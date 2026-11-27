(function () {
  'use strict';

  const STORAGE_KEY = 'dy_danmaku_blocker_config_v1';
  const EngineAPI = window.DYDanmakuEngine;
  const engine = new EngineAPI.DanmakuFilterEngine();

  let activeTabId = null;
  let currentRoomId = '';
  let currentRoomName = '';

  const roomLabel = document.getElementById('roomLabel');
  const masterToggle = document.getElementById('masterToggle');
  const antiSpamToggle = document.getElementById('antiSpamToggle');
  const videoToggle = document.getElementById('videoToggle');
  const chatToggle = document.getElementById('chatToggle');
  const statBlocked = document.getElementById('statBlocked');
  const statRules = document.getElementById('statRules');
  const statRooms = document.getElementById('statRooms');
  const quickInput = document.getElementById('quickInput');
  const quickType = document.getElementById('quickType');
  const addRoomBtn = document.getElementById('addRoomBtn');
  const addGlobalBtn = document.getElementById('addGlobalBtn');
  const openPanelBtn = document.getElementById('openPanelBtn');
  const statusMsg = document.getElementById('statusMsg');

  function showMsg(text, isError = false) {
    statusMsg.textContent = text;
    statusMsg.classList.toggle('is-error', isError);
  }

  function renderUI() {
    const cfg = engine.config;
    masterToggle.checked = cfg.enabled;
    antiSpamToggle.checked = cfg.antiSpam.enabled;
    videoToggle.checked = cfg.scope.videoDanmu;
    chatToggle.checked = cfg.scope.chatRoom;

    const roomCount = Object.values(cfg.rooms).filter((r) => r.rules && r.rules.length > 0).length;
    statRooms.textContent = String(roomCount);
    statRules.textContent = String(engine.getActiveRules(currentRoomId).length);
    addRoomBtn.disabled = !currentRoomId;
  }

  function saveConfig() {
    return new Promise((resolve) => {
      chrome.storage.local.set({ [STORAGE_KEY]: engine.getConfig() }, () => {
        renderUI();
        resolve();
      });
    });
  }

  function loadConfig() {
    return new Promise((resolve) => {
      chrome.storage.local.get([STORAGE_KEY], (res) => {
        if (res && res[STORAGE_KEY]) {
          engine.setConfig(res[STORAGE_KEY]);
        }
        renderUI();
        resolve();
      });
    });
  }

  async function inspectActiveTab() {
    const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
    const tab = tabs && tabs[0];
    if (!tab || !tab.id) {
      roomLabel.textContent = '请打开抖音直播网页版';
      return;
    }
    activeTabId = tab.id;
    const isDouyin = /^https:\/\/(live|www)\.douyin\.com\//.test(tab.url || '');
    if (!isDouyin) {
      roomLabel.textContent = '当前非抖音直播页面';
      statBlocked.textContent = '-';
      openPanelBtn.disabled = true;
      return;
    }

    currentRoomId = EngineAPI.extractRoomIdFromUrl(tab.url || '');
    openPanelBtn.disabled = false;

    try {
      const resp = await chrome.tabs.sendMessage(tab.id, { type: 'GET_STATUS' });
      if (resp) {
        currentRoomId = resp.roomId || currentRoomId;
        currentRoomName = resp.roomName || '';
        statBlocked.textContent = String(resp.stats ? resp.stats.totalBlocked : 0);
      }
    } catch (_) {
      // Content script might not be ready yet
      statBlocked.textContent = '0';
    }

    if (currentRoomId) {
      roomLabel.textContent = currentRoomName
        ? `当前直播间：${currentRoomName}`
        : `当前直播间：${currentRoomId}`;
    } else {
      roomLabel.textContent = '抖音页面（未进入具体直播间）';
    }
    renderUI();
  }

  async function handleAdd(scope) {
    const pattern = quickInput.value.trim();
    if (!pattern) {
      showMsg('请先输入屏蔽词', true);
      quickInput.focus();
      return;
    }
    const res = engine.addRule({
      scope,
      roomId: currentRoomId,
      roomName: currentRoomName,
      pattern,
      type: quickType.value
    });
    if (!res.ok) {
      showMsg(res.error || '添加失败', true);
      return;
    }
    quickInput.value = '';
    await saveConfig();
    showMsg(`已${scope === 'room' ? '本房间' : '全局'}添加：${pattern}`);
  }

  masterToggle.addEventListener('change', () => {
    engine.config.enabled = masterToggle.checked;
    saveConfig();
  });
  antiSpamToggle.addEventListener('change', () => {
    engine.config.antiSpam.enabled = antiSpamToggle.checked;
    saveConfig();
  });
  videoToggle.addEventListener('change', () => {
    engine.config.scope.videoDanmu = videoToggle.checked;
    saveConfig();
  });
  chatToggle.addEventListener('change', () => {
    engine.config.scope.chatRoom = chatToggle.checked;
    saveConfig();
  });

  addRoomBtn.addEventListener('click', () => handleAdd('room'));
  addGlobalBtn.addEventListener('click', () => handleAdd('global'));
  quickInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      handleAdd(currentRoomId ? 'room' : 'global');
    }
  });

  openPanelBtn.addEventListener('click', async () => {
    if (!activeTabId) return;
    try {
      await chrome.tabs.sendMessage(activeTabId, { type: 'TOGGLE_PANEL' });
      window.close();
    } catch (_) {
      showMsg('请刷新直播页面后再试', true);
    }
  });

  loadConfig().then(inspectActiveTab);
})();
