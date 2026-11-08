#!/usr/bin/env node
/**
 * policy/speak 纯函数的最小单测（不依赖游戏、不依赖网络）。
 *
 *   node scripts/smoke-policy.mjs
 */

import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';

import {
  SCENE,
  detectScene,
  isMutedScene,
  buildBubble,
  suggestionKey,
  isSuggestionCoolingDown,
  evaluateSpeak,
  pickSuggestion,
  filterBySpoiler,
  normalizeGameDate,
  selectByDate,
  rememberSuggestion,
} from '../src/policy/speak.mjs';

/** 跑一组用例，返回 {passed, failed} */
export function runPolicyTests() {
  let passed = 0;
  let failed = 0;

  const test = (name, fn) => {
    try {
      fn();
      passed += 1;
      console.log(`  PASS  ${name}`);
    } catch (err) {
      failed += 1;
      console.error(`  FAIL  ${name}`);
      console.error(`        ${err instanceof Error ? err.message : String(err)}`);
    }
  };

  console.log('policy/speak:');

  test('静音场景：中文「对话」', () => {
    assert.equal(detectScene('现在是剧情对话'), SCENE.MUTED);
    assert.equal(isMutedScene('现在是剧情对话'), true);
  });

  test('静音场景：英文 battle / menu / shop', () => {
    assert.equal(detectScene('battle'), SCENE.MUTED);
    assert.equal(detectScene('main menu'), SCENE.MUTED);
    assert.equal(detectScene('shop checkout'), SCENE.MUTED);
  });

  test('安全场景：街道', () => {
    assert.equal(detectScene('皇家大道的街道'), SCENE.ALLOWED);
  });

  test('认不准：unknown', () => {
    assert.equal(detectScene('一些看不懂的东西'), SCENE.UNKNOWN);
    assert.equal(detectScene(''), SCENE.UNKNOWN);
  });

  test('气泡截断到 40 字以内', () => {
    const long = '老'.repeat(80);
    const bubble = buildBubble(long, 40);
    assert.equal(Array.from(bubble).length, 40);
    assert.ok(bubble.endsWith('…'));
  });

  test('气泡不超长时原样返回', () => {
    assert.equal(buildBubble('今天先去花坛', 40), '今天先去花坛');
    assert.equal(buildBubble('  多余   空白  ', 40), '多余 空白');
  });

  test('冷却键忽略大小写与空白', () => {
    assert.equal(suggestionKey('Go  Home'), 'go home');
    assert.equal(suggestionKey('Go Home'), 'go home');
  });

  test('同建议在 30min 内算冷却中', () => {
    const recent = [{ key: '去花坛', atSec: 1000 }];
    assert.equal(isSuggestionCoolingDown('去花坛', recent, 1800, 1500), true);
    assert.equal(isSuggestionCoolingDown('去花坛', recent, 1800, 3000), false);
    assert.equal(isSuggestionCoolingDown('别的事', recent, 1800, 1500), false);
  });

  test('对话中不主动开口', () => {
    const decision = evaluateSpeak({
      nowSec: 10000,
      scene: SCENE.MUTED,
      suggestion: '去花坛看看',
      rng: () => 0,
    });
    assert.equal(decision.speak, false);
    assert.equal(decision.reason, 'scene-muted');
  });

  test('没有候选建议时不开口', () => {
    const decision = evaluateSpeak({ nowSec: 10000, suggestion: '   ' });
    assert.equal(decision.speak, false);
    assert.equal(decision.reason, 'no-candidate');
  });

  test('距上次开口不足 3min 不开口', () => {
    const decision = evaluateSpeak({
      nowSec: 100,
      lastSpeakAtSec: 0,
      suggestion: '去花坛看看',
      rng: () => 0,
    });
    assert.equal(decision.speak, false);
    assert.equal(decision.reason, 'gap-not-elapsed');
    assert.ok(decision.waitSec > 0);
  });

  test('距上次开口超过 3min 才继续判断', () => {
    const decision = evaluateSpeak({
      nowSec: 200,
      lastSpeakAtSec: 0,
      suggestion: '去花坛看看',
      rng: () => 0,
    });
    assert.equal(decision.speak, true);
  });

  test('同建议冷却期内不重复', () => {
    const decision = evaluateSpeak({
      nowSec: 1200,
      suggestion: '去花坛看看',
      recentSuggestions: [{ key: '去花坛看看', atSec: 1000 }],
      rng: () => 0,
    });
    assert.equal(decision.speak, false);
    assert.equal(decision.reason, 'cooldown');
  });

  test('概率闸门：30% 上限', () => {
    const hit = evaluateSpeak({ nowSec: 10000, suggestion: '试试看', rng: () => 0.29 });
    assert.equal(hit.speak, true);
    const miss = evaluateSpeak({ nowSec: 10000, suggestion: '试试看', rng: () => 0.31 });
    assert.equal(miss.speak, false);
    assert.equal(miss.reason, 'probability-roll');
  });

  test('剧透档过滤：light 挡掉 2/3 级条目', () => {
    const items = [
      { id: 'a', spoilerLevel: 0 },
      { id: 'b', spoilerLevel: 2 },
      { id: 'c', spoilerLevel: 3 },
    ];
    assert.deepEqual(
      filterBySpoiler(items, 'light').map((i) => i.id),
      ['a'],
    );
    assert.equal(filterBySpoiler(items, 'medium').length, 2);
    assert.equal(filterBySpoiler(items, 'full').length, 3);
  });

  test('随机挑选候选', () => {
    const picked = pickSuggestion(['甲', '乙'], { rng: () => 0 });
    assert.equal(picked, '甲');
    assert.equal(pickSuggestion([], {}), null);
  });

  test('游戏日期归一化', () => {
    assert.equal(normalizeGameDate('4/1'), '04/01');
    assert.equal(normalizeGameDate('04/01'), '04/01');
    assert.equal(normalizeGameDate('4月1日'), '04/01');
    assert.equal(normalizeGameDate('2026/04/01'), '04/01');
    assert.equal(normalizeGameDate(''), '');
  });

  test('按日期挑当天条目（含区间）', () => {
    const items = [
      { id: 'x', date: '04/01' },
      { id: 'y', date: '04/05', endDate: '04/10' },
      { id: 'z', date: '05/01' },
    ];
    assert.deepEqual(selectByDate(items, '04/01').map((i) => i.id), ['x']);
    assert.deepEqual(selectByDate(items, '04/07').map((i) => i.id), ['y']);
    assert.equal(selectByDate(items, '').length, 0);
  });

  test('记录已说过的建议', () => {
    const recent = rememberSuggestion([], '去花坛', 100);
    assert.equal(recent.length, 1);
    assert.equal(recent[0].key, '去花坛');
    assert.equal(recent[0].atSec, 100);
  });

  return { passed, failed };
}

const invokedDirectly =
  Boolean(process.argv[1]) && import.meta.url === pathToFileURL(process.argv[1]).href;

if (invokedDirectly) {
  const { passed, failed } = runPolicyTests();
  console.log(`policy: ${passed} passed, ${failed} failed`);
  if (failed > 0) process.exitCode = 1;
}
