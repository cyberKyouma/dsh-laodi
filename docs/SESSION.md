# 多轮会话（DSH Session）开发备忘

> **用途**：后续会话 / 聊天记忆相关开发，以本文为准；可随时改勾选与优先级。  
> **关联**：[SPEC.md](./SPEC.md)（产品规格）· [PLAN.md](./PLAN.md)（总批次）· [ACCEPTANCE.md](./ACCEPTANCE.md)  
> **状态**：Session-0/1/1.5 已落地；Session-2 inject + `screen_look`/`glossary_lookup` 已通；SOUL/提醒工具待补  
> **更新**：2026-11-10  

---

## 1. 目标

把陪玩问答从「单次 `askOnce`」改成：

1. **对话落在 DSH Session**（`~/.dsh/sessions/.../session-*.json`），可在侧边栏「陪玩」工作区里打开、续聊。
2. **有聊天记忆**：短期靠 Session transcript；长期可另存 sidecar（偏好 / 约定 / 进度摘要）。
3. **游戏能力仍在**：识屏、少说、剧透档、知识包、提醒 —— 作为工具或 inject 上下文进入同一条 Session。

非目标（本文阶段不做，除非勾进下方批次）：

- [ ] 自研完整聊天 UI（优先用 DSH 侧栏 Session）
- [ ] 重做桌宠（可后接 `dsh-pet` broadcast）
- [ ] ASR / TTS（仍按 SPEC 热键打字优先）

---

## 2. 现状快照

| 能力 | 现状 |
| --- | --- |
| 专用工作区「陪玩」 | ✅ 已登记 `workspace.json`，路径可配 |
| 人格预设「老弟」 | ✅ `data/personas/laodi/` → 工作区 `persona/SOUL.md` |
| 识屏主循环 + 少说 | ✅ `src/index.mjs` + `policy/speak.mjs` |
| 单次问答 | ✅ `askOnce`；CLI `--ask-once=` |
| 多轮问答 | ✅ `askCompanion` → Session `followup`；失败回退 `askOnce` |
| 收藏 | ✅ `favorites.json`（不是对话记忆） |
| 创建 / resume DSH Session | ✅ `src/host/session.mjs`（agents 软取） |
| `followup` / `inject` 进 Session | ✅ 提问前 inject 识屏摘要 + glossary |
| Session 内游戏工具 | ✅ `screen_look` / `glossary_lookup`（create/resume setup 注册；无 defineTool 则跳过） |
| 长期记忆 sidecar | ❌（仅有 SOUL / MEMORY 占位） |
| 热键提问 | ❌ |

---

## 3. 目标架构（草案）

```
用户提问（热键 / CLI / DSH 侧栏）
        │
        ▼
┌───────────────────┐
│ 陪玩宿主插件       │  固定 companionSessionId
│  - 确保 Session    │  create / resume
│  - 识屏摘要 inject │  可选带图 attachment
│  - followup 用户话 │
│  - 工具：识屏/词条/提醒 │
└─────────┬─────────┘
          │
          ▼
   DSH Session（短期记忆 = transcript）
          │
          ├── 侧栏打开「陪玩」工作区里该会话
          ├── 气泡：取本轮回复短句（可选）
          └── 长期记忆：persona/MEMORY.md 或 KV（可选批次）
```

**记忆分层：**

| 层 | 载体 | 内容 |
| --- | --- | --- |
| 短期 | DSH Session transcript | 多轮问答、本局上下文 |
| 游戏态 | 宿主 state / inject | gameDate、scene、剧透档 |
| 长期 | `persona/MEMORY.md` 等 | 跨天偏好、约定（后做） |

---

## 4. 缺口清单（开发对照）

### 4.1 Session 生命周期 — P0

