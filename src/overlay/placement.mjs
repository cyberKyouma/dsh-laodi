/**
 * 桌宠位置：纯函数。
 *
 * 平时停在桌面记住的坐标；P5R 在前台时贴着游戏窗口矩形（默认右下角，可带拖拽偏移）。
 * 不创建窗口、不识屏。
 */

import { isGameWindow } from '../capture/window.mjs';

export const PET_MODE = Object.freeze({
  desktop: 'desktop',
  game: 'game',
});

export const DEFAULT_PET_SIZE = Object.freeze({
  width: 300,
  height: 220,
});

export const DEFAULT_PET_MARGIN = 16;

function finite(value, fallback = 0) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

export function clamp(value, min, max) {
  const low = Math.min(min, max);
  const high = Math.max(min, max);
  return Math.min(high, Math.max(low, value));
}

/**
 * 把前台探测结果收成 {left, top, width, height}。
 * 探测失败或宽高非正时返回 null。
 */
export function normalizeGameRect(rect) {
  if (!rect || typeof rect !== 'object') return null;
  const left = finite(rect.left ?? rect.x, Number.NaN);
  const top = finite(rect.top ?? rect.y, Number.NaN);
  const width = finite(
    rect.width ?? (rect.right != null && rect.left != null ? rect.right - rect.left : Number.NaN),
    Number.NaN,
  );
  const height = finite(
    rect.height ?? (rect.bottom != null && rect.top != null ? rect.bottom - rect.top : Number.NaN),
    Number.NaN,
  );
  if (![left, top, width, height].every(Number.isFinite)) return null;
  if (width <= 0 || height <= 0) return null;
  return { left, top, width, height };
}

/** 前台窗口是不是 P5R。不是、或探测失败，都算桌面。 */
export function resolvePetMode(windowInfo, gameWindow = {}) {
  return isGameWindow(windowInfo, gameWindow) ? PET_MODE.game : PET_MODE.desktop;
}

export function defaultDesktopPosition(workArea, size = DEFAULT_PET_SIZE, margin = DEFAULT_PET_MARGIN) {
  const area = workArea || { x: 0, y: 0, width: 1280, height: 800 };
  const width = finite(size?.width, DEFAULT_PET_SIZE.width);
  const height = finite(size?.height, DEFAULT_PET_SIZE.height);
  const pad = finite(margin, DEFAULT_PET_MARGIN);
  return {
    x: Math.round(finite(area.x) + finite(area.width, 1280) - width - pad),
    y: Math.round(finite(area.y) + finite(area.height, 800) - height - pad),
  };
}

/**
 * 计算形象窗口的屏幕坐标。
 * 游戏模式有矩形时贴着窗口；没有矩形则退回桌面坐标，但调用方仍可自行标 mode。
 */
export function computePetBounds(input = {}) {
  const width = finite(input.width, DEFAULT_PET_SIZE.width);
  const height = finite(input.height, DEFAULT_PET_SIZE.height);
  const margin = finite(input.margin, DEFAULT_PET_MARGIN);

  if (input.mode === PET_MODE.game) {
    const rect = normalizeGameRect(input.gameRect);
    if (rect) {
      const anchorX = rect.left + Math.max(0, rect.width - width - margin);
      const anchorY = rect.top + Math.max(0, rect.height - height - margin);
      const offsetX = finite(input.gameOffset?.x, 0);
      const offsetY = finite(input.gameOffset?.y, 0);
      const minX = rect.left;
      const minY = rect.top;
      const maxX = rect.left + Math.max(0, rect.width - width);
      const maxY = rect.top + Math.max(0, rect.height - height);
      return {
        x: Math.round(clamp(anchorX + offsetX, minX, maxX)),
        y: Math.round(clamp(anchorY + offsetY, minY, maxY)),
        width,
        height,
        mode: PET_MODE.game,
      };
    }
  }

  const desktop =
    input.desktopPosition ||
    defaultDesktopPosition(input.workArea, { width, height }, margin);
  return {
    x: Math.round(finite(desktop.x)),
    y: Math.round(finite(desktop.y)),
    width,
    height,
    mode: PET_MODE.desktop,
  };
}

export default {
  PET_MODE,
  DEFAULT_PET_SIZE,
  DEFAULT_PET_MARGIN,
  clamp,
  normalizeGameRect,
  resolvePetMode,
  defaultDesktopPosition,
  computePetBounds,
};
