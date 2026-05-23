-- Boss直聘猎头 Copilot 数据库 Schema

-- 岗位配置表
CREATE TABLE IF NOT EXISTS job_posts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    title TEXT NOT NULL,
    company TEXT,
    description TEXT,            -- 岗位 JD
    salary_range TEXT,           -- 薪资范围
    requirements TEXT,           -- 任职要求
    highlights TEXT,             -- 岗位亮点（用于对话中吸引候选人）
    is_active INTEGER DEFAULT 1, -- 是否活跃
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- 候选人表
CREATE TABLE IF NOT EXISTS candidates (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    boss_chat_id TEXT UNIQUE,     -- Boss直聘聊天 ID
    name TEXT,
    current_title TEXT,           -- 当前职位
    experience_years INTEGER,     -- 工作年限
    status TEXT DEFAULT 'new',    -- new / chatting / resume_received / rejected / recommended
    job_post_id INTEGER,          -- 关联岗位
    notes TEXT,                   -- 备注
    resume_path TEXT,             -- 简历文件路径
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (job_post_id) REFERENCES job_posts(id)
);

-- 消息历史表
CREATE TABLE IF NOT EXISTS messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    candidate_id INTEGER NOT NULL,
    role TEXT NOT NULL,           -- 'candidate' 或 'copilot'
    content TEXT NOT NULL,
    is_auto INTEGER DEFAULT 1,   -- 是否自动生成
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (candidate_id) REFERENCES candidates(id)
);

-- 每日统计表
CREATE TABLE IF NOT EXISTS daily_stats (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    date TEXT NOT NULL UNIQUE,
    messages_received INTEGER DEFAULT 0,
    replies_sent INTEGER DEFAULT 0,
    resumes_collected INTEGER DEFAULT 0,
    errors INTEGER DEFAULT 0,
    greetings_sent INTEGER DEFAULT 0,
    greetings_followed_up INTEGER DEFAULT 0,
    greetings_replied INTEGER DEFAULT 0
);

-- 智能推荐与打招呼记录表
CREATE TABLE IF NOT EXISTS recommendations (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    candidate_id INTEGER,            -- 关联 candidates(id)
    candidate_name TEXT,
    candidate_title TEXT,            -- 当前职位
    candidate_company TEXT,          -- 最近公司
    candidate_experience TEXT,       -- 工作年限，如 "5年"
    candidate_education TEXT,        -- 学历，如 "硕士"
    candidate_salary TEXT,           -- 期望薪资，如 "25-35K"
    candidate_tags TEXT,             -- 技术标签 JSON: ["FastAPI","Python"]
    candidate_job_status TEXT,       -- 求职状态: "离职-随时到岗"
    candidate_advantage TEXT,        -- 优势描述
    candidate_work_history TEXT,     -- 工作经历摘要
    match_score REAL,                -- LLM 匹配评分 (1-10)
    match_reason TEXT,               -- 匹配理由
    greeting_text TEXT,              -- 预设招呼语（记录发了什么）
    followup_text TEXT,              -- 跟进消息内容
    status TEXT DEFAULT 'pending',   -- filtered / pending / approved / sent / followed_up / replied / ignored
    job_post_id INTEGER,
    sent_at TIMESTAMP,
    followup_at TIMESTAMP,
    replied_at TIMESTAMP,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (candidate_id) REFERENCES candidates(id),
    FOREIGN KEY (job_post_id) REFERENCES job_posts(id)
);

-- 索引
CREATE INDEX IF NOT EXISTS idx_candidates_chat_id ON candidates(boss_chat_id);
CREATE INDEX IF NOT EXISTS idx_candidates_status ON candidates(status);
CREATE INDEX IF NOT EXISTS idx_messages_candidate ON messages(candidate_id);
CREATE INDEX IF NOT EXISTS idx_daily_stats_date ON daily_stats(date);
CREATE INDEX IF NOT EXISTS idx_recommendations_status ON recommendations(status);
CREATE INDEX IF NOT EXISTS idx_recommendations_sent_at ON recommendations(sent_at);
