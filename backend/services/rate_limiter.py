"""
频率控制器 — 令牌桶算法 + 工作时间窗口
"""

import time
import logging
from datetime import datetime

from config import settings

logger = logging.getLogger(__name__)

# Boss 直聘平台的每日打招呼硬限制
MAX_GREETINGS_PER_DAY = 20


class RateLimiter:
    """令牌桶频率限制器"""

    def __init__(self):
        # 回复频率控制
        self.reply_tokens = settings.MAX_REPLIES_PER_HOUR
        self.reply_max = settings.MAX_REPLIES_PER_HOUR
        self.reply_last_refill = time.time()

        # 主动打招呼频率控制（小时级令牌桶）
        self.greeting_tokens = settings.MAX_GREETINGS_PER_HOUR
        self.greeting_max = settings.MAX_GREETINGS_PER_HOUR
        self.greeting_last_refill = time.time()

        # 主动打招呼每日硬限制
        self.greeting_daily_count = 0
        self.greeting_daily_date = datetime.now().date()

        # 每日消息总量
        self.daily_count = 0
        self.daily_date = datetime.now().date()

    def _refill_tokens(self, current_tokens: int, max_tokens: int, last_refill: float) -> tuple[int, float]:
        """每小时补充令牌"""
        now = time.time()
        elapsed_hours = (now - last_refill) / 3600
        if elapsed_hours >= 1:
            refilled = min(max_tokens, current_tokens + max_tokens)
            return refilled, now
        return current_tokens, last_refill

    def _reset_daily_if_needed(self):
        """日期变更时重置每日计数"""
        today = datetime.now().date()
        if today != self.daily_date:
            self.daily_count = 0
            self.daily_date = today
        if today != self.greeting_daily_date:
            self.greeting_daily_count = 0
            self.greeting_daily_date = today

    def is_within_work_hours(self) -> bool:
        """检查是否在工作时间"""
        hour = datetime.now().hour
        return settings.WORK_HOUR_START <= hour < settings.WORK_HOUR_END

    def can_reply(self) -> tuple[bool, str]:
        """
        检查是否可以回复消息

        Returns:
            (是否允许, 原因)
        """
        # 工作时间检查
        if not self.is_within_work_hours():
            return False, f"非工作时间（{settings.WORK_HOUR_START}:00-{settings.WORK_HOUR_END}:00）"

        # 每日上限检查
        self._reset_daily_if_needed()
        if self.daily_count >= settings.MAX_DAILY_MESSAGES:
            return False, f"已达每日消息上限 ({settings.MAX_DAILY_MESSAGES})"

        # 令牌桶检查
        self.reply_tokens, self.reply_last_refill = self._refill_tokens(
            self.reply_tokens, self.reply_max, self.reply_last_refill
        )
        if self.reply_tokens <= 0:
            return False, f"每小时回复已达上限 ({self.reply_max})"

        return True, "OK"

    def consume_reply(self):
        """消耗一个回复令牌"""
        self.reply_tokens -= 1
        self.daily_count += 1
        logger.info(
            f"[RateLimiter] 消耗回复令牌: 剩余 {self.reply_tokens}/{self.reply_max}, "
            f"今日 {self.daily_count}/{settings.MAX_DAILY_MESSAGES}"
        )

    def can_greet(self) -> tuple[bool, str]:
        """
        检查是否可以主动打招呼

        Returns:
            (是否允许, 原因)
        """
        if not self.is_within_work_hours():
            return False, "非工作时间"

        self._reset_daily_if_needed()

        # 每日 20 次硬限制（Boss 平台限制）
        if self.greeting_daily_count >= MAX_GREETINGS_PER_DAY:
            return False, f"已达每日打招呼上限({MAX_GREETINGS_PER_DAY}次)，明天再继续"

        # 每日消息总量检查
        if self.daily_count >= settings.MAX_DAILY_MESSAGES:
            return False, "已达每日消息上限"

        # 小时级令牌桶检查
        self.greeting_tokens, self.greeting_last_refill = self._refill_tokens(
            self.greeting_tokens, self.greeting_max, self.greeting_last_refill
        )
        if self.greeting_tokens <= 0:
            return False, f"每小时打招呼已达上限 ({self.greeting_max})"

        return True, "OK"

    def consume_greeting(self):
        """消耗一个打招呼令牌"""
        self.greeting_tokens -= 1
        self.greeting_daily_count += 1
        self.daily_count += 1
        logger.info(
            f"[RateLimiter] 打招呼: 今日 {self.greeting_daily_count}/{MAX_GREETINGS_PER_DAY}, "
            f"小时剩余 {self.greeting_tokens}/{self.greeting_max}"
        )

    def get_greeting_quota(self) -> dict:
        """获取打招呼配额信息"""
        self._reset_daily_if_needed()
        return {
            "used": self.greeting_daily_count,
            "limit": MAX_GREETINGS_PER_DAY,
            "remaining": max(0, MAX_GREETINGS_PER_DAY - self.greeting_daily_count),
        }

    def get_status(self) -> dict:
        """获取当前限流状态"""
        return {
            "reply_tokens_remaining": self.reply_tokens,
            "greeting_tokens_remaining": self.greeting_tokens,
            "greeting_daily": self.get_greeting_quota(),
            "daily_count": self.daily_count,
            "daily_max": settings.MAX_DAILY_MESSAGES,
            "is_work_hours": self.is_within_work_hours(),
        }


# 全局实例
rate_limiter = RateLimiter()

