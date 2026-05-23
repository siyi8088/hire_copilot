/**
 * chat-interactor.js
 * Boss直聘聊天交互器 — 负责消息输入和发送
 * 
 * 核心功能：
 * 1. 定位聊天输入框
 * 2. 模拟逐字输入（触发 React/Vue 的 input 事件）
 * 3. 触发发送
 * 
 * 依赖：human-simulator.js（必须先加载）
 */

window.ChatInteractor = (() => {
  'use strict';

  const LOG_PREFIX = '[HireCopilot:Interactor]';

  // ============================================================
  // DOM 选择器（Boss直聘聊天页面）
  // 注意：这些选择器可能随页面更新而变化，需要定期维护
  // ============================================================
  const SELECTORS = {
    // 聊天输入框 — 尝试多种可能的选择器
    INPUT_BOX: [
      'div.chat-input div.chat-editor[contenteditable="true"]',
      'div.chat-input textarea',
      'div[class*="chat-input"] div[contenteditable="true"]',
      'div[class*="editor"][contenteditable="true"]',
      '#chat-input',
    ],

    // 发送按钮
    SEND_BUTTON: [
      'div.chat-input button.btn-send',
      'button[class*="send"]',
      'div.chat-op button.btn-sure',
      'div[class*="chat-input"] button',
    ],

    // 聊天列表中的会话项
    CHAT_LIST_ITEM: [
      'ul.chat-list li',
      'div[class*="chat-list"] li',
      'div.chat-record li',
    ],

    // 消息气泡
    MESSAGE_BUBBLE: [
      'div.chat-message div.item-msg',
      'div[class*="message"] div[class*="msg"]',
      'div.msg-text',
    ],
  };

  // ============================================================
  // DOM 定位工具
  // ============================================================

  /**
   * 尝试多个选择器找到元素
   */
  function findElement(selectorList) {
    for (const selector of selectorList) {
      const el = document.querySelector(selector);
      if (el) return el;
    }
    return null;
  }

  /**
   * 等待元素出现
   */
  function waitForElement(selectorList, timeout = 10000) {
    return new Promise((resolve, reject) => {
      const el = findElement(selectorList);
      if (el) return resolve(el);

      const observer = new MutationObserver(() => {
        const el = findElement(selectorList);
        if (el) {
          observer.disconnect();
          resolve(el);
        }
      });

      observer.observe(document.body, { childList: true, subtree: true });

      setTimeout(() => {
        observer.disconnect();
        reject(new Error(`${LOG_PREFIX} 等待元素超时: ${selectorList[0]}`));
      }, timeout);
    });
  }

  // ============================================================
  // 输入模拟
  // ============================================================

  /**
   * 模拟在 contenteditable div 中逐字输入
   * 触发完整的事件链：focus → keydown → input → keyup
   */
  async function simulateTyping(inputEl, text) {
    const sim = window.HumanSimulator;
    const delays = sim.getTypingDelays(text);

    // 先聚焦输入框
    inputEl.focus();
    inputEl.dispatchEvent(new FocusEvent('focus', { bubbles: true }));
    await sim.sleep(300);

    const isContentEditable = inputEl.getAttribute('contenteditable') === 'true';

    for (let i = 0; i < text.length; i++) {
      const char = text[i];

      // keydown 事件
      inputEl.dispatchEvent(new KeyboardEvent('keydown', {
        key: char,
        code: `Key${char.toUpperCase()}`,
        bubbles: true,
        cancelable: true,
      }));

      // 实际输入字符
      if (isContentEditable) {
        // contenteditable div
        inputEl.textContent += char;
        // 某些框架需要 innerHTML
        inputEl.dispatchEvent(new InputEvent('input', {
          bubbles: true,
          cancelable: true,
          inputType: 'insertText',
          data: char,
        }));
      } else {
        // textarea
        const nativeInputValueSetter = Object.getOwnPropertyDescriptor(
          window.HTMLTextAreaElement.prototype, 'value'
        ).set;
        nativeInputValueSetter.call(inputEl, inputEl.value + char);
        inputEl.dispatchEvent(new Event('input', { bubbles: true }));
      }

      // keyup 事件
      inputEl.dispatchEvent(new KeyboardEvent('keyup', {
        key: char,
        code: `Key${char.toUpperCase()}`,
        bubbles: true,
        cancelable: true,
      }));

      // 等待打字延迟
      await sim.sleep(delays[i]);
    }

    // 触发 change 事件
    inputEl.dispatchEvent(new Event('change', { bubbles: true }));
  }

  /**
   * 清空输入框
   */
  function clearInput(inputEl) {
    const isContentEditable = inputEl.getAttribute('contenteditable') === 'true';
    if (isContentEditable) {
      inputEl.textContent = '';
      inputEl.innerHTML = '';
    } else {
      const nativeInputValueSetter = Object.getOwnPropertyDescriptor(
        window.HTMLTextAreaElement.prototype, 'value'
      ).set;
      nativeInputValueSetter.call(inputEl, '');
    }
    inputEl.dispatchEvent(new Event('input', { bubbles: true }));
  }

  /**
   * 点击发送按钮
   */
  async function clickSend() {
    const sim = window.HumanSimulator;
    const sendBtn = findElement(SELECTORS.SEND_BUTTON);

    if (sendBtn) {
      // 等一下再点发送，模拟检查
      await sim.sleep(sim.clampedGaussian(500, 200, 200, 1200));
      sendBtn.click();
      console.log(`${LOG_PREFIX} 已点击发送按钮`);
      return true;
    }

    // 备选方案：模拟 Enter 键发送
    console.log(`${LOG_PREFIX} 未找到发送按钮，尝试 Enter 键发送`);
    const inputEl = findElement(SELECTORS.INPUT_BOX);
    if (inputEl) {
      inputEl.dispatchEvent(new KeyboardEvent('keydown', {
        key: 'Enter',
        code: 'Enter',
        keyCode: 13,
        which: 13,
        bubbles: true,
        cancelable: true,
      }));
      return true;
    }

    console.error(`${LOG_PREFIX} 无法发送消息：找不到发送按钮或输入框`);
    return false;
  }

  // ============================================================
  // 高级发送功能
  // ============================================================

  /**
   * 发送单条消息（完整流程：输入 → 发送）
   */
  async function sendMessage(text) {
    try {
      const inputEl = await waitForElement(SELECTORS.INPUT_BOX);
      clearInput(inputEl);
      await simulateTyping(inputEl, text);
      const sent = await clickSend();
      if (sent) {
        console.log(`${LOG_PREFIX} 消息已发送: "${text.substring(0, 20)}..."`);
      }
      return sent;
    } catch (err) {
      console.error(`${LOG_PREFIX} 发送消息失败:`, err);
      return false;
    }
  }

  /**
   * 发送多段消息（长回复拆分发送）
   */
  async function sendSegmentedMessage(fullText) {
    const sim = window.HumanSimulator;
    const segments = sim.segmentMessage(fullText);

    console.log(`${LOG_PREFIX} 将分 ${segments.length} 段发送`);

    for (let i = 0; i < segments.length; i++) {
      const success = await sendMessage(segments[i]);
      if (!success) return false;

      // 段间延迟
      if (i < segments.length - 1) {
        const delay = sim.getSegmentDelay();
        console.log(`${LOG_PREFIX} 段间等待 ${(delay / 1000).toFixed(1)}s`);
        await sim.sleep(delay);
      }
    }
    return true;
  }

  /**
   * 获取当前聊天窗口的所有可见消息
   */
  function getVisibleMessages() {
    const messages = [];

    // 尝试多种选择器
    for (const selector of SELECTORS.MESSAGE_BUBBLE) {
      const elements = document.querySelectorAll(selector);
      if (elements.length > 0) {
        elements.forEach(el => {
          const text = el.textContent?.trim();
          if (text) {
            // 判断是对方发的还是自己发的
            const parentClasses = el.closest('[class]')?.className || '';
            const isSelf = /self|right|mine|send/.test(parentClasses);
            messages.push({
              text,
              isSelf,
              timestamp: Date.now(),
            });
          }
        });
        break;
      }
    }

    return messages;
  }

  // ============================================================
  // 公共 API
  // ============================================================
  return {
    SELECTORS,
    findElement,
    waitForElement,
    sendMessage,
    sendSegmentedMessage,
    getVisibleMessages,
    clearInput,
  };
})();
