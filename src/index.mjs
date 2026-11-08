#!/usr/bin/env node
/**
 * dsh-laodi 宿主主循环（初版）。
 *
 * 流程：
 *   1. 探测前台窗口；不是 P5R -> 本轮跳过（不识屏、不开口）
 *   2. 是 P5R -> 截屏（只在内存）-> 视觉模型描述画面
 *   3. 交给 policy/speak 判断「这一轮要不要说」
 *   4. 要说 -> 冒到悬浮窗气泡（<= 40 字）
 *   5. 标定日期后刷新今日提醒；问答强制识一屏并可收藏
 *
 * 用法：
 *   node src/index.mjs
 *   node src/index.mjs --mock --once
 *   node src/index.mjs --mock --calibrate=04/17 --ask=Persona
 *   node src/index.mjs --probe
 */

import process from 'node:process';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { loadConfig, resolveDataDir } from './config.mjs';
import { probeForegroundWindow, isGameWindow } from './capture/window.mjs';
import { captureWindowToBuffer, bufferToBase64 } from './capture/screenshot.mjs';
import { createVisionClient } from './vision/client.mjs';
import { createOverlayController } from './overlay/overlay.mjs';
import { loadKnowledgePack } from './data/knowledge.mjs';
import { createReminderStore } from './reminders/store.mjs';
import { createFavoritesStore } from './favorites/store.mjs';
import { askOnce } from './ask/ask.mjs';
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
    overlay = createOverlayController({ config, logger }),
    capture = captureWindowToBuffer,
    probe = probeForegroundWindow,
    knowledge = null,
    dataDir = resolveDataDir(),
    reminders = null,
    favorites = null,
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
  };

  let wake = null;
  let timer = null;
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

  function sleep(ms) {
    return new Promise((resolve) => {
      wake = resolve;
      timer = setTimeout(() => {
        wake = null;
        timer = null;
        resolve();
      }, ms);
    });
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

  async function start() {
    if (state.running) return state;
    state.running = true;
    logger.info?.(
      `[host] 启动：识屏间隔 ${config.captureIntervalSec}s / 开口间隔 ${config.minSpeakGapSec}s / 概率 ${config.speakProbability}`,
    );
    if (config.overlay?.enabled) overlay.show?.();
    pushOverlayLists();

    while (state.running) {
      try {
        await tick();
      } catch (err) {
        logger.error?.(
          `[host] 本轮异常：${err instanceof Error ? err.message : String(err)}`,
        );
      }
      if (!state.running) break;
      await sleep(config.captureIntervalSec * 1000);
    }
    logger.info?.('[host] 已停止');
    return state;
  }

  async function stop() {
    state.running = false;
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
    if (wake) {
      const resolve = wake;
      wake = null;
      resolve();
    }
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

  async function ask(question) {
    const result = await askOnce(
      {
        capture,
        probe,
        vision,
        knowledge: getPack(),
        config,
        state,
        overlay,
        favorites: favoritesStore,
        bufferToBase64,
      },
      question,
    );
    state.lastAsk = result;
    pushOverlayLists();
    logger.info?.(
      result.ok
        ? `[host] 问答：${result.answer?.bubble}`
        : `[host] 问答失败：${result.reason}`,
    );
    return result;
  }

  return {
    state,
    config,
    vision,
    overlay,
    reminders: reminderStore,
    favorites: favoritesStore,
    tick,
    start,
    stop,
    runOnce,
    setCalibration,
    ask,
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

  if (flags.ask) {
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
