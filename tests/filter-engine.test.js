'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const Engine = require('../extension/src/filter-engine.js');

const {
  DanmakuFilterEngine,
  normalizeForSpam,
  isLongRepeatSpam,
  parseChatLine,
  detectSystemType,
  extractRoomIdFromUrl
} = Engine;

test('extractRoomIdFromUrl handles Douyin follow/live, live.douyin.com, and query fallbacks', () => {
  assert.equal(
    extractRoomIdFromUrl('https://www.douyin.com/follow/live/633447594780?anchor_id=7508319986353357884'),
    '633447594780'
  );
  assert.equal(
    extractRoomIdFromUrl('https://live.douyin.com/633447594780'),
    '633447594780'
  );
  assert.equal(
    extractRoomIdFromUrl('https://www.douyin.com/follow/live?anchor_id=7508319986353357884'),
    '7508319986353357884'
  );
  assert.equal(extractRoomIdFromUrl('https://live.douyin.com/category/123'), '');
  assert.equal(extractRoomIdFromUrl('https://www.douyin.com/discover'), '');
});

test('per-room rules isolate streamer memes while global rules apply everywhere', () => {
  const engine = new DanmakuFilterEngine();
  engine.config.antiSpam.enabled = false;

  engine.addRule({
    scope: 'room',
    roomId: '633447594780',
    roomName: '认清野核差距',
    pattern: '盼之',
    type: 'contains'
  });
  engine.addRule({
    scope: 'global',
    pattern: '加微信',
    type: 'contains'
  });

  // Room-specific meme blocked in target room
  const r1 = engine.evaluate({ text: '盼之代练靠谱吗', source: 'video', roomId: '633447594780' });
  assert.equal(r1.blocked, true);
  assert.equal(r1.reason, 'rule');
  assert.equal(r1.scope, 'room');

  // Same meme NOT blocked in another room
  const r2 = engine.evaluate({ text: '盼之代练靠谱吗', source: 'video', roomId: '999888777' });
  assert.equal(r2.blocked, false);

  // Global rule blocked in both rooms
  const r3 = engine.evaluate({ text: '加微信领福利', source: 'chat', roomId: '999888777' });
  assert.equal(r3.blocked, true);
  assert.equal(r3.scope, 'global');

  // Disabling room pauses room rules without deleting them
  engine.config.rooms['633447594780'].enabled = false;
  const r4 = engine.evaluate({ text: '盼之代练靠谱吗', source: 'video', roomId: '633447594780' });
  assert.equal(r4.blocked, false);
});

test('supports exact, regex, user match types and rejects invalid regex safely', () => {
  const engine = new DanmakuFilterEngine();
  engine.config.antiSpam.enabled = false;

  engine.addRule({ scope: 'global', pattern: '典', type: 'exact' });
  engine.addRule({ scope: 'global', pattern: '^[0-9]{4,}$', type: 'regex' });
  engine.addRule({ scope: 'global', pattern: '刷屏哥', type: 'user' });

  // Invalid regex rejected on add
  const bad = engine.addRule({ scope: 'global', pattern: '[unclosed', type: 'regex' });
  assert.equal(bad.ok, false);

  // Exact match
  assert.equal(engine.evaluate({ text: '典', source: 'video' }).blocked, true);
  assert.equal(engine.evaluate({ text: '太经典了', source: 'video' }).blocked, false);

  // Regex match
  assert.equal(engine.evaluate({ text: '666666', source: 'video' }).blocked, true);
  assert.equal(engine.evaluate({ text: '666', source: 'video' }).blocked, false);

  // User match
  assert.equal(engine.evaluate({ text: '你好', username: '狂暴刷屏哥', source: 'chat' }).blocked, true);
  assert.equal(engine.evaluate({ text: '你好', username: '普通观众', source: 'chat' }).blocked, false);
});

