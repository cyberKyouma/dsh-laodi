#!/usr/bin/env node
/**
 * 离线冒烟测试：不启动游戏、不连网络、不写仓库。
 *
 *   node scripts/smoke.mjs
 *
 * 覆盖：config 载入与校验 / policy 少说规则 / 知识包 schema /
 *       窗口白名单匹配 / 视觉请求构造 / 悬浮窗降级 / 主循环分支。
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { loadConfig, DEFAULT_CONFIG, resolveDataDir } from '../src/config.mjs';
import { PROJECT_ROOT, DATA_DIR } from '../src/paths.mjs';
import { loadKnowledgePack, validateKnowledgePack } from '../src/data/knowledge.mjs';
import { matchWindowTitle, isGameWindow } from '../src/capture/window.mjs';
import { isInsideProject } from '../src/capture/screenshot.mjs';
import {
  buildChatCompletionBody,
  parseVisionResult,
  createVisionClient,
} from '../src/vision/client.mjs';
import { createOverlayController } from '../src/overlay/overlay.mjs';
import {
  computePetBounds,
  defaultDesktopPosition,
  resolvePetMode,
} from '../src/overlay/placement.mjs';
import { detectDshPet, isDshPetName } from '../src/overlay/pet-conflict.mjs';
import { createHost } from '../src/index.mjs';
import { runPolicyTests } from './smoke-policy.mjs';

let passed = 0;
let failed = 0;

// 异步用例必须被 await，否则断言失败不会计入 failed，
// 还会变成 unhandledRejection 把 Node 随机炸掉。
async function test(name, fn) {
  try {
    await fn();
    passed += 1;
    console.log(`  PASS  ${name}`);
  } catch (err) {
    failed += 1;
    console.error(`  FAIL  ${name}`);
    console.error(`        ${err instanceof Error ? err.message : String(err)}`);
  }
}

const silentLogger = { info() {}, warn() {}, error() {} };

console.log('config:');

await test('默认值符合 SPEC 的少说规则', () => {
  const config = loadConfig({ env: {} });
  assert.equal(config.captureIntervalSec, 100);
  assert.equal(config.minSpeakGapSec, 180);
  assert.equal(config.speakProbability, 0.3);
  assert.equal(config.bubbleMaxChars, 40);
  assert.equal(config.policy.cooldownSec, 1800);
  assert.equal(config.hotkey.ask, 'Ctrl+Shift+Space');
  assert.ok(config.gameWindow.titleKeywords.includes('P5R'));
});

await test('环境变量可覆盖配置', () => {
  const config = loadConfig({
    env: {
      DSH_VISION_BASE_URL: 'https://example.invalid/v1/',
      DSH_VISION_MODEL: 'demo-model',
      DSH_VISION_API_KEY: '',
      DSH_CAPTURE_INTERVAL_SEC: '120',
    },
  });
  assert.equal(config.vision.baseURL, 'https://example.invalid/v1');
  assert.equal(config.vision.model, 'demo-model');
  assert.equal(config.captureIntervalSec, 120);
  assert.equal(config.vision.mock, true, '没有 apiKey 应该走 mock');
});

await test('越界值会被收敛回安全区间', () => {
  const config = loadConfig({
    env: {
      DSH_SPEAK_PROBABILITY: '0.9',
      DSH_MIN_SPEAK_GAP_SEC: '10',
      DSH_BUBBLE_MAX_CHARS: '999',
      DSH_CAPTURE_INTERVAL_SEC: '5',
    },
  });
  assert.equal(config.speakProbability, 0.3);
  assert.equal(config.minSpeakGapSec, 180);
  assert.equal(config.bubbleMaxChars, 40);
  assert.equal(config.captureIntervalSec, 60);
  assert.ok(config.warnings.length > 0);
});

await test('数据目录指向插件数据目录', () => {
  const dir = resolveDataDir({ DSH_LAODI_DATA_DIR: 'D:\\tmp\\dsh-laodi' });
  assert.ok(dir.includes('dsh-laodi'));
});

await test('配置数组是可写副本（不指向被冻结的默认值）', () => {
  const config = loadConfig({ env: {} });
  config.gameWindow.titleKeywords.push('测试关键字');
  config.policy.mutedSceneKeywords.push('测试静音词');
  assert.ok(!DEFAULT_CONFIG.gameWindow.titleKeywords.includes('测试关键字'));
  assert.ok(!DEFAULT_CONFIG.policy.mutedSceneKeywords.includes('测试静音词'));
});

console.log('knowledge pack:');

await test('三个知识包都能加载且结构完整', () => {
  const pack = loadKnowledgePack();
  const result = validateKnowledgePack(pack);
  assert.deepEqual(result.errors, []);
  assert.ok(result.ok);
  assert.ok(pack.calendar.length > 0);
  assert.ok(pack['shop-items'].length > 0);
  assert.ok(pack.glossary.length > 0);
});

await test('知识包文件在 data/p5r 下', () => {
  assert.ok(fs.existsSync(path.join(DATA_DIR, 'calendar.json')));
  assert.ok(fs.existsSync(path.join(DATA_DIR, 'shop-items.json')));
  assert.ok(fs.existsSync(path.join(DATA_DIR, 'glossary.json')));
});

console.log('window:');

await test('P5R 标题白名单匹配', () => {
  const keywords = DEFAULT_CONFIG.gameWindow.titleKeywords;
  assert.equal(matchWindowTitle('Persona 5 Royal', keywords), 'Persona 5 Royal');
  assert.equal(matchWindowTitle('女神异闻录 5 皇家版', keywords), '女神异闻录');
  assert.equal(matchWindowTitle('Visual Studio Code', keywords), null);
});

await test('进程名也能识别游戏窗口', () => {
  const options = DEFAULT_CONFIG.gameWindow;
  assert.equal(
    isGameWindow({ title: 'Windowed Mode', processName: 'Persona5Royal.exe' }, options),
    true,
  );
  assert.equal(
    isGameWindow({ title: 'Chrome', processName: 'chrome.exe' }, options),
    false,
  );
  assert.equal(isGameWindow(null, options), false);
  assert.equal(
    isGameWindow({ title: 'Windowed Mode', processName: 'Persona5Royal' }, options),
    true,
    'Get-Process 的进程名不带 .exe，也要认',
  );
});

console.log('vision:');

await test('多模态请求体结构正确', () => {
  const body = buildChatCompletionBody({
    model: 'demo',
    prompt: '描述画面',
    imageBase64: 'AAAA',
  });
  assert.equal(body.model, 'demo');
  assert.equal(body.messages[0].content[0].type, 'text');
  assert.equal(body.messages[0].content[1].type, 'image_url');
  assert.ok(body.messages[0].content[1].image_url.url.startsWith('data:image/png;base64,'));
  assert.equal(body.response_format.type, 'json_object');
});

await test('解析 JSON 结果 / 兜底纯文本', () => {
  const parsed = parseVisionResult(
    '{"scene":"street","summary":"街道","suggestion":"去花坛","spoilerLevel":1}',
  );
  assert.equal(parsed.scene, 'street');
  assert.equal(parsed.suggestion, '去花坛');
  assert.equal(parsed.spoilerLevel, 1);
  const fallback = parseVisionResult('就是一条街');
  assert.equal(fallback.scene, 'unknown');
  assert.equal(fallback.summary, '就是一条街');
});

await test('没有 apiKey 时视觉客户端走 mock', async () => {
  const client = createVisionClient({ vision: { baseURL: 'x', model: 'y', apiKey: '' } });
  assert.equal(client.isMock, true);
  const result = await client.describe({ imageBase64: 'AAAA' });
  assert.equal(result.scene, 'street');
});

console.log('overlay:');

await test('没有 Electron 时降级但仍能记录气泡', () => {
  const overlay = createOverlayController({ config: loadConfig({ env: {} }), logger: silentLogger });
  assert.equal(overlay.available, false);
  overlay.speak('测试气泡');
  assert.equal(overlay.lastBubble, '测试气泡');
  overlay.setCalibration({ gameDate: '04/01', timeSlot: '12:00' });
  assert.equal(overlay.calibration.gameDate, '04/01');
});

await test('气泡状态会记录到 pageState（无 Electron 降级）', () => {
  const overlay = createOverlayController({ config: loadConfig({ env: {} }), logger: silentLogger });
  overlay.speak('测试气泡', { at: 1000 });
  assert.equal(overlay.pageState.bubble, '测试气泡');
  assert.equal(overlay.pageState.bubbleAtSec, 1000);
  assert.equal(overlay.pageState.seq, 1);
  overlay.speak('第二句', { at: 2000 });
  assert.equal(overlay.pageState.bubble, '第二句');
  assert.equal(overlay.pageState.seq, 2, 'seq 必须递增，页面才能识别新气泡');
});

await test('Electron 模式下会把状态注入页面脚本', () => {
  const scripts = [];
  class FakeBrowserWindow {
    constructor(options) {
      this.options = options;
      this.webContents = {
        send() {},
        executeJavaScript(script) {
          scripts.push(script);
          return Promise.resolve();
        },
      };
    }
    isDestroyed() { return false; }
    loadFile() {}
    show() {}
    hide() {}
    setAlwaysOnTop() {}
    setIgnoreMouseEvents() {}
  }

  const overlay = createOverlayController({
    config: loadConfig({ env: {} }),
    electron: { BrowserWindow: FakeBrowserWindow },
    logger: silentLogger,
  });
  assert.equal(overlay.available, true);
  overlay.speak('注入测试', { at: 1000 });
  assert.ok(scripts.length > 0, '应该调用 executeJavaScript 注入状态');
  const script = scripts[scripts.length - 1];
  assert.ok(script.includes('__DSH_OVERLAY_STATE__'));
  assert.ok(script.includes('注入测试'));
  assert.ok(script.includes('"seq":1'));
});

await test('形象位置：桌面右下角，进游戏贴窗口，离开后回到原位', () => {
  const area = { x: 0, y: 0, width: 1000, height: 800 };
  const size = { width: 300, height: 220 };
  const home = defaultDesktopPosition(area, size, 16);
  assert.equal(home.x, 684);
  assert.equal(home.y, 564);
  assert.equal(resolvePetMode({ title: 'Chrome', processName: 'chrome' }, DEFAULT_CONFIG.gameWindow), 'desktop');
  assert.equal(
    resolvePetMode({ title: 'Persona 5 Royal', processName: 'game' }, DEFAULT_CONFIG.gameWindow),
    'game',
  );

  const game = computePetBounds({
    mode: 'game',
    gameRect: { left: 100, top: 50, width: 800, height: 600 },
    width: 300,
    height: 220,
    margin: 16,
  });
  assert.equal(game.mode, 'game');
  assert.equal(game.x, 584);
  assert.equal(game.y, 414);
  assert.ok(game.x >= 100 && game.x + game.width <= 900);
  assert.ok(game.y >= 50 && game.y + game.height <= 650);

  const back = computePetBounds({
    mode: 'desktop',
    desktopPosition: home,
    width: 300,
    height: 220,
  });
  assert.equal(back.mode, 'desktop');
  assert.equal(back.x, home.x);
  assert.equal(back.y, home.y);
});

await test('Electron 形象窗跟随游戏窗口，拖回桌面后记住位置', () => {
  const windows = [];
  class FakeBrowserWindow {
    constructor() {
      windows.push(this);
      this.bounds = { x: 0, y: 0, width: 300, height: 220 };
      this.listeners = {};
      this.webContents = {
        send() {},
        executeJavaScript() {
          return Promise.resolve([]);
        },
      };
    }
    isDestroyed() { return false; }
    loadFile() {}
    show() { this.visible = true; }
    showInactive() { this.visible = true; this.inactive = true; }
    hide() { this.visible = false; }
    setAlwaysOnTop() {}
    setVisibleOnAllWorkspaces() {}
    setIgnoreMouseEvents(ignore) { this.ignoreMouse = ignore; }
    setBounds(bounds) { this.bounds = { ...this.bounds, ...bounds }; }
    getBounds() { return { ...this.bounds }; }
    on(event, cb) { this.listeners[event] = cb; }
    destroy() { this.destroyed = true; }
  }

  const overlay = createOverlayController({
    config: { overlay: { width: 300, height: 220, margin: 16 } },
    electron: {
      BrowserWindow: FakeBrowserWindow,
      screen: {
        getPrimaryDisplay() {
          return { workArea: { x: 0, y: 0, width: 1000, height: 800 } };
        },
      },
    },
    logger: silentLogger,
  });
  assert.equal(overlay.show(), true);
  const win = windows[0];
  assert.equal(win.inactive, true, '出场时不抢焦点');
  const home = overlay.place({ mode: 'desktop' });
  assert.equal(home.x, 684);
  assert.equal(home.y, 564);
  assert.equal(overlay.pageState.mode, 'desktop');

  win.setBounds({ x: 40, y: 50, width: 300, height: 220 });
  win.listeners.move();
  const game = overlay.place({
    mode: 'game',
    gameRect: { left: 100, top: 50, width: 800, height: 600 },
  });
  assert.equal(overlay.mode, 'game');
  assert.equal(game.x, 584);
  assert.equal(game.y, 414);
  assert.equal(overlay.pageState.mode, 'game');

  win.setBounds({ x: 584, y: 374, width: 300, height: 220 });
  win.listeners.move();
  const nudged = overlay.place({
    mode: 'game',
    gameRect: { left: 100, top: 50, width: 800, height: 600 },
  });
  assert.equal(nudged.y, 374);

  const back = overlay.place({ mode: 'desktop' });
  assert.equal(back.x, 40);
  assert.equal(back.y, 50);
  assert.equal(overlay.pageState.mode, 'desktop');
  overlay.handleRendererMessage('dsh-laodi:hit-test', { ignore: true });
  assert.equal(win.ignoreMouse, true);
  overlay.destroy();
});

await test('检测到 dsh-pet 时不创建第二个形象', () => {
  assert.equal(isDshPetName('dsh-laodi'), false);
  assert.equal(isDshPetName('dsh-pet'), true);
  const made = [];
  class FakeBrowserWindow {
    constructor() { made.push(this); }
  }
  const overlay = createOverlayController({
    electron: { BrowserWindow: FakeBrowserWindow },
    petConflict: { loaded: true, notice: '检测到 dsh-pet 也在运行' },
    logger: silentLogger,
  });
  assert.equal(overlay.show(), false);
  overlay.speak('不该出现');
  assert.equal(overlay.lastBubble, '不该出现');
  assert.equal(made.length, 0);
  assert.equal(overlay.status().suppressed, true);
  assert.match(overlay.status().notice, /dsh-pet/);

  const loaded = detectDshPet({
    ctx: { plugins: [{ name: 'dsh-pet' }] },
    moduleCache: [],
    existsSync: () => false,
    env: { DSH_HOME: path.join(os.tmpdir(), 'dsh-laodi-no-pet') },
  });
  assert.equal(loaded.loaded, true);
  assert.match(loaded.notice, /关闭/);

  const viaSettings = detectDshPet({
    petPluginId: 'dsh-pet',
    moduleCache: [],
    existsSync: () => false,
    env: { DSH_HOME: path.join(os.tmpdir(), 'dsh-laodi-no-pet') },
  });
  assert.equal(viaSettings.loaded, true);
  assert.ok(viaSettings.reasons.includes('settings'));

  const installedOnly = detectDshPet({
    pluginNames: ['dsh-laodi'],
    moduleCache: [],
    existsSync: (file) => String(file).includes(`${path.sep}dsh-pet${path.sep}`),
    env: { DSH_HOME: path.join(os.tmpdir(), 'dsh-laodi-maybe-pet') },
  });
  assert.equal(installedOnly.loaded, false);
  assert.ok(installedOnly.installedHint);
});

await test('截图目标目录不得落在项目内', () => {
  assert.equal(isInsideProject(path.join(PROJECT_ROOT, 'shot.png')), true);
  const outside = path.join(os.tmpdir(), 'dsh-laodi-outside', 'shot.png');
  assert.equal(isInsideProject(outside), false);
  if (process.platform === 'win32') {
    assert.equal(isInsideProject(path.join('C:\\Temp', 'shot.png')), false);
  }
});

console.log('host loop:');

await test('前台不是游戏 -> 跳过识屏与开口', async () => {
  let visionCalled = false;
  const host = createHost({
    config: loadConfig({ env: {} }),
    logger: silentLogger,
    probe: async () => ({ title: 'Google Chrome', processName: 'chrome' }),
    capture: async () => {
      throw new Error('不应该截屏');
    },
    vision: {
      describe: async () => {
        visionCalled = true;
        return { scene: 'street', summary: '', suggestion: '', spoilerLevel: 0 };
      },
    },
  });
  const result = await host.runOnce();
  assert.equal(result.skipped, true);
  assert.equal(result.reason, 'not-foreground');
  assert.equal(visionCalled, false);
});

await test('对话/过场场景 -> 不主动开口', async () => {
  const host = createHost({
    config: loadConfig({ env: {} }),
    logger: silentLogger,
    probe: async () => ({
      title: 'Persona 5 Royal',
      processName: 'Persona5Royal.exe',
      rect: { left: 0, top: 0, width: 100, height: 100 },
    }),
    capture: async () => ({ buffer: Buffer.from('fake'), mimeType: 'image/png' }),
    vision: {
      describe: async () => ({
        scene: 'dialog',
        summary: '剧情对话',
        suggestion: '继续往前走',
        spoilerLevel: 0,
      }),
    },
  });
  const result = await host.runOnce();
  assert.equal(result.spoke, false);
  assert.equal(result.reason, 'scene-muted');
});

await test('超长建议也走同一条冷却键（ACCEPTANCE #6）', async () => {
  const long = '老'.repeat(80);
  const config = loadConfig({ env: {} });
  const host = createHost({
    config,
    logger: silentLogger,
    clock: () => 1000,
    rng: () => 0,
    probe: async () => ({
      title: 'Persona 5 Royal',
      processName: 'Persona5Royal.exe',
      rect: { left: 0, top: 0, width: 100, height: 100 },
    }),
    capture: async () => ({ buffer: Buffer.from('fake'), mimeType: 'image/png' }),
    vision: {
      describe: async () => ({
        scene: 'street',
        summary: '街道',
        suggestion: long,
        spoilerLevel: 0,
      }),
    },
  });

  const first = await host.runOnce();
  assert.equal(first.spoke, true, '第一轮应该开口');
  assert.ok(first.text.length <= 40, '气泡必须 <= 40 字');

  // 同一句建议再来一次（但间隔够、概率必过）——应被 30min 冷却拦住
  host.state.lastSpeakAtSec = null;
  const second = await host.runOnce();
  assert.equal(second.spoke, false, '同一条建议 30min 内不能重复');
  assert.equal(second.reason, 'cooldown');
});

await test('主循环 start/stop 可控', async () => {
  const config = loadConfig({ env: {} });
  config.captureIntervalSec = 1;
  const host = createHost({
    config,
    logger: silentLogger,
    probe: async () => ({ title: 'Chrome', processName: 'chrome' }),
  });
  const running = host.start();
  assert.equal(host.state.running, true);
  await host.stop();
  await running;
  assert.equal(host.state.running, false);
});

await test('桌面不启动周期识屏；进入 P5R 才识，离开后停', async () => {
  const config = loadConfig({ env: {} });
  config.overlay.placementIntervalMs = 200;
  config.overlay.enabled = false;
  config.captureIntervalSec = 0.2;
  let where = 'desktop';
  let captures = 0;
  const host = createHost({
    config,
    logger: silentLogger,
    electron: null,
    probe: async () =>
      where === 'game'
        ? {
            title: 'Persona 5 Royal',
            processName: 'Persona5Royal',
            rect: { left: 10, top: 20, width: 800, height: 600 },
          }
        : { title: 'Google Chrome', processName: 'chrome' },
    capture: async () => {
      captures += 1;
      return { buffer: Buffer.from('x'), mimeType: 'image/png' };
    },
    vision: {
      describe: async () => ({
        scene: 'street',
        summary: '街',
        suggestion: '',
        spoilerLevel: 0,
      }),
    },
  });

  const running = host.start();
  await new Promise((resolve) => setTimeout(resolve, 450));
  assert.equal(captures, 0, '桌面阶段不能识屏');
  assert.equal(host.state.screenLoopRunning, false);
  assert.equal(host.state.petMode, 'desktop');
  assert.equal(host.overlay.pageState.mode, 'desktop');

  where = 'game';
  let sawGame = false;
  for (let i = 0; i < 40 && captures < 1; i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  sawGame = captures >= 1;
  assert.equal(sawGame, true, '进入 P5R 后要识屏');
  assert.equal(host.state.petMode, 'game');
  assert.equal(host.overlay.pageState.mode, 'game');

  where = 'desktop';
  await new Promise((resolve) => setTimeout(resolve, 700));
  assert.equal(host.state.petMode, 'desktop');
  assert.equal(host.state.screenLoopRunning, false);
  const settled = captures;
  await new Promise((resolve) => setTimeout(resolve, 500));
  assert.equal(captures, settled, '离开游戏后周期识屏要停');
  await host.stop();
  await running;
});

console.log('persona presets:');

await test('默认人格预设是「老弟」', async () => {
  const {
    DEFAULT_PERSONA_ID,
    listPersonaPresets,
    getPersonaPreset,
    applyPersonaPreset,
  } = await import('../src/host/persona.mjs');
  assert.equal(DEFAULT_PERSONA_ID, 'laodi');
  const presets = listPersonaPresets();
  assert.ok(presets.some((item) => item.id === 'laodi' && item.isDefault));
  const laodi = getPersonaPreset('laodi');
  assert.equal(laodi.name, '老弟');
  assert.ok(laodi.soul.includes('老弟'));
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-laodi-persona-'));
  const applied = applyPersonaPreset(tmp, 'laodi');
  assert.equal(applied.preset.id, 'laodi');
  assert.ok(fs.readFileSync(path.join(tmp, 'persona', 'SOUL.md'), 'utf8').includes('老弟'));
  assert.equal(
    JSON.parse(fs.readFileSync(path.join(tmp, 'persona', 'active.json'), 'utf8')).presetId,
    'laodi',
  );
});

console.log('companion session:');

await test('buildScreenInjectText / glossary inject 为纯文字', async () => {
  const {
    buildScreenInjectText,
    buildGlossaryInjectText,
  } = await import('../src/host/session.mjs');
  const screen = buildScreenInjectText({
    vision: { scene: 'street', summary: '涩谷', suggestion: '去花坛' },
    gameDate: '04/17',
    captureOk: true,
  });
  assert.ok(screen.includes('涩谷'));
  assert.ok(!screen.includes('base64'));
  const gloss = buildGlossaryInjectText({ term: 'Persona', brief: '人格面具' });
  assert.ok(gloss.includes('Persona'));
  assert.ok(gloss.includes('人格面具'));
});

await test('mock agents：ensure + 两轮 followup 共 Session，inject 带上识屏', async () => {
  const { createCompanionSessionManager } = await import('../src/host/session.mjs');
  const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-laodi-session-'));
  const env = { DSH_HOME: tmpHome };
  const { ensureCompanionWorkspace, attachSessionToWorkspace } = await import(
    '../src/host/workspace.mjs'
  );
  const ws = ensureCompanionWorkspace({
    env,
    workspacePath: path.join(tmpHome, 'ws'),
    workspaceTitle: '陪玩',
  });

  const store = { companionSessionId: '', workspaceId: ws.workspace.id };
  const followups = [];
  const injects = [];
  const agentsById = new Map();

  function makeAgent(id) {
    return {
      id,
      status: 'idle',
      session: { id },
      lastAssistantText: '',
      inject(msg) {
        injects.push(msg);
      },
      followup(msg) {
        followups.push(msg);
        this.lastAssistantText = `回：${msg.content?.[0]?.text || ''}`;
      },
      whenIdle: async () => {},
    };
  }

  const agents = {
    get(id) {
      return agentsById.get(id) || null;
    },
    async create({ sessionId }) {
      const agent = makeAgent(sessionId);
      agentsById.set(sessionId, agent);
      return {
        agent,
        async dispose() {
          agentsById.delete(sessionId);
        },
      };
    },
    async resume({ sessionId }) {
      const agent = makeAgent(sessionId);
      agentsById.set(sessionId, agent);
      return { agent, async dispose() {} };
    },
  };

  const prevEnv = process.env.DSH_HOME;
  process.env.DSH_HOME = tmpHome;
  try {
    const session = createCompanionSessionManager({
      getAgents: () => agents,
      getSettings: () => store,
      persistSettings: (patch) => {
        Object.assign(store, patch);
        return store;
      },
      getAgentOptions: () => ({ provider: 'magpie', model: 'deepseek/deepseek-flash' }),
    });

    const first = await session.ensure();
    assert.equal(first.ok, true);
    assert.equal(first.created, true);
    assert.ok(store.companionSessionId);
    const sid = store.companionSessionId;

    const linked = attachSessionToWorkspace({
      workspaceId: ws.workspace.id,
      sessionId: sid,
      env,
    });
    assert.equal(linked.ok, true);

    const a1 = await session.followupAsk('第一问', {
      screenText: '画面：街',
      glossaryText: '词条：Persona',
    });
    assert.equal(a1.ok, true);
    assert.equal(a1.mode, 'session');
    assert.equal(a1.sessionId, sid);
    assert.ok(injects.length >= 2);
    assert.equal(followups.length, 1);

    const a2 = await session.followupAsk('第二问还记得吗');
    assert.equal(a2.ok, true);
    assert.equal(a2.sessionId, sid);
    assert.equal(followups.length, 2);
    assert.ok(String(a2.reply || '').includes('第二问'));
  } finally {
    if (prevEnv === undefined) delete process.env.DSH_HOME;
    else process.env.DSH_HOME = prevEnv;
  }
});

await test('create 带 meta.cwd、resume 用 resumeSessionId、挂载走官方工作区注册表', async () => {
  const { createCompanionSessionManager } = await import('../src/host/session.mjs');
  const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-laodi-cwd-'));
  const wsDir = path.join(tmpHome, 'companion-ws');
  fs.mkdirSync(wsDir, { recursive: true });

  const createCalls = [];
  const resumeCalls = [];
  const attached = [];
  const detached = [];

  const workspace = {
    id: 'ws-1',
    path: wsDir,
    title: '陪玩',
    sessionIds: [],
    async attachSession(sessionId) {
      attached.push(sessionId);
      this.sessionIds = [...this.sessionIds, sessionId];
    },
    async detachSession(sessionId) {
      detached.push(sessionId);
      this.sessionIds = this.sessionIds.filter((id) => id !== sessionId);
    },
    async setTitle() {},
  };
  const registry = {
    async create() {
      return workspace;
    },
    async resolveByPath() {
      return undefined;
    },
    get(id) {
      return id === workspace.id ? workspace : undefined;
    },
    list() {
      return [workspace];
    },
  };

  function makeAgent(id, cwd) {
    return {
      id,
      status: 'idle',
      session: { id, header: cwd ? { cwd } : {} },
      inject() {},
      followup() {},
      whenIdle: async () => {},
    };
  }

  const agents = {
    get() {
      return null;
    },
    async create(options) {
      createCalls.push(options);
      return {
        agent: makeAgent(options.sessionId, options.meta?.cwd),
        async dispose() {},
      };
    },
    async resume(options) {
      resumeCalls.push(options);
      // 老会话没有 cwd（落在 ~/.dsh/sessions/_no-cwd）
      return {
        agent: makeAgent(options.resumeSessionId || options.sessionId, ''),
        async dispose() {},
      };
    },
  };

  const store = {
    companionSessionId: '',
    workspaceId: 'ws-1',
    workspacePath: wsDir,
    workspaceTitle: '陪玩',
  };

  const prevEnv = process.env.DSH_HOME;
  process.env.DSH_HOME = tmpHome;
  try {
    const session = createCompanionSessionManager({
      getAgents: () => agents,
      getSettings: () => store,
      persistSettings: (patch) => {
        Object.assign(store, patch);
        return store;
      },
      getWorkspaceRegistry: () => registry,
      getAgentOptions: () => ({ provider: 'magpie', model: 'deepseek/deepseek-flash' }),
    });

    const first = await session.ensure();
    assert.equal(first.ok, true);
    assert.equal(first.created, true);
    assert.equal(createCalls.length, 1);
    assert.equal(
      createCalls[0].meta?.cwd,
      wsDir,
      '建会话必须带 meta.cwd，否则会落到 ~/.dsh/sessions/_no-cwd',
    );
    assert.equal(createCalls[0].agentOptions?.provider, 'magpie');
    assert.equal(createCalls[0].agentOptions?.model, 'deepseek/deepseek-flash');
    assert.deepEqual(attached, [first.sessionId], '会话要挂到工作区');
    assert.equal(session.describe().cwd, wsDir);
    assert.equal(session.describe().attached, true);

    // 第二轮：没有活 agent → resume（参数名是 resumeSessionId）
    const second = await session.ensure();
    assert.equal(second.ok, true);
    assert.equal(resumeCalls.length, 1);
    assert.equal(resumeCalls[0].resumeSessionId, first.sessionId);
    assert.equal(
      second.created,
      true,
      'resume 回来的会话没有 cwd，要另建一条落在工作区目录里的',
    );
    assert.equal(createCalls.length, 2);
    assert.equal(createCalls[1].meta?.cwd, wsDir);
    assert.equal(second.sessionId !== first.sessionId, true);
    assert.deepEqual(detached, [first.sessionId], '作废的老会话要从工作区摘掉');
  } finally {
    if (prevEnv === undefined) delete process.env.DSH_HOME;
    else process.env.DSH_HOME = prevEnv;
  }
});

await test('工作区目录不存在时也能建出会话（cwd 目录会被创建）', async () => {
  const { createCompanionSessionManager } = await import('../src/host/session.mjs');
  const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-laodi-cwd2-'));
  const wsDir = path.join(tmpHome, 'nested', 'companion-ws');
  let createOptions = null;
  const agents = {
    get() {
      return null;
    },
    async create(options) {
      createOptions = options;
      return {
        agent: {
          id: options.sessionId,
          status: 'idle',
          session: { id: options.sessionId, header: { cwd: options.meta?.cwd } },
          inject() {},
          followup() {},
          whenIdle: async () => {},
        },
        async dispose() {},
      };
    },
  };
  const store = {
    companionSessionId: '',
    workspaceId: '',
    workspacePath: wsDir,
    workspaceTitle: '陪玩',
  };
  const prevEnv = process.env.DSH_HOME;
  process.env.DSH_HOME = tmpHome;
  try {
    const session = createCompanionSessionManager({
      getAgents: () => agents,
      getSettings: () => store,
      persistSettings: (patch) => {
        Object.assign(store, patch);
        return store;
      },
      getAgentOptions: () => ({ provider: 'magpie', model: 'deepseek/deepseek-flash' }),
    });
    const ensured = await session.ensure();
    assert.equal(ensured.ok, true);
    assert.equal(createOptions?.meta?.cwd, wsDir);
    assert.ok(fs.existsSync(wsDir), 'cwd 目录必须存在');
    assert.ok(store.workspaceId, '会话要挂工作区，所以工作区 id 得先登记');
  } finally {
    if (prevEnv === undefined) delete process.env.DSH_HOME;
    else process.env.DSH_HOME = prevEnv;
  }
});

await test('设置回传不泄露视觉密钥明文', async () => {
  const { normalizeSettings, publicSettings } = await import('../src/host/settings-store.mjs');
  const settings = normalizeSettings({ visionApiKey: 'sk-secret-value' });
  const shown = publicSettings(settings);
  assert.equal(shown.visionApiKey, '__SET__');
  assert.equal(shown.hasVisionApiKey, true);
  assert.ok(!JSON.stringify(shown).includes('sk-secret-value'));
});

await test('companion tools：screen_look / glossary_lookup 执行与注册', async () => {
  const {
    executeScreenLook,
    executeGlossaryLookup,
    registerCompanionTools,
    TOOL_SCREEN_LOOK,
    TOOL_GLOSSARY_LOOKUP,
  } = await import('../src/host/companion-tools.mjs');

  const screen = await executeScreenLook({
    lookScreen: async () => ({
      ok: true,
      captureOk: true,
      isGame: true,
      windowTitle: 'Persona5Royal',
      gameDate: '04/17',
      timeSlot: 'after-school',
      vision: {
        scene: 'street',
        summary: '涩谷街头',
        suggestion: '去花坛',
        spoilerLevel: 0,
      },
    }),
  });
  assert.equal(screen.ok, true);
  assert.equal(screen.scene, 'street');
  assert.equal(screen.summary, '涩谷街头');
  assert.equal(screen.captureOk, true);

  const hit = executeGlossaryLookup(
    {
      getKnowledge: () => ({
        glossary: [{ id: 'g1', term: 'Persona', brief: '人格面具', spoilerLevel: 0, tags: [] }],
      }),
      getSpoilerTier: () => 'light',
    },
    'Persona',
  );
  assert.equal(hit.found, true);
  assert.equal(hit.term, 'Persona');
  assert.ok(hit.brief.includes('人格面具'));

  const miss = executeGlossaryLookup(
    { getKnowledge: () => ({ glossary: [] }), getSpoilerTier: () => 'light' },
    '不存在的词',
  );
  assert.equal(miss.found, false);

  const registered = [];
  const fakeDefineTool = (spec) => spec;
  const agentCtx = {
    tools: {
      register(def) {
        registered.push(def.name);
      },
    },
  };
  const result = await registerCompanionTools(
    agentCtx,
    () => ({
      lookScreen: async () => ({
        ok: true,
        captureOk: true,
        vision: { scene: 'street', summary: 'x', suggestion: '', spoilerLevel: 0 },
      }),
      getKnowledge: () => ({ glossary: [] }),
      getSpoilerTier: () => 'light',
    }),
    { defineTool: fakeDefineTool },
  );
  assert.equal(result.ok, true);
  assert.deepEqual(registered, [TOOL_SCREEN_LOOK, TOOL_GLOSSARY_LOOKUP]);
});

await test('mock agents create/resume 带 setup 会注册陪玩工具', async () => {
  const { createCompanionSessionManager } = await import('../src/host/session.mjs');
  const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-laodi-tools-'));
  const env = { DSH_HOME: tmpHome };
  const { ensureCompanionWorkspace } = await import('../src/host/workspace.mjs');
  const ws = ensureCompanionWorkspace({
    env,
    workspacePath: path.join(tmpHome, 'ws'),
    workspaceTitle: '陪玩',
  });
  const store = { companionSessionId: '', workspaceId: ws.workspace.id };
  const setups = [];
  const agentsById = new Map();

  function makeAgent(id) {
    const registered = [];
    return {
      id,
      status: 'idle',
      session: { id, header: { cwd: ws.workspace.path } },
      ctx: {
        tools: {
          register(def) {
            registered.push(def.name);
          },
        },
      },
      registered,
      inject() {},
      followup() {},
      whenIdle: async () => {},
    };
  }

  const agents = {
    get(id) {
      return agentsById.get(id) || null;
    },
    async create(opts) {
      const agent = makeAgent(opts.sessionId);
      if (typeof opts.setup === 'function') {
        setups.push('create');
        const setupRet = await opts.setup(agent.ctx, agent);
        // DSH 会把 setup 返回值当成 AgentSetupCommit 调 .commit()；不能返回普通对象
        assert.equal(
          setupRet,
          undefined,
          'setup 不得返回值，否则会出现 setupCommit?.commit is not a function',
        );
      }
      agentsById.set(opts.sessionId, agent);
      return { agent, async dispose() {} };
    },
    async resume() {
      throw new Error('no resume in this test');
    },
  };

  const prevEnv = process.env.DSH_HOME;
  process.env.DSH_HOME = tmpHome;
  try {
    const session = createCompanionSessionManager({
      getAgents: () => agents,
      getSettings: () => store,
      persistSettings: (patch) => {
        Object.assign(store, patch);
        return store;
      },
      getAgentOptions: () => ({ provider: 'magpie', model: 'deepseek/deepseek-flash' }),
      getToolDeps: () => ({
        lookScreen: async () => ({
          ok: true,
          captureOk: true,
          vision: { scene: 'street', summary: '', suggestion: '', spoilerLevel: 0 },
        }),
        getKnowledge: () => ({ glossary: [] }),
        getSpoilerTier: () => 'light',
      }),
    });
    // 注入假 defineTool：通过全局动态 import 路径不可控，改用 installTools 直测
    const agent = makeAgent('manual');
    const { registerCompanionTools } = await import('../src/host/companion-tools.mjs');
    const installed = await registerCompanionTools(
      agent.ctx,
      () => ({
        lookScreen: async () => ({
          ok: true,
          captureOk: true,
          vision: { scene: 'street', summary: '', suggestion: '', spoilerLevel: 0 },
        }),
        getKnowledge: () => ({ glossary: [] }),
      }),
      { defineTool: (spec) => spec },
    );
    assert.equal(installed.ok, true);
    assert.ok(agent.registered.includes('screen_look'));
    assert.ok(agent.registered.includes('glossary_lookup'));

    const ensured = await session.ensure();
    assert.equal(ensured.ok, true);
    assert.ok(setups.includes('create'));
  } finally {
    if (prevEnv === undefined) delete process.env.DSH_HOME;
    else process.env.DSH_HOME = prevEnv;
  }
});

await test('缺少 provider/model 时拒绝 create', async () => {
  const { createCompanionSessionManager } = await import('../src/host/session.mjs');
  const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-laodi-nomodel-'));
  const env = { DSH_HOME: tmpHome };
  const { ensureCompanionWorkspace } = await import('../src/host/workspace.mjs');
  const ws = ensureCompanionWorkspace({
    env,
    workspacePath: path.join(tmpHome, 'ws'),
    workspaceTitle: '陪玩',
  });
  const store = { companionSessionId: '', workspaceId: ws.workspace.id, workspacePath: ws.workspace.path };
  let created = 0;
  const prevEnv = process.env.DSH_HOME;
  process.env.DSH_HOME = tmpHome;
  try {
    const session = createCompanionSessionManager({
      getAgents: () => ({
        get: () => null,
        create: async () => {
          created += 1;
          throw new Error('should not create');
        },
        resume: async () => {
          throw new Error('no resume');
        },
      }),
      getSettings: () => store,
      persistSettings: (patch) => Object.assign(store, patch),
      getAgentOptions: () => ({}),
    });
    const result = await session.ensure();
    assert.equal(result.ok, false);
    assert.equal(result.reason, 'missing-provider-model');
    assert.equal(created, 0);
  } finally {
    if (prevEnv === undefined) delete process.env.DSH_HOME;
    else process.env.DSH_HOME = prevEnv;
  }
});

await test('agents 不可用时 askCompanion 降级 askOnce', async () => {
  const { askCompanion } = await import('../src/ask/ask.mjs');
  const { createCompanionSessionManager } = await import('../src/host/session.mjs');
  const session = createCompanionSessionManager({
    getAgents: () => undefined,
    getSettings: () => ({ companionSessionId: '', workspaceId: '' }),
    persistSettings: (patch) => patch,
  });
  const result = await askCompanion(
    {
      session,
      probe: async () => ({ title: 'Persona5Royal', processName: 'P5R.exe' }),
      capture: async () => ({ buffer: Buffer.from('fake'), mimeType: 'image/png' }),
      vision: {
        describe: async () => ({
          scene: 'street',
          summary: '街',
          suggestion: '走走',
          spoilerLevel: 0,
        }),
      },
      knowledge: { glossary: [{ term: 'Persona', brief: '人格面具', spoilerLevel: 0 }] },
      config: { bubbleMaxChars: 40, policy: { spoilerDefault: 'light' } },
      state: { calibration: { gameDate: '04/17' } },
      bufferToBase64: (buf) => Buffer.from(buf).toString('base64'),
    },
    'Persona',
  );
  assert.equal(result.ok, true);
  assert.equal(result.mode, 'askOnce');
  assert.ok(result.sessionError);
  assert.equal(result.answer.source, 'glossary');
});

await test('桌面闲聊走同一 Session，且不截屏', async () => {
  const { createHost } = await import('../src/index.mjs');
  let captures = 0;
  let followed = null;
  const host = createHost({
    config: loadConfig({ env: {} }),
    logger: silentLogger,
    electron: null,
    dataDir: fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-laodi-desktop-ask-')),
    probe: async () => ({ title: 'Google Chrome', processName: 'chrome' }),
    capture: async () => {
      captures += 1;
      throw new Error('桌面不该截屏');
    },
    vision: {
      describe: async () => {
        throw new Error('桌面不该调用视觉');
      },
    },
    session: {
      followupAsk: async (question, context) => {
        followed = { question, context };
        return { ok: true, mode: 'session', reply: '桌面上随便聊聊', session: { id: 'pet-session' } };
      },
      describe() {
        return { id: 'pet-session' };
      },
    },
  });
  assert.equal(host.overlay.handleRendererMessage('dsh-laodi:chat', { text: '  ' }), false);
  const accepted = host.overlay.handleRendererMessage('dsh-laodi:chat', { text: '在吗' });
  assert.equal(accepted, true);
  const result = await host.ask('在吗', { source: 'pet' });
  assert.equal(result.ok, true);
  assert.equal(result.mode, 'session');
  assert.equal(result.captureOk, false);
  assert.equal(captures, 0);
  assert.equal(followed.question, '在吗');
  assert.equal(followed.context.screenText, '');
  assert.equal(host.overlay.lastBubble, '桌面上随便聊聊');

  const looked = await host.lookScreen();
  assert.equal(looked.ok, false);
  assert.equal(looked.reason, 'desktop-no-screen-look');
  assert.equal(captures, 0);
});

await test('游戏前台提问仍会识屏', async () => {
  let captures = 0;
  let screenText = '';
  const host = createHost({
    config: loadConfig({ env: {} }),
    logger: silentLogger,
    electron: null,
    dataDir: fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-laodi-game-ask-')),
    probe: async () => ({
      title: 'Persona 5 Royal',
      processName: 'Persona5Royal',
      rect: { left: 0, top: 0, width: 1280, height: 720 },
    }),
    capture: async () => {
      captures += 1;
      return { buffer: Buffer.from('fake'), mimeType: 'image/png' };
    },
    vision: {
      describe: async () => ({
        scene: 'street',
        summary: '涩谷街头',
        suggestion: '去花坛看看',
        spoilerLevel: 0,
      }),
    },
    session: {
      followupAsk: async (_question, context) => {
        screenText = context.screenText;
        return { ok: true, mode: 'session', reply: '先去花坛', session: { id: 'pet-session' } };
      },
      describe() {
        return { id: 'pet-session' };
      },
    },
  });
  const result = await host.ask('现在干什么');
  assert.equal(result.mode, 'session');
  assert.equal(captures, 1);
  assert.match(screenText, /涩谷/);
  assert.equal(host.overlay.lastBubble, '先去花坛');
});


await test('「确保 Session」开场揭晓空白会话，resume 已揭晓时不再打招呼', async () => {
  const { createCompanionSessionManager, SESSION_UNVEIL_PROMPT } = await import('../src/host/session.mjs');
  const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-laodi-unveil-'));
  const followups = [];
  const agentsById = new Map();
  function makeAgent(id, cwd) {
    return {
      id,
      status: 'idle',
      session: { id, header: { cwd } },
      inject() {},
      followup(msg) {
        followups.push(msg);
        this.lastAssistantText = '嗨';
      },
      whenIdle: async () => {},
    };
  }
  const agents = {
    get(id) {
      return agentsById.get(id) || null;
    },
    async create({ sessionId, meta }) {
      const agent = makeAgent(sessionId, meta?.cwd || tmpHome);
      agentsById.set(sessionId, agent);
      return { agent, async dispose() { agentsById.delete(sessionId); } };
    },
    async resume({ resumeSessionId, sessionId }) {
      const id = resumeSessionId || sessionId;
      const agent = agentsById.get(id) || makeAgent(id, tmpHome);
      agentsById.set(id, agent);
      return { agent, async dispose() {} };
    },
  };
  const store = { companionSessionId: '', companionSessionRevealedId: '', workspacePath: tmpHome, workspaceTitle: '陪玩' };
  const prevEnv = process.env.DSH_HOME;
  process.env.DSH_HOME = tmpHome;
  try {
    const session = createCompanionSessionManager({
      getAgents: () => agents,
      getSettings: () => store,
      persistSettings: (patch) => {
        Object.assign(store, patch);
        return store;
      },
      getAgentOptions: () => ({ provider: 'magpie', model: 'deepseek/deepseek-flash' }),
    });
    const first = await session.ensure();
    assert.equal(first.ok, true);
    assert.equal(followups.length, 0, 'ensure() 本身不发开场，避免 /ask 顺便打招呼');
    const unveiled = await session.unveil();
    assert.equal(unveiled.ok, true);
    assert.equal(unveiled.unveiled, true);
    assert.equal(followups.length, 1);
    assert.ok(String(followups[0]?.content?.[0]?.text || '').includes('P5R'));
    assert.equal(followups[0]?.role, 'user', '开场必须带 role=user，否则 DSH 重启后无法加载会话');
    assert.equal(store.companionSessionRevealedId, first.sessionId);
    assert.equal(session.describe().revealed, true);
    assert.equal(SESSION_UNVEIL_PROMPT.includes('P5R'), true);

    const again = await session.unveil();
    assert.equal(again.skipped, true);
    assert.equal(followups.length, 1, '已揭晓后不再重复开场');

    // followupAsk 成功后也应记下 revealed（提问同样能揭晓）
    store.companionSessionRevealedId = '';
    const asked = await session.followupAsk('还在吗');
    assert.equal(asked.ok, true);
    assert.equal(store.companionSessionRevealedId, first.sessionId);
  } finally {
    if (prevEnv === undefined) delete process.env.DSH_HOME;
    else process.env.DSH_HOME = prevEnv;
  }
});

console.log('companion workspace:');

await test('ensureCompanionWorkspace 会登记到 storages/workspace.json', async () => {
  const { ensureCompanionWorkspace, describeCompanionWorkspace, listWorkspaces } =
    await import('../src/host/workspace.mjs');
  const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-laodi-ws-'));
  const wsDir = path.join(tmpHome, 'companion-ws');
  const env = { DSH_HOME: tmpHome };
  const first = ensureCompanionWorkspace({
    env,
    workspacePath: wsDir,
    workspaceTitle: '陪玩',
    setAsDefault: true,
    personaPresetId: 'laodi',
    personaPluginId: 'dsh-companion',
  });
  assert.equal(first.ok, true);
  assert.equal(first.created, true);
  assert.ok(first.workspace.id);
  assert.equal(first.workspace.title, '陪玩');
  assert.equal(first.workspace.isDefault, true);
  assert.equal(first.persona?.id, 'laodi');
  assert.ok(fs.existsSync(path.join(wsDir, '.dsh-laodi-workspace.json')));
  assert.ok(fs.existsSync(path.join(wsDir, 'persona', 'SOUL.md')));
  assert.ok(fs.readFileSync(path.join(wsDir, 'persona', 'SOUL.md'), 'utf8').includes('老弟'));
  assert.ok(!fs.readFileSync(path.join(wsDir, 'README.md'), 'utf8').includes('P5R'));

  const listed = listWorkspaces(env);
  assert.equal(listed.items.length, 1);
  assert.equal(listed.items[0].id, first.workspace.id);

  const second = ensureCompanionWorkspace({
    env,
    workspacePath: wsDir,
    workspaceTitle: '陪玩',
    workspaceId: first.workspace.id,
  });
  assert.equal(second.created, false);
  assert.equal(second.workspace.id, first.workspace.id);

  const desc = describeCompanionWorkspace(
    {
      workspaceId: first.workspace.id,
      workspacePath: wsDir,
      workspaceTitle: '陪玩',
      personaPluginId: 'dsh-companion',
    },
    env,
  );
  assert.equal(desc.registered, true);
  assert.equal(desc.directoryExists, true);
  assert.equal(desc.markerExists, true);
});

console.log('repo hygiene:');

await test('仓库里没有残留截图文件', () => {
  const stack = [PROJECT_ROOT];
  const found = [];
  while (stack.length > 0) {
    const dir = stack.pop();
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === 'node_modules' || entry.name === '.git') continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) stack.push(full);
      else if (/\.(png|jpe?g)$/i.test(entry.name)) found.push(full);
    }
  }
  assert.deepEqual(found, []);
});

console.log('policy:');
const policyResult = await runPolicyTests();
// runPolicyTests 可能返回 {passed, failed}，也可能只返回 boolean。
if (policyResult && typeof policyResult === 'object') {
  passed += Number(policyResult.passed ?? 0);
  failed += Number(policyResult.failed ?? 0);
} else if (policyResult === false) {
  failed += 1;
}

console.log('');
console.log(`smoke: ${passed} passed, ${failed} failed`);
if (failed > 0) {
  console.error('SMOKE FAILED');
  process.exitCode = 1;
} else {
  console.log('SMOKE OK');
}
