/**
 * Windows PowerShell 调用封装。
 *
 * 说明：
 *   - 统一用 -EncodedCommand（UTF-16LE + base64）传脚本，避免引号转义地狱；
 *   - 统一 windowsHide，避免每次探测都闪一个黑框；
 *   - 统一超时，探测失败不能拖垮主循环。
 */

import { execFile } from 'node:child_process';

export const POWERSHELL_BIN = process.env.DSH_POWERSHELL || 'powershell.exe';

const DEFAULT_TIMEOUT_MS = 15000;
const MAX_BUFFER = 8 * 1024 * 1024;

/** UTF-16LE + base64 编码 PowerShell 脚本 */
export function encodePowerShellCommand(script) {
  return Buffer.from(script, 'utf16le').toString('base64');
}

/** 把任意字符串安全地包成 PowerShell 单引号字符串 */
export function psQuote(value) {
  return `'${String(value).replace(/'/g, "''")}'`;
}

/**
 * 执行一段 PowerShell 脚本。
 * @returns {Promise<{stdout: string, stderr: string}>}
 */
export function runPowerShell(script, options = {}) {
  const timeout = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  return new Promise((resolve, reject) => {
    execFile(
      POWERSHELL_BIN,
      [
        '-NoProfile',
        '-NonInteractive',
        '-ExecutionPolicy',
        'Bypass',
        '-EncodedCommand',
        encodePowerShellCommand(script),
      ],
      {
        timeout,
        windowsHide: true,
        maxBuffer: MAX_BUFFER,
        encoding: 'utf8',
      },
      (error, stdout, stderr) => {
        if (error) {
          const detail = (stderr || error.message || '').toString().trim();
          const err = new Error(`PowerShell 执行失败: ${detail || error.message}`);
          err.cause = error;
          err.stdout = stdout;
          err.stderr = stderr;
          reject(err);
          return;
        }
        resolve({ stdout: stdout ?? '', stderr: stderr ?? '' });
      },
    );
  });
}

/**
 * 执行 PowerShell 并解析 JSON 输出；解析失败返回 null（不抛）。
 */
export async function runPowerShellJson(script, options = {}) {
  const { stdout } = await runPowerShell(script, options);
  const text = String(stdout).trim();
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

export default { runPowerShell, runPowerShellJson, encodePowerShellCommand, psQuote };
