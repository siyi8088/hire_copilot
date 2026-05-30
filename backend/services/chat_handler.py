"""
聊天消息处理服务 — 核心业务逻辑
"""

import logging
import aiohttp
from typing import Optional

from config import settings
from llm.engine import llm_engine
from llm.prompts import build_chat_prompt
from db.database import (
    get_db,
    get_or_create_candidate,
    save_message,
    get_conversation_history,
    update_candidate_status,
    get_active_job_post,
    increment_daily_stat,
)
from services.rate_limiter import rate_limiter

logger = logging.getLogger(__name__)


async def handle_incoming_message(
    chat_id: str, message: str, job_context: dict | None = None, candidate_name: str | None = None
) -> dict:
    """
    处理来自候选人的新消息

    Args:
        chat_id: Boss直聘聊天会话 ID
        message: 候选人消息内容
        job_context: 从聊天页面抓取的岗位信息（优先使用）
        candidate_name: 从聊天页面抓取的候选人姓名

    Returns:
        {
            "reply": str | None,
            "action": "REPLY" | "SKIP" | "HUMAN_NEEDED",
            "reason": str,
        }
    """
    # 1. 频率检查
    can_reply, reason = rate_limiter.can_reply()
    if not can_reply:
        logger.warning(f"频率限制: {reason}")
        return {"reply": None, "action": "SKIP", "reason": reason}

    # 2. 获取/创建候选人记录
    candidate = await get_or_create_candidate(chat_id)
    candidate_id = candidate["id"]

    # 2.1 如果有候选人姓名，且当前记录无姓名，更新之
    if candidate_name and not candidate.get("name"):
        db = await get_db()
        try:
            await db.execute(
                "UPDATE candidates SET name = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?",
                (candidate_name, candidate_id),
            )
            await db.commit()
            candidate["name"] = candidate_name
            logger.info(f"更新候选人姓名: chat_id={chat_id} -> name={candidate_name}")
        finally:
            await db.close()

    # 2.2 联动打招呼与推荐逻辑：若有姓名，绑定 recommendation 与 candidate 记录，并联动更新回复状态 (使用多维度模糊匹配)
    if candidate_name:
        db = await get_db()
        try:
            from db.database import find_matching_recommendation
            # 构造多维度匹配参数
            profile_data = {
                "name": candidate_name,
                "title": candidate.get("current_title"),
                "experience": f"{candidate.get('experience_years')}年" if candidate.get("experience_years") else None,
                "company": job_context.get("company") if job_context else None,
            }
            job_post_id = job_info.get("id") if job_info else None
            
            rec_row = await find_matching_recommendation(db, candidate_id, profile_data, job_post_id)
            if rec_row:
                rec_id = rec_row["id"]
                status = rec_row["status"]
                
                # 绑定 candidate_id 并将名称更新为真名
                await db.execute(
                    "UPDATE recommendations SET candidate_id = ?, candidate_name = ? WHERE id = ?",
                    (candidate_id, candidate_name, rec_id),
                )
                
                # 2. 如果之前是已发送状态，候选人发来消息，说明回复了，更新为 replied
                if status in ('sent', 'followed_up'):
                    await db.execute(
                        """UPDATE recommendations
                           SET status = 'replied', replied_at = CURRENT_TIMESTAMP
                           WHERE id = ?""",
                        (rec_id,),
                    )
                    await db.commit()
                    await increment_daily_stat("greetings_replied")
                    logger.info(
                        f"🎉 候选人回复联动！推荐记录 id={rec_id} (姓名={candidate_name}) 状态更新为 replied 并绑定 candidate_id={candidate_id}"
                    )
                else:
                    await db.commit()
                    logger.info(
                        f"🔗 候选人信息关联成功！推荐记录 id={rec_id} (姓名={candidate_name}) 已绑定 candidate_id={candidate_id}"
                    )
        except Exception as e:
            logger.error(f"关联推荐/打招呼记录失败: {e}")
        finally:
            await db.close()

    # 3. 保存候选人消息
    await save_message(candidate_id, "candidate", message)
    await increment_daily_stat("messages_received")

    # 4. 检查是否收到了简历相关信息
    if detect_resume_signal(message):
        await update_candidate_status(candidate_id, "resume_received")
        await increment_daily_stat("resumes_collected")
        # 发送微信通知
        await notify_resume_received(candidate, message)
        logger.info(f"🎉 候选人 {chat_id} 发送了简历相关信息!")

    # 5. 获取对话历史
    history = await get_conversation_history(candidate_id, limit=15)

    # 6. 获取岗位信息：优先用 Extension 抓取的，其次用数据库的
    job_info = job_context if job_context else await get_active_job_post()
    if job_context:
        logger.info(
            f"使用页面抓取的岗位信息: {job_context.get('title', '未知')}"
        )
    elif job_info:
        logger.info(f"使用数据库岗位信息: {job_info.get('title', '未知')}")

    # 6.1 获取候选人的来源和匹配得分
    source = "chat"
    match_score = None
    db = await get_db()
    try:
        cursor = await db.execute(
            """SELECT source, match_score FROM recommendations 
               WHERE candidate_id = ? 
               ORDER BY created_at DESC LIMIT 1""",
            (candidate_id,)
        )
        row = await cursor.fetchone()
        if row:
            source = row["source"]
            match_score = row["match_score"]
    except Exception as e:
        logger.error(f"获取候选人来源和匹配评分失败: {e}")
    finally:
        await db.close()

    # 7. 构建 Prompt 并调用 LLM
    prompt_messages = build_chat_prompt(
        conversation_history=history,
        new_message=message,
        job_info=job_info,
        candidate_info=candidate,
        source=source,
        match_score=match_score,
    )

    result = await llm_engine.generate_reply(prompt_messages)

    # 8. 保存自动回复
    if result["reply"]:
        await save_message(candidate_id, "copilot", result["reply"])
        rate_limiter.consume_reply()
        await increment_daily_stat("replies_sent")

        # 更新候选人状态
        if candidate["status"] == "new":
            await update_candidate_status(candidate_id, "chatting")

    # 9. 如果需要人工介入，发通知
    if result["action"] == "HUMAN_NEEDED":
        await notify_human_needed(candidate, message)

    return {
        "reply": result["reply"],
        "action": result["action"],
        "reason": "OK",
    }


