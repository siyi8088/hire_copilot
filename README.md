# 🤖 Boss直聘猎头 Copilot

智能招聘助手 — 自动与候选人互动，高效收集简历。

## 架构

```
Chrome Extension (Content Script)  ←— WebSocket —→  FastAPI 后端 → DeepSeek LLM
     ↕                                                    ↕
Boss直聘网页 (真实浏览器环境)                           SQLite + 微信通知
```

## 快速开始

### 1. 准备工作

- DeepSeek API Key: 在 [platform.deepseek.com](https://platform.deepseek.com) 注册获取
- Boss直聘猎头账号（正常登录 Chrome）
- Python 3.11+

### 2. 启动后端

```bash
cd backend

# 安装依赖
pip install -r requirements.txt

# 配置环境变量
cp .env.example .env
# 编辑 .env，填入你的 DeepSeek API Key

# 启动
python main.py
```

### 3. 加载 Chrome 扩展

1. 打开 Chrome，访问 `chrome://extensions/`
2. 开启右上角「开发者模式」
3. 点击「加载已解压的扩展程序」
4. 选择 `extension/` 目录

### 4. 配置岗位

后端启动后，通过 API 创建岗位：

```bash
curl -X POST http://127.0.0.1:8765/api/job \
  -H "Content-Type: application/json" \
  -d '{
    "title": "高级数据开发工程师",
    "company": "某知名互联网公司",
    "salary_range": "35-50K·15薪",
    "requirements": "3年以上数据开发经验，熟悉 Spark/Flink",
    "highlights": "技术氛围好，WLB，期权激励",
    "description": "负责数据仓库建设和实时数据处理..."
  }'
```

### 5. 开始使用

1. 在 Chrome 中正常登录 Boss直聘
2. 进入聊天页面 (`www.zhipin.com/web/geek/chat`)
3. 点击扩展图标，开启「自动回复」开关
4. Copilot 会自动监听新消息并智能回复

### 6. 管理面板

访问 `http://127.0.0.1:8765/dashboard` 查看运行状态。

## 安全机制

| 机制 | 说明 |
|---|---|
| 🕐 工作时间窗口 | 仅在 9:00-21:00 工作 |
| 🎲 高斯分布延迟 | 每次操作延迟随机且自然 |
| ⌨️ 逐字打字模拟 | 模拟真人打字节奏 |
| 🪣 令牌桶限流 | 每小时最多回复 20 条 |
| 📊 每日上限 | 每日最多 150 条消息 |
| ☕ 自动休息 | 连续工作 2 小时后休息 |

## 项目结构

```
hire_copilot/
├── extension/              # Chrome Extension (MV3)
│   ├── manifest.json
│   ├── content/            # Content Scripts
│   │   ├── boss-observer.js
│   │   ├── chat-interactor.js
│   │   └── human-simulator.js
│   ├── background/
│   │   └── service-worker.js
│   └── popup/
│       ├── popup.html
│       ├── popup.css
│       └── popup.js
│
└── backend/                # FastAPI 后端
    ├── main.py
    ├── config.py
    ├── llm/
    │   ├── engine.py
    │   └── prompts.py
    ├── services/
    │   ├── chat_handler.py
    │   └── rate_limiter.py
    └── db/
        ├── database.py
        └── schema.sql
```
