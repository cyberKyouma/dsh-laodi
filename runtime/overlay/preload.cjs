/**
 * 悬浮窗 preload。只放行形象需要的频道，不打开 nodeIntegration。
 */
'use strict';

const { contextBridge, ipcRenderer } = require('electron');

const SEND_CHANNELS = new Set([
  'dsh-laodi:hit-test',
  'dsh-laodi:chat',
  'dsh:reminder-action',
]);

const ON_CHANNELS = new Set([
  'dsh:bubble',
  'dsh:calibration',
  'dsh:reminders',
  'dsh:favorites',
  'dsh:visibility',
]);

contextBridge.exposeInMainWorld('dshOverlay', {
  send(channel, payload) {
    if (!SEND_CHANNELS.has(channel)) return;
    ipcRenderer.send(channel, payload);
  },
  on(channel, listener) {
    if (!ON_CHANNELS.has(channel) || typeof listener !== 'function') return () => {};
    const wrapped = (_event, payload) => listener(payload);
    ipcRenderer.on(channel, wrapped);
    return () => ipcRenderer.removeListener(channel, wrapped);
  },
});
