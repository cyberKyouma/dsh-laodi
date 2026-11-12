#!/usr/bin/env node
/**
 * dsh-laodi 宿主。
 *
 * 桌宠：平时停在桌面，可拖、可闲聊；P5R 在前台时同一形象跟到游戏窗口。
 * 识屏循环只在游戏前台跑。桌面阶段不启动周期识屏，桌面闲聊也不截屏。
 *
 * 游戏前台一轮：
 *   1. 截屏（只在内存）-> 视觉模型描述画面
 *   2. policy/speak 判断要不要说
 *   3. 要说 -> 形象旁气泡（<= 40 字）
 *
 * 用法：
 *   node src/index.mjs
 *   node src/index.mjs --mock --once
 *   node src/index.mjs --mock --calibrate=04/17 --ask=Persona
 *   node src/index.mjs --mock --ask-once=Persona
 *   node src/index.mjs --probe
 */

import process from 'node:process';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { loadConfig, resolveDataDir } from './config.mjs';
import { probeForegroundWindow, isGameWindow } from './capture/window.mjs';
import { captureWindowToBuffer, bufferToBase64 } from './capture/screenshot.mjs';
import { createVisionClient } from './vision/client.mjs';
import { createOverlayController, loadElectronModule } from './overlay/overlay.mjs';
import { resolvePetMode } from './overlay/placement.mjs';
import { loadKnowledgePack } from './data/knowledge.mjs';
import { createReminderStore } from './reminders/store.mjs';
import { createFavoritesStore } from './favorites/store.mjs';
import { askCompanion, askOnce } from './ask/ask.mjs';
import {
  SCENE,
  DEFAULT_ALLOWED_SCENE_KEYWORDS,
  detectScene,
  evaluateSpeak,
  buildBubble,
  pickSuggestion,
  rememberSuggestion,
  selectByDate,
  normalizeGameDate,
} from './policy/speak.mjs';

/**
 * 创建宿主实例。
 */
