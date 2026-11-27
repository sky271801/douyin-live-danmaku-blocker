/**
 * Douyin Live Danmaku Blocker - Content Script (Extension + UserScript shared)
 * Monitors floating video danmaku (xg-danmu) and chatroom messages (webcast-chatroom),
 * applies per-room/global rules + anti-spam folding safely without breaking React DOM,
 * and provides a sleek in-page control panel, hot-danmaku radar, and hover quick-block.
 */
(function () {
  'use strict';

  if (window.__DY_DF_CONTENT_INITIALIZED__) return;
  window.__DY_DF_CONTENT_INITIALIZED__ = true;

  const EngineAPI = window.DYDanmakuEngine;
  if (!EngineAPI) return;

  const STORAGE_KEY = 'dy_danmaku_blocker_config_v1';
  const DOCK_POS_KEY = 'dy_danmaku_blocker_dock_pos_v1';

  const DEFAULT_VIDEO_CONTAINERS = [
    '#DanmakuLayout',
    '.CanvasDanmakuPlugin',
    'xg-danmu',
    '.xgplayer-danmu',
    '[class*="xgplayer-danmu" i]',
    '[class*="danmu-container" i]',
    '[class*="danmaku" i]',
    '[id*="danmaku" i]',
    '[data-e2e*="danmu" i]'
  ];

  const DEFAULT_CHAT_ITEM_SELECTORS = [
    '.webcast-chatroom___item',
    '[class*="webcast-chatroom___item"]',
    '[data-e2e="chat-message"]'
  ];

  const TYPE_LABELS = {
    contains: '包含',
    exact: '精确',
    regex: '正则',
    user: '用户'
  };

  const REASON_LABELS = {
    rule: '规则命中',
    spam: '刷屏折叠',
    system: '系统消息',
    repeat_char: '重复字符'
  };

  // ==================== Storage Adapter ====================
  function createStorageAdapter() {
    const hasChromeStorage =
      typeof chrome !== 'undefined' &&
      chrome.storage &&
      chrome.storage.local &&
      typeof chrome.storage.local.get === 'function';

    if (hasChromeStorage) {
      return {
        async load() {
          return new Promise((resolve) => {
            try {
              chrome.storage.local.get([STORAGE_KEY], (res) => {
                resolve(res ? res[STORAGE_KEY] : null);
              });
            } catch (_) {
              resolve(null);
            }
          });
        },
        async save(config) {
          return new Promise((resolve) => {
            try {
              chrome.storage.local.set({ [STORAGE_KEY]: config }, () => resolve());
            } catch (_) {
              resolve();
            }
          });
        },
        subscribe(cb) {
          try {
            chrome.storage.onChanged.addListener((changes, area) => {
              if (area === 'local' && changes[STORAGE_KEY]) {
                cb(changes[STORAGE_KEY].newValue);
              }
            });
          } catch (_) {
            // Ignore
          }
        }
      };
    }

    const hasGM = typeof GM_getValue === 'function' && typeof GM_setValue === 'function';
    if (hasGM) {
      return {
        async load() {
          try {
            const raw = GM_getValue(STORAGE_KEY, null);
            return typeof raw === 'string' ? JSON.parse(raw) : raw;
          } catch (_) {
            return null;
          }
        },
        async save(config) {
          try {
            GM_setValue(STORAGE_KEY, JSON.stringify(config));
          } catch (_) {
            // Ignore
          }
        },
        subscribe() {}
      };
    }

    return {
      async load() {
        try {
          const raw = localStorage.getItem(STORAGE_KEY);
          return raw ? JSON.parse(raw) : null;
        } catch (_) {
          return null;
        }
      },
      async save(config) {
        try {
          localStorage.setItem(STORAGE_KEY, JSON.stringify(config));
        } catch (_) {
          // Ignore
        }
      },
      subscribe(cb) {
        window.addEventListener('storage', (e) => {
          if (e.key === STORAGE_KEY && e.newValue) {
            try {
              cb(JSON.parse(e.newValue));
            } catch (_) {
              // Ignore
            }
          }
        });
      }
    };
  }

  // ==================== Helpers ====================
  function escapeHtml(str) {
    return String(str || '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function formatTime(ts) {
    const d = new Date(ts);
    const hh = String(d.getHours()).padStart(2, '0');
    const mm = String(d.getMinutes()).padStart(2, '0');
    const ss = String(d.getSeconds()).padStart(2, '0');
    return `${hh}:${mm}:${ss}`;
  }

  function splitCustomSelectors(str) {
    if (!str || typeof str !== 'string') return [];
    return str
      .split(/[\n,]+/)
      .map((s) => s.trim())
      .filter(Boolean);
  }

  function safeQueryAll(root, selector) {
    if (!root || !selector) return [];
    try {
      return Array.from(root.querySelectorAll(selector));
    } catch (_) {
      return [];
    }
  }

  function safeMatches(el, selector) {
    if (!el || el.nodeType !== 1 || !selector) return false;
    try {
      return el.matches(selector);
    } catch (_) {
      return false;
    }
  }

  function safeClosest(el, selector) {
    if (!el || el.nodeType !== 1 || !selector) return null;
    try {
      return el.closest(selector);
    } catch (_) {
      return null;
    }
  }

  function isLiveContextPage() {
    if (location.hostname === 'live.douyin.com') return true;
    if (/\/live\/|\/follow\/live/.test(location.pathname)) return true;
    if (document.querySelector('xg-danmu, .webcast-chatroom___items, [class*="webcast-chatroom"]')) {
      return true;
    }
    return false;
  }

  function detectStreamerName() {
    // 1. Try common Douyin Live streamer nickname selectors
    const selectors = [
      '[data-e2e="live-room-nickname"]',
      'h1[class*="nickname"]',
      '[class*="anchor-name"]',
      '[class*="author-name"]',
      'header h1'
    ];
    for (const sel of selectors) {
      const el = document.querySelector(sel);
      if (el && el.textContent && el.textContent.trim().length > 0 && el.textContent.trim().length <= 40) {
        return el.textContent.trim();
      }
    }

    // 2. Fallback: document.title e.g. "某某主播的抖音直播间 - 抖音直播"
    const title = (document.title || '').trim();
    const m = title.match(/^(.+?)的抖音直播间/);
    if (m && m[1]) return m[1].trim();
    const m2 = title.match(/^(.+?)\s*[-|]\s*抖音直播/);
    if (m2 && m2[1] && !/^抖音直播/.test(m2[1])) return m2[1].trim();
    return '';
  }

  // ==================== App State ====================
  const storage = createStorageAdapter();
  const engine = new EngineAPI.DanmakuFilterEngine();

  let currentRoomId = '';
  let currentRoomName = '';
  let lastUrl = location.href;
  let uiMounted = false;
  let panelOpen = false;
  let activeTab = 'room'; // 'room' | 'radar' | 'global' | 'settings'
  let isSavingLocal = false;

  // DOM tracking (React-safe & pooling-safe)
  let nextNodeId = 1;
  const nodeMetaMap = new WeakMap();
  const trackedNodes = new Set();
  const pendingScanNodes = new Set();
  let scanScheduled = false;
  let activeObserver = null;
  let observedBody = null;

  // UI references
  let rootEl = null;
  let dockEl = null;
  let dockBadgeEl = null;
  let panelEl = null;
  let bodyEl = null;
  let subtitleEl = null;
  let masterToggleEl = null;
  let statBlockedEl = null;
  let statSpamEl = null;
  let statRulesEl = null;
  let hoverBtnEl = null;
  let popoverEl = null;
  let toastEl = null;
  let toastTimer = null;

  // Hover quick-block state
  let hoveredChatInfo = null;
  let popoverChatInfo = null;
  let hoverHideTimer = null;

  // ==================== Selectors ====================
  function getVideoContainerSelector() {
    const custom = splitCustomSelectors(engine.config.advanced.customVideoSelectors);
    return [...DEFAULT_VIDEO_CONTAINERS, ...custom].join(', ');
  }

  function getChatItemSelector() {
    const custom = splitCustomSelectors(engine.config.advanced.customChatSelectors);
    return [...DEFAULT_CHAT_ITEM_SELECTORS, ...custom].join(', ');
  }

  // ==================== DOM Inspection & Safe Hiding ====================
  function isInsideExtensionUI(el) {
    return !!(el && rootEl && rootEl.contains(el));
  }

  function isUnsafeToHide(el) {
    if (!el || el.nodeType !== 1) return true;
    const tag = el.tagName;
    if (tag === 'BODY' || tag === 'HTML' || tag === 'VIDEO' || tag === 'CANVAS' || tag === 'XG-DANMU') {
      return true;
    }
    if (isInsideExtensionUI(el)) return true;
    // Do not hide whole containers that hold interactive controls or video
    if (el.querySelector('video, textarea, [contenteditable="true"], xg-controls')) {
      return true;
    }
    return false;
  }

  function getNodeMeta(el, source) {
    let meta = nodeMetaMap.get(el);
    if (!meta) {
      meta = {
        id: 'n' + nextNodeId++,
        lastText: '',
        rulesVersion: 0,
        hidden: false,
        source
      };
      nodeMetaMap.set(el, meta);
    }
    trackedNodes.add(el);
    return meta;
  }

  function pruneTrackedNodes() {
    if (trackedNodes.size < 250) return;
    for (const el of Array.from(trackedNodes)) {
      if (!el.isConnected) {
        trackedNodes.delete(el);
      }
    }
  }

  function applyVisibility(el, meta, shouldHide) {
    if (shouldHide) {
      if (!el.classList.contains('dy-df-hidden')) {
        el.classList.add('dy-df-hidden');
      }
      if (el.getAttribute('data-dy-df-blocked') !== '1') {
        el.setAttribute('data-dy-df-blocked', '1');
      }
      if (el.style && (el.style.getPropertyValue('display') !== 'none' || el.style.getPropertyPriority('display') !== 'important')) {
        el.style.setProperty('display', 'none', 'important');
      }
      meta.hidden = true;
    } else if (
      meta.hidden ||
      el.classList.contains('dy-df-hidden') ||
      el.getAttribute('data-dy-df-blocked') === '1'
    ) {
      el.classList.remove('dy-df-hidden');
      el.removeAttribute('data-dy-df-blocked');
      if (el.style && el.style.getPropertyValue('display') === 'none' && el.style.getPropertyPriority('display') === 'important') {
        el.style.removeProperty('display');
      }
      meta.hidden = false;
    }
  }

  function extractChatData(chatEl) {
    let explicitUser = '';
    let explicitContent = '';

    // Try standard Douyin chatroom sub-elements
    const userEl = chatEl.querySelector(
      '.webcast-chatroom___username, [class*="username"], [class*="nick"]'
    );
    if (userEl && userEl.textContent) {
      explicitUser = userEl.textContent.trim();
    }

    const contentEl = chatEl.querySelector(
      '.webcast-chatroom___content, [class*="webcast-chatroom___content"], [class*="message-content"]'
    );
    if (contentEl && contentEl.textContent) {
      explicitContent = contentEl.textContent.trim();
    }

    const rawText = (chatEl.textContent || chatEl.innerText || '').replace(/\s+/g, ' ').trim();
    return EngineAPI.parseChatLine(rawText, explicitUser, explicitContent);
  }

  function evaluateChatItem(chatEl, recordStats) {
    if (isUnsafeToHide(chatEl)) return;
    // Ensure we don't accidentally hide a wrapper containing multiple chat items
    const chatSelector = getChatItemSelector();
    if (chatEl.querySelector && safeQueryAll(chatEl, chatSelector).length > 0) {
      return;
    }

    const parsed = extractChatData(chatEl);
    const text = parsed.content || parsed.fullText;
    const meta = getNodeMeta(chatEl, 'chat');

    if (!text) {
      if (meta.hidden) applyVisibility(chatEl, meta, false);
      meta.lastText = '';
      meta.rulesVersion = 0;
      return;
    }

    if (recordStats && meta.lastText === parsed.fullText && meta.rulesVersion === engine.rulesVersion) {
      // Re-enforce visibility in case React re-render stripped our class/style
      if (meta.hidden) {
        applyVisibility(chatEl, meta, true);
      }
      return;
    }
    meta.lastText = parsed.fullText;
    meta.rulesVersion = engine.rulesVersion;

    const decision = engine.evaluate({
      text: parsed.content,
      username: parsed.username,
      fullText: parsed.fullText,
      source: 'chat',
      roomId: currentRoomId,
      itemKey: `${meta.id}::${parsed.fullText}`,
      recordStats
    });

    applyVisibility(chatEl, meta, decision.blocked);
  }

  function isUnsafeVideoContainer(el) {
    if (!el || el.nodeType !== 1) return true;
    const tag = el.tagName;
    if (tag === 'BODY' || tag === 'HTML') return true;
    if (isInsideExtensionUI(el)) return true;
    if (el.querySelector('video, xg-controls, .webcast-chatroom___items')) return true;
    return false;
  }

  /**
   * Resolve the OUTERMOST safe video danmaku container for a node,
   * so an individual item like <div class="danmaku-item"> inside <xg-danmu>
   * is never mistaken for the container itself.
   */
  function findVideoDanmuRoot(node) {
    const selector = getVideoContainerSelector();
    let cur = node && node.nodeType === 1 ? node : (node && node.parentElement);
    let highest = null;
    while (cur && cur.nodeType === 1 && cur !== document.body && cur !== document.documentElement) {
      if (safeMatches(cur, selector) && !isUnsafeVideoContainer(cur)) {
        highest = cur;
      }
      cur = cur.parentElement;
    }
    return highest;
  }

  function hasMotionStyle(el) {
    if (!el || el.nodeType !== 1) return false;
    const st = el.style;
    if (st && (st.transform || st.animation || st.left || st.right || st.top || st.transition)) {
      return true;
    }
    if (typeof el.getAnimations === 'function') {
      try {
        if (el.getAnimations().length > 0) return true;
      } catch (_) {
        // Ignore
      }
    }
    return false;
  }

  function isVideoWrapperContainer(el) {
    if (!el || el.nodeType !== 1 || !el.children || el.children.length === 0) return false;
    if (el.tagName === 'XG-DANMU') return true;

    let elemChildCount = 0;
    let divChildCount = 0;
    let animatedChildCount = 0;
    let absChildCount = 0;
    let textDivCount = 0;

    for (let i = 0; i < el.children.length; i++) {
      const child = el.children[i];
      if (!child || child.nodeType !== 1 || isInsideExtensionUI(child)) continue;
      if (child.tagName === 'CANVAS' || child.tagName === 'STYLE' || child.tagName === 'SCRIPT') continue;
      elemChildCount++;
      if (child.tagName === 'DIV') {
        divChildCount++;
        if ((child.textContent || '').trim().length > 0) {
          textDivCount++;
        }
      }
      if (hasMotionStyle(child)) {
        animatedChildCount++;
      } else if (child.tagName === 'DIV' && typeof window.getComputedStyle === 'function') {
        try {
          const pos = window.getComputedStyle(child).position;
          if (pos === 'absolute' || pos === 'fixed') absChildCount++;
        } catch (_) {
          // Ignore
        }
      }
    }

    if (elemChildCount === 0) return false;
    // Track or layer with 2+ animated or absolutely-positioned children
    if (animatedChildCount + absChildCount >= 2) return true;
    // Static track/layer containing even 1 animated/absolutely-positioned DIV danmaku child
    if ((animatedChildCount >= 1 || absChildCount >= 1) && divChildCount >= 1 && !hasMotionStyle(el)) return true;
    // Multi-danmaku wrapper whose combined text exceeds a single danmaku length
    if (elemChildCount >= 2 && (el.textContent || '').trim().length > 260) return true;
    // Full-overlay layer inside xg-danmu (e.g. wrapper div spanning player height)
    if (divChildCount >= 1 && el.clientHeight > 120 && el.clientWidth >= 250) return true;
    // Multiple text-bearing block DIV siblings inside a non-moving container
    if (textDivCount >= 3 && !hasMotionStyle(el)) return true;

    return false;
  }

  function collectVideoDanmuItems(container, depth = 0) {
    const items = [];
    if (!container || depth > 5) return items;

    if (!container.children || container.children.length === 0) {
      if (container.tagName !== 'XG-DANMU' && !isUnsafeToHide(container) && (container.textContent || '').trim()) {
        items.push(container);
      }
      return items;
    }

    for (let i = 0; i < container.children.length; i++) {
      const child = container.children[i];
      if (!child || child.nodeType !== 1 || isInsideExtensionUI(child)) continue;
      if (child.tagName === 'CANVAS' || child.tagName === 'STYLE' || child.tagName === 'SCRIPT') continue;

      if (isVideoWrapperContainer(child)) {
        const nested = collectVideoDanmuItems(child, depth + 1);
        for (let j = 0; j < nested.length; j++) {
          items.push(nested[j]);
        }
      } else {
        items.push(child);
      }
    }
    return items;
  }

  function evaluateVideoDanmuItem(itemEl, recordStats, depth = 0) {
    if (!itemEl || depth > 5) return;
    if (isUnsafeToHide(itemEl)) return;
    if (itemEl.querySelector('button, input, select')) return;

    const text = (itemEl.textContent || itemEl.innerText || '').replace(/\s+/g, ' ').trim();
    const meta = getNodeMeta(itemEl, 'video');

    if (!text) {
      // Pooled node cleared out -> restore visibility so next danmaku renders cleanly
      if (meta.hidden) {
        applyVisibility(itemEl, meta, false);
      }
      meta.lastText = '';
      meta.rulesVersion = 0;
      return;
    }

    // If this element contains too much text, it is likely a multi-danmaku wrapper -> descend instead of skipping!
    if (text.length > 260) {
      if (itemEl.children && itemEl.children.length > 0) {
        if (meta.hidden) applyVisibility(itemEl, meta, false);
        for (let i = 0; i < itemEl.children.length; i++) {
          evaluateVideoDanmuItem(itemEl.children[i], recordStats, depth + 1);
        }
      }
      return;
    }

    if (recordStats && meta.lastText === text && meta.rulesVersion === engine.rulesVersion) {
      // Re-enforce hiding in case xg-danmu recycled/reset className or inline style with identical spam text
      if (meta.hidden) {
        applyVisibility(itemEl, meta, true);
      }
      return;
    }
    meta.lastText = text;
    meta.rulesVersion = engine.rulesVersion;

    const decision = engine.evaluate({
      text,
      fullText: text,
      source: 'video',
      roomId: currentRoomId,
      itemKey: `${meta.id}::${text}`,
      recordStats
    });

    applyVisibility(itemEl, meta, decision.blocked);
  }

  function processElementSubtree(node, recordStats) {
    if (!node || node.nodeType !== 1 || isInsideExtensionUI(node)) return;

    const chatSelector = getChatItemSelector();
    const videoContainerSelector = getVideoContainerSelector();

    // 1. Check if node is or is inside a chatroom item
    if (safeMatches(node, chatSelector)) {
      evaluateChatItem(node, recordStats);
      return;
    }
    const parentChat = safeClosest(node, chatSelector);
    if (parentChat) {
      evaluateChatItem(parentChat, recordStats);
      return;
    }

    // 2. Check if node is or is inside a video danmu container (always resolve outermost safe root)
    const danmuRoot = findVideoDanmuRoot(node);
    if (danmuRoot) {
      if (node === danmuRoot || isVideoWrapperContainer(node)) {
        collectVideoDanmuItems(node).forEach((it) => evaluateVideoDanmuItem(it, recordStats));
      } else {
        // Walk up to the individual danmaku item level inside danmuRoot
        let target = node;
        while (
          target &&
          target.parentElement &&
          target.parentElement !== danmuRoot &&
          !isVideoWrapperContainer(target.parentElement)
        ) {
          target = target.parentElement;
        }
        if (target && target !== danmuRoot) {
          if (isVideoWrapperContainer(target)) {
            collectVideoDanmuItems(target).forEach((c) => evaluateVideoDanmuItem(c, recordStats));
          } else {
            evaluateVideoDanmuItem(target, recordStats);
          }
        }
      }
      return;
    }

    // 3. Otherwise check if this added subtree contains chat items or danmu containers
    const nestedChats = safeQueryAll(node, chatSelector);
    for (let i = 0; i < nestedChats.length; i++) {
      evaluateChatItem(nestedChats[i], recordStats);
    }

    const nestedDanmuContainers = safeQueryAll(node, videoContainerSelector);
    for (let i = 0; i < nestedDanmuContainers.length; i++) {
      const c = nestedDanmuContainers[i];
      if (!isUnsafeVideoContainer(c)) {
        collectVideoDanmuItems(c).forEach((it) => evaluateVideoDanmuItem(it, recordStats));
      }
    }
  }

  function scheduleMicroFlush(fn) {
    if (typeof queueMicrotask === 'function') {
      queueMicrotask(fn);
    } else if (typeof Promise === 'function') {
      Promise.resolve().then(fn);
    } else {
      setTimeout(fn, 0);
    }
  }

  function scheduleScan(node) {
    if (!node || isInsideExtensionUI(node)) return;
    pendingScanNodes.add(node);
    if (scanScheduled) return;
    scanScheduled = true;

    const flush = () => {
      scanScheduled = false;
      const batch = Array.from(pendingScanNodes);
      pendingScanNodes.clear();
      for (let i = 0; i < batch.length; i++) {
        const n = batch[i];
        if (!n || !n.isConnected) continue;
        try {
          if (n.nodeType === 3 && n.parentElement) {
            processElementSubtree(n.parentElement, true);
          } else if (n.nodeType === 1) {
            processElementSubtree(n, true);
          }
        } catch (_) {
          // Isolate per-node errors so one malformed node never stalls the batch
        }
      }
      pruneTrackedNodes();
      updateDockBadge();
    };

    scheduleMicroFlush(flush);
  }

  /**
   * Lightweight periodic safety sweep for pooled/recycled DOM nodes
   * whose text/class/style was silently reset by xg-danmu or React.
   */
  function sweepLiveContainers() {
    if (!engine.config.enabled || !isLiveContextPage()) return;

    const rawContainers = safeQueryAll(document, getVideoContainerSelector());
    const roots = new Set();
    for (let i = 0; i < rawContainers.length; i++) {
      const r = findVideoDanmuRoot(rawContainers[i]);
      if (r) roots.add(r);
    }
    roots.forEach((root) => {
      collectVideoDanmuItems(root).forEach((it) => evaluateVideoDanmuItem(it, true));
    });

    const chatItems = safeQueryAll(document, getChatItemSelector());
    for (let i = 0; i < chatItems.length; i++) {
      evaluateChatItem(chatItems[i], true);
    }

    pruneTrackedNodes();
    updateDockBadge();
  }

  function rescanAll() {
    // Prune disconnected tracked nodes and re-evaluate connected ones
    for (const el of Array.from(trackedNodes)) {
      if (!el.isConnected) {
        trackedNodes.delete(el);
        continue;
      }
      const meta = nodeMetaMap.get(el);
      if (!meta) continue;
      if (meta.source === 'chat') {
        evaluateChatItem(el, false);
      } else if (meta.source === 'video') {
        evaluateVideoDanmuItem(el, false);
      }
    }

    // Also scan current DOM containers in case rules were just turned on
    const chatItems = safeQueryAll(document, getChatItemSelector());
    chatItems.forEach((el) => evaluateChatItem(el, false));

    const rawContainers = safeQueryAll(document, getVideoContainerSelector());
    const roots = new Set();
    for (let i = 0; i < rawContainers.length; i++) {
      const r = findVideoDanmuRoot(rawContainers[i]);
      if (r) roots.add(r);
    }
    roots.forEach((c) => {
      collectVideoDanmuItems(c).forEach((it) => evaluateVideoDanmuItem(it, false));
    });

    updateDockBadge();
  }

  // ==================== Canvas Hook Sync ====================
  function syncCanvasHook() {
    const activeRules = engine.getActiveRules(currentRoomId).map((x) => ({
      pattern: x.rule.pattern,
      type: x.rule.type
    }));
    const payload = {
      enabled: engine.config.enabled,
      canvasHook: engine.config.scope.canvasHook && engine.config.scope.videoDanmu,
      rules: activeRules,
      antiSpam: engine.config.antiSpam
    };
    try {
      if (typeof window.__DY_DF_SYNC_CANVAS_CONFIG__ === 'function') {
        window.__DY_DF_SYNC_CANVAS_CONFIG__(payload);
      }
    } catch (_) {
      // Ignore
    }
    try {
      window.dispatchEvent(
        new CustomEvent('dy-df-sync-canvas-config', {
          detail: payload
        })
      );
    } catch (_) {
      // Ignore
    }
  }

  window.addEventListener('dy-df-canvas-blocked', (e) => {
    const d = e && e.detail;
    if (!d || !d.text) return;
    engine.stats.totalBlocked += 1;
    if (engine.stats.byReason[d.reason] !== undefined) {
      engine.stats.byReason[d.reason] += 1;
    }
    engine.blockedLogs.unshift({
      ts: Date.now(),
      text: d.text,
      username: '',
      source: 'canvas',
      roomId: currentRoomId,
      reason: d.reason || 'rule',
      detail: 'Canvas 飘屏: ' + (d.detail || ''),
      ruleId: '',
      scope: ''
    });
    if (engine.blockedLogs.length > engine.maxLogs) {
      engine.blockedLogs.length = engine.maxLogs;
    }
    updateDockBadge();
  });

  // ==================== Config Persistence ====================
  async function persistConfig(andRescan = true) {
    engine.invalidateCache();
    isSavingLocal = true;
    const cfg = engine.getConfig();
    await storage.save(cfg);
    setTimeout(() => {
      isSavingLocal = false;
    }, 150);
    syncCanvasHook();
    if (andRescan) rescanAll();
    if (panelOpen) renderPanel();
    updateDockBadge();
  }

  // ==================== Room Detection (SPA) ====================
  function refreshRoomContext(forceRescan = false) {
    const newRoomId = EngineAPI.extractRoomIdFromUrl(location.href);
    const detectedName = detectStreamerName();
    const roomChanged = newRoomId !== currentRoomId;

    if (roomChanged) {
      currentRoomId = newRoomId;
      currentRoomName = detectedName;
      engine.resetRoomTransientState();
      if (currentRoomId && engine.config.rooms[currentRoomId] && detectedName) {
        engine.config.rooms[currentRoomId].name = detectedName;
      }
      syncCanvasHook();
      rescanAll();
      if (panelOpen) renderPanel();
    } else if (detectedName && detectedName !== currentRoomName) {
      currentRoomName = detectedName;
      if (currentRoomId && engine.config.rooms[currentRoomId] && !engine.config.rooms[currentRoomId].name) {
        engine.config.rooms[currentRoomId].name = detectedName;
        persistConfig(false);
      }
      updateHeaderSubtitle();
    } else if (forceRescan) {
      rescanAll();
    }

    // Mount UI once we enter a live context (especially when navigating from www.douyin.com to /live/)
    if (!uiMounted && isLiveContextPage()) {
      mountUI();
    } else if (uiMounted && dockEl) {
      const shouldShow = isLiveContextPage();
      dockEl.style.display = shouldShow ? 'inline-flex' : 'none';
      if (!shouldShow && panelOpen) setPanelOpen(false);
    }
  }

  // ==================== Toast ====================
  function showToast(msg) {
    if (!toastEl) return;
    toastEl.textContent = msg;
    toastEl.classList.add('is-show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => {
      toastEl && toastEl.classList.remove('is-show');
    }, 2200);
  }

  // ==================== UI Mounting & Rendering ====================
  function updateDockBadge() {
    if (!dockEl || !dockBadgeEl) return;
    const count = engine.stats.totalBlocked;
    dockBadgeEl.textContent = count > 999 ? '999+' : String(count);
    dockEl.classList.toggle('is-disabled', !engine.config.enabled);

    if (statBlockedEl) statBlockedEl.textContent = String(engine.stats.totalBlocked);
    if (statSpamEl) statSpamEl.textContent = String(engine.stats.byReason.spam + engine.stats.byReason.repeat_char);
    if (statRulesEl) statRulesEl.textContent = String(engine.getActiveRules(currentRoomId).length);
  }

  function updateHeaderSubtitle() {
    if (!subtitleEl) return;
    if (currentRoomId) {
      const savedName = (engine.config.rooms[currentRoomId] && engine.config.rooms[currentRoomId].name) || currentRoomName;
      subtitleEl.textContent = savedName
        ? `当前直播间：${savedName} (${currentRoomId})`
        : `当前直播间 ID：${currentRoomId}`;
    } else {
      subtitleEl.textContent = '未在具体直播间内（仅全局规则生效）';
    }
  }

  function setPanelOpen(open) {
    panelOpen = open;
    if (!panelEl) return;
    panelEl.classList.toggle('is-open', panelOpen);
    if (panelOpen) {
      closePopover();
      renderPanel();
    }
  }

  function mountUI() {
    if (uiMounted || !document.body) return;
    uiMounted = true;

    rootEl = document.createElement('div');
    rootEl.id = 'dy-df-root';
    rootEl.innerHTML = `
      <div class="dy-df-dock" title="点击打开弹幕屏蔽面板（快捷键 Alt+B，可拖动）">
        <span class="dy-df-dock-icon">
          <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">
            <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"></path>
            <line x1="9" y1="9" x2="15" y2="15"></line>
            <line x1="15" y1="9" x2="9" y2="15"></line>
          </svg>
        </span>
        <span class="dy-df-dock-label">弹幕屏蔽</span>
        <span class="dy-df-dock-badge">0</span>
      </div>

      <div class="dy-df-panel" role="dialog" aria-label="抖音直播弹幕屏蔽助手">
        <div class="dy-df-header">
          <div class="dy-df-title-group">
            <div class="dy-df-title">🛡️ 抖音直播弹幕屏蔽</div>
            <div class="dy-df-subtitle">识别直播间中...</div>
          </div>
          <div class="dy-df-header-actions">
            <label class="dy-df-switch" title="总开关：开启/暂停屏蔽">
              <input type="checkbox" class="dy-df-master-toggle" checked />
              <span class="dy-df-slider"></span>
            </label>
            <button class="dy-df-icon-btn dy-df-close-btn" title="关闭面板 (Alt+B)">✕</button>
          </div>
        </div>

        <div class="dy-df-stats">
          <div class="dy-df-stat-item">
            <div class="dy-df-stat-num accent dy-df-stat-blocked">0</div>
            <div class="dy-df-stat-label">本次已屏蔽</div>
          </div>
          <div class="dy-df-stat-item">
            <div class="dy-df-stat-num dy-df-stat-spam">0</div>
            <div class="dy-df-stat-label">刷屏已折叠</div>
          </div>
          <div class="dy-df-stat-item">
            <div class="dy-df-stat-num dy-df-stat-rules">0</div>
            <div class="dy-df-stat-label">生效规则数</div>
          </div>
        </div>

        <div class="dy-df-tabs">
          <button class="dy-df-tab is-active" data-tab="room">本房间</button>
          <button class="dy-df-tab" data-tab="radar">刷屏雷达</button>
          <button class="dy-df-tab" data-tab="global">全局规则</button>
          <button class="dy-df-tab" data-tab="settings">设置/日志</button>
        </div>

        <div class="dy-df-body"></div>
      </div>

      <button class="dy-df-hover-btn" type="button">屏蔽</button>
      <div class="dy-df-popover"></div>
      <div class="dy-df-toast"></div>
    `;

    const mountTarget = document.fullscreenElement || document.body;
    mountTarget.appendChild(rootEl);

    dockEl = rootEl.querySelector('.dy-df-dock');
    dockBadgeEl = rootEl.querySelector('.dy-df-dock-badge');
    panelEl = rootEl.querySelector('.dy-df-panel');
    bodyEl = rootEl.querySelector('.dy-df-body');
    subtitleEl = rootEl.querySelector('.dy-df-subtitle');
    masterToggleEl = rootEl.querySelector('.dy-df-master-toggle');
    statBlockedEl = rootEl.querySelector('.dy-df-stat-blocked');
    statSpamEl = rootEl.querySelector('.dy-df-stat-spam');
    statRulesEl = rootEl.querySelector('.dy-df-stat-rules');
    hoverBtnEl = rootEl.querySelector('.dy-df-hover-btn');
    popoverEl = rootEl.querySelector('.dy-df-popover');
    toastEl = rootEl.querySelector('.dy-df-toast');

    restoreDockPosition();
    setupDockDragAndClick();
    setupPanelEvents();
    setupHoverQuickBlock();
    updateDockBadge();
    updateHeaderSubtitle();
  }

  function restoreDockPosition() {
    try {
      const saved = JSON.parse(localStorage.getItem(DOCK_POS_KEY) || 'null');
      if (saved && typeof saved.right === 'number' && typeof saved.bottom === 'number') {
        const right = Math.max(8, Math.min(window.innerWidth - 110, saved.right));
        const bottom = Math.max(8, Math.min(window.innerHeight - 44, saved.bottom));
        dockEl.style.right = right + 'px';
        dockEl.style.bottom = bottom + 'px';
      }
    } catch (_) {
      // Ignore
    }
  }

  function setupDockDragAndClick() {
    let dragging = false;
    let moved = false;
    let startX = 0;
    let startY = 0;
    let startRight = 18;
    let startBottom = 92;

    dockEl.addEventListener('mousedown', (e) => {
      if (e.button !== 0) return;
      dragging = true;
      moved = false;
      startX = e.clientX;
      startY = e.clientY;
      const rect = dockEl.getBoundingClientRect();
      startRight = window.innerWidth - rect.right;
      startBottom = window.innerHeight - rect.bottom;
      e.preventDefault();
    });

    window.addEventListener('mousemove', (e) => {
      if (!dragging) return;
      const dx = e.clientX - startX;
      const dy = e.clientY - startY;
      if (Math.abs(dx) > 5 || Math.abs(dy) > 5) moved = true;
      if (!moved) return;
      const nextRight = Math.max(8, Math.min(window.innerWidth - 110, startRight - dx));
      const nextBottom = Math.max(8, Math.min(window.innerHeight - 44, startBottom - dy));
      dockEl.style.right = nextRight + 'px';
      dockEl.style.bottom = nextBottom + 'px';
    });

    window.addEventListener('mouseup', () => {
      if (!dragging) return;
      dragging = false;
      if (moved) {
        try {
          localStorage.setItem(
            DOCK_POS_KEY,
            JSON.stringify({
              right: parseFloat(dockEl.style.right) || 18,
              bottom: parseFloat(dockEl.style.bottom) || 92
            })
          );
        } catch (_) {
          // Ignore
        }
      } else {
        setPanelOpen(!panelOpen);
      }
    });
  }

  function setupPanelEvents() {
    rootEl.querySelector('.dy-df-close-btn').addEventListener('click', () => setPanelOpen(false));

    masterToggleEl.addEventListener('change', () => {
      engine.config.enabled = masterToggleEl.checked;
      persistConfig(true);
      showToast(engine.config.enabled ? '已开启弹幕屏蔽' : '已暂停弹幕屏蔽');
    });

    rootEl.querySelectorAll('.dy-df-tab').forEach((btn) => {
      btn.addEventListener('click', () => {
        activeTab = btn.dataset.tab;
        rootEl.querySelectorAll('.dy-df-tab').forEach((b) =>
          b.classList.toggle('is-active', b.dataset.tab === activeTab)
        );
        renderPanel();
      });
    });

    // Delegate actions inside panel body
    bodyEl.addEventListener('click', (e) => {
      const target = e.target.closest('[data-action]');
      if (!target) return;
      const action = target.dataset.action;

      if (action === 'add-rule') {
        const scope = target.dataset.scope || 'room';
        const input = bodyEl.querySelector('.dy-df-rule-input');
        const typeSelect = bodyEl.querySelector('.dy-df-rule-type');
        if (!input) return;
        const raw = input.value.trim();
        if (!raw) {
          showToast('请输入要屏蔽的弹幕关键词');
          input.focus();
          return;
        }
        const type = typeSelect ? typeSelect.value : 'contains';
        const res = engine.addRule({
          scope,
          roomId: currentRoomId,
          roomName: currentRoomName,
          pattern: raw,
          type
        });
        if (!res.ok) {
          showToast(res.error || '添加失败');
          return;
        }
        input.value = '';
        persistConfig(true);
        showToast(res.duplicate ? '该规则已存在并已启用' : `已添加屏蔽规则：${raw}`);
      } else if (action === 'delete-rule') {
        const scope = target.dataset.scope;
        const ruleId = target.dataset.ruleId;
        const roomId = target.dataset.roomId || currentRoomId;
        engine.removeRule({ scope, roomId, ruleId });
        persistConfig(true);
        showToast('已删除规则');
      } else if (action === 'radar-block') {
        const scope = target.dataset.scope;
        const text = target.dataset.text || '';
        const res = engine.addRule({
          scope,
          roomId: currentRoomId,
          roomName: currentRoomName,
          pattern: text,
          type: 'contains'
        });
        if (res.ok) {
          persistConfig(true);
          showToast(`已${scope === 'global' ? '全局' : '本房间'}屏蔽「${text}」`);
        } else {
          showToast(res.error || '屏蔽失败');
        }
      } else if (action === 'refresh-radar') {
        renderPanel();
        showToast('已刷新实时刷屏榜');
      } else if (action === 'delete-room') {
        const rid = target.dataset.roomId;
        if (rid && engine.config.rooms[rid]) {
          delete engine.config.rooms[rid];
          persistConfig(true);
          showToast('已移除该直播间配置');
        }
      } else if (action === 'clear-logs') {
        engine.clearLogs();
        renderPanel();
        showToast('已清空拦截日志');
      } else if (action === 'reset-stats') {
        engine.resetStats();
        updateDockBadge();
        renderPanel();
        showToast('已重置本次统计');
      } else if (action === 'undo-log-rule') {
        const scope = target.dataset.scope;
        const ruleId = target.dataset.ruleId;
        const rid = target.dataset.roomId || currentRoomId;
        if (ruleId && scope) {
          engine.removeRule({ scope, roomId: rid, ruleId });
          persistConfig(true);
          showToast('已撤销该屏蔽规则');
        }
      } else if (action === 'export-config') {
        const json = JSON.stringify(engine.getConfig(), null, 2);
        const blob = new Blob([json], { type: 'application/json' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `douyin-danmaku-blocker-${new Date().toISOString().slice(0, 10)}.json`;
        a.click();
        setTimeout(() => URL.revokeObjectURL(url), 2000);
        showToast('配置已导出');
      } else if (action === 'import-config') {
        const fileInput = document.createElement('input');
        fileInput.type = 'file';
        fileInput.accept = '.json,application/json';
        fileInput.onchange = () => {
          const file = fileInput.files && fileInput.files[0];
          if (!file) return;
          const reader = new FileReader();
          reader.onload = () => {
            try {
              const parsed = JSON.parse(String(reader.result || ''));
              engine.setConfig(parsed);
              persistConfig(true);
              showToast('配置导入成功');
            } catch (err) {
              showToast('导入失败：JSON 格式无效');
            }
          };
          reader.readAsText(file);
        };
        fileInput.click();
      } else if (action === 'save-selectors') {
        const vSel = bodyEl.querySelector('.dy-df-custom-video-sel');
        const cSel = bodyEl.querySelector('.dy-df-custom-chat-sel');
        engine.config.advanced.customVideoSelectors = vSel ? vSel.value.trim() : '';
        engine.config.advanced.customChatSelectors = cSel ? cSel.value.trim() : '';
        persistConfig(true);
        showToast('自定义选择器已保存并生效');
      }
    });

    bodyEl.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && e.target.classList.contains('dy-df-rule-input')) {
        e.preventDefault();
        const addBtn = bodyEl.querySelector('[data-action="add-rule"]');
        if (addBtn) addBtn.click();
      }
    });

    bodyEl.addEventListener('change', (e) => {
      const el = e.target;
      const setting = el.dataset.setting;

      if (el.dataset.action === 'toggle-rule') {
        engine.toggleRule({
          scope: el.dataset.scope,
          roomId: el.dataset.roomId || currentRoomId,
          ruleId: el.dataset.ruleId,
          enabled: el.checked
        });
        persistConfig(true);
        return;
      }

      if (el.dataset.action === 'toggle-room-enabled') {
        const room = engine.ensureRoom(currentRoomId, currentRoomName);
        if (room) {
          room.enabled = el.checked;
          persistConfig(true);
        }
        return;
      }

      if (!setting) return;
      const [group, key] = setting.split('.');
      if (!engine.config[group]) return;

      if (el.type === 'checkbox') {
        engine.config[group][key] = el.checked;
      } else if (el.type === 'number') {
        engine.config[group][key] = Number(el.value);
        engine.setConfig(engine.config); // clamp values safely
      }
      persistConfig(true);
    });
  }

  function renderRuleItems(rules, scope, roomId) {
    if (!rules || rules.length === 0) {
      return `<div class="dy-df-empty">暂无屏蔽规则，在上方输入关键词或从「刷屏雷达」一键添加</div>`;
    }
    return `<div class="dy-df-list">` + rules.map((r) => `
      <div class="dy-df-rule-item ${r.enabled === false ? 'is-off' : ''}">
        <div class="dy-df-rule-main" title="${escapeHtml(r.pattern)}">
          <span class="dy-df-tag type-${escapeHtml(r.type)}">${TYPE_LABELS[r.type] || '包含'}</span>
          <span class="dy-df-rule-text">${escapeHtml(r.pattern)}</span>
        </div>
        <div class="dy-df-rule-actions">
          <label class="dy-df-switch" title="启用/停用此规则">
            <input type="checkbox" data-action="toggle-rule" data-scope="${scope}" data-room-id="${escapeHtml(roomId || '')}" data-rule-id="${escapeHtml(r.id)}" ${r.enabled !== false ? 'checked' : ''} />
            <span class="dy-df-slider"></span>
          </label>
          <button class="dy-df-btn dy-df-btn-sm dy-df-btn-danger" data-action="delete-rule" data-scope="${scope}" data-room-id="${escapeHtml(roomId || '')}" data-rule-id="${escapeHtml(r.id)}">删除</button>
        </div>
      </div>
    `).join('') + `</div>`;
  }

  function renderPanel(prefillText = '') {
    if (!bodyEl) return;
    masterToggleEl.checked = engine.config.enabled;
    updateHeaderSubtitle();
    updateDockBadge();

    if (activeTab === 'room') {
      const room = currentRoomId ? engine.config.rooms[currentRoomId] : null;
      const roomRules = room ? room.rules : [];
      const roomEnabled = room ? room.enabled !== false : true;

      bodyEl.innerHTML = `
        <div class="dy-df-section">
          ${currentRoomId ? `
            <div class="dy-df-card">
              <div class="dy-df-row-between">
                <div>
                  <div style="font-weight:600;">启用当前直播间专属规则</div>
                  <div class="dy-df-hint">仅在本主播直播间生效，不影响其他直播间</div>
                </div>
                <label class="dy-df-switch">
                  <input type="checkbox" data-action="toggle-room-enabled" ${roomEnabled ? 'checked' : ''} />
                  <span class="dy-df-slider"></span>
                </label>
              </div>
            </div>
            <div class="dy-df-add-row">
              <input class="dy-df-input dy-df-rule-input" type="text" placeholder="输入本直播间特色刷屏词，回车添加..." value="${escapeHtml(prefillText)}" />
              <select class="dy-df-select dy-df-rule-type" title="匹配方式">
                <option value="contains">包含</option>
                <option value="exact">精确</option>
                <option value="regex">正则</option>
                <option value="user">用户</option>
              </select>
              <button class="dy-df-btn dy-df-btn-primary" data-action="add-rule" data-scope="room">添加</button>
            </div>
            <div class="dy-df-section-title">
              <span>本房间规则 (${roomRules.length})</span>
              <span style="font-weight:400;">鼠标悬停右侧弹幕也可一键屏蔽</span>
            </div>
            ${renderRuleItems(roomRules, 'room', currentRoomId)}
          ` : `
            <div class="dy-df-empty">
              当前页面未检测到直播间 ID。<br/>进入具体直播间后，这里会自动绑定该主播的专属屏蔽规则；你现在可以先配置「全局规则」。
            </div>
          `}
        </div>
      `;
      if (prefillText) {
        const inp = bodyEl.querySelector('.dy-df-rule-input');
        if (inp) {
          inp.focus();
          inp.select();
        }
      }
      return;
    }

    if (activeTab === 'radar') {
      const topList = engine.getTopDanmaku(currentRoomId, 15);
      const as = engine.config.antiSpam;
      bodyEl.innerHTML = `
        <div class="dy-df-section">
          <div class="dy-df-section-title">
            <span>🔥 智能防刷屏（自动折叠重复弹幕）</span>
          </div>
          <div class="dy-df-card">
            <div class="dy-df-row-between">
              <div>
                <div style="font-weight:600;">开启重复弹幕折叠</div>
                <div class="dy-df-hint">相同或相似的刷屏弹幕短时间内仅保留前几条</div>
              </div>
              <label class="dy-df-switch">
                <input type="checkbox" data-setting="antiSpam.enabled" ${as.enabled ? 'checked' : ''} />
                <span class="dy-df-slider"></span>
              </label>
            </div>
            <div class="dy-df-row-between">
              <span>检测窗口（秒） / 最多放行条数</span>
              <div style="display:flex;align-items:center;gap:6px;">
                <input class="dy-df-input dy-df-num-input" type="number" min="2" max="120" data-setting="antiSpam.windowSeconds" value="${as.windowSeconds}" />
                <span style="color:var(--dy-text-muted);">秒</span>
                <input class="dy-df-input dy-df-num-input" type="number" min="1" max="20" data-setting="antiSpam.maxRepeats" value="${as.maxRepeats}" />
                <span style="color:var(--dy-text-muted);">条</span>
              </div>
            </div>
            <div class="dy-df-row-between">
              <div>
                <div>模糊归并（忽略空格/标点/拉长字）</div>
                <div class="dy-df-hint">将「哈哈哈」「哈哈哈哈！」视为同一刷屏词</div>
              </div>
              <label class="dy-df-switch">
                <input type="checkbox" data-setting="antiSpam.normalizeSpaces" ${as.normalizeSpaces ? 'checked' : ''} />
                <span class="dy-df-slider"></span>
              </label>
            </div>
            <div class="dy-df-row-between">
              <div>
                <div>屏蔽纯重复字符刷屏</div>
                <div class="dy-df-hint">如连续 ${as.repeatCharThreshold}+ 个相同字符（666666、？？？？？？）</div>
              </div>
              <label class="dy-df-switch">
                <input type="checkbox" data-setting="antiSpam.blockLongRepeatChar" ${as.blockLongRepeatChar ? 'checked' : ''} />
                <span class="dy-df-slider"></span>
              </label>
            </div>
          </div>
        </div>

        <div class="dy-df-section">
          <div class="dy-df-section-title">
            <span>📡 近 60 秒高频刷屏榜（点击一键屏蔽）</span>
            <button class="dy-df-btn dy-df-btn-sm" data-action="refresh-radar">刷新</button>
          </div>
          ${topList.length === 0 ? `
            <div class="dy-df-empty">正在收集当前直播间弹幕频率，稍等几秒点击「刷新」即可看到刷屏热词</div>
          ` : `
            <div class="dy-df-list">
              ${topList.map((item) => `
                <div class="dy-df-rule-item">
                  <div class="dy-df-rule-main" title="${escapeHtml(item.text)}">
                    <span class="dy-df-radar-count">×${item.count}</span>
                    <span class="dy-df-rule-text">${escapeHtml(item.text)}</span>
                  </div>
                  <div class="dy-df-rule-actions">
                    ${currentRoomId ? `<button class="dy-df-btn dy-df-btn-sm dy-df-btn-primary" data-action="radar-block" data-scope="room" data-text="${escapeHtml(item.text)}">屏本房</button>` : ''}
                    <button class="dy-df-btn dy-df-btn-sm" data-action="radar-block" data-scope="global" data-text="${escapeHtml(item.text)}">屏全局</button>
                  </div>
                </div>
              `).join('')}
            </div>
          `}
        </div>
      `;
      return;
    }

    if (activeTab === 'global') {
      const savedRooms = Object.values(engine.config.rooms).filter((r) => r.rules && r.rules.length > 0);
      bodyEl.innerHTML = `
        <div class="dy-df-section">
          <div class="dy-df-add-row">
            <input class="dy-df-input dy-df-rule-input" type="text" placeholder="输入所有直播间通用屏蔽词，回车添加..." />
            <select class="dy-df-select dy-df-rule-type" title="匹配方式">
              <option value="contains">包含</option>
              <option value="exact">精确</option>
              <option value="regex">正则</option>
              <option value="user">用户</option>
            </select>
            <button class="dy-df-btn dy-df-btn-primary" data-action="add-rule" data-scope="global">添加</button>
          </div>
          <div class="dy-df-section-title">
            <span>全局规则 (${engine.config.globalRules.length})</span>
            <span style="font-weight:400;">对所有抖音直播间生效</span>
          </div>
          ${renderRuleItems(engine.config.globalRules, 'global', '')}
        </div>

        <div class="dy-df-section">
          <div class="dy-df-section-title">
            <span>已保存的直播间专属配置 (${savedRooms.length})</span>
          </div>
          ${savedRooms.length === 0 ? `
            <div class="dy-df-empty">尚未保存任何单个直播间的专属规则</div>
          ` : `
            <div class="dy-df-list">
              ${savedRooms.map((r) => `
                <div class="dy-df-rule-item">
                  <div class="dy-df-rule-main">
                    <span class="dy-df-tag">${r.rules.length} 条</span>
                    <span class="dy-df-rule-text">${escapeHtml(r.name || '直播间 ' + r.roomId)} (${escapeHtml(r.roomId)})</span>
                  </div>
                  <div class="dy-df-rule-actions">
                    <button class="dy-df-btn dy-df-btn-sm dy-df-btn-danger" data-action="delete-room" data-room-id="${escapeHtml(r.roomId)}">清除</button>
                  </div>
                </div>
              `).join('')}
            </div>
          `}
        </div>
      `;
      return;
    }

    // Tab: settings & logs
    const sc = engine.config.scope;
    const sf = engine.config.systemFilter;
    const adv = engine.config.advanced;
    const logs = engine.getBlockedLogs(30);

    bodyEl.innerHTML = `
      <div class="dy-df-section">
        <div class="dy-df-section-title"><span>拦截范围</span></div>
        <div class="dy-df-card">
          <div class="dy-df-row-between">
            <span>屏蔽视频画面飘屏弹幕</span>
            <label class="dy-df-switch"><input type="checkbox" data-setting="scope.videoDanmu" ${sc.videoDanmu ? 'checked' : ''} /><span class="dy-df-slider"></span></label>
          </div>
          <div class="dy-df-row-between">
            <span>屏蔽右侧公屏聊天消息</span>
            <label class="dy-df-switch"><input type="checkbox" data-setting="scope.chatRoom" ${sc.chatRoom ? 'checked' : ''} /><span class="dy-df-slider"></span></label>
          </div>
          <div class="dy-df-row-between">
            <span>兼容 Canvas 渲染飘屏模式</span>
            <label class="dy-df-switch"><input type="checkbox" data-setting="scope.canvasHook" ${sc.canvasHook ? 'checked' : ''} /><span class="dy-df-slider"></span></label>
          </div>
          <div class="dy-df-row-between">
            <span>公屏鼠标悬停显示一键屏蔽按钮</span>
            <label class="dy-df-switch"><input type="checkbox" data-setting="scope.hoverQuickBlock" ${sc.hoverQuickBlock ? 'checked' : ''} /><span class="dy-df-slider"></span></label>
          </div>
        </div>
      </div>

      <div class="dy-df-section">
        <div class="dy-df-section-title"><span>公屏系统消息净化（可选）</span></div>
        <div class="dy-df-card">
          <div class="dy-df-row-between">
            <span>屏蔽「来了 / 加入直播间」提示</span>
            <label class="dy-df-switch"><input type="checkbox" data-setting="systemFilter.hideEnter" ${sf.hideEnter ? 'checked' : ''} /><span class="dy-df-slider"></span></label>
          </div>
          <div class="dy-df-row-between">
            <span>屏蔽「送出礼物」公屏刷屏</span>
            <label class="dy-df-switch"><input type="checkbox" data-setting="systemFilter.hideGift" ${sf.hideGift ? 'checked' : ''} /><span class="dy-df-slider"></span></label>
          </div>
          <div class="dy-df-row-between">
            <span>屏蔽「关注了主播」提示</span>
            <label class="dy-df-switch"><input type="checkbox" data-setting="systemFilter.hideFollow" ${sf.hideFollow ? 'checked' : ''} /><span class="dy-df-slider"></span></label>
          </div>
          <div class="dy-df-row-between">
            <span>屏蔽「为主播点赞了」提示</span>
            <label class="dy-df-switch"><input type="checkbox" data-setting="systemFilter.hideLike" ${sf.hideLike ? 'checked' : ''} /><span class="dy-df-slider"></span></label>
          </div>
        </div>
      </div>

      <div class="dy-df-section">
        <div class="dy-df-section-title">
          <span>最近拦截日志 (${logs.length})</span>
          <div style="display:flex;gap:6px;">
            <button class="dy-df-btn dy-df-btn-sm" data-action="reset-stats">重置计数</button>
            <button class="dy-df-btn dy-df-btn-sm" data-action="clear-logs">清空</button>
          </div>
        </div>
        ${logs.length === 0 ? `
          <div class="dy-df-empty">暂未拦截到弹幕</div>
        ` : `
          <div class="dy-df-list">
            ${logs.map((log) => `
              <div class="dy-df-log-item">
                <div class="dy-df-log-meta">
                  <div>
                    <span class="dy-df-tag reason-${escapeHtml(log.reason)}">${REASON_LABELS[log.reason] || '已拦截'}</span>
                    <span>${escapeHtml(log.detail || '')}</span>
                  </div>
                  <span>${formatTime(log.ts)}</span>
                </div>
                <div class="dy-df-log-text">
                  ${log.username ? `<strong style="color:#93c5fd;">${escapeHtml(log.username)}：</strong>` : ''}${escapeHtml(log.text)}
                </div>
                ${log.ruleId && log.scope ? `
                  <div style="margin-top:4px;text-align:right;">
                    <button class="dy-df-btn dy-df-btn-sm" data-action="undo-log-rule" data-scope="${escapeHtml(log.scope)}" data-room-id="${escapeHtml(log.roomId || '')}" data-rule-id="${escapeHtml(log.ruleId)}">误杀？撤销此规则</button>
                  </div>
                ` : ''}
              </div>
            `).join('')}
          </div>
        `}
      </div>

      <div class="dy-df-section">
        <div class="dy-df-section-title"><span>备份与高级兜底设置</span></div>
        <div class="dy-df-card">
          <div style="display:flex;gap:8px;margin-bottom:10px;">
            <button class="dy-df-btn" style="flex:1;" data-action="export-config">导出规则 JSON</button>
            <button class="dy-df-btn" style="flex:1;" data-action="import-config">导入规则 JSON</button>
          </div>
          <div class="dy-df-hint" style="margin-bottom:8px;padding:6px 8px;border-radius:6px;background:rgba(255,255,255,0.04);">
            页面检测状态：飘屏容器 <strong>${safeQueryAll(document, getVideoContainerSelector()).length}</strong> 个 · 公屏消息 <strong>${safeQueryAll(document, getChatItemSelector()).length}</strong> 条 · 已追踪节点 <strong>${trackedNodes.size}</strong>${(() => {
              try {
                if (typeof window.__DY_DF_GET_CANVAS_STATS__ === 'function') {
                  const cs = window.__DY_DF_GET_CANVAS_STATS__();
                  const ctxLabel = cs.danmuContextType ? ` · 上下文 <strong>${escapeHtml(cs.danmuContextType)}</strong>` : '';
                  const sample = cs.lastTextSample ? ` · 样本「${escapeHtml(cs.lastTextSample)}」` : '';
                  return `<br/>Canvas 拦截：Hook <strong>${cs.hookedPrototypes}</strong> · 文本绘制 <strong>${cs.textCalls}</strong> · 已拦绘制 <strong>${cs.blockedTextCalls + cs.blockedDrawImageCalls}</strong>${ctxLabel}<br/>Worker 通道：Offscreen转移 <strong>${cs.offscreenTransfers}</strong> · 检查 <strong>${cs.workerMsgChecked}</strong> · 已拦 <strong>${cs.workerMsgBlocked}</strong>${sample}`;
                }
              } catch (_) {}
              return '';
            })()}
          </div>
          <div class="dy-df-hint" style="margin-bottom:6px;">如果未来抖音网页版改版导致选择器变化，可在此追加自定义 CSS 选择器（逗号分隔）：</div>
          <input class="dy-df-input dy-df-custom-video-sel" style="width:100%;margin-bottom:6px;" placeholder="额外飘屏弹幕容器选择器（可选）" value="${escapeHtml(adv.customVideoSelectors)}" />
          <input class="dy-df-input dy-df-custom-chat-sel" style="width:100%;margin-bottom:8px;" placeholder="额外公屏消息条目选择器（可选）" value="${escapeHtml(adv.customChatSelectors)}" />
          <button class="dy-df-btn dy-df-btn-sm" data-action="save-selectors">保存自定义选择器</button>
        </div>
      </div>
    `;
  }

  // ==================== Hover Quick-Block on Chatroom ====================
  function closePopover() {
    if (popoverEl) popoverEl.classList.remove('is-open');
    popoverChatInfo = null;
  }

  function hideHoverBtn() {
    if (hoverBtnEl) hoverBtnEl.style.display = 'none';
    hoveredChatInfo = null;
  }

  function setupHoverQuickBlock() {
    document.addEventListener('mouseover', (e) => {
      if (!engine.config.enabled || !engine.config.scope.hoverQuickBlock) return;
      if (!e.target || isInsideExtensionUI(e.target)) return;

      const chatItem = safeClosest(e.target, getChatItemSelector());
      if (!chatItem || chatItem.classList.contains('dy-df-hidden')) return;
      if (safeQueryAll(chatItem, getChatItemSelector()).length > 0) return;

      const parsed = extractChatData(chatItem);
      if (!parsed.content) return;

      clearTimeout(hoverHideTimer);
      hoveredChatInfo = {
        el: chatItem,
        username: parsed.username,
        content: parsed.content
      };

      const rect = chatItem.getBoundingClientRect();
      if (rect.width < 40 || rect.height < 10) return;

      hoverBtnEl.style.display = 'inline-flex';
      hoverBtnEl.style.top = Math.max(8, rect.top + 2) + 'px';
      hoverBtnEl.style.left = Math.min(window.innerWidth - 62, rect.right - 52) + 'px';
    });

    document.addEventListener('mouseout', (e) => {
      if (!hoveredChatInfo) return;
      const related = e.relatedTarget;
      if (related && (related === hoverBtnEl || (popoverEl && popoverEl.contains(related)) || hoveredChatInfo.el.contains(related))) {
        return;
      }
      clearTimeout(hoverHideTimer);
      hoverHideTimer = setTimeout(() => {
        if (!popoverEl || !popoverEl.classList.contains('is-open')) {
          hideHoverBtn();
        }
      }, 260);
    });

    hoverBtnEl.addEventListener('mouseenter', () => clearTimeout(hoverHideTimer));

    hoverBtnEl.addEventListener('click', (e) => {
      e.stopPropagation();
      if (!hoveredChatInfo) return;
      popoverChatInfo = { ...hoveredChatInfo };

      const rect = hoverBtnEl.getBoundingClientRect();
      const top = Math.min(window.innerHeight - 210, Math.max(12, rect.bottom + 6));
      const left = Math.min(window.innerWidth - 252, Math.max(12, rect.right - 240));

      popoverEl.style.top = top + 'px';
      popoverEl.style.left = left + 'px';
      popoverEl.innerHTML = `
        <div class="dy-df-popover-preview">
          ${popoverChatInfo.username ? `<strong>${escapeHtml(popoverChatInfo.username)}：</strong>` : ''}${escapeHtml(popoverChatInfo.content)}
        </div>
        ${currentRoomId ? `<button class="dy-df-btn dy-df-btn-primary" data-pop-action="block-room">屏蔽此内容（仅本房间）</button>` : ''}
        <button class="dy-df-btn" data-pop-action="block-global">屏蔽此内容（全局生效）</button>
        ${popoverChatInfo.username ? `<button class="dy-df-btn" data-pop-action="block-user">屏蔽该用户「${escapeHtml(popoverChatInfo.username.slice(0, 12))}」</button>` : ''}
        <button class="dy-df-btn" data-pop-action="edit-then-block">提取部分关键词再屏蔽...</button>
      `;
      popoverEl.classList.add('is-open');
    });

    popoverEl.addEventListener('click', (e) => {
      const btn = e.target.closest('[data-pop-action]');
      if (!btn || !popoverChatInfo) return;
      const act = btn.dataset.popAction;

      if (act === 'block-room') {
        engine.addRule({
          scope: 'room',
          roomId: currentRoomId,
          roomName: currentRoomName,
          pattern: popoverChatInfo.content,
          type: 'contains'
        });
        persistConfig(true);
        showToast(`已本房间屏蔽「${popoverChatInfo.content.slice(0, 18)}」`);
      } else if (act === 'block-global') {
        engine.addRule({
          scope: 'global',
          pattern: popoverChatInfo.content,
          type: 'contains'
        });
        persistConfig(true);
        showToast(`已全局屏蔽「${popoverChatInfo.content.slice(0, 18)}」`);
      } else if (act === 'block-user') {
        engine.addRule({
          scope: currentRoomId ? 'room' : 'global',
          roomId: currentRoomId,
          roomName: currentRoomName,
          pattern: popoverChatInfo.username,
          type: 'user'
        });
        persistConfig(true);
        showToast(`已屏蔽用户「${popoverChatInfo.username}」`);
      } else if (act === 'edit-then-block') {
        const prefill = popoverChatInfo.content;
        activeTab = currentRoomId ? 'room' : 'global';
        rootEl.querySelectorAll('.dy-df-tab').forEach((b) =>
          b.classList.toggle('is-active', b.dataset.tab === activeTab)
        );
        closePopover();
        hideHoverBtn();
        panelOpen = true;
        panelEl.classList.add('is-open');
        renderPanel(prefill);
        return;
      }

      closePopover();
      hideHoverBtn();
    });

    document.addEventListener('click', (e) => {
      if (popoverEl && popoverEl.classList.contains('is-open') && !popoverEl.contains(e.target) && e.target !== hoverBtnEl) {
        closePopover();
      }
    });
  }

  // ==================== MutationObserver & Global Listeners ====================
  function startObserver() {
    if (!document.body) return;
    if (activeObserver && observedBody === document.body) return;

    if (activeObserver) {
      try {
        activeObserver.disconnect();
      } catch (_) {
        // Ignore
      }
    }

    observedBody = document.body;
    activeObserver = new MutationObserver((mutations) => {
      for (let i = 0; i < mutations.length; i++) {
        const m = mutations[i];
        if (m.type === 'childList') {
          if (m.addedNodes.length > 0) {
            for (let j = 0; j < m.addedNodes.length; j++) {
              const node = m.addedNodes[j];
              if (node.nodeType === 1 || node.nodeType === 3) {
                scheduleScan(node);
              }
            }
          }
        } else if (m.type === 'characterData' && m.target) {
          scheduleScan(m.target);
        }
      }
    });

    activeObserver.observe(document.body, {
      childList: true,
      subtree: true,
      characterData: true
    });
  }

  // Keyboard shortcut: Alt + B
  document.addEventListener('keydown', (e) => {
    if (e.altKey && !e.ctrlKey && !e.metaKey && e.key.toLowerCase() === 'b') {
      if (!uiMounted && isLiveContextPage()) mountUI();
      if (uiMounted) {
        e.preventDefault();
        setPanelOpen(!panelOpen);
      }
    }
  });

  // Keep UI visible when entering/exiting fullscreen video
  document.addEventListener('fullscreenchange', () => {
    if (!rootEl) return;
    const target = document.fullscreenElement || document.body;
    if (target && rootEl.parentElement !== target) {
      target.appendChild(rootEl);
    }
  });

  // Listen for extension popup messages
  if (typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.onMessage) {
    chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
      if (!msg || typeof msg !== 'object') return;
      if (msg.type === 'GET_STATUS') {
        sendResponse({
          roomId: currentRoomId,
          roomName: currentRoomName || (currentRoomId && engine.config.rooms[currentRoomId] && engine.config.rooms[currentRoomId].name) || '',
          enabled: engine.config.enabled,
          stats: engine.stats,
          activeRuleCount: engine.getActiveRules(currentRoomId).length,
          topDanmaku: engine.getTopDanmaku(currentRoomId, 5)
        });
      } else if (msg.type === 'TOGGLE_PANEL') {
        if (!uiMounted) mountUI();
        setPanelOpen(true);
        sendResponse({ ok: true });
      }
    });
  }

  // ==================== Bootstrap ====================
  async function init() {
    const saved = await storage.load();
    if (saved) {
      engine.setConfig(saved);
    }

    storage.subscribe((newVal) => {
      if (isSavingLocal || !newVal) return;
      engine.setConfig(newVal);
      syncCanvasHook();
      rescanAll();
      if (panelOpen) renderPanel();
      updateDockBadge();
    });

    refreshRoomContext(true);
    syncCanvasHook();
    startObserver();

    // Lightweight 400ms safety sweep for pooled/recycled DOM danmaku & React re-renders
    setInterval(() => {
      sweepLiveContainers();
    }, 400);

    // SPA URL, observer health, & streamer name polling (lightweight 1s check)
    setInterval(() => {
      startObserver();
      if (location.href !== lastUrl) {
        lastUrl = location.href;
        refreshRoomContext(true);
      } else {
        refreshRoomContext(false);
      }
    }, 1000);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
