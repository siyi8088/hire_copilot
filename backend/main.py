"""
FastAPI 应用入口 — WebSocket 端点 + REST API
"""

import json
import logging
from contextlib import asynccontextmanager

from fastapi import FastAPI, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import HTMLResponse

from config import settings
from db.database import init_db, get_active_job_post, get_greeting_history, get_greeting_stats, save_or_update_job_post, get_db
from services.chat_handler import handle_incoming_message
from services.rate_limiter import rate_limiter
from services.greeting_handler import (
    evaluate_candidates,
    approve_greetings,
    record_greeting_sent,
    record_followup_sent,
    get_quota,
)

# ============================================================
# 日志配置
# ============================================================
logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(name)s] %(levelname)s: %(message)s",
    datefmt="%Y-%m-%d %H:%M:%S",
)
logger = logging.getLogger("copilot")


# ============================================================
# 应用生命周期
# ============================================================
@asynccontextmanager
async def lifespan(app: FastAPI):
    """启动时初始化数据库"""
    await init_db()
    logger.info("🚀 猎头 Copilot 后端启动")
    logger.info(f"   LLM: {settings.LLM_PROVIDER} / {settings.LLM_MODEL}")
    logger.info(f"   监听: {settings.HOST}:{settings.PORT}")
    yield
    logger.info("👋 猎头 Copilot 后端关闭")


app = FastAPI(
    title="猎头 Copilot Backend",
    version="0.1.0",
    lifespan=lifespan,
)

# CORS — 允许 Chrome Extension 连接
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],  # Chrome Extension 无固定 origin
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


# ============================================================
# WebSocket 端点 — 与 Chrome Extension 通信
# ============================================================
class ConnectionManager:
    """管理 WebSocket 连接"""

    def __init__(self):
        self.active_connections: list[WebSocket] = []

    async def connect(self, websocket: WebSocket):
        await websocket.accept()
        self.active_connections.append(websocket)
        logger.info(f"🔗 Extension 连接 (总连接数: {len(self.active_connections)})")

    def disconnect(self, websocket: WebSocket):
        self.active_connections.remove(websocket)
        logger.info(f"🔌 Extension 断开 (总连接数: {len(self.active_connections)})")

    async def broadcast(self, message: dict):
        for conn in self.active_connections:
            try:
                await conn.send_json(message)
            except Exception:
                pass


manager = ConnectionManager()


@app.websocket("/ws")
async def websocket_endpoint(websocket: WebSocket):
    await manager.connect(websocket)
    try:
        while True:
            data = await websocket.receive_text()
            message = json.loads(data)

            # 心跳
            if message.get("type") == "PING":
                await websocket.send_json({
                    "type": "PONG",
                    "timestamp": message.get("timestamp"),
                })
                continue

            # 处理聊天消息
            if message.get("type") == "CHAT_MESSAGE":
                request_id = message.get("requestId")
                chat_id = message.get("chatId", "unknown")
                msg_text = message.get("message", "")
                job_context = message.get("jobContext")  # 从页面抓取的岗位信息
                candidate_name = message.get("candidateName") # 从页面抓取的候选人姓名

                logger.info(f"📩 收到消息 [{chat_id}] (姓名: {candidate_name}): {msg_text[:50]}")
                if job_context:
                    logger.info(f"   📋 岗位上下文: {job_context.get('title', '未知')}")

                result = await handle_incoming_message(
                    chat_id, msg_text, job_context=job_context, candidate_name=candidate_name
                )

                await websocket.send_json({
                    "requestId": request_id,
                    "reply": result["reply"],
                    "action": result["action"],
                    "reason": result["reason"],
                })
                continue

            # ---- 主动打招呼：评估候选人 ----
            if message.get("type") == "EVALUATE_CANDIDATES":
                request_id = message.get("requestId")
                candidates = message.get("candidates", [])
                job_title = message.get("jobTitle")
                logger.info(f"📊 收到候选人评估请求: {len(candidates)} 人, 岗位: {job_title}")

                result = await evaluate_candidates(candidates, job_title)

                await websocket.send_json({
                    "requestId": request_id,
                    "type": "EVALUATE_RESULT",
                    "ranked": result.get("ranked", []),
                    "filtered": result.get("filtered", []),
                    "quota": result.get("quota", {}),
                    "filtered_count": result.get("filtered_count", 0),
                    "error": result.get("error"),
                })
                continue

            # ---- 主动打招呼：保存/同步岗位 ----
            if message.get("type") == "SAVE_JOB_POST":
                request_id = message.get("requestId")
                job_data = message.get("jobData", {})
                logger.info(f"📋 收到岗位同步请求: {job_data.get('title')}")

                try:
                    result = await save_or_update_job_post(job_data)
                    await websocket.send_json({
                        "requestId": request_id,
                        "type": "SAVE_JOB_POST_RESULT",
                        "ok": True,
                        "job": result,
                    })
                except Exception as e:
                    logger.error(f"同步岗位失败: {e}")
                    await websocket.send_json({
                        "requestId": request_id,
                        "type": "SAVE_JOB_POST_RESULT",
                        "ok": False,
                        "error": str(e),
                    })
                continue

            # ---- 主动打招呼：用户批准候选人 ----
            if message.get("type") == "APPROVE_GREETINGS":
                request_id = message.get("requestId")
                greeting_ids = message.get("greetingIds", [])
                logger.info(f"✅ 用户批准打招呼: {len(greeting_ids)} 人")

                result = await approve_greetings(greeting_ids)

                await websocket.send_json({
                    "requestId": request_id,
                    "type": "APPROVE_RESULT",
                    "approved": result["approved"],
                })
                continue

            # ---- 主动打招呼：记录已发送 ----
            if message.get("type") == "GREETING_SENT":
                request_id = message.get("requestId")
                greeting_id = message.get("greetingId")
                logger.info(f"👋 打招呼已发送: greeting_id={greeting_id}")

                result = await record_greeting_sent(greeting_id)

                await websocket.send_json({
                    "requestId": request_id,
                    "type": "GREETING_SENT_RESULT",
                    **result,
                })
                continue

            # ---- 主动打招呼：记录跟进消息 ----
            if message.get("type") == "FOLLOWUP_SENT":
                request_id = message.get("requestId")
                greeting_id = message.get("greetingId")
                followup_text = message.get("followupText", "")
                logger.info(f"💬 跟进消息已发送: greeting_id={greeting_id}")

                result = await record_followup_sent(greeting_id, followup_text)

                await websocket.send_json({
                    "requestId": request_id,
                    "type": "FOLLOWUP_SENT_RESULT",
                    **result,
                })
                continue

            # ---- 自动采集微简历画像 ----
            if message.get("type") == "UPDATE_CANDIDATE_PROFILE":
                request_id = message.get("requestId")
                chat_id = message.get("chatId")
                profile_data = message.get("profileData", {})
                logger.info(f"👤 收到候选人画像更新 [{chat_id}] (姓名: {profile_data.get('name')}): {profile_data}")
                
                from db.database import update_candidate_profile
                await update_candidate_profile(chat_id, profile_data)
                
                # 触发异步背景智能评估
                import asyncio
                asyncio.create_task(evaluate_chat_candidate_background(chat_id, profile_data))
                
                await websocket.send_json({
                    "requestId": request_id,
                    "type": "UPDATE_CANDIDATE_PROFILE_RESULT",
                    "ok": True,
                })
                continue

            # ---- 在线简历解析与评估 ----
            if message.get("type") == "UPDATE_CANDIDATE_RESUME":
                request_id = message.get("requestId")
                chat_id = message.get("chatId")
                candidate_name = message.get("name")
                resume_text = message.get("resumeText", "")
                logger.info(f"📄 收到在线简历上报 [{chat_id}] (姓名: {candidate_name}), 长度: {len(resume_text)}")
                
                # 异步执行大模型简历评分与评估
                import asyncio
                asyncio.create_task(evaluate_candidate_resume_background(chat_id, candidate_name, resume_text))
                
                await websocket.send_json({
                    "requestId": request_id,
                    "type": "UPDATE_CANDIDATE_RESUME_RESULT",
                    "ok": True,
                })
                continue

            logger.warning(f"未知消息类型: {message.get('type')}")

    except WebSocketDisconnect:
        manager.disconnect(websocket)
    except Exception as e:
        logger.error(f"WebSocket 错误: {e}")
        manager.disconnect(websocket)


async def evaluate_chat_candidate_background(chat_id: str, profile_data: dict):
    """在后台为新抓取的聊天候选人自动评估并计算匹配分和理由"""
    import asyncio
    try:
        from db.database import get_db, get_active_job_post
        from services.greeting_handler import _evaluate_batch, _generate_followup
        
        # 1. 获取当前活跃岗位
        job_info = await get_active_job_post()
        if not job_info:
            logger.warning("[Evaluator] 无活跃岗位，跳过背景智能评估")
            return
            
        # 2. 检查是否已经有了评估记录
        db = await get_db()
        try:
            cursor = await db.execute(
                """SELECT id, match_score FROM recommendations 
                   WHERE candidate_name = ? AND source = 'chat' 
                   ORDER BY created_at DESC LIMIT 1""",
                (profile_data.get("name"),)
            )
            row = await cursor.fetchone()
            if not row:
                return
            rec_id = row["id"]
            # 如果已经有了分数，我们就无需重复生成
            if row["match_score"] is not None:
                return
        finally:
            await db.close()

        logger.info(f"[Evaluator] 🎯 开始为聊天候选人 {profile_data.get('name')} 执行背景智能评估...")

        eval_input = {
            "name": profile_data.get("name"),
            "title": profile_data.get("title") or "未知",
            "experience": profile_data.get("experience") or "未知",
            "education": profile_data.get("education") or "未知",
            "salary": profile_data.get("salary") or "未知",
            "company": profile_data.get("company") or "",
        }
        
        # 调用大模型评分评估
        scored_list = await _evaluate_batch([eval_input], job_info)
        if not scored_list:
            return
        scored = scored_list[0]
        
        match_score = scored.get("matchScore", 5.0)
        match_reason = scored.get("matchReason", "评估未返回详细原因")
        
        # 生成跟进消息
        followup_text = await _generate_followup(scored, job_info, match_reason)
        
        # 保存回数据库
        db = await get_db()
        try:
            await db.execute(
                """UPDATE recommendations 
                   SET match_score = ?, match_reason = ?, followup_text = ?
                   WHERE id = ?""",
                (match_score, match_reason, followup_text, rec_id)
            )
            await db.commit()
            logger.info(f"[Evaluator] ✅ 背景智能评估完成: name={profile_data.get('name')}, score={match_score}")
        finally:
            await db.close()
            
    except Exception as e:
        logger.error(f"[Evaluator] 背景智能评估异常: {e}")


