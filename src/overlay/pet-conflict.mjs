/**
 * 若本机同时加载了独立 dsh-pet，避免两个形象一起出现或抢话。
 *
 * 只在「看起来已经加载」时暂停本插件桌宠。仅仅装在磁盘上时给出提示，不隐藏形象。
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Module } from 'node:module';

export const DSH_PET_NOTICE =
  '检测到 dsh-pet 也在运行。为避免两个形象同时出现或抢话，本插件桌宠已暂停。请关闭 dsh-pet 或本插件其一后再用桌宠。';

export const DSH_PET_INSTALLED_HINT =
  '本机可能装有 dsh-pet。若它也在加载，请只留一个桌宠，避免两个形象抢话。';

export function isDshPetName(name) {
  const text = String(name ?? '')
    .trim()
    .toLowerCase()
    .replace(/\\/g, '/');
  if (!text) return false;
  if (text === 'dsh-pet' || text.startsWith('dsh-pet@') || text.startsWith('dsh-pet/')) return true;
  const base = text.split('/').filter(Boolean).pop() || '';
  return base === 'dsh-pet' || base.startsWith('dsh-pet@');
}

function textMentionsPet(value) {
  const text = String(value ?? '');
  if (!text) return false;
  if (isDshPetName(text)) return true;
  return /(?:^|[\\/])dsh-pet(?:[\\/]|$|@)/i.test(text);
}

/**
 * 从 Cordis ctx 里浅浅收集插件名。只看 name / id，避免把任意字符串误认成插件。
 */
export function collectPluginNames(root) {
  const names = [];
  const seen = new Set();
  const queue = [];
  if (root) queue.push({ node: root, depth: 0 });
  while (queue.length && seen.size < 300) {
    const { node, depth } = queue.shift();
    if (!node || typeof node !== 'object' || seen.has(node) || depth > 5) continue;
    seen.add(node);
    if (typeof node.name === 'string') names.push(node.name);
    if (typeof node.id === 'string') names.push(node.id);
    const plugin = node.plugin;
    if (plugin && typeof plugin === 'object') {
      if (typeof plugin.name === 'string') names.push(plugin.name);
      if (typeof plugin.id === 'string') names.push(plugin.id);
    }
    const bags = [];
    if (depth === 0 && node.root && node.root !== node) bags.push(node.root);
    for (const key of ['plugins', 'children', 'registry']) {
      if (node[key]) bags.push(node[key]);
    }
    const scope = node.scope;
    if (scope && typeof scope === 'object') {
      if (scope.plugins) bags.push(scope.plugins);
      if (scope.children) bags.push(scope.children);
    }
    for (const bag of bags) {
      let values = [];
      if (!bag || typeof bag !== 'object') continue;
      try {
        // Map/Set/Array only. Calling .values() on a Cordis registry during
        // apply() can wait for this plugin to finish loading and deadlock.
        if (Array.isArray(bag)) values = bag;
        else if (bag instanceof Map || bag instanceof Set) values = [...bag.values()];
        else values = Object.values(bag);
      } catch {
        values = [];
      }
      for (const item of values) {
        if (item && typeof item === 'object') queue.push({ node: item, depth: depth + 1 });
      }
    }
  }
  return names;
}

function hasDshPetService(ctx) {
  if (!ctx || typeof ctx.get !== 'function') return false;
  try {
    return Boolean(ctx.get('dsh-pet', false));
  } catch {
    return false;
  }
}

export function findDshPetWindow(electron) {
  let windows = [];
  try {
    windows = electron?.BrowserWindow?.getAllWindows?.() ?? [];
  } catch {
    return false;
  }
  for (const win of windows) {
    let title = '';
    let url = '';
    try {
      title = win?.getTitle?.() || '';
    } catch {
      title = '';
    }
    try {
      url = win?.webContents?.getURL?.() || '';
    } catch {
      url = '';
    }
    if (textMentionsPet(title) || textMentionsPet(url)) return true;
  }
  return false;
}

export function dshPetInstallPaths(env = process.env) {
  const home = String(env?.DSH_HOME || '').trim() || path.join(os.homedir(), '.dsh');
  return [
    path.join(home, 'plugins', 'dsh-pet', 'package.json'),
    path.join(home, 'node_modules', 'dsh-pet', 'package.json'),
  ];
}

function cacheKeys(moduleCache) {
  if (Array.isArray(moduleCache)) return moduleCache;
  try {
    return Object.keys(Module._cache || {});
  } catch {
    return [];
  }
}

/**
 * @returns {{
 *   loaded: boolean,
 *   installed: boolean,
 *   reasons: string[],
 *   notice: string,
 *   installedHint: string,
 * }}
 */
export function detectDshPet(options = {}) {
  const reasons = [];
  const names = [
    ...(Array.isArray(options.pluginNames) ? options.pluginNames : []),
    ...collectPluginNames(options.ctx),
  ];
  if (names.some((name) => isDshPetName(name))) reasons.push('plugin');
  if (isDshPetName(options.petPluginId)) reasons.push('settings');
  if (options.servicePresent === true || hasDshPetService(options.ctx)) reasons.push('service');
  if (cacheKeys(options.moduleCache).some((file) => textMentionsPet(file))) reasons.push('module');
  if (findDshPetWindow(options.electron)) reasons.push('window');

  const exists = options.existsSync || fs.existsSync;
  let installed = options.installed === true;
  if (!installed) {
    try {
      installed = dshPetInstallPaths(options.env).some((file) => {
        try {
          return Boolean(exists(file));
        } catch {
          return false;
        }
      });
    } catch {
      installed = false;
    }
  }

  const loaded = reasons.length > 0;
  return {
    loaded,
    installed,
    reasons,
    notice: loaded ? DSH_PET_NOTICE : '',
    installedHint: !loaded && installed ? DSH_PET_INSTALLED_HINT : '',
  };
}

export default {
  DSH_PET_NOTICE,
  DSH_PET_INSTALLED_HINT,
  isDshPetName,
  collectPluginNames,
  findDshPetWindow,
  dshPetInstallPaths,
  detectDshPet,
};
