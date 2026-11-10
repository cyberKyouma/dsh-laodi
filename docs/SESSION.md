# 多轮会话（DSH Session）开发备忘

> **用途**：后续会话 / 聊天记忆相关开发，以本文为准；可随时改勾选与优先级。  
> **关联**：[SPEC.md](./SPEC.md)（产品规格）· [PLAN.md](./PLAN.md)（总批次）· [ACCEPTANCE.md](./ACCEPTANCE.md)  
> **状态**：Session-0/1/1.5 已落地；Session-2 inject + 基础工具已通；§10 已拍板；**§11 桌宠跟随已拍板**。Session-5 主流程代码已接（圆形静态图、桌面驻留、进游戏跟随、形象旁气泡、桌面闲聊不识屏）；§4.6 / §8 实机勾选仍待 Windows 桌面验收。动画以后再做。  
> **更新**：2026-11-10  

---

## 1. 目标

把陪玩从「单次 `askOnce`」改成一个可跟随的桌面伙伴：

1. **桌宠跟随**：平时待在桌面上，可闲聊、可记以游戏为主的待办；进入 P5R 后，同一形象跟到游戏画面上；离开游戏回到桌面。
2. **游戏中有感知**：识别当前在做什么，记住进度（日程、迷宫、限时），并给出下一步建议；默认不剧透。
3. **对话落在 DSH Session**（`~/.dsh/sessions/.../session-*.json`），可在侧边栏「陪玩」工作区里打开、续聊、回看。
4. **有聊天记忆**：短期靠 Session transcript；长期可另存 sidecar（偏好 / 约定 / 进度摘要）。
5. **游戏能力仍在**：识屏、少说、剧透档、知识包、提醒 —— 作为工具或 inject 上下文进入同一条 Session。
6. **游玩时的主路径**：热键语音提问；回答以形象旁叠字 + 语音为主。DSH 侧栏用于回看和调试，不是第一界面。

非目标（本文阶段不做，除非勾进下方批次）：

- [ ] 自研完整聊天 UI（优先用形象旁出字 + DSH 侧栏回看）
- [ ] 正式人设、定制立绘与形象动画（第一版先放一张圆形静态图，人设和动画以后再定）
- [ ] 接入或重做独立 `dsh-pet`（本插件自己做可跟随形象，不必先依赖它）
- [ ] 日常非游戏待办（待办以游戏事项为主）
- [ ] 桌面阶段主动识屏（桌面上只闲聊和待办；识屏放在游戏中）

语音（ASR / TTS）与全局热键已纳入 **§5 Session-4**，不再作为非目标。

---

## 2. 现状快照

| 能力 | 现状 |
| --- | --- |
| 专用工作区「陪玩」 | ✅ 已登记 `workspace.json`，路径可配 |
| 人格预设「老弟」 | ✅ `data/personas/laodi/` → 工作区 `persona/SOUL.md`；**尚未**挂进 Session system；第一版**不绑定**该立绘 |
| 识屏主循环 + 少说 | ✅ `src/index.mjs` + `policy/speak.mjs` |
| 单次问答 | ✅ `askOnce`；CLI `--ask-once=` |
| 多轮问答 | ✅ `askCompanion` → Session `followup`；失败回退 `askOnce` |
| 收藏 | ✅ `favorites.json`（不是对话记忆） |
| 创建 / resume DSH Session | ✅ `src/host/session.mjs`（agents 软取） |
| `followup` / `inject` 进 Session | ✅ 提问前 inject 识屏摘要 + glossary |
| Session 内游戏工具 | ✅ `screen_look` / `glossary_lookup`（create/resume setup 注册；无 defineTool 则跳过） |
| 游戏提醒 | ⚠️ 已有 reminders（日历/限时），尚未挂到桌宠形象上 |
| 长期记忆 sidecar | ❌（仅有 SOUL / MEMORY 占位） |
| 进度一等状态 inject | ❌ 标定变更尚未 inject；palace 状态待补齐 |
| 热键 / ASR / TTS | ❌ 热键未接；TTS 仍按旧 SPEC 默认关，与已拍板主路径不一致 |
| 可跟随桌宠形象 | ⚠️ 代码已接（圆形静态图、跟随游戏窗、形象旁气泡、桌面闲聊）；Windows 桌面实机未验 |
| 叠层作为回答主出口 | ❌ 叠层目前以短气泡 / 提醒为主，完整回答还在侧栏 |

