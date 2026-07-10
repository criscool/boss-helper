// ==UserScript==
// @name         BOSS Helper
// @namespace    local.boss-helper
// @version      0.1.0
// @description  Configurable on-page helper for contacting recruiters on BOSS Zhipin job pages.
// @match        https://zhipin.com/*
// @match        https://www.zhipin.com/*
// @match        https://*.zhipin.com/*
// @run-at       document-idle
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_deleteValue
// ==/UserScript==

(function () {
  "use strict";

  const PANEL_ID = "boss-helper-panel";
  const STORAGE_KEYS = {
    settings: "bossHelper.settings",
    stats: "bossHelper.stats",
    logs: "bossHelper.logs"
  };

  const DEFAULT_SETTINGS = {
    intervalSeconds: 60,
    dailyMax: 150,
    includeKeywords: "测试开发,测试工程师,软件测试,自动化测试,测开,QA,质量",
    excludeKeywords: "网络销售,电话销售,销售,客服,社群销售,电销,地推,招商,顾问",
    detailWaitMs: 2000,
    modalWaitMs: 5000,
    scrollWaitMs: 2500,
    maxConsecutiveFailures: 3
  };

  const MODE = {
    idle: "IDLE",
    running: "RUNNING",
    paused: "PAUSED",
    stopped: "STOPPED",
    error: "ERROR"
  };

  const STATUS_LABELS = {
    IDLE: "空闲",
    RUNNING: "运行中",
    PAUSED: "暂停",
    STOPPED: "已停止",
    ERROR: "异常停止"
  };

  const RISK_TEXTS = [
    "验证码",
    "安全验证",
    "身份验证",
    "请先登录",
    "异常访问",
    "访问过于频繁",
    "操作过于频繁",
    "账号存在风险",
    "账户存在风险",
    "当前操作存在风险",
    "安全风险",
    "请稍后再试"
  ];

  const SKIP_ACTION_TEXTS = [
    "继续沟通",
    "已沟通",
    "去App",
    "去APP",
    "扫码",
    "下载"
  ];

  const JOB_CARD_SELECTORS = [
    ".job-card-wrapper",
    ".job-card-box",
    ".job-list-box li",
    "[class*='job-card']",
    "[class*='job-list'] li"
  ];

  const BUTTON_LIKE_SELECTORS = [
    "button",
    "a",
    ".btn",
    "[class*='btn']",
    "[role='button']"
  ];

  const state = {
    mode: MODE.idle,
    isRunning: false,
    settings: loadSettings(),
    stats: loadStats(),
    logs: loadLogs(),
    visitedJobKeys: new Set(),
    consecutiveFailures: 0,
    currentMessage: "等待开始"
  };

  function gmGet(key, fallback) {
    if (typeof GM_getValue === "function") return GM_getValue(key, fallback);
    try {
      const raw = window.localStorage.getItem(key);
      return raw ? JSON.parse(raw) : fallback;
    } catch (_error) {
      return fallback;
    }
  }

  function gmSet(key, value) {
    if (typeof GM_setValue === "function") {
      GM_setValue(key, value);
      return;
    }
    window.localStorage.setItem(key, JSON.stringify(value));
  }

  function todayKey(date = new Date()) {
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, "0");
    const day = String(date.getDate()).padStart(2, "0");
    return `${year}-${month}-${day}`;
  }

  function freshStats(date = todayKey()) {
    return {
      date,
      success: 0,
      skipped: 0,
      failed: 0
    };
  }

  function shouldResetStats(stats, date = todayKey()) {
    return !stats || stats.date !== date;
  }

  function loadStats() {
    const stored = gmGet(STORAGE_KEYS.stats, null);
    return shouldResetStats(stored) ? freshStats() : stored;
  }

  function saveStats() {
    gmSet(STORAGE_KEYS.stats, state.stats);
  }

  function clampInteger(value, min, max, fallback) {
    const number = Number.parseInt(value, 10);
    if (!Number.isFinite(number)) return fallback;
    return Math.min(max, Math.max(min, number));
  }

  function loadSettings() {
    const stored = gmGet(STORAGE_KEYS.settings, {});
    return {
      ...DEFAULT_SETTINGS,
      ...stored,
      intervalSeconds: clampInteger(stored.intervalSeconds, 5, 3600, DEFAULT_SETTINGS.intervalSeconds),
      dailyMax: clampInteger(stored.dailyMax, 1, 1000, DEFAULT_SETTINGS.dailyMax),
      includeKeywords: typeof stored.includeKeywords === "string" ? stored.includeKeywords : DEFAULT_SETTINGS.includeKeywords,
      excludeKeywords: typeof stored.excludeKeywords === "string" ? stored.excludeKeywords : DEFAULT_SETTINGS.excludeKeywords
    };
  }

  function saveSettings(nextSettings) {
    state.settings = {
      ...state.settings,
      intervalSeconds: clampInteger(nextSettings.intervalSeconds, 5, 3600, DEFAULT_SETTINGS.intervalSeconds),
      dailyMax: clampInteger(nextSettings.dailyMax, 1, 1000, DEFAULT_SETTINGS.dailyMax),
      includeKeywords: normalizeTextValue(nextSettings.includeKeywords ?? state.settings.includeKeywords),
      excludeKeywords: normalizeTextValue(nextSettings.excludeKeywords ?? state.settings.excludeKeywords)
    };
    gmSet(STORAGE_KEYS.settings, state.settings);
    updatePanel();
  }

  function loadLogs() {
    const stored = gmGet(STORAGE_KEYS.logs, []);
    return Array.isArray(stored) ? stored.slice(-100) : [];
  }

  function saveLogs() {
    gmSet(STORAGE_KEYS.logs, state.logs.slice(-100));
  }

  function timeLabel() {
    return new Date().toLocaleTimeString("zh-CN", { hour12: false });
  }

  function addLog(message) {
    const line = `[${timeLabel()}] ${message}`;
    state.logs.push(line);
    state.logs = state.logs.slice(-100);
    saveLogs();
    updatePanel();
  }

  function normalizedText(element) {
    return (element?.innerText || element?.textContent || "").replace(/\s+/g, " ").trim();
  }

  function normalizeTextValue(text) {
    return String(text || "").replace(/\s+/g, " ").trim();
  }

  function classifyActionText(text) {
    const value = normalizeTextValue(text);
    if (value === "立即沟通" || value.includes("立即沟通")) return "communicate";
    if (SKIP_ACTION_TEXTS.some((skipText) => value.includes(skipText))) return "skip";
    return "unknown";
  }

  function containsRiskText(text) {
    const value = normalizeTextValue(text);
    return RISK_TEXTS.some((riskText) => value.includes(riskText));
  }

  function pickStayButtonText(buttonTexts) {
    const values = buttonTexts.map(normalizeTextValue);
    return values.includes("留在此页") ? "留在此页" : null;
  }

  function parseKeywords(value) {
    return String(value || "")
      .split(/[\s,，、;；|]+/)
      .map((keyword) => keyword.trim())
      .filter(Boolean);
  }

  function containsAnyKeyword(text, keywords) {
    const value = normalizeTextValue(text).toLowerCase();
    return keywords.some((keyword) => value.includes(keyword.toLowerCase()));
  }

  function getKeywordSkipReason(text, settings = state.settings) {
    const includeKeywords = parseKeywords(settings.includeKeywords);
    const excludeKeywords = parseKeywords(settings.excludeKeywords);

    const excluded = excludeKeywords.find((keyword) => normalizeTextValue(text).toLowerCase().includes(keyword.toLowerCase()));
    if (excluded) return `命中排除词：${excluded}`;

    if (includeKeywords.length > 0 && !containsAnyKeyword(text, includeKeywords)) {
      return `未命中必须包含：${includeKeywords.slice(0, 5).join("/")}`;
    }

    return "";
  }

  function shouldSkipByKeyword(text, settings = state.settings) {
    return Boolean(getKeywordSkipReason(text, settings));
  }

  function getIncludeKeywordReason(text, settings = state.settings) {
    const includeKeywords = parseKeywords(settings.includeKeywords);
    if (includeKeywords.length > 0 && !containsAnyKeyword(text, includeKeywords)) {
      return `未命中必须包含：${includeKeywords.slice(0, 5).join("/")}`;
    }
    return "";
  }

  function shouldSkipAfterOpenByKeyword(text, settings = state.settings) {
    return Boolean(getIncludeKeywordReason(text, settings));
  }

  function getExcludeKeywordReason(text, settings = state.settings) {
    const excludeKeywords = parseKeywords(settings.excludeKeywords);
    const excluded = excludeKeywords.find((keyword) => normalizeTextValue(text).toLowerCase().includes(keyword.toLowerCase()));
    return excluded ? `命中排除词：${excluded}` : "";
  }

  function shouldSkipBeforeOpenByKeyword(text, settings = state.settings) {
    return Boolean(getExcludeKeywordReason(text, settings));
  }

  function getDetailText() {
    const detailCandidates = [
      ".job-detail",
      ".job-detail-box",
      ".job-sec-text",
      ".detail-content",
      "[class*='job-detail']",
      "[class*='detail-content']",
      "main"
    ];
    const detail = detailCandidates
      .flatMap((selector) => queryVisible(selector))
      .sort((a, b) => normalizedText(b).length - normalizedText(a).length)[0];
    return detail ? normalizedText(detail) : "";
  }

  function isVisible(element) {
    if (!element || !element.ownerDocument) return false;
    const style = window.getComputedStyle(element);
    const rect = element.getBoundingClientRect();
    return style.display !== "none"
      && style.visibility !== "hidden"
      && Number(style.opacity) !== 0
      && rect.width > 0
      && rect.height > 0;
  }

  function isInsidePanel(element) {
    return Boolean(element?.closest?.(`#${PANEL_ID}`));
  }

  function safeClick(element) {
    if (!element || !isVisible(element)) return false;
    element.scrollIntoView({ block: "center", inline: "center" });
    element.click();
    return true;
  }

  function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  async function waitFor(predicate, timeoutMs, intervalMs = 150) {
    const startedAt = Date.now();
    while (Date.now() - startedAt < timeoutMs) {
      const result = predicate();
      if (result) return result;
      await sleep(intervalMs);
    }
    return null;
  }

  function queryVisible(selector, root = document) {
    return Array.from(root.querySelectorAll(selector)).filter((element) => isVisible(element) && !isInsidePanel(element));
  }

  function uniqueElements(elements) {
    return Array.from(new Set(elements));
  }

  function findButtonLikeElements(root = document) {
    return uniqueElements(BUTTON_LIKE_SELECTORS.flatMap((selector) => queryVisible(selector, root)));
  }

  function findActionElement() {
    const elements = findButtonLikeElements();
    const communicate = elements.find((element) => classifyActionText(normalizedText(element)) === "communicate");
    if (communicate) return { kind: "communicate", element: communicate, text: normalizedText(communicate) };

    const skip = elements.find((element) => classifyActionText(normalizedText(element)) === "skip");
    if (skip) return { kind: "skip", element: skip, text: normalizedText(skip) };

    return { kind: "unknown", element: null, text: "" };
  }

  function findSuccessModal() {
    const candidates = uniqueElements([
      ...queryVisible("[role='dialog']"),
      ...queryVisible("[class*='dialog']"),
      ...queryVisible("[class*='modal']"),
      ...queryVisible("div")
    ]);
    return candidates.find((element) => normalizedText(element).includes("已向BOSS发送消息")) || null;
  }

  function findStayButton(modal) {
    const buttons = findButtonLikeElements(modal);
    const buttonTexts = buttons.map(normalizedText);
    const exact = pickStayButtonText(buttonTexts);
    if (exact) return buttons.find((button) => normalizedText(button) === exact);
    return buttons.find((button) => normalizedText(button).includes("留在此页")) || null;
  }

  function findUnknownBlockingModal() {
    const candidates = uniqueElements([
      ...queryVisible("[role='dialog']"),
      ...queryVisible("[class*='dialog']"),
      ...queryVisible("[class*='modal']")
    ]);
    return candidates.find((element) => {
      const text = normalizedText(element);
      return text && !text.includes("已向BOSS发送消息");
    }) || null;
  }

  function jobKeyFromCard(card) {
    return normalizedText(card).slice(0, 180);
  }

  function looksLikeJobCard(card) {
    const text = normalizedText(card);
    if (text.length <= 10) return false;
    return /(\d+k|\d+K|薪|经验|本科|大专|北京|上海|深圳|广州|杭州|公司|工程师|开发|测试|产品|运营)/.test(text);
  }

  function findJobCards() {
    const candidates = uniqueElements(JOB_CARD_SELECTORS.flatMap((selector) => queryVisible(selector)));
    return candidates.filter((card) => !isInsidePanel(card) && looksLikeJobCard(card));
  }

  function findNextJobCard() {
    return findJobCards().find((card) => {
      const key = jobKeyFromCard(card);
      return key && !state.visitedJobKeys.has(key);
    }) || null;
  }

  function findScrollableJobContainer() {
    const firstCard = findJobCards()[0];
    let node = firstCard?.parentElement || null;
    while (node && node !== document.body) {
      if (node.scrollHeight > node.clientHeight + 20) return node;
      node = node.parentElement;
    }
    return document.scrollingElement || document.documentElement;
  }

  async function scrollJobList() {
    const container = findScrollableJobContainer();
    const beforeTop = container.scrollTop;
    const beforeCount = findJobCards().length;
    const distance = Math.max(240, Math.floor((container.clientHeight || window.innerHeight) * 0.8));

    container.scrollTop = beforeTop + distance;
    await sleep(state.settings.scrollWaitMs);

    const afterTop = container.scrollTop;
    const afterCount = findJobCards().length;
    return afterTop > beforeTop || afterCount > beforeCount;
  }

  function detectRiskOrLoginBlock() {
    const pageText = normalizedText(document.body);
    return containsRiskText(pageText);
  }

  function isDailyQuotaReached() {
    return state.stats.success >= state.settings.dailyMax;
  }

  function markStats(key) {
    state.stats[key] += 1;
    saveStats();
    updatePanel();
  }

  function setMode(mode, message) {
    state.mode = mode;
    state.currentMessage = message || state.currentMessage;
    updatePanel();
  }

  function stop(message) {
    setMode(MODE.stopped, message);
    addLog(`停止：${message}`);
  }

  function errorStop(message) {
    setMode(MODE.error, message);
    addLog(`异常停止：${message}`);
  }

  async function handleSuccessModal() {
    const modal = await waitFor(findSuccessModal, state.settings.modalWaitMs);
    if (modal) {
      const stayButton = findStayButton(modal);
      if (!stayButton) {
        errorStop("发送成功弹窗中未找到留在此页");
        return false;
      }
      safeClick(stayButton);
      return true;
    }

    const unknownModal = findUnknownBlockingModal();
    if (unknownModal) {
      errorStop("检测到未知弹窗，已停止");
      return false;
    }

    const action = findActionElement();
    if (action.kind === "skip") return true;
    return true;
  }

  async function processJobCard(card) {
    const key = jobKeyFromCard(card);
    const cardText = normalizedText(card);
    state.visitedJobKeys.add(key);
    state.currentMessage = cardText.slice(0, 40);
    updatePanel();

    const preOpenReason = getExcludeKeywordReason(cardText);
    if (preOpenReason) {
      markStats("skipped");
      state.consecutiveFailures = 0;
      addLog(`跳过：${preOpenReason}`);
      return;
    }

    if (!safeClick(card)) {
      markStats("failed");
      state.consecutiveFailures += 1;
      addLog("失败：职位卡片无法点击");
      return;
    }

    await sleep(state.settings.detailWaitMs);

    if (detectRiskOrLoginBlock()) {
      errorStop("检测到登录/验证/风控提示，已停止");
      return;
    }

    const detailText = getDetailText();
    const keywordReason = getIncludeKeywordReason(`${cardText} ${detailText}`);
    if (keywordReason) {
      markStats("skipped");
      state.consecutiveFailures = 0;
      addLog(`跳过：${keywordReason}`);
      return;
    }

    const action = findActionElement();
    if (action.kind !== "communicate") {
      markStats("skipped");
      state.consecutiveFailures = 0;
      addLog(`跳过：${action.text || "未找到立即沟通"}`);
      return;
    }

    if (!safeClick(action.element)) {
      markStats("failed");
      state.consecutiveFailures += 1;
      addLog("失败：立即沟通按钮无法点击");
      return;
    }

    const stayed = await handleSuccessModal();
    if (!stayed || state.mode === MODE.error) return;

    markStats("success");
    state.consecutiveFailures = 0;
    addLog(`成功：${state.currentMessage || "已发送沟通"}`);
  }

  async function waitConfiguredInterval() {
    const seconds = state.settings.intervalSeconds;
    for (let remaining = seconds; remaining > 0; remaining -= 1) {
      if (state.mode !== MODE.running) return;
      state.currentMessage = `等待 ${remaining} 秒后继续`;
      updatePanel();
      await sleep(1000);
    }
  }

  async function runLoop() {
    if (state.isRunning) return;
    state.isRunning = true;

    while (state.mode === MODE.running) {
      if (isDailyQuotaReached()) {
        stop("今日上限已达到");
        break;
      }

      if (detectRiskOrLoginBlock()) {
        errorStop("检测到登录/验证/风控提示，已停止");
        break;
      }

      if (state.consecutiveFailures >= state.settings.maxConsecutiveFailures) {
        errorStop("连续失败次数过多，已停止");
        break;
      }

      const card = findNextJobCard();
      if (!card) {
        state.currentMessage = "正在下拉加载更多职位";
        updatePanel();
        const loadedMore = await scrollJobList();
        if (!loadedMore) {
          stop("没有更多职位");
          break;
        }
        continue;
      }

      await processJobCard(card);
      if (state.mode === MODE.running && !isDailyQuotaReached()) {
        await waitConfiguredInterval();
      }
    }

    state.isRunning = false;
    updatePanel();
  }

  function injectStyles() {
    if (document.getElementById(`${PANEL_ID}-style`)) return;
    const style = document.createElement("style");
    style.id = `${PANEL_ID}-style`;
    style.textContent = `
      #${PANEL_ID} {
        position: fixed;
        right: 24px;
        bottom: 24px;
        width: 300px;
        z-index: 999999;
        box-sizing: border-box;
        padding: 12px;
        border: 1px solid #13c2c2;
        border-radius: 8px;
        background: #ffffff;
        color: #1f2933;
        box-shadow: 0 10px 30px rgba(15, 23, 42, 0.18);
        font-size: 13px;
        line-height: 1.4;
        font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      }
      #${PANEL_ID} * { box-sizing: border-box; }
      #${PANEL_ID} .bh-header {
        display: flex;
        align-items: center;
        justify-content: space-between;
        margin-bottom: 8px;
        font-weight: 700;
      }
      #${PANEL_ID} .bh-grid {
        display: grid;
        grid-template-columns: 1fr 1fr;
        gap: 8px;
        margin: 8px 0;
      }
      #${PANEL_ID} label {
        display: grid;
        gap: 4px;
        color: #52616b;
      }
      #${PANEL_ID} input {
        width: 100%;
        border: 1px solid #d9e2ec;
        border-radius: 6px;
        padding: 6px;
        color: #1f2933;
      }
      #${PANEL_ID} textarea {
        width: 100%;
        min-height: 38px;
        resize: vertical;
        border: 1px solid #d9e2ec;
        border-radius: 6px;
        padding: 6px;
        color: #1f2933;
        font-family: inherit;
        font-size: 12px;
      }
      #${PANEL_ID} .bh-actions {
        display: grid;
        grid-template-columns: repeat(4, 1fr);
        gap: 6px;
        margin: 8px 0;
      }
      #${PANEL_ID} button {
        border: 0;
        border-radius: 6px;
        padding: 7px 6px;
        background: #0fb9b1;
        color: #ffffff;
        cursor: pointer;
        font-size: 12px;
      }
      #${PANEL_ID} button[data-kind="secondary"] {
        background: #52616b;
      }
      #${PANEL_ID} button[data-kind="danger"] {
        background: #e55353;
      }
      #${PANEL_ID} .bh-status,
      #${PANEL_ID} .bh-stats,
      #${PANEL_ID} .bh-message {
        margin-top: 6px;
        color: #334e68;
        word-break: break-all;
      }
      #${PANEL_ID} .bh-logs {
        margin-top: 8px;
        max-height: 130px;
        overflow: auto;
        border-top: 1px solid #edf2f7;
        padding-top: 8px;
        color: #52616b;
        font-size: 12px;
        white-space: pre-wrap;
      }
    `;
    document.head.appendChild(style);
  }

  function renderPanel() {
    if (document.getElementById(PANEL_ID)) return;
    injectStyles();

    const panel = document.createElement("div");
    panel.id = PANEL_ID;
    panel.innerHTML = `
      <div class="bh-header">
        <span>BOSS Helper</span>
        <span data-role="status"></span>
      </div>
      <div class="bh-grid">
        <label>间隔秒数
          <input data-role="interval" type="number" min="5" max="3600" step="1">
        </label>
        <label>每日上限
          <input data-role="daily-max" type="number" min="1" max="1000" step="1">
        </label>
      </div>
      <label>必须包含
        <textarea data-role="include-keywords" placeholder="留空表示不过滤必须包含"></textarea>
      </label>
      <label>排除关键词
        <textarea data-role="exclude-keywords" placeholder="命中任一关键词就跳过"></textarea>
      </label>
      <div class="bh-actions">
        <button data-action="start">开始</button>
        <button data-action="pause" data-kind="secondary">暂停</button>
        <button data-action="stop" data-kind="danger">停止</button>
        <button data-action="reset" data-kind="secondary">重置</button>
      </div>
      <div class="bh-stats" data-role="stats"></div>
      <div class="bh-message" data-role="message"></div>
      <div class="bh-logs" data-role="logs"></div>
    `;

    panel.querySelector('[data-action="start"]').addEventListener("click", () => {
      saveSettingsFromPanel();
      if (isDailyQuotaReached()) {
        stop("今日上限已达到");
        return;
      }
      setMode(MODE.running, "开始运行");
      addLog("开始运行");
      runLoop();
    });

    panel.querySelector('[data-action="pause"]').addEventListener("click", () => {
      setMode(MODE.paused, "已暂停");
      addLog("暂停");
    });

    panel.querySelector('[data-action="stop"]').addEventListener("click", () => {
      stop("用户停止");
    });

    panel.querySelector('[data-action="reset"]').addEventListener("click", () => {
      if (!window.confirm("确认重置今天的统计？")) return;
      state.stats = freshStats();
      state.visitedJobKeys.clear();
      saveStats();
      addLog("已重置今日统计");
      updatePanel();
    });

    panel.querySelector('[data-role="interval"]').addEventListener("change", saveSettingsFromPanel);
    panel.querySelector('[data-role="daily-max"]').addEventListener("change", saveSettingsFromPanel);
    panel.querySelector('[data-role="include-keywords"]').addEventListener("change", saveSettingsFromPanel);
    panel.querySelector('[data-role="exclude-keywords"]').addEventListener("change", saveSettingsFromPanel);

    document.body.appendChild(panel);
    updatePanel();
  }

  function saveSettingsFromPanel() {
    const panel = document.getElementById(PANEL_ID);
    if (!panel) return;
    saveSettings({
      intervalSeconds: panel.querySelector('[data-role="interval"]').value,
      dailyMax: panel.querySelector('[data-role="daily-max"]').value,
      includeKeywords: panel.querySelector('[data-role="include-keywords"]').value,
      excludeKeywords: panel.querySelector('[data-role="exclude-keywords"]').value
    });
  }

  function updatePanel() {
    const panel = document.getElementById(PANEL_ID);
    if (!panel) return;

    const remaining = Math.max(0, state.settings.dailyMax - state.stats.success);
    panel.querySelector('[data-role="status"]').textContent = STATUS_LABELS[state.mode] || state.mode;
    panel.querySelector('[data-role="interval"]').value = state.settings.intervalSeconds;
    panel.querySelector('[data-role="daily-max"]').value = state.settings.dailyMax;
    panel.querySelector('[data-role="include-keywords"]').value = state.settings.includeKeywords;
    panel.querySelector('[data-role="exclude-keywords"]').value = state.settings.excludeKeywords;
    panel.querySelector('[data-role="stats"]').textContent =
      `成功 ${state.stats.success} / 跳过 ${state.stats.skipped} / 失败 ${state.stats.failed} / 剩余 ${remaining}`;
    panel.querySelector('[data-role="message"]').textContent = state.currentMessage;
    panel.querySelector('[data-role="logs"]').textContent = state.logs.slice(-8).join("\n");
  }

  function init() {
    if (!/zhipin\.com$/.test(location.hostname)) return;
    if (document.readyState === "loading") {
      document.addEventListener("DOMContentLoaded", renderPanel, { once: true });
      return;
    }
    renderPanel();
  }

  if (globalThis.__BOSS_HELPER_ENABLE_TEST_API__) {
    globalThis.__BOSS_HELPER_TESTS__ = {
      DEFAULT_SETTINGS,
      classifyActionText,
      containsRiskText,
      freshStats,
      shouldResetStats,
      pickStayButtonText,
      parseKeywords,
      shouldSkipByKeyword,
      shouldSkipBeforeOpenByKeyword,
      shouldSkipAfterOpenByKeyword
    };
    return;
  }

  init();
})();