def detect_resume_signal(message: str) -> bool:
    """检测消息中是否包含简历相关信号"""
    message_lower = message.lower()

    # 1. 强信号：Boss直聘官方的附件简历发送请求卡片
    if "想发送附件简历给您" in message_lower or "发送了附件简历" in message_lower:
        return True

    # 2. 基础简历关键词
    resume_keywords = [
        "简历", "resume", "cv", "附件", "发给你",
        "已发", "查收", "看一下", "PDF", "pdf",
        "word", "doc", "附上",
    ]

    has_keyword = any(kw in message_lower for kw in resume_keywords)
    if not has_keyword:
        return False

    # 3. 排除否定词或延迟词（如：“晚点发”、“等会发”、“没带简历”、“准备发”）
    negation_keywords = ["晚点", "稍后", "等会", "等一下", "没带", "没有", "空了", "迟些", "准备发"]
    if any(neg in message_lower for neg in negation_keywords):
        return False

    return True


async def notify_resume_received(candidate: dict, message: str):
    """通知猎头：收到简历"""
    if not settings.WECHAT_WEBHOOK_URL and not settings.DINGTALK_WEBHOOK_URL:
        return

    candidate_name = candidate.get('name', candidate['boss_chat_id'])
    content = (
        f"🎉 **收到简历！**\n\n"
        f"- 候选人: {candidate_name}\n"
        f"- 消息: {message[:100]}\n"
        f"- 请前往 Boss直聘 查看"
    )

    if settings.WECHAT_WEBHOOK_URL:
        await _send_wechat_notification(content)

    if settings.DINGTALK_WEBHOOK_URL:
        await _send_dingtalk_notification(title="收到简历通知", text=content)


async def notify_human_needed(candidate: dict, message: str):
    """通知猎头需要人工介入"""
    if not settings.WECHAT_WEBHOOK_URL and not settings.DINGTALK_WEBHOOK_URL:
        return

    candidate_name = candidate.get('name', candidate['boss_chat_id'])
    content = (
        f"⚠️ **需要人工介入**\n\n"
        f"- 候选人: {candidate_name}\n"
        f"- 消息: {message[:100]}\n"
        f"- 请尽快回复"
    )

    if settings.WECHAT_WEBHOOK_URL:
        await _send_wechat_notification(content)

    if settings.DINGTALK_WEBHOOK_URL:
        await _send_dingtalk_notification(title="需要人工介入通知", text=content)


async def _send_wechat_notification(content: str):
    """发送企业微信群机器人通知"""
    payload = {
        "msgtype": "markdown",
        "markdown": {"content": content},
    }

    try:
        async with aiohttp.ClientSession() as session:
            async with session.post(
                settings.WECHAT_WEBHOOK_URL,
                json=payload,
                timeout=aiohttp.ClientTimeout(total=10),
            ) as resp:
                if resp.status == 200:
                    logger.info("微信通知发送成功")
                else:
                    logger.warning(f"微信通知失败: status={resp.status}")
    except Exception as e:
        logger.error(f"微信通知异常: {e}")


async def _send_dingtalk_notification(title: str, text: str):
    """发送钉钉群机器人通知"""
    import time
    import hmac
    import hashlib
    import base64
    import urllib.parse

    url = settings.DINGTALK_WEBHOOK_URL
    if settings.DINGTALK_SECRET:
        timestamp = str(round(time.time() * 1000))
        secret_enc = settings.DINGTALK_SECRET.encode('utf-8')
        string_to_sign = '{}\n{}'.format(timestamp, settings.DINGTALK_SECRET)
        string_to_sign_enc = string_to_sign.encode('utf-8')
        hmac_code = hmac.new(secret_enc, string_to_sign_enc, digestmod=hashlib.sha256).digest()
        sign = urllib.parse.quote_plus(base64.b64encode(hmac_code))
        url = f"{url}&timestamp={timestamp}&sign={sign}"

    payload = {
        "msgtype": "markdown",
        "markdown": {
            "title": title,
            "text": text,
        }
    }

    try:
        async with aiohttp.ClientSession() as session:
            async with session.post(
                url,
                json=payload,
                timeout=aiohttp.ClientTimeout(total=10),
            ) as resp:
                if resp.status == 200:
                    res_json = await resp.json()
                    if res_json.get("errcode") == 0:
                        logger.info("钉钉通知发送成功")
                    else:
                        logger.warning(f"钉钉通知发送失败(API返回错误): {res_json}")
                else:
                    res_body = await resp.text()
                    logger.warning(f"钉钉通知接口请求失败: status={resp.status}, body={res_body}")
    except Exception as e:
        logger.error(f"钉钉通知发送异常: {e}")
