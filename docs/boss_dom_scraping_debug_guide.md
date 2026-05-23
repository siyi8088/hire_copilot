# Boss直聘 DOM 抓取与动态调试指南 (Scraping Debug Skill)

由于 Boss直聘（zhipin.com）前端采用了频繁迭代的混淆类名、深层嵌套的同源 Iframe 以及动态渲染的交互组件，直接在代码中硬编码静态选择器极易在页面更新时失效。

为了提高调试效率、避免人工通过开发者工具排查的繁琐，本项目沉淀了一套 **“前端调试收集器 + 剪贴板一键复制”** 的调试设计模式（Debug Skill）。任何页面抓取逻辑（岗位同步、推荐扫描、聊天捕获等）若遇到结构失效，应遵循本指南进行排查和重构。

---

## 💡 核心设计模式：一键网页 HTML 调试收集器

当同步或抓取逻辑执行完毕（或失败）后，在插件注入的 UI 弹窗内渲染一个调试区域，搜集当前页面的关键 DOM 特征，并提供一键复制按钮。

### 1. 调试收集器的实现代码模板

在 Content Script 中，可以内置如下搜集函数：

```javascript
/**
 * 收集页面 HTML 结构进行调试，用于针对性分析选择器
 * @param {Array} activeCards - 扫描到的主列表卡片 DOM 数组
 * @param {HTMLElement} previewEl - 展开的抽屉/详情面板 DOM 元素
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

  // 1. 针对表单编辑类页面，抓取前 100+ 个输入框和对应文本（由于编辑页面值存在于 value 而非 textContent）
  const container = previewEl || document.body;
  try {
    const inputs = container.querySelectorAll('input, textarea, select, button, label, h1, h2, h3, [class*="title"], [class*="name"]');
    const items = [];
    inputs.forEach((el, index) => {
      if (index > 120) return; // 限制大小，防止 clipboard 溢出
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

  // 2. 兜底抓取父容器结构
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
```

### 2. UI 面板结构与复制绑定

在注入的玻璃拟态 Overlay 中，包含如下调试面板：

```html
<div id="copilot-debug-container" style="margin-top: 20px; display: none; text-align: left;">
  <button class="copilot-action-btn" id="copilot-btn-copy-debug" style="width: 100%; margin-bottom: 10px; background: #6366f1; color: white;">
    📋 一键复制页面 HTML 信息 (发给 AI 修复)
  </button>
  <textarea id="copilot-debug-text" style="width: 100%; height: 120px; background: #111827; color: #9ca3af; border: 1px solid #374151; border-radius: 6px; padding: 8px; font-size: 11px; font-family: monospace;" readonly></textarea>
</div>
```

在同步流程完成的 `finally` 块中执行渲染：

```javascript
try {
  const debugInfo = collectPageDebugInfo(activeCards, lastPreviewEl);
  const debugText = JSON.stringify(debugInfo, null, 2);
  const debugTextarea = document.getElementById('copilot-debug-text');
  if (debugTextarea) {
    debugTextarea.value = debugText;
    document.getElementById('copilot-debug-container').style.display = 'block';
    
    document.getElementById('copilot-btn-copy-debug').onclick = async () => {
      await navigator.clipboard.writeText(debugText);
      // 提供复制成功的 UI 反馈...
    };
  }
} catch (e) {
  console.error('填充调试信息失败:', e);
}
```

---

## ⚠️ Boss直聘 抓取常见踩坑点与适配技巧

### 1. 表单元素（编辑/发布职位抽屉）
- **现象**：通过 `textContent` 拿不到岗位名、职责描述和任职要求，提取出来的字符串为空或仅仅是提示文案。
- **原因**：编辑页面中，岗位标题和 JD 都是由 `<input>` 和 `<textarea>` 输入框承载的，其真实数据在 `value` 属性中，而非子文本节点。
- **对策**：如果检测到容器内存在 `input` 或 `textarea`，应当优先通过 `.value` 获取用户输入。

### 2. 交互点击导致新标签页跳转及三点菜单“预览”优化
- **现象**：调用 `click()` 触发抽屉打开时，浏览器突然弹窗或跳转到了外部的岗位详情公网 URL，而当前页的抽屉没能出来。
- **原因**：岗位卡片中的职位名称通常是用带有 `target="_blank"` 属性的 `<a>` 链接标签渲染的。直接点击它会触发浏览器默认的跳转新标签页行为。
- **最佳实践：三点菜单级联预览**：
  在岗位卡片上，编辑按钮旁边一般有三个点（`...`）更多操作按钮。点击它会弹出下拉菜单，其中包含一个 **“预览”** 选项。点击此“预览”可以直接在当前页面弹出一个静态预览抽屉，完全不用进入“编辑”表单页面，读取效率极高，且绝对不会触发标签页跳转。
- **代码交互顺序对策**：
  1. **首选**：点击三个点 `...` ➔ 等待菜单展开 ➔ 点击“预览”菜单项（可用文本 “预览” 过滤且宽度 > 0 的项） ➔ 获取静态预览抽屉。
  2. **降级备选 1**：寻找没有 `href` 属性的直属点击元素（如纯文本 “编辑” 或 “查看详情” 等）。
  3. **降级备选 2**：直接点击卡片行最外层容器 `cardEl.click()`。

### 3. 同源嵌套 Iframe 穿透与样式查找
- **现象**：在新版后台页面中，很多子模块是用 Iframe 嵌入的。调用 `document.querySelector` 根本找不到卡片或抽屉。
- **原因**：同源 Iframe 处于另一个 `window` 和 `document` 下，需要穿透查找。同时，在跨 window 上下文下使用 `window.getComputedStyle(el)` 会报错或拿不到正确的布局高度。
- **对策**：
  - 使用递归 `findAllElements(selector, parent)` 函数查找所有同源 Iframe 的子文档。
  - 获取样式时必须使用元素所属文档的 defaultView：`const win = el.ownerDocument.defaultView || window; win.getComputedStyle(el);`。

### 4. 动态 Class 兜底逻辑
- **现象**：Boss 使用类似 CSS Modules 的随机哈希后缀（如 `class="drawer-wrap___3aBcD"`）。
- **对策**：
  - 尽量使用模糊类名匹配，如 `div[class*="drawer"]`。
  - 若失效，采用 **“元素特征 + 祖先回溯”**：遍历所有可见的 `div, section, aside` 元素，如果检测到文本包含特定的 JD 关键字且大小合适，则沿着 `parentElement` 向上回溯，直到找到带有定位属性的父容器，将其作为抓取的目标面板。