export function createHost(options = {}) {
  const {
    config = loadConfig(),
    vision = createVisionClient(config),
    logger = console,
    clock = () => Date.now() / 1000,
    rng = Math.random,
    overlay: overlayOption = null,
    capture = captureWindowToBuffer,
    probe = probeForegroundWindow,
    knowledge = null,
    dataDir = resolveDataDir(),
    reminders = null,
    favorites = null,
    /** createCompanionSessionManager() 返回值；CLI 无 agents 时可空 */
    session = null,
    electron = options.electron !== undefined
      ? options.electron
      : options.overlay
        ? null
        : loadElectronModule(),
    petConflict = null,
  } = options;

  const state = {
    running: false,
    tick: 0,
    lastSpeakAtSec: null,
    recentSuggestions: [],
    lastWindow: null,
    lastVision: null,
    lastAsk: null,
    calibration: { gameDate: '', timeSlot: '' },
    /** desktop：不跑周期识屏。game：才启动识屏循环。 */
    petMode: 'desktop',
    screenLoopRunning: false,
    screenLoopStop: true,
  };

  let askImpl = async () => ({ ok: false, reason: 'not-ready' });
  const overlay =
    overlayOption ??
    createOverlayController({
      config,
      logger,
      electron,
      petConflict,
      onChat: (text) => askImpl(text, { source: 'pet' }),
    });

  const waits = { placement: null, screen: null };
  let screenLoopActive = false;
  let knowledgePack = knowledge;

  const reminderStore =
    reminders ??
    createReminderStore({
      file: path.join(dataDir, 'reminders.json'),
      loadPack: () => getPack(),
      spoilerTier: config.policy?.spoilerDefault ?? 'light',
      clock,
    });

  const favoritesStore =
    favorites ??
    createFavoritesStore({
      file: path.join(dataDir, 'favorites.json'),
      clock,
    });

  function getPack() {
    if (!knowledgePack) {
      try {
        knowledgePack = loadKnowledgePack();
      } catch {
        knowledgePack = { calendar: [], 'shop-items': [], glossary: [] };
      }
    }
    return knowledgePack;
  }

  function policyCooldownSec() {
    const value = Number(config.policy?.cooldownSec);
    return Number.isFinite(value) && value >= 0 ? value : 1800;
  }

  function pruneRecentSuggestions(nowSec) {
    const ttl = policyCooldownSec();
    state.recentSuggestions = state.recentSuggestions.filter(
      (entry) => nowSec - Number(entry?.atSec ?? 0) < ttl,
    );
  }

  function pushOverlayLists() {
    overlay.setReminders?.(reminderStore.list());
    overlay.setFavorites?.(favoritesStore.list());
  }

  function placementIntervalMs() {
    const value = Number(config.overlay?.placementIntervalMs);
    if (!Number.isFinite(value)) return 800;
    return Math.min(5000, Math.max(200, value));
  }

  function wait(slot, ms) {
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        if (waits[slot]?.resolve === resolve) waits[slot] = null;
        resolve();
      }, ms);
      waits[slot] = { timer, resolve };
    });
  }

  function cancelWait(slot) {
    const pending = waits[slot];
    if (!pending) return;
    clearTimeout(pending.timer);
    waits[slot] = null;
    pending.resolve();
  }

  function collectCandidates(visionResult) {
    const candidates = [];
    if (visionResult?.suggestion) {
      candidates.push({
        text: String(visionResult.suggestion),
        spoilerLevel: Number(visionResult.spoilerLevel ?? 0),
        id: 'vision',
        source: 'vision',
      });
    }

    const pack = getPack();
    const today = state.calibration.gameDate;
    if (today) {
      const todayItems = [
        ...selectByDate(pack.calendar ?? [], today),
        ...selectByDate(pack['shop-items'] ?? [], today),
      ];
      for (const item of todayItems) {
        const level = Number(item?.spoilerLevel ?? 0);
        const title = item?.title ?? item?.name;
        if (title) {
          candidates.push({
            text: String(title),
            spoilerLevel: level,
            id: item?.id,
            source: 'knowledge',
          });
        }
        if (item?.worthBuyNote) {
          candidates.push({
            text: `${item?.item ?? item?.name ?? ''}：${item.worthBuyNote}`,
            spoilerLevel: level,
            id: item?.id,
            source: 'knowledge',
          });
        }
      }
    }
    return candidates;
  }

  function resolveScene(visionResult) {
    const options = {
      mutedKeywords: config.policy?.mutedSceneKeywords ?? [],
      allowedKeywords: DEFAULT_ALLOWED_SCENE_KEYWORDS,
    };
    const token = String(visionResult?.scene ?? '').trim();
    if (token && token !== 'unknown') {
      const scene = detectScene(token, options);
      return scene === SCENE.MUTED ? SCENE.MUTED : SCENE.ALLOWED;
    }
    return detectScene(visionResult?.summary ?? '', options);
  }

  async function tick() {
    state.tick += 1;
    const nowSec = clock();
    pruneRecentSuggestions(nowSec);

    const windowInfo = await probe();
    state.lastWindow = windowInfo;

    if (!isGameWindow(windowInfo, config.gameWindow)) {
      logger.info?.(
        `[host] tick ${state.tick}：前台不是 P5R（${
          windowInfo?.title || '未知窗口'
        }），跳过识屏`,
      );
      return { skipped: true, reason: 'not-foreground' };
    }

    let shot;
    try {
      shot = await capture(windowInfo);
    } catch (err) {
      logger.warn?.(
        `[host] 截图失败：${err instanceof Error ? err.message : String(err)}`,
      );
      return { skipped: true, reason: 'capture-failed' };
    }

    const imageBase64 = bufferToBase64(shot.buffer);
    let visionResult;
    try {
      visionResult = await vision.describe({
        imageBase64,
        mimeType: shot.mimeType,
      });
    } catch (err) {
      logger.warn?.(
        `[host] 视觉调用失败：${err instanceof Error ? err.message : String(err)}`,
      );
      return { skipped: true, reason: 'vision-failed' };
    }
    state.lastVision = visionResult;

    const scene = resolveScene(visionResult);
    const candidates = collectCandidates(visionResult);
    const candidate = pickSuggestion(candidates, {
      rng,
      spoilerTier: config.policy?.spoilerDefault ?? 'light',
    });
    const candidateText =
      typeof candidate === 'string'
        ? candidate
        : (candidate?.text ??
          candidate?.title ??
          candidate?.name ??
          candidate?.brief ??
          '');

    const decision = evaluateSpeak({
      nowSec,
      lastSpeakAtSec: state.lastSpeakAtSec,
      scene,
      suggestion: candidateText,
      recentSuggestions: state.recentSuggestions,
      probability: config.speakProbability,
      minGapSec: config.minSpeakGapSec,
      cooldownSec: policyCooldownSec(),
      rng,
    });

    if (!decision.speak) {
      logger.info?.(`[host] 不开口：${decision.reason}`);
      return { spoke: false, reason: decision.reason, scene };
    }

    const text = buildBubble(candidateText, config.bubbleMaxChars);
    overlay.speak(text, { at: nowSec });
    state.lastSpeakAtSec = nowSec;
    state.recentSuggestions = rememberSuggestion(
      state.recentSuggestions,
      candidateText,
      nowSec,
    );
    logger.info?.(`[host] 开口：${text}`);
    return { spoke: true, text, scene };
  }

  async function syncPlacement() {
    let windowInfo = null;
    try {
      windowInfo = await probe();
    } catch (err) {
      logger.warn?.(
        `[host] 前台探测失败：${err instanceof Error ? err.message : String(err)}`,
      );
    }
    if (!state.running) return { mode: state.petMode, windowInfo };
    state.lastWindow = windowInfo;
    const mode = resolvePetMode(windowInfo, config.gameWindow);
    if (state.petMode !== mode) {
      logger.info?.(
        mode === 'game'
          ? '[host] 进入 P5R，形象跟到游戏窗口'
          : '[host] 离开游戏，形象回到桌面',
      );
    }
    state.petMode = mode;
    overlay.place?.({
      mode,
      gameRect: mode === 'game' ? windowInfo?.rect : null,
    });
    if (mode === 'game') {
      state.screenLoopStop = false;
      ensureScreenLoop();
    } else {
      state.screenLoopStop = true;
      cancelWait('screen');
    }
    return { mode, windowInfo };
  }

  async function runScreenLoop() {
    while (state.running && !state.screenLoopStop && state.petMode === 'game') {
      try {
        await tick();
      } catch (err) {
        logger.error?.(
          `[host] 本轮异常：${err instanceof Error ? err.message : String(err)}`,
        );
      }
      if (!state.running || state.screenLoopStop || state.petMode !== 'game') break;
      await wait('screen', Math.max(0, Number(config.captureIntervalSec) * 1000));
    }
  }

  function ensureScreenLoop() {
    if (screenLoopActive || !state.running) return;
    screenLoopActive = true;
    state.screenLoopRunning = true;
    state.screenLoopStop = false;
    void (async () => {
      try {
        await runScreenLoop();
      } finally {
        screenLoopActive = false;
        state.screenLoopRunning = false;
      }
    })();
  }

  async function start() {
    if (state.running) return state;
    state.running = true;
    state.screenLoopStop = true;
    logger.info?.(
      `[host] 启动：桌宠跟随 ${placementIntervalMs()}ms / 识屏间隔 ${config.captureIntervalSec}s（仅游戏前台） / 开口间隔 ${config.minSpeakGapSec}s / 概率 ${config.speakProbability}`,
    );
    logger.info?.("[host] start: showing overlay");
    if (config.overlay?.enabled !== false) overlay.show?.();
    logger.info?.("[host] start: overlay shown");
    pushOverlayLists();
    logger.info?.("[host] start: entering placement loop");

    while (state.running) {
      try {
        await syncPlacement();
      } catch (err) {
        logger.error?.(
          `[host] 跟随异常：${err instanceof Error ? err.message : String(err)}`,
        );
      }
      if (!state.running) break;
      await wait('placement', placementIntervalMs());
    }
    state.screenLoopStop = true;
    cancelWait('screen');
    logger.info?.('[host] 已停止');
    return state;
  }

  async function stop() {
    state.running = false;
    state.screenLoopStop = true;
    cancelWait('placement');
    cancelWait('screen');
    overlay.hide?.();
    overlay.destroy?.();
    return state;
  }

  async function runOnce() {
    return tick();
  }

  function setCalibration(next = {}) {
    state.calibration = {
      gameDate: normalizeGameDate(next.gameDate ?? state.calibration.gameDate),
      timeSlot: next.timeSlot ?? state.calibration.timeSlot,
    };
    overlay.setCalibration?.(state.calibration);
    if (state.calibration.gameDate) {
      reminderStore.refresh(state.calibration.gameDate);
      pushOverlayLists();
    }
    return state.calibration;
  }

  /**
   * 识一屏（screen_look 工具）。
   * 桌面阶段直接拒绝，不截屏。游戏在前台才截，并标明 isGame。
   */
  async function lookScreen() {
    let windowInfo = null;
    try {
      windowInfo = await probe();
    } catch (err) {
      return {
        ok: false,
        reason: 'probe-failed',
        captureOk: false,
        isGame: false,
        windowTitle: '',
        gameDate: state.calibration.gameDate,
        timeSlot: state.calibration.timeSlot,
        vision: {
          scene: 'unknown',
          summary: '',
          suggestion: '',
          spoilerLevel: 0,
          error: err instanceof Error ? err.message : String(err),
        },
      };
    }

    const isGame = isGameWindow(windowInfo, config.gameWindow);
    state.lastWindow = windowInfo;
    state.petMode = isGame ? 'game' : 'desktop';
    const windowTitle = String(windowInfo?.title || '');
    if (!isGame) {
      return {
        ok: false,
        reason: 'desktop-no-screen-look',
        captureOk: false,
        isGame: false,
        windowTitle,
        gameDate: state.calibration.gameDate,
        timeSlot: state.calibration.timeSlot,
        vision: {
          scene: 'unknown',
          summary: '桌面阶段不识屏',
          suggestion: '',
          spoilerLevel: 0,
        },
        message: '桌面阶段不识屏',
      };
    }
    let visionResult = null;
    let captureOk = false;

    try {
      if (windowInfo && capture) {
        const shot = await capture(windowInfo);
        const imageBase64 = bufferToBase64(shot.buffer);
        visionResult = await vision.describe({
          imageBase64,
          mimeType: shot.mimeType ?? 'image/png',
        });
        captureOk = true;
      } else if (vision?.describe) {
        visionResult = await vision.describe({
          imageBase64: 'AA==',
          mimeType: 'image/png',
        });
      }
    } catch (err) {
      visionResult = {
        scene: 'unknown',
        summary: '',
        suggestion: '',
        spoilerLevel: 0,
        error: err instanceof Error ? err.message : String(err),
      };
    }

    if (visionResult) state.lastVision = visionResult;

    return {
      ok: true,
      reason: captureOk ? '' : 'no-capture',
      captureOk,
      isGame,
      windowTitle,
      gameDate: state.calibration.gameDate,
      timeSlot: state.calibration.timeSlot,
      vision: visionResult || {
        scene: 'unknown',
        summary: '',
        suggestion: '',
        spoilerLevel: 0,
      },
    };
  }

  async function confirmPetMode() {
    try {
      const info = await probe();
      if (info) state.lastWindow = info;
      const mode = resolvePetMode(info, config.gameWindow);
      state.petMode = mode;
      overlay.place?.({
        mode,
        gameRect: mode === 'game' ? info?.rect : null,
      });
      return mode;
    } catch {
      return state.petMode || 'desktop';
    }
  }

  async function ask(question, askOptions = {}) {
    const forceOnce = Boolean(askOptions.forceAskOnce);
    let skipScreenLook = askOptions.skipScreenLook === true;
    if (!forceOnce && askOptions.forceScreenLook !== true && askOptions.skipScreenLook !== true) {
      if (askOptions.source === 'pet') {
        skipScreenLook = (overlay.mode || state.petMode) !== 'game';
      }
      if (!skipScreenLook) {
        const mode = await confirmPetMode();
        skipScreenLook = mode !== 'game';
      }
    }
    if (askOptions.forceScreenLook === true) skipScreenLook = false;

    const askCtx = {
      capture,
      probe,
      vision,
      knowledge: getPack(),
      config,
      state,
      overlay,
      favorites: favoritesStore,
      bufferToBase64,
      session,
    };
    const result = forceOnce
      ? await askOnce(askCtx, question)
      : await askCompanion(askCtx, question, { ...askOptions, skipScreenLook });
    state.lastAsk = result;
    pushOverlayLists();
    logger.info?.(
      result.ok
        ? `[host] 问答(${result.mode || 'askOnce'})：${result.answer?.bubble}`
        : `[host] 问答失败：${result.reason}`,
    );
    return result;
  }

  askImpl = ask;

  function petStatus() {
    const overlayStatus = overlay.status?.() || {};
    return {
      ...overlayStatus,
      mode: overlayStatus.mode || state.petMode,
      screenLoop: Boolean(state.screenLoopRunning),
    };
  }

  return {
    state,
    config,
    vision,
    overlay,
    reminders: reminderStore,
    favorites: favoritesStore,
    session,
    tick,
    start,
    stop,
    runOnce,
    setCalibration,
    lookScreen,
    ask,
    petStatus,
    getKnowledge: getPack,
    refreshReminders() {
      const list = reminderStore.refresh(state.calibration.gameDate);
      pushOverlayLists();
      return list;
    },
  };
}

