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

await test('截图目标目录不得落在项目内', () => {
  assert.equal(isInsideProject(path.join(PROJECT_ROOT, 'shot.png')), true);
  assert.equal(isInsideProject(path.join('C:\\Temp', 'shot.png')), false);
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
