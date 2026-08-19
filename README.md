# @deepseek-ai/dsh-conversation-branches

对话分支(conversation branches)插件:在主对话中**选中一段文本**,即可在右侧详情列开启 IM 风格的独立问答分支。分支问答由流式模型生成、随会话持久化,支持追问、折叠、定位高亮与删除。

这是一个 **dsh bundle** 插件:包内声明了 `dsh.bundle`,`dsh plugin add` 后会自动成为 profile 的 composition 层,无需手写挂载配置。

## 功能特性

- **选区提问** — 选中主对话文本即弹出提问框,针对选中片段发起独立问答,不打断主对话
- **IM 气泡对话** — 分支以聊天气泡呈现,流式输出,支持同一分支内多轮追问
- **随会话持久化** — 分支以 `fork/branch` 事件写入会话自身的事件日志,与主对话同一持久化管线;重新加载会话时按事件顺序重放
- **定位高亮** — 点击分支卡片中的"选中片段"定位回主对话并短暂高亮
- **折叠 / 删除** — 分支卡片可折叠为一行,可删除

## 安装

作为 bundle 加入 profile:

```sh
dsh plugin --profile <name> add @deepseek-ai/dsh-conversation-branches
```

harness 会检测到该依赖声明了 `dsh.bundle`,自动把它追加进 profile 的 bundle 层。

也可以手动加入 profile 的依赖与 bundle 层:

```json
// <profile>/package.json
{
  "dependencies": {
    "@deepseek-ai/dsh-conversation-branches": "^0.1.0-rc.6"
  },
  "dsh": {
    "profile": {
      "bundles": [
        "@deepseek-ai/dsh-base",
        "@deepseek-ai/dsh-web-app",
        "@deepseek-ai/dsh-conversation-branches"
      ]
    }
  }
}
```

## 使用

1. 在主对话正文中选中一段文本
2. 弹出提问框,输入问题后回车(或点击"提问")
3. 右侧详情列出现分支面板,开始流式回答
4. 可继续"追问";点击"选中片段"定位回主对话;折叠或删除分支

## 工作原理

- **Host 端**(`lib/index.js`):`ConversationBranchesService`,暴露 `load / save / ask / askPoll` 四个 Remote 方法。`ask` 以主对话上下文 + 选中片段 + 分支历史构造提示词,后台消费 `llm.stream` 增量,`askPoll` 轮询取回;分支数据经 `save` 作为 `fork/branch` log-only 事件写入会话日志。
- **Client 端**(`lib/client.js`):注册到三个 slot:

  | Slot | 用途 |
  | --- | --- |
  | `conversation.session.header.utilities` | 分支面板开关按钮 |
  | `details` | 分支面板(优先级 -1,替换默认详情列) |
  | `shell.overlay` | 选区提问弹窗与文本高亮层 |

> **命名空间解析说明**:插件自挂载 `conversationBranches` Remote 命名空间。挂载者与本插件是**兄弟 fiber**,`ctx.remote.conversationBranches` 的 fiber-store 链解析不到它(自注入会死锁),因此统一通过 `ctx.get('remote.conversationBranches')` 走共享 reflect store 解析。

## 开发

```
conversation-branches/
├── lib/
│   ├── index.js            # Host 服务(构建产物)
│   ├── client.js           # Client 插件(构建产物)
│   └── types/              # 类型声明(.d.ts)
├── src/
│   ├── index.ts            # Host 服务源码
│   └── client.tsx          # Client 源码
├── cordis.patch.yml        # bundle patch(自插插件行)
├── package.json
├── README.md
└── LICENSE
```

运行依赖:`@deepseek-ai/dsh-session`、`@deepseek-ai/dsh-typert-protocol`;peer 依赖:`react`、`@deepseek-ai/dsh-client-connection`。

## License

[MIT](./LICENSE)
