"""
数据库管理 — 异步 SQLite 操作
"""

import aiosqlite
import os
from pathlib import Path

from config import settings


DB_PATH = settings.DB_PATH


async def get_db() -> aiosqlite.Connection:
    """获取数据库连接"""
    os.makedirs(os.path.dirname(DB_PATH), exist_ok=True)
    db = await aiosqlite.connect(DB_PATH)
    db.row_factory = aiosqlite.Row
    await db.execute("PRAGMA journal_mode=WAL")
    await db.execute("PRAGMA foreign_keys=ON")
    return db


async def init_db():
    """初始化数据库（建表与迁移）"""
    db = await get_db()
    try:
        # 1. 安全迁移：如果旧表 greetings 存在，重命名为 recommendations
        try:
            cursor = await db.execute("SELECT name FROM sqlite_master WHERE type='table' AND name='recommendations'")
            rec_exists = await cursor.fetchone()
            if not rec_exists:
                cursor = await db.execute("SELECT name FROM sqlite_master WHERE type='table' AND name='greetings'")
                greet_exists = await cursor.fetchone()
                if greet_exists:
                    await db.execute("ALTER TABLE greetings RENAME TO recommendations")
                    print("[DB] 旧表 greetings 成功重命名为 recommendations")
        except Exception as e:
            print(f"[DB] 重命名旧表失败（或已迁移）: {e}")

        # 2. 执行 schema.sql 创建新表和索引
        schema_path = Path(__file__).parent / "schema.sql"
        schema_sql = schema_path.read_text(encoding="utf-8")
        await db.executescript(schema_sql)
        
        # 3. 动态添加列
        # 3.1 recommendations 添加 candidate_id 关联列
        try:
            await db.execute("ALTER TABLE recommendations ADD COLUMN candidate_id INTEGER REFERENCES candidates(id)")
            print("[DB] 动态为 recommendations 添加 candidate_id 关联列")
        except Exception:
            pass

        # 3.2 daily_stats 添加每日扫描和匹配列
        try:
            await db.execute("ALTER TABLE daily_stats ADD COLUMN candidates_scanned INTEGER DEFAULT 0")
        except Exception:
            pass
        try:
            await db.execute("ALTER TABLE daily_stats ADD COLUMN candidates_matched INTEGER DEFAULT 0")
        except Exception:
            pass

        await db.commit()
        print("[DB] 数据库初始化/迁移完成")
    finally:
        await db.close()


async def get_or_create_candidate(chat_id: str) -> dict:
    """获取或创建候选人记录"""
    db = await get_db()
    try:
        cursor = await db.execute(
            "SELECT * FROM candidates WHERE boss_chat_id = ?", (chat_id,)
        )
        row = await cursor.fetchone()
        if row:
            return dict(row)

        await db.execute(
            "INSERT INTO candidates (boss_chat_id, status) VALUES (?, 'new')",
            (chat_id,),
        )
        await db.commit()

        cursor = await db.execute(
            "SELECT * FROM candidates WHERE boss_chat_id = ?", (chat_id,)
        )
        row = await cursor.fetchone()
        return dict(row)
    finally:
        await db.close()


async def save_message(candidate_id: int, role: str, content: str, is_auto: bool = True):
    """保存消息记录"""
    db = await get_db()
    try:
        await db.execute(
            "INSERT INTO messages (candidate_id, role, content, is_auto) VALUES (?, ?, ?, ?)",
            (candidate_id, role, content, 1 if is_auto else 0),
        )
        await db.commit()
    finally:
        await db.close()


async def get_conversation_history(candidate_id: int, limit: int = 20) -> list:
    """获取对话历史"""
    db = await get_db()
    try:
        cursor = await db.execute(
            "SELECT role, content FROM messages WHERE candidate_id = ? ORDER BY created_at DESC LIMIT ?",
            (candidate_id, limit),
        )
        rows = await cursor.fetchall()
        # 反转顺序（从旧到新）
        return [{"role": row["role"], "content": row["content"]} for row in reversed(rows)]
    finally:
        await db.close()


async def update_candidate_status(candidate_id: int, status: str):
    """更新候选人状态"""
    db = await get_db()
    try:
        await db.execute(
            "UPDATE candidates SET status = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?",
            (status, candidate_id),
        )
        await db.commit()
    finally:
        await db.close()


