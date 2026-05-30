/**
 * service-worker.js
 * Chrome Extension Background Service Worker
 * 
 * 职责：
 * 1. 管理与本地 FastAPI 后端的 WebSocket 长连接
 * 2. 中转 Content Script ↔ Backend 消息
 * 3. 心跳保活 & 断线重连
 */

const LOG_PREFIX = '[HireCopilot:BG]';
const BACKEND_WS_URL = 'ws://127.0.0.1:8765/ws';

// ============================================================
// WebSocket 连接管理
// ============================================================

let ws = null;
let reconnectAttempts = 0;
const MAX_RECONNECT_ATTEMPTS = 50;
const HEARTBEAT_INTERVAL = 30000; // 30 秒
let heartbeatTimer = null;

// 等待后端响应的 pending 请求
const pendingRequests = new Map();
let requestIdCounter = 0;

/**
 * 建立 WebSocket 连接
 */
function connectWebSocket() {
  if (ws && ws.readyState === WebSocket.OPEN) return;

  console.log(`${LOG_PREFIX} 连接后端: ${BACKEND_WS_URL}`);

  try {
    ws = new WebSocket(BACKEND_WS_URL);
  } catch (err) {
    console.error(`${LOG_PREFIX} WebSocket 创建失败:`, err);
    scheduleReconnect();
    return;
  }

  ws.onopen = () => {
    console.log(`${LOG_PREFIX} ✅ 后端连接成功`);
    reconnectAttempts = 0;
    startHeartbeat();
  };

  ws.onmessage = (event) => {
    try {
      const data = JSON.parse(event.data);
      handleBackendMessage(data);
    } catch (err) {
      console.error(`${LOG_PREFIX} 解析后端消息失败:`, err);
    }
  };

  ws.onclose = (event) => {
    console.warn(`${LOG_PREFIX} WebSocket 断开 (code: ${event.code})`);
    stopHeartbeat();
    ws = null;
    scheduleReconnect();
  };

  ws.onerror = (err) => {
    console.error(`${LOG_PREFIX} WebSocket 错误:`, err);
  };
}

/**
 * 指数退避重连
 */
function scheduleReconnect() {
  if (reconnectAttempts >= MAX_RECONNECT_ATTEMPTS) {
    console.error(`${LOG_PREFIX} 达到最大重连次数，停止重连`);
    return;
  }

  const delay = Math.min(1000 * Math.pow(2, reconnectAttempts), 60000);
  reconnectAttempts++;
  console.log(`${LOG_PREFIX} ${delay / 1000}s 后重连 (第 ${reconnectAttempts} 次)`);
  setTimeout(connectWebSocket, delay);
}

/**
 * 心跳保活
 */
function startHeartbeat() {
  stopHeartbeat();
  heartbeatTimer = setInterval(() => {
    if (ws?.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: 'PING', timestamp: Date.now() }));
    }
  }, HEARTBEAT_INTERVAL);
}

function stopHeartbeat() {
  if (heartbeatTimer) {
    clearInterval(heartbeatTimer);
    heartbeatTimer = null;
  }
}

/**
 * 向后端发送消息并等待响应
 */
function sendToBackend(message) {
  return new Promise((resolve, reject) => {
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      reject(new Error('后端未连接'));
      return;
    }

    const requestId = ++requestIdCounter;
    message.requestId = requestId;

    // 设置超时
    const timeout = setTimeout(() => {
      pendingRequests.delete(requestId);
      reject(new Error('后端响应超时'));
    }, 180000);

    pendingRequests.set(requestId, { resolve, reject, timeout });

    ws.send(JSON.stringify(message));
  });
}

/**
 * 处理后端返回的消息
 */
function handleBackendMessage(data) {
  // PONG 心跳响应
  if (data.type === 'PONG') return;

  // 匹配 pending 请求
  if (data.requestId && pendingRequests.has(data.requestId)) {
    const { resolve, timeout } = pendingRequests.get(data.requestId);
    clearTimeout(timeout);
    pendingRequests.delete(data.requestId);
    resolve(data);
    return;
  }

  // 后端主动推送的消息（如通知、配置更新）
  if (data.type === 'CONFIG_UPDATE') {
    // 广播给所有 content scripts
    chrome.tabs.query({ url: 'https://www.zhipin.com/*' }, (tabs) => {
      tabs.forEach(tab => {
        chrome.tabs.sendMessage(tab.id, data).catch(() => {});
      });
    });
  }
}