test('sliding-window anti-spam folds repeated streamer memes and resets after window', () => {
  const engine = new DanmakuFilterEngine();
  engine.config.antiSpam.enabled = true;
  engine.config.antiSpam.windowSeconds = 5;
  engine.config.antiSpam.maxRepeats = 2;
  engine.config.antiSpam.normalizeSpaces = true;

  const t0 = 100000;
  // First 2 pass, 3rd & 4th with slight punctuation/elongation variations get folded
  assert.equal(engine.evaluate({ text: '主播开门', source: 'video', roomId: '1' }, t0).blocked, false);
  assert.equal(engine.evaluate({ text: '主播开门！', source: 'video', roomId: '1' }, t0 + 500).blocked, false);

  const d3 = engine.evaluate({ text: '主播开门！！！', source: 'video', roomId: '1' }, t0 + 1000);
  assert.equal(d3.blocked, true);
  assert.equal(d3.reason, 'spam');

  // Same itemKey re-evaluation does not double-count or flip previously allowed item
  const recheck = engine.evaluate({
    text: '主播开门',
    source: 'video',
    roomId: '1',
    itemKey: 'node1::主播开门'
  }, t0 + 10000);
  assert.equal(recheck.blocked, false);
  const recheck2 = engine.evaluate({
    text: '主播开门',
    source: 'video',
    roomId: '1',
    itemKey: 'node1::主播开门'
  }, t0 + 10050);
  assert.equal(recheck2.blocked, false);
});

test('normalizeForSpam and isLongRepeatSpam handle elongated spam correctly', () => {
  assert.equal(normalizeForSpam('哈哈哈哈哈！！！', true), '哈哈');
  assert.equal(normalizeForSpam('  哈哈  ', true), '哈哈');
  assert.equal(isLongRepeatSpam('666666', 6), true);
  assert.equal(isLongRepeatSpam('？？？？？？', 6), true);
  assert.equal(isLongRepeatSpam('正常弹幕讨论', 6), false);
});

test('hot danmaku radar tracks top repeated danmaku within 60s window', () => {
  const engine = new DanmakuFilterEngine();
  const now = 200000;
  for (let i = 0; i < 5; i++) {
    engine.evaluate({ text: '野核差距', source: 'chat', roomId: '633447594780' }, now + i * 100);
  }
  for (let i = 0; i < 2; i++) {
    engine.evaluate({ text: '主播牛逼', source: 'chat', roomId: '633447594780' }, now + i * 100);
  }

  const top = engine.getTopDanmaku('633447594780', 5, now + 1000);
  assert.equal(top.length, 2);
  assert.equal(top[0].text, '野核差距');
  assert.equal(top[0].count, 5);
  assert.equal(top[1].text, '主播牛逼');
  assert.equal(top[1].count, 2);

  // After 61 seconds, radar expires cleanly
  const expired = engine.getTopDanmaku('633447594780', 5, now + 62000);
  assert.equal(expired.length, 0);
});

test('parseChatLine and detectSystemType accurately parse Douyin chat items', () => {
  const p1 = parseChatLine('路人甲：这波打野太帅了');
  assert.equal(p1.username, '路人甲');
  assert.equal(p1.content, '这波打野太帅了');

  const p2 = parseChatLine('路人乙 送出了 粉丝团灯牌 x 1');
  assert.equal(detectSystemType(p2.fullText, p2.username), 'gift');

  // Real Douyin obfuscated chatroom DOM where content span matches but username class is obfuscated
  const p3 = parseChatLine('顾北清歌寒：关注+小狐狸套装', '', '关注+小狐狸套装');
  assert.equal(p3.username, '顾北清歌寒');
  assert.equal(p3.content, '关注+小狐狸套装');

  assert.equal(detectSystemType('小王 来了', ''), 'enter');
  assert.equal(detectSystemType('张三 关注了主播', ''), 'follow');
  assert.equal(detectSystemType('李四 为主播点赞了', ''), 'like');
  assert.equal(detectSystemType('这把野核差距太大了', '玩家A'), null);
});

test('adding or toggling rules immediately invalidates seenItems cache for pooled DOM nodes', () => {
  const engine = new DanmakuFilterEngine();
  engine.config.antiSpam.enabled = false;
  const t0 = 500000;

  // Before rule is added, pooled node n12 evaluates as allowed and gets cached
  const before = engine.evaluate({
    text: '我并不知道什么小狐狸套装和ev63，我只知道我中了10颗',
    source: 'video',
    roomId: '557481980778',
    itemKey: 'n12::我并不知道什么小狐狸套装和ev63，我只知道我中了10颗'
  }, t0);
  assert.equal(before.blocked, false);

  // User adds room rule
  engine.addRule({
    scope: 'room',
    roomId: '557481980778',
    pattern: '我并不知道什么',
    type: 'contains'
  });

  // Same pooled node reused immediately MUST be blocked, never served stale cached decision
  const after = engine.evaluate({
    text: '我并不知道什么小狐狸套装和ev63，我只知道我中了10颗',
    source: 'video',
    roomId: '557481980778',
    itemKey: 'n12::我并不知道什么小狐狸套装和ev63，我只知道我中了10颗'
  }, t0 + 500);
  assert.equal(after.blocked, true);
  assert.equal(after.reason, 'rule');
});

