# dsh-laodi MVP 规格（定稿）

## 锁定
- 游戏：仅 Persona 5 Royal（P5R）
- 平台：Windows；悬浮窗需游戏窗口化/无边框
- 识屏：周期低频 + 问答时加识一屏
- 开口：默认可自动，短句低频
- 提醒：游戏上悬浮窗

## 进度
- 主：用户标定 gameDate + timeSlot
- 辅：识屏高置信才校正
- 最少状态：gameDate, timeSlot, palaceInProgress?, lastScene

## 知识包 data/p5r/
- calendar.json — 考试/限时/deadline
- shop-items.json — 特殊道具日
- glossary.json — 名词
- 字段含 spoilerLevel, tags, source?

## 少说规则
- 周期识屏默认 90–120s
- 自动开口 ≥3min；开口概率 ≤30%
- 对话/过场/主菜单/商店结算：不主动说
- 同建议冷却 30min；气泡 ≤40 字

## 剧透
- 默认轻提示；用户要详细再升级

## 语音 MVP
- 全局热键（默认 Ctrl+Shift+Space）；不做唤醒词
- ASR 可配；失败可打字；TTS 默认关

## 隐私
- 截图默认不落盘；入库摘要/收藏/提醒/日期，不存原图

## 非目标（本 MVP）
- 多游戏、唤醒词、云同步、独占全屏 overlay、飞书推送
