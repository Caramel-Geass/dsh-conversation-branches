# 安装与部署（DSH 0.2.x）

本包没有构建步骤：`lib/index.js` 与 `lib/client.js` 是手写维护的发布产物，仓库里直接提交，装好即可用。

## 一键安装

```bash
./scripts/install.sh            # 默认装进 desktop profile
./scripts/install.sh web        # 或指定其它 profile
./scripts/uninstall.sh          # 卸载
```

脚本做两件事：

1. 把包复制到 `~/.dsh/profiles/<profile>/node_modules/@caramel-geass/dsh-conversation-branches/`；
2. 在该 profile 的 `package.json` 里登记 `dependencies` 与 `dsh.profile.bundles`。

装完**重启 App**（⌘Q 后重开）才生效。之后只改 client 时，硬刷新页面（⌘⇧R）即可。

## 手动安装

```bash
PROFILE=desktop
DEST="$HOME/.dsh/profiles/$PROFILE/node_modules/@caramel-geass/dsh-conversation-branches"
mkdir -p "$DEST"
rsync -a --exclude src --exclude dynamic --exclude docs --exclude scripts . "$DEST/"
```

再编辑 `~/.dsh/profiles/$PROFILE/package.json`：

```json
{
  "dependencies": {
    "@caramel-geass/dsh-conversation-branches": "file:/abs/path/to/conversation-branches"
  },
  "dsh": { "profile": { "bundles": ["@deepseek-ai/dsh-base", "@deepseek-ai/dsh-web-app", "@caramel-geass/dsh-conversation-branches"] } }
}
```

也可以不选 bundle，改在 profile 的 `cordis.patch.yml` 里插一行：

```yaml
- insert:
    - id: conversation-branches
      name: '@caramel-geass/dsh-conversation-branches'
```

## 为什么必须是真实目录

Host 端的 `zod`、`@deepseek-ai/dsh-typert-protocol` 等裸模块靠 Node 从包所在位置向上解析；profile 目录之外的软链接会解析到目标真实路径，导致这些依赖找不到。**不要用 `ln -s` 安装。**

## 验证

1. 启动日志里没有 `failed to import` / `did not activate`；
2. 会话头部出现「分支」按钮；
3. 选中主对话文本 → 弹窗 → 提问 → 右侧面板出现分支；
4. 刷新页面后分支仍在（数据在 `$DSH_HOME/storages/conversation_branches.json`）。

## 数据与兼容

- 分支存在 storage domain `conversation_branches`，不写会话日志；
- 首次读取某个会话时，若 storage 没有记录，会只读回放旧的 `fork/branch` 会话事件并导入（0.1 版本遗留数据）。