---

## 3. 目标架构（已拍板）

```
平时（桌面）
  圆形静态形象 ── 闲聊 / 游戏待办（日程、迷宫、限时）
       │ 进入 P5R                    │ 离开游戏
       ▼                             │
游戏画面上的同一形象（跟随游戏窗） ◄────┘
  识屏记进度、建议、待办
  热键语音提问 → 形象旁叠字 + 语音
       │
       ▼
┌─────────────────────────────┐
│ 陪玩 Session（一条固定 id）   │
│  system: harness + 部署persona │
│         + dsh-laodi:soul      │  ← 人设正式定稿后再强化
│  tools: screen_look / glossary│
│  游戏态: date / slot / palace │
└────────────┬────────────────┘
             │
             ▼
        侧栏回看 / 调试

主动开口（少说闸门通过后，仅高价值节点）：
  考试 / 时限 / 迷宫 deadline
  → 形象旁气泡 + 短旁白 inject（不 followup、不刷屏）
```

**记忆分层：**

| 层 | 载体 | 内容 |
| --- | --- | --- |
| 人设 | `persona/SOUL.md` → system 段 `dsh-laodi:soul` | 说话方式、剧透边界；**第一版视觉为圆形静态图，不锁定人设**，正式人设以后再定 |
| 短期 | DSH Session transcript | 多轮问答、本局上下文、桌面闲聊 |
| 游戏态 | 宿主 state / inject | gameDate、timeSlot、palace、scene、剧透档；变更时 inject |
| 游戏待办 | reminders + 形象旁展示 | 日程、迷宫、限时活动；可完成 / 忽略 |
| 主动开口痕迹 | 短 inject 旁白（选项 C） | 开口成功后一行摘要；下次提问能接上 |
| 长期 | `persona/MEMORY.md` 等 | 跨天偏好、约定、进度摘要（后做） |

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

### 4.3 游戏上下文进 Session — P1（已拍板，待实现；排在形象之后）

- [ ] 主动开口改为选项 C：开口成功后气泡 + 短旁白 inject（不 followup）
- [ ] 标定 `gameDate` / `timeSlot` / `palace` 变更时 inject
- [ ] 主动开口只在考试、时限、迷宫 deadline 等高价值节点触发
- [ ] 游戏待办（日程、迷宫、限时）挂到形象旁，可完成 / 忽略
- [ ] 人设 SOUL 挂 `dsh-laodi:soul`（人设未正式定稿前可轻量接入，不挡形象与待办）

### 4.4 Session 内工具 — P1

- [x] `screen_look`：强制识一屏，返回结构化 JSON 摘要
- [x] `glossary_lookup`：查知识包
- [ ] `reminders_list` / `calibrate_date`（接到桌宠待办后做）
- [x] 工具描述强调剧透档 / 少说边界

### 4.5 聊天记忆（长期）— P2

- [ ] 明确 MEMORY 写入策略（谁写：模型工具 vs 宿主摘要）
- [ ] Session 压缩 / 过长时的摘要回流 MEMORY
- [ ] 正式人设与形象定稿后再强化 SOUL

### 4.6 桌宠跟随 — P0（代码已接，Windows 实机未勾）

- [ ] 桌面上出现一个圆形静态图形象（先放一张图做成圆形，可拖动，不挡操作；不做动画）
- [ ] 进入 P5R 后，形象跟到游戏窗口上；离开游戏回到桌面
- [ ] 形象旁出短气泡 / 叠字（同一套出口，不另做一套聊天窗）
- [ ] 桌面上可闲聊，走同一条陪玩 Session
- [ ] 桌面阶段不主动识屏

### 4.7 UI / 入口 — P1（语音主路径，排在形象与待办之后）