test('rule matching strips zero-width characters used by spam bots', () => {
  const engine = new DanmakuFilterEngine();
  engine.config.antiSpam.enabled = false;
  engine.addRule({
    scope: 'room',
    roomId: '557481980778',
    pattern: '我并不知道什么',
    type: 'contains'
  });

  const sneaky = '我\u200B并\u200C不\uFEFF知道什么小狐狸套装和ev63';
  const res = engine.evaluate({ text: sneaky, source: 'video', roomId: '557481980778' });
  assert.equal(res.blocked, true);
});

test('page-canvas-hook patches unsafeWindow canvas and intercepts CanvasDanmakuPlugin & sprite drawImage', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const vm = require('node:vm');

  const hookCode = fs.readFileSync(
    path.join(__dirname, '..', 'extension', 'src', 'page-canvas-hook.js'),
    'utf8'
  );

  const drawnCalls = [];
  function FakeCtx2D(canvas) {
    this.canvas = canvas;
  }
  FakeCtx2D.prototype.fillText = function (text) {
    drawnCalls.push({ op: 'fill', text });
  };
  FakeCtx2D.prototype.strokeText = function (text) {
    drawnCalls.push({ op: 'stroke', text });
  };
  FakeCtx2D.prototype.clearRect = function () {
    drawnCalls.push({ op: 'clear' });
  };
  FakeCtx2D.prototype.drawImage = function (img) {
    drawnCalls.push({ op: 'drawImage', img });
  };

  // Separate sandbox window vs page unsafeWindow (just like Tampermonkey with @grant)
  const sandboxWindow = {
    addEventListener() {},
    dispatchEvent() {},
    CanvasRenderingContext2D: function SandboxCtx() {}
  };
  const pageUnsafeWindow = {
    addEventListener() {},
    getComputedStyle() {
      return { pointerEvents: 'auto', position: 'relative' };
    },
    CanvasRenderingContext2D: FakeCtx2D
  };

  const ctx = vm.createContext({
    window: sandboxWindow,
    unsafeWindow: pageUnsafeWindow,
    CustomEvent: function (type, init) {
      this.type = type;
      this.detail = init && init.detail;
    },
    Date,
    Map,
    WeakMap,
    WeakSet,
    RegExp,
    Object,
    String
  });
  vm.runInContext(hookCode, ctx);

  // Sync config via direct userscript hook
  assert.equal(typeof sandboxWindow.__DY_DF_SYNC_CANVAS_CONFIG__, 'function');
  sandboxWindow.__DY_DF_SYNC_CANVAS_CONFIG__({
    enabled: true,
    canvasHook: true,
    rules: [{ pattern: '我并不知道什么', type: 'contains' }],
    antiSpam: { blockLongRepeatChar: false }
  });

  // 1. Real Douyin CanvasDanmakuPlugin (#DanmakuLayout > .CanvasDanmakuPlugin > canvas with position: relative)
  const mainDanmuCanvas = {
    isConnected: true,
    width: 1104,
    height: 1005,
    closest(sel) {
      if (sel.includes('#dy-df-root')) return null;
      return sel.includes('#DanmakuLayout') || sel.includes('.CanvasDanmakuPlugin') ? {} : null;
    }
  };
  const mainCtx = new FakeCtx2D(mainDanmuCanvas);
  mainCtx.fillText('我并不知道什么小狐狸套装和ev63', 500, 100);
  mainCtx.strokeText('我并不知道什么小狐狸套装和ev63', 500, 100);
  mainCtx.fillText('换把ak', 500, 140);
  assert.deepEqual(drawnCalls, [{ op: 'fill', text: '换把ak' }]);

  // 2. Offscreen single-danmaku sprite canvas + drawImage blocking + clean reuse after clearRect
  drawnCalls.length = 0;
  const spriteCanvas = { isConnected: false, width: 420, height: 42 };
  const spriteCtx = new FakeCtx2D(spriteCanvas);
  spriteCtx.fillText('我并不知道什么小狐狸套装和ev63', 0, 20);
  spriteCtx.fillText('，我很幸福', 200, 20); // trailing segment of same blocked sprite
  mainCtx.drawImage(spriteCanvas, 100, 80); // blocked sprite MUST NOT be blitted!
  assert.equal(drawnCalls.length, 0);

  // Reuse sprite after clearRect for clean danmaku -> MUST draw and blit normally!
  spriteCtx.clearRect(0, 0, 420, 42);
  spriteCtx.fillText('正常弹幕666', 0, 20);
  mainCtx.drawImage(spriteCanvas, 100, 80);
  assert.equal(drawnCalls.length, 3);
  assert.equal(drawnCalls[1].text, '正常弹幕666');
  assert.equal(drawnCalls[2].op, 'drawImage');

  // Verify live diagnostics counter
  const stats = sandboxWindow.__DY_DF_GET_CANVAS_STATS__();
  assert.ok(stats.hookedPrototypes >= 1);
  assert.ok(stats.blockedTextCalls >= 3);
  assert.equal(stats.blockedDrawImageCalls, 1);
});

