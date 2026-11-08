# 开发计划

## Batch 0 — 仓库与约定
- [x] 创建 D:\dshworkspace\dsh-laodi + git
- [x] package.json / 插件清单 / .gitignore
- [x] 目录骨架与空知识包 schema
- [x] 初提交 + Batch1 scaffold 提交

## Batch 1 — 宿主骨架
- [x] 前台窗口探测（P5R 进程/标题白名单可配）
- [x] 低频截屏（默认只截游戏窗，不落盘）
- [x] 视觉 API 配置位（OpenAI 兼容，可 mock）
- [x] 透明置顶悬浮窗占位（可拖、气泡区、日期标定 UI 占位）
- [x] 设置/路径约定到插件数据目录
- [x] 少说规则纯函数 + smoke
- [ ] 真机：切到非游戏停止循环；悬浮窗可见可拖（需装入 DSH/Electron 实机验）

## Batch 2 — 策略引擎
- [x] 少说规则接入主循环（场景静音、冷却、剧透档）
- [x] 结构化识屏 → 一句建议（真实视觉 API / mock）

## Batch 3 — 知识包 + 提醒
- [x] 加载 data/p5r/*
- [x] 按 gameDate 生成提醒；稍后/忽略/已完成

## Batch 4 — 问答
- [x] CLI/宿主 ask：强制识一屏；glossary 优先；自动收藏
- [ ] 全局热键 + ASR（初版用 `--ask=` / 打字；热键接线留给装入 DSH 后）

## Batch 5 — 打磨与验收全用例
- [x] 对照 docs/ACCEPTANCE.md 逻辑用例（冒烟）
- [ ] 真机 P5R 窗口化联调
