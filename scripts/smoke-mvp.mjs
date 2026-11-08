#!/usr/bin/env node
/**
 * Batch3–4 初版冒烟：提醒 / 问答 / 收藏
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { createReminderStore, buildTodayReminders, REMINDER_STATUS } from '../src/reminders/store.mjs';
import { createFavoritesStore } from '../src/favorites/store.mjs';
import { lookupGlossary, composeAnswer, askOnce } from '../src/ask/ask.mjs';
import { createHost } from '../src/index.mjs';
import { loadKnowledgePack } from '../src/data/knowledge.mjs';
import { createOverlayController } from '../src/overlay/overlay.mjs';

export async function runMvpTestsAsync() {
  const stats = { passed: 0, failed: 0 };
  const test = async (name, fn) => {
    try {
      await fn();
      stats.passed += 1;
      console.log(`  PASS  ${name}`);
    } catch (err) {
      stats.failed += 1;
      console.error(`  FAIL  ${name}`);
      console.error(`        ${err instanceof Error ? err.message : String(err)}`);
    }
  };

  console.log('mvp reminders/ask/favorites:');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-laodi-mvp-'));
  const pack = loadKnowledgePack();

  await test('标定 04/17 后出现特殊道具提醒', () => {
    const built = buildTodayReminders({
      pack,
      gameDate: '04/17',
      spoilerTier: 'light',
      saved: {},
      nowSec: 1000,
    });
    assert.ok(built.length >= 1);
    assert.ok(built.some((item) => /点心|道具|套餐|手作/.test(`${item.title}${item.detail}`)));
  });

  await test('提醒可稍后/忽略/已完成并落盘', () => {
    const store = createReminderStore({
      file: path.join(tmp, 'reminders.json'),
      loadPack: () => pack,
      spoilerTier: 'light',
      clock: () => 2000,
    });
    const list = store.refresh('04/17');
    assert.ok(list.length >= 1);
    const id = list[0].id;
    assert.equal(store.later(id)?.status, REMINDER_STATUS.later);
    assert.equal(store.done(id)?.status, REMINDER_STATUS.done);
    const again = createReminderStore({
      file: path.join(tmp, 'reminders.json'),
      loadPack: () => pack,
      clock: () => 3000,
    });
    again.refresh('04/17');
    assert.equal(again.list().find((item) => item.id === id)?.status, REMINDER_STATUS.done);
  });

  await test('glossary 命中 Persona', () => {
    const hit = lookupGlossary('Persona', pack.glossary);
    assert.ok(hit);
    const answer = composeAnswer({ question: 'Persona', glossaryHit: hit, maxChars: 40 });
    assert.equal(answer.source, 'glossary');
    assert.ok([...answer.bubble].length <= 40);
  });

  await test('askOnce 强制识屏并自动收藏', async () => {
    const fav = createFavoritesStore({ file: path.join(tmp, 'favorites.json'), clock: () => 4000 });
    const overlay = createOverlayController({
      config: { overlay: { enabled: false } },
      logger: { info() {} },
    });
    const result = await askOnce(
      {
        probe: async () => ({ title: 'Persona5Royal', processName: 'P5R.exe' }),
        capture: async () => ({ buffer: Buffer.from('fake'), mimeType: 'image/png' }),
        vision: {
          describe: async () => ({
            scene: 'street',
            summary: '街景',
            suggestion: '去花坛',
            spoilerLevel: 0,
          }),
        },
        knowledge: pack,
        config: { bubbleMaxChars: 40, policy: { spoilerDefault: 'light' } },
        state: { calibration: { gameDate: '04/17' } },
        overlay,
        favorites: fav,
        bufferToBase64: (buf) => Buffer.from(buf).toString('base64'),
      },
      'Persona',
    );
    assert.equal(result.ok, true);
    assert.equal(result.captureOk, true);
    assert.equal(result.answer.source, 'glossary');
    assert.ok(result.favorite?.id);
    assert.ok(fav.list().some((item) => item.question === 'Persona'));
  });

  await test('host.setCalibration 刷新提醒到 overlay', () => {
    const overlay = createOverlayController({ config: {}, logger: { info() {} } });
    const host = createHost({
      config: {
        captureIntervalSec: 90,
        minSpeakGapSec: 180,
        speakProbability: 0.3,
        bubbleMaxChars: 40,
        policy: { cooldownSec: 1800, spoilerDefault: 'light', mutedSceneKeywords: [] },
        overlay: { enabled: false },
        vision: { mock: true, apiKey: '', baseURL: 'http://x', model: 'm' },
        gameWindow: { titleIncludes: ['Persona'], processNames: ['P5R.exe'] },
      },
      overlay,
      knowledge: pack,
      dataDir: tmp,
      logger: { info() {}, warn() {}, error() {} },
      capture: async () => ({ buffer: Buffer.from('x'), mimeType: 'image/png' }),
      probe: async () => ({ title: 'Desktop', processName: 'explorer' }),
    });
    host.setCalibration({ gameDate: '04/17', timeSlot: 'after-school' });
    assert.ok(host.reminders.list().length >= 1);
    assert.ok(overlay.pageState.reminders.length >= 1);
  });

  await test('剧透 light 不弹 spoilerLevel>=2 日历主线', () => {
    const built = buildTodayReminders({
      pack,
      gameDate: '05/07',
      spoilerTier: 'light',
      saved: {},
      nowSec: 1000,
    });
    assert.ok(built.every((item) => Number(item.spoilerLevel ?? 0) <= 1));
  });

  return stats;
}

const invoked =
  Boolean(process.argv[1]) && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invoked) {
  const stats = await runMvpTestsAsync();
  console.log(`mvp: ${stats.passed} passed, ${stats.failed} failed`);
  process.exitCode = stats.failed ? 1 : 0;
}

export default { runMvpTestsAsync };
