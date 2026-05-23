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

    # 2.2 联动打招呼与推荐逻辑：若有姓名，绑定 recommendation 与 candidate 记录，并联动更新回复状态
    if candidate_name:
        db = await get_db()
        try:
            # 1. 查找此候选人最新的推荐/打招呼记录 (未绑定过 candidate_id 优先)
            cursor = await db.execute(
                """SELECT id, status FROM recommendations
                   WHERE candidate_name = ?
                   ORDER BY (CASE WHEN candidate_id IS NULL THEN 1 ELSE 0 END) DESC, created_at DESC LIMIT 1""",
                (candidate_name,),
            )
            row = await cursor.fetchone()
            if row:
                rec_id, status = row[0], row[1]
                # 绑定 candidate_id
                await db.execute(
                    "UPDATE recommendations SET candidate_id = ? WHERE id = ?",
                    (candidate_id, rec_id),
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

    # 7. 构建 Prompt 并调用 LLM
    prompt_messages = build_chat_prompt(
        conversation_history=history,
        new_message=message,
        job_info=job_info,
        candidate_info=candidate,
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
    resume_keywords = [
        "简历", "resume", "cv", "附件", "发给你",
        "已发", "查收", "看一下", "PDF", "pdf",
        "word", "doc", "附上",
    ]
    message_lower = message.lower()
    return any(kw in message_lower for kw in resume_keywords)


async def notify_resume_received(candidate: dict, message: str):
    """通过企业微信通知猎头：收到简历"""
    if not settings.WECHAT_WEBHOOK_URL:
        return

    content = (
        f"🎉 **收到简历！**\n"
        f"- 候选人: {candidate.get('name', candidate['boss_chat_id'])}\n"
        f"- 消息: {message[:100]}\n"
        f"- 请前往 Boss直聘 查看"
    )
    await _send_wechat_notification(content)


async def notify_human_needed(candidate: dict, message: str):
    """通知猎头需要人工介入"""
    if not settings.WECHAT_WEBHOOK_URL:
        return

    content = (
        f"⚠️ **需要人工介入**\n"
        f"- 候选人: {candidate.get('name', candidate['boss_chat_id'])}\n"
        f"- 消息: {message[:100]}\n"
        f"- 请尽快回复"
    )
    await _send_wechat_notification(content)


async def _send_wechat_notification(content: str):
    """发送企业微信群机器人通知"""
    if not settings.WECHAT_WEBHOOK_URL:
        return

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
