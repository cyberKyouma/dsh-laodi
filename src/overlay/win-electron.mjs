/**
 * Windows overlay backend for DSH's Node-mode host.
 * Packaged DeepSeek Harness runs plugins with ELECTRON_RUN_AS_NODE, so
 * require('electron') has no BrowserWindow. This shim spawns a WPF window
 * and mimics the small BrowserWindow surface overlay.mjs already uses.
 */
import { spawn, execFileSync } from 'node:child_process';
import { appendFileSync } from 'node:fs';
import { EventEmitter } from 'node:events';
import { homedir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../runtime/overlay/win-overlay.ps1',
);

function powershellExe() {
  return process.env.SystemRoot
    ? path.join(process.env.SystemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
    : 'powershell.exe';
}

function fileTrace(line) {
  try {
    const home = process.env.DSH_HOME || path.join(homedir(), '.dsh');
    appendFileSync(path.join(home, 'dsh-laodi.log'), `[${new Date().toISOString()}] ${line}\n`, 'utf8');
  } catch {
    // ignore
  }
}

let cachedWorkArea = null;

export function readWindowsWorkArea() {
  if (cachedWorkArea) return cachedWorkArea;
  try {
    const out = execFileSync(
      powershellExe(),
      [
        '-NoProfile',
        '-STA',
        '-ExecutionPolicy',
        'Bypass',
        '-Command',
        'Add-Type -AssemblyName PresentationFramework; $w=[System.Windows.SystemParameters]::WorkArea; Write-Output ("{0},{1},{2},{3}" -f $w.X,$w.Y,$w.Width,$w.Height)',
      ],
      { timeout: 5000, windowsHide: true, encoding: 'utf8' },
    );
    const parts = String(out)
      .trim()
      .split(/[,\s]+/)
      .map((item) => Number(item));
    if (parts.length >= 4 && parts[2] > 0 && parts[3] > 0) {
      cachedWorkArea = { x: parts[0], y: parts[1], width: parts[2], height: parts[3] };
    }
  } catch {
    // fall through
  }
  return cachedWorkArea || { x: 0, y: 0, width: 1280, height: 800 };
}

const liveWindows = new Set();

class WinBrowserWindow extends EventEmitter {
  constructor(options = {}) {
    super();
    this._destroyed = false;
    this._shown = false;
    this._bounds = {
      x: Number(options.x) || 0,
      y: Number(options.y) || 0,
      width: Number(options.width) > 0 ? Number(options.width) : 300,
      height: Number(options.height) > 0 ? Number(options.height) : 220,
    };
    this._queue = [];
    this._ready = false;
    this._child = null;
    this._buf = '';
    this.webContents = {
      send: (channel, payload) => {
        this._send({ op: 'channel', channel, payload });
        return true;
      },
      executeJavaScript: (script) => this._executeJavaScript(script),
      getURL: () => 'file://dsh-laodi-overlay',
    };
    liveWindows.add(this);
    this._spawn();
    this._send({
      op: 'bounds',
      x: this._bounds.x,
      y: this._bounds.y,
      width: this._bounds.width,
      height: this._bounds.height,
    });
  }

  _spawn() {
    fileTrace(`[overlay-ps] spawn ${SCRIPT}`);
    const child = spawn(
      powershellExe(),
      [
        '-NoProfile',
        '-STA',
        '-ExecutionPolicy',
        'Bypass',
        '-WindowStyle',
        'Hidden',
        '-File',
        SCRIPT,
        '-X',
        String(this._bounds.x),
        '-Y',
        String(this._bounds.y),
        '-Width',
        String(this._bounds.width),
        '-Height',
        String(this._bounds.height),
      ],
      {
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true,
        env: { ...process.env, PYTHONIOENCODING: 'utf-8' },
      },
    );
    this._child = child;
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      this._buf += chunk;
      let idx;
      while ((idx = this._buf.indexOf('\n')) >= 0) {
        const line = this._buf.slice(0, idx).trim();
        this._buf = this._buf.slice(idx + 1);
        if (line) this._onLine(line);
      }
    });
    child.stderr.on('data', (chunk) => {
      const line = String(chunk).trim();
      if (line) fileTrace(`[overlay-ps] ${line}`);
    });
    const fail = (code, signal) => {
      fileTrace(`[overlay-ps] exit code=${code ?? ''} signal=${signal || ''}`);
      if (this._destroyed) return;
      this._destroyed = true;
      liveWindows.delete(this);
      this.emit('closed');
    };
    child.on('exit', (code, signal) => fail(code, signal));
    child.on('error', (err) => {
      fileTrace(`[overlay-ps] error ${err && err.message ? err.message : err}`);
      fail(null, 'error');
    });
  }

  _onLine(line) {
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      fileTrace(`[overlay-ps] non-json ${line.slice(0, 200)}`);
      return;
    }
    const event = String(msg.event || '');
    if (event === 'ready') {
      fileTrace(`[overlay-ps] ready hwnd=${msg.hwnd || ''} workArea=${JSON.stringify(msg.workArea || {})}`);
      if (msg.workArea && Number(msg.workArea.width) > 0) {
        cachedWorkArea = {
          x: Number(msg.workArea.x) || 0,
          y: Number(msg.workArea.y) || 0,
          width: Number(msg.workArea.width),
          height: Number(msg.workArea.height),
        };
      }
      this._ready = true;
      const queued = this._queue.splice(0, this._queue.length);
      for (const item of queued) this._write(item);
      this._write({
        op: 'bounds',
        x: this._bounds.x,
        y: this._bounds.y,
        width: this._bounds.width,
        height: this._bounds.height,
      });
      if (this._shown) this._write({ op: 'show' });
      fileTrace(`[overlay-ps] flushed queue=${queued.length} bounds=${JSON.stringify(this._bounds)} shown=${this._shown}`);
      return;
    }
    if (event === 'moved') {
      this._bounds = {
        x: Number(msg.x) || 0,
        y: Number(msg.y) || 0,
        width: Number(msg.width) || this._bounds.width,
        height: Number(msg.height) || this._bounds.height,
      };
      this.emit('move');
      this.emit('moved');
      return;
    }
    if (event === 'chat') {
      const payload = { text: String(msg.text || '') };
      this.emit('ipc', 'dsh-laodi:chat', payload);
      return;
    }
    if (event === 'closed') {
      this._destroyed = true;
      liveWindows.delete(this);
      this.emit('closed');
    }
  }

  _write(cmd) {
    if (!this._child || !this._child.stdin || this._destroyed) return;
    try {
      this._child.stdin.write(`${JSON.stringify(cmd)}\n`);
    } catch {
      // ignore
    }
  }

  _send(cmd) {
    if (this._destroyed) return;
    if (!this._ready) {
      this._queue.push(cmd);
      return;
    }
    this._write(cmd);
  }

  _executeJavaScript(script) {
    const text = String(script || '');
    const match = text.match(/window\.__DSH_OVERLAY_STATE__\s*=\s*(\{[\s\S]*\})\s*;?\s*$/);
    if (match) {
      try {
        this._send({ op: 'state', state: JSON.parse(match[1]) });
      } catch {
        // ignore malformed state
      }
      return Promise.resolve();
    }
    if (text.includes('__DSH_OVERLAY_OUTBOX__')) {
      return Promise.resolve([]);
    }
    return Promise.resolve();
  }

  setAlwaysOnTop() {
    return true;
  }

  setVisibleOnAllWorkspaces() {
    return true;
  }

  setIgnoreMouseEvents(ignore) {
    this._send({ op: 'ignoreMouse', ignore: Boolean(ignore) });
  }

  loadFile() {
    return Promise.resolve();
  }

  showInactive() {
    this._shown = true;
    this._send({ op: 'show' });
  }

  show() {
    this.showInactive();
  }

  hide() {
    this._shown = false;
    this._send({ op: 'hide' });
  }

  getBounds() {
    return { ...this._bounds };
  }

  setBounds(bounds) {
    if (!bounds) return;
    this._bounds = {
      x: Number(bounds.x) || 0,
      y: Number(bounds.y) || 0,
      width: Number(bounds.width) > 0 ? Number(bounds.width) : this._bounds.width,
      height: Number(bounds.height) > 0 ? Number(bounds.height) : this._bounds.height,
    };
    this._send({
      op: 'bounds',
      x: this._bounds.x,
      y: this._bounds.y,
      width: this._bounds.width,
      height: this._bounds.height,
    });
  }

  isDestroyed() {
    return this._destroyed;
  }

  destroy() {
    if (this._destroyed) return;
    this._destroyed = true;
    this._send({ op: 'quit' });
    liveWindows.delete(this);
    const child = this._child;
    this._child = null;
    if (child) {
      try {
        child.stdin?.end();
      } catch {
        // ignore
      }
      setTimeout(() => {
        try {
          if (!child.killed) child.kill();
        } catch {
          // ignore
        }
      }, 800).unref?.();
    }
    this.emit('closed');
  }
}

WinBrowserWindow.getAllWindows = () => [...liveWindows];

class ShimIpcMain extends EventEmitter {
  on(channel, listener) {
    super.on(channel, listener);
    return this;
  }

  removeListener(channel, listener) {
    super.off(channel, listener);
    return this;
  }
}

export function createWinElectronShim() {
  const ipcMain = new ShimIpcMain();
  class BoundWindow extends WinBrowserWindow {
    constructor(options) {
      super(options);
      this.on('ipc', (channel, payload) => {
        ipcMain.emit(channel, { sender: this.webContents }, payload);
      });
    }
  }
  BoundWindow.getAllWindows = WinBrowserWindow.getAllWindows;
  return {
    BrowserWindow: BoundWindow,
    ipcMain,
    screen: {
      getPrimaryDisplay() {
        const area = readWindowsWorkArea();
        return { workArea: { ...area }, bounds: { ...area }, scaleFactor: 1 };
      },
    },
  };
}

export default { createWinElectronShim, readWindowsWorkArea };