async def evaluate_candidate_resume_background(chat_id: str, candidate_name: str, resume_text: str):
    """在后台为在线简历文本执行智能匹配评估"""
    try:
        from db.database import get_db, get_active_job_post
        from services.greeting_handler import _evaluate_batch, _generate_followup
        
        # 1. 获取当前活跃岗位
        job_info = await get_active_job_post()
        if not job_info:
            logger.warning("[ResumeEvaluator] 无活跃岗位，跳过在线简历评估")
            return
            
        # 2. 获取 recommendations 记录（获取或新建）
        db = await get_db()
        try:
            # 找到对应的 candidate_id
            cursor = await db.execute("SELECT id FROM candidates WHERE boss_chat_id = ?", (chat_id,))
            cand_row = await cursor.fetchone()
            candidate_id = cand_row["id"] if cand_row else None
            
            # 查找已有的推荐记录
            cursor = await db.execute(
                """SELECT id FROM recommendations 
                   WHERE candidate_name = ? AND source = 'chat' 
                   ORDER BY created_at DESC LIMIT 1""",
                (candidate_name,)
            )
            row = await cursor.fetchone()
            if row:
                rec_id = row["id"]
            else:
                # 自动获取岗位 id
                job_post_id = job_info.get("id")
                # 插入全新记录
                cursor = await db.execute(
                    """INSERT INTO recommendations 
                       (candidate_id, candidate_name, source, status, job_post_id)
                       VALUES (?, ?, 'chat', 'chatting', ?)""",
                    (candidate_id, candidate_name, job_post_id)
                )
                await db.commit()
                rec_id = cursor.lastrowid
        finally:
            await db.close()

        logger.info(f"[ResumeEvaluator] 🎯 开始调用大模型评估 {candidate_name} 的在线简历...")

        # 3. 构造大模型输入（直接把在线简历内容作为评估内容）
        eval_input = {
            "name": candidate_name,
            "title": "在线简历",
            "experience": "详见简历",
            "education": "详见简历",
            "salary": "面议",
            "company": "详见简历",
            "advantage": resume_text[:1500]  # 大段简历正文限制在 1500 字，防止 Token 溢出
        }
        
        # 4. 调用评分
        scored_list = await _evaluate_batch([eval_input], job_info)
        if not scored_list:
            return
        scored = scored_list[0]
        
        match_score = scored.get("matchScore", 5.0)
        match_reason = scored.get("matchReason", "在线简历评估未返回详细原因")
        
        # 5. 生成跟进消息
        followup_text = await _generate_followup(scored, job_info, match_reason)
        
        # 6. 保存回数据库
        db = await get_db()
        try:
            await db.execute(
                """UPDATE recommendations 
                   SET match_score = ?, match_reason = ?, followup_text = ?
                   WHERE id = ?""",
                (match_score, match_reason, followup_text, rec_id)
            )
            await db.commit()
            logger.info(f"[ResumeEvaluator] ✅ 在线简历背景评估完成: name={candidate_name}, score={match_score}")
        finally:
            await db.close()
            
    except Exception as e:
        logger.error(f"[ResumeEvaluator] 在线简历评估异常: {e}")


@app.get("/api/candidates/check_evaluated")
async def check_candidate_evaluated(chat_id: str, name: str):
    """请求后端校验该候选人是否已有聊天记录及匹配评分"""
    from db.database import get_db
    db = await get_db()
    try:
        # 1. 查找 candidate
        cursor = await db.execute("SELECT id FROM candidates WHERE boss_chat_id = ?", (chat_id,))
        cand_row = await cursor.fetchone()
        if not cand_row:
            return {"evaluated": False, "has_messages": False}
        candidate_id = cand_row["id"]
        
        # 2. 检查消息数量
        cursor = await db.execute("SELECT COUNT(*) as msg_count FROM messages WHERE candidate_id = ?", (candidate_id,))
        msg_row = await cursor.fetchone()
        has_messages = (msg_row["msg_count"] > 0) if msg_row else False
        
        # 3. 检查 recommendations 表是否有 match_score (不限来源)
        cursor = await db.execute(
            """SELECT match_score FROM recommendations 
               WHERE candidate_id = ? AND match_score IS NOT NULL
               ORDER BY created_at DESC LIMIT 1""",
            (candidate_id,)
        )
        row = await cursor.fetchone()
        if row and row["match_score"] is not None:
            return {"evaluated": True, "has_messages": has_messages}
            
        # 兜底通过姓名查 recommendations 表 (不限来源)
        cursor = await db.execute(
            """SELECT match_score FROM recommendations 
               WHERE candidate_name = ? AND match_score IS NOT NULL
               ORDER BY created_at DESC LIMIT 1""",
            (name,)
        )
        row = await cursor.fetchone()
        if row and row["match_score"] is not None:
            return {"evaluated": True, "has_messages": has_messages}
            
        return {"evaluated": False, "has_messages": has_messages}
    except Exception as e:
        logger.error(f"check_candidate_evaluated 发生错误: {e}")
        return {"evaluated": False, "has_messages": False}
    finally:
        await db.close()


# ============================================================
# REST API — 管理接口
# ============================================================

@app.get("/api/status")
async def get_status():
    """获取后端运行状态"""
    return {
        "status": "running",
        "connections": len(manager.active_connections),
        "rate_limiter": rate_limiter.get_status(),
        "llm": {
            "provider": settings.LLM_PROVIDER,
            "model": settings.LLM_MODEL,
        },
    }


@app.get("/api/job")
async def get_current_job():
    """获取当前活跃岗位"""
    job = await get_active_job_post()
    return {"job": job}


@app.post("/api/job")
async def create_job(job_data: dict):
    """创建新岗位"""
    from db.database import get_db

    db = await get_db()
    try:
        await db.execute(
            """INSERT INTO job_posts (title, company, description, salary_range, requirements, highlights)
               VALUES (?, ?, ?, ?, ?, ?)""",
            (
                job_data.get("title", ""),
                job_data.get("company", ""),
                job_data.get("description", ""),
                job_data.get("salary_range", ""),
                job_data.get("requirements", ""),
                job_data.get("highlights", ""),
            ),
        )
        await db.commit()
        return {"ok": True, "message": "岗位创建成功"}
    finally:
        await db.close()


# ============================================================
# REST API — 主动打招呼
# ============================================================

@app.get("/api/greetings")
async def get_greetings(page: int = 1, limit: int = 15, status: str = 'sent'):
    """获取打招呼历史"""
    from db.database import get_greeting_history_paginated
    result = await get_greeting_history_paginated(page=page, limit=limit, status_filter=status)
    return result


@app.get("/api/recommendations")
async def get_recommendations(page: int = 1, limit: int = 15, status: str = 'sent'):
    """获取打招呼和评估历史（推荐路径）"""
    from db.database import get_greeting_history_paginated
    result = await get_greeting_history_paginated(page=page, limit=limit, status_filter=status)
    return result


@app.get("/api/stats/daily")
async def get_daily_stats_api():
    """获取今日累计的统计数据"""
    from db.database import get_daily_stats
    stats = await get_daily_stats()
    return {"ok": True, "stats": stats}


@app.get("/api/chat/candidates")
async def get_chat_candidates(q: str = None):
    """获取有聊天记录的候选人列表，按最后消息时间倒序"""
    from db.database import get_db
    db = await get_db()
    try:
        if q:
            query = """
                SELECT c.id, c.name, c.boss_chat_id, COALESCE(c.current_title, r.candidate_title) as current_title, c.experience_years, c.status,
                       m.content as last_message_content, m.created_at as last_message_time, m.role as last_message_role,
                       r.match_score, r.match_reason,
                       r.candidate_experience, r.candidate_education, r.candidate_salary, r.candidate_company, r.followup_text
                FROM candidates c
                INNER JOIN (
                    SELECT candidate_id, content, created_at, role,
                           ROW_NUMBER() OVER (PARTITION BY candidate_id ORDER BY created_at DESC) as rn
                    FROM messages
                ) m ON c.id = m.candidate_id AND m.rn = 1
                LEFT JOIN (
                    SELECT candidate_id, match_score, match_reason, candidate_title,
                           candidate_experience, candidate_education, candidate_salary, candidate_company, followup_text,
                           ROW_NUMBER() OVER (PARTITION BY candidate_id ORDER BY created_at DESC) as rn
                    FROM recommendations
                    WHERE candidate_id IS NOT NULL
                ) r ON c.id = r.candidate_id AND r.rn = 1
                WHERE c.name LIKE ?
                ORDER BY last_message_time DESC
            """
            cursor = await db.execute(query, (f"%{q}%",))
        else:
            query = """
                SELECT c.id, c.name, c.boss_chat_id, COALESCE(c.current_title, r.candidate_title) as current_title, c.experience_years, c.status,
                       m.content as last_message_content, m.created_at as last_message_time, m.role as last_message_role,
                       r.match_score, r.match_reason,
                       r.candidate_experience, r.candidate_education, r.candidate_salary, r.candidate_company, r.followup_text
                FROM candidates c
                INNER JOIN (
                    SELECT candidate_id, content, created_at, role,
                           ROW_NUMBER() OVER (PARTITION BY candidate_id ORDER BY created_at DESC) as rn
                    FROM messages
                ) m ON c.id = m.candidate_id AND m.rn = 1
                LEFT JOIN (
                    SELECT candidate_id, match_score, match_reason, candidate_title,
                           candidate_experience, candidate_education, candidate_salary, candidate_company, followup_text,
                           ROW_NUMBER() OVER (PARTITION BY candidate_id ORDER BY created_at DESC) as rn
                    FROM recommendations
                    WHERE candidate_id IS NOT NULL
                ) r ON c.id = r.candidate_id AND r.rn = 1
                ORDER BY last_message_time DESC
            """
            cursor = await db.execute(query)
            
        rows = await cursor.fetchall()
        candidates = [dict(row) for row in rows]
        return {"ok": True, "candidates": candidates}
    except Exception as e:
        logger.error(f"Failed to fetch chat candidates: {e}")
        return {"ok": False, "candidates": [], "error": str(e)}
    finally:
        await db.close()


@app.get("/api/greetings/quota")
async def get_greetings_quota():
    """获取今日打招呼配额"""
    quota = await get_quota()
    return {"quota": quota}


@app.get("/api/greetings/stats")
async def get_greetings_stats():
    """获取打招呼效果统计"""
    stats = await get_greeting_stats()
    return {"stats": stats}


@app.get("/api/candidates/{candidate_id}/messages")
async def get_candidate_messages(candidate_id: int):
    """拉取候选人的对话记录气泡数据"""
    db = await get_db()
    try:
        cursor = await db.execute(
            """SELECT role, content, created_at FROM messages
               WHERE candidate_id = ?
               ORDER BY created_at ASC""",
            (candidate_id,)
        )
        rows = await cursor.fetchall()
        messages = [dict(row) for row in rows]
        return {"messages": messages}
    except Exception as e:
        logger.error(f"获取对话历史失败: {e}")
        return {"messages": [], "error": str(e)}
    finally:
        await db.close()


# ============================================================
# REST API — DOM 校准诊断
# ============================================================

import base64
from pathlib import Path
from datetime import datetime

