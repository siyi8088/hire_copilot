/**
 * selector-registry.js
 * 集中式 DOM 选择器注册表
 *
 * 将所有 content script 中使用的 CSS 选择器集中到此文件管理。
 * Boss直聘前端频繁改版时，只需更新此文件即可。
 *
 * 每个选择器定义包含：
 *   candidates  - 按优先级排列的选择器候选列表
 *   verify      - 校验规则（minCount / textContains / textEquals）
 *   critical    - 是否为关键选择器（关键选择器失败会阻止业务逻辑执行）
 *   searchIframes - 是否需要穿透 iframe 查找（默认 true）
 */

window.SelectorRegistry = (() => {
  'use strict';

  const modules = {

    // ================================================================
    // 职位同步模块 — /web/chat/job/list
    // ================================================================
    jobSyncer: {
      pagePattern: '/web/chat/job/list',
      selectors: {

        // 岗位卡片列表
        JOB_CARD: {
          candidates: [
            'li.job-jobInfo-warp',
            'li[class*="job-jobInfo"]',
            'li[class*="jobInfo"]',
            'div.job-item',
            'div.job-card',
            'div[class*="job-card"]',
            'div[class*="job-item"]',
            'div[class*="position-item"]',
            'li.job-card',
            '.job-list-item',
          ],
          verify: { minCount: 1, textContains: ['编辑'] },
          critical: true,
          searchIframes: true,
        },

        // 岗位卡片内的标题
        JOB_CARD_TITLE: {
          candidates: [
            'div.job-title',
            '.job-title',
            '.job-name',
            '.name',
            'span.name',
            'a.job-name',
            'h3',
            'div.title',
          ],
          verify: { minCount: 0 },
          critical: false,
          searchIframes: true,
        },

        // 三个点按钮 / 更多操作
        MORE_OPERATE_BTN: {
          candidates: [
            'div.job-operate-wrapper',
            '.job-operate-wrapper',
            '[class*="job-operate"]',
            '.dot',
            '.more-operate',
            '[class*="more-operate"]',
          ],
          verify: { minCount: 0 },
          critical: false,
          searchIframes: true,
        },

        // 下拉菜单中的操作项
        OPERATE_MENU_ITEM: {
          candidates: [
            '.job-operate-item',
            '.job-operate-container li',
            '.operation-container a',
            '.opreat-btn',
            'li',
            'a',
            'span',
          ],
          verify: { minCount: 0, textContains: ['预览'] },
          critical: false,
          searchIframes: true,
        },

        // 预览容器（抽屉/弹窗/面板）
        PREVIEW_CONTAINER: {
          candidates: [
            'div[class*="drawer"]',
            'section[class*="drawer"]',
            'aside[class*="drawer"]',
            'div[class*="dialog"]',
            'div[class*="modal"]',
            'div[class*="detail"]',
            'section[class*="detail"]',
            'aside[class*="detail"]',
            'div[class*="preview"]',
            'section[class*="preview"]',
            'div[class*="popup"]',
            'div[class*="aside"]',
            'div[class*="pane"]',
            'div[class*="panel"]',
            'div[class*="wrap"]',
            '.detail-dialog',
            '.job-detail-box',
            '.job-detail-dialog',
            '.job-detail-drawer',
            '.job-drawer',
            '.job-preview',
            '.preview-drawer',
            '.preview-box',
            '.preview-container',
            '.detail-box',
            '.detail-container',
            '.chat-right',
            '.job-detail',
            '.chat-detail',
            '.chat-info',
          ],
          verify: { minCount: 0 },
          critical: false,
          searchIframes: true,
        },

        // 预览容器内关闭按钮
        PREVIEW_CLOSE_BTN: {
          candidates: [
            'button[class*="close"]',
            'span[class*="close"]',
            'a[class*="close"]',
            '[class*="icon-close"]',
            '.close',
          ],
          verify: { minCount: 0 },
          critical: false,
          searchIframes: false,
        },
      },
    },

    // ================================================================
    // 推荐牛人模块 — /web/chat/recommend
    // ================================================================
    recommendGreeter: {
      pagePattern: '/web/chat/recommend',
      selectors: {

        // 候选人卡片列表容器
        CARD_CONTAINER: {
          candidates: [
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
          verify: { minCount: 1 },
          critical: true,
          searchIframes: true,
        },

        // 单个候选人卡片
        CARD_ITEM: {
          candidates: [
            'li.card-item',
            'div.candidate-card-wrap',
            'div.recommend-card-item',
            'div[class*="card-item"]',
            'li[class*="card"]',
            'div[class*="candidate-card"]',
            'div.card-inner',
          ],
          verify: { minCount: 1 },
          critical: true,
          searchIframes: true,
        },

        // 卡片内 - 姓名
        CARD_NAME: {
          candidates: [
            'span.name',
            '.name-text',
            '[class*="name"]',
          ],
          verify: { minCount: 1 },
          critical: true,
        },

        // 卡片内 - 在线状态
        CARD_ONLINE: {
          candidates: [
            '.active-text',
            'span.status',
            '.active-tag',
            '[class*="active-status"]',
            '[class*="online"]',
          ],
          verify: { minCount: 0 },
          critical: false,
        },

        // 卡片内 - 基本信息
        CARD_BASE_INFO: {
          candidates: [
            '.base-info',
            '.info-text',
            'span[class*="info"]',
          ],
          verify: { minCount: 0 },
          critical: false,
        },

        // 卡片内 - 期望薪资
        CARD_SALARY: {
          candidates: [
            '.salary-wrap',
            '.expect-salary',
            '.salary-tag',
            'span[class*="salary"]',
            'span[class*="expect"]',
            '.tag-salary',
          ],
          verify: { minCount: 0 },
          critical: false,
        },

        // 卡片内 - 期望职位
        CARD_EXPECT: {
          candidates: [
            '.expect-wrap',
            '.expect-position',
            '.expect-info',
            '[class*="expect"]',
          ],
          verify: { minCount: 0 },
          critical: false,
        },

        // 卡片内 - 优势描述
        CARD_ADVANTAGE: {
          candidates: [
            '.geek-desc',
            '.advantage-text',
            '.desc-text',
            '[class*="advantage"]',
            '[class*="优势"]',
          ],
          verify: { minCount: 0 },
          critical: false,
        },

        // 卡片内 - 技术标签
        CARD_TAGS: {
          candidates: [
            '.tags-wrap .tag-item',
            '.tag-list span',
            '.skill-tags span',
            '.tag-item',
            '[class*="tag"] span',
            '[class*="skill"] span',
          ],
          verify: { minCount: 0 },
          critical: false,
        },

        // 卡片内 - 工作经历
        CARD_EXPERIENCE: {
          candidates: [
            '.work-exps',
            '.timeline-wrap',
            '.work-history',
            '.experience-list',
            '[class*="history"]',
            '[class*="experience"]',
          ],
          verify: { minCount: 0 },
          critical: false,
        },

        // 打招呼按钮
        GREET_BUTTON: {
          candidates: [
            'button.btn-greet',
            'button.greet-btn',
            'a.greet-btn',
            '.btn-greet',
            'button[class*="greet"]',
            'a[class*="greet"]',
            'span[class*="greet"]',
          ],
          verify: { minCount: 0, textContains: ['打招呼', '沟通', '聊一聊'] },
          critical: true,
          searchIframes: true,
        },

        // 当前活跃岗位选择器（页面顶部的岗位下拉框）
        JOB_SELECT: {
          candidates: [
            '.job-selecter-wrap .ui-dropmenu-label',
            '.ui-dropmenu-label',
            '.job-selecter-wrap',
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
            'span[class*="select-val"]',
            'span[class*="cur-name"]',
            'div[class*="select-val"]',
          ],
          verify: { minCount: 0 },
          critical: false,
          searchIframes: true,
        },
      },
    },

    // ================================================================
    // 聊天观察模块 — /web/geek/chat
    // ================================================================
    chatObserver: {
      pagePattern: '/web/chat/index',
      selectors: {
        // 聊天列表（左侧会话列表）
        CHAT_LIST: {
          candidates: [
            'div.user-list',
            '.user-list',
            'ul.chat-list',
            'div[class*="chat-list"]',
            'div[class*="session-list"]',
          ],
          verify: { minCount: 1 },
          critical: true,
          searchIframes: false,
        },

        // 聊天列表中的每个会话项
        CHAT_LIST_ITEM: {
          candidates: [
            '.geek-item',
            'ul.chat-list li',
            'div[class*="chat-list"] li',
            'div.chat-record li',
          ],
          verify: { minCount: 1 },
          critical: true,
          searchIframes: false,
        },

        // 活跃的聊天列表项
        ACTIVE_CHAT_ITEM: {
          candidates: [
            '.user-list .geek-item.selected',
            '.user-list .geek-item.active',
            'ul.chat-list li.active',
            'div[class*="chat-list"] li.active',
            'div[class*="session-list"] li.active',
            '.geek-item.selected',
            '.geek-item.active',
            '.user-list li.active',
            '.chat-list li.active',
            '.session-list li.active',
          ],
          verify: { minCount: 0 },
          critical: false,
          searchIframes: false,
        },
      },
    },

    chatConversation: {
      pagePattern: '/web/chat/index',
      selectors: {
        // 聊天消息容器
        CHAT_CONTAINER: {
          candidates: [
            'div.chat-conversation',
            'div.chat-record',
            'div[class*="chat-message-list"]',
            'div[class*="message-list"]',
            'div[class*="chat-content"]',
          ],
          verify: { minCount: 1 },
          critical: true,
          searchIframes: false,
        },

        // 消息气泡
        MESSAGE_BUBBLE: {
          candidates: [
            'div[class*="message"]',
            'div[class*="msg"]',
            'span[class*="text"]',
          ],
          verify: { minCount: 0 },
          critical: false,
          searchIframes: false,
        },

        // 聊天头部 - 候选人姓名
        CHAT_HEADER_NAME: {
          candidates: [
            '.name-box',
            '.base-name',
            '.chat-top .name',
            '.chat-header .name',
            'div[class*="chat-top"] [class*="name"]',
            'div[class*="chat-header"] [class*="name"]',
            '.active-chat-name',
            'div.dialog-title span.name',
          ],
          verify: { minCount: 0 },
          critical: false,
          searchIframes: false,
        },

        // 聊天侧栏 - 岗位名称
        JOB_TITLE: {
          candidates: [
            '.position-name',
            '.job-content .position-name',
            '.chat-job .job-title',
            '.job-detail .name',
            '.chat-detail .job-name',
            'div[class*="job"] [class*="title"]',
            '.resume-detail .job-title',
            '.chat-right .position-name',
            'a[class*="job"] .title',
            '.chat-info .job-name',
          ],
          verify: { minCount: 0 },
          critical: false,
          searchIframes: false,
        },

        // 聊天侧栏 - 薪资
        JOB_SALARY: {
          candidates: [
            '.expect .high-light-orange',
            '.expect .value i',
            '.chat-job .salary',
            '.job-detail .salary',
            'div[class*="job"] [class*="salary"]',
            'div[class*="job"] [class*="pay"]',
            '.chat-right .salary',
            'span[class*="red"]',
          ],
          verify: { minCount: 0 },
          critical: false,
          searchIframes: false,
        },

        // 聊天侧栏 - 要求
        JOB_REQUIREMENTS: {
          candidates: [
            '.chat-job .info-labels',
            '.job-detail .require',
            '.job-detail .job-info',
            'div[class*="job"] [class*="require"]',
            'div[class*="job"] [class*="info"]',
            '.chat-right .job-require',
          ],
          verify: { minCount: 0 },
          critical: false,
          searchIframes: false,
        },

        // 聊天侧栏 - JD 描述
        JOB_DESCRIPTION: {
          candidates: [
            '.chat-job .job-desc',
            '.job-detail .desc',
            '.job-detail .text',
            'div[class*="job"] [class*="desc"]',
            '.chat-right .job-desc',
          ],
          verify: { minCount: 0 },
          critical: false,
          searchIframes: false,
        },

        // 聊天侧栏 - 公司名
        JOB_COMPANY: {
          candidates: [
            '.chat-job .company-name',
            '.job-detail .company',
            'div[class*="company"] [class*="name"]',
            '.chat-right .company-name',
            '.chat-info .company',
          ],
          verify: { minCount: 0 },
          critical: false,
          searchIframes: false,
        },

        // 聊天头部区域（备选岗位提取）
        CHAT_HEADER_AREA: {
          candidates: [
            '.base-info-single-container',
            '.base-info-single-top-detail',
            '.chat-header',
            '.chat-top',
            'div[class*="chat-info"]',
            'div[class*="dialog-title"]',
          ],
          verify: { minCount: 0 },
          critical: false,
          searchIframes: false,
        },

        // 简历栏候选人姓名
        RESUME_NAME: {
          candidates: [
            '.resume-detail .name',
            '.resume-custom .name',
            'div[class*="resume"] [class*="name"]',
          ],
          verify: { minCount: 0 },
          critical: false,
          searchIframes: false,
        },
      },
    },
  };

  // ================================================================
  // 公共 API
  // ================================================================
  return {
    modules,

    /**
     * 获取指定模块的所有选择器定义
     */
    getModule(moduleName) {
      return modules[moduleName] || null;
    },

    /**
     * 获取指定模块中某个选择器的 candidates 列表
     */
    getCandidates(moduleName, selectorName) {
      const mod = modules[moduleName];
      if (!mod) return [];
      const sel = mod.selectors[selectorName];
      return sel ? sel.candidates : [];
    },

    /**
     * 获取指定模块的 pagePattern
     */
    getPagePattern(moduleName) {
      const mod = modules[moduleName];
      return mod ? mod.pagePattern : null;
    },

    /**
     * 列出所有模块名
     */
    listModules() {
      return Object.keys(modules);
    },
  };
})();
