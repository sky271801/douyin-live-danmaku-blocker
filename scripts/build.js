/**
 * Build script:
 * 1. Generates crisp PNG icons (16x16, 48x48, 128x128) for the Chrome/Edge extension (zero external deps).
 * 2. Bundles the standalone Tampermonkey/Violentmonkey UserScript from the extension sources.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const ROOT = path.resolve(__dirname, '..');
const EXT_DIR = path.join(ROOT, 'extension');
const SRC_DIR = path.join(EXT_DIR, 'src');
const ICON_DIR = path.join(EXT_DIR, 'icons');
const US_DIR = path.join(ROOT, 'userscript');

// ==================== Minimal Zero-Dep PNG Encoder ====================
const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) {
      c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
    }
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) {
    c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  }
  return (c ^ 0xffffffff) >>> 0;
}

function pngChunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const typeBuf = Buffer.from(type, 'ascii');
  const crcBuf = Buffer.alloc(4);
  crcBuf.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
  return Buffer.concat([len, typeBuf, data, crcBuf]);
}

function encodePNG(width, height, rgba) {
  const raw = Buffer.alloc((width * 4 + 1) * height);
  for (let y = 0; y < height; y++) {
    const rowStart = y * (width * 4 + 1);
    raw[rowStart] = 0; // filter type: None
    rgba.copy(raw, rowStart + 1, y * width * 4, (y + 1) * width * 4);
  }

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // color type: RGBA
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;

  const compressed = zlib.deflateSync(raw, { level: 9 });
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', compressed),
    pngChunk('IEND', Buffer.alloc(0))
  ]);
}

function blendPixel(buf, width, x, y, r, g, b, a) {
  if (x < 0 || y < 0 || x >= width || y >= width) return;
  const idx = (y * width + x) * 4;
  const srcA = a / 255;
  const dstA = buf[idx + 3] / 255;
  const outA = srcA + dstA * (1 - srcA);
  if (outA <= 0) return;
  buf[idx] = Math.round((r * srcA + buf[idx] * dstA * (1 - srcA)) / outA);
  buf[idx + 1] = Math.round((g * srcA + buf[idx + 1] * dstA * (1 - srcA)) / outA);
  buf[idx + 2] = Math.round((b * srcA + buf[idx + 2] * dstA * (1 - srcA)) / outA);
  buf[idx + 3] = Math.round(outA * 255);
}

function renderIcon(size) {
  const rgba = Buffer.alloc(size * size * 4);
  const cx = size / 2;
  const cy = size / 2;
  const radius = size * 0.22;

  function insideRoundedRect(x, y) {
    const pad = size * 0.04;
    const min = pad;
    const max = size - pad;
    if (x < min || x > max || y < min || y > max) return false;
    const ix = Math.max(min + radius, Math.min(max - radius, x));
    const iy = Math.max(min + radius, Math.min(max - radius, y));
    return Math.hypot(x - ix, y - iy) <= radius;
  }

  function insideShield(nx, ny) {
    // Normalized coordinates in [-1, 1]
    if (ny < -0.66 || ny > 0.72) return false;
    // Top curve
    const topY = -0.66 + 0.16 * Math.abs(nx);
    if (ny < topY) return false;
    // Side/bottom taper
    let halfW;
    if (ny <= 0.05) {
      halfW = 0.58 - (ny + 0.66) * 0.04;
    } else {
      const t = (ny - 0.05) / 0.67;
      halfW = 0.55 * Math.pow(Math.max(0, 1 - t), 0.72);
    }
    return Math.abs(nx) <= halfW;
  }

  // 2x2 supersampling for smooth anti-aliased edges
  const samples = [
    [-0.25, -0.25],
    [0.25, -0.25],
    [-0.25, 0.25],
    [0.25, 0.25]
  ];

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let bgHit = 0;
      let shieldCyanHit = 0;
      let shieldRedHit = 0;
      let shieldMainHit = 0;
      let slashHit = 0;

      for (const [ox, oy] of samples) {
        const px = x + 0.5 + ox;
        const py = y + 0.5 + oy;
        if (insideRoundedRect(px, py)) bgHit++;

        const nx = (px - cx) / (size * 0.5);
        const ny = (py - cy) / (size * 0.5);

        // Douyin-style subtle cyan/red offset glow on shield
        if (insideShield(nx + 0.05, ny + 0.03)) shieldCyanHit++;
        if (insideShield(nx - 0.05, ny - 0.02)) shieldRedHit++;
        if (insideShield(nx, ny)) shieldMainHit++;

        // X / block cross inside shield
        const d1 = Math.abs(nx - ny) / Math.SQRT2;
        const d2 = Math.abs(nx + ny) / Math.SQRT2;
        const inCrossBox = Math.abs(nx) <= 0.26 && Math.abs(ny - 0.02) <= 0.26;
        if (inCrossBox && (d1 <= 0.085 || d2 <= 0.085)) slashHit++;
      }

      if (bgHit > 0) {
        const grad = y / size;
        const r = Math.round(22 + grad * 12);
        const g = Math.round(24 + grad * 10);
        const b = Math.round(35 + grad * 18);
        blendPixel(rgba, size, x, y, r, g, b, Math.round((bgHit / 4) * 255));
      }
      if (shieldCyanHit > 0) {
        blendPixel(rgba, size, x, y, 37, 244, 238, Math.round((shieldCyanHit / 4) * 210));
      }
      if (shieldRedHit > 0) {
        blendPixel(rgba, size, x, y, 254, 44, 85, Math.round((shieldRedHit / 4) * 235));
      }
      if (shieldMainHit > 0) {
        blendPixel(rgba, size, x, y, 245, 247, 252, Math.round((shieldMainHit / 4) * 245));
      }
      if (slashHit > 0) {
        blendPixel(rgba, size, x, y, 254, 44, 85, Math.round((slashHit / 4) * 255));
      }
    }
  }

  return encodePNG(size, size, rgba);
}

function buildIcons() {
  fs.mkdirSync(ICON_DIR, { recursive: true });
  for (const size of [16, 48, 128]) {
    const outPath = path.join(ICON_DIR, `icon${size}.png`);
    fs.writeFileSync(outPath, renderIcon(size));
  }
  console.log('[build] Generated icons: 16, 48, 128');
}

// ==================== Bundle UserScript ====================
function buildUserScript() {
  fs.mkdirSync(US_DIR, { recursive: true });

  const filterEngineCode = fs.readFileSync(path.join(SRC_DIR, 'filter-engine.js'), 'utf8');
  const canvasHookCode = fs.readFileSync(path.join(SRC_DIR, 'page-canvas-hook.js'), 'utf8');
  const contentCss = fs.readFileSync(path.join(SRC_DIR, 'content.css'), 'utf8');
  const contentJs = fs.readFileSync(path.join(SRC_DIR, 'content.js'), 'utf8');

  const header = `// ==UserScript==
// @name         抖音直播弹幕屏蔽助手
// @namespace    https://github.com/sky271801/douyin-live-danmaku-blocker
// @version      1.3.0
// @description  按直播间/全局屏蔽抖音网页版刷屏弹幕，支持实时高频刷屏雷达、智能重复弹幕折叠、正则/用户屏蔽与公屏一键快捷屏蔽。
// @author       sky271801
// @homepageURL  https://github.com/sky271801/douyin-live-danmaku-blocker
// @supportURL   https://github.com/sky271801/douyin-live-danmaku-blocker/issues
// @downloadURL  https://raw.githubusercontent.com/sky271801/douyin-live-danmaku-blocker/main/userscript/douyin-live-danmaku-blocker.user.js
// @updateURL    https://raw.githubusercontent.com/sky271801/douyin-live-danmaku-blocker/main/userscript/douyin-live-danmaku-blocker.user.js
// @match        https://live.douyin.com/*
// @match        https://www.douyin.com/*
// @icon         https://www.douyin.com/favicon.ico
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_addStyle
// @grant        unsafeWindow
// @run-at       document-start
// ==/UserScript==

`;

  const injectStyleBlock = `
(function injectStyles() {
  const css = ${JSON.stringify(contentCss)};
  if (typeof GM_addStyle === 'function') {
    GM_addStyle(css);
  } else {
    const apply = () => {
      const st = document.createElement('style');
      st.textContent = css;
      (document.head || document.documentElement).appendChild(st);
    };
    if (document.head || document.documentElement) apply();
    else document.addEventListener('DOMContentLoaded', apply);
  }
})();
`;

  const bundle = [
    header,
    '// ==================== 1. Canvas Fallback Hook ====================',
    canvasHookCode,
    '\n// ==================== 2. Core Filter Engine ====================',
    filterEngineCode,
    '\n// ==================== 3. In-Page Styles ====================',
    injectStyleBlock,
    '\n// ==================== 4. Content Controller & UI ====================',
    contentJs
  ].join('\n');

  const outPath = path.join(US_DIR, 'douyin-live-danmaku-blocker.user.js');
  fs.writeFileSync(outPath, bundle, 'utf8');
  console.log('[build] Generated userscript:', outPath);
}

buildIcons();
buildUserScript();
