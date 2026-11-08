/**
 * 悬浮窗控制器。
 *
 * 透明置顶 + 气泡 + 日期标定 + 今日提醒 + 收藏列表占位。
 * 不硬依赖 Electron：注入 electron 模块就用真窗口，否则控制台/内存降级。
 */

import { OVERLAY_HTML } from '../paths.mjs';

export const OVERLAY_CHANNELS = Object.freeze({
  bubble: 'dsh:bubble',
  calibration: 'dsh:calibration',
  reminders: 'dsh:reminders',
  favorites: 'dsh:favorites',
  visibility: 'dsh:visibility',
});

export function createOverlayController(options = {}) {
  const {
    config = {},
    logger = console,
    electron = null,
  } = options;

  const available = Boolean(electron?.BrowserWindow);
  let window = null;
  let lastBubble = '';
  let calibration = { gameDate: '', timeSlot: '' };
  let reminders = [];
  let favorites = [];
  let seq = 0;

  const pageState = {
    bubble: '',
    bubbleAtSec: 0,
    seq: 0,
    calibration: { gameDate: '', timeSlot: '' },
    reminders: [],
    favorites: [],
  };

  function ensureWindow() {
    if (!available) return null;
    if (window && !window.isDestroyed?.()) return window;
    window = new electron.BrowserWindow({
      width: Number(config.overlay?.width ?? 360),
      height: Number(config.overlay?.height ?? 420),
      frame: false,
      transparent: true,
      alwaysOnTop: true,
      skipTaskbar: true,
      resizable: false,
      show: false,
      webPreferences: {
        contextIsolation: true,
        nodeIntegration: false,
      },
    });
    window.setAlwaysOnTop?.(true, 'screen-saver');
    window.loadFile?.(OVERLAY_HTML);
    return window;
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
    const win = ensureWindow();
    if (!win) return false;
    const script = "window.__DSH_OVERLAY_STATE__ = " + JSON.stringify(pageState) + ";";
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

  return {
    available,
    get lastBubble() { return lastBubble; },
    get calibration() { return { ...calibration }; },
    get pageState() {
      return {
        ...pageState,
        reminders: reminders.map((item) => ({ ...item })),
        favorites: favorites.map((item) => ({ ...item })),
      };
    },
    show() {
      const win = ensureWindow();
      if (!win) {
        logger.info?.('[overlay] 无 Electron，降级为控制台气泡');
        return false;
      }
      win.show?.();
      send(OVERLAY_CHANNELS.visibility, { visible: true });
      pushState();
      return true;
    },
    hide() {
      if (!window) return false;
      window.hide?.();
      send(OVERLAY_CHANNELS.visibility, { visible: false });
      return true;
    },
    speak(text, meta = {}) {
      const bubble = String(text ?? '').trim();
      if (!bubble) return false;
      lastBubble = bubble;
      pageState.bubble = bubble;
      pageState.bubbleAtSec = Number(meta?.at ?? Date.now() / 1000);
      bump();
      if (!available) {
        logger.info?.('[overlay] ' + bubble);
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
      if (!available) return false;
      const sent = send(OVERLAY_CHANNELS.calibration, { ...calibration });
      pushState();
      return sent;
    },
    setReminders(list = []) {
      reminders = Array.isArray(list) ? list.map((item) => ({ ...item })) : [];
      pageState.reminders = reminders;
      bump();
      if (!available) return false;
      const sent = send(OVERLAY_CHANNELS.reminders, { items: reminders });
      pushState();
      return sent;
    },
    setFavorites(list = []) {
      favorites = Array.isArray(list) ? list.map((item) => ({ ...item })) : [];
      pageState.favorites = favorites;
      bump();
      if (!available) return false;
      const sent = send(OVERLAY_CHANNELS.favorites, { items: favorites });
      pushState();
      return sent;
    },
    destroy() {
      if (window && !window.isDestroyed?.()) {
        try { window.destroy?.(); } catch {}
      }
      window = null;
    },
  };
}

export default { createOverlayController, OVERLAY_CHANNELS };
