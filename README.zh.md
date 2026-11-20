# conversation-branches（对话分支）

> 在阅读中随手提问：选中主对话里的任意文本，在右侧分支面板追问，不打断主对话。

本目录是**面向 DeepSeek Harness 0.2.x（当前 0.2.1-rc.3）的适配版**。它是可直接安装的双面包插件：
Host 端 `lib/index.js`（分支存取 + 模型问答）与 Client 端 `lib/client.js`（选区浮窗、右侧停靠面板、IM 气泡、流式输出）。

## 功能

- **选中即问** — 选中主对话文本 → 选区旁弹出输入框 → 提问（Enter 发送，Shift+Enter 换行）
- **右侧停靠面板** — 分支列停靠在窗口右侧，可拖拽左边缘调宽（300–560px），宽度会记住
- **IM 气泡** — 你的发言靠右（品牌色），模型回复靠左；回答流式输出并渲染 Markdown
- **追问** — 分支内可无限追问，每轮回答都基于「主对话 + 选中片段 + 分支已有问答链」
- **回跳定位** — 点击引用片段，主对话滚动到对应位置并以鹅黄色高亮选中文本
- **折叠** — 折叠后仅显示「选中片段 + 第一句话」，折叠状态持久化
- **数据可靠** — 分支写入 Harness 的 storage domain（JSON 后端，落在 `$DSH_HOME/storages`），重启不丢

## 0.2.x 适配要点（相对旧版）

| 旧版（0.1 / 0.2.0） | 本版（0.2.1-rc.3） |
| --- | --- |
| 分支作为 `fork/branch` 事件写进会话日志 | 改用 `ctx.storageDomain`（官方插件数据落点），不再污染会话日志 |
| 面板注册到 `details` 槽位 + `ctx.layout.openDetails()` | 0.2.x 已无 `details` 槽位，改为 `shell.overlay` 内自绘右侧停靠列 |
| Remote 描述符用 `codec.schema` | 0.2.x 校验要求 `codec.create()` 工厂，已改写 |
| 插件版本声明 `^0.1.0-rc.6` | 声明 `engines.dsh >= 0.2.1-rc.3`，否则 0.2.1 会以「不兼容」为由跳过加载 |

旧数据不会丢：首次读取某会话时，若 storage 中没有分支记录，会从该会话日志里只读回放旧的 `fork/branch` 事件并导入。

## 安装（当前桌面端）

前置：DeepSeek Harness **≥ 0.2.1-rc.3**（0.2.0 及 0.1 不兼容，会被版本闸门跳过）。用 `dsh --version` 或 App 的「关于」确认。

```bash
# 默认装进 desktop profile（也就是桌面 App 使用的 profile）
./scripts/install.sh            # 或： ./scripts/install.sh web
```

脚本会：把本目录复制到 `~/.dsh/profiles/<profile>/node_modules/@caramel-geass/dsh-conversation-branches/`，
并把包名加入该 profile `package.json` 的 `dependencies` 与 `dsh.profile.bundles`。

安装后需要**重启 App**（⌘Q 再打开），插件才会加载。

> 必须以「真实目录」安装，不要用软链接：Host 端 `import 'zod'` 等裸模块解析依赖包位于 profile 目录内。

## 卸载

```bash
./scripts/uninstall.sh          # 或： ./scripts/uninstall.sh web
```

## 结构

```
conversation-branches/
├── package.json        # 双面包声明：bundle patch + dsh.client
├── cordis.patch.yml    # 插入 Host 行
├── lib/
│   ├── index.js        # Host：ConversationBranchesService（load/save/ask/askPoll）
│   └── client.js       # Client：选区浮窗 + 右侧停靠面板（__ModuleLoader__ 产物）
├── locale/{zh,en}.json # 插件管理页显示标题/描述
├── icon.svg
├── scripts/{install,uninstall}.sh
└── src/                # 0.1 时期的 TypeScript 源码，仅作历史参考，不参与构建
```

> `lib/` 是**手写维护的发布产物**，不是 `src/` 的构建结果；改代码请直接改 `lib/` 并跑一次安装验证。

## 原理

- **Host**（`lib/index.js`）：`TypertRemoteService` 暴露 `load` / `save` / `ask` / `askPoll`；
  `ask` 通过 `sessionQuery.readSurface` 读取主对话当前模型表面，组装聚焦 prompt，
  用 `agentDefaultModel.currentSelection()` 的默认模型经 `llm.stream` 流式作答。
- **Client**（`lib/client.js`）：监听 `[data-conversation-scroll]` 内的选区，浮窗提问；
  面板由 `shell.overlay` 承载并停靠右侧；每 200ms 轮询 `askPoll` 取流式增量。

## License

MIT