DIAGNOSTIC_DIR = Path(__file__).parent / "data" / "diagnostics"


@app.post("/api/diagnostic")
async def receive_diagnostic(data: dict):
    """接收前端 Preflight Check 校准诊断数据（DOM 结构 + 截图）"""
    DIAGNOSTIC_DIR.mkdir(parents=True, exist_ok=True)

    timestamp = datetime.now().strftime("%Y%m%d_%H%M%S")
    module = data.get("module", "unknown")
    report_id = f"{module}_{timestamp}"
    report_dir = DIAGNOSTIC_DIR / report_id
    report_dir.mkdir(exist_ok=True)

    # 保存 DOM 诊断数据 (JSON)，排除 screenshot 字段以减小体积
    dom_data = {k: v for k, v in data.items() if k != "screenshot"}
    (report_dir / "diagnostic.json").write_text(
        json.dumps(dom_data, ensure_ascii=False, indent=2),
        encoding="utf-8",
    )

    # 保存截图 (PNG)
    screenshot_b64 = data.get("screenshot", "")
    if screenshot_b64 and isinstance(screenshot_b64, str) and screenshot_b64.startswith("data:image"):
        try:
            img_data = base64.b64decode(screenshot_b64.split(",")[1])
            (report_dir / "screenshot.png").write_bytes(img_data)
            logger.info(f"📸 截图已保存: {report_dir / 'screenshot.png'}")
        except Exception as e:
            logger.warning(f"截图解码失败: {e}")

    logger.info(f"📋 收到诊断数据: {report_id} (模块: {module})")
    logger.info(f"   失败选择器: {list(dom_data.get('failedSelectors', {}).keys())}")
    logger.info(f"   报告路径: {report_dir}")

    return {"ok": True, "reportId": report_id, "path": str(report_dir)}


@app.get("/api/diagnostic")
async def list_diagnostics():
    """列出所有诊断报告"""
    if not DIAGNOSTIC_DIR.exists():
        return {"reports": []}
    reports = sorted(DIAGNOSTIC_DIR.iterdir(), key=lambda p: p.name, reverse=True)
    result = []
    for r in reports[:20]:
        info = {"id": r.name, "path": str(r)}
        # 读取 diagnostic.json 的基本信息
        diag_file = r / "diagnostic.json"
        if diag_file.exists():
            try:
                diag = json.loads(diag_file.read_text(encoding="utf-8"))
                info["module"] = diag.get("module", "unknown")
                info["url"] = diag.get("url", "")
                info["timestamp"] = diag.get("timestamp", "")
                info["failedCount"] = len(diag.get("failedSelectors", {}))
                info["passedCount"] = len(diag.get("passedSelectors", {}))
                info["hasScreenshot"] = (r / "screenshot.png").exists()
            except Exception:
                pass
        result.append(info)
    return {"reports": result}


# ============================================================
# Dashboard 页面（简易版）
# ============================================================

