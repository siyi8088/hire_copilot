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
  const MODULE_NAME = 'chatObserver';

  // ============================================================
  // 状态管理
  // ============================================================
  const state = {
    enabled: false,                // 是否启用自动回复
    observer: null,                // MutationObserver 实例
    processedMessages: new Set(),  // 已处理的消息指纹（去重）
    currentChatId: null,           // 当前聊天对象 ID
    pendingReply: false,           // 是否有回复正在处理中
    preflightResult: null,         // 校准结果
    stats: {
      messagesReceived: 0,
      repliesSent: 0,
      errors: 0,
      startTime: null,
    },
  };

  let sweepTimer = null;
  let isScanning = false;

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
  // 选择器智能路由与子模块校准
  // ============================================================

  /**
   * 智能路由选择器，自动从正确的子模块获取已校准选择器
   */
  function getSelector(selectorName) {
    if (!window.PreflightCheck) return null;
    const listSelectors = ['CHAT_LIST', 'CHAT_LIST_ITEM', 'ACTIVE_CHAT_ITEM'];
    const targetModule = listSelectors.includes(selectorName) ? 'chatObserver' : 'chatConversation';
    return window.PreflightCheck.getSelector(targetModule, selectorName);
  }

  /**
   * 触发“聊天对话框”部分的校准
   */
  async function calibrateConversation(forceRefresh = false) {
    if (!window.PreflightCheck) return null;
    console.log(`${LOG_PREFIX} 正在校准聊天对话框选择器...`);
    const result = await window.PreflightCheck.run('chatConversation', { forceRefresh });
    if (result.passed) {
      console.log(`${LOG_PREFIX} ✅ 聊天对话框校准通过${result.fromCache ? ' (缓存)' : ''}`);
    } else {
      console.warn(`${LOG_PREFIX} ⚠️ 聊天对话框校准失败，自动回复可能受影响`);
    }
    
    // 成功/失败均尝试提取候选人画像并上报
    setTimeout(() => {
      tryReportCandidateProfile();
      // 根据是否已有智能评估做出在线简历自动/手动采集决策
      handleResumeCollectionDecision();
    }, 500);

    return result;
  }

  // 缓存已处理的在线简历，避免重复评估
  const processedResumes = new Set();

  /**
   * 检查并抓取当前展示的在线简历弹窗/侧栏内容
   */
  function checkAndScrapeOnlineResume() {
    try {
      const resumeSelectors = [
        '.resume-detail',
        '.resume-custom',
        'div[class*="resume-detail"]',
        'div[class*="resume-custom"]',
        'div[class*="resume-content"]',
        'div[class*="resume-drawer"]',
        'div[class*="resume-preview"]',
        'div[class*="geek-resume"]',
      ];
      
      let resumeEl = null;
      for (const sel of resumeSelectors) {
        const el = document.querySelector(sel);
        if (el && el.offsetWidth > 0 && el.offsetHeight > 0) {
          resumeEl = el;
          break;
        }
      }
      
      if (!resumeEl) return;
      
      const candidateName = scrapeCandidateName();
      if (!candidateName) return;
      
      const resumeText = resumeEl.innerText || '';
      if (resumeText.length < 50) return;
      
      const fingerprint = `${candidateName}_${resumeText.length}`;
      if (processedResumes.has(fingerprint)) return;
      processedResumes.add(fingerprint);
      
      console.log(`${LOG_PREFIX} 📄 侦测到在线简历展开，正在采集解析 [${candidateName}]...`);
      
      chrome.runtime.sendMessage({
        type: 'UPDATE_CANDIDATE_RESUME',
        payload: {
          chatId: getCurrentChatId(),
          name: candidateName,
          resumeText: resumeText,
        }
      }).then(response => {
        if (response && response.ok) {
          console.log(`${LOG_PREFIX} ✅ 在线简历解析上报成功`);
        }
      }).catch(err => {
        console.error(`${LOG_PREFIX} ❌ 上报在线简历失败:`, err);
      });
      
    } catch (e) {
      console.warn(`${LOG_PREFIX} 提取在线简历异常:`, e);
    }
  }

  // ============================================================
  // DOM 监听
  // ============================================================

  let bodyObserver = null;

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

    // 监听 document.body 以便捕获弹窗简历
    if (!bodyObserver) {
      bodyObserver = new MutationObserver(
        debounce(() => {
          checkAndScrapeOnlineResume();
        }, 500)
      );
      bodyObserver.observe(document.body, {
        childList: true,
        subtree: true,
      });
    }

    // 同时监听聊天列表切换（用户切到不同对话）
    observeChatListSwitch();
  }

  /**
   * 查找聊天消息容器
   */
  function findChatContainer() {
    const candidates = window.PreflightCheck
      ? window.PreflightCheck.getSelector(MODULE_NAME, 'CHAT_CONTAINER')
      : [
          'div.chat-record',
          'div[class*="chat-message"]',
          'div[class*="message-list"]',
          'div[class*="chat-content"]',
          'div.chat-conversation',
        ];

    const selectorList = typeof candidates === 'string' ? [candidates] : candidates;
    for (const selector of selectorList) {
      const el = document.querySelector(selector);
      if (el) return el;
    }
    return null;
  }

  /**
   * 监听聊天列表切换
   */
  function observeChatListSwitch() {
    const chatListCandidates = window.PreflightCheck
      ? window.PreflightCheck.getSelector(MODULE_NAME, 'CHAT_LIST')
      : ['ul.chat-list', 'div[class*="chat-list"]', 'div[class*="session-list"]'];
    const chatListSels = typeof chatListCandidates === 'string' ? [chatListCandidates] : chatListCandidates;

    let chatList = null;
    for (const sel of chatListSels) {
      chatList = document.querySelector(sel);
      if (chatList) break;
    }

    if (!chatList) return;

    const activeItemCandidates = window.PreflightCheck
      ? window.PreflightCheck.getSelector(MODULE_NAME, 'ACTIVE_CHAT_ITEM')
      : ['.geek-item.selected', '.geek-item.active', 'li.active', 'li[class*="active"]', 'li[class*="selected"]'];
    const activeItemSels = typeof activeItemCandidates === 'string' ? [activeItemCandidates] : activeItemCandidates;

    // 初始化当前聊天 ID
    let activeItem = null;
    for (const sel of activeItemSels) {
      activeItem = chatList.querySelector(sel);
      if (activeItem) break;
    }
    if (activeItem) {
      state.currentChatId = activeItem.getAttribute('data-id') ||
                            activeItem.getAttribute('data-uid') ||
                            activeItem.textContent?.substring(0, 20);
      console.log(`${LOG_PREFIX} 初始化当前聊天ID: ${state.currentChatId}`);
    }

    const listObserver = new MutationObserver(() => {
      let activeItem = null;
      for (const sel of activeItemSels) {
        activeItem = chatList.querySelector(sel);
        if (activeItem) break;
      }
      if (activeItem) {
        const newChatId = activeItem.getAttribute('data-id') ||
                          activeItem.getAttribute('data-uid') ||
                          activeItem.textContent?.substring(0, 20);
        if (newChatId !== state.currentChatId) {
          state.currentChatId = newChatId;
          console.log(`${LOG_PREFIX} 切换到聊天: ${newChatId}`);
          // 切换聊天后，延迟 500ms 等待对话框渲染，然后自动执行对话部分校准
          setTimeout(() => {
            calibrateConversation();
          }, 500);
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
      const titleCandidates = window.PreflightCheck
        ? window.PreflightCheck.getSelector(MODULE_NAME, 'JOB_TITLE')
        : [
            '.chat-job .job-title', '.job-detail .name', '.chat-detail .job-name',
            'div[class*="job"] [class*="title"]', '.resume-detail .job-title',
            '.chat-right .position-name', 'a[class*="job"] .title', '.chat-info .job-name',
          ];
      job.title = queryText(typeof titleCandidates === 'string' ? [titleCandidates] : titleCandidates);

      // ---- 薪资 ----
      const salaryCandidates = window.PreflightCheck
        ? window.PreflightCheck.getSelector(MODULE_NAME, 'JOB_SALARY')
        : [
            '.chat-job .salary', '.job-detail .salary',
            'div[class*="job"] [class*="salary"]', 'div[class*="job"] [class*="pay"]',
            '.chat-right .salary', 'span[class*="red"]',
          ];
      job.salary_range = queryText(typeof salaryCandidates === 'string' ? [salaryCandidates] : salaryCandidates);

      // ---- 要求（经验/学历等）----
      const reqCandidates = window.PreflightCheck
        ? window.PreflightCheck.getSelector(MODULE_NAME, 'JOB_REQUIREMENTS')
        : [
            '.chat-job .info-labels', '.job-detail .require', '.job-detail .job-info',
            'div[class*="job"] [class*="require"]', 'div[class*="job"] [class*="info"]',
            '.chat-right .job-require',
          ];
      job.requirements = queryText(typeof reqCandidates === 'string' ? [reqCandidates] : reqCandidates);

      // ---- JD 描述 ----
      const descCandidates = window.PreflightCheck
        ? window.PreflightCheck.getSelector(MODULE_NAME, 'JOB_DESCRIPTION')
        : [
            '.chat-job .job-desc', '.job-detail .desc', '.job-detail .text',
            'div[class*="job"] [class*="desc"]', '.chat-right .job-desc',
          ];
      job.description = queryText(typeof descCandidates === 'string' ? [descCandidates] : descCandidates);

      // ---- 公司名 ----
      const companyCandidates = window.PreflightCheck
        ? window.PreflightCheck.getSelector(MODULE_NAME, 'JOB_COMPANY')
        : [
            '.chat-job .company-name', '.job-detail .company',
            'div[class*="company"] [class*="name"]', '.chat-right .company-name',
            '.chat-info .company',
          ];
      job.company = queryText(typeof companyCandidates === 'string' ? [companyCandidates] : companyCandidates);

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
    const headerAreaCandidates = window.PreflightCheck
      ? window.PreflightCheck.getSelector(MODULE_NAME, 'CHAT_HEADER_AREA')
      : ['.chat-header', '.chat-top', 'div[class*="chat-info"]', 'div[class*="dialog-title"]'];
    const headerAreaSels = typeof headerAreaCandidates === 'string' ? [headerAreaCandidates] : headerAreaCandidates;

    let headerArea = null;
    for (const sel of headerAreaSels) {
      headerArea = document.querySelector(sel);
      if (headerArea) break;
    }

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
      const headerNameCandidates = window.PreflightCheck
        ? window.PreflightCheck.getSelector(MODULE_NAME, 'CHAT_HEADER_NAME')
        : [
            '.chat-top .name', '.chat-header .name',
            'div[class*="chat-top"] [class*="name"]', 'div[class*="chat-header"] [class*="name"]',
            '.active-chat-name', 'div.dialog-title span.name',
          ];
      const headerNameSels = typeof headerNameCandidates === 'string' ? [headerNameCandidates] : headerNameCandidates;
      for (const sel of headerNameSels) {
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
      const resumeNameCandidates = window.PreflightCheck
        ? window.PreflightCheck.getSelector(MODULE_NAME, 'RESUME_NAME')
        : ['.resume-detail .name', '.resume-custom .name', 'div[class*="resume"] [class*="name"]'];
      const resumeNameSels = typeof resumeNameCandidates === 'string' ? [resumeNameCandidates] : resumeNameCandidates;
      for (const sel of resumeNameSels) {
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
   * 自动抓取当前候选人的画像信息（微简历快照）
   */
  function scrapeCandidateProfile() {
    const profile = {
      name: null,
      title: null,
      experience: null,
      education: null,
      salary: null,
      company: null,
    };

    try {
      // 1. 获取姓名
      profile.name = scrapeCandidateName();
      if (!profile.name) {
        console.warn(`${LOG_PREFIX} 未抓取到候选人姓名，跳过画像提取`);
        return null;
      }

      // 2. 尝试从 jobContext 获取岗位/薪资/公司
      const jobContext = scrapeJobContext();
      if (jobContext) {
        profile.title = jobContext.title;
        profile.salary = jobContext.salary_range;
        profile.company = jobContext.company;
      }

      // 3. 收集聊天头部区域及页面的文本进行正则匹配
      let headerText = '';
      const headerAreaCandidates = [
        '.base-info-single-container',
        '.base-info-single-top-detail',
        '.chat-header',
        '.chat-top',
        'div[class*="chat-info"]',
        'div[class*="dialog-title"]',
      ];
      for (const sel of headerAreaCandidates) {
        try {
          const el = document.querySelector(sel);
          if (el) {
            headerText += ' ' + el.textContent;
          }
        } catch {}
      }

      // 页面的 innerText 作为辅助
      const bodyText = document.body.innerText || '';

      // 寻找 "沟通职位：" 文本，优先级高于 jobContext.title
      const positionMatch = bodyText.match(/沟通职位[：:]\s*([^|·\n\r\t]+)/) || 
                            headerText.match(/沟通职位[：:]\s*([^|·\n\r\t]+)/);
      if (positionMatch && positionMatch[1]) {
        profile.title = positionMatch[1].trim();
      }

      // 4. 工作年限匹配
      const expMatch = headerText.match(/(应届生|在校生|无需经验|\d+年工作经验|\d+年)/) || 
                       bodyText.match(/(应届生|在校生|无需经验|\d+年工作经验|\d+年)/);
      if (expMatch) {
        profile.experience = expMatch[1].trim();
      }

      // 5. 学历匹配
      const eduMatch = headerText.match(/(博士|硕士|本科|大专|中专|高中)/) || 
                       bodyText.match(/(博士|硕士|本科|大专|中专|高中)/);
      if (eduMatch) {
        profile.education = eduMatch[1].trim();
      }

      // 6. 薪资期望匹配 (如果 jobContext 里没有)
      if (!profile.salary) {
        const salaryMatch = headerText.match(/(\d+-\d+[Kk万元]|\d+[Kk万元])/) || 
                            bodyText.match(/(\d+-\d+[Kk万元]|\d+[Kk万元])/);
        if (salaryMatch) {
          profile.salary = salaryMatch[1].trim();
        }
      }

      // 7. 兜底：如果依然没有职位名称，从左侧活跃聊天项抓取
      if (!profile.title) {
        const activeItem = document.querySelector(
          'li.active, li[class*="active"], li[class*="selected"], .geek-item.selected, .geek-item.active'
        );
        if (activeItem) {
          const possibleJobEls = activeItem.querySelectorAll('.job-name, .position, [class*="job"], [class*="position"]');
          for (const el of possibleJobEls) {
            const isNameOrTime = /name|time|date|msg|text|badge|status/i.test(el.className) || 
                                 /name|time|date|msg|text|badge|status/i.test(el.parentElement?.className || '');
            if (!isNameOrTime) {
              const text = el.textContent?.trim();
              if (text && text.length > 0 && text.length < 30) {
                profile.title = text;
                break;
              }
            }
          }
        }
      }

      console.log(`${LOG_PREFIX} 抓取画像成功:`, profile);
      return profile;
    } catch (e) {
      console.warn(`${LOG_PREFIX} 抓取画像异常:`, e);
    }
    return null;
  }

  /**
   * 尝试提取候选人画像并上报给后端
   */
  async function tryReportCandidateProfile() {
    try {
      const profileData = scrapeCandidateProfile();
      if (!profileData || !profileData.name) {
        return;
      }
      
      const chatId = getCurrentChatId();
      if (!chatId) {
        return;
      }

      console.log(`${LOG_PREFIX} 正在上报候选人画像: ${profileData.name} (${chatId})`);
      
      const response = await chrome.runtime.sendMessage({
        type: 'UPDATE_CANDIDATE_PROFILE',
        payload: {
          chatId,
          profileData,
        },
      });
      
      if (response && response.ok) {
        console.log(`${LOG_PREFIX} ✅ 画像上报成功`);
      } else {
        console.warn(`${LOG_PREFIX} ⚠️ 画像上报响应失败:`, response);
      }
    } catch (err) {
      console.error(`${LOG_PREFIX} 上报候选人画像失败:`, err);
    }
  }

  /**
   * 检查候选人评估状态和是否有历史消息
   */
  async function checkCandidateEvaluated(chatId, name) {
    try {
      const response = await chrome.runtime.sendMessage({
        type: 'CHECK_EVALUATED',
        payload: { chatId, name }
      });
      return {
        evaluated: response?.evaluated || false,
        hasMessages: response?.has_messages || false
      };
    } catch (e) {
      console.warn(`${LOG_PREFIX} 检查评估状态失败:`, e);
      return { evaluated: false, hasMessages: false };
    }
  }

  /**
   * 寻找“在线简历”按钮或链接
   */
  function findOnlineResumeButton() {
    const header = document.querySelector('.chat-top, .chat-header, .base-info-single-container, .dialog-title');
    if (header) {
      const buttons = header.querySelectorAll('a, button, span, div');
      for (const btn of buttons) {
        const text = btn.textContent?.trim();
        if (text === '在线简历' || text === '查看在线简历') {
          return btn;
        }
      }
    }
    // 兜底全页面查找
    const allButtons = document.querySelectorAll('a, button, span');
    for (const btn of allButtons) {
      const text = btn.textContent?.trim();
      if (text === '在线简历') {
        return btn;
      }
    }
    return null;
  }

  /**
   * 自动关闭在线简历弹窗
   */
  function closeOnlineResumeModal() {
    const resumeSelectors = [
      '.resume-detail',
      '.resume-custom',
      'div[class*="resume-detail"]',
      'div[class*="resume-custom"]',
      'div[class*="resume-content"]',
      'div[class*="resume-drawer"]',
      'div[class*="resume-preview"]',
      'div[class*="geek-resume"]',
    ];
    for (const sel of resumeSelectors) {
      const el = document.querySelector(sel);
      if (el && el.offsetWidth > 0 && el.offsetHeight > 0) {
        const closeBtn = el.querySelector('button[class*="close"], span[class*="close"], a[class*="close"], [class*="close"], .close');
        if (closeBtn) {
          closeBtn.click();
          console.log(`${LOG_PREFIX} 自动关闭了在线简历弹窗`);
          return true;
        }
      }
    }
    return false;
  }

  let capsuleEl = null;

  /**
   * 展示手动采集胶囊 UI
   */
  function showCapsuleUI(candidateName) {
    removeCapsuleUI();

    capsuleEl = document.createElement('div');
    capsuleEl.id = 'copilot-resume-capsule';
    capsuleEl.style.cssText = `
      position: fixed;
      bottom: 20px;
      right: 20px;
      z-index: 99999;
      display: flex;
      align-items: center;
      background: linear-gradient(135deg, #6366f1, #4f46e5);
      color: #ffffff;
      padding: 10px 16px;
      border-radius: 30px;
      box-shadow: 0 4px 15px rgba(99, 102, 241, 0.4);
      font-size: 13px;
      font-weight: 500;
      cursor: pointer;
      user-select: none;
      transition: all 0.3s ease;
    `;

    const label = document.createElement('span');
    label.textContent = `🤖 采集 [${candidateName}] 的在线简历`;
    label.style.marginRight = '8px';
    capsuleEl.appendChild(label);

    const closeBtn = document.createElement('span');
    closeBtn.textContent = '×';
    closeBtn.style.cssText = `
      display: inline-flex;
      align-items: center;
      justify-content: center;
      width: 18px;
      height: 18px;
      background: rgba(255, 255, 255, 0.2);
      border-radius: 50%;
      font-size: 14px;
      line-height: 1;
      margin-left: 4px;
      transition: background 0.2s;
    `;
    closeBtn.addEventListener('mouseenter', () => {
      closeBtn.style.background = 'rgba(255, 255, 255, 0.4)';
    });
    closeBtn.addEventListener('mouseleave', () => {
      closeBtn.style.background = 'rgba(255, 255, 255, 0.2)';
    });
    closeBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      removeCapsuleUI();
    });
    capsuleEl.appendChild(closeBtn);

    capsuleEl.addEventListener('click', () => {
      triggerManualScrape(candidateName);
    });

    document.body.appendChild(capsuleEl);
  }

  /**
   * 移除手动采集胶囊 UI
   */
  function removeCapsuleUI() {
    if (capsuleEl) {
      capsuleEl.remove();
      capsuleEl = null;
    }
  }

  /**
   * 触发手动采集流程
   */
  async function triggerManualScrape(candidateName) {
    if (capsuleEl) {
      const label = capsuleEl.querySelector('span');
      if (label) label.textContent = '⚡ 正在打开并采集在线简历...';
    }

    const btn = findOnlineResumeButton();
    if (!btn) {
      console.warn(`${LOG_PREFIX} 未找到在线简历按钮`);
      if (capsuleEl) {
        const label = capsuleEl.querySelector('span');
        if (label) label.textContent = '❌ 未找到在线简历按钮';
        setTimeout(removeCapsuleUI, 2000);
      }
      return;
    }

    btn.click();
    console.log(`${LOG_PREFIX} 手动采集：已点击打开在线简历预览`);

    setTimeout(() => {
      closeOnlineResumeModal();
      if (capsuleEl) {
        const label = capsuleEl.querySelector('span');
        if (label) label.textContent = '✅ 在线简历采集并评估成功';
        setTimeout(removeCapsuleUI, 2000);
      }
    }, 2000);
  }

  const autoCollectedNewChats = new Set();

  /**
   * 触发自动采集流程（针对新聊天）
   */
  async function triggerAutoScrape(candidateName) {
    const fingerprint = candidateName;
    if (autoCollectedNewChats.has(fingerprint)) return;
    autoCollectedNewChats.add(fingerprint);

    console.log(`${LOG_PREFIX} 🚀 侦测到新沟通候选人 ${candidateName}，启动自动简历采集流程...`);
    const btn = findOnlineResumeButton();
    if (!btn) {
      console.warn(`${LOG_PREFIX} 自动采集：未找到在线简历按钮`);
      return;
    }

    btn.click();

    setTimeout(() => {
      closeOnlineResumeModal();
    }, 2000);
  }

  /**
   * 判断画像采集并做出采集决策 (自动采集 vs 手动小胶囊)
   */
  async function handleResumeCollectionDecision() {
    try {
      const name = scrapeCandidateName();
      const chatId = getCurrentChatId();
      if (!name || !chatId) {
        removeCapsuleUI();
        return;
      }

      const status = await checkCandidateEvaluated(chatId, name);
      if (status.evaluated) {
        // 已有智能评分（来自推荐打招呼或者已自动采集），无需再次展示胶囊或触发自动采集
        removeCapsuleUI();
        return;
      }

      if (status.hasMessages) {
        // 历史聊天记录（数据库中已有聊天记录）：展示手动采集胶囊 UI
        showCapsuleUI(name);
      } else {
        // 新聊天记录（数据库中尚无聊天记录）：执行自动采集
        removeCapsuleUI();
        triggerAutoScrape(name);
      }
    } catch (e) {
      console.warn(`${LOG_PREFIX} 画像采集决策失败:`, e);
      removeCapsuleUI();
    }
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

    // 过滤系统官方和群聊等非候选人会话消息，防止误回复
    const candidateName = scrapeCandidateName();
    if (isSystemOrGroupContact(candidateName)) {
      return;
    }

    // 判断是否是对方发的消息（如果不是对方发送的，例如是自己发的或者系统消息，则跳过）
    const parentClasses = getAncestorClasses(msgEl, 5);
    const isCandidate = /friend|item-friend|left/.test(parentClasses);
    if (!isCandidate) return;

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
          chatId: getCurrentChatId(),
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

  /**
   * 动态获取当前选中的聊天 ID
   */
  function getCurrentChatId() {
    if (state.currentChatId) return state.currentChatId;

    try {
      const chatListCandidates = window.PreflightCheck
        ? window.PreflightCheck.getSelector(MODULE_NAME, 'CHAT_LIST')
        : ['ul.chat-list', 'div[class*="chat-list"]', 'div[class*="session-list"]'];
      const chatListSels = typeof chatListCandidates === 'string' ? [chatListCandidates] : chatListCandidates;

      let chatList = null;
      for (const sel of chatListSels) {
        chatList = document.querySelector(sel);
        if (chatList) break;
      }

      if (!chatList) return null;

      const activeItemCandidates = window.PreflightCheck
        ? window.PreflightCheck.getSelector(MODULE_NAME, 'ACTIVE_CHAT_ITEM')
        : ['.geek-item.selected', '.geek-item.active', 'li.active', 'li[class*="active"]', 'li[class*="selected"]'];
      const activeItemSels = typeof activeItemCandidates === 'string' ? [activeItemCandidates] : activeItemCandidates;

      let activeItem = null;
      for (const sel of activeItemSels) {
        activeItem = chatList.querySelector(sel);
        if (activeItem) break;
      }
      if (activeItem) {
        const chatId = activeItem.getAttribute('data-id') ||
                       activeItem.getAttribute('data-uid') ||
                       activeItem.textContent?.substring(0, 20);
        state.currentChatId = chatId;
        return chatId;
      }
    } catch (e) {
      console.warn(`${LOG_PREFIX} 动态获取当前聊天ID异常:`, e);
    }
    return null;
  }

  // ============================================================
  // 消息监听（来自 Popup 和 Background）
  // ============================================================

  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    switch (msg.type) {
      case 'TOGGLE_ENABLED':
        state.enabled = msg.enabled;
        console.log(`${LOG_PREFIX} 自动回复: ${state.enabled ? '开启' : '关闭'}`);
        if (state.enabled) {
          state.stats.startTime = Date.now();
          startAutoSweepLoop();
        } else {
          stopAutoSweepLoop();
        }
        sendResponse({ ok: true, enabled: state.enabled });
        break;

      case 'GET_STATUS':
        sendResponse({
          ok: true,
          enabled: state.enabled,
          stats: state.stats,
          currentChatId: getCurrentChatId(),
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
  // 全自动“扫雷”轮询循环与切换聊天
  // ============================================================

  /**
   * 判断某个会话项是否有未读红点/数字
   */
  function hasUnreadMessage(geekItemEl) {
    const badge = geekItemEl.querySelector('.badge');
    if (!badge) return false;

    // 检查是否有除了头像之外的未读数字或红点类名
    const subElements = badge.querySelectorAll('span, sup, i, div:not(.image-content)');
    for (const el of subElements) {
      const text = el.textContent?.trim() || '';
      if (/^\d+$/.test(text)) return true; // 有未读数字
      if (el.className && el.className.includes('dot')) return true; // 有红点类名
      if (el.offsetHeight > 0 && el.offsetWidth > 0) return true; // 有可见的其他未读标识
    }

    // 兜底量化校验：寻找带有常见未读类名的子元素
    const unreadIndicator = geekItemEl.querySelector('[class*="unread"], [class*="badge-dot"], [class*="badge-num"], .num, .dot');
    if (unreadIndicator) return true;

    return false;
  }

  /**
   * 判断联系人是否是系统/官方消息或群组
   */
  function isSystemOrGroupContact(name) {
    if (!name) return false;
    const systemKeywords = ["群组", "助手", "直聘", "官方", "系统", "通知", "群聊", "客服", "活动"];
    for (const keyword of systemKeywords) {
      if (name.includes(keyword)) {
        return true;
      }
    }
    return false;
  }

  /**
   * 启动自动扫雷轮询循环
   */
  function startAutoSweepLoop() {
    if (sweepTimer) clearTimeout(sweepTimer);

    const runSweepTick = async () => {
      if (!state.enabled) return;

      // 前台保护：当页面隐藏或最小化时暂停操作
      if (document.hidden) {
        console.log(`${LOG_PREFIX} 🛡️ 页面处于后台/最小化状态，自动扫雷暂停`);
        // 5秒后再检查一次，直到页面回到前台
        sweepTimer = setTimeout(runSweepTick, 5000);
        return;
      }

      if (isScanning) return;
      if (state.pendingReply) {
        console.log(`${LOG_PREFIX} 有正在回复的消息，跳过本次扫描`);
        const nextDelay = window.HumanSimulator 
          ? window.HumanSimulator.clampedGaussian(15000, 3000, 10000, 30000)
          : 15000;
        sweepTimer = setTimeout(runSweepTick, nextDelay);
        return;
      }

      isScanning = true;
      try {
        await sweepUnreadChats();
      } catch (err) {
        console.error(`${LOG_PREFIX} 扫雷异常:`, err);
      } finally {
        isScanning = false;
        // 定期扫雷，使用高斯随机时间增加真人感 (中心在 30 秒)
        const nextDelay = window.HumanSimulator 
          ? window.HumanSimulator.clampedGaussian(30000, 5000, 20000, 60000)
          : 30000;
        sweepTimer = setTimeout(runSweepTick, nextDelay);
      }
    };

    sweepTimer = setTimeout(runSweepTick, 5000);
  }

  /**
   * 停止自动扫雷轮询循环
   */
  function stopAutoSweepLoop() {
    if (sweepTimer) {
      clearTimeout(sweepTimer);
      sweepTimer = null;
    }
  }

  /**
   * 执行一次会话扫描和切换
   */
  async function sweepUnreadChats() {
    const chatListCandidates = window.PreflightCheck
      ? window.PreflightCheck.getSelector(MODULE_NAME, 'CHAT_LIST')
      : ['div.user-list', '.user-list', 'ul.chat-list', 'div[class*="chat-list"]', 'div[class*="session-list"]'];
    const chatListSels = typeof chatListCandidates === 'string' ? [chatListCandidates] : chatListCandidates;

    let chatList = null;
    for (const sel of chatListSels) {
      chatList = document.querySelector(sel);
      if (chatList) break;
    }
    if (!chatList) {
      console.warn(`${LOG_PREFIX} 未找到会话列表，无法自动扫描`);
      return;
    }

    const itemCandidates = window.PreflightCheck
      ? window.PreflightCheck.getSelector(MODULE_NAME, 'CHAT_LIST_ITEM')
      : ['.geek-item', 'ul.chat-list li', 'div[class*="chat-list"] li', 'div.chat-record li'];
    const itemSels = typeof itemCandidates === 'string' ? [itemCandidates] : itemCandidates;

    let items = [];
    for (const sel of itemSels) {
      const els = chatList.querySelectorAll(sel);
      if (els.length > 0) {
        items = [...els];
        break;
      }
    }

    if (items.length === 0) return;

    // 寻找第一个有红点未读消息的联系人
    let targetItem = null;
    for (const item of items) {
      const candidateName = item.querySelector('.name, .geek-name, [class*="name"]')?.textContent?.trim() || '';
      if (isSystemOrGroupContact(candidateName)) {
        continue; // 过滤群组、助手、系统官方通知等非候选人会话
      }

      if (hasUnreadMessage(item)) {
        // 过滤掉当前已经选中的联系人（当前窗口有 MutationObserver 监控，不需要切换）
        const isSelected = item.classList.contains('selected') || item.classList.contains('active') || (item.className && item.className.includes('selected'));
        if (!isSelected) {
          targetItem = item;
          break;
        }
      }
    }

    if (!targetItem) return;

    const candidateName = targetItem.querySelector('.name, .geek-name, [class*="name"]')?.textContent?.trim() || '未知候选人';
    console.log(`${LOG_PREFIX} 🎯 发现未读消息联系人: ${candidateName}，准备自动切换...`);

    const sim = window.HumanSimulator;

    // 1. 模拟鼠标 hover 动作（mouseenter / mouseover）
    targetItem.dispatchEvent(new MouseEvent('mouseenter', { bubbles: true }));
    targetItem.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
    
    // 延迟 1~3 秒模拟人类悬停与看列表的过程
    await sim.sleep(sim.clampedGaussian(2000, 500, 1000, 4000));

    // 2. 模拟鼠标点击
    targetItem.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
    targetItem.click();
    targetItem.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
    
    console.log(`${LOG_PREFIX} 已模拟点击切换到: ${candidateName}`);

    // 3. 等待聊天窗口及右侧岗位信息稳定加载
    await sim.sleep(sim.clampedGaussian(3000, 500, 2000, 5000));

    // 更新当前正在聊天的 uid，确保状态正确
    const activeChatId = targetItem.getAttribute('data-id') ||
                         targetItem.getAttribute('data-uid') ||
                         candidateName;
    state.currentChatId = activeChatId;

    // 主动上报候选人画像
    tryReportCandidateProfile();

    // 检查是否已经评估过，如果未评估则先执行自动采集并等待评分完成
    const status = await checkCandidateEvaluated(activeChatId, candidateName);
    if (!status.evaluated) {
      console.log(`${LOG_PREFIX} 扫雷切换：检测到候选人 [${candidateName}] 尚未评估，启动自动采集并等待评分完成...`);
      await handleResumeCollectionDecision();
      // 等待 4 秒让采集和背景 LLM 评估完成，避免回复策略因没有评分而做出错误的决策
      await sim.sleep(4000);
    } else {
      console.log(`${LOG_PREFIX} 扫雷切换：候选人 [${candidateName}] 已评估，直接进行后续处理。`);
      await handleResumeCollectionDecision();
    }

    // 4. 切过去后，主动提取最后一条消息，触发智能回复流程
    await checkAndReplyLastVisibleMessage();
  }

  /**
   * 主动检查并回复聊天窗口中的最后一条可视消息
   */
  async function checkAndReplyLastVisibleMessage() {
    if (!state.enabled || state.pendingReply) return;

    // 获取当前聊天列表的所有消息
    const messages = window.ChatInteractor.getVisibleMessages();
    if (messages.length === 0) return;

    // 拿到最后一条消息
    const lastMsg = messages[messages.length - 1];
    if (lastMsg.isSelf) {
      console.log(`${LOG_PREFIX} 最后一条消息是我发送的，无需回复`);
      return;
    }

    // 去重校验
    const fingerprint = getMessageFingerprint(lastMsg.text, Date.now());
    if (state.processedMessages.has(fingerprint)) {
      console.log(`${LOG_PREFIX} 最后一条消息已处理过，跳过`);
      return;
    }
    state.processedMessages.add(fingerprint);

    console.log(`${LOG_PREFIX} 主动发现未读最新消息: "${lastMsg.text.substring(0, 30)}..."`);
    state.stats.messagesReceived++;

    // 发送给后端处理回复
    await requestReply(lastMsg.text);
  }

  // ============================================================
  // 初始化
  // ============================================================

  async function init() {
    console.log(`${LOG_PREFIX} v${VERSION} 已加载`);

    // ★ Preflight Check — 校准 DOM 选择器
    if (window.PreflightCheck) {
      state.preflightResult = await window.PreflightCheck.run(MODULE_NAME);
      if (!state.preflightResult.passed) {
        console.error(`${LOG_PREFIX} ❌ DOM 列表校准失败，聊天监听可能受影响`);
      } else {
        console.log(`${LOG_PREFIX} ✅ DOM 列表校准通过${state.preflightResult.fromCache ? ' (缓存)' : ''}`);
      }
    }

    // 从 storage 读取上次的开关状态
    const stored = await chrome.storage.local.get(['copilotEnabled']);
    state.enabled = stored.copilotEnabled || false;

    // 始终初始化 DOM 监控器，以支持画像、在线简历采集与小胶囊交互功能
    state.stats.startTime = Date.now();
    setupObserver();

    // 如果页面上已经有对话框渲染，则同时初始化对话框部分的校准与采集决策
    const conversationBox = document.querySelector('div.chat-conversation, div.chat-record, [class*="chat-message-list"]');
    if (conversationBox) {
      await calibrateConversation();
    }

    if (state.enabled) {
      startAutoSweepLoop();
      console.log(`${LOG_PREFIX} 自动回复已启用（上次状态恢复）`);
    } else {
      console.log(`${LOG_PREFIX} 自动回复未启用，仅开启微简历画像及在线简历采集`);
    }

    // 检查并发送待处理的跟进消息
    setTimeout(() => checkPendingFollowups(), 5000);
  }

  // 页面前台/后台隐藏监听 (Visibility Guard)
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) {
      console.warn(`${LOG_PREFIX} 🛡️ 检测到 Boss 直聘窗口已置于后台/最小化。为防封号，已暂停自动扫雷循环。`);
      stopAutoSweepLoop();
    } else {
      console.log(`${LOG_PREFIX} 🔄 检测到 Boss 直聘窗口已回到前台。即将恢复自动扫雷循环。`);
      if (state.enabled) {
        startAutoSweepLoop();
      }
    }
  });

  // 等页面稳定后再初始化
  if (document.readyState === 'complete') {
    setTimeout(init, 2000);
  } else {
    window.addEventListener('load', () => setTimeout(init, 2000));
  }
})();

