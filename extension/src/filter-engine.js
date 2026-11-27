/**
 * Douyin Live Danmaku Blocker - Core Filter Engine
 * Supports per-room rules, global rules, regex/exact/contains/user matching,
 * sliding-window anti-spam deduplication, and hot-danmaku radar analytics.
 *
 * Works in Browser (window.DYDanmakuEngine) and Node.js (module.exports).
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    root.DYDanmakuEngine = factory();
  }
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const CONFIG_VERSION = 1;

  const DEFAULT_CONFIG = {
    version: CONFIG_VERSION,
    enabled: true,
    scope: {
      videoDanmu: true,
      chatRoom: true,
      canvasHook: true,
      hoverQuickBlock: true
    },
    systemFilter: {
      hideEnter: false,
      hideGift: false,
      hideFollow: false,
      hideLike: false
    },
    antiSpam: {
      enabled: true,
      windowSeconds: 8,
      maxRepeats: 2,
      normalizeSpaces: true,
      blockLongRepeatChar: false,
      repeatCharThreshold: 6
    },
    globalRules: [],
    rooms: {},
    advanced: {
      customVideoSelectors: '',
      customChatSelectors: ''
    }
  };

  function deepClone(obj) {
    return JSON.parse(JSON.stringify(obj));
  }

  function generateId() {
    return 'r_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 8);
  }

  /**
   * Merge loaded/imported config with defaults safely.
   */
  function normalizeConfig(raw) {
    const base = deepClone(DEFAULT_CONFIG);
    if (!raw || typeof raw !== 'object') return base;

    base.enabled = typeof raw.enabled === 'boolean' ? raw.enabled : base.enabled;

    if (raw.scope && typeof raw.scope === 'object') {
      base.scope = {
        videoDanmu: typeof raw.scope.videoDanmu === 'boolean' ? raw.scope.videoDanmu : true,
        chatRoom: typeof raw.scope.chatRoom === 'boolean' ? raw.scope.chatRoom : true,
        canvasHook: typeof raw.scope.canvasHook === 'boolean' ? raw.scope.canvasHook : true,
        hoverQuickBlock: typeof raw.scope.hoverQuickBlock === 'boolean' ? raw.scope.hoverQuickBlock : true
      };
    }

    if (raw.systemFilter && typeof raw.systemFilter === 'object') {
      base.systemFilter = {
        hideEnter: Boolean(raw.systemFilter.hideEnter),
        hideGift: Boolean(raw.systemFilter.hideGift),
        hideFollow: Boolean(raw.systemFilter.hideFollow),
        hideLike: Boolean(raw.systemFilter.hideLike)
      };
    }

    if (raw.antiSpam && typeof raw.antiSpam === 'object') {
      base.antiSpam = {
        enabled: typeof raw.antiSpam.enabled === 'boolean' ? raw.antiSpam.enabled : true,
        windowSeconds: clampNumber(raw.antiSpam.windowSeconds, 2, 120, 8),
        maxRepeats: clampNumber(raw.antiSpam.maxRepeats, 1, 20, 2),
        normalizeSpaces: typeof raw.antiSpam.normalizeSpaces === 'boolean' ? raw.antiSpam.normalizeSpaces : true,
        blockLongRepeatChar: Boolean(raw.antiSpam.blockLongRepeatChar),
        repeatCharThreshold: clampNumber(raw.antiSpam.repeatCharThreshold, 3, 30, 6)
      };
    }

    if (Array.isArray(raw.globalRules)) {
      base.globalRules = raw.globalRules.map(normalizeRule).filter(Boolean);
    }

    if (raw.rooms && typeof raw.rooms === 'object') {
      for (const [roomId, roomData] of Object.entries(raw.rooms)) {
        if (!roomId || !roomData || typeof roomData !== 'object') continue;
        base.rooms[String(roomId)] = {
          roomId: String(roomId),
          name: typeof roomData.name === 'string' ? roomData.name.slice(0, 60) : '',
          enabled: typeof roomData.enabled === 'boolean' ? roomData.enabled : true,
          rules: Array.isArray(roomData.rules)
            ? roomData.rules.map(normalizeRule).filter(Boolean)
            : []
        };
      }
    }

    if (raw.advanced && typeof raw.advanced === 'object') {
      base.advanced = {
        customVideoSelectors: typeof raw.advanced.customVideoSelectors === 'string'
          ? raw.advanced.customVideoSelectors
          : '',
        customChatSelectors: typeof raw.advanced.customChatSelectors === 'string'
          ? raw.advanced.customChatSelectors
          : ''
      };
    }

    return base;
  }

  function clampNumber(val, min, max, fallback) {
    const n = Number(val);
    if (!Number.isFinite(n)) return fallback;
    return Math.min(max, Math.max(min, Math.round(n)));
  }

  function normalizeRule(rule) {
    if (!rule || typeof rule !== 'object') return null;
    const pattern = typeof rule.pattern === 'string' ? rule.pattern.trim() : '';
    if (!pattern) return null;
    const validTypes = ['contains', 'exact', 'regex', 'user'];
    const type = validTypes.includes(rule.type) ? rule.type : 'contains';
    return {
      id: typeof rule.id === 'string' && rule.id ? rule.id : generateId(),
      pattern,
      type,
      enabled: typeof rule.enabled === 'boolean' ? rule.enabled : true,
      createdAt: typeof rule.createdAt === 'number' ? rule.createdAt : Date.now(),
      note: typeof rule.note === 'string' ? rule.note.slice(0, 80) : ''
    };
  }

  /**
   * Normalize danmaku text for anti-spam deduplication & hot-danmaku radar.
   * Strips punctuation/spaces/zero-width chars and collapses long character runs.
   */
  function normalizeForSpam(text, fuzzy) {
    if (!text) return '';
    let s = String(text)
      .replace(/[\u200B-\u200D\uFEFF]/g, '')
      .trim()
      .toLowerCase();
    if (!fuzzy) return s;

    // Strip spaces and common Chinese/English punctuation
    s = s.replace(/[\s~～`!！?？.,。，、;；:：'"“”‘’()（）【】[\]{}<>《》\-—_+=·…|\\/]+/g, '');
    // Collapse 3+ consecutive identical characters to 2 (e.g. "哈哈哈哈哈" -> "哈哈", "66666" -> "66")
    s = s.replace(/(.)\1{2,}/gu, '$1$1');
    return s;
  }

  /**
   * Detect pure repeated-character or repeated short-token spam (e.g. "666666", "哈哈哈哈哈哈", "12121212").
   */
  function isLongRepeatSpam(text, threshold) {
    const cleaned = String(text || '').replace(/\s+/g, '');
    if (cleaned.length < threshold) return false;
    // Same single character repeated >= threshold times consecutively
    const singleRepeat = new RegExp('(.)\\1{' + (threshold - 1) + ',}', 'u');
    if (singleRepeat.test(cleaned)) return true;

    // Short 2-char pattern repeated >= Math.max(4, Math.ceil(threshold / 1.5)) times (e.g., "草草草草", "23232323")
    const pairCount = Math.max(4, Math.ceil(threshold * 0.7));
    const pairRepeat = new RegExp('(.{2})\\1{' + (pairCount - 1) + ',}', 'u');
    if (pairRepeat.test(cleaned)) return true;

    return false;
  }

  /**
   * Parse Douyin chatroom text line into { username, content }.
   * Handles formats like "张三：主播好帅", "LV12 李四: 666", or system messages.
   */
  function parseChatLine(rawText, explicitUsername, explicitContent) {
    const full = String(rawText || '').replace(/\s+/g, ' ').trim();
    if (explicitContent && explicitContent.trim()) {
      const cleanContent = explicitContent.trim();
      let cleanUser = (explicitUsername || '').replace(/[:：\s]+$/, '').trim();
      if (!cleanUser && full && full !== cleanContent) {
        const idx = full.lastIndexOf(cleanContent);
        if (idx > 0) {
          const prefix = full.slice(0, idx).replace(/[:：\s]+$/, '').trim();
          if (prefix && prefix.length <= 40) {
            cleanUser = prefix;
          }
        }
      }
      return {
        username: cleanUser,
        content: cleanContent,
        fullText: full || cleanContent
      };
    }

    if (explicitUsername && explicitUsername.trim()) {
      const cleanUser = explicitUsername.replace(/[:：\s]+$/, '').trim();
      let content = full;
      const idx = full.indexOf(cleanUser);
      if (idx !== -1) {
        content = full.slice(idx + cleanUser.length).replace(/^[:：\s]+/, '').trim();
      }
      return {
        username: cleanUser,
        content: content || full,
        fullText: full
      };
    }

    // Fallback: split on first Chinese or English colon (that is not a timestamp like 12:30)
    const match = full.match(/^([^\n:：]{1,36}?)[：:]\s*(.+)$/);
    if (match && !/^\d{1,2}$/.test(match[1].trim())) {
      return {
        username: match[1].trim(),
        content: match[2].trim(),
        fullText: full
      };
    }

    return {
      username: '',
      content: full,
      fullText: full
    };
  }

  /**
   * Detect system notification messages in chatroom.
   */
  function detectSystemType(text, username) {
    const t = String(text || '').trim();
    if (!t) return null;

    // Enter room
    if (/(?:来了|加入了直播间|进入直播间|进入了直播间)$/.test(t) && t.length <= 40) {
      return 'enter';
    }
    // Gift
    if (/(?:送出了|送出|赠送了|打赏了|送给主播).{1,30}/.test(t) && !username) {
      return 'gift';
    }
    if (/(?:送出了|送出)\s*[\u4e00-\u9fa5A-Za-z0-9\s]+(?:×|x|X|\*)\s*\d+/.test(t)) {
      return 'gift';
    }
    // Follow
    if (/(?:关注了主播|关注了TA)$/.test(t) && t.length <= 40) {
      return 'follow';
    }
    // Like
    if (/(?:为主播点赞了|点亮了小心心|赞了主播)$/.test(t) && t.length <= 45) {
      return 'like';
    }
    return null;
  }

  /**
   * Extract roomId from Douyin Live URL.
   */
  function extractRoomIdFromUrl(urlStr) {
    if (!urlStr) return '';
    try {
      const url = new URL(urlStr);
      // https://live.douyin.com/123456789
      if (url.hostname === 'live.douyin.com') {
        const seg = url.pathname.split('/').filter(Boolean)[0];
        if (seg && /^[a-zA-Z0-9_-]{3,}$/.test(seg) && !['category', 'categorynew', 'search', 'follow'].includes(seg)) {
          return seg;
        }
      }
      // https://www.douyin.com/follow/live/123456789 or /live/123456789
      const liveMatch = url.pathname.match(/\/live\/([a-zA-Z0-9_-]{3,})/);
      if (liveMatch) return liveMatch[1];

      const qRoom = url.searchParams.get('room_id') || url.searchParams.get('web_rid') || url.searchParams.get('anchor_id');
      if (qRoom) return qRoom;
    } catch (_) {
      // Ignore invalid URL
    }
    return '';
  }

  class DanmakuFilterEngine {
    constructor(config) {
      this.config = normalizeConfig(config);
      this.regexCache = new Map();

      // Anti-spam sliding windows: key = `${roomId}::${normText}` -> number[] (timestamps)
      this.spamWindows = new Map();
      // Seen itemKeys so re-evaluating the exact same DOM node+text does not double-count
      this.seenItems = new Map();
      this.rulesVersion = 1;

      // Hot danmaku radar (last 60s): key = `${roomId}::${normText}` -> { text, norm, roomId, timestamps: number[] }
      this.radarMap = new Map();
      this.radarWindowMs = 60 * 1000;

      // Session statistics & recent blocked logs
      this.stats = {
        totalChecked: 0,
        totalBlocked: 0,
        byReason: {
          rule: 0,
          spam: 0,
          system: 0,
          repeat_char: 0
        }
      };
      this.blockedLogs = [];
      this.maxLogs = 60;
      this._lastPruneAt = 0;
    }

    invalidateCache() {
      this.rulesVersion += 1;
      this.regexCache.clear();
      this.seenItems.clear();
    }

    setConfig(newConfig) {
      this.config = normalizeConfig(newConfig);
      this.invalidateCache();
    }

    getConfig() {
      return deepClone(this.config);
    }

    ensureRoom(roomId, roomName) {
      if (!roomId) return null;
      const id = String(roomId);
      if (!this.config.rooms[id]) {
        this.config.rooms[id] = {
          roomId: id,
          name: roomName || '',
          enabled: true,
          rules: []
        };
      } else if (roomName && !this.config.rooms[id].name) {
        this.config.rooms[id].name = roomName;
      }
      return this.config.rooms[id];
    }

    addRule({ scope = 'room', roomId = '', roomName = '', pattern, type = 'contains', note = '' }) {
      const trimmed = String(pattern || '').trim();
      if (!trimmed) return { ok: false, error: '屏蔽词不能为空' };

      if (type === 'regex') {
        try {
          new RegExp(trimmed, 'i');
        } catch (err) {
          return { ok: false, error: '正则表达式语法无效: ' + err.message };
        }
      }

      const targetList = scope === 'global'
        ? this.config.globalRules
        : (this.ensureRoom(roomId, roomName) || {}).rules;

      if (!targetList) {
        return { ok: false, error: '未识别到当前直播间 ID，请改用全局规则' };
      }

      // Prevent exact duplicate
      const exists = targetList.find(
        (r) => r.type === type && r.pattern.toLowerCase() === trimmed.toLowerCase()
      );
      if (exists) {
        exists.enabled = true;
        this.invalidateCache();
        return { ok: true, rule: exists, duplicate: true };
      }

      const rule = normalizeRule({ pattern: trimmed, type, note, enabled: true });
      targetList.unshift(rule);
      this.invalidateCache();
      return { ok: true, rule, duplicate: false };
    }

    removeRule({ scope = 'room', roomId = '', ruleId }) {
      const list = scope === 'global'
        ? this.config.globalRules
        : (this.config.rooms[roomId] && this.config.rooms[roomId].rules);
      if (!Array.isArray(list)) return false;
      const idx = list.findIndex((r) => r.id === ruleId);
      if (idx === -1) return false;
      list.splice(idx, 1);
      this.invalidateCache();
      return true;
    }

    toggleRule({ scope = 'room', roomId = '', ruleId, enabled }) {
      const list = scope === 'global'
        ? this.config.globalRules
        : (this.config.rooms[roomId] && this.config.rooms[roomId].rules);
      if (!Array.isArray(list)) return false;
      const rule = list.find((r) => r.id === ruleId);
      if (!rule) return false;
      rule.enabled = typeof enabled === 'boolean' ? enabled : !rule.enabled;
      this.invalidateCache();
      return true;
    }

    getActiveRules(roomId) {
      const result = [];
      for (const r of this.config.globalRules) {
        if (r.enabled !== false) result.push({ rule: r, scope: 'global' });
      }
      if (roomId && this.config.rooms[roomId] && this.config.rooms[roomId].enabled !== false) {
        for (const r of this.config.rooms[roomId].rules) {
          if (r.enabled !== false) result.push({ rule: r, scope: 'room' });
        }
      }
      return result;
    }

    _getCompiledRegex(pattern) {
      if (this.regexCache.has(pattern)) {
        return this.regexCache.get(pattern);
      }
      try {
        const re = new RegExp(pattern, 'i');
        this.regexCache.set(pattern, re);
        return re;
      } catch (_) {
        this.regexCache.set(pattern, null);
        return null;
      }
    }

    _matchRule(rule, content, username, fullText) {
      const pat = rule.pattern;
      if (!pat) return false;

      if (rule.type === 'user') {
        if (!username) return false;
        const cleanUser = username.replace(/[\u200B-\u200D\uFEFF]/g, '');
        return cleanUser.toLowerCase().includes(pat.toLowerCase());
      }

      const rawTarget = content || fullText || '';
      if (!rawTarget) return false;
      const target = rawTarget.replace(/[\u200B-\u200D\uFEFF]/g, '');
      const cleanFull = fullText ? fullText.replace(/[\u200B-\u200D\uFEFF]/g, '') : '';

      if (rule.type === 'exact') {
        return target.trim().toLowerCase() === pat.trim().toLowerCase();
      }
      if (rule.type === 'regex') {
        const re = this._getCompiledRegex(pat);
        if (!re) return false;
        return re.test(target) || (cleanFull && cleanFull !== target && re.test(cleanFull));
      }
      // Default: 'contains'
      return target.toLowerCase().includes(pat.toLowerCase());
    }

    /**
     * Evaluate a single danmaku/chat message.
     * @param {object} payload
     * @param {string} payload.text - Danmaku content text
     * @param {string} [payload.username] - Sender username (chatroom)
     * @param {string} [payload.fullText] - Full raw text (chatroom)
     * @param {'video'|'chat'|'canvas'} [payload.source='video']
     * @param {string} [payload.roomId='']
     * @param {string} [payload.itemKey] - Unique key per DOM element+text to avoid double counting
     * @param {boolean} [payload.recordStats=true] - Set false during rule rescan
     * @param {number} [now=Date.now()]
     */
    evaluate(payload, now = Date.now()) {
      const {
        text = '',
        username = '',
        fullText = '',
        source = 'video',
        roomId = '',
        itemKey = '',
        recordStats = true
      } = payload || {};

      const content = String(text || '').trim();
      const rawFull = String(fullText || content).trim();
      if (!content && !rawFull) {
        return { blocked: false, reason: null };
      }

      this._maybePrune(now);

      // Avoid double-counting the same DOM item when MutationObserver fires multiple times
      let isDuplicateCheck = false;
      if (itemKey) {
        const prev = this.seenItems.get(itemKey);
        if (prev && prev.rulesVersion === this.rulesVersion && now - prev.ts < 3000) {
          isDuplicateCheck = true;
          // If it's a normal evaluation (not a rule rescan), return cached decision for spam consistency
          if (recordStats && prev.result) {
            return prev.result;
          }
        }
      }

      // Record in Hot Danmaku Radar (even when disabled or before rule matching, so user can spot spam!)
      const systemType = source === 'chat' ? detectSystemType(rawFull, username) : null;
      if (recordStats && !isDuplicateCheck && !systemType && content.length >= 1 && content.length <= 80) {
        this._recordRadar(roomId, content, now);
      }

      if (!this.config.enabled) {
        return { blocked: false, reason: null };
      }

      // Scope check
      if (source === 'video' && !this.config.scope.videoDanmu) {
        return { blocked: false, reason: null };
      }
      if (source === 'chat' && !this.config.scope.chatRoom) {
        return { blocked: false, reason: null };
      }
      if (source === 'canvas' && !this.config.scope.canvasHook) {
        return { blocked: false, reason: null };
      }

      if (recordStats && !isDuplicateCheck) {
        this.stats.totalChecked += 1;
      }

      let decision = { blocked: false, reason: null };

      // 1. System message filters (chatroom)
      if (systemType) {
        const sf = this.config.systemFilter;
        const sysLabels = {
          enter: '进场提示',
          gift: '送礼消息',
          follow: '关注提示',
          like: '点赞提示'
        };
        if (
          (systemType === 'enter' && sf.hideEnter) ||
          (systemType === 'gift' && sf.hideGift) ||
          (systemType === 'follow' && sf.hideFollow) ||
          (systemType === 'like' && sf.hideLike)
        ) {
          decision = {
            blocked: true,
            reason: 'system',
            detail: sysLabels[systemType] || '系统消息'
          };
        }
      }

      // 2. Room & global rules
      if (!decision.blocked) {
        const activeRules = this.getActiveRules(roomId);
        for (const entry of activeRules) {
          if (this._matchRule(entry.rule, content, username, rawFull)) {
            decision = {
              blocked: true,
              reason: 'rule',
              scope: entry.scope,
              rule: entry.rule,
              detail: (entry.scope === 'room' ? '本房规则: ' : '全局规则: ') + entry.rule.pattern
            };
            break;
          }
        }
      }

      // 3. Long repeated-character spam
      if (!decision.blocked && !systemType && this.config.antiSpam.blockLongRepeatChar) {
        if (isLongRepeatSpam(content, this.config.antiSpam.repeatCharThreshold)) {
          decision = {
            blocked: true,
            reason: 'repeat_char',
            detail: '重复字符刷屏'
          };
        }
      }

      // 4. Sliding-window anti-spam deduplication
      if (!decision.blocked && !systemType && this.config.antiSpam.enabled && recordStats && !isDuplicateCheck) {
        const norm = normalizeForSpam(content, this.config.antiSpam.normalizeSpaces);
        if (norm.length >= 1) {
          const key = `${roomId || 'global'}::${source}::${norm}`;
          const windowMs = this.config.antiSpam.windowSeconds * 1000;
          let list = this.spamWindows.get(key);
          if (!list) {
            list = [];
            this.spamWindows.set(key, list);
          }
          // Evict expired timestamps
          const cutoff = now - windowMs;
          while (list.length > 0 && list[0] < cutoff) {
            list.shift();
          }
          list.push(now);

          if (list.length > this.config.antiSpam.maxRepeats) {
            decision = {
              blocked: true,
              reason: 'spam',
              detail: `刷屏折叠 (${this.config.antiSpam.windowSeconds}秒内第${list.length}条)`
            };
          }
        }
      }

      if (itemKey) {
        this.seenItems.set(itemKey, { ts: now, rulesVersion: this.rulesVersion, result: decision });
      }

      if (decision.blocked && recordStats && !isDuplicateCheck) {
        this.stats.totalBlocked += 1;
        if (this.stats.byReason[decision.reason] !== undefined) {
          this.stats.byReason[decision.reason] += 1;
        }
        this.blockedLogs.unshift({
          ts: now,
          text: content || rawFull,
          username,
          source,
          roomId,
          reason: decision.reason,
          detail: decision.detail || '',
          ruleId: decision.rule ? decision.rule.id : '',
          scope: decision.scope || ''
        });
        if (this.blockedLogs.length > this.maxLogs) {
          this.blockedLogs.length = this.maxLogs;
        }
      }

      return decision;
    }

    _recordRadar(roomId, content, now) {
      const norm = normalizeForSpam(content, true);
      if (!norm) return;
      const key = `${roomId || 'global'}::${norm}`;
      let entry = this.radarMap.get(key);
      if (!entry) {
        entry = {
          roomId: roomId || 'global',
          norm,
          sampleText: content,
          timestamps: []
        };
        this.radarMap.set(key, entry);
      } else {
        // Keep the shorter/cleaner sample text
        if (content.length < entry.sampleText.length && content.length >= 2) {
          entry.sampleText = content;
        }
      }
      entry.timestamps.push(now);
    }

    /**
     * Get top repeated danmaku in the given room within the last 60 seconds.
     */
    getTopDanmaku(roomId, limit = 15, now = Date.now()) {
      const cutoff = now - this.radarWindowMs;
      const targetRoom = roomId || 'global';
      const items = [];

      for (const [key, entry] of this.radarMap.entries()) {
        if (entry.roomId !== targetRoom) continue;
        while (entry.timestamps.length > 0 && entry.timestamps[0] < cutoff) {
          entry.timestamps.shift();
        }
        if (entry.timestamps.length === 0) {
          this.radarMap.delete(key);
          continue;
        }
        items.push({
          text: entry.sampleText,
          norm: entry.norm,
          count: entry.timestamps.length,
          lastSeen: entry.timestamps[entry.timestamps.length - 1]
        });
      }

      items.sort((a, b) => b.count - a.count || b.lastSeen - a.lastSeen);
      return items.slice(0, limit);
    }

    getBlockedLogs(limit = 50) {
      return this.blockedLogs.slice(0, limit);
    }

    clearLogs() {
      this.blockedLogs = [];
    }

    resetStats() {
      this.stats = {
        totalChecked: 0,
        totalBlocked: 0,
        byReason: { rule: 0, spam: 0, system: 0, repeat_char: 0 }
      };
      this.blockedLogs = [];
    }

    resetRoomTransientState() {
      this.spamWindows.clear();
      this.seenItems.clear();
    }

    _maybePrune(now) {
      if (now - this._lastPruneAt < 15000) return;
      this._lastPruneAt = now;

      const spamCutoff = now - this.config.antiSpam.windowSeconds * 1000 - 5000;
      for (const [k, list] of this.spamWindows.entries()) {
        while (list.length > 0 && list[0] < spamCutoff) list.shift();
        if (list.length === 0) this.spamWindows.delete(k);
      }

      const seenCutoff = now - 10000;
      for (const [k, item] of this.seenItems.entries()) {
        if (item.ts < seenCutoff || item.rulesVersion !== this.rulesVersion) this.seenItems.delete(k);
      }

      const radarCutoff = now - this.radarWindowMs;
      for (const [k, entry] of this.radarMap.entries()) {
        while (entry.timestamps.length > 0 && entry.timestamps[0] < radarCutoff) {
          entry.timestamps.shift();
        }
        if (entry.timestamps.length === 0) this.radarMap.delete(k);
      }
    }
  }

  return {
    CONFIG_VERSION,
    DEFAULT_CONFIG,
    DanmakuFilterEngine,
    normalizeConfig,
    normalizeRule,
    normalizeForSpam,
    isLongRepeatSpam,
    parseChatLine,
    detectSystemType,
    extractRoomIdFromUrl,
    generateId
  };
});
