"""
配置管理 — 从 .env 文件或环境变量读取配置
"""

from pydantic_settings import BaseSettings
from typing import Optional


class Settings(BaseSettings):
    """应用配置"""

    # ---- 服务器 ----
    HOST: str = "127.0.0.1"
    PORT: int = 8765
    DEBUG: bool = False

    # ---- LLM ----
    LLM_PROVIDER: str = "mimo"  # mimo / deepseek / openai / ollama
    LLM_API_KEY: str = ""
    LLM_BASE_URL: str = "https://api.deepseek.com"
    LLM_MODEL: str = "deepseek-chat"
    LLM_MAX_TOKENS: int = 500
    LLM_TEMPERATURE: float = 0.7

    # ---- 安全策略 ----
    MAX_REPLIES_PER_HOUR: int = 20
    MAX_GREETINGS_PER_HOUR: int = 8
    WORK_HOUR_START: int = 9
    WORK_HOUR_END: int = 21
    MAX_DAILY_MESSAGES: int = 150

    # ---- 微信通知 ----
    WECHAT_WEBHOOK_URL: Optional[str] = None  # 企业微信群机器人 Webhook

    # ---- 钉钉通知 ----
    DINGTALK_WEBHOOK_URL: Optional[str] = None  # 钉钉群机器人 Webhook
    DINGTALK_SECRET: Optional[str] = None  # 钉钉群机器人安全密钥 (可选加签)

    # ---- 数据库 ----
    DB_PATH: str = "data/copilot.db"

    class Config:
        env_file = ".env"
        env_file_encoding = "utf-8"


settings = Settings()
