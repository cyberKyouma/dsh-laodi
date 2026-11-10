# overlay/ — 桌宠形象 + 气泡

Session-5 把原来的短气泡窗升级成**同一个**透明置顶形象窗。不另做聊天窗，也不依赖独立的 `dsh-pet`。

## 行为

| 场景 | 形象 |
| --- | --- |
| 桌面 | 圆形静态图停在桌面（默认识别主显示器工作区右下角），可拖，位置会被记住 |
| P5R 在前台 | 同一形象贴到游戏窗口右下角，并跟着窗口走 |
| 离开游戏 | 回到刚才的桌面位置 |
| 说话 | 短气泡出现在形象旁边（仍是 `speak()` / `dsh:bubble`） |
| 桌面闲聊 | 形象下方输入框，走同一条陪玩 Session，不截屏 |

第一版图是 `runtime/overlay/pet.svg`，裁成圆形。没有走路、眨眼，也不使用「老弟」立绘。

## 文件

| 文件 | 作用 |
| --- | --- |
| `src/overlay/overlay.mjs` | 窗口控制器。有 Electron 才建真窗口 |
| `src/overlay/placement.mjs` | 桌面 / 游戏坐标（纯函数） |
| `src/overlay/pet-conflict.mjs` | 检测到 `dsh-pet` 已加载时暂停本插件形象 |
| `runtime/overlay/overlay.html` | 圆形图、气泡、桌面输入框 |
| `runtime/overlay/preload.cjs` | 只放行点击穿透和闲聊频道 |
| `runtime/overlay/pet.svg` | 占位圆形图 |

## 不挡操作

窗口只包住形象和气泡。空白处由页面上报 `dsh-laodi:hit-test`，宿主 `setIgnoreMouseEvents(true, { forward: true })`，点击会落到桌面或其他窗口。形象本身用 `-webkit-app-region: drag` 拖动。没有 Electron 时退回控制台气泡，主循环照常判断前台。

## 识屏

跟随循环只探测前台窗口，**不截屏**。周期识屏只在形象处于游戏模式时启动；回到桌面就停。桌面闲聊不 inject 画面摘要。
