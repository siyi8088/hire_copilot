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
  // DOM 选择器 — 从 SelectorRegistry + PreflightCheck 动态获取
  // ============================================================
  const MODULE_NAME = 'recommendGreeter';

  // 校准状态
  let preflightResult = null;

  /**
   * 获取选择器（优先从已校准缓存中取，否则从注册表取原始 candidates）
   */
  function SEL(name) {
    const val = window.PreflightCheck.getSelector(MODULE_NAME, name);
    // 如果返回字符串（已校准匹配到的），包装成数组以兼容 findElement/findAllElements
    if (typeof val === 'string') return [val];
    return val || [];
  }

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
    evaluatedFingerprints: new Set(), // 已评估的候选人指纹，去重防刷
    currentJobTitle: '',       // 当前正在扫描的岗位，用于切换岗位时重置去重
  };

  // ============================================================
  // 候选人卡片抓取
  // ============================================================

  /**
   * 尝试多个选择器找到元素
   */
  function findElement(selectorListOrName, parent = document) {
    // 支持传入选择器名称字符串（如 'CARD_CONTAINER'）或数组
    const selectorList = typeof selectorListOrName === 'string' && !selectorListOrName.includes('.')
      ? SEL(selectorListOrName)
      : (Array.isArray(selectorListOrName) ? selectorListOrName : [selectorListOrName]);

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
  function findAllElements(selectorListOrName, parent = document) {
    // 支持传入选择器名称字符串（如 'CARD_ITEM'）或数组
    const selectorList = typeof selectorListOrName === 'string' && !selectorListOrName.includes('.')
      ? SEL(selectorListOrName)
      : (Array.isArray(selectorListOrName) ? selectorListOrName : [selectorListOrName]);

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
  function getText(selectorListOrName, parent = document) {
    const el = findElement(selectorListOrName, parent);
    return el?.textContent?.trim() || '';
  }

  /**
   * 从一个候选人卡片 DOM 中提取信息
   */
  function parseCardElement(cardEl) {
    // 姓名
    const name = getText(SEL('CARD_NAME'), cardEl);

    // 在线状态
    const onlineStatus = getText(SEL('CARD_ONLINE'), cardEl);

    // 基本信息行 — "29岁 5年 硕士 离职-随时到岗"
    // 这通常是一组 span 或一段文本
    const baseInfoEl = findElement(SEL('CARD_BASE_INFO'), cardEl);
    const baseInfoText = baseInfoEl?.textContent?.trim() || '';

    // 从基本信息解析
    const ageMatch = baseInfoText.match(/(\d+)岁/);
    const expMatch = baseInfoText.match(/(\d+)年/);
    const eduMatch = baseInfoText.match(/(博士|硕士|本科|大专|中专|高中)/);
    const statusMatch = baseInfoText.match(/(离职[\-\s]?随时到岗|在职[\-\s]?考虑机会|在职[\-\s]?月内到岗|在职[\-\s]?暂不考虑)/);

    // 期望薪资
    const salary = getText(SEL('CARD_SALARY'), cardEl);

    // 期望职位
    const expectText = getText(SEL('CARD_EXPECT'), cardEl);

    // 优势描述
    const advantage = getText(SEL('CARD_ADVANTAGE'), cardEl);

    // 技术标签
    const tagElements = findAllElements(SEL('CARD_TAGS'), cardEl);
    const tags = tagElements
      .map(el => el.textContent?.trim())
      .filter(t => t && t.length > 0);

    // 工作经历（右侧区域）
    const expElements = findAllElements(SEL('CARD_EXPERIENCE'), cardEl);
    const workHistory = expElements
      .map(el => el.textContent?.trim())
      .filter(t => t)
      .join(' | ');

    // 打招呼按钮 (优先使用选择器查找，若未找到，则通过按钮文本内容进行兜底匹配)
    let greetBtn = findElement(SEL('GREET_BUTTON'), cardEl);
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
    const container = findElement(SEL('CARD_CONTAINER'));
    if (!container) {
      console.warn(`${LOG_PREFIX} 未找到候选人列表容器`);
      // 降级方案：直接在整个页面查找卡片
    }

    const parent = container || document;
    const cardElements = findAllElements(SEL('CARD_ITEM'), parent);

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
   * 滚动加载更多候选人
   */
  async function scrollAndScrape(maxCount = 40) {
    const sim = window.HumanSimulator;
    const allCandidates = new Map(); // fingerprint → candidate

    // 辅助函数：将新扫描到的非重复、未评估卡片加入 map
    const filterAndAdd = (cards) => {
      cards.forEach(c => {
        if (state.evaluatedFingerprints && state.evaluatedFingerprints.has(c.fingerprint)) {
          // 已经评估过，跳过
          return;
        }
        if (!allCandidates.has(c.fingerprint)) {
          allCandidates.set(c.fingerprint, c);
        }
      });
    };

    // 先扫描当前可见的
    const initial = scanVisibleCards();
    filterAndAdd(initial);

    // 滚动加载更多
    const scrollContainer = findElement(SEL('CARD_CONTAINER')) ||
                            document.querySelector('.main-content') ||
                            document.documentElement;

    let noNewCount = 0;
    const maxScrolls = 40; // 调大滚动限制，防止跳过已评估人员时滚动次数不够

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
      filterAndAdd(newCards);

      if (allCandidates.size === prevSize) {
        noNewCount++;
        if (noNewCount >= 5) { // 调大空转限制，防止由于过滤较多导致的连续未增加新人员误判
          console.log(`${LOG_PREFIX} 连续 5 次没有找到全新候选人，停止滚动`);
          break;
        }
      } else {
        noNewCount = 0;
      }

      console.log(`${LOG_PREFIX} 滚动 ${i + 1}/${maxScrolls}, 已收集全新候选人 ${allCandidates.size} 人`);
    }

    // 严格限制返回的候选人数量不超过 maxCount，防止评估超时
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
    const selectors = SEL('JOB_SELECT');

    const checkElementText = (el) => {
      if (!el) return null;
      // 避免包含子列表的包裹容器，剔除包含列表的容器
      if (el.querySelector('ul') || el.querySelector('li') || el.querySelector('dl') || el.querySelector('ol')) {
        return null;
      }
      const txt = el.textContent?.trim();
      if (txt && txt.length > 2 && txt.length < 80 && !txt.includes('打招呼') && !txt.includes('推荐') && !txt.includes('最新')) {
        // 如果包含多行或明显的多个岗位和菜单项拼接，剔除
        if (txt.includes('\n') || txt.includes('\r') || txt.includes('调整顺序') || txt.split(/\s{2,}/).length > 2) {
          return null;
        }
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



      <div class="crp-footer" id="crp-footer" style="display: flex; flex-direction: column; gap: 8px; align-items: stretch; padding: 12px 16px;">
        <div class="crp-tip-safe" style="font-size: 11px; color: #2ed573; text-align: left; line-height: 1.4; background: rgba(46, 213, 115, 0.08); padding: 8px; border-radius: 4px; border: 1px solid rgba(46, 213, 115, 0.15);">
          🛡️ <b>最安全半自动模式已启用</b>：点击候选人右侧的<b>“定位去沟通 🔍”</b>，系统会自动将其在网页中高亮闪烁，由您<b>物理点击打招呼</b>。100% 模拟真实操作，绕过一切限流与封号风控！
        </div>
        <div class="crp-actions" style="display: flex; justify-content: center; width: 100%;">
          <button class="crp-btn crp-btn-scan" id="crp-scan-btn" style="width: 100%; padding: 10px; font-weight: bold; background: #6c5ce7; color: white; border: none; border-radius: 4px; cursor: pointer;">🔍 扫描并筛选候选人</button>
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
        const isGreeted = c.greeted;

        const actionBtnHtml = isGreeted 
          ? `<span class="crp-card-badge-greeted" style="font-size: 11px; background: rgba(46, 213, 115, 0.15); color: #2ed573; padding: 4px 8px; border-radius: 4px; font-weight: bold; border: 1px solid rgba(46, 213, 115, 0.25);">已去沟通</span>`
          : `<button class="crp-btn crp-btn-locate" data-index="${i}" style="font-size: 11px; background: #6c5ce7; color: white; border: none; padding: 4px 10px; border-radius: 4px; cursor: pointer; font-weight: bold; transition: background 0.2s;">定位去沟通 🔍</button>`;

        return `
          <div class="crp-card" data-index="${i}" style="display: block; padding: 12px 14px; margin-bottom: 8px; border-radius: 8px; border: 1px solid rgba(255, 255, 255, 0.06); background: rgba(255, 255, 255, 0.02); transition: all 0.2s; ${isGreeted ? 'opacity: 0.6;' : ''}">
            <div class="crp-card-content" style="width: 100%;">
              <div class="crp-card-header" style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 4px;">
                <div style="display: flex; align-items: center; gap: 8px;">
                  <span class="crp-card-name" style="font-size: 14px; font-weight: bold; color: #fff;">${c.name || '未知'}</span>
                  <span class="crp-card-status" style="font-size: 11px; color: #8888a8;">${c.jobStatus || ''}</span>
                </div>
                <div style="display: flex; align-items: center; gap: 6px;">
                  <span class="crp-card-score ${scoreClass}">⭐${score}</span>
                  ${actionBtnHtml}
                </div>
              </div>
              <div class="crp-card-info" style="font-size: 12px; color: #a8a8c8; margin-bottom: 4px;">
                ${c.experience || ''} · ${c.education || ''} · ${c.salary || ''}
              </div>
              <div class="crp-card-reason" style="font-size: 11px; color: #9ca3af; line-height: 1.4; margin-bottom: 6px;">${c.matchReason || ''}</div>
              ${tags ? `<div class="crp-card-tags" style="font-size: 10px; color: #818cf8; margin-bottom: 4px;">${tags}</div>` : ''}
              <div class="crp-card-followup" style="font-size: 11px; background: rgba(255, 255, 255, 0.02); padding: 4px 6px; border-radius: 4px; border-left: 2px solid #6c5ce7;">
                <span class="crp-followup-label" style="color: #8888a8;">跟进语:</span>
                <span class="crp-followup-text" style="color: #a8a8c8; font-style: italic;">"${c.followupText || ''}"</span>
              </div>
            </div>
          </div>
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

    // 绑定 定位去沟通 按钮的事件
    listEl.querySelectorAll('.crp-btn-locate').forEach(btn => {
      btn.addEventListener('click', async () => {
        const index = parseInt(btn.dataset.index);
        const candidate = state.rankedCandidates[index];
        if (candidate) {
          await locateAndGreetCandidate(candidate, index);
        }
      });
    });
  }

  /**
   * 定位候选人，进行高亮，并在用户物理点击时无感记录和跟进
   */
  async function locateAndGreetCandidate(candidate, index) {
    // 1. 通知后端批准该候选人，使其在后端 DB 状态流转为“已审核”
    if (candidate.greetingId) {
      try {
        await sendToBackground({
          type: 'APPROVE_GREETINGS',
          payload: { greetingIds: [candidate.greetingId] },
        });
        console.log(`${LOG_PREFIX} 已通知后端批准候选人: ${candidate.name}`);
      } catch (err) {
        console.error(`${LOG_PREFIX} 批准单个请求失败:`, err);
      }
    }

    // 2. 在当前页面/iframe中寻找最鲜活的卡片和打招呼按钮
    const liveElements = findLiveGreetButton(candidate);
    if (!liveElements) {
      alert(`未能在页面当前列表中找到候选人 [${candidate.name}]。请尝试手动在页面列表中向下滚动寻找，或重新扫描。`);
      return;
    }

    const { cardEl, greetBtn } = liveElements;

    // 3. 平滑滚动到卡片位置
    cardEl.scrollIntoView({ behavior: 'smooth', block: 'center' });

    // 4. 为卡片添加黄色粗边框和发光的高亮闪烁动画，提醒用户点击
    cardEl.style.transition = 'all 0.5s ease';
    cardEl.style.outline = '4px solid #f1c40f'; // 粗黄边框
    cardEl.style.boxShadow = '0 0 25px #f1c40f'; // 黄色发光
    
    // 定时移除高亮效果
    setTimeout(() => {
      cardEl.style.outline = '';
      cardEl.style.boxShadow = '';
    }, 4000);

    // 5. 闪烁真实的“打招呼”按钮，让其更醒目
    if (greetBtn) {
      greetBtn.style.transition = 'all 0.3s ease';
      greetBtn.style.transform = 'scale(1.1)';
      greetBtn.style.border = '2px solid #fff';
      setTimeout(() => {
        greetBtn.style.transform = '';
        greetBtn.style.border = '';
      }, 2000);
    }

    // 6. 为真实的“打招呼”按钮绑定一次性物理点击事件
    if (greetBtn && !greetBtn._hasCopilotListener) {
      greetBtn._hasCopilotListener = true;
      
      const handlePhysicalClick = async (event) => {
        // 只有真实的物理点击才进行记录，规避一切机器人模拟检测
        if (event.isTrusted) {
          console.log(`${LOG_PREFIX} ✅ 检测到用户对 ${candidate.name} 的真实物理点击打招呼！`);
          
          // 标记面板状态为已打招呼
          candidate.greeted = true;
          
          // 更新配额
          state.quota.used++;
          state.quota.remaining = Math.max(0, state.quota.remaining - 1);
          const quotaEl = document.getElementById('crp-quota-num');
          if (quotaEl) quotaEl.textContent = state.quota.remaining;

          // 通知后端打招呼已发送，进行 DB 状态同步
          if (candidate.greetingId) {
            try {
              await sendToBackground({
                type: 'GREETING_SENT',
                payload: { greetingId: candidate.greetingId },
              });
              console.log(`${LOG_PREFIX} 打招呼状态已同步至后端 DB`);
            } catch (err) {
              console.error(`${LOG_PREFIX} 同步打招呼状态失败:`, err);
            }
          }

          // 准备跟进语到 storage 供聊天页面监听跟进发送
          if (candidate.followupText) {
            await saveFollowupToStorage(candidate);
          }

          // 重新渲染候选人列表以更新状态
          renderCandidateList();
        }
      };

      greetBtn.addEventListener('click', handlePhysicalClick, { once: true });
    }
  }

  /**
   * 动态寻找当前 DOM 树中特定候选人的最新卡片与打招呼按钮
   */
  function findLiveGreetButton(candidate) {
    const docs = [document];
    const iframes = document.querySelectorAll('iframe');
    for (const iframe of iframes) {
      try {
        const innerDoc = iframe.contentDocument || iframe.contentWindow.document;
        if (innerDoc) {
          docs.push(innerDoc);
        }
      } catch (e) {
        // 跨域 iframe 忽略
      }
    }

    for (const doc of docs) {
      const cards = findAllElements(SEL('CARD_ITEM'), doc);
      for (const card of cards) {
        const nameText = getText(SEL('CARD_NAME'), card)?.trim() || '';
        if (nameText && (nameText === candidate.name || nameText.includes(candidate.name) || candidate.name.includes(nameText))) {
          // 进一步验证薪资，防止名字相同误判
          const salary = getText(SEL('CARD_SALARY'), card)?.trim() || '';
          const isSalaryMatch = !candidate.salary || !salary || salary === candidate.salary || salary.includes(candidate.salary) || candidate.salary.includes(salary);
          
          if (isSalaryMatch) {
            // 重新在当前卡片中查找打招呼按钮
            let greetBtn = findElement(SEL('GREET_BUTTON'), card);
            if (!greetBtn) {
              const allButtons = card.querySelectorAll('button, a, span[class*="btn"], div[class*="btn"]');
              for (const btn of allButtons) {
                const text = btn.textContent?.trim() || '';
                if (text === '打招呼' || text === '立即沟通' || text === '聊一聊' || text === '沟通' || text.includes('沟通') || text.includes('打招呼')) {
                  if (text.length < 10) {
                    greetBtn = btn;
                    break;
                  }
                }
              }
            }
            if (greetBtn) {
              return { cardEl: card, greetBtn };
            }
          }
        }
      }
    }
    return null;
  }

  /**
   * Step 1: 扫描 → 评估
   */
  async function startScanFlow() {
    if (state.phase === 'scanning' || state.phase === 'evaluating') {
      console.warn(`${LOG_PREFIX} 当前状态 ${state.phase}，正在处理中，无法重复扫描`);
      return;
    }

    // 检查招聘岗位是否切换，切换则清除指纹去重历史
    const jobTitle = scrapeActiveJobOnRecommendPage();
    if (jobTitle && jobTitle !== state.currentJobTitle) {
      console.log(`${LOG_PREFIX} 检测到招聘岗位切换从 "${state.currentJobTitle}" 到 "${jobTitle}"，清空去重历史`);
      state.evaluatedFingerprints.clear();
      state.currentJobTitle = jobTitle;
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

      // 成功评估后，将指纹加入已评估 Set 避免下次扫描重复拉取
      candidates.forEach(c => {
        if (c.fingerprint) {
          state.evaluatedFingerprints.add(c.fingerprint);
        }
      });

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

  /**
   * 校准失败时，在审核面板中显示诊断 UI
   */
  function showCalibrationFailureUI(results, reportResponse) {
    const listEl = document.getElementById('crp-candidates-list');
    if (!listEl) return;

    listEl.innerHTML = window.PreflightCheck.renderCalibrationFailureHTML(MODULE_NAME, results, reportResponse);

    // 绑定重新校准按钮
    const retryBtn = document.getElementById('preflight-btn-retry');
    if (retryBtn) {
      retryBtn.addEventListener('click', async () => {
        retryBtn.disabled = true;
        retryBtn.textContent = '⏳ 校准中...';
        await window.PreflightCheck.clearCache(MODULE_NAME);
        preflightResult = await window.PreflightCheck.run(MODULE_NAME, { forceRefresh: true });
        if (preflightResult.passed) {
          updatePanelStatus('✅ 校准通过！可以开始扫描');
          listEl.innerHTML = '<div style="padding: 20px; text-align: center; color: #2ed573; font-size: 14px;">✅ DOM 校准已通过，请点击下方按钮开始扫描</div>';
          const scanBtn = document.getElementById('crp-scan-btn');
          if (scanBtn) {
            scanBtn.disabled = false;
            scanBtn.textContent = '🔍 扫描并筛选候选人';
          }
        } else {
          showCalibrationFailureUI(preflightResult.results, null);
        }
      });
    }

    // 绑定复制诊断数据按钮
    const copyBtn = document.getElementById('preflight-btn-copy');
    if (copyBtn) {
      copyBtn.addEventListener('click', async () => {
        const diagData = JSON.stringify(results, null, 2);
        try {
          await navigator.clipboard.writeText(diagData);
          copyBtn.textContent = '✅ 已复制！';
          setTimeout(() => { copyBtn.textContent = '📋 复制诊断数据'; }, 2000);
        } catch {
          copyBtn.textContent = '❌ 复制失败';
        }
      });
    }
  }

  async function init() {
    console.log(`${LOG_PREFIX} v${VERSION} 已加载`);
    console.log(`${LOG_PREFIX} 页面: ${window.location.href}`);

    // 等待页面稳定
    await new Promise(resolve => setTimeout(resolve, 3000));

    // ★ Preflight Check — 校准 DOM 选择器
    if (window.PreflightCheck) {
      preflightResult = await window.PreflightCheck.run(MODULE_NAME);
      if (!preflightResult.passed) {
        console.error(`${LOG_PREFIX} ❌ DOM 校准失败，业务逻辑已暂停`);
        // 创建面板并显示校准失败 UI
        if (window.location.href.includes('/web/chat/recommend')) {
          createReviewPanel();
          updatePanelStatus('🔴 DOM 校准失败');
          showCalibrationFailureUI(preflightResult.results, null);
          const scanBtn = document.getElementById('crp-scan-btn');
          if (scanBtn) {
            scanBtn.disabled = true;
            scanBtn.textContent = '⛔ 校准失败，无法扫描';
          }
          uiCreated = true;
        }
        return;
      }
      console.log(`${LOG_PREFIX} ✅ DOM 校准通过${preflightResult.fromCache ? ' (缓存)' : ''}`);
    }

    checkRoute();
    setInterval(checkRoute, 1000);
  }

  if (document.readyState === 'complete') {
    setTimeout(init, 2000);
  } else {
    window.addEventListener('load', () => setTimeout(init, 2000));
  }
})();