async def get_active_job_post() -> dict | None:
    """获取当前活跃的岗位信息"""
    db = await get_db()
    try:
        cursor = await db.execute(
            "SELECT * FROM job_posts WHERE is_active = 1 ORDER BY updated_at DESC LIMIT 1"
        )
        row = await cursor.fetchone()
        return dict(row) if row else None
    finally:
        await db.close()


async def increment_daily_stat(field: str, amount: int = 1):
    """递增每日统计"""
    from datetime import date

    today = date.today().isoformat()
    db = await get_db()
    try:
        await db.execute(
            f"""INSERT INTO daily_stats (date, {field})
                VALUES (?, ?)
                ON CONFLICT(date) DO UPDATE SET {field} = {field} + ?""",
            (today, amount, amount),
        )
        await db.commit()
    finally:
        await db.close()


# ============================================================
# 智能推荐与主动打招呼 — 数据库操作
# ============================================================

async def save_greeting(candidate_data: dict, match_score: float,
                         match_reason: str, followup_text: str,
                         job_post_id: int | None = None,
                         status: str = 'pending') -> dict:
    """保存待打招呼候选人记录"""
    import json

    db = await get_db()
    try:
        tags_json = json.dumps(candidate_data.get("tags", []), ensure_ascii=False)
        await db.execute(
            """INSERT INTO recommendations
               (candidate_name, candidate_title, candidate_company,
                candidate_experience, candidate_education, candidate_salary,
                candidate_tags, candidate_job_status, candidate_advantage,
                candidate_work_history, match_score, match_reason,
                followup_text, job_post_id, status)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
            (
                candidate_data.get("name", ""),
                candidate_data.get("title", ""),
                candidate_data.get("company", ""),
                candidate_data.get("experience", ""),
                candidate_data.get("education", ""),
                candidate_data.get("salary", ""),
                tags_json,
                candidate_data.get("jobStatus", ""),
                candidate_data.get("advantage", ""),
                candidate_data.get("workHistory", ""),
                match_score,
                match_reason,
                followup_text,
                job_post_id,
                status,
            ),
        )
        await db.commit()

        # 返回刚插入的记录
        cursor = await db.execute("SELECT last_insert_rowid()")
        row = await cursor.fetchone()
        greeting_id = row[0]

        cursor = await db.execute("SELECT * FROM recommendations WHERE id = ?", (greeting_id,))
        row = await cursor.fetchone()
        return dict(row)
    finally:
        await db.close()


async def update_greeting_status(greeting_id: int, status: str,
                                 extra_fields: dict | None = None):
    """更新打招呼记录状态"""
    db = await get_db()
    try:
        sets = ["status = ?"]
        params = [status]

        if extra_fields:
            for key, value in extra_fields.items():
                sets.append(f"{key} = ?")
                params.append(value)

        params.append(greeting_id)
        await db.execute(
            f"UPDATE recommendations SET {', '.join(sets)} WHERE id = ?",
            params,
        )
        await db.commit()
    finally:
        await db.close()


async def link_recommendation_to_candidate(recommendation_id: int, candidate_id: int):
    """绑定评估记录与聊天候选人记录"""
    db = await get_db()
    try:
        await db.execute(
            "UPDATE recommendations SET candidate_id = ? WHERE id = ?",
            (candidate_id, recommendation_id),
        )
        await db.commit()
    finally:
        await db.close()


async def get_today_greeting_count() -> int:
    """获取今日已发送打招呼数量"""
    from datetime import date

    today = date.today().isoformat()
    db = await get_db()
    try:
        cursor = await db.execute(
            """SELECT COUNT(*) FROM recommendations
               WHERE status IN ('sent', 'followed_up', 'replied')
               AND DATE(sent_at) = ?""",
            (today,),
        )
        row = await cursor.fetchone()
        return row[0] if row else 0
    finally:
        await db.close()


async def get_pending_greetings(job_post_id: int | None = None) -> list:
    """获取待处理（已审核但未发送）的打招呼记录"""
    db = await get_db()
    try:
        if job_post_id:
            cursor = await db.execute(
                """SELECT * FROM recommendations
                   WHERE status = 'approved' AND job_post_id = ?
                   ORDER BY match_score DESC""",
                (job_post_id,),
            )
        else:
            cursor = await db.execute(
                """SELECT * FROM recommendations
                   WHERE status = 'approved'
                   ORDER BY match_score DESC"""
            )
        rows = await cursor.fetchall()
        return [dict(row) for row in rows]
    finally:
        await db.close()


async def get_greeting_history(limit: int = 50, status_filter: str = 'sent') -> list:
    """获取推荐和打招呼历史记录，支持状态过滤以及已过滤候选人的2天留存"""
    db = await get_db()
    try:
        if status_filter == 'all':
            query = """
                SELECT * FROM recommendations
                WHERE status != 'filtered' OR created_at >= datetime('now', '-2 days', 'localtime')
                ORDER BY created_at DESC LIMIT ?
            """
            params = (limit,)
        elif status_filter == 'sent':
            query = """
                SELECT * FROM recommendations
                WHERE status IN ('sent', 'followed_up', 'replied')
                ORDER BY created_at DESC LIMIT ?
            """
            params = (limit,)
        elif status_filter == 'pending':
            query = """
                SELECT * FROM recommendations
                WHERE status = 'pending'
                ORDER BY created_at DESC LIMIT ?
            """
            params = (limit,)
        elif status_filter == 'filtered':
            query = """
                SELECT * FROM recommendations
                WHERE status = 'filtered' AND created_at >= datetime('now', '-2 days', 'localtime')
                ORDER BY created_at DESC LIMIT ?
            """
            params = (limit,)
        else:
            query = """
                SELECT * FROM recommendations
                WHERE status != 'filtered' OR created_at >= datetime('now', '-2 days', 'localtime')
                ORDER BY created_at DESC LIMIT ?
            """
            params = (limit,)

        cursor = await db.execute(query, params)
        rows = await cursor.fetchall()
        return [dict(row) for row in rows]
    finally:
        await db.close()


async def get_greeting_stats() -> dict:
    """获取打招呼效果统计（漏斗数据）"""
    from datetime import date

    today = date.today().isoformat()
    db = await get_db()
    try:
        # 今日数据
        cursor = await db.execute(
            """SELECT
                COUNT(CASE WHEN status IN ('sent','followed_up','replied') THEN 1 END) as sent,
                COUNT(CASE WHEN status IN ('followed_up','replied') THEN 1 END) as followed_up,
                COUNT(CASE WHEN status = 'replied' THEN 1 END) as replied
               FROM recommendations WHERE DATE(sent_at) = ?""",
            (today,),
        )
        today_row = await cursor.fetchone()

        # 总数据
        cursor = await db.execute(
            """SELECT
                COUNT(CASE WHEN status IN ('sent','followed_up','replied') THEN 1 END) as total_sent,
                COUNT(CASE WHEN status IN ('followed_up','replied') THEN 1 END) as total_followed_up,
                COUNT(CASE WHEN status = 'replied' THEN 1 END) as total_replied
               FROM recommendations"""
        )
        total_row = await cursor.fetchone()

        # 今日扫描和匹配
        cursor = await db.execute(
            """SELECT SUM(candidates_scanned), SUM(candidates_matched) FROM daily_stats WHERE date = ?""",
            (today,),
        )
        today_scan_row = await cursor.fetchone()
        today_scanned = today_scan_row[0] if today_scan_row and today_scan_row[0] is not None else 0
        today_matched = today_scan_row[1] if today_scan_row and today_scan_row[1] is not None else 0

        # 总扫描和匹配
        cursor = await db.execute(
            """SELECT SUM(candidates_scanned), SUM(candidates_matched) FROM daily_stats"""
        )
        total_scan_row = await cursor.fetchone()
        total_scanned = total_scan_row[0] if total_scan_row and total_scan_row[0] is not None else 0
        total_matched = total_scan_row[1] if total_scan_row and total_scan_row[1] is not None else 0

        return {
            "today": {
                "sent": today_row[0] if today_row else 0,
                "followed_up": today_row[1] if today_row else 0,
                "replied": today_row[2] if today_row else 0,
                "scanned": today_scanned,
                "matched": today_matched,
            },
            "total": {
                "sent": total_row[0] if total_row else 0,
                "followed_up": total_row[1] if total_row else 0,
                "replied": total_row[2] if total_row else 0,
                "scanned": total_scanned,
                "matched": total_matched,
            },
        }
    finally:
        await db.close()


async def check_candidate_greeted(candidate_name: str, candidate_title: str) -> bool:
    """检查是否已经对该候选人打过招呼（去重）"""
    db = await get_db()
    try:
        cursor = await db.execute(
            """SELECT COUNT(*) FROM recommendations
               WHERE candidate_name = ? AND candidate_title = ?
               AND status IN ('sent', 'followed_up', 'replied', 'approved')""",
            (candidate_name, candidate_title),
        )
        row = await cursor.fetchone()
        return row[0] > 0 if row else False
    finally:
        await db.close()


async def save_or_update_job_post(job_data: dict) -> dict:
    """保存或更新岗位配置，并设为活跃，其它岗位设为非活跃"""
    title = job_data.get("title", "").strip()
    if not title:
        raise ValueError("Job title cannot be empty")
        
    company = job_data.get("company", "").strip()
    description = job_data.get("description", "").strip()
    salary_range = job_data.get("salary_range", "").strip()
    requirements = job_data.get("requirements", "").strip()
    highlights = job_data.get("highlights", "").strip()
    
    db = await get_db()
    try:
        # Check if job with this title already exists
        cursor = await db.execute("SELECT id FROM job_posts WHERE title = ?", (title,))
        row = await cursor.fetchone()
        
        if row:
            job_id = row["id"]
            # Update existing job and make it active
            await db.execute("UPDATE job_posts SET is_active = 0")
            await db.execute(
                """UPDATE job_posts 
                   SET company = ?, description = ?, salary_range = ?, requirements = ?, highlights = ?, is_active = 1, updated_at = CURRENT_TIMESTAMP
                   WHERE id = ?""",
                (company, description, salary_range, requirements, highlights, job_id)
            )
        else:
            # Insert new job and make it active
            await db.execute("UPDATE job_posts SET is_active = 0")
            cursor = await db.execute(
                """INSERT INTO job_posts (title, company, description, salary_range, requirements, highlights, is_active)
                   VALUES (?, ?, ?, ?, ?, ?, 1)""",
                (title, company, description, salary_range, requirements, highlights)
            )
            job_id = cursor.lastrowid
            
        await db.commit()
        
        cursor = await db.execute("SELECT * FROM job_posts WHERE id = ?", (job_id,))
        row = await cursor.fetchone()
        return dict(row)
    finally:
        await db.close()


async def sync_active_job_post_by_title(job_title: str) -> dict:
    """
    根据推荐页面的职位名称来识别并激活数据库中的岗位。
    例如推荐页显示 "测试开发 _ 华为 _ 深圳 20-40K"，我们尝试匹配数据库中的 "测试开发"。
    """
    import re
    # 清理和解析标题，例如把空格、下划线、代招、匿名等词去掉
    clean_title = job_title.replace("代招", "").replace("匿名", "").strip()
    # 提取核心职位名，例如 "测试开发 _ 华为" -> "测试开发"
    parts = [p.strip() for p in re.split(r'[_|｜\-]', clean_title) if p.strip()]
    core_title = parts[0] if parts else clean_title
    
    db = await get_db()
    try:
        # 1. 精确匹配标题
        cursor = await db.execute("SELECT * FROM job_posts WHERE title = ?", (core_title,))
        row = await cursor.fetchone()
        
        # 2. 如果没匹配到，尝试模糊匹配（如 title 包含在 core_title 中，或者 core_title 包含在 title 中）
        if not row:
            cursor = await db.execute("SELECT * FROM job_posts")
            all_rows = await cursor.fetchall()
            for r in all_rows:
                db_title = r["title"]
                if db_title in core_title or core_title in db_title:
                    row = r
                    break
        
        if row:
            job_id = row["id"]
            # 将该岗位设为活跃，其它岗位设为非活跃
            await db.execute("UPDATE job_posts SET is_active = 0")
            await db.execute("UPDATE job_posts SET is_active = 1, updated_at = CURRENT_TIMESTAMP WHERE id = ?", (job_id,))
            await db.commit()
        else:
            # 3. 如果依然未找到，说明可能是一个全新的职位，直接自动创建并激活它
            company = parts[1] if len(parts) > 1 else ""
            salary_range = parts[2] if len(parts) > 2 else ""
            await db.execute("UPDATE job_posts SET is_active = 0")
            cursor = await db.execute(
                """INSERT INTO job_posts (title, company, description, salary_range, requirements, highlights, is_active)
                   VALUES (?, ?, ?, '自动创建的岗位，建议去职位管理页面同步完整 JD', '自动提取的要求', '自动提取的亮点', 1)""",
                (core_title, company, salary_range)
            )
            job_id = cursor.lastrowid
            await db.commit()
            
        cursor = await db.execute("SELECT * FROM job_posts WHERE id = ?", (job_id,))
        row = await cursor.fetchone()
        return dict(row)
    finally:
        await db.close()