- [x] 设置：Session 状态 + 重置
- [ ] 全局热键提问（默认 Ctrl+Shift+Space）
- [ ] ASR：语音提问，失败可打字
- [ ] TTS：回答同时出语音（与形象旁叠字一起，不再默认关闭）
- [ ] Session 回复同步到形象旁叠字；侧栏保留回看 / 调试
- [ ] 气泡 / 叠字展示本轮 Session 回复（监听 turn 完成；现尽力 `extractAssistantReply`）

### 4.8 策略与风险 — 全程注意

- [x] 用户提问：必须答；主动开口：仍走少说（间隔/概率/静音场景）— 现行为只气泡；**改为选项 C 后**仍不 followup
- [x] 截图：默认摘要进 Session；`sessionAttachImages` 开关预留（附件路径后做）
- [x] 剧透：默认只给下一步、不剧透；用户明确要详细再升级
- [ ] 若本机同时加载 `dsh-pet`：避免两个形象同时出现或抢话（实现时检测并给出关闭其一的说明）
- [ ] token / 压缩：依赖 DSH compact；过长则宿主摘要
- [x] `ctx.agents` 不可用时的降级：回退 `askOnce` + `mode` / `sessionError` 提示

---

## 5. 建议批次（可改）

### Session-0 — 探测与设计冻结

- [x] 冻结 agents 接入方式：软取，不硬 `inject: ['agents']`
- [x] 冻结：主动开口是否入 Session → 先定为不入，**2026-11-10 改拍板为选项 C**
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
- [ ] 气泡短句（完善 extract；主出口改到形象旁，见 Session-5 / 4）
- [ ] SOUL 进 system（人设未定稿，不作为下一步第一项）

### Session-5 — 打通桌宠主流程（代码已接，实机未勾）

当前优先把主流程打通，第一版形象先简单放一张图、做成圆形，不做动画；动画和立绘后续再设计。

1. **桌面上的圆形静态形象**（一张图裁成圆形；可拖动、置顶、不挡操作；不绑定「老弟」立绘）
2. **进入 P5R 后跟随到游戏窗口**；离开游戏回到桌面
3. **形象旁出短气泡 / 叠字**，复用并升级现有 overlay，不另起一套聊天窗
4. **桌面上可闲聊**，走同一条陪玩 Session；桌面阶段不主动识屏

实现放在本插件内（从 `src/overlay/` 升级），不必先接入 `dsh-pet`。本批次不做走路、眨眼等动画。

### Session-2 收尾 + 游戏待办 — 接在形象之后

形象能跟上之后，再把「记得住、用得上」接上：

1. **标定 `gameDate` / `timeSlot` / `palace` 变更时 inject**
2. **游戏待办挂到形象旁**：日程、迷宫、限时活动；可完成 / 忽略（接现有 reminders）
3. **主循环开口成功 → 短 inject（选项 C）**；开口失败或 Session 不可用时只气泡，不挡开口
4. **收紧主动开口时机**：只在考试、时限、迷宫 deadline 等高价值节点开口
5. （可后做）轻量挂上 `dsh-laodi:soul`，仅作说话约束，不锁定视觉人设

### Session-4 — 游戏内主路径（语音 + 叠字）

在形象与待办之后做：

- [ ] 全局热键提问（默认 Ctrl+Shift+Space）
- [ ] ASR：语音提问，不用停下来打字；失败可打字
- [ ] TTS：回答同时出语音，与形象旁叠字一起给（不再默认关闭）
- [ ] Session 回复同步到形象旁叠字；侧栏保留回看 / 调试
- [ ] 同步更新 [SPEC.md](./SPEC.md) / [ACCEPTANCE.md](./ACCEPTANCE.md) 中与语音、TTS、主界面、桌宠相关的旧表述

### Session-3 — 记忆与人设打磨

- [ ] MEMORY 长期记忆（跨天偏好、约定、进度摘要）
- [ ] 正式人设与形象定稿
- [ ] 进度一等状态打磨，主动对齐日程与迷宫
- [ ] 更新 ACCEPTANCE / SPEC 中与会话、记忆、桌宠相关的条目

