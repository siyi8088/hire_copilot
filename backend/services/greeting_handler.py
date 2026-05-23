"""
主动打招呼服务 — 核心业务逻辑
候选人评估、跟进消息生成、打招呼记录管理
"""

import json
import logging
from datetime import datetime

from llm.engine import llm_engine
from llm.greeting_prompts import build_evaluate_prompt, build_followup_prompt
from db.database import (
    save_greeting,
    update_greeting_status,
    get_today_greeting_count,
    get_active_job_post,
    get_greeting_stats,
    get_greeting_history,
    check_candidate_greeted,
    increment_daily_stat,
    sync_active_job_post_by_title,
)
from services.rate_limiter import rate_limiter

logger = logging.getLogger(__name__)

# 每批评估的候选人数量上限（控制 Token 开销）
BATCH_EVAL_SIZE = 8
# 最低匹配分（低于此分的候选人不推荐）
MIN_MATCH_SCORE = 6.5
# 每日打招呼硬限制
MAX_DAILY_GREETINGS = 20


async def evaluate_candidates(candidates: list[dict], job_title: str | None = None) -> dict:
    """
    评估一批候选人，返回排序后的推荐列表与过滤列表

    Args:
        candidates: Extension 抓取的候选人信息列表
        job_title: 页面当前选择的岗位标题，可选（用于自动同步激活）

    Returns:
        {
            "ranked": [{ ...candidate, matchScore, matchReason, followupText }],
            "filtered": [{ ...candidate, matchScore, matchReason }],
            "quota": { "used": 8, "limit": 20, "remaining": 12 },
            "filtered_count": 5,
        }
    """
    # 1. 获取当前岗位信息
    if job_title:
        job_info = await sync_active_job_post_by_title(job_title)
    else:
        job_info = await get_active_job_post()

    if not job_info:
        logger.warning("没有活跃岗位，无法评估候选人")
        return {
            "ranked": [],
            "filtered": [],
            "quota": await _get_quota(),
            "error": "请先前往‘职位管理’页面同步活跃岗位",
        }

    # 2. 去重：过滤已打过招呼的候选人
    fresh_candidates = []
    for c in candidates:
        already_greeted = await check_candidate_greeted(
            c.get("name", ""), c.get("title", "")
        )
        if not already_greeted:
            fresh_candidates.append(c)
        else:
            logger.info(f"跳过已打招呼的候选人: {c.get('name', '未知')}")

    if not fresh_candidates:
        return {
            "ranked": [],
            "filtered": [],
            "quota": await _get_quota(),
            "error": "所有候选人都已打过招呼",
        }

    logger.info(f"待评估候选人: {len(fresh_candidates)} 人 (去重后)")

    # 3. 分批串行调用 LLM 评分 (避免并发限流)
    import asyncio
    all_scored = []
    for i in range(0, len(fresh_candidates), BATCH_EVAL_SIZE):
        batch = fresh_candidates[i:i + BATCH_EVAL_SIZE]
        logger.info(f"正在评估分批 {i // BATCH_EVAL_SIZE + 1} / {((len(fresh_candidates) - 1) // BATCH_EVAL_SIZE) + 1}...")
        scored = await _evaluate_batch(batch, job_info)
        all_scored.extend(scored)
        if i + BATCH_EVAL_SIZE < len(fresh_candidates):
            await asyncio.sleep(0.5)  # 批次间稍微休眠

    # 4. 按分数排序，过滤低分
    all_scored.sort(key=lambda x: x.get("matchScore", 0.0), reverse=True)
    qualified = [c for c in all_scored if c.get("matchScore", 0.0) >= MIN_MATCH_SCORE]
    filtered = [c for c in all_scored if c.get("matchScore", 0.0) < MIN_MATCH_SCORE]

    logger.info(
        f"评估完成: {len(all_scored)} 人评分, "
        f"{len(qualified)} 人达标 (>= {MIN_MATCH_SCORE}), {len(filtered)} 人未达标"
    )

    # 5. 为合格候选人串行生成个性化跟进消息
    if qualified:
        for c in qualified:
            followup = await _generate_followup(c, job_info, c["matchReason"])
            c["followupText"] = followup
            await asyncio.sleep(0.5)

    # 6. 保存到数据库
    # 6.1 保存合格的（状态为 pending，等待用户确认）
    for c in qualified:
        saved = await save_greeting(
            candidate_data=c,
            match_score=c["matchScore"],
            match_reason=c["matchReason"],
            followup_text=c.get("followupText", ""),
            job_post_id=job_info.get("id"),
            status='pending',
        )
        c["greetingId"] = saved["id"]

    # 6.2 保存已过滤的（状态为 filtered，仅归档展示）
    for c in filtered:
        await save_greeting(
            candidate_data=c,
            match_score=c["matchScore"],
            match_reason=c["matchReason"],
            followup_text="",
            job_post_id=job_info.get("id"),
            status='filtered',
        )

    # 7. 记录每日扫描和匹配的统计指标
    await increment_daily_stat("candidates_scanned", len(fresh_candidates))
    await increment_daily_stat("candidates_matched", len(qualified))

    return {
        "ranked": qualified,
        "filtered": filtered,
        "quota": await _get_quota(),
        "filtered_count": len(filtered),
    }


