# dsh-laodi

陪玩 DSH 插件（Windows）：低频识屏建议、问答找攻略、帮忙记事、悬浮窗提醒。

## 分工
- 架构 / 计划 / 验收：Grok Bot「游戏助手」
- 具体实现：本机 DeepSeek Harness（DSH）

## 文档
- [docs/SPEC.md](docs/SPEC.md) — MVP 规格
- [docs/PLAN.md](docs/PLAN.md) — 开发计划与批次
- [docs/SESSION.md](docs/SESSION.md) — **多轮 Session / 聊天记忆（现行开发依据，可改）**
- [docs/ACCEPTANCE.md](docs/ACCEPTANCE.md) — 验收用例
- [docs/TASK_BATCH1.md](docs/TASK_BATCH1.md) — Batch 1 任务书

## 目录

```
src/
  index.mjs              宿主主循环（start / stop / runOnce）
  config.mjs             配置、校验、设置落盘
  paths.mjs              常用路径
  capture/
    powershell.mjs       PowerShell 调用封装
    window.mjs           前台窗口探测 + P5R 白名单
    screenshot.mjs       截屏到内存（不落盘）
  vision/client.mjs      OpenAI 兼容多模态调用（可 mock）
  policy/speak.mjs       少说规则（间隔/概率/静音/冷却/剧透）
  overlay/overlay.mjs    桌宠形象 + 气泡（无 Electron 时降级）
  data/knowledge.mjs     data/p5r 知识包加载 + 校验
data/p5r/                知识包：calendar / shop-items / glossary
runtime/overlay/         圆形形象、气泡、桌面闲聊输入框
scripts/
  smoke.mjs              离线冒烟测试
  smoke-policy.mjs       策略单测
```

## 开发

```bash
npm run smoke          # 离线冒烟（不启动游戏、不连网）
npm run smoke:policy   # 只跑策略单测
npm start              # 常驻宿主循环
npm run start:mock     # 视觉走 mock，跑一轮就退出
node src/index.mjs --probe   # 只看当前前台窗口是不是 P5R
```

需要 Node >= 20.10。仓库不带运行时依赖，`npm install` 不是必需步骤。

## 配置

复制 `.env.example` 为 `.env` 后填写视觉 API：

```bash
copy .env.example .env
node --env-file=.env src/index.mjs
```

| 变量 | 说明 |
| --- | --- |
| `DSH_VISION_BASE_URL` | OpenAI 兼容接口地址 |
| `DSH_VISION_MODEL` | 支持多模态的模型名 |
| `DSH_VISION_API_KEY` | 密钥；留空则自动走 mock |
| `DSH_VISION_MOCK` | `1` 强制 mock |
| `DSH_LAODI_DATA_DIR` | 设置落盘目录（默认 `%LOCALAPPDATA%\dsh-laodi`） |

没有 API Key 也能把宿主循环跑起来（视觉输出是 mock）。



## 设置卡片

装进 desktop 并重启后，设置里会出现 **「陪玩」** 分区：专用工作区、开关/识屏间隔/开口规则、Magpie 视觉模型、立刻试一轮 / 测一下视觉。配置落盘到 %USERPROFILE%\.dsh\dsh-laodi.json。

### 专用工作区（DSH Session）

陪玩相关对话建议都放在侧边栏单独的工作区里（类似「默认工作区」）：

1. 打开设置 → **陪玩** → **专用工作区**
2. 确认显示名 / 目录（默认 `%USERPROFILE%\Documents\deepseek-harness\dsh-laodi`）
3. 点 **确保工作区**

插件会：

- 创建目录，并写入 `persona/SOUL.md`、`persona/MEMORY.md` 占位（后续可接人设插件）
- 登记到 `%USERPROFILE%\.dsh\storages\workspace.json`，侧边栏「工作区」出现 **陪玩**
- 在设置里记下 `workspaceId`，方便以后把 Session / 人设 / 桌宠绑到同一处

默认人格预设是 **「老弟」**（`data/personas/laodi/`），可在设置里切换；写入工作区 `persona/SOUL.md`。人设插件（`personaPluginId`）与桌宠插件（`petPluginId`）字段仍预留，后续再对接。

### 陪玩会话落在哪

陪玩会话建出来时会带上工作区目录当 cwd（`ctx.agents.create({ meta: { cwd } })`）：

- 会话存到 `~/.dsh/sessions/<工作区目录>/`，侧边栏「陪玩」工作区里能直接看到（需先点「确保 Session」发开场，否则空白会话会被隐藏）；
- 没有 cwd 的老会话会落在 `~/.dsh/sessions/_no-cwd/`，DSH 不认它属于哪个工作区——插件检测到就会另建一条；
- 设置页的「多轮 Session」卡片会显示当前会话的落盘目录（cwd）与是否已挂到工作区。

DSH 宿主在时，工作区登记与挂载优先走官方 `ctx.workspaceRegistry`；拿不到（比如 CLI 单独跑）才退回写 `~/.dsh/storages/workspace.json`。

## 装进 DSH（desktop）

本机已支持作为 Cordis bundle 安装：

```bat
dsh plugin --profile desktop add D:\dshworkspace\dsh-laodi
```

装完后 **重启 DeepSeek Harness 桌面版**，插件会随 profile 加载并启动陪玩主循环。

卸载：

```bat
dsh plugin --profile desktop remove dsh-laodi
```

## 使用 DSH 已配置的大模型（Magpie）

可以。本机 DSH 走 Magpie 网关 `http://127.0.0.1:3425/v1`，支持识图的模型包括：

- `deepseek/deepseek-flash`
- `minimax-cn/MiniMax-M3.1-Flash`

不填 `.env` 时，宿主会自动读 `~/.dsh/settings.yaml` + `~/.dsh/.env` 里的 Magpie 配置。
也可显式写：

```bat
copy .env.example .env
REM 默认已是 Magpie 示例
node --env-file=.env src/index.mjs --once
node scripts/probe-magpie.mjs
```


## 当前状态

Batch 0 / Batch 1 已完成，详见 [docs/PLAN.md](docs/PLAN.md)。