---

## 6. 已拍板

> 开发中达成一致就写进这里，避免口头约定丢失。

| 议题 | 结论 | 日期 |
| --- | --- | --- |
| 对话载体 | 用 DSH Session，不自建第二套 chat store 当主 transcript | 2026-11-09 |
| 工作区 | 对话归「陪玩」工作区 | 2026-11-09 |
| 默认人格 | 文案预设仍可沿用「老弟」SOUL 作说话约束，但**第一版不绑定该立绘**；正式人设以后再定 | 2026-11-10 修订 |
| 主动开口是否入 Session | **选项 C**：开口成功后出气泡，并 `inject` 一行短旁白（不 `followup`、侧栏不刷屏）；下次提问能接上。原 11-09 选项 B（只气泡、不入 Session）作废 | 2026-11-10 |
| 截图默认 | **只 inject 文字摘要**；`sessionAttachImages` 默认 false（2026-11-10 再次确认） | 2026-11-09 |
| agents 依赖 | **软取** `optionalService(ctx,'agents')`，不硬 inject | 2026-11-09 |
| agents 不可用 | 回退 `askOnce`，结果带 `mode` / `sessionError` | 2026-11-09 |
| 会话 cwd | **= 「陪玩」工作区目录**（`ctx.agents.create({ meta: { cwd } })`）；没 cwd 的会话会落到 `~/.dsh/sessions/_no-cwd/` | 2026-11-10 |
| 老会话 cwd 不对 | 丢弃并另建（不硬用）：工作区成员资格要拿 header.cwd 比对 | 2026-11-10 |
| resume 参数名 | `ctx.agents.resume({ resumeSessionId })` | 2026-11-10 |
| 工作区登记/挂载 | 优先官方 `ctx.workspaceRegistry`；拿不到才写 `workspace.json` | 2026-11-10 |
| 会话标题 | 固定「陪玩」（`ctx.sessionTitle.rename`，只在没有标题时设） | 2026-11-10 |
| 玩家主路径 | 可跟随的桌宠形象是第一界面；PC 上玩 P5R 时热键语音提问，回答以形象旁叠字 + 语音为主；DSH 侧栏用于回看和调试 | 2026-11-10 修订 |
| 进度状态 | `gameDate` / `timeSlot` / `palace` 作为一等状态；变更时 inject 进 Session，主动对齐日程与迷宫 | 2026-11-10 |
| 主动提醒时机 | 只在考试、时限、迷宫 deadline 等高价值节点开口，不做碎碎念 | 2026-11-10 |
| 剧透 | 默认只给下一步、不剧透；用户明确要详细再升级 | 2026-11-10 |
| 人设进 system | 仅在陪玩这条 Session 的 `setup` 里追加 `dsh-laodi:soul` 段；只写 `agent.ctx`，不写全局 `ctx.systemPrompt`；禁止 `complete: true`。实现排在形象与待办之后，不挡 Session-5 | 2026-11-10 |
| 桌宠位置 | 平时待在桌面；进入 P5R 后跟到游戏画面上；离开游戏回到桌面 | 2026-11-10 |
| 第一版形象 | 先放一张图，做成圆形静态头像；不做动画。当前优先打通主流程。人设和立绘以后再定，不绑定「老弟」立绘 | 2026-11-10 修订 |
| 桌面能力 | 可闲聊，也帮记待办；桌面阶段不主动识屏 | 2026-11-10 |
| 待办范围 | 以游戏事项为主：日程、迷宫、限时活动 | 2026-11-10 |
| 桌宠实现 | 在本插件内从 overlay 升级，不必先接入 `dsh-pet` | 2026-11-10 |

---

## 7. 关键文件

