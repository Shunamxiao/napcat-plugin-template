#!/usr/bin/env bash
# 部署 napcat-plugin-autoreply 到 mi8 一号实例（acc-main），并校验设备上跑的确实是本地 HEAD 的构建。
#
#   bash scripts/deploy.sh            # 构建 → 覆盖 → 重启 → 校验 build 等于 git HEAD
#   bash scripts/deploy.sh --check    # 只校验不部署（巡检调用）
#   SKIP_WEBUI_SMOKE=1 bash scripts/deploy.sh   # 跳过页面自检（没有可用 Chromium 时）
#
# 退出码：0 一致/部署成功；3 设备构建与本地 HEAD 不一致；4 取不到设备构建（实例没起/网络不通）；
#         5 页面自检失败（构建产物渲染不出来或关键控件缺失）
# 起因（2026-11-08）：设备上的 webui/index.html 停在 11-06，服务端是新代码、页面是旧页面，
# 保存全 404，没人能看出来；当时产物里没有版本信息，只能靠 md5 猜。
set -euo pipefail

cd "$(dirname "$0")/.."

HOST=${MI8_SSH_HOST:-mi8}
ROOTFS=/data/data/com.termux/files/usr/var/lib/proot-distro/containers/napcat/rootfs
PLUGIN_DIR=$ROOTFS/root/Napcat/opt/QQ/resources/app/app_launcher/napcat/plugins/napcat-plugin-autoreply
STATUS_URL=http://127.0.0.1:6099/plugin/napcat-plugin-autoreply/api/status
SHA=$(git rev-parse --short HEAD)

# 设备上正在跑的构建戳；取不到回空
device_build() {
    ssh -o BatchMode=yes -o ConnectTimeout=8 "$HOST" "curl -s -m 5 '$STATUS_URL'" 2>/dev/null \
        | sed -n 's/.*"build":"\([^"]*\)".*/\1/p' | head -1
}

if [ "${1:-}" = "--check" ]; then
    build=$(device_build || true)
    if [ -z "$build" ]; then
        echo "取不到设备构建（实例未就绪或 ssh 不通）：$STATUS_URL" >&2
        exit 4
    fi
    case "$build" in
        *-dirty-*) echo "漂移：设备 build=$build 是未提交改动构建的产物（本地 HEAD=$SHA）" >&2; exit 3 ;;
        "$SHA"-*)  echo "一致：设备 build=$build，本地 HEAD=$SHA"; exit 0 ;;
        *)         echo "漂移：设备 build=$build，本地 HEAD=$SHA（部署：bash scripts/deploy.sh）" >&2; exit 3 ;;
    esac
fi

echo "== 1/5 构建"
pnpm -s build

# 构建戳必须落进产物，否则下面的校验没有意义
if ! grep -q "$SHA-" dist/index.mjs; then
    echo "构建产物里没有 HEAD 戳 $SHA-，构建配置有问题（vite define __BUILD_ID__）" >&2
    exit 1
fi
# 未提交的工作区部署上去会以「build == HEAD」伪装成干净版本，默认拒绝
if grep -q "$SHA-dirty-" dist/index.mjs && [ "${1:-}" != "--allow-dirty" ]; then
    echo "工作区有未提交改动：先 commit，或显式跑 bash scripts/deploy.sh --allow-dirty" >&2
    exit 1
fi
for f in dist/index.mjs dist/webui/index.html; do
    [ -s "$f" ] || { echo "缺产物：$f" >&2; exit 1; }
done

echo "== 2/5 覆盖设备插件目录"
# Termux 侧没有 /tmp：tar 走 stdin 直接解到插件目录，先留一份 index.mjs 备份
tar czf - -C dist index.mjs webui | ssh -o BatchMode=yes "$HOST" "
    set -e
    cd $PLUGIN_DIR
    cp index.mjs index.mjs.bak-\$(date +%Y%m%d) 2>/dev/null || true
    tar xzf -
    ls -l --time-style=+%F_%T index.mjs webui/index.html
"

echo "== 3/5 重启实例"
ssh -o BatchMode=yes "$HOST" 'bash ~/restart-main.sh' || true

echo "== 4/5 等 /status 就绪（最多 180s）"
build=""
for _ in $(seq 1 36); do
    build=$(device_build || true)
    if [ -n "$build" ]; then break; fi
    sleep 5
done
if [ -z "$build" ]; then
    echo "实例 180s 内没回 /status——按知识库「MI8 QQ 实例与插件配置运维」的手动恢复步骤拉 instance.sh" >&2
    exit 4
fi

echo "== 5/6 校验"
case "$build" in
    "$SHA"-*) echo "设备 build 校验通过：$build" ;;
    *)       echo "部署后 build 仍不一致：设备=$build 本地=$SHA（多看几秒，若重启没吃新文件就是解包路径错了）" >&2; exit 3 ;;
esac

# 6/6 页面自检：拿本地同一份 dist 在无头 Chromium 跑一遍 8 个页面。
# build 戳只证明文件到了设备，不证明页面能渲染（11-06 那次就是页面旧了没人知道）。
echo "== 6/6 WebUI 渲染自检"
if [ "${SKIP_WEBUI_SMOKE:-0}" = "1" ]; then
    echo "已按 SKIP_WEBUI_SMOKE=1 跳过"
elif [ ! -e "${CHROME_PATH:-/root/cchrome-web/kernel/ungoogled-chromium-150.0.7871.186-1-x86_64_linux/chrome}" ]; then
    echo "没找到 Chromium（CHROME_PATH），跳过页面自检" >&2
else
    node scripts/webui-smoke.mjs || { echo "页面自检失败：页面渲染/控件断言没过，别当成部署成功" >&2; exit 5; }
    echo "部署完成：设备 build=$build，页面自检通过"
fi
