"""
LLM 调用引擎 — 封装 DeepSeek / OpenAI 兼容接口
"""

import logging
from openai import AsyncOpenAI

from config import settings

logger = logging.getLogger(__name__)


class LLMEngine:
    """LLM 调用引擎，支持 DeepSeek 和 OpenAI 兼容 API"""

    def __init__(self):
        self.client = AsyncOpenAI(
            api_key=settings.LLM_API_KEY,
            base_url=settings.LLM_BASE_URL,
        )
        self.model = settings.LLM_MODEL
        self.max_tokens = settings.LLM_MAX_TOKENS
        self.temperature = settings.LLM_TEMPERATURE
        logger.info(
            f"LLM 引擎初始化: provider={settings.LLM_PROVIDER}, model={self.model}"
        )

    async def generate_reply(self, messages: list[dict]) -> dict:
        """
        调用 LLM 生成回复

        Args:
            messages: OpenAI 格式的 messages 列表

        Returns:
            {
                "reply": str,          # 生成的回复文本
                "action": str,         # "REPLY" | "SKIP" | "HUMAN_NEEDED"
                "tokens_used": int,    # Token 使用量
            }
        """
        try:
            response = await self.client.chat.completions.create(
                model=self.model,
                messages=messages,
                max_tokens=self.max_tokens,
                temperature=self.temperature,
            )

            reply_text = response.choices[0].message.content.strip()
            tokens_used = response.usage.total_tokens if response.usage else 0

            # 检查是否需要人工介入
            if "[HUMAN_NEEDED]" in reply_text:
                reply_text = reply_text.replace("[HUMAN_NEEDED]", "").strip()
                action = "HUMAN_NEEDED"
            else:
                action = "REPLY"

            logger.info(
                f"LLM 生成回复: action={action}, tokens={tokens_used}, "
                f"reply={reply_text[:50]}..."
            )

            return {
                "reply": reply_text,
                "action": action,
                "tokens_used": tokens_used,
            }

        except Exception as e:
            logger.error(f"LLM 调用失败: {e}")
            return {
                "reply": None,
                "action": "SKIP",
                "tokens_used": 0,
                "error": str(e),
            }


# 全局实例
llm_engine = LLMEngine()
