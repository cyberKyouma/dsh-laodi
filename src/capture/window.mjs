/**
 * 前台窗口探测（Windows）。
 *
 * 思路：PowerShell + user32.dll 取当前前台窗口的标题 / 进程 / 矩形。
 * 标题与进程名都走白名单，白名单可在 config.gameWindow 里改。
 *
 * 本文件同时提供纯函数（matchWindowTitle / isGameWindow），
 * 方便不启动 PowerShell 就能单测。
 */

import { runPowerShellJson } from './powershell.mjs';

const FOREGROUND_PS = `
$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
using System.Text;

public static class DshWin32 {
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetWindowTextW(IntPtr hWnd, StringBuilder text, int count);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetClassNameW(IntPtr hWnd, StringBuilder text, int count);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint processId);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hWnd, out RECT rect);

  [StructLayout(LayoutKind.Sequential)]
  public struct RECT { public int Left; public int Top; public int Right; public int Bottom; }
}
'@

$hwnd = [DshWin32]::GetForegroundWindow()
$titleSb = New-Object System.Text.StringBuilder 512
[void][DshWin32]::GetWindowTextW($hwnd, $titleSb, $titleSb.Capacity)
$classSb = New-Object System.Text.StringBuilder 256
[void][DshWin32]::GetClassNameW($hwnd, $classSb, $classSb.Capacity)

$procId = 0
[void][DshWin32]::GetWindowThreadProcessId($hwnd, [ref]$procId)
$procName = ''
try { $procName = (Get-Process -Id $procId -ErrorAction Stop).ProcessName } catch { $procName = '' }

$rect = [DshWin32+RECT]::new()
[void][DshWin32]::GetWindowRect($hwnd, [ref]$rect)

[pscustomobject]@{
  hwnd = $hwnd.ToInt64()
  title = $titleSb.ToString()
  className = $classSb.ToString()
  pid = $procId
  processName = $procName
  rect = @{
    left = $rect.Left
    top = $rect.Top
    right = $rect.Right
    bottom = $rect.Bottom
    width = ($rect.Right - $rect.Left)
    height = ($rect.Bottom - $rect.Top)
  }
} | ConvertTo-Json -Compress -Depth 5
`;

const WINDOW_LIST_PS = `
$ErrorActionPreference = 'SilentlyContinue'
$items = @(
  Get-Process | Where-Object { $_.MainWindowTitle -and $_.MainWindowTitle.Trim().Length -gt 0 } | ForEach-Object {
    [pscustomobject]@{
      pid = $_.Id
      processName = $_.ProcessName
      title = $_.MainWindowTitle
      hwnd = $_.MainWindowHandle.ToInt64()
    }
  }
)
ConvertTo-Json -InputObject $items -Compress -Depth 4
`;

/**
 * 纯函数：标题是否命中白名单。
 * @returns {string|null} 命中的关键字（没命中返回 null）
 */
export function matchWindowTitle(title, keywords = []) {
  const text = String(title ?? '').trim().toLowerCase();
  if (!text) return null;
  for (const keyword of keywords ?? []) {
    const needle = String(keyword ?? '').trim().toLowerCase();
    if (!needle) continue;
    if (text.includes(needle)) return keyword;
  }
  return null;
}

/**
 * Get-Process 的 ProcessName 不带 .exe，白名单里两种写法都认。
 */
export function normalizeProcessName(name) {
  return String(name ?? '')
    .trim()
    .toLowerCase()
    .replace(/\.exe$/i, '');
}

/**
 * 纯函数：窗口是否算 P5R 游戏窗口（标题命中，或进程名命中）。
 */
export function isGameWindow(windowInfo, options = {}) {
  if (!windowInfo) return false;
  const { titleKeywords = [], processNames = [] } = options;
  if (matchWindowTitle(windowInfo.title, titleKeywords)) return true;
  const proc = normalizeProcessName(windowInfo.processName);
  if (!proc) return false;
  return processNames.some((name) => normalizeProcessName(name) === proc);
}

/**
 * 取当前前台窗口信息；探测失败返回 null（不抛）。
 * @returns {Promise<object|null>}
 */
export async function probeForegroundWindow(options = {}) {
  try {
    const info = await runPowerShellJson(FOREGROUND_PS, options);
    if (!info || typeof info !== 'object') return null;
    if (!info.title && !info.processName) return null;
    return info;
  } catch {
    return null;
  }
}

/**
 * 列出所有有主窗口的进程窗口。
 * @returns {Promise<Array<object>>}
 */
export async function listTopLevelWindows(options = {}) {
  try {
    const parsed = await runPowerShellJson(WINDOW_LIST_PS, options);
    if (!parsed) return [];
    const list = Array.isArray(parsed) ? parsed : [parsed];
    return list.filter((item) => item && item.title);
  } catch {
    return [];
  }
}

/**
 * 在窗口列表里找 P5R 游戏窗口。
 * @returns {Promise<object|null>}
 */
export async function findGameWindow(options = {}) {
  const windows = await listTopLevelWindows(options);
  return windows.find((win) => isGameWindow(win, options)) ?? null;
}

/**
 * 当前前台窗口是否就是 P5R。
 * @returns {Promise<boolean>}
 */
export async function isGameForeground(options = {}) {
  const foreground = await probeForegroundWindow(options);
  return isGameWindow(foreground, options);
}

export default {
  probeForegroundWindow,
  listTopLevelWindows,
  findGameWindow,
  isGameForeground,
  isGameWindow,
  matchWindowTitle,
  normalizeProcessName,
};