| 路径 | 角色 |
| --- | --- |
| `src/overlay/overlay.mjs` | 桌宠形象 + 气泡 / 叠层（从短气泡窗升级为可跟随形象） |
| `runtime/overlay/` | 形象与气泡页面 |
| `src/host/session.mjs` | Session ensure/resume/followup/inject；create/resume `setup` 挂工具与 SOUL |
| `src/host/companion-tools.mjs` | `screen_look` / `glossary_lookup` 定义与注册 |
| `src/index.mjs` | `host.lookScreen` / `getKnowledge` 供工具调用；CLI `--ask` / `--ask-once`；前台窗口变化时切换桌宠位置 |
| `src/ask/ask.mjs` | `askCompanion` + `askOnce` |
| `src/dsh-plugin.mjs` | `/session*`、`/ask`、挂 session 到 host |
| `src/policy/speak.mjs` | 少说规则；收紧高价值开口时机 |
| `src/reminders/store.mjs` | 游戏待办（日程、迷宫、限时） |
| `src/host/settings-store.mjs` | `companionSessionId`、`sessionAttachImages` |
| `src/host/workspace.mjs` | `attachSessionToWorkspace` + `ensureCompanionWorkspaceViaHost`（官方注册表优先） |
| `client.js` | Session 状态 UI |
| `docs/ACCEPTANCE.md` | 补多轮 / 语音 / 桌宠 / 叠层用例（待） |
| `docs/SPEC.md` | 会话 / 记忆 / 桌宠主路径写入规格（待同步） |

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
- [ ] 陪玩 Session 请求的 system 中含 SOUL 关键句；其他工作区 Session 不含（人设接入后）
- [ ] 主动开口后侧栏**不**多出一轮完整 user/assistant 对话；但随后用户提问能引用「刚才提醒过的内容」（inject 旁白可见）
- [ ] 提问默认 transcript / inject 无原图；`sessionAttachImages` 关时行为不变
- [ ] 与 dsh-pet 同时加载时，不报 system 组装错误；并尽量避免两个形象抢话
- [ ] 未进入 P5R 时，圆形静态形象停在桌面，可闲聊，不主动识屏（Session-5）
- [ ] 进入 P5R 后形象跟到游戏窗口上；离开游戏回到桌面（Session-5）
- [ ] 游戏待办（日程 / 迷宫 / 限时）能在形象旁看到，并可完成或忽略
- [ ] 热键语音提问后，形象旁出字，同时播放语音（Session-4）

---

## 9. 修订记录

| 日期 | 说明 |
| --- | --- |
| 2026-11-09 | 初稿：缺口分析 + Session-0/1/2/3 批次 |
| 2026-11-09 | 落地 Session-0/1 + inject；拍板主动开口不入 Session、摘要 inject、agents 软取 |
| 2026-11-10 | 落地 Session-1.5：create 带 `meta.cwd`、resume 用 `resumeSessionId`、工作区优先走 `ctx.workspaceRegistry`、会话标题固定「陪玩」；版本 0.2.7 |
| 2026-11-10 | Session-2：注册 `screen_look` / `glossary_lookup`（setup + agent.ctx；软载 defineTool） |
| 2026-11-10 | 新增 §10：人设进 system / 主动开口选项 C / 提问识屏摘要 设计草案（待确认后改「已拍板」） |
| 2026-11-10 | **§10 已确认并写入 §6**：人设 `dsh-laodi:soul`、主动开口改选项 C、提问默认仅摘要；同时拍板游戏内语音+叠字主路径、进度一等状态、高价值节点才主动开口、默认不剧透。 |
| 2026-11-10 | **§11 桌宠跟随已拍板**：平时在桌面、进游戏跟随；第一版用轻量卡通形象，人设以后再定；桌面可闲聊并记游戏待办（日程/迷宫/限时），桌面不主动识屏。下一步改为 Session-5 → 进度与待办 / 选项 C → Session-4 语音 → Session-3 记忆与人设。SPEC / ACCEPTANCE 待同步。 |
| 2026-11-10 | **第一版形象改为圆形静态图**：先放一张图做成圆形，不做动画；Session-5 优先打通主流程（桌面驻留、进游戏跟随、形象旁气泡、桌面闲聊）。 |
| 2026-11-10 | Session-5 实现：圆形静态形象、桌面驻留 / 进 P5R 跟随、形象旁气泡、桌面闲聊走同一 Session 且不主动识屏。§4.6 与 §8 实机项仍不勾，等 Windows 桌面验收。 |

