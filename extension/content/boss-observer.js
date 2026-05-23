/**
 * boss-observer.js
 * Boss直聘 DOM 监听核心 — 检测新消息并协调回复
 * 
 * 这是 Content Script 的主入口，协调各模块工作：
 * 1. MutationObserver 监听新聊天消息
 * 2. 将新消息发送给后端（通过 Background Service Worker）
 * 3. 接收后端回复并通过 ChatInteractor 发送
 * 
 * 依赖：human-simulator.js, chat-interactor.js
 */

(() => {
  'use strict';

  const LOG_PREFIX = '[HireCopilot:Observer]';
  const VERSION = '0.1.0';

  // ============================================================
  // 状态管理
  // ============================================================
  const state = {
    enabled: false,                // 是否启用自动回复
    observer: null,                // MutationObserver 实例
    processedMessages: new Set(),  // 已处理的消息指纹（去重）
    currentChatId: null,           // 当前聊天对象 ID
    pendingReply: false,           // 是否有回复正在处理中
    stats: {
      messagesReceived: 0,
      repliesSent: 0,
      errors: 0,
      startTime: null,
    },
  };

  // ============================================================
  // 消息指纹（去重）
  // ============================================================

  /**
   * 生成消息指纹，用于去重
   */
  function getMessageFingerprint(text, timestamp) {
    // 简单但有效的指纹：内容 + 粗粒度时间
    const timeKey = Math.floor(timestamp / 60000); // 分钟级别
    return `${text.substring(0, 50)}_${timeKey}`;
  }

  // ============================================================
  // DOM 监听
  // ============================================================

  /**
   * 设置 MutationObserver 监听聊天消息区域
   */
  function setupObserver() {
    // 尝试定位聊天消息容器
    const chatContainer = findChatContainer();
    if (!chatContainer) {
      console.warn(`${LOG_PREFIX} 未找到聊天消息容器，将在 3 秒后重试`);
      setTimeout(setupObserver, 3000);
      return;
    }

    console.log(`${LOG_PREFIX} 找到聊天容器，开始监听`);

    // 创建 MutationObserver
    state.observer = new MutationObserver(
      debounce(handleMutations, 300)
    );

    state.observer.observe(chatContainer, {
      childList: true,
      subtree: true,
      // 不监听 attributes 和 characterData，减少噪音
    });

    // 同时监听聊天列表切换（用户切到不同对话）
    observeChatListSwitch();
  }

  /**
   * 查找聊天消息容器
   */
  function findChatContainer() {
    const candidates = [
      'div.chat-record',
      'div[class*="chat-message"]',
      'div[class*="message-list"]',
      'div[class*="chat-content"]',
      'div.chat-conversation',
    ];

    for (const selector of candidates) {
      const el = document.querySelector(selector);
      if (el) return el;
    }
    return null;
  }

  /**
   * 监听聊天列表切换
   */
  function observeChatListSwitch() {
    const chatList = document.querySelector(
      'ul.chat-list, div[class*="chat-list"], div[class*="session-list"]'
    );
    if (!chatList) return;

    const listObserver = new MutationObserver(() => {
      // 检测当前活跃的聊天是否变了
      const activeItem = chatList.querySelector(
        'li.active, li[class*="active"], li[class*="selected"]'
      );
      if (activeItem) {
        const newChatId = activeItem.getAttribute('data-id') ||
                          activeItem.getAttribute('data-uid') ||
                          activeItem.textContent?.substring(0, 20);
        if (newChatId !== state.currentChatId) {
          state.currentChatId = newChatId;
          console.log(`${LOG_PREFIX} 切换到聊天: ${newChatId}`);
        }
      }
    });

    listObserver.observe(chatList, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ['class'],
    });
  }

  // ============================================================
  // 岗位信息抓取
  // ============================================================

  /**
   * 从聊天页面右侧/顶部抓取当前对话关联的岗位信息
   * Boss直聘聊天页面通常会在侧栏展示候选人感兴趣的岗位
   */
  function scrapeJobContext() {
    const job = {
      title: null,
      salary_range: null,
      requirements: null,
      description: null,
      company: null,
      highlights: null,
    };

    try {
      // ---- 岗位名称 ----
      const titleSelectors = [
        '.chat-job .job-title',
        '.job-detail .name',
        '.chat-detail .job-name',
        'div[class*="job"] [class*="title"]',
        '.resume-detail .job-title',
        '.chat-right .position-name',
        'a[class*="job"] .title',
        '.chat-info .job-name',
      ];
      job.title = queryText(titleSelectors);

      // ---- 薪资 ----
      const salarySelectors = [
        '.chat-job .salary',
        '.job-detail .salary',
        'div[class*="job"] [class*="salary"]',
        'div[class*="job"] [class*="pay"]',
        '.chat-right .salary',
        'span[class*="red"]',
      ];
      job.salary_range = queryText(salarySelectors);

      // ---- 要求（经验/学历等）----
      const reqSelectors = [
        '.chat-job .info-labels',
        '.job-detail .require',
        '.job-detail .job-info',
        'div[class*="job"] [class*="require"]',
        'div[class*="job"] [class*="info"]',
        '.chat-right .job-require',
      ];
      job.requirements = queryText(reqSelectors);

      // ---- JD 描述 ----
      const descSelectors = [
        '.chat-job .job-desc',
        '.job-detail .desc',
        '.job-detail .text',
        'div[class*="job"] [class*="desc"]',
        '.chat-right .job-desc',
      ];
      job.description = queryText(descSelectors);

      // ---- 公司名 ----
      const companySelectors = [
        '.chat-job .company-name',
        '.job-detail .company',
        'div[class*="company"] [class*="name"]',
        '.chat-right .company-name',
        '.chat-info .company',
      ];
      job.company = queryText(companySelectors);

      // 如果什么都没抓到，尝试从聊天头部区域批量提取
      if (!job.title) {
        const headerJob = scrapeFromChatHeader();
        if (headerJob) Object.assign(job, headerJob);
      }
    } catch (err) {
      console.warn(`${LOG_PREFIX} 抓取岗位信息异常:`, err);
    }

    // 检查是否至少有一个字段有值
    const hasAnyData = Object.values(job).some(v => v);
    if (hasAnyData) {
      console.log(`${LOG_PREFIX} 抓取到岗位: ${job.title || '(无标题)'}`);
    }
    return hasAnyData ? job : null;
  }

  /**
   * 从聊天头部区域提取岗位信息（备选方案）
   */
  function scrapeFromChatHeader() {
    const headerArea = document.querySelector(
      '.chat-header, .chat-top, div[class*="chat-info"], div[class*="dialog-title"]'
    );
    if (!headerArea) return null;

    const text = headerArea.textContent || '';
    // 尝试从文本中提取信息
    const salaryMatch = text.match(/(\d+[-~]\d+[Kk万])/);
    const title = headerArea.querySelector('span, h3, a')?.textContent?.trim();

    if (!title && !salaryMatch) return null;

    return {
      title: title || null,
      salary_range: salaryMatch?.[1] || null,
    };
  }

  /**
   * 从聊天页面抓取当前对话的候选人姓名
   */
  function scrapeCandidateName() {
    try {
      // 1. 尝试从聊天头部标题获取
      const headerNameSelectors = [
        '.chat-top .name',
        '.chat-header .name',
        'div[class*="chat-top"] [class*="name"]',
        'div[class*="chat-header"] [class*="name"]',
        '.active-chat-name',
        'div.dialog-title span.name',
      ];
      for (const sel of headerNameSelectors) {
        const el = document.querySelector(sel);
        const name = el?.textContent?.trim();
        if (name && name.length > 0 && name.length < 15) return name;
      }

      // 2. 尝试从聊天列表的活跃项中获取
      const chatList = document.querySelector(
        'ul.chat-list, div[class*="chat-list"], div[class*="session-list"]'
      );
      if (chatList) {
        const activeItem = chatList.querySelector(
          'li.active, li[class*="active"], li[class*="selected"]'
        );
        if (activeItem) {
          const nameEl = activeItem.querySelector('.name, [class*="name"], span[class*="title"]');
          const name = nameEl?.textContent?.trim();
          if (name && name.length > 0 && name.length < 15) return name;
        }
      }

      // 3. 尝试从右侧简历栏获取
      const resumeNameSelectors = [
        '.resume-detail .name',
        '.resume-custom .name',
        'div[class*="resume"] [class*="name"]',
      ];
      for (const sel of resumeNameSelectors) {
        const el = document.querySelector(sel);
        const name = el?.textContent?.trim();
        if (name && name.length > 0 && name.length < 15) return name;
      }
    } catch (e) {
      console.warn(`${LOG_PREFIX} 抓取候选人姓名异常:`, e);
    }
    return null;
  }

  /**
   * 依次尝试多个选择器，返回第一个匹配到的文本
   */
  function queryText(selectors) {
    for (const sel of selectors) {
      try {
        const el = document.querySelector(sel);
        const text = el?.textContent?.trim();
        if (text && text.length > 0) return text;
      } catch { /* 选择器无效，跳过 */ }
    }
    return null;
  }

  // ============================================================
  // 消息处理
  // ============================================================

  /**
   * 处理 DOM 变化
   */
  function handleMutations(mutations) {
    if (!state.enabled) return;

    for (const mutation of mutations) {
      if (mutation.type !== 'childList') continue;

      for (const node of mutation.addedNodes) {
        if (node.nodeType !== Node.ELEMENT_NODE) continue;
        processNewNode(node);
      }
    }
  }

  /**
   * 处理新增的 DOM 节点，提取消息
   */
  function processNewNode(node) {
    // 检查是否是消息气泡
    const msgSelectors = [
      'div[class*="msg"]',
      'div[class*="message"]',
      'span[class*="text"]',
    ];

    for (const selector of msgSelectors) {
      const msgElements = node.matches?.(selector)
        ? [node]
        : node.querySelectorAll?.(selector) || [];

      for (const msgEl of msgElements) {
        extractAndProcessMessage(msgEl);
      }
    }
  }

  /**
   * 提取消息内容并处理
   */
  function extractAndProcessMessage(msgEl) {
    const text = msgEl.textContent?.trim();
    if (!text || text.length < 1) return;

    // 判断是否是对方发的消息（不是自己发的）
    const parentClasses = getAncestorClasses(msgEl, 5);
    const isSelf = /self|right|mine|owner/.test(parentClasses);
    if (isSelf) return; // 跳过自己发的消息

    // 去重检查
    const fingerprint = getMessageFingerprint(text, Date.now());
    if (state.processedMessages.has(fingerprint)) return;
    state.processedMessages.add(fingerprint);

    // 防止 Set 无限增长
    if (state.processedMessages.size > 500) {
      const entries = [...state.processedMessages];
      state.processedMessages = new Set(entries.slice(-200));
    }

    console.log(`${LOG_PREFIX} 新消息: "${text.substring(0, 30)}..."`);
    state.stats.messagesReceived++;

    // 发送给后端处理
    requestReply(text);
  }

  /**
   * 获取祖先元素的 class 字符串（用于判断消息方向）
   */
  function getAncestorClasses(el, depth) {
    let classes = '';
    let current = el;
    for (let i = 0; i < depth && current; i++) {
      classes += ' ' + (current.className || '');
      current = current.parentElement;
    }
    return classes.toLowerCase();
  }

  // ============================================================
  // 与后端通信
  // ============================================================

  /**
   * 将消息发送给后端，请求 LLM 生成回复
   */
  async function requestReply(incomingMessage) {
    if (state.pendingReply) {
      console.log(`${LOG_PREFIX} 有回复正在处理中，跳过`);
      return;
    }

    const sim = window.HumanSimulator;

    // 工作时间检查
    if (!sim.isWithinWorkHours()) {
      console.log(`${LOG_PREFIX} 非工作时间，不回复`);
      return;
    }

    // 休息检查
    if (sim.needsRest()) {
      const restTime = sim.getRestDuration();
      console.log(`${LOG_PREFIX} 需要休息 ${(restTime / 60000).toFixed(0)} 分钟`);
      await sim.sleep(restTime);
    }

    state.pendingReply = true;

    try {
      // 抓取当前对话关联的岗位信息
      const jobContext = scrapeJobContext();
      // 抓取当前对话关联的候选人姓名
      const candidateName = scrapeCandidateName();

      // 发送给 Background Service Worker
      const response = await chrome.runtime.sendMessage({
        type: 'NEW_MESSAGE',
        payload: {
          chatId: state.currentChatId,
          message: incomingMessage,
          timestamp: Date.now(),
          pageUrl: window.location.href,
          jobContext,  // 附带岗位上下文
          candidateName, // 候选人姓名
        },
      });

      if (response?.reply) {
        // 模拟思考延迟
        const thinkDelay = sim.getThinkDelay(incomingMessage);
        console.log(`${LOG_PREFIX} 思考 ${(thinkDelay / 1000).toFixed(1)}s 后回复`);
        await sim.sleep(thinkDelay);

        // 发送回复
        const success = await window.ChatInteractor.sendSegmentedMessage(response.reply);
        if (success) {
          state.stats.repliesSent++;
          console.log(`${LOG_PREFIX} 回复成功 (总计: ${state.stats.repliesSent})`);
        }
      } else if (response?.action === 'SKIP') {
        console.log(`${LOG_PREFIX} 后端建议跳过此消息`);
      } else if (response?.action === 'HUMAN_NEEDED') {
        console.log(`${LOG_PREFIX} ⚠️ 需要人工介入`);
        // TODO: 显示通知
      }
    } catch (err) {
      console.error(`${LOG_PREFIX} 请求回复失败:`, err);
      state.stats.errors++;
    } finally {
      state.pendingReply = false;
    }
  }

  // ============================================================
  // 工具函数
  // ============================================================

  /**
   * 防抖函数
   */
  function debounce(fn, delay) {
    let timer = null;
    return function (...args) {
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => fn.apply(this, args), delay);
    };
  }

  // ============================================================
  // 消息监听（来自 Popup 和 Background）
  // ============================================================

  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    switch (msg.type) {
      case 'TOGGLE_ENABLED':
        state.enabled = msg.enabled;
        console.log(`${LOG_PREFIX} 自动回复: ${state.enabled ? '开启' : '关闭'}`);
        if (state.enabled && !state.observer) {
          state.stats.startTime = Date.now();
          setupObserver();
        }
        sendResponse({ ok: true, enabled: state.enabled });
        break;

      case 'GET_STATUS':
        sendResponse({
          ok: true,
          enabled: state.enabled,
          stats: state.stats,
          currentChatId: state.currentChatId,
        });
        break;

      case 'SEND_MANUAL':
        // 手动发送消息（从 Popup 触发）
        window.ChatInteractor.sendSegmentedMessage(msg.text)
          .then(success => sendResponse({ ok: success }));
        return true; // 异步 sendResponse
    }
  });

  // ============================================================
  // 打招呼跟进消息
  // ============================================================

  /**
   * 检查并发送待处理的跟进消息
   * 在推荐牛人页面打招呼后，跟进消息会存到 chrome.storage
   * 切到聊天页面后自动在对应对话中发送
   */
  async function checkPendingFollowups() {
    const stored = await chrome.storage.local.get(['pendingFollowups']);
    const pending = stored.pendingFollowups || [];

    if (pending.length === 0) return;

    console.log(`${LOG_PREFIX} 发现 ${pending.length} 条待发送的跟进消息`);

    const sim = window.HumanSimulator;
    const sent = [];

    for (const item of pending) {
      // 检查是否超过 1 小时（过期不发）
      if (Date.now() - item.timestamp > 60 * 60 * 1000) {
        console.log(`${LOG_PREFIX} 跟进消息已过期 (>1h): ${item.candidateName}`);
        sent.push(item);
        continue;
      }

      console.log(`${LOG_PREFIX} 准备发送跟进消息给: ${item.candidateName}`);

      // 在聊天列表中找到该候选人
      const found = await findAndOpenChat(item.candidateName);
      if (!found) {
        console.warn(`${LOG_PREFIX} 未在聊天列表中找到: ${item.candidateName}`);
        continue;
      }

      // 等待聊天窗口稳定
      await sim.sleep(sim.clampedGaussian(2000, 500, 1000, 4000));

      // 发送跟进消息
      try {
        const success = await window.ChatInteractor.sendSegmentedMessage(item.followupText);
        if (success) {
          console.log(`${LOG_PREFIX} ✅ 跟进消息已发送给 ${item.candidateName}`);
          sent.push(item);

          // 通知后端
          if (item.greetingId) {
            chrome.runtime.sendMessage({
              type: 'FOLLOWUP_SENT',
              payload: {
                greetingId: item.greetingId,
                followupText: item.followupText,
              },
            }).catch(() => {});
          }

          // 等待一段时间再处理下一个
          await sim.sleep(sim.clampedGaussian(30000, 10000, 15000, 60000));
        }
      } catch (err) {
        console.error(`${LOG_PREFIX} 发送跟进消息失败:`, err);
      }
    }

    // 清除已发送的
    if (sent.length > 0) {
      const remaining = pending.filter(p =>
        !sent.some(s => s.candidateName === p.candidateName && s.timestamp === p.timestamp)
      );
      await chrome.storage.local.set({ pendingFollowups: remaining });
      console.log(`${LOG_PREFIX} 已清除 ${sent.length} 条已处理的跟进消息`);
    }
  }

  /**
   * 在聊天列表中找到并打开指定候选人的对话
   */
  async function findAndOpenChat(candidateName) {
    const chatList = document.querySelector(
      'ul.chat-list, div[class*="chat-list"], div[class*="session-list"]'
    );
    if (!chatList) return false;

    // 遍历聊天列表项
    const items = chatList.querySelectorAll('li, div[class*="item"]');
    for (const item of items) {
      const text = item.textContent || '';
      if (text.includes(candidateName)) {
        item.click();
        console.log(`${LOG_PREFIX} 已打开 ${candidateName} 的对话`);
        return true;
      }
    }

    return false;
  }

  // ============================================================
  // 初始化
  // ============================================================

  async function init() {
    console.log(`${LOG_PREFIX} v${VERSION} 已加载`);

    // 从 storage 读取上次的开关状态
    const stored = await chrome.storage.local.get(['copilotEnabled']);
    state.enabled = stored.copilotEnabled || false;

    if (state.enabled) {
      state.stats.startTime = Date.now();
      setupObserver();
      console.log(`${LOG_PREFIX} 自动回复已启用（上次状态恢复）`);
    } else {
      console.log(`${LOG_PREFIX} 自动回复未启用，请在 Popup 中开启`);
    }

    // 检查并发送待处理的跟进消息
    setTimeout(() => checkPendingFollowups(), 5000);
  }

  // 等页面稳定后再初始化
  if (document.readyState === 'complete') {
    setTimeout(init, 2000);
  } else {
    window.addEventListener('load', () => setTimeout(init, 2000));
  }
})();

