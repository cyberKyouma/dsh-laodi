# overlay/ — 悬浮窗占位

Batch 1 只做**占位**：结构像插件，但不硬依赖 Electron。

## 现状

| 文件 | 作用 |
| --- | --- |
| `src/overlay/overlay.mjs` | 宿主侧控制器：创建透明置顶窗、冒气泡、更新日期标定 |
| `runtime/overlay/overlay.html` | 窗内页面：气泡区 + 日期标定区 + 拖拽条 |

## 两种运行模式

1. **有 Electron**：`createOverlayController({ electron })` 会建一个
   `frame:false / transparent:true / alwaysOnTop:true` 的 `BrowserWindow`，
   加载 `runtime/overlay/overlay.html`。
2. **无 Electron（默认）**：控制器降级为「控制台模式」——
   `speak()` 打到日志、状态存在内存里，主循环照常跑。
   这样 `npm run smoke` / `npm start` 在没有 Electron 的机器上也不会炸。

## 气泡怎么进到页面

两条路，同时都在：

1. **IPC**：`win.webContents.send('dsh:bubble', {...})` —— 需要 preload 暴露
   `window.dshOverlay.on`，Batch 2 接。
2. **状态注入（Batch 1 走这条）**：宿主用
   `win.webContents.executeJavaScript('window.__DSH_OVERLAY_STATE__ = {...}')`
   把 `{bubble, bubbleAt, seq, calibration}` 写进页面，页面每 300ms 轮询，
   `seq` 变了就刷新气泡。**所以不装 preload 也能看到气泡。**

## IPC 频道

| 频道 | 载荷 | 说明 |
| --- | --- | --- |
| `dsh:bubble` | `{ text, at? }` | 显示一句话（已按 40 字截断） |
| `dsh:calibration` | `{ gameDate, timeSlot }` | 更新日期标定占位 |
| `dsh:visibility` | `{ visible }` | 显示 / 隐藏 |

宿主 → 窗：`win.webContents.send(channel, payload)`
窗 → 宿主：预留 `dsh:ask`（热键问答，Batch 4 接线）。

## 下一步（Batch 2 / 4）

- 接 preload，把 `ipcRenderer` 安全暴露成 `window.dshOverlay`（只放行上面 3 个频道）。
- 气泡加淡入淡出与「说话中」状态。
- 日期标定区接真实输入（目前是占位文本）。
- 拖拽：标题条已加 `-webkit-app-region: drag`。
