你是实现者。只允许读写目录：D:\dshworkspace\dsh-laodi （已 git init，main 分支，已有 docs/SPEC.md PLAN.md ACCEPTANCE.md README.md .gitignore）。

目标：完成 Batch 0 剩余 + Batch 1 骨架，并 git commit。

## 必须交付
1. package.json：name=dsh-laodi，private，描述 P5R 陪玩 DSH 插件；engines.node 合理；预留 dsh.bundle 字段占位（参考常见 dsh 插件，可先最小可用）。
2. .env.example：视觉 API 的 baseURL/model/apiKey 占位，无真实密钥。
3. data/p5r/ 下三个 JSON schema 示例（可少条目但结构完整）：
   - calendar.json
   - shop-items.json
   - glossary.json
   字段含 id, title/name, spoilerLevel, tags；shop 含 date/item/effect/worthBuyNote；glossary 含 term/brief。
4. src/ 宿主骨架（Node 可跑的最小实现，不强求此刻装进 DSH 桌面，但结构要像插件）：
   - config.mjs 默认：captureIntervalSec 100，minSpeakGapSec 180，speakProbability 0.3，bubbleMaxChars 40，hotkey 文案占位
   - capture/window.mjs：Windows 下探测前台窗口（可用 PowerShell/user32 思路或 child_process）；P5R 白名单关键字可配（Persona5, P5R, 女神异闻录 等）
   - capture/screenshot.mjs：截游戏窗口到内存/临时缓冲，默认不持久保存 PNG 到仓库
   - vision/client.mjs：OpenAI 兼容 chat/completions 多模态调用封装（读环境变量），先可 mock
   - policy/speak.mjs：实现少说规则纯函数（间隔、概率、场景静音、冷却）+ 单测或 scripts/smoke-policy.mjs
   - overlay/：透明置顶窗占位说明 + 若用 Electron 则最小 html；至少提供 runtime/overlay/overlay.html 气泡+日期标定占位 UI
   - index.mjs：主循环伪代码级可运行入口：非游戏前台则停识屏；导出 start/stop
5. scripts/smoke.mjs：不依赖真实游戏也能跑：测 policy + config 加载 + 打印 OK
6. 更新 docs/PLAN.md 勾选 Batch 0 完成项与 Batch 1 已完成部分
7. git add 后 commit，message 用英文前缀：feat: batch0-1 scaffold host loop and overlay placeholder
   若无 user.name，用：git -c user.email=laodi@local -c user.name=dsh-laodi

## 禁止
- 不要删除 docs/SPEC.md 等内容
- 不要把 API Key 写入仓库
- 不要修改 D:\dshworkspace\dsh-laodi 以外的文件
- 不要 force push / 改 git 历史

## 完成时
stdout 只输出：COMMIT_HASH=<hash> 与简短文件清单。