- [x] 在宿主拿到可用的 `ctx.agents`（软取 `ctx.get('agents', false)`；desktop 实机仍需验收）
- [x] `ensureCompanionSession()`：无则 create，有则 resume；写入设置 `companionSessionId`
- [x] Session 挂到「陪玩」工作区（`attachSessionToWorkspace` → `sessionIds`）
- [x] 设置页展示 Session 状态：id、是否存活、一键新建/重置
- [x] 进程重启后 resume 同一条 Session（依赖 DSH 持久化 + 本插件存 id）
- [x] 建会话带 `meta.cwd` = 工作区目录（否则落到 `~/.dsh/sessions/_no-cwd/`，侧边栏认不出）
- [x] 「确保 Session」/「重置 Session」后发一句开场 followup：DSH 侧栏会隐藏 `sessionListMetadata.blank=true` 的空白会话；已揭晓的 id 记在 `companionSessionRevealedId`，不重复打招呼。「立刻试一轮」仍不入 Session。
- [x] `agents.resume({ resumeSessionId })`：参数名对齐 DSH
- [x] 老会话 cwd 缺失 / 与工作区不一致 → 丢弃并另建，不硬用
- [x] 工作区登记与挂载优先走官方 `ctx.workspaceRegistry`（没有则退回写 workspace.json）
- [x] 会话标题固定「陪玩」（`ctx.sessionTitle.rename`）

### 4.2 把 ask 改成多轮 — P0

- [x] 用户提问 → `agent.followup` / 等价入口（`askCompanion`；CLI `--ask=`）
- [x] 提问时仍强制识一屏；结果 **inject 文字摘要**（默认不落原图）
- [x] glossary 命中可作为 inject，避免模型瞎编
- [x] CLI：`--ask=` 走 Session 路径（无 agents 自动降级）；`--ask-once=` 保留旧行为
- [x] 冒烟：mock agents 下可测两轮 followup / inject 契约

### 4.3 游戏上下文进 Session — P1

- [ ] 标定 `gameDate` / `timeSlot` 变更时 inject
- [x] 主动开口（少说通过后）是否写入 Session：**选项 B**（只气泡、不入 Session）
- [ ] 人设 SOUL 在 agent setup / system 段加载

### 4.4 Session 内工具 — P1

- [x] `screen_look`：强制识一屏，返回结构化 JSON 摘要
- [x] `glossary_lookup`：查知识包
- [ ] `reminders_list` / `calibrate_date`（可后挪）
- [x] 工具描述强调剧透档 / 少说边界

### 4.5 聊天记忆（长期）— P2

- [ ] 明确 MEMORY 写入策略（谁写：模型工具 vs 宿主摘要）
- [ ] Session 压缩 / 过长时的摘要回流 MEMORY
- [ ] 与外人设插件（dsh-companion 等）的桥接约定（可选）

### 4.6 UI / 入口 — P1～P2

- [x] 设置：Session 状态 + 重置
- [ ] 全局热键提问（SPEC）
- [ ] 气泡展示本轮 Session 回复短句（监听 turn 完成；现尽力 `extractAssistantReply`）
- [ ] （可选）`broadcast` 到 dsh-pet

### 4.7 策略与风险 — 全程注意

- [x] 用户提问：必须答；主动开口：仍走少说（间隔/概率/静音场景）— 主动开口不入 Session
- [x] 截图：默认摘要进 Session；`sessionAttachImages` 开关预留（附件路径后做）
- [ ] token / 压缩：依赖 DSH compact；过长则宿主摘要
- [x] `ctx.agents` 不可用时的降级：回退 `askOnce` + `mode` / `sessionError` 提示

---

## 5. 建议批次（可改）

### Session-0 — 探测与设计冻结

- [x] 冻结 agents 接入方式：软取，不硬 `inject: ['agents']`
- [x] 冻结：主动开口是否入 Session → **不入**
- [x] 冻结：截图进 Session 的默认策略 → **只 inject 摘要**
- [x] 更新本文「已拍板」一节

### Session-1 — 固定 Session + 文字多轮

- [x] `src/host/session.mjs`：ensure / resume / 持久化 id
- [x] 设置项：`companionSessionId` / `sessionAttachImages`
- [x] 提问入口改 followup（CLI + `POST /ask`）
- [x] 设置页 Session 状态
- [x] smoke：mock agents 契约

### Session-2 — 识屏 inject + 基础工具

- [x] 提问链路：识屏摘要 inject + followup
- [x] 工具：`screen_look`、`glossary_lookup`（注册到 agent.ctx；见 `src/host/companion-tools.mjs`）
- [ ] SOUL 进 system
- [ ] 气泡短句（可选，完善 extract）

### Session-3 — 记忆与打磨

- [ ] MEMORY 长期记忆
- [ ] 热键
- [ ] pet broadcast（可选）
- [ ] 更新 ACCEPTANCE / SPEC 中与会话相关的条目

---

## 6. 已拍板

> 开发中达成一致就写进这里，避免口头约定丢失。

