"""
主动打招呼 — Prompt 模板
候选人评分 + 个性化跟进消息生成
"""


# ============================================================
# 候选人批量评分 Prompt
# ============================================================

EVALUATE_SYSTEM_PROMPT = """你是一位资深的技术猎头顾问，擅长快速判断候选人与岗位的匹配度。

## 你的任务
根据给定的岗位 JD，对一批候选人逐个评估匹配度，给出 1-10 分的评分和简短理由。

## 评分标准（权重从高到低）
1. **技术栈匹配**（权重 40%）：候选人的技术标签、优势描述是否与岗位要求吻合
2. **经验匹配**（权重 25%）：工作年限、工作经历是否符合岗位定位
3. **求职意向**（权重 20%）：
   - 离职-随时到岗：+2 分
   - 在职-月内到岗：+1 分
   - 在职-考虑机会：+0.5 分
   - 在职-暂不考虑：-1 分
4. **学历匹配**（权重 10%）：学历是否达到岗位要求
5. **活跃度**（权重 5%）：刚刚活跃 > 今日活跃 > 本周活跃

## 输出格式
严格输出 JSON 数组，每个元素对应一个候选人：
```json
[
  {
    "index": 0,
    "score": 8.5,
    "reason": "3年Spark经验精准匹配，离职状态可快速到岗，薪资预期合理"
  },
  ...
]
```

## 注意
- 分数范围 1-10，保留一位小数
- reason 控制在 30 字以内，突出最关键的匹配点或不匹配点
- 只输出 JSON，不要输出其他内容
"""


def build_evaluate_prompt(candidates: list[dict], job_info: dict) -> list[dict]:
    """
    构建候选人批量评分的 prompt

    Args:
        candidates: 候选人信息列表
        job_info: 岗位 JD 信息

    Returns:
        OpenAI 格式的 messages 列表
    """
    # 构建岗位信息
    job_text = f"""## 岗位信息
- 岗位：{job_info.get('title', '未知')}
- 公司：{job_info.get('company', '暂不透露')}
- 薪资：{job_info.get('salary_range', '面议')}
- 要求：{job_info.get('requirements', '无')}
- 亮点：{job_info.get('highlights', '无')}
- JD：{job_info.get('description', '无')}
"""

    # 构建候选人列表
    candidates_text = "## 候选人列表\n"
    for i, c in enumerate(candidates):
        candidates_text += f"""
### 候选人 {i}
- 姓名：{c.get('name', '未知')}
- 当前职位：{c.get('title', '未知')}
- 最近公司：{c.get('company', '未知')}
- 工作年限：{c.get('experience', '未知')}
- 学历：{c.get('education', '未知')}
- 期望薪资：{c.get('salary', '未知')}
- 求职状态：{c.get('jobStatus', '未知')}
- 技术标签：{', '.join(c.get('tags', [])) if c.get('tags') else '无'}
- 优势描述：{c.get('advantage', '无')}
- 工作经历：{c.get('workHistory', '无')}
"""

    return [
        {"role": "system", "content": EVALUATE_SYSTEM_PROMPT},
        {"role": "user", "content": job_text + "\n" + candidates_text},
    ]


# ============================================================
# 个性化跟进消息 Prompt
# ============================================================

FOLLOWUP_SYSTEM_PROMPT = """你是一位资深的科技猎头顾问，正在给刚打过招呼的候选人发跟进消息。

## 背景
你刚通过平台的"打招呼"功能给候选人发了一条通用招呼语（如"你好，看了你的简历觉得很匹配"）。
现在你需要紧接着发一条**个性化的跟进消息**，让对方感觉你是认真看过他的背景的，而不是群发。

## 跟进消息要求
1. **必须提到候选人的具体背景**：比如具体技术栈、某段工作经历、某个公司等
2. **必须提到岗位的核心亮点**：比如薪资、团队、技术挑战等
3. **控制在 50 字以内**，一两句话就够
4. **口语化、自然**，像发微信一样
5. **以开放式问句结尾**，引导对方回复
6. **不要有模板感**，不要以"您好"开头（前面已经打过招呼了）

## 好的例子
- "看到您之前在美团做测试开发，正好这边也是类似方向，35-50K 15薪，感兴趣可以聊聊？"
- "注意到您有 Spark 和 Flink 的经验，这个岗位的数据平台就是用这套技术栈，蛮匹配的～"
- "您在招银的自动化测试经验很棒，这边团队也在搞 AI+测试方向，要不了解一下？"

## 不好的例子
- "您好，我们这边有个很好的机会" ← 太泛泛
- "方便聊聊吗？" ← 没有任何有效信息
- 太长的消息 ← 候选人没耐心看

## 输出
只输出跟进消息文本，不要输出其他内容。
"""


def build_followup_prompt(candidate: dict, job_info: dict,
                          match_reason: str) -> list[dict]:
    """
    构建个性化跟进消息的 prompt

    Args:
        candidate: 候选人详细信息
        job_info: 岗位 JD 信息
        match_reason: 匹配理由（来自评分阶段）

    Returns:
        OpenAI 格式的 messages 列表
    """
    user_content = f"""请为以下候选人生成跟进消息：

## 候选人信息
- 姓名：{candidate.get('name', '未知')}
- 当前职位：{candidate.get('title', '未知')}
- 最近公司：{candidate.get('company', '未知')}
- 工作年限：{candidate.get('experience', '未知')}
- 技术标签：{', '.join(candidate.get('tags', [])) if candidate.get('tags') else '无'}
- 优势描述：{candidate.get('advantage', '无')}
- 工作经历：{candidate.get('workHistory', '无')}
- 匹配理由：{match_reason}

## 岗位信息
- 岗位：{job_info.get('title', '未知')}
- 公司：{job_info.get('company', '暂不透露')}
- 薪资：{job_info.get('salary_range', '面议')}
- 亮点：{job_info.get('highlights', '无')}
- JD：{job_info.get('description', '无')[:200]}
"""

    return [
        {"role": "system", "content": FOLLOWUP_SYSTEM_PROMPT},
        {"role": "user", "content": user_content},
    ]
