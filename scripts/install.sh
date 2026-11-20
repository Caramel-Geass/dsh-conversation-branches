#!/bin/bash
# 把本插件安装到指定 dsh profile（默认 desktop，即桌面 App 使用的 profile）。
# 用法： ./scripts/install.sh [profile]
set -euo pipefail

PROFILE="${1:-desktop}"
case "$PROFILE" in
  *[!A-Za-z0-9._-]* | . | .. )
    echo "非法的 profile 名：${PROFILE}（只允许字母、数字、._-）" >&2
    exit 1
    ;;
esac
SRC="$(cd "$(dirname "$0")/.." && pwd)"
PKG_NAME="@caramel-geass/dsh-conversation-branches"
PROFILE_DIR="$HOME/.dsh/profiles/$PROFILE"
DEST="$PROFILE_DIR/node_modules/@caramel-geass/dsh-conversation-branches"

if [ ! -d "$PROFILE_DIR" ]; then
  echo "找不到 profile 目录：$PROFILE_DIR" >&2
  exit 1
fi

# 1) 以「真实目录」复制（不要软链接：裸模块解析需要包位于 profile 内）
rm -rf "$DEST"
mkdir -p "$DEST"
rsync -a \
  --exclude 'src' --exclude 'dynamic' --exclude 'docs' --exclude 'scripts' \
  --exclude '.git*' --exclude '.DS_Store' --exclude '*.log' \
  "$SRC/" "$DEST/"
echo "已复制到 $DEST"

# 2) profile 的 package.json：登记依赖 + 选择 bundle
python3 - "$PROFILE_DIR/package.json" "$PKG_NAME" "$SRC" <<'PY'
import json, sys
path, name, src = sys.argv[1], sys.argv[2], sys.argv[3]
with open(path, encoding='utf-8') as fh:
    data = json.load(fh)
deps = data.setdefault('dependencies', {})
deps[name] = 'file:' + src
profile = data.setdefault('dsh', {}).setdefault('profile', {})
bundles = profile.setdefault('bundles', ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app'])
if name not in bundles:
    bundles.append(name)
with open(path, 'w', encoding='utf-8') as fh:
    json.dump(data, fh, ensure_ascii=False, indent=2)
    fh.write('\n')
print('已更新 ' + path)
PY

echo
echo "完成。请重启 DeepSeek Harness（⌘Q 后重新打开）以加载插件。"