| 议题 | 结论 | 日期 |
| --- | --- | --- |
| 对话载体 | 用 DSH Session，不自建第二套 chat store 当主 transcript | 2026-11-09 |
| 工作区 | 对话归「陪玩」工作区 | 2026-11-09 |
| 默认人格 | 「老弟」预设 | 2026-11-09 |
| 主动开口是否入 Session | **不入**（选项 B：只气泡） | 2026-11-09 |
| 截图默认 | **只 inject 文字摘要**；`sessionAttachImages` 默认 false | 2026-11-09 |
| agents 依赖 | **软取** `optionalService(ctx,'agents')`，不硬 inject | 2026-11-09 |
| agents 不可用 | 回退 `askOnce`，结果带 `mode` / `sessionError` | 2026-11-09 |
| 会话 cwd | **= 「陪玩」工作区目录**（`ctx.agents.create({ meta: { cwd } })`）；没 cwd 的会话会落到 `~/.dsh/sessions/_no-cwd/` | 2026-11-10 |
| 老会话 cwd 不对 | 丢弃并另建（不硬用）：工作区成员资格要拿 header.cwd 比对 | 2026-11-10 |
| resume 参数名 | `ctx.agents.resume({ resumeSessionId })` | 2026-11-10 |
| 工作区登记/挂载 | 优先官方 `ctx.workspaceRegistry`；拿不到才写 `workspace.json` | 2026-11-10 |
| 会话标题 | 固定「陪玩」（`ctx.sessionTitle.rename`，只在没有标题时设） | 2026-11-10 |

---

## 7. 关键文件

| 路径 | 角色 |
| --- | --- |
| `src/host/session.mjs` | Session ensure/resume/followup/inject；create/resume `setup` 挂工具 |
| `src/host/companion-tools.mjs` | `screen_look` / `glossary_lookup` 定义与注册 |
| `src/index.mjs` | `host.lookScreen` / `getKnowledge` 供工具调用 |
| `src/ask/ask.mjs` | `askCompanion` + `askOnce` |
| `src/dsh-plugin.mjs` | `/session*`、`/ask`、挂 session 到 host |
| `src/host/settings-store.mjs` | `companionSessionId`、`sessionAttachImages` |
| `src/host/workspace.mjs` | `attachSessionToWorkspace` + `ensureCompanionWorkspaceViaHost`（官方注册表优先） |
| `client.js` | Session 状态 UI |
| `src/index.mjs` | CLI `--ask` / `--ask-once` |
| `docs/ACCEPTANCE.md` | 补多轮用例（待） |
| `docs/SPEC.md` | 会话/记忆写入规格（待） |

---

## 8. 验收草案（多轮）

- [ ] 同 Session 连续两问，第二问能引用第一问内容（侧栏或 API 可见）— **desktop 实机**
- [x] mock：两轮 followup 均写入同一 agent（smoke）
- [ ] 重启 DSH 后 resume 同一 `companionSessionId`，历史仍在 — **desktop 实机**
- [x] 提问触发识屏时，inject 文字摘要（无原图默认）
- [x] 非游戏前台时主动开口仍停；用户提问仍可答（策略不互相踩死）
- [x] 重置 Session 后旧 id 不再被误用（设置清空 + forceNew）
- [x] create 时带 `meta.cwd`（冒烟：断言 create 参数里有 cwd）
- [x] 老会话（无 cwd）不硬用：resume 后发现 cwd 不对 → 另建（冒烟）
- [x] 挂载走官方工作区注册表（冒烟：fake registry 收到 attachSession）
- [ ] desktop 实机：会话出现在侧边栏「陪玩」工作区里（cwd 与工作区一致） — **desktop 实机**

---

## 9. 修订记录

| 日期 | 说明 |
| --- | --- |
| 2026-11-09 | 初稿：缺口分析 + Session-0/1/2/3 批次 |
| 2026-11-09 | 落地 Session-0/1 + inject；拍板主动开口不入 Session、摘要 inject、agents 软取 |
| 2026-11-10 | 落地 Session-1.5：create 带 `meta.cwd`、resume 用 `resumeSessionId`、工作区优先走 `ctx.workspaceRegistry`、会话标题固定「陪玩」；版本 0.2.7 |
| 2026-11-10 | Session-2：注册 `screen_look` / `glossary_lookup`（setup + agent.ctx；软载 defineTool） |
