/**
 * 知识包加载（data/p5r/*.json）。
 *
 * 结构：
 *   { schemaVersion, game, items: [...] }
 * Batch 1 只负责读 + 校验；「按 gameDate 生成提醒」属于 Batch 3。
 */

import fs from 'node:fs';
import path from 'node:path';

import { DATA_DIR } from '../paths.mjs';

export const KNOWLEDGE_FILES = Object.freeze({
  calendar: 'calendar.json',
  'shop-items': 'shop-items.json',
  glossary: 'glossary.json',
});

/** 每个知识包集合的必填字段 */
export const REQUIRED_FIELDS = Object.freeze({
  calendar: ['id', 'title', 'date', 'spoilerLevel', 'tags'],
  'shop-items': ['id', 'name', 'date', 'item', 'effect', 'worthBuyNote', 'spoilerLevel', 'tags'],
  glossary: ['id', 'term', 'brief', 'spoilerLevel', 'tags'],
});

/**
 * 读取整个知识包。
 * @returns {{meta: object, calendar: Array, 'shop-items': Array, glossary: Array}}
 */
export function loadKnowledgePack(options = {}) {
  const dir = options.dir ?? DATA_DIR;
  const pack = { meta: {} };
  for (const [key, file] of Object.entries(KNOWLEDGE_FILES)) {
    const full = path.join(dir, file);
    let parsed = null;
    try {
      parsed = JSON.parse(fs.readFileSync(full, 'utf8'));
    } catch (err) {
      // 单个知识包坏掉不应该拖垮整个宿主：记下错误，该集合按空处理
      pack[key] = [];
      pack.meta[key] = {
        schemaVersion: 1,
        game: 'persona-5-royal',
        description: '',
        source: full,
        error: err instanceof Error ? err.message : String(err),
      };
      continue;
    }
    pack[key] = Array.isArray(parsed) ? parsed : (parsed?.items ?? []);
    pack.meta[key] = {
      schemaVersion: parsed?.schemaVersion ?? 1,
      game: parsed?.game ?? 'persona-5-royal',
      description: parsed?.description ?? '',
      source: full,
    };
  }
  return pack;
}

/**
 * 校验知识包结构。
 * @returns {{ok: boolean, errors: string[]}}
 */
export function validateKnowledgePack(pack = {}) {
  const errors = [];
  for (const [key, fields] of Object.entries(REQUIRED_FIELDS)) {
    const items = pack[key];
    if (!Array.isArray(items)) {
      errors.push(`${key}: 缺失或不是数组`);
      continue;
    }
    if (items.length === 0) {
      errors.push(`${key}: 条目为空`);
    }
    const seen = new Set();
    items.forEach((item, index) => {
      const where = `${key}[${index}]`;
      if (!item || typeof item !== 'object') {
        errors.push(`${where}: 不是对象`);
        return;
      }
      for (const field of fields) {
        const value = item[field];
        if (value === undefined || value === null || value === '') {
          errors.push(`${where}: 缺少字段 ${field}`);
        }
      }
      if (item.id !== undefined) {
        if (seen.has(item.id)) errors.push(`${where}: id 重复 ${item.id}`);
        seen.add(item.id);
      }
      if (item.tags !== undefined && !Array.isArray(item.tags)) {
        errors.push(`${where}: tags 必须是数组`);
      }
      if (
        item.spoilerLevel !== undefined &&
        !(Number(item.spoilerLevel) >= 0 && Number(item.spoilerLevel) <= 3)
      ) {
        errors.push(`${where}: spoilerLevel 必须在 0–3`);
      }
    });
  }
  return { ok: errors.length === 0, errors };
}

export default { loadKnowledgePack, validateKnowledgePack, KNOWLEDGE_FILES, REQUIRED_FIELDS };
