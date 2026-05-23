/**
 * popup.js — 控制面板逻辑
 */

document.addEventListener('DOMContentLoaded', () => {
  const toggleEnabled = document.getElementById('toggleEnabled');
  const statusText = document.getElementById('statusText');
  const connectionDot = document.getElementById('connectionDot');
  const statReceived = document.getElementById('statReceived');
  const statReplied = document.getElementById('statReplied');
  const statResumes = document.getElementById('statResumes');
  const statErrors = document.getElementById('statErrors');
  const runtime = document.getElementById('runtime');
  const currentChat = document.getElementById('currentChat');
  const btnReconnect = document.getElementById('btnReconnect');
  const btnOpenDashboard = document.getElementById('btnOpenDashboard');
  const btnStartScan = document.getElementById('btnStartScan');
  const greetQuota = document.getElementById('greetQuota');
  const greetStatus = document.getElementById('greetStatus');

  // ---- 初始化 ----
  init();

  async function init() {
    // 动态设置版本号
    const versionText = document.getElementById('versionText');
    if (versionText) {
      versionText.textContent = `v${chrome.runtime.getManifest().version}`;
    }

    // 读取开关状态
    const stored = await chrome.storage.local.get(['copilotEnabled']);
    toggleEnabled.checked = stored.copilotEnabled || false;
    updateStatusText(toggleEnabled.checked);

    // 查询后端连接状态
    checkConnection();

    // 查询 content script 状态
    refreshStats();

    // 刷新打招呼配额
    refreshGreetingQuota();

    // 定时刷新
    setInterval(() => {
      checkConnection();
      refreshStats();
      refreshGreetingQuota();
    }, 3000);
  }

  // ---- 开关 ----
  toggleEnabled.addEventListener('change', async () => {
    const enabled = toggleEnabled.checked;
    await chrome.storage.local.set({ copilotEnabled: enabled });
    updateStatusText(enabled);

    // 通知当前活动的 Boss 直聘标签页
    const tabs = await chrome.tabs.query({ url: 'https://www.zhipin.com/*', active: true });
    for (const tab of tabs) {
      try {
        await chrome.tabs.sendMessage(tab.id, { type: 'TOGGLE_ENABLED', enabled });
      } catch (e) {
        // tab 可能没有 content script
      }
    }

    // 如果没有活跃的标签页，也通知所有 Boss 标签
    if (tabs.length === 0) {
      const allTabs = await chrome.tabs.query({ url: 'https://www.zhipin.com/*' });
      for (const tab of allTabs) {
        try {
          await chrome.tabs.sendMessage(tab.id, { type: 'TOGGLE_ENABLED', enabled });
        } catch (e) {}
      }
    }
  });

  function updateStatusText(enabled) {
    if (enabled) {
      statusText.textContent = '✅ 正在自动监听并回复消息';
      statusText.style.color = '#00cec9';
    } else {
      statusText.textContent = '已暂停，点击开关启用';
      statusText.style.color = '#8888a8';
    }
  }

  // ---- 后端连接状态 ----
  async function checkConnection() {
    try {
      const response = await chrome.runtime.sendMessage({ type: 'GET_CONNECTION_STATUS' });
      if (response?.connected) {
        connectionDot.className = 'connection-dot online';
        connectionDot.title = '后端已连接';
      } else {
        connectionDot.className = 'connection-dot offline';
        connectionDot.title = `后端未连接 (重试 ${response?.reconnectAttempts || 0} 次)`;
      }
    } catch {
      connectionDot.className = 'connection-dot offline';
      connectionDot.title = '无法获取状态';
    }
  }

  // ---- 刷新统计数据 ----
  async function refreshStats() {
    const tabs = await chrome.tabs.query({ url: 'https://www.zhipin.com/*' });
    for (const tab of tabs) {
      try {
        const response = await chrome.tabs.sendMessage(tab.id, { type: 'GET_STATUS' });
        if (response?.ok) {
          const s = response.stats;
          statReceived.textContent = s.messagesReceived || 0;
          statReplied.textContent = s.repliesSent || 0;
          statErrors.textContent = s.errors || 0;

          // 运行时长
          if (s.startTime) {
            const elapsed = Date.now() - s.startTime;
            runtime.textContent = formatDuration(elapsed);
          }

          // 当前聊天
          currentChat.textContent = response.currentChatId
            ? response.currentChatId.substring(0, 15) + '...'
            : '无';

          break; // 只取第一个标签页的数据
        }
      } catch (e) {}
    }
  }

  // ---- 刷新打招呼配额 ----
  async function refreshGreetingQuota() {
    // 从推荐牛人页面获取
    const tabs = await chrome.tabs.query({ url: 'https://www.zhipin.com/web/chat/recommend*' });
    for (const tab of tabs) {
      try {
        const response = await chrome.tabs.sendMessage(tab.id, { type: 'GET_GREETING_STATUS' });
        if (response?.ok) {
          const q = response.quota || {};
          greetQuota.textContent = `${q.used || 0}/${q.limit || 20}`;

          // 更新状态文本
          if (response.phase === 'scanning') {
            greetStatus.textContent = '🔍 正在扫描候选人...';
            greetStatus.style.color = '#feca57';
          } else if (response.phase === 'evaluating') {
            greetStatus.textContent = '🤖 AI 评估中...';
            greetStatus.style.color = '#a29bfe';
          } else if (response.phase === 'reviewing') {
            greetStatus.textContent = '📋 请在推荐牛人页面审核';
            greetStatus.style.color = '#00cec9';
          } else if (response.phase === 'greeting') {
            greetStatus.textContent = `👋 打招呼中 (${response.stats?.greeted || 0}/${response.stats?.approved || 0})`;
            greetStatus.style.color = '#6c5ce7';
          } else if (response.phase === 'done') {
            greetStatus.textContent = `✅ 今日已完成 ${q.used || 0} 个`;
            greetStatus.style.color = '#00cec9';
          } else {
            greetStatus.textContent = '就绪 — 点击下方按钮开始';
            greetStatus.style.color = '#8888a8';
          }
          return;
        }
      } catch (e) {}
    }

    // 没有打开推荐牛人页面
    greetStatus.textContent = '请先打开推荐牛人页面';
    greetStatus.style.color = '#8888a8';
  }

  function formatDuration(ms) {
    const s = Math.floor(ms / 1000) % 60;
    const m = Math.floor(ms / 60000) % 60;
    const h = Math.floor(ms / 3600000);
    return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
  }

  // ---- 按钮事件 ----
  btnReconnect.addEventListener('click', async () => {
    btnReconnect.disabled = true;
    btnReconnect.textContent = '⏳ 连接中...';
    try {
      await chrome.runtime.sendMessage({ type: 'FORCE_RECONNECT' });
      setTimeout(() => {
        btnReconnect.disabled = false;
        btnReconnect.textContent = '🔄 重连后端';
        checkConnection();
      }, 2000);
    } catch {
      btnReconnect.disabled = false;
      btnReconnect.textContent = '🔄 重连后端';
    }
  });

  btnOpenDashboard.addEventListener('click', () => {
    chrome.tabs.create({ url: 'http://127.0.0.1:8765/dashboard' });
  });

  // ---- 扫描推荐牛人 ----
  btnStartScan.addEventListener('click', async () => {
    // 检查是否有推荐牛人页面打开
    const tabs = await chrome.tabs.query({ url: 'https://www.zhipin.com/web/chat/recommend*' });

    if (tabs.length === 0) {
      // 没有打开，自动打开
      chrome.tabs.create({ url: 'https://www.zhipin.com/web/chat/recommend' });
      greetStatus.textContent = '🚀 正在打开推荐牛人页面...';
      greetStatus.style.color = '#feca57';
      return;
    }

    // 已打开，通知 content script 开始扫描
    const tab = tabs[0];
    chrome.tabs.update(tab.id, { active: true }); // 切到该标签页
    try {
      await chrome.tabs.sendMessage(tab.id, { type: 'START_GREETING_SCAN' });
      greetStatus.textContent = '🔍 扫描已启动，请切到推荐牛人页面';
      greetStatus.style.color = '#feca57';
    } catch (e) {
      greetStatus.textContent = '⚠️ 无法连接页面，请刷新后重试';
      greetStatus.style.color = '#ff6b6b';
    }
  });
});