/** 解析命令行参数 */
export function parseArgs(argv = process.argv.slice(2)) {
  const flags = {
    mock: false,
    once: false,
    probe: false,
    overlay: true,
    intervalSec: null,
    calibrate: null,
    ask: null,
    askOnce: null,
    listFavorites: false,
  };
  for (const arg of argv) {
    if (arg === '--mock') flags.mock = true;
    else if (arg === '--once') flags.once = true;
    else if (arg === '--probe') flags.probe = true;
    else if (arg === '--no-overlay') flags.overlay = false;
    else if (arg === '--list-favorites') flags.listFavorites = true;
    else if (arg.startsWith('--interval=')) {
      flags.intervalSec = Number(arg.slice('--interval='.length));
    } else if (arg.startsWith('--calibrate=')) {
      flags.calibrate = arg.slice('--calibrate='.length);
    } else if (arg.startsWith('--ask-once=')) {
      flags.askOnce = arg.slice('--ask-once='.length);
    } else if (arg.startsWith('--ask=')) {
      flags.ask = arg.slice('--ask='.length);
    }
  }
  return flags;
}

/** CLI 入口 */
export async function main(argv = process.argv.slice(2)) {
  const flags = parseArgs(argv);
  const config = loadConfig();

  if (flags.mock) config.vision.mock = true;
  if (flags.overlay === false) config.overlay.enabled = false;
  if (Number.isFinite(flags.intervalSec) && flags.intervalSec > 0) {
    config.captureIntervalSec = flags.intervalSec;
  }

  if (flags.probe) {
    const win = await probeForegroundWindow();
    console.log(
      JSON.stringify(
        {
          foreground: win,
          isGame: isGameWindow(win, config.gameWindow),
        },
        null,
        2,
      ),
    );
    return 0;
  }

  const host = createHost({ config });

  if (flags.calibrate) {
    const cal = host.setCalibration({ gameDate: flags.calibrate, timeSlot: 'after-school' });
    console.log(JSON.stringify({ calibration: cal, reminders: host.reminders.list() }, null, 2));
  }

  if (flags.askOnce) {
    const result = await host.ask(flags.askOnce, { forceAskOnce: true });
    console.log(JSON.stringify(result, null, 2));
    await host.stop();
    return result.ok ? 0 : 1;
  }

  if (flags.ask) {
    // CLI 无 Cordis agents 时 askCompanion 会自动降级 askOnce
    const result = await host.ask(flags.ask);
    console.log(JSON.stringify(result, null, 2));
    await host.stop();
    return result.ok ? 0 : 1;
  }

  if (flags.listFavorites) {
    console.log(JSON.stringify(host.favorites.list(), null, 2));
    await host.stop();
    return 0;
  }

  if (flags.once) {
    const result = await host.runOnce();
    console.log(JSON.stringify(result, null, 2));
    await host.stop();
    return 0;
  }

  // 仅标定/列提醒后退出
  if (flags.calibrate) {
    await host.stop();
    return 0;
  }

  const shutdown = async () => {
    await host.stop();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  await host.start();
  return 0;
}

const invokedDirectly =
  Boolean(process.argv[1]) && import.meta.url === pathToFileURL(process.argv[1]).href;

if (invokedDirectly) {
  main().catch((err) => {
    console.error(err);
    process.exitCode = 1;
  });
}

export default { createHost, main, parseArgs };
