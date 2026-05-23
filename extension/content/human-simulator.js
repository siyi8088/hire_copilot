/**
 * human-simulator.js
 * 拟人化行为模拟器 — 让所有自动化操作看起来像真人
 * 
 * 核心原则：
 * 1. 所有延迟使用高斯分布，而非均匀分布
 * 2. 打字节奏有快有慢，模拟真人的思考停顿
 * 3. 偶尔产生"误操作"增加真实感
 */

window.HumanSimulator = (() => {
  'use strict';

  // ============================================================
  // 配置常量
  // ============================================================
  const CONFIG = {
    // 阅读消息后的思考时间（毫秒）
    THINK_DELAY_MEAN: 15000,      // 平均 15 秒
    THINK_DELAY_STD: 8000,        // 标准差 8 秒
    THINK_DELAY_MIN: 5000,        // 最少 5 秒
    THINK_DELAY_MAX: 60000,       // 最多 60 秒

    // 打字速度（每字符毫秒数）
    TYPE_SPEED_MEAN: 150,         // 平均 150ms/字符
    TYPE_SPEED_STD: 60,           // 标准差
    TYPE_SPEED_MIN: 60,           // 最快 60ms
    TYPE_SPEED_MAX: 350,          // 最慢 350ms

    // 打字中的停顿（模拟思考）
    TYPE_PAUSE_PROBABILITY: 0.08, // 8% 概率在某个字符后停顿
    TYPE_PAUSE_MEAN: 1500,        // 停顿平均 1.5 秒
    TYPE_PAUSE_STD: 800,

    // 分段发送（长消息拆成多条）
    SEGMENT_DELAY_MEAN: 4000,     // 段间延迟平均 4 秒
    SEGMENT_DELAY_STD: 2000,

    // 工作时间窗口
    WORK_HOURS: {
      start: 9,   // 早上 9 点
      end: 21,    // 晚上 9 点
    },

    // 连续工作时长限制（毫秒）
    MAX_CONTINUOUS_WORK: 2 * 60 * 60 * 1000,  // 2 小时
    REST_DURATION_MEAN: 15 * 60 * 1000,        // 休息 15 分钟
    REST_DURATION_STD: 5 * 60 * 1000,
  };

  // ============================================================
  // 随机数工具
  // ============================================================

  /**
   * Box-Muller 变换生成高斯分布随机数
   */
  function gaussianRandom(mean, std) {
    let u1 = Math.random();
    let u2 = Math.random();
    // 避免 log(0)
    while (u1 === 0) u1 = Math.random();
    const z = Math.sqrt(-2.0 * Math.log(u1)) * Math.cos(2.0 * Math.PI * u2);
    return mean + z * std;
  }

  /**
   * 带上下界的高斯随机数
   */
  function clampedGaussian(mean, std, min, max) {
    let value = gaussianRandom(mean, std);
    return Math.max(min, Math.min(max, Math.round(value)));
  }

  // ============================================================
  // 延迟生成器
  // ============================================================

  /**
   * 生成"阅读并思考"的延迟时间
   * @param {string} messageText - 收到的消息文本（越长思考越久）
   * @returns {number} 延迟毫秒数
   */
  function getThinkDelay(messageText = '') {
    // 根据消息长度调整：每 10 个字符增加 500ms
    const lengthBonus = Math.min((messageText.length / 10) * 500, 10000);
    return clampedGaussian(
      CONFIG.THINK_DELAY_MEAN + lengthBonus,
      CONFIG.THINK_DELAY_STD,
      CONFIG.THINK_DELAY_MIN,
      CONFIG.THINK_DELAY_MAX
    );
  }

  /**
   * 生成打字速度序列
   * @param {string} text - 要输入的文本
   * @returns {number[]} 每个字符的输入延迟数组
   */
  function getTypingDelays(text) {
    const delays = [];
    for (let i = 0; i < text.length; i++) {
      let delay = clampedGaussian(
        CONFIG.TYPE_SPEED_MEAN,
        CONFIG.TYPE_SPEED_STD,
        CONFIG.TYPE_SPEED_MIN,
        CONFIG.TYPE_SPEED_MAX
      );

      // 标点符号后稍微停顿久一点
      const char = text[i];
      if (/[，。！？、；：,.!?;:]/.test(char)) {
        delay += clampedGaussian(300, 150, 100, 800);
      }

      // 随机思考停顿
      if (Math.random() < CONFIG.TYPE_PAUSE_PROBABILITY) {
        delay += clampedGaussian(
          CONFIG.TYPE_PAUSE_MEAN,
          CONFIG.TYPE_PAUSE_STD,
          500,
          4000
        );
      }

      delays.push(delay);
    }
    return delays;
  }

  /**
   * 将长消息拆分为多段
   * @param {string} text - 完整回复文本
   * @returns {string[]} 拆分后的消息数组
   */
  function segmentMessage(text) {
    // 短消息不拆分
    if (text.length <= 50) return [text];

    // 按自然断句拆分
    const sentences = text.split(/(?<=[。！？\n])/g).filter(s => s.trim());

    // 合并过短的句子
    const segments = [];
    let current = '';
    for (const sentence of sentences) {
      if (current.length + sentence.length > 80 && current.length > 0) {
        segments.push(current.trim());
        current = sentence;
      } else {
        current += sentence;
      }
    }
    if (current.trim()) segments.push(current.trim());

    // 最多拆成 3 段
    if (segments.length > 3) {
      const merged = [];
      const chunkSize = Math.ceil(segments.length / 3);
      for (let i = 0; i < segments.length; i += chunkSize) {
        merged.push(segments.slice(i, i + chunkSize).join(''));
      }
      return merged;
    }

    return segments.length > 0 ? segments : [text];
  }

  /**
   * 获取段间延迟
   */
  function getSegmentDelay() {
    return clampedGaussian(
      CONFIG.SEGMENT_DELAY_MEAN,
      CONFIG.SEGMENT_DELAY_STD,
      2000,
      10000
    );
  }

  // ============================================================
  // 工作时间控制
  // ============================================================

  let workStartTime = null;

  /**
   * 检查当前是否在工作时间窗口内
   */
  function isWithinWorkHours() {
    const hour = new Date().getHours();
    return hour >= CONFIG.WORK_HOURS.start && hour < CONFIG.WORK_HOURS.end;
  }

  /**
   * 检查是否需要休息（连续工作太久）
   */
  function needsRest() {
    if (!workStartTime) {
      workStartTime = Date.now();
      return false;
    }
    return (Date.now() - workStartTime) > CONFIG.MAX_CONTINUOUS_WORK;
  }

  /**
   * 获取休息时长
   */
  function getRestDuration() {
    workStartTime = null; // 重置工作开始时间
    return clampedGaussian(
      CONFIG.REST_DURATION_MEAN,
      CONFIG.REST_DURATION_STD,
      5 * 60 * 1000,
      30 * 60 * 1000
    );
  }

  /**
   * 通用的 sleep 函数
   */
  function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  // ============================================================
  // 公共 API
  // ============================================================
  return {
    CONFIG,
    gaussianRandom,
    clampedGaussian,
    getThinkDelay,
    getTypingDelays,
    segmentMessage,
    getSegmentDelay,
    isWithinWorkHours,
    needsRest,
    getRestDuration,
    sleep,
  };
})();
