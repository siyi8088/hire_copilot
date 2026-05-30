/**
 * preflight-check.js
 * DOM Preflight Check — 校准引擎 + 诊断收集 + 截图上报
 *
 * 每个功能模块启动前调用 PreflightCheck.run(moduleName)，验证
 * SelectorRegistry 中定义的选择器在当前页面是否仍然有效。
 *
 * 校准通过 → 缓存有效选择器映射到 chrome.storage.local（24h TTL）
 * 校准失败 → 自动截图 + 收集 DOM 诊断数据 → 发送到后端
 *
 * 依赖：selector-registry.js（必须先加载）
 */

window.PreflightCheck = (() => {
  'use strict';

  const LOG_PREFIX = '[HireCopilot:Preflight]';
  const CACHE_TTL = 24 * 60 * 60 * 1000; // 24 小时
  const CACHE_KEY_PREFIX = 'preflight_cache_';

  // 存储每个模块校准后的"有效选择器"映射
  // 格式: { moduleName: { SELECTOR_NAME: 'matched_selector_string', ... } }
  const resolvedSelectors = {};

  // ============================================================
  // DOM 穿透查找辅助函数 (Traverse same-origin iframes)
  // ============================================================

  function querySelectorInDoc(selector, doc) {
    try {
      return doc.querySelector(selector);
    } catch { return null; }
  }

  function querySelectorAllInDoc(selector, doc) {
    try {
      return [...doc.querySelectorAll(selector)];
    } catch { return []; }
  }

  /**
   * 在主文档及同源 iframe 中查找所有匹配元素
   */
  function findAllInPage(selector) {
    let results = querySelectorAllInDoc(selector, document);

    const iframes = document.querySelectorAll('iframe');
    for (const iframe of iframes) {
      try {
        const innerDoc = iframe.contentDocument || iframe.contentWindow.document;
        if (innerDoc) {
          results = results.concat(querySelectorAllInDoc(selector, innerDoc));
        }
      } catch { /* 跨域 iframe 跳过 */ }
    }
    return results;
  }

  // ============================================================
  // 核心校准逻辑
  // ============================================================

  /**
   * 验证单个选择器定义
   * @returns {{ passed: boolean, matchedSelector: string|null, matchCount: number, detail: string }}
   */
  function verifySingleSelector(selectorDef) {
    const { candidates, verify, searchIframes } = selectorDef;
    const minCount = verify?.minCount ?? 0;
    const textContains = verify?.textContains || [];
    const textEquals = verify?.textEquals || null;

    for (const sel of candidates) {
      let elements;
      if (searchIframes !== false) {
        elements = findAllInPage(sel);
      } else {
        elements = querySelectorAllInDoc(sel, document);
      }

      if (elements.length === 0) continue;

      // 检查 minCount
      if (elements.length < minCount) continue;

      // 检查 textContains
      if (textContains.length > 0) {
        const hasMatch = elements.some(el => {
          const txt = el.textContent || '';
          return textContains.some(keyword => txt.includes(keyword));
        });
        if (!hasMatch) continue;
      }

      // 检查 textEquals
      if (textEquals) {
        const hasExact = elements.some(el => {
          return (el.textContent?.trim() || '') === textEquals;
        });
        if (!hasExact) continue;
      }

      // 全部校验通过
      return {
        passed: true,
        matchedSelector: sel,
        matchCount: elements.length,
        detail: `✅ "${sel}" 匹配到 ${elements.length} 个元素`,
      };
    }

    // 所有 candidates 都失败
    return {
      passed: false,
      matchedSelector: null,
      matchCount: 0,
      detail: `❌ 所有 ${candidates.length} 个候选选择器均未匹配`,
    };
  }

  /**
   * 执行指定模块的完整校准
   * @param {string} moduleName
   * @param {Object} [options]
   * @param {boolean} [options.forceRefresh] - 强制刷新，忽略缓存
   * @returns {Promise<{ passed: boolean, results: Object, fromCache: boolean }>}
   */
  async function run(moduleName, options = {}) {
    const registry = window.SelectorRegistry;
    if (!registry) {
      console.error(`${LOG_PREFIX} SelectorRegistry 未加载`);
      return { passed: false, results: {}, fromCache: false };
    }

    const moduleDef = registry.getModule(moduleName);
    if (!moduleDef) {
      console.error(`${LOG_PREFIX} 未找到模块定义: ${moduleName}`);
      return { passed: false, results: {}, fromCache: false };
    }

    // 检查缓存
    if (!options.forceRefresh) {
      const cached = await loadCache(moduleName);
      if (cached) {
        // 检查缓存的结果是否全部关键项通过
        const results = cached.results || {};
        const hasCriticalFailure = Object.entries(results).some(
          ([, r]) => r.critical && !r.passed
        );

        if (!hasCriticalFailure) {
          console.log(`${LOG_PREFIX} [${moduleName}] 使用缓存的校准结果 (${Object.keys(cached.selectors).length} 项)`);
          resolvedSelectors[moduleName] = cached.selectors;
          return { passed: true, results: cached.results, fromCache: true };
        } else {
          console.log(`${LOG_PREFIX} [${moduleName}] 缓存中有关键选择器失败，重新校准`);
        }
      }
    }

    console.log(`${LOG_PREFIX} [${moduleName}] 开始校准...`);

    const selectorDefs = moduleDef.selectors;
    const results = {};
    const resolved = {};
    let allCriticalPassed = true;

    for (const [name, def] of Object.entries(selectorDefs)) {
      const result = verifySingleSelector(def);
      results[name] = {
        ...result,
        critical: def.critical,
      };

      if (result.passed) {
        resolved[name] = result.matchedSelector;
      } else {
        // 即使匹配失败也保留 candidates，业务代码会使用降级逻辑
        resolved[name] = def.candidates;
      }

      if (def.critical && !result.passed) {
        allCriticalPassed = false;
      }

      console.log(`${LOG_PREFIX}   ${name}: ${result.detail}${def.critical ? ' [关键]' : ''}`);
    }

    resolvedSelectors[moduleName] = resolved;

    // 无论通过还是失败，都保存到缓存（Popup 需要读取状态）
    await saveCache(moduleName, resolved, results);

    if (allCriticalPassed) {
      console.log(`${LOG_PREFIX} [${moduleName}] ✅ 校准通过`);
      if (options.forceReport) {
        console.log(`${LOG_PREFIX} [${moduleName}] 强制生成并上报诊断报告...`);
        await collectAndReport(moduleName, results);
      }
    } else {
      console.error(`${LOG_PREFIX} [${moduleName}] ❌ 校准失败 — 关键选择器未匹配`);
      // 自动收集诊断并上报
      await collectAndReport(moduleName, results);
    }

    return { passed: allCriticalPassed, results, fromCache: false };
  }

  // ============================================================
  // 选择器获取（业务代码使用）
  // ============================================================

  /**
   * 获取校准后的选择器
   * 如果校准成功，返回匹配到的单个选择器字符串
   * 如果校准失败或未校准，返回原始的 candidates 数组（兼容现有代码）
   * @param {string} moduleName
   * @param {string} selectorName
   * @returns {string|string[]}
   */
  function getSelector(moduleName, selectorName) {
    let actualModule = moduleName;
    if (moduleName === 'chatObserver') {
      const listSelectors = ['CHAT_LIST', 'CHAT_LIST_ITEM', 'ACTIVE_CHAT_ITEM'];
      if (!listSelectors.includes(selectorName)) {
        actualModule = 'chatConversation';
      }
    }

    const moduleResolved = resolvedSelectors[actualModule];
    if (moduleResolved && moduleResolved[selectorName]) {
      const val = moduleResolved[selectorName];
      // 如果是字符串说明校准成功匹配到了一个具体选择器
      // 如果是数组说明校准失败，返回全部 candidates 让业务代码降级
      return val;
    }

    // 未校准，从注册表返回原始 candidates
    const registry = window.SelectorRegistry;
    if (registry) {
      return registry.getCandidates(actualModule, selectorName);
    }
    return [];
  }

  /**
   * 获取指定模块的全部已校准选择器
   * @param {string} moduleName
   * @returns {Object} { SELECTOR_NAME: resolved_value, ... }
   */
  function getAllSelectors(moduleName) {
    return resolvedSelectors[moduleName] || {};
  }

  // ============================================================
  // 缓存管理
  // ============================================================

  async function loadCache(moduleName) {
    const cacheKey = CACHE_KEY_PREFIX + moduleName;
    const stored = await chrome.storage.local.get([cacheKey]);
    const cache = stored[cacheKey];

    if (!cache) return null;
    if (Date.now() - cache._timestamp > CACHE_TTL) {
      console.log(`${LOG_PREFIX} [${moduleName}] 缓存已过期`);
      return null;
    }

    return cache;
  }

  async function saveCache(moduleName, selectors, results) {
    const cacheKey = CACHE_KEY_PREFIX + moduleName;
    await chrome.storage.local.set({
      [cacheKey]: {
        selectors,
        results,
        _timestamp: Date.now(),
      },
    });
    console.log(`${LOG_PREFIX} [${moduleName}] 校准结果已缓存`);
  }

  /**
   * 清除指定模块的缓存（手动重新校准时使用）
   */
  async function clearCache(moduleName) {
    if (moduleName) {
      const cacheKey = CACHE_KEY_PREFIX + moduleName;
      await chrome.storage.local.remove([cacheKey]);
      console.log(`${LOG_PREFIX} [${moduleName}] 缓存已清除`);
    } else {
      // 清除所有模块的缓存
      const registry = window.SelectorRegistry;
      if (registry) {
        const keys = registry.listModules().map(m => CACHE_KEY_PREFIX + m);
        await chrome.storage.local.remove(keys);
        console.log(`${LOG_PREFIX} 所有模块缓存已清除`);
      }
    }
  }

  // ============================================================
  // 诊断收集 + 截图 + 上报
  // ============================================================

  /**
   * 收集诊断数据并上报到后端
   */
  async function collectAndReport(moduleName, failedResults) {
    console.log(`${LOG_PREFIX} [${moduleName}] 开始收集诊断数据...`);

    // 1. 收集 DOM 诊断数据
    const domDiagnostics = collectDOMDiagnostics(moduleName);

    // 2. 请求截图
    let screenshot = null;
    try {
      const response = await chrome.runtime.sendMessage({ type: 'CAPTURE_SCREENSHOT' });
      if (response?.screenshot) {
        screenshot = response.screenshot;
        console.log(`${LOG_PREFIX} 截图已获取`);
      }
    } catch (err) {
      console.warn(`${LOG_PREFIX} 截图失败:`, err.message);
    }

    // 3. 组装诊断报告
    const report = {
      module: moduleName,
      url: window.location.href,
      timestamp: new Date().toISOString(),
      pageTitle: document.title,
      failedSelectors: {},
      passedSelectors: {},
      domDiagnostics,
      screenshot,
    };

    // 分类失败和通过的选择器
    for (const [name, result] of Object.entries(failedResults)) {
      if (result.passed) {
        report.passedSelectors[name] = {
          matchedSelector: result.matchedSelector,
          matchCount: result.matchCount,
        };
      } else {
        report.failedSelectors[name] = {
          critical: result.critical,
          detail: result.detail,
        };
      }
    }

    // 4. 发送到后端
    try {
      const response = await chrome.runtime.sendMessage({
        type: 'REPORT_DIAGNOSTIC',
        payload: report,
      });

      if (response?.ok) {
        console.log(`${LOG_PREFIX} ✅ 诊断数据已发送到后端 (reportId: ${response.reportId})`);
        return response;
      } else {
        console.warn(`${LOG_PREFIX} 诊断上报失败:`, response?.error);
      }
    } catch (err) {
      console.error(`${LOG_PREFIX} 诊断上报异常:`, err);
    }

    return null;
  }

  /**
   * 收集页面 DOM 结构诊断信息
   */
  function collectDOMDiagnostics(moduleName) {
    const diag = {
      iframeCount: 0,
      iframes: [],
      matchedClasses: [],
      potentialButtons: [],
      bodySnippet: '',
    };

    try {
      // 根据模块类型选择不同的关键词进行扫描
      const keywordSets = {
        jobSyncer: ['job', 'position', 'card', 'item', 'list', 'edit', 'preview', 'operate', 'drawer', 'detail'],
        recommendGreeter: ['recommend', 'card', 'list', 'geek', 'candidate', 'user', 'item', 'member', 'resume', 'greet'],
        chatObserver: ['chat', 'message', 'msg', 'session', 'list', 'record', 'conversation', 'dialog'],
      };
      const keywords = keywordSets[moduleName] || ['card', 'list', 'item', 'container'];

      // 扫描主文档
      const scanDoc = (doc, label) => {
        const elements = doc.querySelectorAll('div, ul, li, section, a, button, span');
        const matched = [];

        elements.forEach(el => {
          const cls = el.className;
          if (cls && typeof cls === 'string') {
            const hits = keywords.filter(kw => cls.toLowerCase().includes(kw));
            if (hits.length > 0) {
              matched.push({
                source: label,
                tag: el.tagName.toLowerCase(),
                class: cls.substring(0, 120),
                matchedKeywords: hits.join(', '),
                text: (el.textContent?.trim() || '').substring(0, 40).replace(/\s+/g, ' '),
                childCount: el.children.length,
              });
            }
          }
        });
        return matched;
      };

      diag.matchedClasses = scanDoc(document, 'main').slice(0, 50);

      // 按钮扫描
      const buttonTexts = ['打招呼', '沟通', '聊一聊', '编辑', '预览', '详情', '发消息', '关闭'];
      document.querySelectorAll('button, a, span, div').forEach(el => {
        const txt = el.textContent?.trim() || '';
        const matched = buttonTexts.filter(t => txt.includes(t));
        if (matched.length > 0 && txt.length < 20) {
          diag.potentialButtons.push({
            source: 'main',
            tag: el.tagName.toLowerCase(),
            class: (el.className || '').substring(0, 80),
            text: txt,
          });
        }
      });

      // 扫描 iframe
      const iframes = document.querySelectorAll('iframe');
      diag.iframeCount = iframes.length;

      iframes.forEach((iframe, idx) => {
        const iframeInfo = {
          index: idx,
          src: iframe.src || '',
          id: iframe.id || '',
          class: iframe.className || '',
          accessible: false,
          matchedClasses: [],
          potentialButtons: [],
        };

        try {
          const innerDoc = iframe.contentDocument || iframe.contentWindow.document;
          if (innerDoc) {
            iframeInfo.accessible = true;
            iframeInfo.bodyLength = innerDoc.body?.innerHTML?.length || 0;
            iframeInfo.matchedClasses = scanDoc(innerDoc, `iframe[${idx}]`).slice(0, 30);

            // iframe 内按钮扫描
            innerDoc.querySelectorAll('button, a, span, div').forEach(el => {
              const txt = el.textContent?.trim() || '';
              const matched = buttonTexts.filter(t => txt.includes(t));
              if (matched.length > 0 && txt.length < 20) {
                iframeInfo.potentialButtons.push({
                  tag: el.tagName.toLowerCase(),
                  class: (el.className || '').substring(0, 80),
                  text: txt,
                });
              }
            });
          }
        } catch (e) {
          iframeInfo.error = e.message;
        }

        diag.iframes.push(iframeInfo);
      });

      // body 结构摘要（前 3000 字符）
      diag.bodySnippet = document.body?.innerHTML?.substring(0, 3000) || '';

      // 补充：收集第一个候选人卡片的 outerHTML 结构，以便精准分析选择器
      diag.firstCardHTML = '';
      try {
        let firstCard = document.querySelector('li.card-item, [class*="card-item"], [class*="candidate-card"]');
        if (!firstCard) {
          // 穿透 iframe 找
          const iframes = document.querySelectorAll('iframe');
          for (const iframe of iframes) {
            try {
              const innerDoc = iframe.contentDocument || iframe.contentWindow.document;
              if (innerDoc) {
                firstCard = innerDoc.querySelector('li.card-item, [class*="card-item"], [class*="candidate-card"]');
                if (firstCard) break;
              }
            } catch {}
          }
        }
        if (firstCard) {
          diag.firstCardHTML = firstCard.outerHTML;
        }
      } catch (err) {
        diag.firstCardError = err.message;
      }

      // 补充：收集可能匹配的岗位选择下拉框
      diag.potentialJobSelectHTML = [];
      try {
        const selectSels = ['.job-select-box', '.job-select', '.job-selector', '.dropdown-select-title', '.select-target', '[class*="select"]'];
        const findAndAddSelects = (doc) => {
          for (const sel of selectSels) {
            try {
              const els = doc.querySelectorAll(sel);
              els.forEach(el => {
                const rect = el.getBoundingClientRect();
                if (rect.width > 0 && rect.height > 0 && diag.potentialJobSelectHTML.length < 5) {
                  // 只包含少量字符和子元素，避免包含超大父容器
                  if (el.outerHTML.length < 15000) {
                    diag.potentialJobSelectHTML.push({
                      selector: sel,
                      class: el.className,
                      html: el.outerHTML
                    });
                  }
                }
              });
            } catch {}
          }
        };
        findAndAddSelects(document);
        const iframes = document.querySelectorAll('iframe');
        for (const iframe of iframes) {
          try {
            const innerDoc = iframe.contentDocument || iframe.contentWindow.document;
            if (innerDoc) {
              findAndAddSelects(innerDoc);
            }
          } catch {}
        }
      } catch (err) {
        diag.jobSelectError = err.message;
      }

      // 补充：收集第一个聊天列表项 (li) 的 outerHTML，以便分析未读消息红点标志
      diag.firstUserListItemHTML = '';
      try {
        const userList = document.querySelector('div.user-list, .user-list');
        if (userList) {
          const firstLi = userList.querySelector('li');
          if (firstLi) {
            diag.firstUserListItemHTML = firstLi.outerHTML;
          }
        }
      } catch (err) {
        diag.firstUserListItemError = err.message;
      }

      // 补充：收集聊天对话窗口的 outerHTML，用于分析对话头部和岗位信息选择器
      diag.chatConversationHTML = '';
      try {
        const convBox = document.querySelector('div.conversation-box, div.chat-conversation, .chat-conversation');
        if (convBox) {
          diag.chatConversationHTML = convBox.outerHTML.substring(0, 25000);
        }
      } catch (err) {
        diag.chatConversationError = err.message;
      }

    } catch (err) {
      diag.error = err.message;
    }

    return diag;
  }

  // ============================================================
  // 校准状态 UI 辅助（供各模块调用）
  // ============================================================

  /**
   * 生成校准状态 HTML，供面板展示
   */
  function renderCalibrationStatusHTML(results) {
    if (!results || Object.keys(results).length === 0) {
      return '<div style="color: #8888a8; font-size: 12px; padding: 8px;">未执行校准</div>';
    }

    let html = '<div style="font-size: 12px; line-height: 1.8; padding: 8px 12px;">';

    for (const [name, result] of Object.entries(results)) {
      const icon = result.passed ? '✅' : (result.critical ? '❌' : '⚠️');
      const color = result.passed ? '#2ed573' : (result.critical ? '#ff6b6b' : '#feca57');
      const label = result.critical ? ' [关键]' : '';

      html += `<div style="display: flex; justify-content: space-between; align-items: center; padding: 2px 0;">`;
      html += `  <span style="color: ${color};">${icon} ${name}${label}</span>`;
      if (result.passed) {
        html += `  <span style="color: #666; font-size: 10px;">${result.matchCount} 个匹配</span>`;
      } else {
        html += `  <span style="color: #ff6b6b; font-size: 10px;">未匹配</span>`;
      }
      html += `</div>`;
    }

    html += '</div>';
    return html;
  }

  /**
   * 生成校准失败时的完整引导 UI
   */
  function renderCalibrationFailureHTML(moduleName, results, reportResponse) {
    const failedItems = Object.entries(results).filter(([, r]) => !r.passed && r.critical);
    const passedItems = Object.entries(results).filter(([, r]) => r.passed);

    let html = `
      <div style="margin: 16px; padding: 16px; background: rgba(255, 107, 107, 0.08); border: 1px dashed rgba(255, 107, 107, 0.3); border-radius: 12px;">
        <div style="font-size: 15px; font-weight: bold; color: #ff6b6b; margin-bottom: 12px; display: flex; align-items: center; gap: 8px;">
          <span>🔴</span> <span>DOM 校准失败</span>
        </div>
        
        <div style="font-size: 12px; color: #a8a8c8; margin-bottom: 12px; line-height: 1.5;">
          Boss直聘页面结构可能已更新，以下关键选择器无法匹配到页面元素：
        </div>

        <div style="margin-bottom: 12px;">
    `;

    // 失败项
    for (const [name, result] of failedItems) {
      html += `
        <div style="padding: 4px 8px; margin-bottom: 4px; background: rgba(255, 107, 107, 0.06); border-radius: 4px; font-size: 11px;">
          <span style="color: #ff6b6b;">❌ ${name}</span>
          <span style="color: #666; margin-left: 8px;">${result.detail}</span>
        </div>
      `;
    }

    // 通过项（折叠）
    if (passedItems.length > 0) {
      html += `<details style="margin-top: 8px;"><summary style="font-size: 11px; color: #2ed573; cursor: pointer;">✅ ${passedItems.length} 项通过</summary>`;
      for (const [name, result] of passedItems) {
        html += `<div style="padding: 2px 8px; font-size: 10px; color: #2ed573;">${name}: ${result.matchedSelector} (${result.matchCount})</div>`;
      }
      html += `</details>`;
    }

    html += `</div>`;

    // 上报状态
    if (reportResponse?.ok) {
      html += `
        <div style="padding: 8px; background: rgba(46, 213, 115, 0.08); border-radius: 6px; margin-bottom: 12px;">
          <div style="font-size: 12px; color: #2ed573; font-weight: 600;">📸 诊断数据（含截图）已自动发送至后端</div>
          <div style="font-size: 10px; color: #8888a8; margin-top: 4px;">报告 ID: ${reportResponse.reportId || 'N/A'}</div>
        </div>
      `;
    } else {
      html += `
        <div style="padding: 8px; background: rgba(255, 107, 107, 0.08); border-radius: 6px; margin-bottom: 12px;">
          <div style="font-size: 12px; color: #feca57;">⚠️ 诊断数据上报失败，请确保后端已启动</div>
        </div>
      `;
    }

    // 操作按钮
    html += `
        <div style="display: flex; gap: 8px;">
          <button id="preflight-btn-retry" style="flex: 1; padding: 8px; background: #6366f1; color: white; border: none; border-radius: 6px; font-size: 12px; font-weight: 600; cursor: pointer;">🔄 重新校准</button>
          <button id="preflight-btn-copy" style="flex: 1; padding: 8px; background: rgba(255, 255, 255, 0.08); color: white; border: none; border-radius: 6px; font-size: 12px; cursor: pointer;">📋 复制诊断数据</button>
        </div>
      </div>
    `;

    return html;
  }

  // ============================================================
  // 消息监听（来自 Popup 的校准状态查询 / 重新校准指令）
  // ============================================================

  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (msg.type === 'GET_PREFLIGHT_STATUS') {
      const moduleName = msg.moduleName;
      const moduleResolved = resolvedSelectors[moduleName];
      sendResponse({
        ok: true,
        module: moduleName,
        calibrated: !!moduleResolved,
        selectorCount: moduleResolved ? Object.keys(moduleResolved).length : 0,
      });
      return;
    }

    if (msg.type === 'FORCE_RECALIBRATE') {
      const requestedModule = msg.moduleName;

      // 确定要校准的模块列表
      let modulesToRun = [];
      const registry = window.SelectorRegistry;

      if (requestedModule) {
        modulesToRun = [requestedModule];
      } else if (registry) {
        // moduleName 为 null 时，根据当前页面 URL 匹配所有相关模块
        const currentUrl = window.location.href;
        for (const modName of registry.listModules()) {
          const pattern = registry.getPagePattern(modName);
          if (pattern && currentUrl.includes(pattern)) {
            modulesToRun.push(modName);
          }
        }
        // 如果没有匹配到任何模块，就全部跑一遍（不管页面）
        if (modulesToRun.length === 0) {
          modulesToRun = registry.listModules();
        }
      }

      console.log(`${LOG_PREFIX} 重新校准: ${modulesToRun.join(', ')}`);
      const forceReport = msg.forceReport || false;

      // 逐个清除缓存并重新校准
      (async () => {
        const allResults = {};
        let allPassed = true;

        for (const modName of modulesToRun) {
          await clearCache(modName);
          const result = await run(modName, { forceRefresh: true, forceReport: forceReport });
          allResults[modName] = result;
          if (!result.passed) allPassed = false;
        }

        sendResponse({
          ok: true,
          passed: allPassed,
          modules: modulesToRun,
          results: allResults,
        });
      })();

      return true; // async
    }
  });

  // ============================================================
  // 公共 API
  // ============================================================

  return {
    run,
    getSelector,
    getAllSelectors,
    clearCache,
    collectAndReport,
    renderCalibrationStatusHTML,
    renderCalibrationFailureHTML,
  };
})();