@app.get("/dashboard", response_class=HTMLResponse)
async def dashboard():
    """管理面板 — 现代 Premium UI"""
    return """
    <!DOCTYPE html>
    <html lang="zh-CN">
    <head>
        <meta charset="UTF-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <title>Boss直聘 Copilot — 智能招聘面板</title>
        <link rel="preconnect" href="https://fonts.googleapis.com">
        <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
        <link href="https://fonts.googleapis.com/css2?family=Inter:wght@300;400;500;600;700&family=Outfit:wght@400;500;600;700;800&display=swap" rel="stylesheet">
        <style>
            :root {
                --bg-primary: #0a0a0f;
                --bg-secondary: #13121f;
                --bg-glass: rgba(22, 21, 38, 0.7);
                --bg-glass-hover: rgba(28, 27, 48, 0.85);
                --border-color: rgba(255, 255, 255, 0.08);
                --text-primary: #f1f1f6;
                --text-secondary: #9493a5;
                
                --color-primary: #6366f1; /* Indigo */
                --color-primary-glow: rgba(99, 102, 241, 0.15);
                --color-success: #10b981; /* Emerald */
                --color-success-glow: rgba(16, 185, 129, 0.15);
                --color-cyan: #06b6d4; /* Cyan */
                --color-cyan-glow: rgba(6, 182, 212, 0.15);
                --color-warning: #f59e0b; /* Amber */
                --color-warning-glow: rgba(245, 158, 11, 0.15);
                --color-error: #f43f5e; /* Rose */
                --color-error-glow: rgba(244, 63, 94, 0.15);
                
                --font-display: 'Outfit', 'Inter', -apple-system, sans-serif;
                --font-sans: 'Inter', -apple-system, sans-serif;
            }

            * {
                margin: 0;
                padding: 0;
                box-sizing: border-box;
            }

            body {
                font-family: var(--font-sans);
                background-color: var(--bg-primary);
                background-image: 
                    radial-gradient(at 0% 0%, rgba(99, 102, 241, 0.1) 0px, transparent 50%),
                    radial-gradient(at 100% 100%, rgba(6, 182, 212, 0.08) 0px, transparent 50%);
                background-attachment: fixed;
                color: var(--text-primary);
                min-height: 100vh;
                padding: 32px;
                line-height: 1.5;
            }

            /* Layout */
            .container {
                max-width: 1400px;
                margin: 0 auto;
            }

            header {
                display: flex;
                justify-content: space-between;
                align-items: center;
                margin-bottom: 32px;
                padding-bottom: 20px;
                border-bottom: 1px solid var(--border-color);
            }

            .logo-area {
                display: flex;
                align-items: center;
                gap: 12px;
            }

            .logo-icon {
                font-size: 32px;
                background: linear-gradient(135deg, var(--color-primary), var(--color-cyan));
                -webkit-background-clip: text;
                -webkit-text-fill-color: transparent;
                filter: drop-shadow(0 2px 8px rgba(99, 102, 241, 0.3));
            }

            h1 {
                font-family: var(--font-display);
                font-size: 26px;
                font-weight: 700;
                letter-spacing: -0.5px;
                background: linear-gradient(to right, #ffffff, #c7c6d5);
                -webkit-background-clip: text;
                -webkit-text-fill-color: transparent;
            }

            .header-status {
                display: flex;
                align-items: center;
                gap: 16px;
            }

            .status-badge {
                display: flex;
                align-items: center;
                gap: 8px;
                background: rgba(16, 185, 129, 0.1);
                border: 1px solid rgba(16, 185, 129, 0.2);
                color: var(--color-success);
                padding: 6px 14px;
                border-radius: 99px;
                font-size: 13px;
                font-weight: 500;
            }

            .pulse-dot {
                width: 8px;
                height: 8px;
                background-color: var(--color-success);
                border-radius: 50%;
                box-shadow: 0 0 0 0 rgba(16, 185, 129, 0.7);
                animation: pulse 1.6s infinite;
            }

            @keyframes pulse {
                0% {
                    transform: scale(0.95);
                    box-shadow: 0 0 0 0 rgba(16, 185, 129, 0.7);
                }
                70% {
                    transform: scale(1);
                    box-shadow: 0 0 0 6px rgba(16, 185, 129, 0);
                }
                100% {
                    transform: scale(0.95);
                    box-shadow: 0 0 0 0 rgba(16, 185, 129, 0);
                }
            }

            /* Dashboard Grid */
            .dashboard-grid {
                display: grid;
                grid-template-columns: repeat(5, 1fr);
                gap: 20px;
                margin-bottom: 24px;
            }

            /* Hover Tooltip/Card for JD & Requirements */
            .hover-tooltip-container {
                position: relative;
                display: inline-block;
            }
            
            .hover-tooltip-trigger {
                color: var(--color-cyan);
                cursor: pointer;
                text-decoration: underline dashed rgba(6, 182, 212, 0.4);
                font-weight: 500;
                font-size: 13px;
                transition: color 0.2s;
            }
            
            .hover-tooltip-trigger:hover {
                color: #22d3ee;
            }
            
            .hover-tooltip-card {
                visibility: hidden;
                opacity: 0;
                position: absolute;
                top: calc(100% + 8px);
                left: 0;
                width: 450px;
                background: #141324;
                border: 1px solid rgba(255, 255, 255, 0.12);
                border-radius: 12px;
                padding: 16px;
                color: var(--text-primary);
                font-size: 13px;
                line-height: 1.6;
                box-shadow: 0 12px 40px rgba(0, 0, 0, 0.6);
                z-index: 100;
                transition: opacity 0.25s ease, transform 0.25s ease;
                transform: translateY(4px);
                white-space: pre-wrap;
                max-height: 300px;
                overflow-y: auto;
            }
            
            .hover-tooltip-container:hover .hover-tooltip-card {
                visibility: visible;
                opacity: 1;
                transform: translateY(0);
            }

            .card {
                background: var(--bg-glass);
                border: 1px solid var(--border-color);
                backdrop-filter: blur(16px);
                border-radius: 16px;
                padding: 24px;
                transition: transform 0.2s ease, border-color 0.2s ease, box-shadow 0.2s ease;
                box-shadow: 0 8px 32px 0 rgba(0, 0, 0, 0.2);
            }

            .card:hover {
                transform: translateY(-2px);
                border-color: rgba(99, 102, 241, 0.25);
                box-shadow: 0 12px 40px 0 rgba(99, 102, 241, 0.1);
            }

            .card-header-row {
                display: flex;
                justify-content: space-between;
                align-items: center;
                margin-bottom: 12px;
            }

            .card-title {
                font-family: var(--font-display);
                font-size: 13px;
                color: var(--text-secondary);
                text-transform: uppercase;
                letter-spacing: 0.8px;
                font-weight: 600;
            }

            .card-icon {
                font-size: 18px;
                opacity: 0.8;
            }

            .stat-value {
                font-family: var(--font-display);
                font-size: 36px;
                font-weight: 700;
                line-height: 1.1;
                margin-bottom: 6px;
                background: linear-gradient(135deg, #ffffff 0%, #e2e1ec 100%);
                -webkit-background-clip: text;
                -webkit-text-fill-color: transparent;
            }

            .stat-desc {
                font-size: 12px;
                color: var(--text-secondary);
            }

            /* Custom Grid for Content Sections */
            .main-content-layout {
                display: grid;
                grid-template-columns: 2fr 1fr;
                gap: 24px;
                align-items: start;
            }

            .left-column {
                display: flex;
                flex-direction: column;
                gap: 24px;
            }

            .section-card {
                background: var(--bg-glass);
                border: 1px solid var(--border-color);
                backdrop-filter: blur(16px);
                border-radius: 16px;
                padding: 24px;
                box-shadow: 0 8px 32px 0 rgba(0, 0, 0, 0.2);
                position: relative;
                transition: z-index 0.2s;
            }
            
            .section-card:hover {
                z-index: 10;
            }

            .section-title-bar {
                display: flex;
                justify-content: space-between;
                align-items: center;
                margin-bottom: 20px;
            }

            .section-title {
                font-family: var(--font-display);
                font-size: 18px;
                font-weight: 600;
                display: flex;
                align-items: center;
                gap: 8px;
            }

            /* Job Post Card */
            .job-badge {
                background: var(--color-primary-glow);
                border: 1px solid rgba(99, 102, 241, 0.3);
                color: #a5b4fc;
                padding: 2px 8px;
                border-radius: 4px;
                font-size: 12px;
                font-weight: 500;
            }

            .job-detail-grid {
                display: grid;
                grid-template-columns: auto 1fr;
                gap: 16px 24px;
            }

            .job-label {
                color: var(--text-secondary);
                font-size: 14px;
                font-weight: 500;
            }

            .job-value {
                font-size: 14px;
            }

            .job-highlight-list {
                display: flex;
                flex-wrap: wrap;
                gap: 8px;
                margin-top: 4px;
            }

            .job-highlight-tag {
                background: rgba(255, 255, 255, 0.05);
                border: 1px solid rgba(255, 255, 255, 0.08);
                color: var(--text-primary);
                padding: 3px 10px;
                border-radius: 6px;
                font-size: 12px;
            }

            /* Funnel Display */
            .funnel-container {
                display: flex;
                flex-direction: column;
                gap: 16px;
                padding: 10px 0;
            }

            .funnel-stage {
                display: flex;
                flex-direction: column;
                gap: 6px;
            }

            .funnel-stage-meta {
                display: flex;
                justify-content: space-between;
                font-size: 13px;
                font-weight: 500;
            }

            .funnel-stage-name {
                color: var(--text-secondary);
            }

            .funnel-stage-stats {
                font-family: var(--font-display);
                font-weight: 600;
            }

            .funnel-bar-outer {
                height: 12px;
                background: rgba(255, 255, 255, 0.04);
                border-radius: 99px;
                overflow: hidden;
                position: relative;
            }

            .funnel-bar-inner {
                height: 100%;
                border-radius: 99px;
                transition: width 1s ease-out;
            }

            /* History Table */
            .table-container {
                overflow-x: auto;
                width: 100%;
            }

            table {
                width: 100%;
                border-collapse: collapse;
                text-align: left;
                font-size: 14px;
            }

            th, td {
                padding: 14px 16px;
                border-bottom: 1px solid var(--border-color);
                vertical-align: middle;
            }

            th {
                color: var(--text-secondary);
                font-weight: 500;
                font-size: 13px;
                text-transform: uppercase;
                letter-spacing: 0.5px;
            }

            tr:last-child td {
                border-bottom: none;
            }

            tr:hover td {
                background: rgba(255, 255, 255, 0.01);
            }

            /* Badges & Scores */
            .score-badge {
                display: inline-flex;
                align-items: center;
                gap: 4px;
                font-weight: 600;
                font-family: var(--font-display);
                border-radius: 6px;
                padding: 2px 8px;
            }

            .score-high {
                background: var(--color-success-glow);
                color: #6ee7b7;
            }

            .score-mid {
                background: var(--color-warning-glow);
                color: #fcd34d;
            }

            .score-low {
                background: var(--color-error-glow);
                color: #fda4af;
            }

            .status-badge-custom {
                display: inline-block;
                padding: 3px 8px;
                border-radius: 6px;
                font-size: 12px;
                font-weight: 500;
                text-align: center;
            }

            .status-pending { background: rgba(99, 102, 241, 0.1); border: 1px solid rgba(99, 102, 241, 0.2); color: #a5b4fc; }
            .status-approved { background: rgba(6, 182, 212, 0.1); border: 1px solid rgba(6, 182, 212, 0.2); color: #67e8f9; }
            .status-sent { background: rgba(245, 158, 11, 0.1); border: 1px solid rgba(245, 158, 11, 0.2); color: #fde047; }
            .status-followed { background: rgba(16, 185, 129, 0.1); border: 1px solid rgba(16, 185, 129, 0.2); color: #6ee7b7; }
            .status-replied { background: rgba(16, 185, 129, 0.2); border: 1px solid var(--color-success); color: #10b981; }
            .status-ignored { background: rgba(255, 255, 255, 0.05); border: 1px solid rgba(255, 255, 255, 0.1); color: var(--text-secondary); }

            /* Detail Collapsible */
            .detail-cell {
                font-size: 13px;
                color: var(--text-secondary);
                max-width: 260px;
                overflow: hidden;
                text-overflow: ellipsis;
                white-space: nowrap;
                cursor: pointer;
            }

            .detail-cell:hover {
                color: var(--text-primary);
                text-decoration: underline;
            }

            /* Log Panel */
            .log-panel {
                margin-top: 24px;
            }

            .toggle-btn {
                background: transparent;
                border: 1px solid var(--border-color);
                color: var(--text-secondary);
                padding: 6px 14px;
                border-radius: 8px;
                font-size: 13px;
                cursor: pointer;
                transition: all 0.2s;
            }

            .toggle-btn:hover {
                border-color: var(--color-primary);
                color: var(--text-primary);
            }

            pre {
                background: #0d0c15;
                border: 1px solid var(--border-color);
                border-radius: 12px;
                padding: 16px;
                overflow-x: auto;
                font-family: 'Courier New', Courier, monospace;
                font-size: 12px;
                color: #a5b4fc;
                margin-top: 12px;
                max-height: 300px;
                display: none;
            }

            /* Modal Styles */
            .modal {
                display: none;
                position: fixed;
                top: 0;
                left: 0;
                width: 100%;
                height: 100%;
                background: rgba(0, 0, 0, 0.8);
                backdrop-filter: blur(8px);
                justify-content: center;
                align-items: center;
                z-index: 1000;
            }

            .modal-content {
                background: var(--bg-secondary);
                border: 1px solid var(--border-color);
                border-radius: 20px;
                width: 90%;
                max-width: 600px;
                padding: 32px;
                box-shadow: 0 20px 50px rgba(0,0,0,0.5);
                position: relative;
            }

            .modal-close {
                position: absolute;
                top: 20px;
                right: 20px;
                background: none;
                border: none;
                color: var(--text-secondary);
                font-size: 20px;
                cursor: pointer;
            }

            .modal-close:hover {
                color: var(--text-primary);
            }

            .modal-title {
                font-family: var(--font-display);
                font-size: 20px;
                margin-bottom: 16px;
                font-weight: 600;
            }

            .modal-body {
                display: flex;
                flex-direction: column;
                gap: 16px;
                font-size: 14px;
            }

            .info-block {
                background: rgba(255, 255, 255, 0.03);
                border: 1px solid var(--border-color);
                border-radius: 8px;
                padding: 12px 16px;
            }

            .info-block-title {
                font-size: 12px;
                color: var(--text-secondary);
                margin-bottom: 4px;
                text-transform: uppercase;
                letter-spacing: 0.5px;
            }

            @media (max-width: 1200px) {
                .dashboard-grid {
                    grid-template-columns: repeat(3, 1fr);
                }
                .main-content-layout {
                    grid-template-columns: 1fr;
                }
            }
            @media (max-width: 768px) {
                .dashboard-grid {
                    grid-template-columns: repeat(2, 1fr);
                }
            }

            @media (max-width: 640px) {
                .dashboard-grid {
                    grid-template-columns: 1fr;
                }
                body {
                    padding: 16px;
                }
            }

            /* 页签 Tabs 样式 */
            .crp-tabs-container {
                display: flex;
                justify-content: flex-start;
                align-items: center;
                gap: 8px;
                margin-top: 16px;
                margin-bottom: 8px;
                border-bottom: 1px solid var(--border-color);
                padding-bottom: 12px;
            }

            .crp-tab-btn {
                background: transparent;
                border: 1px solid transparent;
                color: var(--text-secondary);
                padding: 6px 16px;
                border-radius: 8px;
                font-size: 13px;
                font-weight: 500;
                cursor: pointer;
                transition: all 0.25s cubic-bezier(0.4, 0, 0.2, 1);
                position: relative;
            }

            .crp-tab-btn:hover {
                color: var(--text-primary);
                background: rgba(255, 255, 255, 0.03);
            }

            .crp-tab-btn.active {
                color: #ffffff;
                background: var(--color-primary-glow);
                border-color: rgba(99, 102, 241, 0.3);
                font-weight: 600;
                box-shadow: 0 4px 12px rgba(99, 102, 241, 0.1);
            }

            /* 已过滤状态标签样式 */
            .status-filtered {
                background: rgba(244, 63, 94, 0.1);
                border: 1px solid rgba(244, 63, 94, 0.2);
                color: #fda4af;
            }

            /* 详情弹窗中实时跟进对话历史样式 */
            .chat-history-section {
                border-top: 1px solid var(--border-color);
                padding-top: 16px;
                margin-top: 8px;
                display: none; /* 默认隐藏，有 candidate_id 时显示 */
            }

            .chat-history-title {
                font-size: 13px;
                font-weight: 600;
                color: var(--text-primary);
                margin-bottom: 12px;
                display: flex;
                align-items: center;
                gap: 6px;
            }

            .chat-bubble-container {
                max-height: 240px;
                overflow-y: auto;
                background: rgba(0, 0, 0, 0.2);
                border: 1px solid var(--border-color);
                border-radius: 12px;
                padding: 12px;
                display: flex;
                flex-direction: column;
                gap: 12px;
            }

            .chat-bubble {
                max-width: 85%;
                padding: 10px 14px;
                border-radius: 12px;
                font-size: 13px;
                line-height: 1.45;
                position: relative;
            }

            .chat-bubble.copilot {
                background: var(--color-primary-glow);
                border: 1px solid rgba(99, 102, 241, 0.25);
                color: #e0e7ff;
                align-self: flex-end;
                border-bottom-right-radius: 2px;
            }

            .chat-bubble.candidate {
                background: rgba(255, 255, 255, 0.05);
                border: 1px solid rgba(255, 255, 255, 0.08);
                color: #f1f1f6;
                align-self: flex-start;
                border-bottom-left-radius: 2px;
            }

            .chat-bubble-time {
                font-size: 10px;
                color: rgba(255, 255, 255, 0.3);
                margin-top: 4px;
                text-align: right;
            }

            /* Main Navigation Styles */
            .main-nav {
                display: flex;
                gap: 12px;
                margin-bottom: 24px;
                border-bottom: 1px solid var(--border-color);
                padding-bottom: 16px;
            }

            .nav-btn {
                background: rgba(255, 255, 255, 0.02);
                border: 1px solid var(--border-color);
                color: var(--text-secondary);
                padding: 10px 20px;
                border-radius: 12px;
                font-size: 14px;
                font-weight: 600;
                cursor: pointer;
                transition: all 0.25s cubic-bezier(0.4, 0, 0.2, 1);
                display: flex;
                align-items: center;
                gap: 8px;
            }

            .nav-btn:hover {
                color: var(--text-primary);
                background: rgba(255, 255, 255, 0.05);
                border-color: rgba(255, 255, 255, 0.15);
            }

            .nav-btn.active {
                color: #ffffff;
                background: var(--color-primary);
                border-color: var(--color-primary);
                box-shadow: 0 4px 20px rgba(99, 102, 241, 0.35);
            }

            /* Pagination Styles */
            .pagination-container {
                display: flex;
                justify-content: space-between;
                align-items: center;
                margin-top: 20px;
                padding-top: 16px;
                border-top: 1px solid var(--border-color);
            }

            .pagination-info {
                font-size: 13px;
                color: var(--text-secondary);
            }

            .pagination-buttons {
                display: flex;
                gap: 8px;
            }

            .page-btn {
                background: rgba(255, 255, 255, 0.03);
                border: 1px solid var(--border-color);
                color: var(--text-primary);
                padding: 6px 14px;
                border-radius: 8px;
                font-size: 13px;
                cursor: pointer;
                transition: all 0.2s;
                display: flex;
                align-items: center;
                gap: 4px;
            }

            .page-btn:hover:not(:disabled) {
                border-color: var(--color-primary);
                background: var(--color-primary-glow);
                color: #ffffff;
            }

            .page-btn:disabled {
                opacity: 0.3;
                cursor: not-allowed;
            }

            /* Chat History View (Split Screen layout) */
            .chat-module-container {
                display: grid;
                grid-template-columns: 340px 1fr;
                gap: 24px;
                height: calc(100vh - 220px);
                min-height: 650px;
                align-items: stretch;
            }

            .chat-sidebar {
                display: flex;
                flex-direction: column;
                padding: 20px;
                height: 100%;
                overflow: hidden;
            }

            .sidebar-header {
                margin-bottom: 16px;
            }

            .search-input {
                width: 100%;
                background: rgba(0, 0, 0, 0.25);
                border: 1px solid var(--border-color);
                border-radius: 10px;
                padding: 10px 14px;
                color: var(--text-primary);
                font-size: 13px;
                outline: none;
                transition: all 0.2s;
            }

            .search-input:focus {
                border-color: var(--color-primary);
                box-shadow: 0 0 0 2px var(--color-primary-glow);
            }

            .candidate-list {
                flex: 1;
                overflow-y: auto;
                display: flex;
                flex-direction: column;
                gap: 10px;
                padding-right: 6px;
            }

            .candidate-item {
                background: rgba(255, 255, 255, 0.02);
                border: 1px solid var(--border-color);
                border-radius: 12px;
                padding: 14px;
                cursor: pointer;
                transition: all 0.2s ease;
            }

            .candidate-item:hover {
                background: rgba(255, 255, 255, 0.05);
                border-color: rgba(255, 255, 255, 0.15);
            }

            .candidate-item.active {
                background: var(--color-primary-glow);
                border-color: rgba(99, 102, 241, 0.4);
            }

            .candidate-item-header {
                display: flex;
                justify-content: space-between;
                align-items: center;
                margin-bottom: 6px;
            }

            .candidate-item-name {
                font-weight: 600;
                font-size: 14px;
                color: var(--text-primary);
            }

            .candidate-item-time {
                font-size: 11px;
                color: var(--text-secondary);
            }

            .candidate-item-snippet {
                font-size: 12px;
                color: var(--text-secondary);
                white-space: nowrap;
                overflow: hidden;
                text-overflow: ellipsis;
            }

            .chat-main {
                display: flex;
                flex-direction: column;
                height: 100%;
                overflow: hidden;
            }

            .chat-window {
                height: 100%;
                display: flex;
                flex-direction: column;
                justify-content: center;
                align-items: center;
            }

            .chat-window-active {
                display: flex;
                flex-direction: column;
                height: 100%;
                gap: 20px;
            }

            .chat-header {
                padding: 20px;
            }

            .chat-header-name-row {
                display: flex;
                align-items: center;
                gap: 12px;
            }

            .chat-header-name {
                font-size: 20px;
                font-weight: 700;
                font-family: var(--font-display);
            }

            .chat-header-meta {
                font-size: 13px;
                color: var(--text-secondary);
                margin-top: 6px;
            }

            .chat-workspace {
                display: grid;
                grid-template-columns: 1fr 320px;
                gap: 20px;
                flex: 1;
                min-height: 0;
            }

            .chat-message-pane {
                display: flex;
                flex-direction: column;
                padding: 20px;
                height: 100%;
            }

            .chat-info-pane {
                padding: 20px;
                height: 100%;
                overflow-y: auto;
                display: flex;
                flex-direction: column;
                gap: 16px;
            }
        </style>
    </head>
    <body>
        <div class="container">
            <header>
                <div class="logo-area">
                    <span class="logo-icon">🤖</span>
                    <div>
                        <h1>猎头 Copilot</h1>
                        <p style="font-size: 12px; color: var(--text-secondary);">智能候选人筛选与互动平台</p>
                    </div>
                </div>
                <div class="header-status">
                    <div class="status-badge">
                        <span class="pulse-dot"></span>
                        <span id="systemConnection">连接数: -</span>
                    </div>
                </div>
            </header>

            <!-- Main Navigation Tabs -->
            <div class="main-nav">
                <button class="nav-btn active" id="navBtn-dashboard" onclick="switchMainView('dashboard')">
                    📊 监控面板
                </button>
                <button class="nav-btn" id="navBtn-chat" onclick="switchMainView('chat')">
                    💬 历史聊天记录
                </button>
            </div>

            <div id="view-dashboard">
            <!-- Top Row Stats -->
            <div class="dashboard-grid">
                <div class="card">
                    <div class="card-header-row">
                        <span class="card-title">今日打招呼</span>
                        <span class="card-icon">👋</span>
                    </div>
                    <div class="stat-value" id="statGreetings">-</div>
                    <div class="stat-desc" id="statGreetingsDesc">配额: 20 次</div>
                </div>
                <div class="card">
                    <div class="card-header-row">
                        <span class="card-title">今日回复数</span>
                        <span class="card-icon">📩</span>
                    </div>
                    <div class="stat-value" id="statReplies">-</div>
                    <div class="stat-desc" id="statRepliesDesc">今日回复总量限制: 150</div>
                </div>
                <div class="card">
                    <div class="card-header-row">
                        <span class="card-title">今日扫描/推荐</span>
                        <span class="card-icon">🔍</span>
                    </div>
                    <div class="stat-value" id="statScanned">-</div>
                    <div class="stat-desc" id="statScannedDesc">评估合格: -</div>
                </div>
                <div class="card">
                    <div class="card-header-row">
                        <span class="card-title">系统回复余量</span>
                        <span class="card-icon">⏳</span>
                    </div>
                    <div class="stat-value" id="statTokens">-</div>
                    <div class="stat-desc">每小时可用令牌数量</div>
                </div>
                <div class="card">
                    <div class="card-header-row">
                        <span class="card-title">运行模式 / 状态</span>
                        <span class="card-icon">⚙️</span>
                    </div>
                    <div class="stat-value" id="statStatus" style="font-size: 24px; padding-top: 10px; font-weight: 600; color: #10b981;">-</div>
                    <div class="stat-desc" id="statLLM">LLM: -</div>
                </div>
            </div>

            <!-- Main Sections -->
            <div class="main-content-layout">
                <!-- Left: Job Details + Table -->
                <div class="left-column">
                    <!-- Current Active Job -->
                    <div class="section-card">
                        <div class="section-title-bar">
                            <h2 class="section-title">
                                <span>📋</span>
                                <span>当前激活招聘岗位</span>
                            </h2>
                            <span class="job-badge">运行中</span>
                        </div>
                        <div id="jobDetailsContainer">
                            <div class="job-detail-grid">
                                <div class="job-label">岗位名称</div>
                                <div class="job-value" id="jobTitle" style="font-weight: 600;">加载中...</div>
                                
                                <div class="job-label">发布公司</div>
                                <div class="job-value" id="jobCompany">加载中...</div>
                                
                                <div class="job-label">薪资范围</div>
                                <div class="job-value" id="jobSalary" style="color: var(--color-cyan); font-weight: 600;">加载中...</div>
                                
                                <div class="job-label">职责描述</div>
                                <div class="job-value">
                                    <div class="hover-tooltip-container">
                                        <span class="hover-tooltip-trigger" id="jobDescTrigger">查看完整 JD 职责描述 ➔</span>
                                        <div class="hover-tooltip-card" id="jobDescCard">加载中...</div>
                                    </div>
                                </div>

                                <div class="job-label">任职要求</div>
                                <div class="job-value">
                                    <div class="hover-tooltip-container">
                                        <span class="hover-tooltip-trigger" id="jobReqTrigger">查看完整任职要求 ➔</span>
                                        <div class="hover-tooltip-card" id="jobReqCard">加载中...</div>
                                    </div>
                                </div>

                                <div class="job-label">岗位亮点</div>
                                <div class="job-value">
                                    <div class="job-highlight-list" id="jobHighlights">
                                        <!-- Highlights -->
                                    </div>
                                </div>
                            </div>
                        </div>
                    </div>

                    <!-- Greetings History Table -->
                    <div class="section-card">
                        <div class="section-title-bar">
                            <h2 class="section-title">
                                <span>👥</span>
                                <span>主动打招呼及跟进记录</span>
                        </div>
                        <div class="crp-tabs-container">
                            <button class="crp-tab-btn active" id="tabBtn-all" onclick="switchGreetingTab('all')">全部历史</button>
                            <button class="crp-tab-btn" id="tabBtn-sent" onclick="switchGreetingTab('sent')">已发送/沟通</button>
                            <button class="crp-tab-btn" id="tabBtn-pending" onclick="switchGreetingTab('pending')">待打招呼</button>
                            <button class="crp-tab-btn" id="tabBtn-filtered" onclick="switchGreetingTab('filtered')">已被过滤</button>
                        </div>
                        <div class="table-container">
                            <table>
                                <thead>
                                    <tr>
                                        <th>姓名</th>
                                        <th>求职意向/公司</th>
                                        <th>匹配评分</th>
                                        <th>沟通状态</th>
                                        <th>匹配理由</th>
                                        <th>发送时间</th>
                                    </tr>
                                </thead>
                                <tbody id="greetingsTableBody">
                                    <tr>
                                        <td colspan="6" style="text-align: center; color: var(--text-secondary);">加载中...</td>
                                    </tr>
                                </tbody>
                            </table>
                        </div>
                        <div class="pagination-container">
                            <div class="pagination-info" id="greetingPaginationInfo">
                                共 0 条记录，当前第 1 / 1 页
                            </div>
                            <div class="pagination-buttons">
                                <button class="page-btn" id="btnPrevPage" onclick="changeGreetingPage(-1)" disabled>
                                    ◀ 上一页
                                </button>
                                <button class="page-btn" id="btnNextPage" onclick="changeGreetingPage(1)" disabled>
                                    下一页 ▶
                                </button>
                            </div>
                        </div>
                    </div>
                </div>

                <!-- Right: Funnel & Controls -->
                <div class="right-column" style="display: flex; flex-direction: column; gap: 24px;">
                    <!-- Today Funnel Card -->
                    <div class="section-card">
                        <div class="section-title-bar">
                            <h2 class="section-title">
                                <span>📊</span>
                                <span>今日漏斗分析</span>
                            </h2>
                        </div>
                        <div class="funnel-container" id="todayFunnel">
                            <div class="funnel-stage">
                                <div class="funnel-stage-meta">
                                    <span class="funnel-stage-name">候选人扫描</span>
                                    <span class="funnel-stage-stats" id="funnelScanned">0</span>
                                </div>
                                <div class="funnel-bar-outer">
                                    <div class="funnel-bar-inner" id="barScanned" style="background: var(--text-secondary); width: 0%;"></div>
                                </div>
                            </div>
                            <div class="funnel-stage">
                                <div class="funnel-stage-meta">
                                    <span class="funnel-stage-name">推荐合格</span>
                                    <span class="funnel-stage-stats" id="funnelMatched">0</span>
                                </div>
                                <div class="funnel-bar-outer">
                                    <div class="funnel-bar-inner" id="barMatched" style="background: var(--color-warning); width: 0%;"></div>
                                </div>
                            </div>
                            <div class="funnel-stage">
                                <div class="funnel-stage-meta">
                                    <span class="funnel-stage-name">已打招呼</span>
                                    <span class="funnel-stage-stats" id="funnelSent">0</span>
                                </div>
                                <div class="funnel-bar-outer">
                                    <div class="funnel-bar-inner" id="barSent" style="background: var(--color-primary); width: 0%;"></div>
                                </div>
                            </div>
                            <div class="funnel-stage">
                                <div class="funnel-stage-meta">
                                    <span class="funnel-stage-name">已发跟进</span>
                                    <span class="funnel-stage-stats" id="funnelFollowed">0</span>
                                </div>
                                <div class="funnel-bar-outer">
                                    <div class="funnel-bar-inner" id="barFollowed" style="background: var(--color-cyan); width: 0%;"></div>
                                </div>
                            </div>
                            <div class="funnel-stage">
                                <div class="funnel-stage-meta">
                                    <span class="funnel-stage-name">候选人回复</span>
                                    <span class="funnel-stage-stats" id="funnelReplied">0</span>
                                </div>
                                <div class="funnel-bar-outer">
                                    <div class="funnel-bar-inner" id="barReplied" style="background: var(--color-success); width: 0%;"></div>
                                </div>
                            </div>
                        </div>
                    </div>

                    <!-- Total Funnel Card -->
                    <div class="section-card">
                        <div class="section-title-bar">
                            <h2 class="section-title">
                                <span>📈</span>
                                <span>历史累计漏斗</span>
                            </h2>
                        </div>
                        <div class="funnel-container" id="totalFunnel">
                            <div class="funnel-stage">
                                <div class="funnel-stage-meta">
                                    <span class="funnel-stage-name">总扫描数</span>
                                    <span class="funnel-stage-stats" id="totalScannedVal">0</span>
                                </div>
                                <div class="funnel-bar-outer">
                                    <div class="funnel-bar-inner" id="totalBarScanned" style="background: var(--text-secondary); width: 0%;"></div>
                                </div>
                            </div>
                            <div class="funnel-stage">
                                <div class="funnel-stage-meta">
                                    <span class="funnel-stage-name">总合格数</span>
                                    <span class="funnel-stage-stats" id="totalMatchedVal">0</span>
                                </div>
                                <div class="funnel-bar-outer">
                                    <div class="funnel-bar-inner" id="totalBarMatched" style="background: var(--color-warning); width: 0%;"></div>
                                </div>
                            </div>
                            <div class="funnel-stage">
                                <div class="funnel-stage-meta">
                                    <span class="funnel-stage-name">总打招呼</span>
                                    <span class="funnel-stage-stats" id="totalSentVal">0</span>
                                </div>
                                <div class="funnel-bar-outer">
                                    <div class="funnel-bar-inner" id="totalBarSent" style="background: var(--color-primary); width: 0%;"></div>
                                </div>
                            </div>
                            <div class="funnel-stage">
                                <div class="funnel-stage-meta">
                                    <span class="funnel-stage-name">总跟进数</span>
                                    <span class="funnel-stage-stats" id="totalFollowedVal">0</span>
                                </div>
                                <div class="funnel-bar-outer">
                                    <div class="funnel-bar-inner" id="totalBarFollowed" style="background: var(--color-cyan); width: 0%;"></div>
                                </div>
                            </div>
                            <div class="funnel-stage">
                                <div class="funnel-stage-meta">
                                    <span class="funnel-stage-name">总回复数</span>
                                    <span class="funnel-stage-stats" id="totalRepliedVal">0</span>
                                </div>
                                <div class="funnel-bar-outer">
                                    <div class="funnel-bar-inner" id="totalBarReplied" style="background: var(--color-success); width: 0%;"></div>
                                </div>
                            </div>
                        </div>
                    </div>
                </div>
            </div>

            <!-- Bottom Collapsible Debug Log -->
            <div class="log-panel">
                <button class="toggle-btn" onclick="toggleDebug()">🛠️ 显示完整系统 JSON 状态</button>
                <pre id="debugState">加载中...</pre>
            </div>
            </div> <!-- end of view-dashboard -->

            <!-- Chat View Section (Split Screen layout Option A) -->
            <div id="view-chat" class="chat-module-container" style="display: none;">
                <!-- Left: Candidates list -->
                <div class="chat-sidebar card">
                    <div class="sidebar-header">
                        <input type="text" id="chatSearchInput" class="search-input" placeholder="🔍 搜索候选人姓名..." oninput="handleChatSearch()">
                    </div>
                    <div class="candidate-list" id="chatCandidateList">
                        <div style="text-align: center; color: var(--text-secondary); padding: 20px;">暂无有聊天记录的候选人</div>
                    </div>
                </div>
                <!-- Right: Chat Window & Info Panel -->
                <div class="chat-main">
                    <div class="chat-window card" id="chatWindowPlaceholder">
                        <div style="display: flex; flex-direction: column; align-items: center; justify-content: center; height: 100%; color: var(--text-secondary);">
                            <span style="font-size: 48px; margin-bottom: 16px;">💬</span>
                            <span style="font-weight: 500;">请从左侧选择一个候选人以查看聊天记录</span>
                        </div>
                    </div>
                    
                    <div class="chat-window-active" id="chatWindowActive" style="display: none;">
                        <!-- Top header of the active conversation -->
                        <div class="chat-header card">
                            <div class="chat-header-info">
                                <div class="chat-header-name-row">
                                    <span class="chat-header-name" id="activeChatName">候选人姓名</span>
                                    <span id="activeChatScoreBadge"></span>
                                </div>
                                <div class="chat-header-meta" id="activeChatMeta">工作经历 · 学历 · 薪资</div>
                            </div>
                        </div>
                        
                        <!-- Middle: Scrollable messages and candidate matching details (split screen) -->
                        <div class="chat-workspace">
                            <!-- Left: Messages bubble list -->
                            <div class="chat-message-pane card">
                                <div class="chat-bubble-container" id="activeChatBubbleContainer" style="max-height: none; flex: 1; height: 100%;">
                                    <!-- Messages bubble list -->
                                </div>
                            </div>
                            <!-- Right: Candidate match analysis detail panel -->
                            <div class="chat-info-pane card">
                                <div class="info-block" style="margin-bottom: 8px;">
                                    <div class="info-block-title">智能评估理由</div>
                                    <div id="activeChatReason" style="line-height: 1.6; font-size: 13px; max-height: 220px; overflow-y: auto; white-space: pre-wrap;">-</div>
                                </div>
                                <div class="info-block">
                                    <div class="info-block-title">已发/预设跟进消息</div>
                                    <div id="activeChatFollowup" style="line-height: 1.6; font-size: 13px; max-height: 220px; overflow-y: auto; color: #a5b4fc; white-space: pre-wrap;">-</div>
                                </div>
                            </div>
                        </div>
                    </div>
                </div>
            </div>
        </div> <!-- end of container -->

        <!-- Detail Modal -->
        <div class="modal" id="candidateModal">
            <div class="modal-content">
                <button class="modal-close" onclick="closeModal()">✕</button>
                <div class="modal-title" id="modalName">候选人详细分析</div>
                <div class="modal-body">
                    <div class="info-block">
                        <div class="info-block-title">求职意向及背景</div>
                        <div id="modalDetails" style="font-weight: 500;">-</div>
                    </div>
                    <div class="info-block">
                        <div class="info-block-title">LLM 评估意见 (⭐ <span id="modalScore">-</span>)</div>
                        <div id="modalReason" style="line-height: 1.6;">-</div>
                    </div>
                    <div class="info-block">
                        <div class="info-block-title">已发/预设跟进消息</div>
                        <div id="modalFollowup" style="font-style: italic; color: #a5b4fc;">-</div>
                    </div>
                    <div class="chat-history-section" id="modalChatHistorySection">
                        <div class="chat-history-title">💬 沟通跟进对话历史</div>
                        <div class="chat-bubble-container" id="modalChatBubbleContainer">
                            <!-- 对话气泡动态生成 -->
                        </div>
                    </div>
                </div>
            </div>
        </div>

        <script>
            // Debug panel toggle
            function toggleDebug() {
                const el = document.getElementById('debugState');
                if (el.style.display === 'block') {
                    el.style.display = 'none';
                } else {
                    el.style.display = 'block';
                }
            }

            // Modal controller
            let activeGreetingsList = [];
            
            async function showCandidateModal(index) {
                const item = activeGreetingsList[index];
                if (!item) return;

                document.getElementById('modalName').textContent = `候选人: ${item.candidate_name || '未知'}`;
                document.getElementById('modalScore').textContent = item.match_score?.toFixed(1) || '?';
                
                const exp = item.candidate_experience || '未知年限';
                const edu = item.candidate_education || '未知学历';
                const sal = item.candidate_salary || '未知薪资';
                const company = item.candidate_company ? ` · 最近公司: ${item.candidate_company}` : '';
                document.getElementById('modalDetails').textContent = `${item.candidate_title || '未知职位'} (${exp} / ${edu} / ${sal})${company}`;
                
                document.getElementById('modalReason').textContent = item.match_reason || '无评估理由';
                document.getElementById('modalFollowup').textContent = item.followup_text ? `"${item.followup_text}"` : '未发送或无跟进消息';

                // 实时对话记录展示
                const chatSection = document.getElementById('modalChatHistorySection');
                const bubbleContainer = document.getElementById('modalChatBubbleContainer');
                
                if (item.candidate_id) {
                    chatSection.style.display = 'block';
                    bubbleContainer.innerHTML = '<div style="text-align: center; font-size: 12px; color: var(--text-secondary); padding: 12px;">正在加载实时对话记录...</div>';
                    
                    try {
                        const res = await fetch(`/api/candidates/${item.candidate_id}/messages`);
                        const data = await res.json();
                        const messages = data.messages || [];
                        
                        if (messages.length === 0) {
                            bubbleContainer.innerHTML = '<div style="text-align: center; font-size: 12px; color: var(--text-secondary); padding: 12px;">暂无对话消息记录</div>';
                        } else {
                            bubbleContainer.innerHTML = messages.map(msg => {
                                const bubbleClass = msg.role === 'copilot' ? 'copilot' : 'candidate';
                                const roleLabel = msg.role === 'copilot' ? 'Copilot 助手' : item.candidate_name;
                                return `
                                    <div class="chat-bubble ${bubbleClass}">
                                        <div style="font-weight: 600; font-size: 11px; margin-bottom: 2px;">${roleLabel}</div>
                                        <div>${msg.content}</div>
                                        <div class="chat-bubble-time">${formatTime(msg.created_at)}</div>
                                    </div>
                                `;
                            }).join('');
                            // 滚动到底部
                            setTimeout(() => {
                                bubbleContainer.scrollTop = bubbleContainer.scrollHeight;
                            }, 50);
                        }
                    } catch (e) {
                        console.error("Failed to load chat history: ", e);
                        bubbleContainer.innerHTML = '<div style="text-align: center; font-size: 12px; color: var(--color-error); padding: 12px;">加载失败，请检查后端服务</div>';
                    }
                } else {
                    chatSection.style.display = 'none';
                }

                document.getElementById('candidateModal').style.display = 'flex';
            }

            function closeModal() {
                document.getElementById('candidateModal').style.display = 'none';
            }

            // Close modal when click outside content
            window.onclick = function(event) {
                const modal = document.getElementById('candidateModal');
                if (event.target == modal) {
                    modal.style.display = "none";
                }
            }

            // Helper for badges
            function getStatusBadge(status) {
                const statusLabels = {
                    'filtered': '已被过滤',
                    'pending': '待打招呼',
                    'approved': '已审核',
                    'sent': '已发招呼',
                    'followed_up': '已发跟进',
                    'replied': '已回复',
                    'ignored': '已略过'
                };
                const label = statusLabels[status] || status;
                const normStatus = status === 'followed_up' ? 'followed' : status;
                return `<span class="status-badge-custom status-${normStatus}">${label}</span>`;
            }

            function getScoreBadge(score) {
                if (!score) return '-';
                let scoreClass = 'score-low';
                if (score >= 8.0) scoreClass = 'score-high';
                else if (score >= 6.5) scoreClass = 'score-mid';
                return `<span class="score-badge ${scoreClass}">⭐ ${score.toFixed(1)}</span>`;
            }

            function formatTime(isoStr) {
                if (!isoStr) return '-';
                try {
                    const d = new Date(isoStr);
                    return d.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' }) + ' ' +
                           d.toLocaleDateString('zh-CN', { month: '2-digit', day: '2-digit' });
                } catch {
                    return isoStr;
                }
            }

            // Fetch and update data
            async function refreshDashboard() {
                try {
                    // 1. Fetch system status
                    const statusRes = await fetch('/api/status');
                    const statusData = await statusRes.json();
                    
                    document.getElementById('systemConnection').textContent = `连接数: ${statusData.connections}`;
                    document.getElementById('statGreetings').textContent = `${statusData.rate_limiter.greeting_daily.used} / ${statusData.rate_limiter.greeting_daily.limit}`;
                    document.getElementById('statGreetingsDesc').textContent = `剩余打招呼: ${statusData.rate_limiter.greeting_daily.remaining} 次`;
                    
                    document.getElementById('statReplies').textContent = statusData.rate_limiter.daily_count;
                    document.getElementById('statRepliesDesc').textContent = `今日上限: ${statusData.rate_limiter.daily_max} (包含打招呼)`;
                    
                    document.getElementById('statTokens').textContent = statusData.rate_limiter.reply_tokens_remaining;
                    
                    const workStatus = statusData.rate_limiter.is_work_hours ? '🟢 工作时间' : '🔴 非工作时间';
                    document.getElementById('statStatus').textContent = workStatus;
                    document.getElementById('statStatus').style.color = statusData.rate_limiter.is_work_hours ? '#10b981' : '#f43f5e';
                    
                    document.getElementById('statLLM').textContent = `LLM: ${statusData.llm.provider} (${statusData.llm.model})`;
                    
                    document.getElementById('debugState').textContent = JSON.stringify(statusData, null, 2);

                    // 2. Fetch Active Job Details
                    const jobRes = await fetch('/api/job');
                    const jobData = await jobRes.json();
                    if (jobData && jobData.job) {
                        document.getElementById('jobTitle').textContent = jobData.job.title;
                        document.getElementById('jobCompany').textContent = jobData.job.company || '自营招聘';
                        document.getElementById('jobSalary').textContent = jobData.job.salary_range || '未设薪资';
                        document.getElementById('jobDescCard').textContent = jobData.job.description || '无详细描述';
                        document.getElementById('jobReqCard').textContent = jobData.job.requirements || '无任职要求';
                        
                        const highlights = jobData.job.highlights || '';
                        const hlContainer = document.getElementById('jobHighlights');
                        hlContainer.innerHTML = '';
                        highlights.split(/[,，;|]/).filter(h => h.trim()).forEach(hl => {
                            const tag = document.createElement('span');
                            tag.className = 'job-highlight-tag';
                            tag.textContent = hl.trim();
                            hlContainer.appendChild(tag);
                        });
                    } else {
                        document.getElementById('jobTitle').textContent = '未激活岗位';
                        document.getElementById('jobCompany').textContent = '-';
                        document.getElementById('jobSalary').textContent = '-';
                        document.getElementById('jobDescCard').textContent = '请先前往职位管理同步岗位';
                        document.getElementById('jobReqCard').textContent = '请先前往职位管理同步岗位';
                        document.getElementById('jobHighlights').innerHTML = '<span style="color: var(--text-secondary);">请先在主应用配置活跃职位</span>';
                    }

                    // 3. Fetch Funnel Metrics
                    const statsRes = await fetch('/api/greetings/stats');
                    const statsData = await statsRes.json();
                    
                    const today = statsData.stats.today;
                    const total = statsData.stats.total;

                    // Today funnel UI
                    document.getElementById('funnelScanned').textContent = today.scanned;
                    document.getElementById('funnelMatched').textContent = today.matched;
                    document.getElementById('funnelSent').textContent = today.sent;
                    document.getElementById('funnelFollowed').textContent = today.followed_up;
                    document.getElementById('funnelReplied').textContent = today.replied;

                    // Top Card Update
                    document.getElementById('statScanned').textContent = `${today.scanned} 人`;
                    document.getElementById('statScannedDesc').textContent = `评估合格: ${today.matched} 人 / 过滤: ${today.scanned - today.matched} 人`;

                    const barScannedWidth = today.scanned > 0 ? 100 : 0;
                    const barMatchedWidth = today.scanned > 0 ? (today.matched / today.scanned * 100) : 0;
                    const barSentWidth = today.matched > 0 ? (today.sent / today.matched * 100) : 0;
                    const barFollowedWidth = today.sent > 0 ? (today.followed_up / today.sent * 100) : 0;
                    const barRepliedWidth = today.followed_up > 0 ? (today.replied / today.followed_up * 100) : 0;

                    document.getElementById('barScanned').style.width = barScannedWidth + '%';
                    document.getElementById('barMatched').style.width = barMatchedWidth + '%';
                    document.getElementById('barSent').style.width = barSentWidth + '%';
                    document.getElementById('barFollowed').style.width = barFollowedWidth + '%';
                    document.getElementById('barReplied').style.width = barRepliedWidth + '%';

                    // Total funnel UI
                    document.getElementById('totalScannedVal').textContent = total.scanned;
                    document.getElementById('totalMatchedVal').textContent = total.matched;
                    document.getElementById('totalSentVal').textContent = total.sent;
                    document.getElementById('totalFollowedVal').textContent = total.followed_up;
                    document.getElementById('totalRepliedVal').textContent = total.replied;

                    const totalBarScannedWidth = total.scanned > 0 ? 100 : 0;
                    const totalBarMatchedWidth = total.scanned > 0 ? (total.matched / total.scanned * 100) : 0;
                    const totalBarSentWidth = total.matched > 0 ? (total.sent / total.matched * 100) : 0;
                    const totalBarFollowedWidth = total.sent > 0 ? (total.followed_up / total.sent * 100) : 0;
                    const totalBarRepliedWidth = total.followed_up > 0 ? (total.replied / total.followed_up * 100) : 0;

                    document.getElementById('totalBarScanned').style.width = totalBarScannedWidth + '%';
                    document.getElementById('totalBarMatched').style.width = totalBarMatchedWidth + '%';
                    document.getElementById('totalBarSent').style.width = totalBarSentWidth + '%';
                    document.getElementById('totalBarFollowed').style.width = totalBarFollowedWidth + '%';
                    document.getElementById('totalBarReplied').style.width = totalBarRepliedWidth + '%';

                    // 4. Fetch Greetings History
                    await refreshGreetingsHistory();

                    // 5. 若当前在聊天页面，静默刷新当前选中的候选人聊天记录气泡
                    const viewChat = document.getElementById('view-chat');
                    if (viewChat && viewChat.style.display === 'grid' && currentSelectedCandidateId) {
                        await refreshActiveChatMessagePane();
                    }

                } catch(e) {
                    console.error("Dashboard refresh error: ", e);
                }
            }

            // 主视图切换控制器 (方案 A)
            function switchMainView(view) {
                const views = ['dashboard', 'chat'];
                views.forEach(v => {
                    const el = document.getElementById(`view-${v}`);
                    const btn = document.getElementById(`navBtn-${v}`);
                    if (v === view) {
                        el.style.display = (v === 'chat') ? 'grid' : 'block';
                        btn.classList.add('active');
                    } else {
                        el.style.display = 'none';
                        btn.classList.remove('active');
                    }
                });

                if (view === 'chat') {
                    loadChatCandidates();
                }
            }

            // 打招呼列表分页状态与处理器
            let currentActiveTab = 'all';
            let greetingCurrentPage = 1;
            let greetingTotalPages = 1;
            const greetingPageLimit = 15;

            async function switchGreetingTab(status) {
                currentActiveTab = status;
                greetingCurrentPage = 1; // 切换 Tab 时重置为第一页
                
                // 更新 tab 按钮高亮状态
                const buttons = document.querySelectorAll('.crp-tab-btn');
                buttons.forEach(btn => {
                    if (btn.id === `tabBtn-${status}`) {
                        btn.classList.add('active');
                    } else {
                        btn.classList.remove('active');
                    }
                });
                
                // 表格展示加载中
                const tbody = document.getElementById('greetingsTableBody');
                tbody.innerHTML = '<tr><td colspan="6" style="text-align: center; color: var(--text-secondary);">加载中...</td></tr>';
                
                await refreshGreetingsHistory();
            }

            async function changeGreetingPage(delta) {
                const targetPage = greetingCurrentPage + delta;
                if (targetPage < 1 || targetPage > greetingTotalPages) return;
                greetingCurrentPage = targetPage;
                
                const tbody = document.getElementById('greetingsTableBody');
                tbody.innerHTML = '<tr><td colspan="6" style="text-align: center; color: var(--text-secondary);">加载中...</td></tr>';
                
                await refreshGreetingsHistory();
            }

            async function refreshGreetingsHistory() {
                try {
                    const greetRes = await fetch(`/api/greetings?page=${greetingCurrentPage}&limit=${greetingPageLimit}&status=${currentActiveTab}`);
                    const greetData = await greetRes.json();
                    const list = greetData.greetings || [];
                    const total = greetData.total || 0;
                    greetingTotalPages = greetData.total_pages || 1;
                    activeGreetingsList = list;

                    // 更新分页控制器显示与可用状态
                    document.getElementById('greetingPaginationInfo').textContent = `共 ${total} 条记录，当前第 ${greetingCurrentPage} / ${greetingTotalPages} 页`;
                    document.getElementById('btnPrevPage').disabled = (greetingCurrentPage <= 1);
                    document.getElementById('btnNextPage').disabled = (greetingCurrentPage >= greetingTotalPages);

                    const tbody = document.getElementById('greetingsTableBody');
                    if (list.length === 0) {
                        tbody.innerHTML = '<tr><td colspan="6" style="text-align: center; color: var(--text-secondary);">暂无该状态下的历史记录</td></tr>';
                    } else {
                        tbody.innerHTML = list.map((item, index) => {
                            const subInfo = item.candidate_company ? `${item.candidate_title} | ${item.candidate_company}` : item.candidate_title;
                            return `
                                <tr>
                                    <td style="font-weight: 500;">${item.candidate_name || '未知'}</td>
                                    <td>
                                        <div style="font-size: 13px;">${subInfo || '未知意向'}</div>
                                        <div style="font-size: 11px; color: var(--text-secondary); margin-top: 2px;">
                                            ${item.candidate_experience || ''} · ${item.candidate_education || ''} · ${item.candidate_salary || ''}
                                        </div>
                                    </td>
                                    <td>${getScoreBadge(item.match_score)}</td>
                                    <td>${getStatusBadge(item.status)}</td>
                                    <td>
                                        <div class="detail-cell" onclick="showCandidateModal(${index})">
                                            ${item.match_reason || '无理由'}
                                        </div>
                                    </td>
                                    <td style="font-size: 12px; color: var(--text-secondary);">${formatTime(item.sent_at || item.created_at)}</td>
                                </tr>
                            `;
                        }).join('');
                    }
                } catch (e) {
                    console.error("Failed to load greetings history: ", e);
                }
            }

            // 聊天记录管理页面控制逻辑
            let activeCandidatesList = [];
            let currentSelectedCandidateId = null;

            async function loadChatCandidates() {
                try {
                    const q = document.getElementById('chatSearchInput').value.trim();
                    const url = q ? `/api/chat/candidates?q=${encodeURIComponent(q)}` : '/api/chat/candidates';
                    const res = await fetch(url);
                    const data = await res.json();
                    const list = data.candidates || [];
                    activeCandidatesList = list;

                    const listContainer = document.getElementById('chatCandidateList');
                    if (list.length === 0) {
                        listContainer.innerHTML = '<div style="text-align: center; color: var(--text-secondary); padding: 20px;">未找到有聊天记录的候选人</div>';
                    } else {
                        listContainer.innerHTML = list.map((c, index) => {
                            const activeClass = (c.id === currentSelectedCandidateId) ? 'active' : '';
                            const timeStr = formatTime(c.last_message_time);
                            const lastMsgPrefix = c.last_message_role === 'copilot' ? 'Copilot: ' : '候选人: ';
                            return `
                                <div class="candidate-item ${activeClass}" onclick="selectChatCandidate(${c.id}, ${index})">
                                    <div class="candidate-item-header">
                                        <span class="candidate-item-name">${c.name || '未知候选人'}</span>
                                        <span class="candidate-item-time">${timeStr}</span>
                                    </div>
                                    <div class="candidate-item-snippet">${lastMsgPrefix}${c.last_message_content || ''}</div>
                                </div>
                            `;
                        }).join('');
                    }
                } catch (e) {
                    console.error("Failed to load chat candidates:", e);
                }
            }

            let searchTimeout = null;
            function handleChatSearch() {
                if (searchTimeout) clearTimeout(searchTimeout);
                searchTimeout = setTimeout(loadChatCandidates, 300);
            }

            async function selectChatCandidate(candidateId, index) {
                currentSelectedCandidateId = candidateId;
                
                // 列表选中态高亮
                const items = document.querySelectorAll('.candidate-item');
                items.forEach((item, idx) => {
                    if (idx === index) item.classList.add('active');
                    else item.classList.remove('active');
                });

                const candidate = activeCandidatesList[index];
                if (!candidate) return;

                // 显示对话窗口
                document.getElementById('chatWindowPlaceholder').style.display = 'none';
                document.getElementById('chatWindowActive').style.display = 'flex';

                // 设置头部及元数据
                document.getElementById('activeChatName').textContent = candidate.name || '未知候选人';
                document.getElementById('activeChatScoreBadge').innerHTML = getScoreBadge(candidate.match_score);
                
                const exp = candidate.candidate_experience || '未知年限';
                const edu = candidate.candidate_education || '未知学历';
                const sal = candidate.candidate_salary || '未知薪资';
                const company = candidate.candidate_company ? ` · 最近公司: ${candidate.candidate_company}` : '';
                document.getElementById('activeChatMeta').textContent = `${candidate.current_title || '未知职位'} (${exp} / ${edu} / ${sal})${company}`;

                // 侧边栏智能评估理由及跟进
                document.getElementById('activeChatReason').textContent = candidate.match_reason || '无智能评估理由';
                document.getElementById('activeChatFollowup').textContent = candidate.followup_text ? `"${candidate.followup_text}"` : '未发送或无跟进消息';

                // 获取并载入消息列表
                const bubbleContainer = document.getElementById('activeChatBubbleContainer');
                bubbleContainer.innerHTML = '<div style="text-align: center; font-size: 12px; color: var(--text-secondary); padding: 20px;">正在加载对话记录...</div>';

                try {
                    const res = await fetch(`/api/candidates/${candidateId}/messages`);
                    const data = await res.json();
                    const messages = data.messages || [];
                    
                    if (messages.length === 0) {
                        bubbleContainer.innerHTML = '<div style="text-align: center; font-size: 12px; color: var(--text-secondary); padding: 20px;">暂无对话消息记录</div>';
                    } else {
                        bubbleContainer.innerHTML = messages.map(msg => {
                            const bubbleClass = msg.role === 'copilot' ? 'copilot' : 'candidate';
                            const roleLabel = msg.role === 'copilot' ? 'Copilot 助手' : candidate.name;
                            return `
                                <div class="chat-bubble ${bubbleClass}">
                                    <div style="font-weight: 600; font-size: 11px; margin-bottom: 2px;">${roleLabel}</div>
                                    <div>${msg.content}</div>
                                    <div class="chat-bubble-time">${formatTime(msg.created_at)}</div>
                                </div>
                            `;
                        }).join('');
                        
                        // 滚动到底部
                        setTimeout(() => {
                            bubbleContainer.scrollTop = bubbleContainer.scrollHeight;
                        }, 50);
                    }
                } catch (e) {
                    console.error("Failed to load conversation:", e);
                    bubbleContainer.innerHTML = '<div style="text-align: center; font-size: 12px; color: var(--color-error); padding: 20px;">加载失败，请检查服务连接</div>';
                }
            }

            async function refreshActiveChatMessagePane() {
                if (!currentSelectedCandidateId) return;
                const bubbleContainer = document.getElementById('activeChatBubbleContainer');
                try {
                    const res = await fetch(`/api/candidates/${currentSelectedCandidateId}/messages`);
                    const data = await res.json();
                    const messages = data.messages || [];
                    if (messages.length > 0) {
                        const candidate = activeCandidatesList.find(c => c.id === currentSelectedCandidateId);
                        const nameLabel = candidate ? candidate.name : '候选人';
                        
                        // 对比当前气泡数量，防止每次刷新导致闪烁或滚动位置丢失
                        const currentBubbles = bubbleContainer.querySelectorAll('.chat-bubble');
                        if (messages.length !== currentBubbles.length) {
                            const isNearBottom = bubbleContainer.scrollHeight - bubbleContainer.scrollTop - bubbleContainer.clientHeight < 50;
                            
                            bubbleContainer.innerHTML = messages.map(msg => {
                                const bubbleClass = msg.role === 'copilot' ? 'copilot' : 'candidate';
                                const roleLabel = msg.role === 'copilot' ? 'Copilot 助手' : nameLabel;
                                return `
                                    <div class="chat-bubble ${bubbleClass}">
                                        <div style="font-weight: 600; font-size: 11px; margin-bottom: 2px;">${roleLabel}</div>
                                        <div>${msg.content}</div>
                                        <div class="chat-bubble-time">${formatTime(msg.created_at)}</div>
                                    </div>
                                `;
                            }).join('');
                            
                            if (isNearBottom) {
                                bubbleContainer.scrollTop = bubbleContainer.scrollHeight;
                            }
                        }
                    }

                    // 同时静默获取当前候选人最新画像以更新评估原因、职位及分数（防止刚上报的微简历和背景评估未展示）
                    const q = document.getElementById('chatSearchInput').value.trim();
                    const listRes = await fetch(q ? `/api/chat/candidates?q=${encodeURIComponent(q)}` : '/api/chat/candidates');
                    const listData = await listRes.json();
                    const list = listData.candidates || [];
                    activeCandidatesList = list;
                    
                    const candidate = list.find(c => c.id === currentSelectedCandidateId);
                    if (candidate) {
                        document.getElementById('activeChatScoreBadge').innerHTML = getScoreBadge(candidate.match_score);
                        document.getElementById('activeChatReason').textContent = candidate.match_reason || '无智能评估理由';
                        document.getElementById('activeChatFollowup').textContent = candidate.followup_text ? `"${candidate.followup_text}"` : '未发送或无跟进消息';
                        
                        const exp = candidate.candidate_experience || '未知年限';
                        const edu = candidate.candidate_education || '未知学历';
                        const sal = candidate.candidate_salary || '未知薪资';
                        const company = candidate.candidate_company ? ` · 最近公司: ${candidate.candidate_company}` : '';
                        document.getElementById('activeChatMeta').textContent = `${candidate.current_title || '未知职位'} (${exp} / ${edu} / ${sal})${company}`;
                    }
                } catch (e) {
                    console.error("Silent message refresh failed: ", e);
                }
            }

            // 初始刷新与周期刷新
            refreshDashboard();
            setInterval(refreshDashboard, 5000);
        </script>
    </body>
    </html>
    """



# ============================================================
# 启动入口
# ============================================================

if __name__ == "__main__":
    import uvicorn
    uvicorn.run(
        "main:app",
        host=settings.HOST,
        port=settings.PORT,
        reload=settings.DEBUG,
        log_level="info",
    )
