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
from db.database import init_db, get_active_job_post, get_greeting_history, get_greeting_stats, save_or_update_job_post
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

            logger.warning(f"未知消息类型: {message.get('type')}")

    except WebSocketDisconnect:
        manager.disconnect(websocket)
    except Exception as e:
        logger.error(f"WebSocket 错误: {e}")
        manager.disconnect(websocket)


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
async def get_greetings(limit: int = 50):
    """获取打招呼历史"""
    history = await get_greeting_history(limit)
    return {"greetings": history}


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
                            </h2>
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
        </div>

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
            
            function showCandidateModal(index) {
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
                    'pending': '待评估',
                    'approved': '已批准',
                    'sent': '已打招呼',
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
                    const greetRes = await fetch('/api/greetings?limit=15');
                    const greetData = await greetRes.json();
                    const list = greetData.greetings || [];
                    activeGreetingsList = list;

                    const tbody = document.getElementById('greetingsTableBody');
                    if (list.length === 0) {
                        tbody.innerHTML = '<tr><td colspan="6" style="text-align: center; color: var(--text-secondary);">暂无主动打招呼历史</td></tr>';
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

                } catch(e) {
                    console.error("Dashboard refresh error: ", e);
                }
            }

            // Initial and interval refresh
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
