/**
 * recommend-greeter.js
 * Boss直聘"推荐牛人"页面 — 智能选人 + 半自动打招呼
 *
 * 运行在: https://www.zhipin.com/web/chat/recommend*
 *
 * 核心功能：
 * 1. 抓取推荐牛人候选人卡片信息
 * 2. 发送给后端 LLM 评分
 * 3. 在页面注入审核面板，展示排序结果
 * 4. 用户确认后，模拟点击"打招呼"按钮
 *
 * 依赖：human-simulator.js（必须先加载）
 */

(() => {
  'use strict';

  const LOG_PREFIX = '[HireCopilot:Greeter]';
  const VERSION = '0.1.0';

  // ============================================================
  // DOM 选择器 — 需要在实际页面调试确认
  // ============================================================
  const SELECTORS = {
    // 候选人卡片列表容器
    CARD_CONTAINER: [
      'ul.card-list',
      'div.list-wrap.card-list-wrap',
      'div.recommend-list-wrap',
      'div.recommend-card-list',
      'div[class*="recommend"] ul',
      'div[class*="card-list"]',
      'div.recommend-main',
      'div[class*="recommend-list"]',
      '.recommend-content',
    ],

    // 单个候选人卡片
    CARD_ITEM: [
      'li.card-item',
      'div.candidate-card-wrap',
      'div.recommend-card-item',
      'div[class*="card-item"]',
      'li[class*="card"]',
      'div[class*="candidate-card"]',
      'div.card-inner',
    ],

    // 卡片内的字段选择器
    CARD_NAME: [
      'span.name', '.name-text', '[class*="name"]',
    ],
    CARD_ONLINE: [
      'span.status', '.active-tag', '[class*="active-status"]', '[class*="online"]',
    ],
    CARD_BASE_INFO: [
      '.base-info', '.info-text', 'span[class*="info"]',
    ],
    CARD_SALARY: [
      '.expect-salary', '.salary-tag', 'span[class*="salary"]',
      'span[class*="expect"]', '.tag-salary',
    ],
    CARD_EXPECT: [
      '.expect-position', '.expect-info', '[class*="expect"]',
    ],
    CARD_ADVANTAGE: [
      '.advantage-text', '.desc-text', '[class*="advantage"]',
      '[class*="优势"]',
    ],
    CARD_TAGS: [
      '.tag-list span', '.skill-tags span', '.tag-item',
      '[class*="tag"] span', '[class*="skill"] span',
    ],
    CARD_EXPERIENCE: [
      '.work-history', '.experience-list', '[class*="history"]',
      '[class*="experience"]',
    ],
    GREET_BUTTON: [
      'button.btn-greet',
      'button.greet-btn',
      'a.greet-btn',
      '.btn-greet',
      'button[class*="greet"]',
      'a[class*="greet"]',
      'span[class*="greet"]',
    ],
  };

  // ============================================================
  // 状态管理
  // ============================================================
  const state = {
    phase: 'idle',  // idle → scanning → evaluating → reviewing → greeting → done
    scannedCandidates: [],    // 抓取到的候选人
    rankedCandidates: [],     // 后端返回的评分结果
    filteredCandidates: [],   // 后端返回的被过滤候选人
    approvedCandidates: [],   // 用户确认的候选人
    greetingQueue: [],        // 待执行的打招呼队列
    currentGreetingIndex: 0,
    stats: {
      scanned: 0,
      evaluated: 0,
      approved: 0,
      greeted: 0,
      errors: 0,
    },
    quota: { used: 0, limit: 20, remaining: 20 },
    panelElement: null,       // 审核面板 DOM 引用
    panelDismissed: false,
  };

  // ============================================================
  // 候选人卡片抓取
  // ============================================================

  /**
   * 尝试多个选择器找到元素
   */
  function findElement(selectorList, parent = document) {
    for (const sel of selectorList) {
      try {
        const el = parent.querySelector(sel);
        if (el) return el;
      } catch { /* 选择器无效 */ }
    }

    // 如果未找到，且 parent 是在主文档中，尝试穿透进入同源的 iframe 查找
    const parentDoc = parent.ownerDocument || parent;
    if (parentDoc === document) {
      const iframes = document.querySelectorAll('iframe');
      for (const iframe of iframes) {
        try {
          const innerDoc = iframe.contentDocument || iframe.contentWindow.document;
          if (innerDoc) {
            const el = findElement(selectorList, innerDoc);
            if (el) return el;
          }
        } catch (e) {
          // 跨域 iframe，跳过
        }
      }
    }
    return null;
  }

  /**
   * 尝试多个选择器找到所有匹配元素
   */
  function findAllElements(selectorList, parent = document) {
    for (const sel of selectorList) {
      try {
        const els = parent.querySelectorAll(sel);
        if (els.length > 0) return [...els];
      } catch { /* 选择器无效 */ }
    }

    // 如果未找到，且 parent 是在主文档中，尝试穿透进入同源的 iframe 查找
    const parentDoc = parent.ownerDocument || parent;
    if (parentDoc === document) {
      const iframes = document.querySelectorAll('iframe');
      for (const iframe of iframes) {
        try {
          const innerDoc = iframe.contentDocument || iframe.contentWindow.document;
          if (innerDoc) {
            const els = findAllElements(selectorList, innerDoc);
            if (els.length > 0) return els;
          }
        } catch (e) {
          // 跨域 iframe，跳过
        }
      }
    }
    return [];
  }

  /**
   * 获取元素的文本内容
   */
  function getText(selectorList, parent = document) {
    const el = findElement(selectorList, parent);
    return el?.textContent?.trim() || '';
  }

  /**
   * 从一个候选人卡片 DOM 中提取信息
   */
  function parseCardElement(cardEl) {
    // 姓名
    const name = getText(SELECTORS.CARD_NAME, cardEl);

    // 在线状态
    const onlineStatus = getText(SELECTORS.CARD_ONLINE, cardEl);

    // 基本信息行 — "29岁 5年 硕士 离职-随时到岗"
    // 这通常是一组 span 或一段文本
    const baseInfoEl = findElement(SELECTORS.CARD_BASE_INFO, cardEl);
    const baseInfoText = baseInfoEl?.textContent?.trim() || '';

    // 从基本信息解析
    const ageMatch = baseInfoText.match(/(\d+)岁/);
    const expMatch = baseInfoText.match(/(\d+)年/);
    const eduMatch = baseInfoText.match(/(博士|硕士|本科|大专|中专|高中)/);
    const statusMatch = baseInfoText.match(/(离职[\-\s]?随时到岗|在职[\-\s]?考虑机会|在职[\-\s]?月内到岗|在职[\-\s]?暂不考虑)/);

    // 期望薪资
    const salary = getText(SELECTORS.CARD_SALARY, cardEl);

    // 期望职位
    const expectText = getText(SELECTORS.CARD_EXPECT, cardEl);

    // 优势描述
    const advantage = getText(SELECTORS.CARD_ADVANTAGE, cardEl);

    // 技术标签
    const tagElements = findAllElements(SELECTORS.CARD_TAGS, cardEl);
    const tags = tagElements
      .map(el => el.textContent?.trim())
      .filter(t => t && t.length > 0);

    // 工作经历（右侧区域）
    const expElements = findAllElements(SELECTORS.CARD_EXPERIENCE, cardEl);
    const workHistory = expElements
      .map(el => el.textContent?.trim())
      .filter(t => t)
      .join(' | ');

    // 打招呼按钮 (优先使用选择器查找，若未找到，则通过按钮文本内容进行兜底匹配)
    let greetBtn = findElement(SELECTORS.GREET_BUTTON, cardEl);
    if (!greetBtn) {
      const allButtons = cardEl.querySelectorAll('button, a, span[class*="btn"], div[class*="btn"]');
      for (const btn of allButtons) {
        const text = btn.textContent?.trim() || '';
        if (text === '打招呼' || text === '立即沟通' || text === '聊一聊' || text === '沟通' || text.includes('沟通') || text.includes('打招呼')) {
          if (text.length < 10) { // 限制文本长度以防止误匹配大型容器
            greetBtn = btn;
            break;
          }
        }
      }
    }

    // 生成指纹用于去重
    const fingerprint = `${name}_${salary}_${expMatch?.[1] || ''}`;

    return {
      name: name || '未知',
      age: ageMatch?.[1] || '',
      experience: expMatch?.[1] ? `${expMatch[1]}年` : '',
      education: eduMatch?.[1] || '',
      jobStatus: statusMatch?.[1] || '',
      salary: salary || '',
      title: expectText || '',
      advantage: advantage || '',
      tags,
      workHistory: workHistory || '',
      onlineStatus: onlineStatus || '',
      fingerprint,
      _cardElement: cardEl,   // 保留 DOM 引用，用于后续点击
      _greetButton: greetBtn, // 打招呼按钮引用
    };
  }

  /**
   * 扫描页面中所有可见的候选人卡片
   */
  function scanVisibleCards() {
    const container = findElement(SELECTORS.CARD_CONTAINER);
    if (!container) {
      console.warn(`${LOG_PREFIX} 未找到候选人列表容器`);
      // 降级方案：直接在整个页面查找卡片
    }

    const parent = container || document;
    const cardElements = findAllElements(SELECTORS.CARD_ITEM, parent);

    console.log(`${LOG_PREFIX} 找到 ${cardElements.length} 个候选人卡片`);

    if (cardElements.length === 0) {
      console.warn(`${LOG_PREFIX} ⚠️ 未找到候选人卡片，正在运行 DOM 诊断功能...`);
      runDOMDiagnostics();
    }

    const candidates = [];
    const seen = new Set();

    for (const cardEl of cardElements) {
      const candidate = parseCardElement(cardEl);
      if (candidate.name === '未知' && !candidate.salary) continue;
      if (seen.has(candidate.fingerprint)) continue;

      // 过滤已经打过招呼/沟通中的候选人，避免重新扫描时重复评估
      const btnText = candidate._greetButton?.textContent?.trim() || '';
      const isAlreadyGreeted = btnText.includes('继续') || 
                               btnText.includes('聊过') || 
                               btnText.includes('发消息') || 
                               btnText.includes('已') ||
                               (!btnText.includes('打招呼') && !btnText.includes('聊一聊') && !btnText.includes('沟通') && btnText.length > 0);
      if (isAlreadyGreeted) {
        console.log(`${LOG_PREFIX} 自动过滤已打招呼/已沟通的候选人: ${candidate.name} (${btnText})`);
        continue;
      }

      seen.add(candidate.fingerprint);
      candidates.push(candidate);
    }

    console.log(`${LOG_PREFIX} 解析成功: ${candidates.length} 个有效候选人`);
    return candidates;
  }

  /**
   * 诊断页面 DOM 结构，帮我们找出正确的 class 名和选择器
   */
  function runDOMDiagnostics() {
    try {
      console.group('%c[HireCopilot] 页面 DOM 诊断报告', 'color: #6c5ce7; font-weight: bold; font-size: 14px;');
      
      // 1. 查找可能包含候选人卡片的容器和列表项
      const keywords = ['recommend', 'card', 'list', 'geek', 'candidate', 'user', 'item', 'member', 'resume'];
      const matchedElements = [];
      const allElements = document.querySelectorAll('div, ul, li, section, a');
      
      allElements.forEach(el => {
        const cls = el.className;
        if (cls && typeof cls === 'string') {
          const matched = keywords.filter(kw => cls.toLowerCase().includes(kw));
          if (matched.length > 0) {
            matchedElements.push({
              tag: el.tagName.toLowerCase(),
              class: cls,
              matchedKeywords: matched.join(', '),
              text: el.textContent?.trim().substring(0, 40) || ''
            });
          }
        }
      });
      
      console.log('🔍 包含推荐/卡片/列表关键字的 DOM 元素列表 (前50个)：');
      console.table(matchedElements.slice(0, 50));

      // 2. 查找打招呼按钮
      const textToSearch = ['打招呼', '沟通', '聊一聊', '发起聊天', '问候'];
      const buttons = [];
      document.querySelectorAll('button, a, span, div').forEach(el => {
        const txt = el.textContent?.trim() || '';
        const matched = textToSearch.filter(t => txt.includes(t));
        if (matched.length > 0 && txt.length < 20) {
          buttons.push({
            tag: el.tagName.toLowerCase(),
            class: el.className || '',
            text: txt
          });
        }
      });

      console.log('👋 疑似"打招呼"或"沟通"的按钮元素：');
      console.table(buttons);

      console.groupEnd();
    } catch (err) {
      console.error('执行 DOM 诊断失败:', err);
    }
  }

  /**
   * 诊断网页 DOM 获取类名文本报告
   */
  function getDOMDiagnosticsText() {
    let report = [];
    try {
      report.push('--- HireCopilot DOM DIAGNOSTIC REPORT ---');
      report.push(`URL: ${window.location.href}`);
      report.push(`Time: ${new Date().toISOString()}`);
      report.push(`Page title: ${document.title}`);
      
      // 1. 查找可能包含候选人卡片的容器和列表项
      const keywords = ['recommend', 'card', 'list', 'geek', 'candidate', 'user', 'item', 'member', 'resume'];
      const matchedElements = [];
      const allElements = document.querySelectorAll('div, ul, li, section, a');
      
      allElements.forEach(el => {
        const cls = el.className;
        if (cls && typeof cls === 'string') {
          const matched = keywords.filter(kw => cls.toLowerCase().includes(kw));
          if (matched.length > 0) {
            matchedElements.push({
              tag: el.tagName.toLowerCase(),
              class: cls,
              matchedKeywords: matched.join(', '),
              text: el.textContent?.trim().substring(0, 30).replace(/\s+/g, ' ') || ''
            });
          }
        }
      });
      
      report.push('\n=== MATCHED CLASSES ===');
      matchedElements.slice(0, 40).forEach(item => {
        report.push(`[${item.tag}] class="${item.class}" text="${item.text}"`);
      });

      // 2. 查找打招呼按钮
      const textToSearch = ['打招呼', '沟通', '聊一聊', '发起聊天', '问候'];
      const buttons = [];
      document.querySelectorAll('button, a, span, div').forEach(el => {
        const txt = el.textContent?.trim() || '';
        const matched = textToSearch.filter(t => txt.includes(t));
        if (matched.length > 0 && txt.length < 20) {
          buttons.push({
            tag: el.tagName.toLowerCase(),
            class: el.className || '',
            text: txt
          });
        }
      });

      report.push('\n=== POTENTIAL BUTTONS ===');
      buttons.forEach(btn => {
        report.push(`[${btn.tag}] class="${btn.class}" text="${btn.text}"`);
      });

      // 3. 检测是否存在 iframe 及其来源
      const iframes = document.querySelectorAll('iframe');
      report.push(`\n=== IFRAMES FOUND: ${iframes.length} ===`);
      iframes.forEach((iframe, idx) => {
        report.push(`Iframe [${idx}]: src="${iframe.src || ''}" id="${iframe.id || ''}" class="${iframe.className || ''}"`);
        try {
          // 尝试测试是否跨域
          const innerDoc = iframe.contentDocument || iframe.contentWindow.document;
          if (innerDoc) {
            report.push(`  -> Accessible (Same-Origin). Inner HTML length: ${innerDoc.body?.innerHTML?.length || 0}`);
            
            // 1. 查找里面的卡片类元素
            const matchedInner = [];
            const keywords = ['recommend', 'card', 'list', 'geek', 'candidate', 'user', 'item', 'member', 'resume'];
            const innerElements = innerDoc.querySelectorAll('div, ul, li, section, a');
            innerElements.forEach(el => {
              const cls = el.className;
              if (cls && typeof cls === 'string') {
                const matched = keywords.filter(kw => cls.toLowerCase().includes(kw));
                if (matched.length > 0) {
                  matchedInner.push({
                    tag: el.tagName.toLowerCase(),
                    class: cls,
                    text: el.textContent?.trim().substring(0, 30).replace(/\s+/g, ' ') || ''
                  });
                }
              }
            });
            
            report.push(`  -> Matched classes inside iframe: ${matchedInner.length}`);
            matchedInner.slice(0, 30).forEach(item => {
              report.push(`     [${item.tag}] class="${item.class}" text="${item.text}"`);
            });

            // 2. 查找里面的按钮
            const textToSearch = ['打招呼', '沟通', '聊一聊', '发起聊天', '问候'];
            const innerButtons = [];
            innerDoc.querySelectorAll('button, a, span, div').forEach(el => {
              const txt = el.textContent?.trim() || '';
              const matched = textToSearch.filter(t => txt.includes(t));
              if (matched.length > 0 && txt.length < 20) {
                innerButtons.push({
                  tag: el.tagName.toLowerCase(),
                  class: el.className || '',
                  text: txt
                });
              }
            });
            
            report.push(`  -> Buttons inside iframe: ${innerButtons.length}`);
            innerButtons.slice(0, 10).forEach(btn => {
              report.push(`     [${btn.tag}] class="${btn.class}" text="${btn.text}"`);
            });

            // 3. 诊断打招呼按钮的父元素结构，以便找出候选人卡片的具体类名
            const sampleBtn = innerDoc.querySelector('button.btn-greet');
            if (sampleBtn) {
              report.push('  -> Greet button ancestors trace:');
              let curr = sampleBtn;
              for (let depth = 0; depth < 8 && curr; depth++) {
                report.push(`     Depth ${depth}: <${curr.tagName.toLowerCase()}> class="${curr.className || ''}"`);
                curr = curr.parentElement;
              }
            } else {
              report.push('  -> No button.btn-greet found to trace ancestors.');
            }
          }
        } catch (e) {
          report.push(`  -> Blocked/Cross-Origin: ${e.message}`);
        }
      });
    } catch (err) {
      report.push('Error running diagnostic: ' + err.message);
    }
    return report.join('\n');
  }

  /**
   * 将诊断信息渲染到审核面板候选人列表容器中
   */
  function showDiagnosticsInPanel() {
    const listEl = document.getElementById('crp-candidates-list');
    if (!listEl) return;

    listEl.innerHTML = `
      <div class="crp-diag-box" style="margin: 16px; padding: 12px; background: rgba(0,0,0,0.5); border-radius: 8px; border: 1px dashed rgba(255,255,255,0.15);">
        <div style="font-size: 13px; color: #ff6b6b; font-weight: bold; margin-bottom: 6px; display: flex; align-items: center; gap: 6px;">
          <span>⚠️</span> <span>未检测到候选人卡片</span>
        </div>
        <div style="font-size: 11px; color: #9493a5; margin-bottom: 10px; line-height: 1.4; font-family: system-ui, sans-serif;">
          由于 Boss 平台防调试限制，请直接点击下方按钮复制“诊断信息”，并粘贴发送给 AI 助手，以更新页面元素选择器。
        </div>
        <textarea id="crp-diag-textarea" readonly style="width: 100%; height: 120px; background: #07070b; color: #00f5c4; border: 1px solid rgba(255,255,255,0.08); font-family: monospace; font-size: 10px; padding: 6px; border-radius: 6px; resize: none; margin-bottom: 8px;"></textarea>
        <button id="crp-btn-copy-diag" style="width: 100%; background: #6366f1; color: #fff; border: none; padding: 8px; border-radius: 6px; font-size: 12px; cursor: pointer; font-weight: 500; transition: background 0.2s;">
          📋 复制诊断数据
        </button>
      </div>
    `;

    const diagText = getDOMDiagnosticsText();
    const textarea = document.getElementById('crp-diag-textarea');
    if (textarea) {
      textarea.value = diagText;
    }

    const copyBtn = document.getElementById('crp-btn-copy-diag');
    if (copyBtn && textarea) {
      copyBtn.addEventListener('click', () => {
        textarea.select();
        document.execCommand('copy');
        copyBtn.textContent = '✅ 已成功复制！';
        copyBtn.style.background = '#10b981';
        setTimeout(() => {
          copyBtn.textContent = '📋 复制诊断数据';
          copyBtn.style.background = '#6366f1';
        }, 2000);
      });
    }
  }
  /**
   * 收集页面 HTML 结构进行调试，用于针对性分析选择器
   */
  function collectPageDebugInfo() {
    const container = findElement(SELECTORS.CARD_CONTAINER);
    const cardElements = findAllElements(SELECTORS.CARD_ITEM, container || document);
    
    // 搜寻页面上所有可能的可见弹窗 HTML
    const docs = [document];
    if (window.parent && window.parent.document && window.parent.document !== document) {
      docs.push(window.parent.document);
    }
    const containerDoc = container ? container.ownerDocument : null;
    if (containerDoc && !docs.includes(containerDoc)) {
      docs.push(containerDoc);
    }

    const activeDialogs = [];
    for (const docObj of docs) {
      try {
        const dialogEls = docObj.querySelectorAll('div[class*="dialog"], div[class*="modal"], div[class*="popover"], div.dialog-wrap, div[class*="popup"], [class*="recommend-filter-guide"], [class*="dialog"]');
        for (const el of dialogEls) {
          const rect = el.getBoundingClientRect();
          if (rect.width > 0 && rect.height > 0) {
            activeDialogs.push({
              class: el.className,
              html: el.outerHTML.slice(0, 10000)
            });
          }
        }
      } catch (e) {}
    }

    const info = {
      url: window.location.href,
      cardsCount: cardElements.length,
      firstCardHtml: cardElements[0] ? cardElements[0].outerHTML.slice(0, 8000) : '未找到任何候选人卡片',
      parentContainerHtml: container ? container.outerHTML.slice(0, 5000) : '未找到候选人容器',
      activeDialogs: activeDialogs,
      diagnosticsText: getDOMDiagnosticsText()
    };

    return info;
  }

  /**
   * 填充并展示调试信息容器
   */
  function showPageDebugInfo() {
    try {
      const debugInfo = collectPageDebugInfo();
      const debugText = JSON.stringify(debugInfo, null, 2);
      const debugTextarea = document.getElementById('copilot-debug-text');
      const debugContainer = document.getElementById('copilot-debug-container');
      
      if (debugTextarea && debugContainer) {
        debugTextarea.value = debugText;
        debugContainer.style.display = 'block';
        
        document.getElementById('copilot-btn-copy-debug').onclick = async () => {
          const btn = document.getElementById('copilot-btn-copy-debug');
          // 重新实时抓取最新的页面 DOM 状态以捕获新出现的弹窗！
          const latestInfo = collectPageDebugInfo();
          const latestText = JSON.stringify(latestInfo, null, 2);
          if (debugTextarea) {
            debugTextarea.value = latestText;
          }

          try {
            await navigator.clipboard.writeText(latestText);
            btn.textContent = '✅ 已成功复制调试数据！';
            btn.style.background = '#10b981';
            setTimeout(() => {
              btn.textContent = '📋 复制页面 HTML 信息 (发给 AI 修复)';
              btn.style.background = '#6366f1';
            }, 2000);
          } catch (err) {
            // 备选复制
            if (debugTextarea) {
              debugTextarea.select();
            }
            document.execCommand('copy');
            btn.textContent = '✅ 已成功复制调试数据！';
            btn.style.background = '#10b981';
            setTimeout(() => {
              btn.textContent = '📋 复制页面 HTML 信息 (发给 AI 修复)';
              btn.style.background = '#6366f1';
            }, 2000);
          }
        };
      }
    } catch (e) {
      console.error('填充调试信息失败:', e);
    }
  }
  /**
   * 滚动加载更多候选人
   */
  async function scrollAndScrape(maxCount = 40) {
    const sim = window.HumanSimulator;
    const allCandidates = new Map(); // fingerprint → candidate

    // 先扫描当前可见的
    const initial = scanVisibleCards();
    initial.forEach(c => allCandidates.set(c.fingerprint, c));

    // 滚动加载更多
    const scrollContainer = findElement(SELECTORS.CARD_CONTAINER) ||
                            document.querySelector('.main-content') ||
                            document.documentElement;

    let noNewCount = 0;
    const maxScrolls = 10;

    for (let i = 0; i < maxScrolls && allCandidates.size < maxCount; i++) {
      const prevSize = allCandidates.size;

      // 滚动
      scrollContainer.scrollBy({
        top: 600,
        behavior: 'smooth',
      });

      // 如果卡片在同源 iframe 里，也对 iframe 内的滚动容器和 window 进行滚动，以触发加载
      const iframes = document.querySelectorAll('iframe');
      for (const iframe of iframes) {
        try {
          const innerWin = iframe.contentWindow;
          const innerDoc = iframe.contentDocument || innerWin.document;
          if (innerDoc) {
            const innerScrollContainer = innerDoc.querySelector('div.list-wrap.card-list-wrap, div.recommend-list-wrap, .list-body') || innerDoc.documentElement;
            innerScrollContainer.scrollBy({
              top: 600,
              behavior: 'smooth',
            });
            innerWin.scrollBy({
              top: 600,
              behavior: 'smooth',
            });
          }
        } catch (e) {
          // 跨域 iframe 跳过
        }
      }

      // 等待加载
      await sim.sleep(sim.clampedGaussian(1500, 500, 800, 3000));

      // 扫描新卡片
      const newCards = scanVisibleCards();
      newCards.forEach(c => {
        if (!allCandidates.has(c.fingerprint)) {
          allCandidates.set(c.fingerprint, c);
        }
      });

      if (allCandidates.size === prevSize) {
        noNewCount++;
        if (noNewCount >= 3) {
          console.log(`${LOG_PREFIX} 连续 3 次没有新候选人，停止滚动`);
          break;
        }
      } else {
        noNewCount = 0;
      }

      console.log(`${LOG_PREFIX} 滚动 ${i + 1}/${maxScrolls}, 已收集 ${allCandidates.size} 人`);
    }

    // 严格限制返回的候选人数量不超过 maxCount，防止页面预加载了过多卡片导致评估超时
    return [...allCandidates.values()].slice(0, maxCount);
  }

  // ============================================================
  // 与后端通信
  // ============================================================

  /**
   * 发送消息给 Background Service Worker 并等待响应
   */
  function sendToBackground(message) {
    return new Promise((resolve, reject) => {
      chrome.runtime.sendMessage(message, (response) => {
        if (chrome.runtime.lastError) {
          reject(new Error(chrome.runtime.lastError.message));
        } else {
          resolve(response);
        }
      });
    });
  }

  /**
   * 从推荐牛人页面（主页面或 iframe 内）提取当前活跃的岗位标题
   */
  function scrapeActiveJobOnRecommendPage() {
    const selectors = [
      '.job-select-box .cur-name',
      '.job-select-box .cur-value',
      '.job-select .cur-name',
      '.job-select .cur-value',
      '.job-select .dropdown-select-title',
      '.job-select .dropdown-select-val',
      '.job-selector .cur-name',
      '.job-selector .cur-value',
      '.job-selector-box .job-name',
      '.dropdown-select-title',
      '.dropdown-select-val',
      '.select-target',
      'div[class*="job-select"]',
      'div[class*="dropdown-select"]',
      'div[class*="select-job"]',
    ];

    const checkElementText = (el) => {
      if (!el) return null;
      const txt = el.textContent?.trim();
      if (txt && txt.length > 2 && txt.length < 80 && !txt.includes('打招呼') && !txt.includes('推荐') && !txt.includes('最新')) {
        return txt;
      }
      return null;
    };

    // 1. 在主页面中查找
    for (const sel of selectors) {
      const els = document.querySelectorAll(sel);
      for (const el of els) {
        const txt = checkElementText(el);
        if (txt) return txt;
      }
    }

    // 2. 穿透到 iframe 中查找
    const iframes = document.querySelectorAll('iframe');
    for (const iframe of iframes) {
      try {
        const innerDoc = iframe.contentDocument || iframe.contentWindow.document;
        if (innerDoc) {
          for (const sel of selectors) {
            const els = innerDoc.querySelectorAll(sel);
            for (const el of els) {
              const txt = checkElementText(el);
              if (txt) return txt;
            }
          }
        }
      } catch (e) {
        // 跨域 iframe 忽略
      }
    }
    return null;
  }

  /**
   * 请求后端评估候选人
   */
  async function requestEvaluation(candidates) {
    const jobTitle = scrapeActiveJobOnRecommendPage();
    console.log(`${LOG_PREFIX} 自动提取当前活跃岗位: ${jobTitle}`);

    // 清理 DOM 引用（不能序列化）
    const cleanCandidates = candidates.map(c => ({
      name: c.name,
      age: c.age,
      experience: c.experience,
      education: c.education,
      jobStatus: c.jobStatus,
      salary: c.salary,
      title: c.title,
      advantage: c.advantage,
      tags: c.tags,
      workHistory: c.workHistory,
      onlineStatus: c.onlineStatus,
    }));

    const response = await sendToBackground({
      type: 'EVALUATE_CANDIDATES',
      payload: { 
        candidates: cleanCandidates,
        jobTitle: jobTitle,
      },
    });

    return response;
  }

  // ============================================================
  // 审核面板 UI
  // ============================================================

  /**
   * 创建并注入审核面板
   */
  function createReviewPanel() {
    // 移除旧面板
    const old = document.getElementById('copilot-review-panel');
    if (old) old.remove();

    const panel = document.createElement('div');
    panel.id = 'copilot-review-panel';
    panel.innerHTML = `
      <div class="crp-header">
        <div class="crp-title">
          <span class="crp-icon">🤖</span>
          <span>Copilot 智能推荐</span>
        </div>
        <div class="crp-quota">
          剩余配额: <span id="crp-quota-num">${state.quota.remaining}</span>/${state.quota.limit}
        </div>
        <button class="crp-close" id="crp-close-btn">✕</button>
      </div>

      <div class="crp-status" id="crp-status">
        <div class="crp-spinner"></div>
        <span>准备就绪</span>
      </div>

      <div class="crp-tip-banner" style="font-size: 11px; color: #a29bfe; padding: 6px 12px; background: rgba(162, 155, 254, 0.08); border-bottom: 1px dashed rgba(255,255,255,0.06); text-align: center; line-height: 1.4;">
        💡 建议先在页面右上角设置好岗位和城市筛选条件再扫描
      </div>

      <div class="crp-candidates" id="crp-candidates-list">
        <!-- 候选人卡片将在这里动态生成 -->
      </div>

      <div id="copilot-debug-container" style="margin: 10px 16px; display: none; text-align: left;">
        <button class="crp-btn" id="copilot-btn-copy-debug" style="width: 100%; margin-bottom: 8px; background: #6366f1; color: white; padding: 6px; font-size: 11px; border-radius: 4px; border: none; cursor: pointer;">
          📋 复制页面 HTML 信息 (发给 AI 修复)
        </button>
        <textarea id="copilot-debug-text" style="width: 100%; height: 100px; background: #111827; color: #9ca3af; border: 1px solid #374151; border-radius: 6px; padding: 6px; font-size: 9px; font-family: monospace; resize: none;" readonly></textarea>
      </div>

      <div class="crp-footer" id="crp-footer">
        <div class="crp-selected-count">
          已选 <span id="crp-selected-num">0</span> 人
        </div>
        <div class="crp-actions">
          <button class="crp-btn crp-btn-scan" id="crp-scan-btn">🔍 扫描候选人</button>
          <button class="crp-btn crp-btn-greet" id="crp-greet-btn" disabled>👋 开始打招呼</button>
        </div>
      </div>
    `;

    document.body.appendChild(panel);
    state.panelElement = panel;

    // 绑定事件
    document.getElementById('crp-close-btn').addEventListener('click', () => {
      panel.style.display = 'none';
      state.panelDismissed = true;
    });

    document.getElementById('crp-scan-btn').addEventListener('click', startScanFlow);
    document.getElementById('crp-greet-btn').addEventListener('click', startGreetingFlow);

    return panel;
  }

  /**
   * 更新面板状态文本
   */
  function updatePanelStatus(text, showSpinner = false) {
    const statusEl = document.getElementById('crp-status');
    if (!statusEl) return;

    const spinner = statusEl.querySelector('.crp-spinner');
    const span = statusEl.querySelector('span');

    if (spinner) spinner.style.display = showSpinner ? 'inline-block' : 'none';
    if (span) span.textContent = text;
  }

  /**
   * 渲染候选人列表到面板
   */
  function renderCandidateList() {
    const listEl = document.getElementById('crp-candidates-list');
    if (!listEl) return;

    if (state.rankedCandidates.length === 0 && state.filteredCandidates.length === 0) {
      listEl.innerHTML = '<div class="crp-empty">没有找到合适的候选人</div>';
      return;
    }

    let html = '';

    // 1. 渲染合格推荐的候选人
    if (state.rankedCandidates.length === 0) {
      html += '<div class="crp-empty" style="padding: 20px 10px; font-size: 13px; color: #8888a8; text-align: center;">没有达标的候选人 (评分 >= 6.5)</div>';
    } else {
      html += state.rankedCandidates.map((c, i) => {
        const score = c.matchScore?.toFixed(1) || '?';
        const scoreClass = c.matchScore >= 8 ? 'high' : c.matchScore >= 6.5 ? 'mid' : 'low';
        const tags = (c.tags || []).slice(0, 4).join(' · ');

        return `
          <label class="crp-card" data-index="${i}">
            <input type="checkbox" class="crp-checkbox" data-index="${i}" checked>
            <div class="crp-card-content">
              <div class="crp-card-header">
                <span class="crp-card-name">${c.name || '未知'}</span>
                <span class="crp-card-score ${scoreClass}">⭐${score}</span>
                <span class="crp-card-status">${c.jobStatus || ''}</span>
              </div>
              <div class="crp-card-info">
                ${c.experience || ''} · ${c.education || ''} · ${c.salary || ''}
              </div>
              <div class="crp-card-reason">${c.matchReason || ''}</div>
              ${tags ? `<div class="crp-card-tags">${tags}</div>` : ''}
              <div class="crp-card-followup">
                <span class="crp-followup-label">跟进语:</span>
                <span class="crp-followup-text">"${c.followupText || ''}"</span>
              </div>
            </div>
          </label>
        `;
      }).join('');
    }

    // 2. 渲染已过滤的候选人（折叠区）
    if (state.filteredCandidates && state.filteredCandidates.length > 0) {
      const filteredHtml = state.filteredCandidates.map((c) => {
        const score = c.matchScore?.toFixed(1) || '?';
        return `
          <div class="crp-card crp-card-filtered" style="opacity: 0.65; border: 1px dashed rgba(255, 255, 255, 0.1); cursor: default; margin-bottom: 6px; padding: 10px 12px; background: rgba(255,255,255,0.01);">
            <div class="crp-card-content" style="width: 100%;">
              <div class="crp-card-header" style="display: flex; align-items: center; justify-content: space-between;">
                <span class="crp-card-name" style="color: #a8a8c8;">${c.name || '未知'}</span>
                <span class="crp-card-score low" style="font-size: 11px; background: rgba(255, 107, 107, 0.12); color: #ff6b6b; padding: 1px 6px; border-radius: 8px;">⭐${score}</span>
              </div>
              <div class="crp-card-info" style="font-size: 11px; color: #686888; margin: 3px 0;">
                ${c.experience || ''} · ${c.education || ''} · ${c.salary || ''}
              </div>
              <div class="crp-card-reason" style="font-size: 11px; color: #ff7675; line-height: 1.3;">
                🚫 过滤原因: ${c.matchReason || '未满足匹配门槛'}
              </div>
            </div>
          </div>
        `;
      }).join('');

      html += `
        <details class="crp-filtered-container" style="margin-top: 15px; border-top: 1px solid rgba(255,255,255,0.08); padding-top: 10px;" open>
          <summary class="crp-filtered-summary" style="cursor: pointer; font-size: 12px; color: #8888a8; padding: 6px 0; display: flex; justify-content: space-between; align-items: center; user-select: none; outline: none;">
            <span style="font-weight: 600;">⬇️ 已过滤的候选人 (${state.filteredCandidates.length} 人)</span>
            <span style="font-size: 10px; background: rgba(255, 255, 255, 0.06); padding: 2px 6px; border-radius: 4px; color: #a8a8c8;">点击收起/展开</span>
          </summary>
          <div class="crp-filtered-list" style="margin-top: 8px; max-height: 200px; overflow-y: auto; padding-right: 4px;">
            ${filteredHtml}
          </div>
        </details>
      `;
    }

    listEl.innerHTML = html;

    // 绑定 checkbox 事件
    listEl.querySelectorAll('.crp-checkbox').forEach(cb => {
      cb.addEventListener('change', updateSelectedCount);
    });

    updateSelectedCount();

    // 启用打招呼按钮
    const greetBtn = document.getElementById('crp-greet-btn');
    if (greetBtn) {
      greetBtn.disabled = state.rankedCandidates.length === 0;
    }
  }

  /**
   * 更新已选人数
   */
  function updateSelectedCount() {
    const checkboxes = document.querySelectorAll('.crp-checkbox:checked');
    const countEl = document.getElementById('crp-selected-num');
    if (countEl) countEl.textContent = checkboxes.length;
  }

  /**
   * 获取用户选中的候选人
   */
  function getSelectedCandidates() {
    const checkboxes = document.querySelectorAll('.crp-checkbox:checked');
    const indices = [...checkboxes].map(cb => parseInt(cb.dataset.index));
    return indices.map(i => state.rankedCandidates[i]).filter(Boolean);
  }

  // ============================================================
  // 核心流程
  // ============================================================

  /**
   * Step 1: 扫描 → 评估
   */
  async function startScanFlow() {
    if (state.phase !== 'idle' && state.phase !== 'done') {
      console.warn(`${LOG_PREFIX} 当前状态 ${state.phase}，无法开始扫描`);
      return;
    }

    state.phase = 'scanning';
    updatePanelStatus('正在扫描候选人...', true);

    const scanBtn = document.getElementById('crp-scan-btn');
    if (scanBtn) {
      scanBtn.disabled = true;
      scanBtn.textContent = '⏳ 扫描中...';
    }

    try {
      // 扫描页面，一次仅扫描 3 人（等于一个评估批次），显著提升响应速度避免超时
      const candidates = await scrollAndScrape(3);
      state.scannedCandidates = candidates;
      state.stats.scanned = candidates.length;

      console.log(`${LOG_PREFIX} 扫描完成: ${candidates.length} 个候选人`);
      updatePanelStatus(`已扫描 ${candidates.length} 人，正在评估...`, true);

      if (candidates.length === 0) {
        updatePanelStatus('未找到候选人，已生成诊断数据');
        showDiagnosticsInPanel();
        state.phase = 'idle';
        if (scanBtn) {
          scanBtn.disabled = false;
          scanBtn.textContent = '🔍 重新扫描';
        }
        return;
      }

      // 发送给后端评估
      state.phase = 'evaluating';
      const result = await requestEvaluation(candidates);

      if (result?.error) {
        updatePanelStatus(`评估失败: ${result.error}`);
        state.phase = 'idle';
        if (scanBtn) {
          scanBtn.disabled = false;
          scanBtn.textContent = '🔍 重新扫描';
        }
        return;
      }

      // 保存评估结果
      state.rankedCandidates = result.ranked || [];
      state.filteredCandidates = result.filtered || [];
      state.quota = result.quota || state.quota;
      state.stats.evaluated = state.rankedCandidates.length;

      // 更新配额显示
      const quotaEl = document.getElementById('crp-quota-num');
      if (quotaEl) quotaEl.textContent = state.quota.remaining;

      // 渲染候选人列表
      state.phase = 'reviewing';
      updatePanelStatus(
        `推荐 ${state.rankedCandidates.length} 人（过滤 ${result.filtered_count || 0} 人）`,
        false
      );
      renderCandidateList();

    } catch (err) {
      console.error(`${LOG_PREFIX} 扫描评估失败:`, err);
      updatePanelStatus(`出错: ${err.message}`);
      state.stats.errors++;
      state.phase = 'idle';
    }

    if (scanBtn) {
      scanBtn.disabled = false;
      scanBtn.textContent = '🔍 重新扫描';
    }

    // 渲染并填充页面 HTML 调试收集器信息
    showPageDebugInfo();
  }

  /**
   * Step 2: 用户确认 → 执行打招呼
   */
  async function startGreetingFlow() {
    if (state.phase !== 'reviewing') {
      console.warn(`${LOG_PREFIX} 当前状态 ${state.phase}，无法开始打招呼`);
      return;
    }

    const selected = getSelectedCandidates();
    if (selected.length === 0) {
      updatePanelStatus('请至少选择一个候选人');
      return;
    }

    // 检查配额
    if (selected.length > state.quota.remaining) {
      updatePanelStatus(`选择了 ${selected.length} 人，但剩余配额只有 ${state.quota.remaining}`);
      return;
    }

    state.phase = 'greeting';
    state.approvedCandidates = selected;
    state.greetingQueue = [...selected];
    state.currentGreetingIndex = 0;

    const greetBtn = document.getElementById('crp-greet-btn');
    if (greetBtn) {
      greetBtn.disabled = true;
      greetBtn.textContent = '⏳ 打招呼中...';
    }

    // 先通知后端批准这些候选人
    const greetingIds = selected
      .map(c => c.greetingId)
      .filter(Boolean);

    if (greetingIds.length > 0) {
      try {
        await sendToBackground({
          type: 'APPROVE_GREETINGS',
          payload: { greetingIds },
        });
      } catch (err) {
        console.error(`${LOG_PREFIX} 批准请求失败:`, err);
      }
    }

    // 逐个执行打招呼
    await executeGreetings();
  }

  /**
   * 逐个执行打招呼
   */
  async function executeGreetings() {
    const sim = window.HumanSimulator;

    for (let i = 0; i < state.greetingQueue.length; i++) {
      const candidate = state.greetingQueue[i];
      state.currentGreetingIndex = i;

      updatePanelStatus(
        `正在打招呼 ${i + 1}/${state.greetingQueue.length}: ${candidate.name}`,
        true
      );

      try {
        // 找到对应的卡片和按钮
        const cardIndex = state.scannedCandidates.findIndex(
          c => c.fingerprint === candidate.fingerprint
        );

        let greetBtn = null;
        if (cardIndex >= 0) {
          const cardEl = state.scannedCandidates[cardIndex]._cardElement;
          greetBtn = state.scannedCandidates[cardIndex]._greetButton;

          // 滚动到卡片可见位置
          if (cardEl) {
            cardEl.scrollIntoView({ behavior: 'smooth', block: 'center' });
            await sim.sleep(sim.clampedGaussian(1000, 300, 500, 2000));
          }
        }

        if (!greetBtn) {
          // 降级：尝试在页面中找到这个候选人的打招呼按钮
          console.warn(`${LOG_PREFIX} 未找到 ${candidate.name} 的打招呼按钮，跳过`);
          state.stats.errors++;
          continue;
        }

        // 检查按钮是否可点击及是否已经打过招呼
        const btnText = greetBtn.textContent?.trim() || '';
        const isAlreadyGreeted = btnText.includes('继续') || 
                                 btnText.includes('聊过') || 
                                 btnText.includes('发消息') || 
                                 btnText.includes('已') ||
                                 (!btnText.includes('打招呼') && !btnText.includes('聊一聊') && !btnText.includes('沟通') && btnText.length > 0);
        if (greetBtn.disabled || greetBtn.classList.contains('disabled') || isAlreadyGreeted) {
          console.warn(`${LOG_PREFIX} ${candidate.name} 的打招呼按钮不可用或已沟通，跳过 (文案: ${btnText})`);
          continue;
        }

        // 点击打招呼按钮
        greetBtn.click();
        console.log(`${LOG_PREFIX} ✅ 已点击 ${candidate.name} 的打招呼按钮`);
        
        // 拟人化：等待弹窗渲染（0.8s - 1.5s）并自动确认职位关联或打招呼确认弹窗
        await sim.sleep(sim.clampedGaussian(1000, 200, 800, 1500));
        
        // 收集所有可能的 document 对象（主文档、iframe 内部文档、以及 parent 文档）
        const docs = [document];
        if (window.parent && window.parent.document && window.parent.document !== document) {
          docs.push(window.parent.document);
        }
        if (greetBtn.ownerDocument && !docs.includes(greetBtn.ownerDocument)) {
          docs.push(greetBtn.ownerDocument);
        }

        let dialogs = [];
        for (const docObj of docs) {
          try {
            const found = docObj.querySelectorAll('div[class*="dialog"], div[class*="modal"], div[class*="popover"], div.dialog-wrap, div[class*="popup"], [class*="recommend-filter-guide"]');
            dialogs = dialogs.concat([...found]);
          } catch (e) {
            // 忽略由于跨域策略可能导致的错误
          }
        }

        let dialogClicked = false;
        for (const dialog of dialogs) {
          const rect = dialog.getBoundingClientRect();
          // 只检查在屏幕上渲染可见的弹窗
          if (rect.width > 0 && rect.height > 0) {
            console.log(`${LOG_PREFIX} 检测到可见确认弹窗，尝试自动点击“确定/发送”按钮...`);
            
            // 查找弹窗内的所有交互按钮 (放宽元素标签和类名匹配，以防混淆类名)
            const buttons = dialog.querySelectorAll('button, a, span, div, [class*="btn"], [class*="button"], [role="button"]');
            for (const btn of buttons) {
              const text = btn.textContent?.trim() || '';
              if (text === '确定' || text === '确认' || text === '发送' || text === '同意' || 
                  text === '立即沟通' || text === '确认发送' ||
                  text.includes('确定') || text.includes('确认') || text.includes('发送')) {
                btn.click();
                console.log(`${LOG_PREFIX} ✅ 已自动确认弹窗: "${text}"`);
                dialogClicked = true;
                break;
              }
            }
            if (dialogClicked) {
              // 确认后给弹窗一点点关闭动画的缓冲时间
              await sim.sleep(500);
              break;
            }
          }
        }
        
        state.stats.greeted++;

        // 通知后端记录
        if (candidate.greetingId) {
          try {
            await sendToBackground({
              type: 'GREETING_SENT',
              payload: { greetingId: candidate.greetingId },
            });
          } catch (err) {
            console.error(`${LOG_PREFIX} 通知后端失败:`, err);
          }
        }

        // 保存跟进消息到 storage（聊天页面会读取并发送）
        if (candidate.followupText) {
          await saveFollowupToStorage(candidate);
        }

        // 更新配额
        state.quota.used++;
        state.quota.remaining = Math.max(0, state.quota.remaining - 1);
        const quotaEl = document.getElementById('crp-quota-num');
        if (quotaEl) quotaEl.textContent = state.quota.remaining;

        // 检查是否达到每日上限
        if (state.quota.remaining <= 0) {
          console.log(`${LOG_PREFIX} 已达每日上限，停止打招呼`);
          updatePanelStatus('已达每日 20 次上限，明天继续 ✋');
          break;
        }

        // 等待间隔（2-5 分钟）— 如果不是最后一个
        if (i < state.greetingQueue.length - 1) {
          const interval = sim.clampedGaussian(
            3 * 60 * 1000,  // 均值 3 分钟
            60 * 1000,       // 标准差 1 分钟
            2 * 60 * 1000,   // 最小 2 分钟
            5 * 60 * 1000    // 最大 5 分钟
          );
          const mins = (interval / 60000).toFixed(1);
          updatePanelStatus(
            `已打招呼 ${i + 1}/${state.greetingQueue.length}，等待 ${mins} 分钟...`,
            true
          );
          await sim.sleep(interval);
        }

      } catch (err) {
        console.error(`${LOG_PREFIX} 打招呼失败 [${candidate.name}]:`, err);
        state.stats.errors++;
      }
    }

    // 完成
    state.phase = 'done';
    updatePanelStatus(
      `✅ 完成！已打招呼 ${state.stats.greeted} 人，配额剩余 ${state.quota.remaining}`,
      false
    );

    const greetBtn = document.getElementById('crp-greet-btn');
    if (greetBtn) {
      greetBtn.disabled = true;
      greetBtn.textContent = '✅ 已完成';
    }

    const scanBtn = document.getElementById('crp-scan-btn');
    if (scanBtn) {
      scanBtn.disabled = false;
      scanBtn.textContent = '🔍 重新扫描';
    }
  }

  /**
   * 将跟进消息保存到 chrome.storage，聊天页面会读取并发送
   */
  async function saveFollowupToStorage(candidate) {
    const stored = await chrome.storage.local.get(['pendingFollowups']);
    const pending = stored.pendingFollowups || [];

    pending.push({
      candidateName: candidate.name,
      followupText: candidate.followupText,
      greetingId: candidate.greetingId,
      timestamp: Date.now(),
    });

    await chrome.storage.local.set({ pendingFollowups: pending });
    console.log(`${LOG_PREFIX} 跟进消息已保存: ${candidate.name}`);
  }

  // ============================================================
  // 与 Popup / Background 通信
  // ============================================================

  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    switch (msg.type) {
      case 'START_GREETING_SCAN':
        state.panelDismissed = false;
        if (state.panelElement) {
          state.panelElement.style.display = 'flex';
        }
        startScanFlow().then(() => sendResponse({ ok: true }));
        return true;

      case 'GET_GREETING_STATUS':
        sendResponse({
          ok: true,
          phase: state.phase,
          stats: state.stats,
          quota: state.quota,
        });
        break;

      case 'TOGGLE_PANEL':
        if (state.panelElement) {
          const isHidden = state.panelElement.style.display === 'none';
          state.panelElement.style.display = isHidden ? 'flex' : 'none';
          state.panelDismissed = !isHidden;
        }
        sendResponse({ ok: true });
        break;
    }
  });

  // ============================================================
  // 初始化
  // ============================================================

  let uiCreated = false;
  let lastUrl = '';

  function checkRoute() {
    const currentUrl = window.location.href;
    const isRecommend = currentUrl.includes('/web/chat/recommend');

    if (isRecommend) {
      if (!uiCreated) {
        createReviewPanel();
        updatePanelStatus('就绪 — 点击"扫描候选人"开始');
        uiCreated = true;
      }
      if (state.panelElement) {
        state.panelElement.style.display = state.panelDismissed ? 'none' : 'flex';
      }
    } else {
      if (state.panelElement) {
        state.panelElement.style.display = 'none';
      }
    }

    // 检测到真实的 URL 切换时，重新恢复面板显示（以防用户再次进入推荐页面需要使用）
    if (currentUrl !== lastUrl) {
      if (isRecommend) {
        state.panelDismissed = false;
      }
      lastUrl = currentUrl;
    }
  }

  // ============================================================
  // 初始化
  // ============================================================

  async function init() {
    console.log(`${LOG_PREFIX} v${VERSION} 已加载`);
    console.log(`${LOG_PREFIX} 页面: ${window.location.href}`);

    // 等待页面稳定
    await new Promise(resolve => setTimeout(resolve, 3000));

    checkRoute();
    setInterval(checkRoute, 1000);
  }

  if (document.readyState === 'complete') {
    setTimeout(init, 2000);
  } else {
    window.addEventListener('load', () => setTimeout(init, 2000));
  }
})();
