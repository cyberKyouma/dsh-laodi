/**
 * 游戏窗口截屏。
 *
 * 约束（来自 SPEC「隐私」）：截图默认不落盘。
 * 这里只把 PNG 写进系统临时目录，读回内存后立刻删掉临时文件，
 * 并且显式拒绝把临时文件写到仓库里面。
 */

import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { PROJECT_ROOT } from '../paths.mjs';
import { runPowerShell, psQuote } from './powershell.mjs';

function captureScript(outPath, rect) {
  return `
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing

$left = ${rect.left}
$top = ${rect.top}
$width = ${rect.width}
$height = ${rect.height}
if ($width -le 0 -or $height -le 0) { throw 'invalid rect' }

$bitmap = New-Object System.Drawing.Bitmap($width, $height)
$graphics = [System.Drawing.Graphics]::FromImage($bitmap)
try {
  $graphics.CopyFromScreen($left, $top, 0, 0, (New-Object System.Drawing.Size($width, $height)))
  $bitmap.Save(${psQuote(outPath)}, [System.Drawing.Imaging.ImageFormat]::Png)
} finally {
  $graphics.Dispose()
  $bitmap.Dispose()
}
Write-Output 'ok'
`;
}

/** 目标路径是否落在项目目录内（截图绝对不允许落在仓库里） */
export function isInsideProject(targetPath, root = PROJECT_ROOT) {
  const relative = path.relative(path.resolve(root), path.resolve(targetPath));
  return (
    relative === '' ||
    (!relative.startsWith('..') && !path.isAbsolute(relative))
  );
}

function normalizeRect(rect) {
  const left = Math.round(Number(rect?.left ?? 0) || 0);
  const top = Math.round(Number(rect?.top ?? 0) || 0);
  const rawWidth = rect?.width ?? (Number(rect?.right ?? 0) - Number(rect?.left ?? 0));
  const rawHeight = rect?.height ?? (Number(rect?.bottom ?? 0) - Number(rect?.top ?? 0));
  const width = Math.round(Number(rawWidth) || 0);
  const height = Math.round(Number(rawHeight) || 0);
  if (!(width > 0) || !(height > 0)) {
    throw new Error(`窗口矩形非法: ${width}x${height}`);
  }
  return { left, top, width, height };
}

/**
 * 截取屏幕上一块矩形，PNG 只存在于内存。
 * @returns {Promise<{buffer: Buffer, mimeType: string, bytes: number, rect: object}>}
 */
export async function captureRectToBuffer(rect, options = {}) {
  const normalized = normalizeRect(rect);
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-laodi-shot-'));
  const outPath = path.join(tempDir, 'shot.png');

  if (isInsideProject(outPath)) {
    await fs.rm(tempDir, { recursive: true, force: true }).catch(() => {});
    throw new Error('拒绝把截图写入项目目录');
  }

  try {
    await runPowerShell(captureScript(outPath, normalized), {
      timeoutMs: options.timeoutMs ?? 15000,
    });
    const buffer = await fs.readFile(outPath);
    return {
      buffer,
      mimeType: 'image/png',
      bytes: buffer.length,
      rect: normalized,
    };
  } finally {
    // 立刻清掉临时 PNG：截图默认不落盘
    await fs.rm(tempDir, { recursive: true, force: true }).catch(() => {});
  }
}

/**
 * 截取指定窗口（需要 windowInfo.rect）。
 */
export async function captureWindowToBuffer(windowInfo, options = {}) {
  if (!windowInfo?.rect) throw new Error('windowInfo.rect 缺失');
  return captureRectToBuffer(windowInfo.rect, options);
}

/** PNG -> base64（给视觉 API 用） */
export function bufferToBase64(buffer) {
  return Buffer.from(buffer).toString('base64');
}

export default {
  captureRectToBuffer,
  captureWindowToBuffer,
  bufferToBase64,
  isInsideProject,
};
