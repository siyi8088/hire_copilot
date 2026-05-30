/**
 * job-syncer.js
 * Boss直聘"职位管理"页面 — 自动同步活跃岗位详细 JD
 *
 * 运行在: https://www.zhipin.com/web/chat/job/list*
 */

(() => {
  'use strict';

  const LOG_PREFIX = '[HireCopilot:JobSyncer]';
  const VERSION = '0.2.0';
  const MODULE_NAME = 'jobSyncer';

  let syncOverlay = null;
  let panelDismissed = false;
  let preflightResult = null;

  // ============================================================
  // DOM 选择器 — 从 SelectorRegistry + PreflightCheck 动态获取
  // ============================================================
  function SEL(name) {
    const val = window.PreflightCheck.getSelector(MODULE_NAME, name);
    if (typeof val === 'string') return [val];
    return val || [];
  }

  function logToBackend(msg) {
    console.log(LOG_PREFIX, msg);
    try {
      sendToBackground({
        type: 'DEBUG_LOG',
        log: msg
      });
    } catch (e) {}
  }

  // ============================================================
  // UI 样式注入
  // ============================================================
  function injectStyles() {
    const styleId = 'copilot-job-syncer-styles';
    if (document.getElementById(styleId)) return;

    const style = document.createElement('style');
    style.id = styleId;
    style.textContent = `
      /* 同步控制面板 */
      .copilot-sync-panel {
        position: fixed;
        bottom: 40px;
        right: 40px;
        z-index: 10000;
        background: linear-gradient(135deg, #6366f1 0%, #4f46e5 100%);
        border: 1px solid rgba(255, 255, 255, 0.15);
        border-radius: 9999px;
        box-shadow: 0 4px 20px rgba(99, 102, 241, 0.4);
        display: flex;
        align-items: center;
        padding: 2px;
        backdrop-filter: blur(8px);
        font-family: 'Inter', system-ui, sans-serif;
        transition: all 0.3s cubic-bezier(0.4, 0, 0.2, 1);
      }

      .copilot-sync-main-btn {
        background: transparent;
        color: #ffffff;
        border: none;
        padding: 8px 14px 8px 18px;
        font-size: 14px;
        font-weight: 600;
        cursor: pointer;
        display: flex;
        align-items: center;
        gap: 8px;
        border-radius: 9999px;
        transition: opacity 0.2s;
      }

      .copilot-sync-main-btn:hover {
        opacity: 0.9;
      }

      .copilot-sync-main-btn .robot-icon {
        font-size: 16px;
        animation: pulse 2s infinite;
      }

      .copilot-sync-close-btn {
        background: rgba(255, 255, 255, 0.15);
        color: #ffffff;
        border: none;
        width: 24px;
        height: 24px;
        border-radius: 50%;
        font-size: 11px;
        display: flex;
        align-items: center;
        justify-content: center;
        cursor: pointer;
        margin-right: 8px;
        transition: background 0.2s;
      }

      .copilot-sync-close-btn:hover {
        background: rgba(255, 255, 255, 0.3);
      }

      @keyframes pulse {
        0% { transform: scale(1); }
        50% { transform: scale(1.15); }
        100% { transform: scale(1); }
      }

      /* 同步全屏遮罩 */
      .copilot-sync-overlay {
        position: fixed;
        top: 0;
        left: 0;
        width: 100vw;
        height: 100vh;
        background: rgba(10, 10, 15, 0.75);
        backdrop-filter: blur(12px);
        z-index: 20000;
        display: flex;
        align-items: center;
        justify-content: center;
        font-family: 'Inter', system-ui, sans-serif;
        opacity: 0;
        pointer-events: none;
        transition: opacity 0.4s ease;
      }

      .copilot-sync-overlay.active {
        opacity: 1;
        pointer-events: auto;
      }

      .copilot-sync-card {
        background: rgba(20, 20, 30, 0.9);
        border: 1px solid rgba(255, 255, 255, 0.08);
        border-radius: 20px;
        width: 480px;
        padding: 40px;
        box-shadow: 0 20px 50px rgba(0, 0, 0, 0.5);
        text-align: center;
        transform: scale(0.9);
        transition: transform 0.4s cubic-bezier(0.34, 1.56, 0.64, 1);
      }

      .copilot-sync-overlay.active .copilot-sync-card {
        transform: scale(1);
      }

      .copilot-sync-icon {
        font-size: 48px;
        margin-bottom: 24px;
        display: inline-block;
        animation: rotate 3s linear infinite;
      }

      @keyframes rotate {
        100% { transform: rotate(360deg); }
      }

      .copilot-sync-title {
        color: #ffffff;
        font-size: 20px;
        font-weight: 700;
        margin-bottom: 12px;
      }

      .copilot-sync-desc {
        color: #9493a5;
        font-size: 14px;
        line-height: 1.6;
        margin-bottom: 30px;
      }

      .copilot-progress-bar {
        background: rgba(255, 255, 255, 0.05);
        border-radius: 9999px;
        height: 6px;
        width: 100%;
        margin-bottom: 16px;
        overflow: hidden;
        position: relative;
      }

      .copilot-progress-fill {
        background: linear-gradient(90deg, #6366f1 0%, #10b981 100%);
        height: 100%;
        width: 0%;
        border-radius: 9999px;
        transition: width 0.4s ease;
      }

      .copilot-progress-text {
        color: #00f5c4;
        font-size: 13px;
        font-weight: 600;
      }

      /* 成功后的返回按钮 */
      .copilot-success-actions {
        display: flex;
        gap: 12px;
        justify-content: center;
        margin-top: 10px;
      }

      .copilot-action-btn {
        padding: 10px 20px;
        border-radius: 8px;
        font-size: 13px;
        font-weight: 600;
        cursor: pointer;
        border: none;
        transition: all 0.2s;
      }

      .copilot-btn-primary {
        background: #10b981;
        color: #fff;
      }

      .copilot-btn-primary:hover {
        background: #059669;
      }

      .copilot-btn-secondary {
        background: rgba(255, 255, 255, 0.08);
        color: #fff;
      }

      .copilot-btn-secondary:hover {
        background: rgba(255, 255, 255, 0.15);
      }
    `;
    document.head.appendChild(style);
  }

  // ============================================================
  // UI 元素创建
  // ============================================================
  function createUI() {
    // 注入同步控制面板
    const panel = document.createElement('div');
    panel.className = 'copilot-sync-panel';
    panel.id = 'copilot-sync-floating-panel';
    panel.style.display = 'none'; // 由 checkRoute 控制显示
    panel.innerHTML = `
      <button class="copilot-sync-main-btn" id="copilot-btn-sync-trigger">
        <span class="robot-icon">🤖</span>
        <span>同步活跃岗位</span>
      </button>
      <button class="copilot-sync-close-btn" id="copilot-btn-sync-dismiss" title="关闭悬浮窗">✕</button>
    `;
    document.body.appendChild(panel);

    // 注入同步进度模态框
    const overlay = document.createElement('div');
    overlay.className = 'copilot-sync-overlay';
    overlay.id = 'copilot-sync-overlay';
    overlay.innerHTML = `
      <div class="copilot-sync-card">
        <div class="copilot-sync-icon" id="copilot-sync-icon">🔄</div>
        <div class="copilot-sync-title" id="copilot-sync-title">同步中...</div>
        <div class="copilot-sync-desc" id="copilot-sync-desc">正在扫描您的活跃岗位，请勿关闭或刷新此页面。</div>
        <div class="copilot-progress-bar">
          <div class="copilot-progress-fill" id="copilot-progress-fill"></div>
        </div>
        <div class="copilot-progress-text" id="copilot-progress-text">准备就绪...</div>
        <div class="copilot-success-actions" id="copilot-success-actions" style="display: none;">
          <button class="copilot-action-btn copilot-btn-primary" id="copilot-btn-go-recommend">🔍 去推荐牛人</button>
          <button class="copilot-action-btn copilot-btn-secondary" id="copilot-btn-close-sync">关闭</button>
        </div>
        <div id="copilot-debug-container" style="margin-top: 20px; display: none; text-align: left;">
          <button class="copilot-action-btn" id="copilot-btn-copy-debug" style="width: 100%; margin-bottom: 10px; background: #6366f1; color: white; border: none; padding: 10px; border-radius: 8px; font-weight: 600; cursor: pointer;">📋 一键复制页面 HTML 信息 (发给 AI 修复)</button>
          <textarea id="copilot-debug-text" style="width: 100%; height: 120px; background: #111827; color: #9ca3af; border: 1px solid #374151; border-radius: 6px; padding: 8px; font-size: 11px; font-family: monospace; resize: vertical;" readonly></textarea>
        </div>
      </div>
    `;
    document.body.appendChild(overlay);

    syncOverlay = overlay;

    // 绑定按钮事件
    document.getElementById('copilot-btn-sync-trigger').addEventListener('click', startSyncFlow);
    document.getElementById('copilot-btn-sync-dismiss').addEventListener('click', () => {
      panelDismissed = true;
      panel.style.display = 'none';
    });
    document.getElementById('copilot-btn-close-sync').addEventListener('click', () => {
      overlay.classList.remove('active');
    });
    document.getElementById('copilot-btn-go-recommend').addEventListener('click', () => {
      window.location.href = 'https://www.zhipin.com/web/chat/recommend';
    });
  }

  // ============================================================
  // DOM 穿透查找辅助函数 (Traverse same-origin iframes)
  // ============================================================
  function findElement(selector, parent = document) {
    try {
      const el = parent.querySelector(selector);
      if (el) return el;
    } catch (e) {}

    const iframes = parent.querySelectorAll('iframe');
    for (const iframe of iframes) {
      try {
        const innerDoc = iframe.contentDocument || iframe.contentWindow.document;
        if (innerDoc) {
          const el = findElement(selector, innerDoc);
          if (el) return el;
        }
      } catch (e) {}
    }
    return null;
  }

  function findAllElements(selector, parent = document) {
    let results = [];
    try {
      const els = parent.querySelectorAll(selector);
      if (els.length > 0) results = [...els];
    } catch (e) {}

    const iframes = parent.querySelectorAll('iframe');
    for (const iframe of iframes) {
      try {
        const innerDoc = iframe.contentDocument || iframe.contentWindow.document;
        if (innerDoc) {
          results = results.concat(findAllElements(selector, innerDoc));
        }
      } catch (e) {}
    }
    return results;
  }

  // ============================================================
  // 核心同步逻辑
  // ============================================================

  /**
   * 自动寻找所有的“开放中”岗位卡片
   */
  function findActiveJobCards() {
    const cardSelectors = SEL('JOB_CARD');
    logToBackend(`JOB_CARD selectors: ${JSON.stringify(cardSelectors)}`);

    let cardElements = [];
    for (const sel of cardSelectors) {
      const els = findAllElements(sel);
      logToBackend(`Selector [${sel}] found ${els.length} elements`);
      if (els.length > 0) {
        cardElements = els;
        break;
      }
    }

    // 兜底方案：通过“编辑”和“开放中”特征查找行卡片
    if (cardElements.length === 0) {
      logToBackend("常规选择器均未找到卡片，启动兜底扫描...");
      const allDivs = findAllElements('div, li');
      const seen = new Set();
      for (const el of allDivs) {
        const txt = el.textContent || '';
        if (txt.includes('编辑') && (txt.includes('开放中') || txt.includes('待开放') || txt.includes('关闭')) && el.children.length > 1) {
          if (el.querySelector('button, a') && txt.length < 500) {
            let hasAncestor = false;
            let parent = el.parentElement;
            while (parent) {
              if (seen.has(parent)) {
                hasAncestor = true;
                break;
              }
              parent = parent.parentElement;
            }
            if (!hasAncestor) {
              cardElements.push(el);
              seen.add(el);
            }
          }
        }
      }
      logToBackend(`兜底扫描找到 ${cardElements.length} 个卡片`);
    }

    // 过滤出状态为“开放中”的岗位（包含“开放中”或包含“关闭”操作按钮的，且不包含“打开”操作按钮的）
    logToBackend(`开始对 ${cardElements.length} 个岗位候选元素进行状态过滤...`);
    cardElements.forEach((el, index) => {
      logToBackend(`[卡片 #${index}] text content: "${el.textContent?.replace(/\s+/g, ' ').trim()}"`);
    });

    const activeCards = cardElements.filter(el => {
      const text = el.textContent || '';
      const matched = (text.includes('开放中') || text.includes('关闭')) && !text.includes('打开');
      return matched;
    });

    logToBackend(`过滤完成。活跃岗位卡片数: ${activeCards.length}`);
    activeCards.forEach((el, index) => {
      logToBackend(`[活跃岗 #${index}] text content: "${el.textContent?.replace(/\s+/g, ' ').trim()}"`);
    });

    console.log(`${LOG_PREFIX} 共找到 ${cardElements.length} 个岗位，其中活跃岗 ${activeCards.length} 个`);
    return activeCards;
  }

  /**
   * 打开岗位的详情弹窗/抽屉
   */
  async function openJobPreview(cardEl) {
    // 1. 尝试在 cardEl 里直接查找“预览”选项并点击（部分改版或布局可能直接显示）
    try {
      const operateItemSels = SEL('OPERATE_MENU_ITEM');
      const previewItems = operateItemSels.flatMap(sel => [...cardEl.querySelectorAll(sel)]);
      const previewItem = previewItems.find(el => el.textContent?.trim() === '预览');
      if (previewItem) {
        logToBackend(`在卡片内直接找到“预览”项，触发点击: "${previewItem.outerHTML.slice(0, 100)}"`);
        previewItem.click();
        await new Promise(r => setTimeout(r, 1000));
        const previewEl = findPreviewContainer();
        if (previewEl) {
          logToBackend(`✅ 成功开启静态预览容器`);
          return true;
        }
      }
    } catch (e) {
      logToBackend(`卡片内直接查找“预览”出错: ${e.message}`);
    }

    // 2. 模拟悬停与点击“三个点”按钮以激活/展开操作菜单
    try {
      const moreBtnCandidates = SEL('MORE_OPERATE_BTN');
      let moreBtn = null;
      for (const sel of moreBtnCandidates) {
        moreBtn = cardEl.querySelector(sel);
        if (moreBtn) break;
      }
      if (moreBtn) {
        logToBackend(`模拟悬停与点击三个点按钮: "${moreBtn.outerHTML.slice(0, 100)}"`);
        moreBtn.dispatchEvent(new MouseEvent('mouseenter', { bubbles: true }));
        moreBtn.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
        moreBtn.click();
        await new Promise(r => setTimeout(r, 500)); // 等待下拉菜单展开与渲染
      } else {
        logToBackend(`卡片内未找到三个点按钮`);
      }
    } catch (e) {
      logToBackend(`点击三个点按钮出错: ${e.message}`);
    }

    // 3. 在全局范围内模糊查找所有包含“预览”文本且【当前可见】的选项进行点击
    logToBackend(`尝试在全局查找可见的“预览”选项进行点击...`);
    try {
      // 搜集全局的所有可能是操作菜单项或按钮/链接 of elements
      const globalCandidates = findAllElements('.job-operate-item, li, a, span, button');
      logToBackend(`全局找到 ${globalCandidates.length} 个候选交互元素`);
      // 过滤：文本为“预览”，且真正可见的元素
      const visiblePreviewItem = globalCandidates.find(el => {
        if (el.textContent?.trim() !== '预览') return false;
        try {
          const rect = el.getBoundingClientRect();
          if (rect.width === 0 || rect.height === 0) return false;
          
          const style = window.getComputedStyle(el);
          if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') return false;
          
          // 向上检查所有父级，确保没有隐藏
          let parent = el.parentElement;
          while (parent && parent !== document.body) {
            const pStyle = window.getComputedStyle(parent);
            if (pStyle.display === 'none' || pStyle.visibility === 'hidden') return false;
            parent = parent.parentElement;
          }
          return true;
        } catch (err) {
          return true;
        }
      });

      if (visiblePreviewItem) {
        logToBackend(`找到全局可见的“预览”选项，触发点击: "${visiblePreviewItem.outerHTML.slice(0, 100)}"`);
        visiblePreviewItem.click();
        await new Promise(r => setTimeout(r, 1200));
        const previewEl = findPreviewContainer();
        if (previewEl) {
          logToBackend(`✅ 通过全局可见“预览”项成功开启静态预览容器`);
          return true;
        }
      } else {
        logToBackend(`全局中未找到任何可见且文本等于“预览”的元素！`);
      }
    } catch (e) {
      logToBackend(`全局查找可见“预览”点击失败: ${e.message}`);
    }

    // 4. 寻找卡片内是否有直接暴露出来的“预览”或“详情”字样按钮，但绝不点击标题/卡片整行
    logToBackend(`尝试在卡片中查找直接暴露的预览/查看详情按钮...`);
    try {
      const actionElements = [...cardEl.querySelectorAll('button, a, span, div')];
      const previewBtn = actionElements.find(el => {
        const txt = el.textContent?.trim() || '';
        return (txt === '预览' || txt === '详情' || txt.includes('查看详情') || txt.includes('岗位详情')) && 
               el.tagName !== 'A' && el.getBoundingClientRect().width > 0;
      });

      if (previewBtn) {
        logToBackend(`找到卡片直接预览按钮并点击: "${previewBtn.outerHTML.slice(0, 100)}"`);
        previewBtn.click();
        await new Promise(r => setTimeout(r, 1200));
        const previewEl = findPreviewContainer();
        if (previewEl) {
          logToBackend(`✅ 通过直接预览按钮成功开启静态预览容器`);
          return true;
        }
      } else {
        logToBackend(`卡片内未找到直接暴露的预览/详情按钮`);
      }
    } catch (e) {
      logToBackend(`卡片内直接暴露的按钮查找点击失败: ${e.message}`);
    }

    logToBackend(`❌ 无法成功打开该岗位卡片的预览窗口！`);
    return false;
  }

  /**
   * 查找页面当前可见的详情预览弹窗/抽屉/面板
   */
  function findPreviewContainer() {
    // 扩展选择器，覆盖更多可能的抽屉/对话框/详情容器，并支持更多 HTML5 语义标签
    const selectors = SEL('PREVIEW_CONTAINER');

    console.log(`${LOG_PREFIX} 正在查找详情预览容器...`);

    for (const sel of selectors) {
      const els = findAllElements(sel);
      for (const el of els) {
        try {
          const win = el.ownerDocument.defaultView || window;
          const style = win.getComputedStyle(el);
          if (style.display !== 'none' && style.visibility !== 'hidden') {
            const txt = el.textContent || '';
            // 检查常见的 JD 词汇特征
            if (txt.includes('职位详情') || txt.includes('职位要求') || txt.includes('职责') || txt.includes('要求') || txt.includes('描述') || txt.includes('工作职责') || txt.includes('岗位职责') || txt.includes('薪资') || txt.includes('任职资格') || txt.includes('任职要求')) {
              console.log(`${LOG_PREFIX} 找到预览容器 (Selector: ${sel}):`, el);
              return el;
            }
          }
        } catch (e) {
          console.warn(`${LOG_PREFIX} 获取元素样式出错:`, e);
        }
      }
    }

    // 备用兜底查找：查找任何包含“职责/要求”字样的可见元素，并往上寻找定位容器或合适大小的容器
    console.log(`${LOG_PREFIX} 未通过常规选择器找到容器，尝试兜底寻找包含职责/要求关键词的可见元素...`);
    const elements = findAllElements('div, section, aside, article');
    for (const el of elements) {
      try {
        const text = el.textContent || '';
        // 长度在合适范围，且包含关键 JD 词汇
        if (text.length > 50 && text.length < 50000) {
          if (text.includes('工作职责') || text.includes('岗位职责') || text.includes('职位要求') || text.includes('任职要求') || text.includes('任职资格') || text.includes('职位描述')) {
            const win = el.ownerDocument.defaultView || window;
            const style = win.getComputedStyle(el);
            // 只要它是可见的
            if (style.display !== 'none' && style.visibility !== 'hidden') {
              // 往上找最近的一个定位容器或者宽度较大的块级容器，作为预览窗口
              let curr = el;
              while (curr && curr.tagName !== 'BODY' && curr.tagName !== 'HTML') {
                const currStyle = curr.ownerDocument.defaultView.getComputedStyle(curr);
                if (currStyle.display !== 'none' && 
                    (currStyle.position === 'fixed' || currStyle.position === 'absolute' || currStyle.position === 'relative' || 
                     curr.className?.includes('drawer') || curr.className?.includes('dialog') || curr.className?.includes('detail') || curr.className?.includes('preview') ||
                     curr.offsetWidth > 300)) {
                  console.log(`${LOG_PREFIX} 找到兜底预览容器 (Through ancestor traversal):`, curr);
                  return curr;
                }
                curr = curr.parentElement;
              }
              // 如果没找到合适的祖先，直接返回 el 自身
              console.log(`${LOG_PREFIX} 找到兜底预览容器 (Direct element):`, el);
              return el;
            }
          }
        }
      } catch (e) {}
    }
    
    console.warn(`${LOG_PREFIX} 未找到任何详情预览容器`);
    return null;
  }

  /**
   * 从详情预览/编辑页面中解析 JD 字段
   */
  async function parsePreviewDetails(previewEl, fallbackData = {}) {
    const text = previewEl.textContent || '';

    // 1. 点击展开全部（如果存在）
    const expandBtn = [...previewEl.querySelectorAll('a, span, button')].find(
      el => el.textContent?.includes('展开全部') || el.textContent?.includes('展开')
    );
    if (expandBtn) {
      try {
        expandBtn.click();
        await new Promise(r => setTimeout(r, 500));
      } catch (e) {
        console.warn(`${LOG_PREFIX} 点击展开按钮出错:`, e);
      }
    }

    // 2. 提取岗位名称
    let title = '';
    // 优先从 input[name="jobName"] 或 input.job-name-input 获取 (编辑模式)
    const titleInput = previewEl.querySelector('input[name="jobName"], input.job-name-input');
    if (titleInput && titleInput.value) {
      title = titleInput.value.trim();
    }
    
    // 其次从常规的选择器提取 textContent (预览模式)
    if (!title) {
      const titleEls = [...previewEl.querySelectorAll('h1, h2, h3, [class*="title"], [class*="name"]')];
      const validTitleEl = titleEls.find(el => {
        const text = el.textContent || '';
        return text.length > 0 && text.length < 50 && 
               !text.includes('基本信息') && 
               !text.includes('无法修改') && 
               !text.includes('客户公司') && 
               !text.includes('职位描述') && 
               !text.includes('职位要求') && 
               !text.includes('工作地点') && 
               !text.includes('招聘类型') && 
               !text.includes('职位名称') &&
               !text.includes('提示') &&
               !text.includes('保存') &&
               !text.includes('发布') &&
               !text.includes('删除') &&
               !text.includes('关闭') &&
               !text.includes('取消') &&
               !text.includes('编辑');
      });
      if (validTitleEl) {
        title = validTitleEl.textContent.trim();
      }
    }
    
    // 清洗格式
    title = title.replace(/代招|匿名/g, '').trim();
    
    // 校验解析出的标题是否与期望目标一致，不一致则使用 fallback 期望值（排除 DOM 过渡残留标题干扰）
    const cleanStr = (s) => (s || '').replace(/代招|匿名|普|营|竞|官/g, '')
                            .replace(/\d+[-~]\d+[Kk万]/g, '')
                            .replace(/\d+薪/g, '')
                            .replace(/[_|｜\-]/g, '')
                            .replace(/\s+/g, '')
                            .toLowerCase();
    if (title && fallbackData.title) {
      const parsedNorm = cleanStr(title);
      const fallbackNorm = cleanStr(fallbackData.title);
      if (parsedNorm && fallbackNorm && !parsedNorm.includes(fallbackNorm) && !fallbackNorm.includes(parsedNorm)) {
        console.warn(`${LOG_PREFIX} 解析到的职位名称 [${title}] 与目标岗位 [${fallbackData.title}] 不匹配，降级采用目标职位名称。`);
        title = fallbackData.title;
      }
    }

    if (!title && fallbackData.title) {
      title = fallbackData.title;
    }

    // 3. 提取公司名称
    let company = '';
    // 优先从 input 且 placeholder 包含“客户公司”或其 value 查找 (编辑模式)
    const companyInput = previewEl.querySelector('input[placeholder*="客户公司"], input[placeholder*="代为招聘"]');
    if (companyInput && companyInput.value) {
      company = companyInput.value.trim();
    }
    
    if (!company) {
      const companyBrandEl = previewEl.querySelector('.brand-info .name, .enterprise-info .name, [class*="company"] .name');
      if (companyBrandEl) {
        company = companyBrandEl.textContent.trim();
      }
    }
    
    if (!company && fallbackData.company) {
      company = fallbackData.company;
    }

    // 4. 薪资范围
    let salary = '';
    const salaryMatch = previewEl.textContent.match(/(\d+[-~]\d+[Kk万](?:·\d+薪)?)/);
    if (salaryMatch) {
      salary = salaryMatch[1];
    } else {
      const salaryEl = previewEl.querySelector('[class*="salary"], [class*="pay"]');
      salary = salaryEl?.textContent?.trim() || '';
    }
    
    if (!salary && fallbackData.salary_range) {
      salary = fallbackData.salary_range;
    }

    // 5. 使用 Slicing 方法健壮地获取 JD 描述和任职要求
    let description = '';
    let requirements = '';
    let highlights = '';

    // 优先从 textarea 获取 (编辑模式)
    const textarea = previewEl.querySelector('textarea');
    if (textarea && textarea.value) {
      const fullJD = textarea.value.trim();
      const reqKeywords = ['职位要求', '任职要求', '任职资格', '岗位要求', '招聘要求', '任职条件'];
      let splitIdx = -1;
      let matchedReqLen = 0;
      for (const kw of reqKeywords) {
        const idx = fullJD.indexOf(kw);
        if (idx !== -1) {
          splitIdx = idx;
          matchedReqLen = kw.length;
          break;
        }
      }
      
      if (splitIdx !== -1) {
        description = fullJD.substring(0, splitIdx).trim();
        requirements = fullJD.substring(splitIdx + matchedReqLen).trim();
      } else {
        description = fullJD;
      }
    } else {
      // 兜底全文本拿描述 (预览模式)
      
      // 寻找描述部分的起始位置
      const descKeywords = ['职位详情', '岗位职责', '工作职责', '职位描述', '职责描述', '工作内容'];
      let detailIndex = -1;
      let matchedDescLen = 0;
      for (const kw of descKeywords) {
        const idx = text.indexOf(kw);
        if (idx !== -1) {
          detailIndex = idx;
          matchedDescLen = kw.length;
          break;
        }
      }

      // 寻找要求部分的起始位置
      const reqKeywords = ['职位要求', '任职要求', '任职资格', '岗位要求', '招聘要求', '任职条件'];
      let reqIndex = -1;
      let matchedReqLen = 0;
      for (const kw of reqKeywords) {
        const idx = text.indexOf(kw);
        if (idx !== -1) {
          reqIndex = idx;
          matchedReqLen = kw.length;
          break;
        }
      }

      // 寻找工作地址/地点的起始位置作为结束标记
      const addrKeywords = ['工作地址', '工作地点', '公司地址', '面试地址'];
      let addrIndex = -1;
      for (const kw of addrKeywords) {
        const idx = text.indexOf(kw);
        if (idx !== -1) {
          addrIndex = idx;
          break;
        }
      }

      if (detailIndex !== -1) {
        const endIndex = reqIndex !== -1 ? reqIndex : (addrIndex !== -1 ? addrIndex : text.length);
        description = text.substring(detailIndex + matchedDescLen, endIndex).trim();
      } else {
        if (reqIndex !== -1) {
          description = text.substring(0, reqIndex).trim();
        } else {
          description = text.substring(0, 1500).trim();
        }
      }

      if (reqIndex !== -1) {
        const endIndex = addrIndex !== -1 ? addrIndex : text.length;
        requirements = text.substring(reqIndex + matchedReqLen, endIndex).trim();
      }
    }

    // 6. 工作地点
    const addrKeywords = ['工作地址', '工作地点', '公司地址', '面试地址'];
    let addrIndex = -1;
    for (const kw of addrKeywords) {
      const idx = text.indexOf(kw);
      if (idx !== -1) {
        addrIndex = idx;
        break;
      }
    }
    if (addrIndex !== -1) {
      highlights = text.substring(addrIndex).split('\n')[0].trim();
    } else {
      // 尝试从 input 获取
      const addrInput = previewEl.querySelector('input[placeholder*="工作地点"], input[placeholder*="地点"]');
      if (addrInput && addrInput.value) {
        highlights = '工作地点：' + addrInput.value.trim();
      }
    }

    return {
      title: title || fallbackData.title || '未知职位',
      company: company || fallbackData.company || '未知公司',
      salary_range: salary || fallbackData.salary_range || '薪资面议',
      requirements: requirements || '无学历要求',
      description: description || '无岗位详情描述',
      highlights: highlights || '工作地点见详情',
    };
  }

  /**
   * 关闭详情弹窗/抽屉
   */
  async function closeJobPreview(previewEl) {
    if (!previewEl) return;
    
    // 寻找包含关闭按钮的祖先容器（例如抽屉 wrapper、弹窗 wrapper 等）
    let container = previewEl;
    let current = previewEl;
    while (current && current.tagName !== 'BODY') {
      const hasClose = current.querySelector('button[class*="close"], span[class*="close"], a[class*="close"], [class*="icon-close"], .close');
      if (hasClose) {
        container = current;
        break;
      }
      current = current.parentElement;
    }
    
    let closeBtn = null;
    const closeBtnCandidates = SEL('PREVIEW_CLOSE_BTN');
    for (const sel of closeBtnCandidates) {
      closeBtn = container.querySelector(sel);
      if (closeBtn) break;
    }
    if (closeBtn) {
      logToBackend(`找到关闭按钮并点击: "${closeBtn.outerHTML.slice(0, 100)}"`);
      closeBtn.click();
    } else {
      // 兜底策略：在 container 里找带关闭字样的元素（必须是精确匹配，不能模糊匹配以防点到“关闭职位”危险按钮）
      const spans = container.querySelectorAll('span, button, a, i');
      const xBtn = [...spans].find(el => {
        const txt = el.textContent?.trim() || '';
        return txt === '✕' || txt === '✕ 关闭' || txt === '关闭' || txt === '取消' || txt === '关闭窗口' || el.className?.includes('close');
      });
      if (xBtn) {
        logToBackend(`找到带关闭特征的按钮并点击: "${xBtn.outerHTML.slice(0, 100)}"`);
        xBtn.click();
      } else {
        logToBackend(`[警告] 未能识别到关闭按钮，尝试点击遮罩层或空白区域兜底`);
        document.body.click();
      }
    }
    await new Promise(r => setTimeout(r, 1000)); // 保证过渡动画加载完毕，顺利返回主页面
  }

  /**
   * 收集页面 HTML structure 进行调试，用于针对性分析选择器
   */
  function collectPageDebugInfo(activeCards, previewEl) {
    const info = {
      url: window.location.href,
      cardsCount: activeCards ? activeCards.length : 0,
      firstCardHtml: activeCards && activeCards[0] ? activeCards[0].outerHTML : '未找到活跃卡片',
      previewElFound: !!previewEl,
      previewElHtml: previewEl ? previewEl.outerHTML : '未找到详情预览容器',
      visibleInputsAndLabels: []
    };

    // 搜集页面上所有可能的悬浮抽屉/对话框/编辑区域的输入控件及标签特征
    const container = previewEl || document.body;
    try {
      const inputs = container.querySelectorAll('input, textarea, select, button, label, h1, h2, h3, [class*="title"], [class*="name"]');
      const items = [];
      inputs.forEach((el, index) => {
        if (index > 120) return; // 限制大小
        items.push({
          tag: el.tagName,
          id: el.id,
          class: el.className,
          placeholder: el.placeholder || el.getAttribute('placeholder') || '',
          value: el.value || '',
          text: el.textContent?.trim().slice(0, 150) || '',
          name: el.name || el.getAttribute('name') || ''
        });
      });
      info.visibleInputsAndLabels = items;
    } catch (e) {}

    // 如果 previewEl 没找到，抓取最近点击过的卡片周围的 HTML 结构片段
    if (!previewEl && activeCards && activeCards[0]) {
      try {
        const parent = activeCards[0].parentElement;
        if (parent) {
          info.parentContainerHtml = parent.outerHTML.slice(0, 5000);
        }
      } catch (e) {}
    }

    return info;
  }

  /**
   * 等待详情预览窗口中的职位名称加载匹配目标岗位
   */
  async function waitForPreviewToLoad(previewEl, targetTitle, maxWaitMs = 3000) {
    const startTime = Date.now();
    const cleanStr = (s) => (s || '').replace(/代招|匿名|普|营|竞|官/g, '')
                            .replace(/\d+[-~]\d+[Kk万]/g, '')
                            .replace(/\d+薪/g, '')
                            .replace(/[_|｜\-]/g, '')
                            .replace(/\s+/g, '')
                            .toLowerCase();
                             
    const targetNorm = cleanStr(targetTitle);
    logToBackend(`[waitForPreviewToLoad] 开始载入校验。targetTitle: "${targetTitle}", targetNorm: "${targetNorm}"`);
    
    while (Date.now() - startTime < maxWaitMs) {
      let title = '';
      const titleInput = previewEl.querySelector('input[name="jobName"], input.job-name-input');
      if (titleInput && titleInput.value) {
        title = titleInput.value.trim();
        logToBackend(`[waitForPreviewToLoad] 找到 titleInput.value: "${title}"`);
      }
      if (!title) {
        const titleEls = [...previewEl.querySelectorAll('h1, h2, h3, [class*="title"], [class*="name"]')];
        const validTitleEl = titleEls.find(el => {
          const text = el.textContent || '';
          return text.length > 0 && text.length < 50 && 
                 !text.includes('基本信息') && 
                 !text.includes('无法修改') && 
                 !text.includes('客户公司') && 
                 !text.includes('职位描述') && 
                 !text.includes('职位要求') && 
                 !text.includes('工作地点') && 
                 !text.includes('招聘类型') && 
                 !text.includes('职位名称') &&
                 !text.includes('提示') &&
                 !text.includes('保存') &&
                 !text.includes('发布') &&
                 !text.includes('删除') &&
                 !text.includes('关闭') &&
                 !text.includes('取消') &&
                 !text.includes('编辑');
        });
        if (validTitleEl) {
          title = validTitleEl.textContent.trim();
          logToBackend(`[waitForPreviewToLoad] 从 titleEls 匹配到首个 validTitleEl: "${title}"`);
        } else {
          // 打印前 5 个候选 titleEls textContent
          const candidates = titleEls.slice(0, 5).map(el => `${el.tagName}: "${el.textContent?.trim()}"`).join(', ');
          logToBackend(`[waitForPreviewToLoad] 未找到有效 validTitleEl。候选列表: [${candidates}]`);
        }
      }
      
      const titleNorm = cleanStr(title);
      const pageTextNorm = cleanStr(previewEl.textContent);
      logToBackend(`[waitForPreviewToLoad] titleNorm: "${titleNorm}", pageTextNorm 长度: ${pageTextNorm.length}`);
      
      // 双重策略验证：如果解析的标题名归一化匹配，或者整个预览容器的文本中包含了目标岗位的归一化名称，均视为加载成功
      if ((titleNorm && (titleNorm.includes(targetNorm) || targetNorm.includes(titleNorm))) || 
          (pageTextNorm && pageTextNorm.includes(targetNorm))) {
        logToBackend(`[waitForPreviewToLoad] ✅ 校验通过！`);
        console.log(`${LOG_PREFIX} ✅ 预览窗口已成功加载/匹配到目标岗位: ${targetTitle}`);
        return true;
      }
      
      await new Promise(r => setTimeout(r, 200));
    }
    logToBackend(`[waitForPreviewToLoad] ❌ 校验超时，匹配失败！`);
    return false;
  }

  /**
   * 执行一键同步全流程
   */
  async function startSyncFlow() {
    const overlay = document.getElementById('copilot-sync-overlay');
    const iconEl = document.getElementById('copilot-sync-icon');
    const titleEl = document.getElementById('copilot-sync-title');
    const descEl = document.getElementById('copilot-sync-desc');
    const fillEl = document.getElementById('copilot-progress-fill');
    const textEl = document.getElementById('copilot-progress-text');
    const actionsEl = document.getElementById('copilot-success-actions');
    const debugContainer = document.getElementById('copilot-debug-container');

    // 恢复 UI 状态
    iconEl.textContent = '🔄';
    iconEl.style.animation = 'rotate 3s linear infinite';
    titleEl.textContent = '正在同步中...';
    descEl.textContent = '正在扫描您的活跃岗位，请勿关闭或刷新此页面。';
    fillEl.style.width = '0%';
    textEl.textContent = '正在初始化...';
    actionsEl.style.display = 'none';
    if (debugContainer) debugContainer.style.display = 'none';

    overlay.classList.add('active');

    let lastPreviewEl = null;
    const activeCards = findActiveJobCards();

    try {
      // 1. 扫描页面中所有的活跃卡片
      if (activeCards.length === 0) {
        iconEl.textContent = '⚠️';
        iconEl.style.animation = 'none';
        titleEl.textContent = '未检测到活跃岗位';
        descEl.textContent = '请确保您在“开放中”Tab页下，且页面中有处于“开放中”的招聘职位。';
        textEl.textContent = '同步中止';
        actionsEl.style.display = 'flex';
        if (debugContainer) debugContainer.style.display = 'block';
        return;
      }

      // 提取所有活跃岗位信息作为兜底数据
      const cardDatas = activeCards.map((card, idx) => {
        let title = '';
        const titleSelectors = SEL('JOB_CARD_TITLE');
        for (const sel of titleSelectors) {
          const el = card.querySelector(sel);
          if (el && el.textContent?.trim()) {
            title = el.textContent.replace(/代招|匿名/g, '').trim();
            break;
          }
        }
        title = title || `未命名岗位${idx + 1}`;

        let company = '';
        const companyEl = card.querySelector('.brand-info, [class*="brand"], [class*="company"]');
        if (companyEl) {
          company = companyEl.textContent.trim();
        }

        let salary = '';
        const cardText = card.textContent || '';
        const salaryMatch = cardText.match(/(\d+[-~]\d+[Kk万](?:·\d+薪)?)/);
        if (salaryMatch) {
          salary = salaryMatch[1];
        }

        return { title, company, salary_range: salary };
      });

      const jobTitles = cardDatas.map(d => d.title);

      // 弹出确认提示框告知扫描到的岗位名称列表
      const startConfirm = confirm(
        `🤖 Copilot 扫描到以下 ${activeCards.length} 个活跃岗位：\n\n` + 
        jobTitles.map((t, idx) => `${idx + 1}. ${t}`).join('\n') + 
        `\n\n确定要开始同步这些岗位详细 JD 到后端吗？`
      );

      if (!startConfirm) {
        console.log(`${LOG_PREFIX} 用户取消了同步`);
        overlay.classList.remove('active');
        return;
      }

      descEl.innerHTML = `检测到以下活跃岗位：<br><strong style="color: #6366f1; display: block; margin: 10px 0; font-size: 15px;">${jobTitles.join('、')}</strong>正在同步中，请勿关闭或刷新此页面。`;
      textEl.textContent = `正在重置云端岗位激活状态...`;
      try {
        await sendToBackground({
          type: 'DEACTIVATE_ALL_JOBS'
        });
      } catch (e) {
        console.warn(`${LOG_PREFIX} 重置激活状态失败 (后端可能未更新):`, e);
      }
      textEl.textContent = `共发现 ${activeCards.length} 个活跃岗位，开始同步...`;

      let successCount = 0;
      const syncedTitles = [];

      for (let i = 0; i < activeCards.length; i++) {
        const card = activeCards[i];
        const fallbackData = cardDatas[i] || {};
        logToBackend(`开始同步第 ${i + 1}/${activeCards.length} 个活跃岗位: "${fallbackData.title}"`);
        
        // 滚动到该卡片
        card.scrollIntoView({ behavior: 'smooth', block: 'center' });
        await new Promise(r => setTimeout(r, 500));

        // 尝试打开预览，引入加载等待与重试机制以规避Boss直聘DOM更新竞态
        textEl.textContent = `正在展开第 ${i + 1}/${activeCards.length} 个岗位...`;
        let previewEl = null;
        let loadSuccess = false;
        
        for (let attempt = 1; attempt <= 2; attempt++) {
          logToBackend(`第 ${attempt} 次尝试打开预览...`);
          const opened = await openJobPreview(card);
          logToBackend(`openJobPreview 返回结果: ${opened}`);
          previewEl = findPreviewContainer();
          logToBackend(`findPreviewContainer 返回结果: ${previewEl ? '已找到' : '未找到'}`);
          if (previewEl) {
            logToBackend(`等待预览内容加载，目标岗位: "${fallbackData.title}"...`);
            loadSuccess = await waitForPreviewToLoad(previewEl, fallbackData.title);
            logToBackend(`waitForPreviewToLoad 返回结果: ${loadSuccess}`);
            if (loadSuccess) break;
          }
          console.warn(`${LOG_PREFIX} 第 ${attempt} 次打开/加载岗位 [${fallbackData.title}] 预览未就绪，重试中...`);
          await new Promise(r => setTimeout(r, 800));
        }

        if (!previewEl || !loadSuccess) {
          logToBackend(`[警告] 无法正确打开或加载岗位 [${fallbackData.title}] 的详情，跳过该岗位！`);
          console.warn(`${LOG_PREFIX} 无法正确打开或加载岗位 [${fallbackData.title}] 的详情，跳过该岗位。`);
          continue;
        }
        lastPreviewEl = previewEl;

        // 解析 JD 字段
        const jobData = await parsePreviewDetails(previewEl, fallbackData);
        console.log(`${LOG_PREFIX} 解析到岗位详情:`, jobData);

        // 同步发送给后端
        textEl.textContent = `正在保存 [${jobData.title}] 至后端数据库...`;
        const response = await sendToBackground({
          type: 'SAVE_JOB_POST',
          payload: { jobData }
        });

        if (response && response.ok) {
          successCount++;
          syncedTitles.push(jobData.title);
        }

        // 关闭预览弹层
        await closeJobPreview(previewEl);

        // 更新进度条
        const percent = Math.round(((i + 1) / activeCards.length) * 100);
        fillEl.style.width = `${percent}%`;
      }

      // 同步完成，根据结果展示不同的提示
      if (successCount === 0) {
        iconEl.textContent = '⚠️';
        iconEl.style.animation = 'none';
        titleEl.textContent = '同步未成功';
        descEl.innerHTML = `已扫描到 ${activeCards.length} 个活跃岗位，但由于详情预览窗口未能被识别打开，未能成功同步数据。<br><br>
        <span style="color: #f59e0b; font-size: 13px; text-align: left; display: block; line-height: 1.6;">
        <strong>可能原因：</strong><br>
        1. 岗位详情抽屉未能成功在页面中渲染。<br>
        2. 页面处于非活跃窗口或有其他弹层遮挡。<br>
        请尝试关闭并重新加载页面，并在同步开始后<strong>保持页面在前端展示</strong>。您也可以先手动点击岗位看看是否能正常在右侧展开详情。
        </span>`;
        textEl.textContent = '同步完成 (0 个成功)';
        actionsEl.style.display = 'flex';
        if (debugContainer) debugContainer.style.display = 'block';
      } else {
        iconEl.textContent = '✅';
        iconEl.style.animation = 'none';
        titleEl.textContent = '同步成功！';
        descEl.innerHTML = `已成功同步并激活以下活跃岗位：<br><strong style="color: #10b981; display: block; margin: 10px 0; font-size: 15px;">${syncedTitles.join('、')}</strong>可以在“推荐牛人”中使用这些详细 JD 啦！`;
        textEl.textContent = '所有数据同步已就绪 🚀';
        actionsEl.style.display = 'flex';
        if (debugContainer) debugContainer.style.display = 'none';
      }

    } catch (err) {
      console.error(`${LOG_PREFIX} 同步异常:`, err);
      iconEl.textContent = '❌';
      iconEl.style.animation = 'none';
      titleEl.textContent = '同步出错';
      descEl.textContent = `异常原因: ${err.message}`;
      textEl.textContent = '同步失败';
      actionsEl.style.display = 'flex';
      if (debugContainer) debugContainer.style.display = 'block';
    } finally {
      // 最终，无论如何，都收集页面结构信息供调试，但仅在出错时在 UI 中展示
      try {
        const debugInfo = collectPageDebugInfo(activeCards, lastPreviewEl);
        const debugText = JSON.stringify(debugInfo, null, 2);
        const debugTextarea = document.getElementById('copilot-debug-text');
        if (debugTextarea && debugContainer) {
          debugTextarea.value = debugText;
          
          const copyBtn = document.getElementById('copilot-btn-copy-debug');
          if (copyBtn) {
            copyBtn.onclick = async () => {
              try {
                await navigator.clipboard.writeText(debugText);
                copyBtn.textContent = '✅ 复制成功！请粘贴给 AI';
                copyBtn.style.background = '#10b981';
                setTimeout(() => {
                  copyBtn.textContent = '📋 一键复制页面 HTML 信息 (发给 AI 修复)';
                  copyBtn.style.background = '#6366f1';
                }, 2000);
              } catch (err) {
                alert('复制失败，请手动全选文本框内容复制并发送给 AI！');
              }
            };
          }
        }
      } catch (e) {
        console.error('填充调试信息失败:', e);
      }
    }
  }

  /**
   * 发送给 service worker
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

  let uiCreated = false;
  let lastUrl = '';

  function checkRoute() {
    const currentUrl = window.location.href;
    const isJobList = currentUrl.includes('/web/chat/job/list');

    if (isJobList) {
      if (!uiCreated) {
        injectStyles();
        createUI();
        uiCreated = true;
      }
      const panel = document.getElementById('copilot-sync-floating-panel');
      if (panel) {
        panel.style.display = panelDismissed ? 'none' : 'flex';
      }
    } else {
      const panel = document.getElementById('copilot-sync-floating-panel');
      if (panel) {
        panel.style.display = 'none';
      }
    }

    // 检测到真实的 URL 切换时，重新恢复面板显示（以防用户再次进入职位管理页面需要使用）
    if (currentUrl !== lastUrl) {
      if (isJobList) {
        panelDismissed = false;
      }
      lastUrl = currentUrl;
    }
  }

  // ============================================================
  // 初始化
  // ============================================================
  async function init() {
    console.log(`${LOG_PREFIX} v${VERSION} 已加载`);

    // ★ Preflight Check — 校准 DOM 选择器
    if (window.PreflightCheck) {
      preflightResult = await window.PreflightCheck.run(MODULE_NAME);
      if (!preflightResult.passed) {
        console.error(`${LOG_PREFIX} ❌ DOM 校准失败，业务逻辑已暂停`);
        // 校准失败时仍然显示同步面板，但点击同步时提示校准失败
      } else {
        console.log(`${LOG_PREFIX} ✅ DOM 校准通过${preflightResult.fromCache ? ' (缓存)' : ''}`);
      }
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