---

## 10. 人设 · 主动开口 · 识屏进 Session（已拍板）

> **状态：已拍板。** 结论已写入 §6。实现顺序以 §5 为准：先做 Session-5 形象，再做进度 / 待办 / 选项 C；SOUL 接入不挡前面两步。  
> 对照：同类桌宠/companion（Zuiti、clawd-soul、OpenClaw heartbeat、dsh-pet）普遍是「人设常驻 + 画面摘要 + 主动少说/可静默」，很少把周期碎碎念整段刷进主对话。

### 10.1 要解决的问题

原选项 B（主动开口只气泡、不入 Session）会让：

- 侧栏「陪玩」对话有记忆，气泡碎碎念几乎没记忆；
- 人设 SOUL 只在工作区文件里，Session 侧还没进 system；
- 两套脑：主循环本地拼气泡 vs Session followup。

提问侧已有「识屏摘要 inject + `screen_look`」；缺的是**共用人格**和**主动开口与 Session 的轻量衔接**。

### 10.2 目标架构

```
                    ┌─────────────────────────────┐
                    │ 陪玩 Session（一条固定 id）   │
                    │  system: harness + 部署persona │
                    │         + dsh-laodi:soul      │  ← 人设只挂这条 agent
                    │  tools: screen_look / glossary│
                    └────────────▲────────────────┘
                                 │
          ┌──────────────────────┼──────────────────────┐
          │                      │                      │
   用户提问 /ask            主动开口（主循环）      标定变更等
   识屏摘要 inject          气泡 + 短旁白 inject    游戏态 inject
   → followup（唤醒）       （inject 不唤醒）         （不唤醒）
          │                      │
          ▼                      ▼
     形象旁叠字 + 语音        侧栏不刷屏；下次提问能看见「刚才说过」
     （侧栏可回看）
```

记忆分层（与 §3 对齐，细化主动开口）：

| 层 | 载体 | 谁写 | 模型何时看见 |
| --- | --- | --- | --- |
| 人设 | `persona/SOUL.md` → system 段 `dsh-laodi:soul` | 宿主 setup | 该 Session 每次请求 |
| 游戏态 | inject / 宿主 state | 标定、场景变化 | 下一轮组装 |
| 主动开口痕迹 | **短 inject 旁白**（选项 C） | 主循环开口成功后 | 下一轮提问/续聊 |
| 用户对话 | Session transcript | followup | 完整历史 |
| 画面（提问） | 文字摘要 inject；可选附件开关 | 提问链路 | 当轮 |
| 长期 | `MEMORY.md`（后做） | 巩固策略后定 | 预算内 |

### 10.3 人设进 system

**做法**

1. 在 `agents.create` / `resume` 的 `setup(agentCtx)` 里（与工具同一处）：
   ```text
   agentCtx.systemPrompt.section({
     name: 'dsh-laodi:soul',
     order: <选一个不踩官方固定段的中段值，如 50>,
     text: <读工作区 persona/SOUL.md，缺则用预设 laodi>,
   })
   ```
2. **仅** `agent.ctx`，不写全局 `ctx.systemPrompt`。
3. **禁止** `complete: true`（避免吞掉 harness / 部署 persona）。
4. 段名固定 `dsh-laodi:soul`，避免和官方段、其他插件同名互踩。

**与系统 / 桌宠冲突**

| 对象 | 会不会冲突 | 说明 |
| --- | --- | --- |
| DSH harness / 部署 persona | 否（正常） | 我们是追加段，不是替换整份 system |
| 其他 Session | 否 | 作用域只绑陪玩这条 agent |
| 本插件桌宠形象 | 否 | 形象是本插件 UI；人设以后再定，第一版视觉不绑「老弟」 |
| 独立 dsh-pet | 体验上可能 | 若同时加载，可能出现两个形象或抢话——实现时检测并避免 |

**主动开口要不要读 SOUL**

- Session 内提问：接入后自然带 SOUL。
- 主循环气泡：今日仍可本地短生成；中期可改为「读同一份 SOUL 摘要 + 画面摘要」拼气泡，**不必**为气泡再跑一整轮 Session assistant。

