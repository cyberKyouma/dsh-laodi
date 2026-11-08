/**
 * 提醒状态机：按标定 gameDate 从知识包生成今日提醒，
 * 支持 later / ignore / done，状态落盘到插件数据目录。
 */

import fs from 'node:fs';
import path from 'node:path';
import { normalizeGameDate, selectByDate, filterBySpoiler } from '../policy/speak.mjs';

export const REMINDER_STATUS = Object.freeze({
  open: 'open',
  later: 'later',
  ignored: 'ignored',
  done: 'done',
});

function ensureDir(file) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
}

function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}

function writeJsonAtomic(file, value) {
  ensureDir(file);
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  fs.renameSync(tmp, file);
}

/** 从知识包条目生成一条提醒草稿 */
export function draftFromItem(item, source) {
  const id = String(item?.id ?? `${source}-${item?.title ?? item?.name ?? Math.random()}`);
  const title = String(item?.title ?? item?.name ?? item?.item ?? id);
  const detail = String(
    item?.detail ?? item?.worthBuyNote ?? item?.effect ?? item?.brief ?? '',
  );
  return {
    id,
    source,
    title,
    detail,
    spoilerLevel: Number(item?.spoilerLevel ?? 0),
    date: normalizeGameDate(item?.date ?? ''),
    status: REMINDER_STATUS.open,
    updatedAtSec: 0,
  };
}

/**
 * 合并知识包与已保存状态，得到「今天」提醒列表。
 */
export function buildTodayReminders(options = {}) {
  const {
    pack = {},
    gameDate = '',
    spoilerTier = 'light',
    saved = {},
    nowSec = Date.now() / 1000,
  } = options;
  const day = normalizeGameDate(gameDate);
  if (!day) return [];

  const raw = [
    ...selectByDate(pack.calendar ?? [], day).map((item) => draftFromItem(item, 'calendar')),
    ...selectByDate(pack['shop-items'] ?? [], day).map((item) =>
      draftFromItem(item, 'shop-items'),
    ),
  ];
  const filtered = filterBySpoiler(raw, spoilerTier);
  return filtered.map((draft) => {
    const prev = saved[draft.id];
    if (!prev) return { ...draft, updatedAtSec: nowSec };
    return {
      ...draft,
      status: Object.values(REMINDER_STATUS).includes(prev.status)
        ? prev.status
        : REMINDER_STATUS.open,
      updatedAtSec: Number(prev.updatedAtSec ?? nowSec),
    };
  });
}

export function createReminderStore(options = {}) {
  const {
    file,
    loadPack,
    spoilerTier = 'light',
    clock = () => Date.now() / 1000,
  } = options;
  if (!file) throw new Error('createReminderStore: 缺少 file');

  let gameDate = '';
  let items = [];
  let saved = readJson(file, { version: 1, byId: {} }).byId ?? {};

  function persist() {
    writeJsonAtomic(file, { version: 1, byId: saved, gameDate });
  }

  function refresh(nextDate = gameDate) {
    gameDate = normalizeGameDate(nextDate);
    const pack = typeof loadPack === 'function' ? loadPack() : loadPack ?? {};
    items = buildTodayReminders({
      pack,
      gameDate,
      spoilerTier,
      saved,
      nowSec: clock(),
    });
    return list();
  }

  function list(filterStatus) {
    const all = items.map((item) => ({ ...item }));
    if (!filterStatus) return all;
    return all.filter((item) => item.status === filterStatus);
  }

  function setStatus(id, status) {
    if (!Object.values(REMINDER_STATUS).includes(status)) {
      throw new Error(`未知提醒状态：${status}`);
    }
    const target = items.find((item) => item.id === id);
    if (!target) return null;
    target.status = status;
    target.updatedAtSec = clock();
    saved[id] = { status, updatedAtSec: target.updatedAtSec };
    persist();
    return { ...target };
  }

  return {
    get gameDate() {
      return gameDate;
    },
    refresh,
    list,
    open() {
      return list(REMINDER_STATUS.open);
    },
    later(id) {
      return setStatus(id, REMINDER_STATUS.later);
    },
    ignore(id) {
      return setStatus(id, REMINDER_STATUS.ignored);
    },
    done(id) {
      return setStatus(id, REMINDER_STATUS.done);
    },
    setStatus,
  };
}

export default { createReminderStore, buildTodayReminders, draftFromItem, REMINDER_STATUS };
