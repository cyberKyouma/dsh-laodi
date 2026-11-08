/**
 * 攻略收藏：问答/气泡可收藏，列表回看；不存原图。
 */

import fs from 'node:fs';
import path from 'node:path';

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

export function createFavoritesStore(options = {}) {
  const { file, clock = () => Date.now() / 1000, maxItems = 200 } = options;
  if (!file) throw new Error('createFavoritesStore: 缺少 file');

  let items = Array.isArray(readJson(file, { version: 1, items: [] }).items)
    ? readJson(file, { version: 1, items: [] }).items
    : [];

  function persist() {
    writeJsonAtomic(file, { version: 1, items });
  }

  function list() {
    return items.map((item) => ({ ...item }));
  }

  function add(entry = {}) {
    const text = String(entry.text ?? entry.answer ?? '').trim();
    if (!text) return null;
    const id = String(entry.id ?? `fav-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`);
    const record = {
      id,
      text,
      question: String(entry.question ?? '').trim(),
      source: String(entry.source ?? 'ask'),
      gameDate: String(entry.gameDate ?? ''),
      createdAtSec: clock(),
    };
    items = [record, ...items.filter((item) => item.id !== id)].slice(0, maxItems);
    persist();
    return { ...record };
  }

  function remove(id) {
    const before = items.length;
    items = items.filter((item) => item.id !== id);
    if (items.length !== before) persist();
    return before !== items.length;
  }

  return { list, add, remove };
}

export default { createFavoritesStore };
