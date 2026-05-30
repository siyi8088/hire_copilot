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

  // 校准模块配置
  const CAL_MODULES = {
    jobSyncer: {
      dot: document.getElementById('calDotJobSyncer'),
      status: document.getElementById('calStatusJobSyncer'),
      btn: document.getElementById('calBtnJobSyncer'),
      urlPattern: 'https://www.zhipin.com/web/chat/job/list*',
      pageUrl: 'https://www.zhipin.com/web/chat/job/list',
      label: '职位同步',
    },
    recommendGreeter: {
      dot: document.getElementById('calDotRecommend'),
      status: document.getElementById('calStatusRecommend'),
      btn: document.getElementById('calBtnRecommend'),
      urlPattern: 'https://www.zhipin.com/web/chat/recommend*',
      pageUrl: 'https://www.zhipin.com/web/chat/recommend',
      label: '推荐牛人',
    },
    chatObserver: {
      dot: document.getElementById('calDotChatObserver'),
      status: document.getElementById('calStatusChatObserver'),
      btn: document.getElementById('calBtnChatObserver'),
      urlPattern: 'https://www.zhipin.com/web/chat/index*',
      pageUrl: 'https://www.zhipin.com/web/chat/index',
      label: '聊天列表',
    },
    chatConversation: {
      dot: document.getElementById('calDotChatConversation'),
      status: document.getElementById('calStatusChatConversation'),
      btn: document.getElementById('calBtnChatConversation'),
      urlPattern: 'https://www.zhipin.com/web/chat/index*',
      pageUrl: 'https://www.zhipin.com/web/chat/index',
      label: '聊天对话',
    },
  };

  // ---- 初始化 ----
  init();

  async function init() {
    const versionText = document.getElementById('versionText');
    if (versionText) {
      versionText.textContent = `v${chrome.runtime.getManifest().version}`;
    }

    const stored = await chrome.storage.local.get(['copilotEnabled']);
    toggleEnabled.checked = stored.copilotEnabled || false;
    updateStatusText(toggleEnabled.checked);

    checkConnection();
    refreshStats();
    refreshCalibrationStatus();

    // 绑定每个模块的校准按钮
    for (const [modName, mod] of Object.entries(CAL_MODULES)) {
      if (mod.btn) {
        mod.btn.addEventListener('click', () => handleCalibrate(modName));
      }
    }

    setInterval(() => {
      checkConnection();
      refreshStats();
      refreshCalibrationStatus();
    }, 5000);
  }

  // ---- 开关 ----
  toggleEnabled.addEventListener('change', async () => {
    const enabled = toggleEnabled.checked;
    await chrome.storage.local.set({ copilotEnabled: enabled });
    updateStatusText(enabled);

    const tabs = await chrome.tabs.query({ url: 'https://www.zhipin.com/*', active: true });
    for (const tab of tabs) {
      try {
        await chrome.tabs.sendMessage(tab.id, { type: 'TOGGLE_ENABLED', enabled });
      } catch (e) {}
    }

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
    // 1. 优先从后台获取真实的数据库统计数据
    let backendStatsLoaded = false;
    try {
      const response = await new Promise((resolve, reject) => {
        chrome.runtime.sendMessage({ type: 'GET_DAILY_STATS' }, (res) => {
          if (chrome.runtime.lastError) reject(chrome.runtime.lastError);
          else resolve(res);
        });
      });
      if (response?.ok && response.stats) {
        const s = response.stats;
        statReceived.textContent = s.messages_received ?? 0;
        statReplied.textContent = s.replies_sent ?? 0;
        statResumes.textContent = s.resumes_collected ?? 0;
        statErrors.textContent = s.errors ?? 0;
        backendStatsLoaded = true;
      }
    } catch (e) {
      console.warn("无法从后端获取统计数据，将降级使用页面本地统计:", e);
    }

    // 2. 从活跃的 Boss 标签页获取运行时长和当前聊天（非持久化状态）
    const tabs = await chrome.tabs.query({ url: 'https://www.zhipin.com/*' });
    for (const tab of tabs) {
      try {
        const response = await chrome.tabs.sendMessage(tab.id, { type: 'GET_STATUS' });
        if (response?.ok) {
          const s = response.stats;
          
          // 如果后端统计加载失败，降级使用页面内存统计
          if (!backendStatsLoaded && s) {
            statReceived.textContent = s.messagesReceived || 0;
            statReplied.textContent = s.repliesSent || 0;
            statErrors.textContent = s.errors || 0;
            statResumes.textContent = 0; // 页面本地无此统计
          }

          if (s?.startTime) {
            const elapsed = Date.now() - s.startTime;
            runtime.textContent = formatDuration(elapsed);
          }

          currentChat.textContent = response.currentChatId
            ? response.currentChatId.substring(0, 15) + '...'
            : '无';

          break;
        }
      } catch (e) {}
    }
  }

  // ---- 刷新校准状态 ----
  async function refreshCalibrationStatus() {
    const CACHE_TTL = 24 * 60 * 60 * 1000;

    for (const [modName, mod] of Object.entries(CAL_MODULES)) {
      if (!mod.dot || !mod.status || !mod.btn) continue;

      // 检查是否有对应页面的标签页打开
      const tabs = await chrome.tabs.query({ url: mod.urlPattern });
      const hasTab = tabs.length > 0;

      // 读取缓存
      const cacheKey = `preflight_cache_${modName}`;
      const stored = await chrome.storage.local.get([cacheKey]);
      const cache = stored[cacheKey];

      if (!cache) {
        mod.dot.textContent = '⏳';
        mod.status.textContent = '未检测';
        mod.status.className = 'cal-status';
      } else if (Date.now() - cache._timestamp > CACHE_TTL) {
        mod.dot.textContent = '⚠️';
        mod.status.textContent = '已过期';
        mod.status.className = 'cal-status failed';
      } else {
        const results = cache.results || {};
        const failedCritical = Object.entries(results).some(
          ([, r]) => r.critical && !r.passed
        );

        if (failedCritical) {
          mod.dot.textContent = '🔴';
          mod.status.textContent = '校准失败';
          mod.status.className = 'cal-status failed';
        } else {
          const passedCount = Object.values(results).filter(r => r.passed).length;
          const totalCount = Object.keys(results).length;
          mod.dot.textContent = '🟢';
          mod.status.textContent = `${passedCount}/${totalCount} 通过`;
          mod.status.className = 'cal-status passed';
        }
      }

      // 更新按钮状态
      if (hasTab) {
        mod.btn.textContent = '校准';
        mod.btn.className = 'cal-btn';
        mod.btn.title = `在当前打开的${mod.label}页面上执行校准`;
      } else {
        mod.btn.textContent = '前往';
        mod.btn.className = 'cal-btn btn-go';
        mod.btn.title = `打开${mod.label}页面`;
      }
    }
  }

  // ---- 单模块校准 ----
  async function handleCalibrate(modName) {
    const mod = CAL_MODULES[modName];
    if (!mod) return;

    const tabs = await chrome.tabs.query({ url: mod.urlPattern });

    if (tabs.length === 0) {
      // 没有对应页面，打开它
      chrome.tabs.create({ url: mod.pageUrl });
      mod.status.textContent = '正在打开...';
      mod.status.className = 'cal-status';
      return;
    }

    // 有对应页面，触发校准
    const tab = tabs[0];
    mod.btn.disabled = true;
    mod.btn.textContent = '⏳';
    mod.dot.textContent = '🔄';
    mod.status.textContent = '校准中...';
    mod.status.className = 'cal-status';

    // 清除该模块的缓存
    const cacheKey = `preflight_cache_${modName}`;
    await chrome.storage.local.remove([cacheKey]);

    try {
      await chrome.tabs.sendMessage(tab.id, {
        type: 'FORCE_RECALIBRATE',
        moduleName: modName,
        forceReport: true, // 手动点击校准时，强制生成并上报诊断文档
      });
    } catch (e) {
      mod.status.textContent = '⚠️ 页面无响应';
      mod.status.className = 'cal-status failed';
    }

    // 延迟刷新状态
    setTimeout(() => {
      mod.btn.disabled = false;
      refreshCalibrationStatus();
    }, 3000);
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
});