### 10.4 主动开口：选项 C

| 方案 | 行为 | 评价 |
| --- | --- | --- |
| A 全量入 Session | 每次开口 followup 一轮 | 侧栏刷屏、token 高 |
| B 只气泡（已作废） | 不入 Session | 省，但与提问记忆断裂 |
| **C 气泡 + 短 inject** | 开口成功 → 气泡；并 `agent.inject` 一行旁白，**不** `followup` | **已拍板**：连贯且不刷屏 |

**C 的旁白格式（示例，≤约 80 字）**

```text
[陪玩主动] 04/17 课后 · street · 「去花坛看看」
```

规则：

- 仅在少说闸门**通过并真正开口**后 inject；不开口不写。
- 主动开口只在考试、时限、迷宫 deadline 等高价值节点触发。
- `inject` 不唤醒模型；下次用户提问 / 侧栏续聊时进入历史。
- 「立刻试一轮」仍可保持不入 Session（调试入口），或与主循环同一套 C（实现时二选一，默认与主循环一致更简单）。
- Session 未 ensure / agents 不可用：只气泡，inject 失败则记日志，不挡开口。

**不在 C 里做的事**

- 不为碎碎念再调一次大模型写「对话回复」进 transcript（那是 A）。
- 不把周期识屏的每一次 vision JSON 都 inject（噪声）；只在**开口那一次**带短摘要。

### 10.5 提问时的截图

维持并写清：

| 项 | 结论 |
| --- | --- |
| 默认 | **只 inject 文字摘要**（scene / summary / suggestion / 日期），与 SPEC「截图不落盘、入库摘要」一致 |
| 原图 | 仅当 `sessionAttachImages === true` 走附件（后做完整路径）；默认 false |
| 不够看时 | 模型调已有 `screen_look` 再识一屏 |
| 主动开口 | 不塞原图；旁白里最多带一句话面摘要 |
| 桌面闲聊 | 不主动截屏、不 inject 画面摘要 |

### 10.6 实现顺序

见 §5：先 Session-5 形象，再进度 / 待办 / 选项 C，再语音；SOUL 接入不挡前两步。

### 10.7 验收（本设计）

见 §8 中与 SOUL 作用域、选项 C 不刷屏、默认无原图、桌宠跟随相关的条目。

### 10.8 确认记录

1. 主动开口：**接受选项 C**（已拍板）。
2. 提问截图：**默认仅摘要**（已拍板）。
3. 人设：按 **agent 作用域 `dsh-laodi:soul`** 做（已拍板，实现后置）；第一版视觉不锁定人设。

---

## 11. 桌宠跟随（已拍板）

> **状态：已拍板。** 结论已写入 §6；实现按 §5「Session-5」先打通主流程，第一版只用圆形静态图。

### 11.1 形态

- 平时：圆形静态形象停在桌面，可拖动、置顶，不挡操作。
- 进入 P5R：同一形象跟到游戏窗口上（跟随窗口位置 / 显示器，不另开一个无关角色）。
- 离开 P5R：回到桌面。
- 第一版先放一张图片，做成圆形静态头像；不做走路、眨眼等动画。人设和立绘以后再定，不绑定「老弟」立绘。

### 11.2 能力分层

| 场景 | 做什么 | 不做什么 |
| --- | --- | --- |
| 桌面 | 闲聊；展示和记录以游戏为主的待办 | 不主动识屏；不优先记日常杂事 |
| 游戏中 | 识别当前在做什么；记录进度；给下一步建议；记下日程 / 迷宫 / 限时事项 | 默认不剧透；不在对话、过场里抢话 |

### 11.3 与现有 overlay 的关系

`src/overlay/` 原先是短气泡窗。Session-5 已把它升级为「形象 + 气泡」，而不是旁边再做一套桌宠，也不是先去对接独立的 `dsh-pet`。若本机已加载 `dsh-pet`，会暂停本插件形象并提示关闭其中一个。

### 11.4 验收

见 §8 中 Session-5 与游戏待办相关条目。
