/**
 * Douyin Live Danmaku Blocker - MAIN World / Userscript Canvas & Worker Hook
 * Intercepts:
 * 1. CanvasRenderingContext2D & OffscreenCanvasRenderingContext2D (fillText / strokeText / drawImage)
 *    for Douyin's CanvasDanmakuPlugin (#DanmakuLayout canvas) & offscreen sprite caches.
 * 2. Worker.prototype.postMessage / MessagePort.prototype.postMessage / BroadcastChannel.prototype.postMessage
 *    to filter danmaku payloads BEFORE they enter OffscreenCanvas Web Workers.
 * 3. Lightweight diagnostics for transferControlToOffscreen / getContext on #DanmakuLayout canvas.
 */
(function () {
  'use strict';

  const pageWin = (typeof unsafeWindow !== 'undefined' && unsafeWindow) ? unsafeWindow : window;

  if (window.__DY_DF_CANVAS_HOOKED__) return;
  window.__DY_DF_CANVAS_HOOKED__ = true;

  const DANMU_CONTAINER_SELECTOR = [
    '#DanmakuLayout',
    '.CanvasDanmakuPlugin',
    'xg-danmu',
    '.xgplayer-danmu',
    '[id*="danmaku" i]',
    '[class*="danmaku" i]',
    '[id*="danmu" i]',
    '[class*="danmu" i]',
    '[data-e2e*="danmu" i]'
  ].join(', ');

  const PLAYER_CONTAINER_SELECTOR = [
    '.douyin-player',
    '.LivePlayer_LivingPlayer',
    '#PlayerLayout',
    '.xgplayer',
    'xg-player',
    '[class*="player" i]',
    '[id*="player" i]'
  ].join(', ');

  const RICH_TEXT_ARRAY_KEYS = new Set([
    'segments', 'pieces', 'fragments', 'tokens', 'spans', 'parts', 'rtf', 'richText', 'contentList', 'elements'
  ]);

  let state = {
    enabled: false,
    canvasHook: false,
    rules: [],
    antiSpam: {
      enabled: false,
      windowSeconds: 8,
      maxRepeats: 2,
      normalizeSpaces: true,
      blockLongRepeatChar: false,
      repeatCharThreshold: 6
    }
  };

  const stats = {
    hookedPrototypes: 0,
    textCalls: 0,
    blockedTextCalls: 0,
    blockedDrawImageCalls: 0,
    danmuCanvasHits: 0,
    offscreenTransfers: 0,
    workerMsgChecked: 0,
    workerMsgBlocked: 0,
    danmuContextType: '',
    lastTextSample: ''
  };

  const regexCache = new Map();
  const confirmedDanmuCanvas = new WeakSet();
  const blockedSpriteCanvases = new WeakMap();
  const recentDrawDedupe = new Map();

  function applyConfig(detail) {
    if (!detail || typeof detail !== 'object') return;
    state = detail;
    regexCache.clear();
  }

  try {
    window.__DY_DF_SYNC_CANVAS_CONFIG__ = applyConfig;
    window.__DY_DF_GET_CANVAS_STATS__ = () => ({ ...stats });
  } catch (_) {
    // Ignore
  }

  const onSyncEvent = (e) => {
    applyConfig(e && e.detail);
  };
  window.addEventListener('dy-df-sync-canvas-config', onSyncEvent);
  if (pageWin && pageWin !== window && typeof pageWin.addEventListener === 'function') {
    try {
      pageWin.addEventListener('dy-df-sync-canvas-config', onSyncEvent);
    } catch (_) {
      // Ignore
    }
  }

  function safeClosest(el, sel) {
    if (!el || typeof el.closest !== 'function') return null;
    try {
      return el.closest(sel);
    } catch (_) {
      return null;
    }
  }

  function classifyDanmuCanvas(ctx) {
    const canvas = ctx && ctx.canvas;
    if (!canvas) {
      return 'offscreen';
    }
    if (confirmedDanmuCanvas.has(canvas)) {
      return 'danmu';
    }
    if (safeClosest(canvas, '#dy-df-root')) {
      return false;
    }
    if (typeof canvas.closest !== 'function' || canvas.isConnected === false) {
      return 'offscreen';
    }

    if (safeClosest(canvas, DANMU_CONTAINER_SELECTOR)) {
      confirmedDanmuCanvas.add(canvas);
      stats.danmuCanvasHits += 1;
      return 'danmu';
    }
    if (safeClosest(canvas, PLAYER_CONTAINER_SELECTOR)) {
      confirmedDanmuCanvas.add(canvas);
      stats.danmuCanvasHits += 1;
      return 'danmu';
    }

    return 'any';
  }

  function isSingleDanmuSprite(canvas, mode) {
    if (!canvas) return false;
    if (mode === 'offscreen' || mode === 'any') {
      return typeof canvas.height === 'number' && canvas.height > 0 && canvas.height <= 140;
    }
    return false;
  }

  function stripZeroWidth(str) {
    return String(str || '').replace(/[\u200B-\u200D\uFEFF]/g, '');
  }

  function looksLikeUrl(str) {
    return /^(?:https?:|wss?:|data:|blob:|\/\/)/i.test(str);
  }

  function matchCanvasRules(text, mode) {
    const t = stripZeroWidth(text).trim();
    if (!t) return null;

    const lower = t.toLowerCase();
    const rules = state.rules || [];
    for (let i = 0; i < rules.length; i++) {
      const r = rules[i];
      if (!r || !r.pattern) continue;
      if (r.type === 'user') continue;
      const pat = stripZeroWidth(r.pattern).trim();
      if (!pat) continue;

      if (r.type === 'exact') {
        if (lower === pat.toLowerCase()) return { reason: 'rule', detail: r.pattern };
      } else if (r.type === 'regex') {
        let re = regexCache.get(r.pattern);
        if (re === undefined) {
          try {
            re = new RegExp(r.pattern, 'i');
          } catch (_) {
            re = null;
          }
          regexCache.set(r.pattern, re);
        }
        if (re && re.test(t)) return { reason: 'rule', detail: r.pattern };
      } else {
        if (lower.includes(pat.toLowerCase())) return { reason: 'rule', detail: r.pattern };
      }
    }

    if (state.antiSpam && state.antiSpam.blockLongRepeatChar && (mode === 'danmu' || mode === 'offscreen')) {
      const cleaned = t.replace(/\s+/g, '');
      const th = state.antiSpam.repeatCharThreshold || 6;
      if (cleaned.length >= th) {
        const singleRe = new RegExp('(.)\\1{' + (th - 1) + ',}', 'u');
        if (singleRe.test(cleaned)) return { reason: 'repeat_char', detail: '重复字符刷屏' };
      }
    }

    return null;
  }

  function notifyBlocked(text, hit, dedupeMs = 4000) {
    const now = Date.now();
    const key = text + '::' + hit.reason;
    const last = recentDrawDedupe.get(key) || 0;
    if (now - last < dedupeMs) return;
    recentDrawDedupe.set(key, now);
    if (recentDrawDedupe.size > 200) {
      for (const [k, ts] of recentDrawDedupe.entries()) {
        if (now - ts > 8000) recentDrawDedupe.delete(k);
      }
    }
    try {
      window.dispatchEvent(new CustomEvent('dy-df-canvas-blocked', {
        detail: { text: String(text), reason: hit.reason, detail: hit.detail }
      }));
    } catch (_) {
      // Ignore
    }
  }

  // ==================== Worker / MessagePort Payload Filtering ====================
  function isBinaryOrSpecial(val) {
    if (!val || typeof val !== 'object') return false;
    if (val instanceof ArrayBuffer || ArrayBuffer.isView(val)) return true;
    if (typeof Blob !== 'undefined' && val instanceof Blob) return true;
    if (typeof MessagePort !== 'undefined' && val instanceof MessagePort) return true;
    if (typeof OffscreenCanvas !== 'undefined' && val instanceof OffscreenCanvas) return true;
    if (typeof ImageBitmap !== 'undefined' && val instanceof ImageBitmap) return true;
    return false;
  }

  function matchObjectStrings(obj, depth, seen) {
    if (obj == null || depth > 5) return null;
    if (typeof obj === 'string') {
      if (obj.length < 1 || obj.length > 500 || looksLikeUrl(obj)) return null;
      const hit = matchCanvasRules(obj, 'danmu');
      return hit ? { hit, text: obj } : null;
    }
    if (typeof obj !== 'object' || isBinaryOrSpecial(obj)) return null;

    if (!seen) seen = new Set();
    if (seen.has(obj)) return null;
    seen.add(obj);

    if (Array.isArray(obj)) {
      let joined = '';
      for (let i = 0; i < obj.length && i < 60; i++) {
        const item = obj[i];
        const res = matchObjectStrings(item, depth + 1, seen);
        if (res) return res;
        if (typeof item === 'string' && !looksLikeUrl(item)) {
          joined += item;
        } else if (item && typeof item === 'object') {
          const seg = item.text || item.content || item.txt;
          if (typeof seg === 'string' && !looksLikeUrl(seg)) joined += seg;
        }
      }
      if (joined) {
        const hit = matchCanvasRules(joined, 'danmu');
        if (hit) return { hit, text: joined };
      }
      return null;
    }

    const keys = Object.keys(obj);
    for (let i = 0; i < keys.length && i < 40; i++) {
      const k = keys[i];
      if (k === 'buffer' || k === 'canvas' || k === 'image' || k === 'bitmap' || k === 'avatar' || k === 'url' || k === 'src') {
        continue;
      }
      const res = matchObjectStrings(obj[k], depth + 1, seen);
      if (res) return res;
    }
    return null;
  }

  function filterDanmakuArray(arr) {
    let blockedAny = false;
    const kept = [];
    for (let i = 0; i < arr.length; i++) {
      const item = arr[i];
      const res = matchObjectStrings(item, 0, null);
      if (res) {
        blockedAny = true;
        stats.workerMsgBlocked += 1;
        notifyBlocked(res.text, res.hit, 250);
      } else {
        kept.push(item);
      }
    }
    if (!blockedAny) return { changed: false };
    if (kept.length === 0) return { drop: true };
    return { changed: true, value: kept };
  }

  function filterWorkerMessage(data, depth = 0) {
    if (data == null || depth > 2) return { changed: false };

    if (typeof data === 'string') {
      if (data.length < 1 || data.length > 8000 || looksLikeUrl(data)) return { changed: false };
      const hit = matchCanvasRules(data, 'danmu');
      if (!hit) return { changed: false };
      if ((data[0] === '{' || data[0] === '[') && data.length <= 8000) {
        try {
          const parsed = JSON.parse(data);
          const sub = filterWorkerMessage(parsed, depth + 1);
          if (sub.drop) return { drop: true };
          if (sub.changed) return { changed: true, value: JSON.stringify(sub.value) };
        } catch (_) {
          // Fall through to drop
        }
      }
      stats.workerMsgBlocked += 1;
      notifyBlocked(data.slice(0, 120), hit, 250);
      return { drop: true };
    }

    if (typeof data !== 'object' || isBinaryOrSpecial(data)) return { changed: false };

    if (Array.isArray(data)) {
      return filterDanmakuArray(data);
    }

    const keys = Object.keys(data);
    const hasDanmakuIdentity = Boolean(data.danmakuId || data.danmuId || data.msgId || data.chatId);

    // Check if an array property holds a batch of danmaku items (not rich-text segments of 1 danmaku)
    if (!hasDanmakuIdentity) {
      for (let i = 0; i < keys.length && i < 20; i++) {
        const k = keys[i];
        const v = data[k];
        if (Array.isArray(v) && v.length > 0 && !RICH_TEXT_ARRAY_KEYS.has(k)) {
          // Only treat as danmaku batch if elements are objects/strings (not numbers/typed arrays)
          const first = v[0];
          if (first && (typeof first === 'object' || typeof first === 'string') && !isBinaryOrSpecial(first)) {
            const arrRes = filterDanmakuArray(v);
            if (arrRes.drop) return { drop: true };
            if (arrRes.changed) {
              return { changed: true, value: { ...data, [k]: arrRes.value } };
            }
          }
        } else if (depth < 1 && v && typeof v === 'object' && !Array.isArray(v) && !isBinaryOrSpecial(v)) {
          const nested = filterWorkerMessage(v, depth + 1);
          if (nested.drop) return { drop: true };
          if (nested.changed) {
            return { changed: true, value: { ...data, [k]: nested.value } };
          }
        }
      }
    }

    // Single danmaku object check
    const singleHit = matchObjectStrings(data, 0, null);
    if (singleHit) {
      stats.workerMsgBlocked += 1;
      notifyBlocked(singleHit.text, singleHit.hit, 250);
      return { drop: true };
    }

    return { changed: false };
  }

  function patchPostMessagePrototype(proto) {
    if (!proto || proto.__DY_DF_PM_HOOKED__ || typeof proto.postMessage !== 'function') return;
    try {
      Object.defineProperty(proto, '__DY_DF_PM_HOOKED__', {
        value: true,
        configurable: false,
        enumerable: false
      });
    } catch (_) {
      proto.__DY_DF_PM_HOOKED__ = true;
    }

    const origPostMessage = proto.postMessage;
    proto.postMessage = function (message, transfer) {
      if (
        state.enabled &&
        state.canvasHook &&
        state.rules &&
        state.rules.length > 0 &&
        message != null &&
        (typeof message === 'object' || typeof message === 'string') &&
        !isBinaryOrSpecial(message) &&
        !(Array.isArray(transfer) && transfer.length > 0)
      ) {
        stats.workerMsgChecked += 1;
        try {
          const res = filterWorkerMessage(message, 0);
          if (res.drop) return;
          if (res.changed) {
            return arguments.length > 1
              ? origPostMessage.call(this, res.value, transfer)
              : origPostMessage.call(this, res.value);
          }
        } catch (_) {
          // Never break host messaging on unexpected shapes
        }
      }
      return origPostMessage.apply(this, arguments);
    };
  }

  // ==================== Canvas Context & Diagnostics Hooks ====================
  function patchCanvasElementPrototype(proto) {
    if (!proto || proto.__DY_DF_CANVAS_EL_HOOKED__) return;
    try {
      Object.defineProperty(proto, '__DY_DF_CANVAS_EL_HOOKED__', {
        value: true,
        configurable: false,
        enumerable: false
      });
    } catch (_) {
      proto.__DY_DF_CANVAS_EL_HOOKED__ = true;
    }

    if (typeof proto.transferControlToOffscreen === 'function') {
      const origTransfer = proto.transferControlToOffscreen;
      proto.transferControlToOffscreen = function () {
        stats.offscreenTransfers += 1;
        if (safeClosest(this, DANMU_CONTAINER_SELECTOR)) {
          stats.danmuContextType = 'offscreen';
        }
        return origTransfer.apply(this, arguments);
      };
    }

    if (typeof proto.getContext === 'function') {
      const origGetContext = proto.getContext;
      proto.getContext = function (type) {
        if (type && safeClosest(this, DANMU_CONTAINER_SELECTOR)) {
          stats.danmuContextType = String(type);
        }
        return origGetContext.apply(this, arguments);
      };
    }
  }

  function patchContextPrototype(proto) {
    if (!proto || proto.__DY_DF_HOOKED__) return;
    try {
      Object.defineProperty(proto, '__DY_DF_HOOKED__', {
        value: true,
        configurable: false,
        enumerable: false
      });
    } catch (_) {
      proto.__DY_DF_HOOKED__ = true;
    }
    stats.hookedPrototypes += 1;

    const origFillText = proto.fillText;
    const origStrokeText = proto.strokeText;
    const origClearRect = proto.clearRect;
    const origDrawImage = proto.drawImage;

    if (typeof origFillText === 'function') {
      proto.fillText = function (text, x, y, maxWidth) {
        if (text) {
          stats.textCalls += 1;
          stats.lastTextSample = String(text).slice(0, 24);
          if (state.enabled && state.canvasHook) {
            const mode = classifyDanmuCanvas(this);
            if (mode) {
              const now = Date.now();
              const prevSprite = this.canvas ? blockedSpriteCanvases.get(this.canvas) : null;
              if (prevSprite) {
                const resized = this.canvas.width !== prevSprite.width || this.canvas.height !== prevSprite.height;
                if (resized || now - prevSprite.ts > 150) {
                  blockedSpriteCanvases.delete(this.canvas);
                } else {
                  stats.blockedTextCalls += 1;
                  return;
                }
              }

              const hit = matchCanvasRules(text, mode);
              if (hit) {
                stats.blockedTextCalls += 1;
                if (isSingleDanmuSprite(this.canvas, mode)) {
                  blockedSpriteCanvases.set(this.canvas, {
                    ts: now,
                    width: this.canvas.width,
                    height: this.canvas.height
                  });
                }
                notifyBlocked(text, hit);
                return;
              }
            }
          }
        }
        return maxWidth !== undefined
          ? origFillText.call(this, text, x, y, maxWidth)
          : origFillText.call(this, text, x, y);
      };
    }

    if (typeof origStrokeText === 'function') {
      proto.strokeText = function (text, x, y, maxWidth) {
        if (text && state.enabled && state.canvasHook) {
          const mode = classifyDanmuCanvas(this);
          if (mode) {
            const now = Date.now();
            const prevSprite = this.canvas ? blockedSpriteCanvases.get(this.canvas) : null;
            if (prevSprite && this.canvas.width === prevSprite.width && this.canvas.height === prevSprite.height && now - prevSprite.ts <= 150) {
              stats.blockedTextCalls += 1;
              return;
            }
            const hit = matchCanvasRules(text, mode);
            if (hit) {
              stats.blockedTextCalls += 1;
              if (isSingleDanmuSprite(this.canvas, mode)) {
                blockedSpriteCanvases.set(this.canvas, {
                  ts: now,
                  width: this.canvas.width,
                  height: this.canvas.height
                });
              }
              notifyBlocked(text, hit);
              return;
            }
          }
        }
        return maxWidth !== undefined
          ? origStrokeText.call(this, text, x, y, maxWidth)
          : origStrokeText.call(this, text, x, y);
      };
    }

    if (typeof origClearRect === 'function') {
      proto.clearRect = function (x, y, w, h) {
        if (this.canvas && blockedSpriteCanvases.has(this.canvas)) {
          if (!this.canvas.width || !this.canvas.height || w >= this.canvas.width * 0.4 || h >= this.canvas.height * 0.4) {
            blockedSpriteCanvases.delete(this.canvas);
          }
        }
        return origClearRect.call(this, x, y, w, h);
      };
    }

    if (typeof origDrawImage === 'function') {
      proto.drawImage = function (image) {
        if (state.enabled && state.canvasHook && image && blockedSpriteCanvases.has(image)) {
          stats.blockedDrawImageCalls += 1;
          return;
        }
        return origDrawImage.apply(this, arguments);
      };
    }
  }

  const targetWins = pageWin && pageWin !== window ? [pageWin, window] : [window];
  for (let i = 0; i < targetWins.length; i++) {
    const w = targetWins[i];
    try {
      if (w && w.CanvasRenderingContext2D && w.CanvasRenderingContext2D.prototype) {
        patchContextPrototype(w.CanvasRenderingContext2D.prototype);
      }
      if (w && w.OffscreenCanvasRenderingContext2D && w.OffscreenCanvasRenderingContext2D.prototype) {
        patchContextPrototype(w.OffscreenCanvasRenderingContext2D.prototype);
      }
      if (w && w.HTMLCanvasElement && w.HTMLCanvasElement.prototype) {
        patchCanvasElementPrototype(w.HTMLCanvasElement.prototype);
      }
      if (w && w.Worker && w.Worker.prototype) {
        patchPostMessagePrototype(w.Worker.prototype);
      }
      if (w && w.MessagePort && w.MessagePort.prototype) {
        patchPostMessagePrototype(w.MessagePort.prototype);
      }
      if (w && w.BroadcastChannel && w.BroadcastChannel.prototype) {
        patchPostMessagePrototype(w.BroadcastChannel.prototype);
      }
    } catch (_) {
      // Ignore inaccessible realms
    }
  }
})();
