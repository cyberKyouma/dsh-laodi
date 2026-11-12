/**
 * 桌宠形象 + 气泡。
 *
 * 有 Electron 时是一个透明置顶小窗：圆形静态图、可拖、点击穿透空白处。
 * 平时停在桌面；宿主调用 place({ mode:'game', gameRect }) 时跟到游戏窗口。
 * 没有 Electron 时只把气泡和位置记在内存里，主循环照常跑。
 *
 * 形象是 runtime/overlay/pet.svg，不使用「老弟」立绘。
 */

import { appendFileSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

import { OVERLAY_HTML, OVERLAY_PRELOAD } from '../paths.mjs';
import {
  DEFAULT_PET_MARGIN,
  computePetBounds,
  defaultDesktopPosition,
  normalizeGameRect,
} from './placement.mjs';

export const OVERLAY_CHANNELS = Object.freeze({
  bubble: 'dsh:bubble',
  calibration: 'dsh:calibration',
  reminders: 'dsh:reminders',
  favorites: 'dsh:favorites',
  visibility: 'dsh:visibility',
  hitTest: 'dsh-laodi:hit-test',
  chat: 'dsh-laodi:chat',
});

/** DSH 主进程里能拿到 electron；普通 node / 冒烟拿不到。 */

function fileTrace(line) {
  try {
    const home = process.env.DSH_HOME || path.join(homedir(), ".dsh");
    appendFileSync(path.join(home, "dsh-laodi.log"), `[${new Date().toISOString()}] ${line}\n`, "utf8");
  } catch {
    // ignore
  }
}

export function loadElectronModule() {
  const notes = [
    `type=${process.type || "none"}`,
    `electronVer=${process.versions?.electron || "no"}`,
    `runAsNode=${process.env.ELECTRON_RUN_AS_NODE || ""}`,
  ];
  try {
    const require = createRequire(import.meta.url);
    const loaded = require('electron');
    if (!loaded || typeof loaded !== 'object' || typeof loaded.BrowserWindow !== 'function') {
      const typ = loaded == null ? "null" : typeof loaded;
      notes.push(`require=${typ}`);
      loadElectronModule.lastNote = notes.join("; ");
      return null;
    }
    notes.push("require=ok");
    loadElectronModule.lastNote = notes.join("; ");
    return loaded;
  } catch (err) {
    notes.push(`require=err:${err && err.message ? err.message : err}`);
    loadElectronModule.lastNote = notes.join("; ");
    return null;
  }
}

function near(a, b) {
  if (!a || !b) return false;
  return Math.abs(Number(a.x) - Number(b.x)) <= 8 && Math.abs(Number(a.y) - Number(b.y)) <= 8;
}

export function createOverlayController(options = {}) {
  const {
    config = {},
    logger = console,
    electron = null,
    petConflict = null,
    onChat = null,
  } = options;

  const info = (...args) => {
    try { logger.info?.(...args); } catch { /* ignore */ }
    fileTrace(args.map((item) => (typeof item === "string" ? item : String(item))).join(" "));
  };
  const available = Boolean(electron?.BrowserWindow);
  const suppressed = Boolean(petConflict?.loaded);
  const conflictNotice = String(petConflict?.notice || '');
  const installedHint = String(petConflict?.installedHint || '');

  let window = null;
  let shown = false;
  let conflictWarned = false;
  let lastBubble = '';
  let calibration = { gameDate: '', timeSlot: '' };
  let reminders = [];
  let favorites = [];
  let seq = 0;
  let mode = 'desktop';
  let desktopPosition = null;
  let gameOffset = { x: 0, y: 0 };
  let lastGameRect = null;
  let lastProgrammatic = null;
  let workArea = null;
  let suspendFollow = false;
  let resumeFollowTimer = null;
  let drainTimer = null;
  let unbindIpc = null;
  let chatHandler = onChat;

  const pageState = {
    bubble: '',
    bubbleAtSec: 0,
    seq: 0,
    mode: 'desktop',
    calibration: { gameDate: '', timeSlot: '' },
    reminders: [],
    favorites: [],
  };

  function margin() {
    const value = Number(config.overlay?.margin ?? DEFAULT_PET_MARGIN);
    return Number.isFinite(value) ? value : DEFAULT_PET_MARGIN;
  }

  function petSize() {
    const width = Number(config.overlay?.width ?? 300);
    const height = Number(config.overlay?.height ?? 220);
    return {
      width: Number.isFinite(width) && width >= 160 ? width : 300,
      height: Number.isFinite(height) && height >= 140 ? height : 220,
    };
  }

  function readWorkArea() {
    if (workArea) return workArea;
    try {
      const display = electron?.screen?.getPrimaryDisplay?.();
      const area = display?.workArea || display?.bounds;
      if (area && Number(area.width) > 0 && Number(area.height) > 0) {
        workArea = {
          x: Number(area.x) || 0,
          y: Number(area.y) || 0,
          width: Number(area.width),
          height: Number(area.height),
        };
        return workArea;
      }
    } catch {
      // 没有 screen 模块时用一块虚拟桌面，冒烟不依赖真显示器
    }
    workArea = { x: 0, y: 0, width: 1280, height: 800 };
    return workArea;
  }

  function boundsFor(nextMode = mode) {
    const size = petSize();
    const area = readWorkArea();
    if (!desktopPosition) desktopPosition = defaultDesktopPosition(area, size, margin());
    const rect = nextMode === 'game' ? lastGameRect : null;
    const bounds = computePetBounds({
      mode: rect ? 'game' : 'desktop',
      gameRect: rect,
      gameOffset,
      desktopPosition,
      workArea: area,
      width: size.width,
      height: size.height,
      margin: margin(),
    });
    return { ...bounds, mode: nextMode };
  }

  function rememberUserBounds(bounds) {
    if (!bounds) return;
    if (mode === 'game' && lastGameRect) {
      const anchor = computePetBounds({
        mode: 'game',
        gameRect: lastGameRect,
        gameOffset: { x: 0, y: 0 },
        width: bounds.width,
        height: bounds.height,
        margin: margin(),
      });
      gameOffset = {
        x: Number(bounds.x) - anchor.x,
        y: Number(bounds.y) - anchor.y,
      };
      return;
    }
    desktopPosition = { x: Number(bounds.x) || 0, y: Number(bounds.y) || 0 };
  }

  function onWindowMoved() {
    const bounds = window?.getBounds?.();
    if (!bounds) return;
    if (near(bounds, lastProgrammatic)) return;
    rememberUserBounds(bounds);
    // 用户还在拖时，跟随循环不要把窗口拽回去。换模式（进/出游戏）仍立刻挪。
    suspendFollow = true;
    if (resumeFollowTimer) clearTimeout(resumeFollowTimer);
    resumeFollowTimer = setTimeout(() => {
      suspendFollow = false;
      resumeFollowTimer = null;
    }, 500);
    if (typeof resumeFollowTimer.unref === 'function') resumeFollowTimer.unref();
  }

  function isOurEvent(event) {
    const contents = window?.webContents;
    return Boolean(contents && event?.sender === contents);
  }

  function bindIpc() {
    if (unbindIpc || !electron?.ipcMain?.on) return;
    const onHit = (event, payload) => {
      if (!isOurEvent(event)) return;
      handleRendererMessage(OVERLAY_CHANNELS.hitTest, payload);
    };
    const onChatMessage = (event, payload) => {
      if (!isOurEvent(event)) return;
      handleRendererMessage(OVERLAY_CHANNELS.chat, payload);
    };
    electron.ipcMain.on(OVERLAY_CHANNELS.hitTest, onHit);
    electron.ipcMain.on(OVERLAY_CHANNELS.chat, onChatMessage);
    unbindIpc = () => {
      electron.ipcMain.removeListener?.(OVERLAY_CHANNELS.hitTest, onHit);
      electron.ipcMain.removeListener?.(OVERLAY_CHANNELS.chat, onChatMessage);
      unbindIpc = null;
    };
  }

  function ensureWindow() {
    if (!available || suppressed) return null;
    if (window && !window.isDestroyed?.()) return window;
    const initial = boundsFor(mode);
    info(`[overlay] creating BrowserWindow at ${initial.x},${initial.y} ${initial.width}x${initial.height}`);
    window = new electron.BrowserWindow({
      x: initial.x,
      y: initial.y,
      width: initial.width,
      height: initial.height,
      frame: false,
      transparent: true,
      alwaysOnTop: true,
      skipTaskbar: true,
      resizable: false,
      movable: true,
      minimizable: false,
      maximizable: false,
      fullscreenable: false,
      show: false,
      hasShadow: false,
      backgroundColor: '#00000000',
      webPreferences: {
        contextIsolation: true,
        nodeIntegration: false,
        preload: OVERLAY_PRELOAD,
      },
    });
    lastProgrammatic = { x: initial.x, y: initial.y, width: initial.width, height: initial.height };
    window.setAlwaysOnTop?.(true, 'screen-saver');
    window.setVisibleOnAllWorkspaces?.(true, { visibleOnFullScreen: true });
    // 空白处先穿透，页面指到形象或输入框时再接住点击。
    window.setIgnoreMouseEvents?.(true, { forward: true });
    window.on?.('move', onWindowMoved);
    window.on?.('moved', onWindowMoved);
    window.on?.('closed', () => {
      window = null;
      shown = false;
    });
    info("[overlay] BrowserWindow created, loading html");
    window.loadFile?.(OVERLAY_HTML);
    bindIpc();
    info("[overlay] window ready");
    return window;
  }

  function applyBounds(bounds) {
    const win = ensureWindow();
    if (!win || !bounds) return false;
    const next = {
      x: bounds.x,
      y: bounds.y,
      width: bounds.width,
      height: bounds.height,
    };
    const current = win.getBounds?.();
    lastProgrammatic = next;
    if (current && near(current, next) && current.width === next.width && current.height === next.height) {
      return true;
    }
    try {
      win.setBounds?.(next);
      return true;
    } catch {
      return false;
    }
  }

  function send(channel, payload) {
    const win = ensureWindow();
    if (!win) return false;
    try {
      win.webContents?.send?.(channel, payload);
      return true;
    } catch {
      return false;
    }
  }

  function pushState() {
    const win = shown || window ? ensureWindow() : null;
    if (!win) return false;
    const script = `window.__DSH_OVERLAY_STATE__ = ${JSON.stringify(pageState)};`;
    try {
      const result = win.webContents?.executeJavaScript?.(script, true);
      if (result && typeof result.catch === 'function') result.catch(() => {});
      return true;
    } catch {
      return false;
    }
  }

  function bump() {
    pageState.seq = ++seq;
  }

  function warnConflict() {
    if (conflictWarned) return;
    conflictWarned = true;
    logger.warn?.(conflictNotice || '[overlay] 检测到 dsh-pet，桌宠已暂停');
  }

  function startDrain() {
    if (drainTimer || !available) return;
    drainTimer = setInterval(() => {
      drainOutbox();
    }, 400);
    if (typeof drainTimer.unref === 'function') drainTimer.unref();
  }

  function stopDrain() {
    if (drainTimer) {
      clearInterval(drainTimer);
      drainTimer = null;
    }
    if (resumeFollowTimer) {
      clearTimeout(resumeFollowTimer);
      resumeFollowTimer = null;
    }
  }

  function drainOutbox() {
    const win = window;
    if (!win || win.isDestroyed?.()) return;
    let result;
    try {
      result = win.webContents?.executeJavaScript?.(
        '(() => { var q = window.__DSH_OVERLAY_OUTBOX__ || []; window.__DSH_OVERLAY_OUTBOX__ = []; return q; })()',
        true,
      );
    } catch {
      return;
    }
    Promise.resolve(result)
      .then((items) => {
        if (!Array.isArray(items)) return;
        for (const item of items) {
          handleRendererMessage(item?.channel, item?.payload);
        }
      })
      .catch(() => {});
  }

  function handleRendererMessage(channel, payload) {
    if (channel === OVERLAY_CHANNELS.hitTest) {
      const win = window;
      if (!win || win.isDestroyed?.()) return false;
      try {
        win.setIgnoreMouseEvents?.(Boolean(payload?.ignore), { forward: true });
        return true;
      } catch {
        return false;
      }
    }
    if (channel === OVERLAY_CHANNELS.chat) {
      const text = String(payload?.text ?? '').trim();
      if (!text || suppressed) return false;
      try {
        const pending = chatHandler?.(text, { mode });
        if (pending && typeof pending.catch === 'function') pending.catch(() => {});
      } catch (error) {
        logger.warn?.(
          `[overlay] 桌面闲聊失败：${error instanceof Error ? error.message : String(error)}`,
        );
      }
      return true;
    }
    return false;
  }

  function place(input = {}) {
    const nextMode = input.mode === 'game' ? 'game' : 'desktop';
    const modeChanged = nextMode !== mode;
    mode = nextMode;
    pageState.mode = nextMode;
    const rect = normalizeGameRect(input.gameRect);
    if (rect) lastGameRect = rect;
    if (nextMode === 'desktop' && input.desktopPosition) {
      desktopPosition = {
        x: Number(input.desktopPosition.x) || 0,
        y: Number(input.desktopPosition.y) || 0,
      };
    }
    const bounds = boundsFor(nextMode);
    if (suppressed || !shown) return bounds;
    if (!modeChanged && suspendFollow) {
      pushState();
      const current = window?.getBounds?.();
      return current ? { ...bounds, x: current.x, y: current.y, mode: nextMode } : bounds;
    }
    if (modeChanged) suspendFollow = false;
    applyBounds(bounds);
    pushState();
    return bounds;
  }

  return {
    available,
    get suppressed() {
      return suppressed;
    },
    get mode() {
      return mode;
    },
    get lastBubble() {
      return lastBubble;
    },
    get calibration() {
      return { ...calibration };
    },
    get pageState() {
      return {
        ...pageState,
        reminders: reminders.map((item) => ({ ...item })),
        favorites: favorites.map((item) => ({ ...item })),
      };
    },
    setChatHandler(handler) {
      chatHandler = handler;
    },
    handleRendererMessage,
    place,
    noteUserBounds: rememberUserBounds,
    status() {
      return {
        mode,
        available,
        shown,
        suppressed,
        notice: suppressed ? conflictNotice : installedHint,
        installedHint,
        screenLoop: false,
      };
    },
    show() {
      info("[overlay] show()");
      if (suppressed) {
        warnConflict();
        return false;
      }
      const win = ensureWindow();
      info(`[overlay] ensureWindow done win=${Boolean(win)}`);
      if (!win) {
        logger.info?.('[overlay] 无 Electron，降级为控制台气泡');
        return false;
      }
      applyBounds(boundsFor(mode));
      if (typeof win.showInactive === 'function') win.showInactive();
      else win.show?.();
      win.setIgnoreMouseEvents?.(true, { forward: true });
      shown = true;
      send(OVERLAY_CHANNELS.visibility, { visible: true });
      pushState();
      startDrain();
      return true;
    },
    hide() {
      if (!window) return false;
      window.hide?.();
      send(OVERLAY_CHANNELS.visibility, { visible: false });
      shown = false;
      return true;
    },
    speak(text, meta = {}) {
      const bubble = String(text ?? '').trim();
      if (!bubble) return false;
      lastBubble = bubble;
      pageState.bubble = bubble;
      pageState.bubbleAtSec = Number(meta?.at ?? Date.now() / 1000);
      bump();
      if (suppressed) {
        logger.info?.(`[overlay] 桌宠已暂停，气泡不显示：${bubble}`);
        return false;
      }
      if (!available) {
        logger.info?.(`[overlay] ${bubble}`);
        return false;
      }
      const sent = send(OVERLAY_CHANNELS.bubble, { text: bubble, ...meta });
      pushState();
      return sent;
    },
    setCalibration(next = {}) {
      calibration = {
        gameDate: next.gameDate ?? calibration.gameDate,
        timeSlot: next.timeSlot ?? calibration.timeSlot,
      };
      pageState.calibration = { ...calibration };
      bump();
      if (!available || suppressed) return false;
      const sent = send(OVERLAY_CHANNELS.calibration, { ...calibration });
      pushState();
      return sent;
    },
    setReminders(list = []) {
      reminders = Array.isArray(list) ? list.map((item) => ({ ...item })) : [];
      pageState.reminders = reminders;
      bump();
      if (!available || suppressed) return false;
      const sent = send(OVERLAY_CHANNELS.reminders, { items: reminders });
      pushState();
      return sent;
    },
    setFavorites(list = []) {
      favorites = Array.isArray(list) ? list.map((item) => ({ ...item })) : [];
      pageState.favorites = favorites;
      bump();
      if (!available || suppressed) return false;
      const sent = send(OVERLAY_CHANNELS.favorites, { items: favorites });
      pushState();
      return sent;
    },
    destroy() {
      stopDrain();
      if (unbindIpc) unbindIpc();
      if (window && !window.isDestroyed?.()) {
        try {
          window.destroy?.();
        } catch {
          // 窗口已经没了
        }
      }
      window = null;
      shown = false;
    },
  };
}

export default { createOverlayController, OVERLAY_CHANNELS, loadElectronModule };