test('page-canvas-hook intercepts Worker & MessagePort danmaku payloads safely', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const vm = require('node:vm');

  const hookCode = fs.readFileSync(
    path.join(__dirname, '..', 'extension', 'src', 'page-canvas-hook.js'),
    'utf8'
  );

  const workerReceived = [];
  const portReceived = [];
  function FakeWorker() {}
  FakeWorker.prototype.postMessage = function (msg) {
    workerReceived.push(msg);
  };
  function FakeMessagePort() {}
  FakeMessagePort.prototype.postMessage = function (msg) {
    portReceived.push(msg);
  };

  const sandboxWindow = {
    addEventListener() {},
    dispatchEvent() {}
  };
  const pageUnsafeWindow = {
    addEventListener() {},
    Worker: FakeWorker,
    MessagePort: FakeMessagePort
  };

  const ctx = vm.createContext({
    window: sandboxWindow,
    unsafeWindow: pageUnsafeWindow,
    CustomEvent: function (type, init) {
      this.type = type;
      this.detail = init && init.detail;
    },
    ArrayBuffer,
    Uint8Array,
    Date,
    Map,
    Set,
    WeakMap,
    WeakSet,
    RegExp,
    Object,
    Array,
    String,
    JSON,
    Boolean
  });
  vm.runInContext(hookCode, ctx);

  sandboxWindow.__DY_DF_SYNC_CANVAS_CONFIG__({
    enabled: true,
    canvasHook: true,
    rules: [{ pattern: '我并不知道', type: 'contains' }],
    antiSpam: { blockLongRepeatChar: false }
  });

  const w = new FakeWorker();
  const p = new FakeMessagePort();

  // 1. Single danmaku object dropped
  w.postMessage({ type: 'addDanmaku', payload: { text: '我并不知道什么小狐狸套装和ev63' } });
  // 2. Batch danmaku array partially filtered (clean item preserved!)
  w.postMessage({
    type: 'batch',
    list: [
      { id: 1, content: '我并不知道什么小狐狸套装' },
      { id: 2, content: '老了退网' }
    ]
  });
  // 3. Rich-text segments single danmaku dropped as a whole
  p.postMessage({
    type: 'push',
    danmakuId: 'd99',
    segments: [
      { type: 'badge', url: 'https://example.com/badge.png' },
      { type: 'text', text: '我并不知道什么小狐狸' }
    ]
  });
  // 4. React scheduler null message & binary ArrayBuffer pass straight through
  p.postMessage(null);
  const bin = new Uint8Array([1, 2, 3]);
  w.postMessage(bin);

  assert.equal(workerReceived.length, 2);
  assert.equal(JSON.stringify(workerReceived[0]), JSON.stringify({ type: 'batch', list: [{ id: 2, content: '老了退网' }] }));
  assert.equal(workerReceived[1], bin);
  assert.deepEqual(portReceived, [null]);

  const stats = sandboxWindow.__DY_DF_GET_CANVAS_STATS__();
  assert.equal(stats.workerMsgBlocked, 3);
});