// ============================================================
// 处理 Content Script 消息
// ============================================================

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type === 'NEW_MESSAGE') {
    // 转发给后端
    sendToBackend({
      type: 'CHAT_MESSAGE',
      chatId: msg.payload.chatId,
      message: msg.payload.message,
      timestamp: msg.payload.timestamp,
      pageUrl: msg.payload.pageUrl,
      jobContext: msg.payload.jobContext || null,
      candidateName: msg.payload.candidateName || null,
    })
      .then(response => {
        sendResponse({
          reply: response.reply,
          action: response.action,
        });
      })
      .catch(err => {
        console.error(`${LOG_PREFIX} 转发消息失败:`, err);
        sendResponse({ reply: null, error: err.message });
      });

    return true; // 异步 sendResponse
  }

  // ---- 调试日志打印 ----
  if (msg.type === 'DEBUG_LOG') {
    sendToBackend({
      type: 'DEBUG_LOG',
      log: msg.log,
    })
      .then(() => {
        sendResponse({ ok: true });
      })
      .catch(err => {
        sendResponse({ ok: false, error: err.message });
      });
    return true;
  }

  // ---- 主动打招呼：反激活所有岗位 ----
  if (msg.type === 'DEACTIVATE_ALL_JOBS') {
    sendToBackend({
      type: 'DEACTIVATE_ALL_JOBS',
    })
      .then(response => {
        sendResponse({ ok: response.ok, error: response.error });
      })
      .catch(err => {
        console.error(`${LOG_PREFIX} 反激活岗位失败:`, err);
        sendResponse({ ok: false, error: err.message });
      });

    return true;
  }

  // ---- 主动打招呼：同步保存岗位 ----
  if (msg.type === 'SAVE_JOB_POST') {
    sendToBackend({
      type: 'SAVE_JOB_POST',
      jobData: msg.payload.jobData,
    })
      .then(response => {
        sendResponse({
          ok: response.ok,
          job: response.job,
          error: response.error,
        });
      })
      .catch(err => {
        console.error(`${LOG_PREFIX} 岗位同步失败:`, err);
        sendResponse({ ok: false, error: err.message });
      });

    return true;
  }

  // ---- 主动打招呼：评估候选人 ----
  if (msg.type === 'EVALUATE_CANDIDATES') {
    sendToBackend({
      type: 'EVALUATE_CANDIDATES',
      candidates: msg.payload.candidates,
      jobTitle: msg.payload.jobTitle || null,
    })
      .then(response => {
        sendResponse({
          ranked: response.ranked,
          filtered: response.filtered || [],
          quota: response.quota,
          filtered_count: response.filtered_count,
          error: response.error,
        });
      })
      .catch(err => {
        console.error(`${LOG_PREFIX} 候选人评估失败:`, err);
        sendResponse({ ranked: [], filtered: [], error: err.message });
      });

    return true;
  }

  // ---- 主动打招呼：批准候选人 ----
  if (msg.type === 'APPROVE_GREETINGS') {
    sendToBackend({
      type: 'APPROVE_GREETINGS',
      greetingIds: msg.payload.greetingIds,
    })
      .then(response => sendResponse(response))
      .catch(err => {
        console.error(`${LOG_PREFIX} 批准请求失败:`, err);
        sendResponse({ error: err.message });
      });

    return true;
  }

  // ---- 主动打招呼：记录已发送 ----
  if (msg.type === 'GREETING_SENT') {
    sendToBackend({
      type: 'GREETING_SENT',
      greetingId: msg.payload.greetingId,
    })
      .then(response => sendResponse(response))
      .catch(err => {
        console.error(`${LOG_PREFIX} 记录打招呼失败:`, err);
        sendResponse({ error: err.message });
      });

    return true;
  }

  // ---- 主动打招呼：记录跟进消息 ----
  if (msg.type === 'FOLLOWUP_SENT') {
    sendToBackend({
      type: 'FOLLOWUP_SENT',
      greetingId: msg.payload.greetingId,
      followupText: msg.payload.followupText,
    })
      .then(response => sendResponse(response))
      .catch(err => {
        console.error(`${LOG_PREFIX} 记录跟进消息失败:`, err);
        sendResponse({ error: err.message });
      });

    return true;
  }

  // ---- 自动采集微简历画像 ----
  if (msg.type === 'UPDATE_CANDIDATE_PROFILE') {
    sendToBackend({
      type: 'UPDATE_CANDIDATE_PROFILE',
      chatId: msg.payload.chatId,
      profileData: msg.payload.profileData,
    })
      .then(response => sendResponse(response))
      .catch(err => {
        console.error(`${LOG_PREFIX} 转发微简历画像失败:`, err);
        sendResponse({ ok: false, error: err.message });
      });
    return true; // 异步 response
  }

  // ---- 在线简历完整解析上报 ----
  if (msg.type === 'UPDATE_CANDIDATE_RESUME') {
    sendToBackend({
      type: 'UPDATE_CANDIDATE_RESUME',
      chatId: msg.payload.chatId,
      name: msg.payload.name,
      resumeText: msg.payload.resumeText,
    })
      .then(response => sendResponse(response))
      .catch(err => {
        console.error(`${LOG_PREFIX} 转发在线简历失败:`, err);
        sendResponse({ ok: false, error: err.message });
      });
    return true; // 异步 response
  }

  // ---- 检查候选人是否被评估过 ----
  if (msg.type === 'CHECK_EVALUATED') {
    const url = `http://127.0.0.1:8765/api/candidates/check_evaluated?chat_id=${encodeURIComponent(msg.payload.chatId)}&name=${encodeURIComponent(msg.payload.name)}`;
    fetch(url)
      .then(res => res.json())
      .then(data => sendResponse({ evaluated: data.evaluated, has_messages: data.has_messages }))
      .catch(err => {
        console.error(`${LOG_PREFIX} 检查候选人评估状态失败:`, err);
        sendResponse({ evaluated: false, has_messages: false });
      });
    return true; // 异步 response
  }

  // ---- Preflight Check：截图 ----
  if (msg.type === 'CAPTURE_SCREENSHOT') {
    chrome.tabs.captureVisibleTab(null, { format: 'png' }, (dataUrl) => {
      if (chrome.runtime.lastError) {
        console.warn(`${LOG_PREFIX} 截图失败:`, chrome.runtime.lastError.message);
        sendResponse({ screenshot: null, error: chrome.runtime.lastError.message });
      } else {
        sendResponse({ screenshot: dataUrl });
      }
    });
    return true; // 异步 sendResponse
  }

  // ---- Preflight Check：诊断上报（走 HTTP，避免大包阻塞 WS）----
  if (msg.type === 'REPORT_DIAGNOSTIC') {
    fetch('http://127.0.0.1:8765/api/diagnostic', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(msg.payload),
    })
      .then(res => res.json())
      .then(data => {
        console.log(`${LOG_PREFIX} 诊断数据上报成功:`, data);
        sendResponse(data);
      })
      .catch(err => {
        console.error(`${LOG_PREFIX} 诊断数据上报失败:`, err);
        sendResponse({ ok: false, error: err.message });
      });
    return true; // 异步 sendResponse
  }

  if (msg.type === 'GET_DAILY_STATS') {
    fetch('http://127.0.0.1:8765/api/stats/daily')
      .then(res => res.json())
      .then(data => sendResponse(data))
      .catch(err => {
        console.error(`${LOG_PREFIX} 获取今日统计数据失败:`, err);
        sendResponse({ ok: false, error: err.message });
      });
    return true; // 异步 response
  }

  if (msg.type === 'GET_CONNECTION_STATUS') {
    sendResponse({
      connected: ws?.readyState === WebSocket.OPEN,
      reconnectAttempts,
    });
    return;
  }

  if (msg.type === 'FORCE_RECONNECT') {
    reconnectAttempts = 0;
    if (ws) ws.close();
    connectWebSocket();
    sendResponse({ ok: true });
    return;
  }
});

// ============================================================
// 初始化
// ============================================================

console.log(`${LOG_PREFIX} Service Worker 启动`);
connectWebSocket();

// MV3 Service Worker 可能被挂起，通过 alarm 保活
chrome.alarms.create('keepalive', { periodInMinutes: 1 });
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === 'keepalive') {
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      connectWebSocket();
    }
  }
});
