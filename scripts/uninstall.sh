#!/bin/bash
# 从指定 dsh profile 卸载本插件（默认 desktop）。
# 用法： ./scripts/uninstall.sh [profile]
set -euo pipefail

PROFILE="${1:-desktop}"
case "$PROFILE" in
  *[!A-Za-z0-9._-]* | . | .. )
    echo "非法的 profile 名：${PROFILE}（只允许字母、数字、._-）" >&2
    exit 1
    ;;
esac
PKG_NAME="@caramel-geass/dsh-conversation-branches"
PROFILE_DIR="$HOME/.dsh/profiles/$PROFILE"
DEST="$PROFILE_DIR/node_modules/@caramel-geass/dsh-conversation-branches"

# 删目录前校验：路径必须正好是 <profile>/node_modules/<pkg>
case "$DEST" in
  "$HOME"/.dsh/profiles/*/node_modules/@caramel-geass/dsh-conversation-branches) ;;
  *)
    echo "拒绝删除意外路径：$DEST" >&2
    exit 1
    ;;
esac

if [ ! -d "$PROFILE_DIR" ]; then
  echo "找不到 profile 目录：$PROFILE_DIR" >&2
  exit 1
fi

rm -rf "$DEST"
echo "已删除 $DEST"

python3 - "$PROFILE_DIR/package.json" "$PKG_NAME" <<'PY'
import json, sys
path, name = sys.argv[1], sys.argv[2]
with open(path, encoding='utf-8') as fh:
    data = json.load(fh)
data.get('dependencies', {}).pop(name, None)
profile = data.get('dsh', {}).get('profile', {})
if isinstance(profile.get('bundles'), list):
    profile['bundles'] = [b for b in profile['bundles'] if b != name]
with open(path, 'w', encoding='utf-8') as fh:
    json.dump(data, fh, ensure_ascii=False, indent=2)
    fh.write('\n')
print('已更新 ' + path)
PY

echo
echo "完成。请重启 DeepSeek Harness 使改动生效。"
