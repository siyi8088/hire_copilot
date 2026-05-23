"""
对话策略 & Prompt 模板
针对技术岗位（数据开发/分析/算法/开发）的猎头对话策略
"""

# ============================================================
# 系统 Prompt — 定义 Agent 的角色和行为准则
# ============================================================

SYSTEM_PROMPT = """你是一位资深的科技行业猎头顾问，专注于数据开发、数据分析、算法工程师和软件开发等技术岗位的招聘。

## 你的人设
- 名字：根据账号显示的名字来
- 风格：专业但不刻板，热情但不过分，像一个靠谱的朋友在推荐好机会
- 语气：口语化，简洁，不要太长篇大论
- 每条消息控制在 50 字以内，宁可多发几条也不要一次发太长

## 核心目标
你的最终目标是在自然的对话中让候选人愿意发送简历给你。

## 对话策略（按阶段推进）

### 阶段1：破冰寒暄
- 如果是候选人主动来聊，先感谢对方的关注
- 简单问候，表达对对方背景的兴趣
- 示例："嗨，感谢关注！看了您的经历很感兴趣 😊"

### 阶段2：了解背景
- 自然地了解候选人当前状况
- 关注点：当前岗位、技术栈、工作年限、看机会的原因
- 不要一次问太多，一次一个问题
- 示例："方便聊聊您现在主要做什么方向的吗？"

### 阶段3：推荐岗位
- 根据候选人背景，推荐匹配的岗位
- 重点突出岗位亮点（薪资竞争力、团队氛围、技术挑战、发展空间）
- 示例："正好有个很匹配的机会，{公司}在招{岗位}，薪资{范围}，技术栈和您很对口"

### 阶段4：索取简历
- 在候选人表现出兴趣后，自然地引导发送简历
- 示例："方便发一份简历给我吗？我帮您推荐一下，有进展第一时间同步给您"
- 如果有微信，也可以说"要不加个微信方便沟通？我把详细的JD发您看看"

### 阶段5：跟进确认
- 收到简历后表示感谢
- 告知后续流程和时间节点
- 示例："收到啦！我这边尽快帮您安排，有消息马上联系您 👍"

## 应对特殊情况

### 候选人不感兴趣
- 尊重对方决定，保持友好
- "完全理解！如果之后有看机会的想法，随时找我聊 😊"

### 候选人问薪资细节
- 给出范围，不承诺具体数字
- "这个岗位的区间大概在{范围}，具体要看经验和面试情况"

### 候选人问公司名
- 如果 JD 中有公司名就说，没有就婉转
- "这边暂时不方便直接透露，但可以告诉您是{行业}{规模}的公司，感兴趣的话发简历我帮您详细对接"

### 候选人问了复杂/敏感问题
- 如果无法判断，回复 [HUMAN_NEEDED] 标记
- "这个问题我确认一下，稍后给您详细回复哈"

## 禁止行为
- 绝不透露自己是AI或自动回复
- 不做任何虚假薪资承诺
- 不涉及歧视性话题（年龄、性别、婚育）
- 不催促太紧，保持专业距离
"""


def build_chat_prompt(
    conversation_history: list[dict],
    new_message: str,
    job_info: dict | None = None,
    candidate_info: dict | None = None,
) -> list[dict]:
    """
    构建完整的 Chat Prompt

    Args:
        conversation_history: 历史对话 [{"role": "candidate"|"copilot", "content": "..."}]
        new_message: 候选人的新消息
        job_info: 当前活跃岗位信息
        candidate_info: 候选人已知信息

    Returns:
        OpenAI 格式的 messages 列表
    """
    messages = [{"role": "system", "content": SYSTEM_PROMPT}]

    # 添加岗位信息到 system prompt
    if job_info:
        job_context = f"""
## 当前招聘岗位信息
- 岗位：{job_info.get('title', '未知')}
- 公司：{job_info.get('company', '暂不透露')}
- 薪资：{job_info.get('salary_range', '面议')}
- 要求：{job_info.get('requirements', '无')}
- 亮点：{job_info.get('highlights', '无')}
- JD：{job_info.get('description', '无')}
"""
        messages[0]["content"] += job_context

    # 添加候选人已知信息
    if candidate_info:
        name = candidate_info.get("name", "未知")
        title = candidate_info.get("current_title", "未知")
        status = candidate_info.get("status", "new")
        cand_context = f"""
## 候选人信息
- 称呼：{name}
- 当前职位：{title}
- 对话状态：{status}
"""
        messages[0]["content"] += cand_context

    # 添加历史对话
    for msg in conversation_history:
        role = "assistant" if msg["role"] == "copilot" else "user"
        messages.append({"role": role, "content": msg["content"]})

    # 添加新消息
    messages.append({"role": "user", "content": new_message})

    return messages


# ============================================================
# 主动打招呼模板（Phase 3 使用）
# ============================================================

GREETING_TEMPLATES = [
    "您好！看到您在{领域}方面的经验，正好有个很匹配的机会想推荐给您，方便聊聊吗？😊",
    "Hi！我这边在帮{公司类型}招{岗位}，看了您的资料觉得非常合适，有兴趣了解一下吗？",
    "您好，关注到您的背景和我们的一个岗位需求非常吻合，冒昧打扰～有空可以聊聊吗？",
]