async def approve_greetings(greeting_ids: list[int]) -> dict:
    """用户确认要打招呼的候选人列表"""
    for gid in greeting_ids:
        await update_greeting_status(gid, "approved")
    logger.info(f"已批准 {len(greeting_ids)} 个打招呼请求")
    return {"approved": len(greeting_ids)}


async def record_greeting_sent(greeting_id: int) -> dict:
    """记录打招呼已发送"""
    # 检查每日限额
    today_count = await get_today_greeting_count()
    if today_count >= MAX_DAILY_GREETINGS:
        logger.warning(f"已达每日打招呼上限 ({MAX_DAILY_GREETINGS})")
        return {"ok": False, "reason": "已达每日上限"}

    await update_greeting_status(greeting_id, "sent", {
        "sent_at": datetime.now().isoformat(),
    })
    await increment_daily_stat("greetings_sent")
    rate_limiter.consume_greeting()

    logger.info(f"打招呼已发送: greeting_id={greeting_id}")
    return {"ok": True, "quota": await _get_quota()}


async def record_followup_sent(greeting_id: int, followup_text: str) -> dict:
    """记录跟进消息已发送"""
    await update_greeting_status(greeting_id, "followed_up", {
        "followup_text": followup_text,
        "followup_at": datetime.now().isoformat(),
    })
    await increment_daily_stat("greetings_followed_up")

    logger.info(f"跟进消息已发送: greeting_id={greeting_id}")
    return {"ok": True}


async def get_quota() -> dict:
    """获取今日打招呼配额"""
    return await _get_quota()


# ============================================================
# 内部方法
# ============================================================

async def _get_quota() -> dict:
    """获取配额信息"""
    used = await get_today_greeting_count()
    return {
        "used": used,
        "limit": MAX_DAILY_GREETINGS,
        "remaining": max(0, MAX_DAILY_GREETINGS - used),
    }


async def _evaluate_batch(candidates: list[dict], job_info: dict) -> list[dict]:
    """调用 LLM 对一批候选人评分，带重试机制"""
    import re
    import asyncio
    
    prompt_messages = build_evaluate_prompt(candidates, job_info)
    max_retries = 2

    for attempt in range(max_retries + 1):
        try:
            response = await llm_engine.client.chat.completions.create(
                model=llm_engine.model,
                messages=prompt_messages,
                max_tokens=1500,
                temperature=0.3,  # 评分用低温度，结果更稳定
            )

            reply_text = response.choices[0].message.content
            if not reply_text:
                raise ValueError("LLM 返回评分内容为空")
                
            reply_text = reply_text.strip()

            # 使用更健壮的正则表达式提取 JSON 数组 [...]
            match = re.search(r'\[\s*\{.*\}\s*\]', reply_text, re.DOTALL)
            if match:
                json_str = match.group(0)
            else:
                if "```json" in reply_text:
                    json_str = reply_text.split("```json")[1].split("```")[0].strip()
                elif "```" in reply_text:
                    json_str = reply_text.split("```")[1].split("```")[0].strip()
                else:
                    json_str = reply_text

            scores = json.loads(json_str)

            # 将评分合并回候选人数据
            result = []
            for score_item in scores:
                idx = score_item.get("index", 0)
                if 0 <= idx < len(candidates):
                    candidate = dict(candidates[idx])  # 复制一份
                    candidate["matchScore"] = float(score_item.get("score", 0))
                    candidate["matchReason"] = score_item.get("reason", "")
                    result.append(candidate)

            # 补齐未返回评分的候选人
            scored_indices = {item.get("index") for item in scores if "index" in score_item}
            for i, c in enumerate(candidates):
                if i not in scored_indices:
                    candidate = dict(c)
                    candidate["matchScore"] = 5.0
                    candidate["matchReason"] = "大模型评分漏缺，建议人工审核"
                    result.append(candidate)

            return result

        except Exception as e:
            logger.warning(f"第 {attempt + 1} 次 LLM 评分尝试失败: {e}")
            if attempt < max_retries:
                await asyncio.sleep(1.5)
            else:
                logger.error(f"LLM 评分最终失败: {e}")
                # 降级：给所有候选人一个默认分与错误原因
                return [
                    {**c, "matchScore": 5.0, "matchReason": f"评分异常: {str(e)}，建议人工审核"}
                    for c in candidates
                ]


async def _generate_followup(candidate: dict, job_info: dict,
                              match_reason: str) -> str:
    """为单个候选人生成个性化跟进消息，带重试机制"""
    import asyncio

    prompt_messages = build_followup_prompt(candidate, job_info, match_reason)
    max_retries = 2

    for attempt in range(max_retries + 1):
        try:
            response = await llm_engine.client.chat.completions.create(
                model=llm_engine.model,
                messages=prompt_messages,
                max_tokens=200,
                temperature=0.8,  # 跟进消息用稍高温度，更有创意
            )

            followup = response.choices[0].message.content
            if not followup:
                raise ValueError("LLM 返回跟进消息为空")

            followup = followup.strip()
            # 去除可能的外部引号
            followup = followup.strip('"').strip("'").strip("“").strip("”")

            logger.info(f"生成跟进消息 [{candidate.get('name', '?')}]: {followup[:30]}...")
            return followup

        except Exception as e:
            logger.warning(f"第 {attempt + 1} 次生成跟进消息尝试失败: {e}")
            if attempt < max_retries:
                await asyncio.sleep(1.0)
            else:
                logger.error(f"生成跟进消息最终失败: {e}")
                return ""
