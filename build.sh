#!/bin/sh
# 一键构建/部署/清理（POSIX sh；npm 机制只用于 frontend/ 内部，根目录编排全 shell）
# 语义同 make：产物 ccweb 出在项目根目录，与源码同级
# ./build.sh                    构建：frontend vite → 根目录 ./ccweb（单文件）
# ./build.sh deploy | install   构建 + 部署：装 /usr/local/ccweb + systemd 重启 + 健康检查
# ./build.sh clean              清产物：./ccweb + frontend/dist + cargo target（下次全量重建）
# CCWEB_NO_RUST=1 ./build.sh    只出前端（deploy 恒全量，装机器需要单文件）
# CCWEB_PORT=xxx ./build.sh deploy   部署端口（默认 18090）
set -eu
root=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
mode=${1:-build}
[ "$mode" = "install" ] && mode=deploy
[ "$mode" = "build" ] || [ "$mode" = "deploy" ] || [ "$mode" = "clean" ] || { echo "用法: ./build.sh [deploy|install|clean]" >&2; exit 2; }

# ---------- 清理（= make clean） ----------
if [ "$mode" = "clean" ]; then
  rm -f "$root/ccweb" "$root/qtom"
  rm -rf "$root/frontend/dist"
  (cd "$root/backend" && cargo clean)
  echo "✓ 已清理：./ccweb、./qtom、frontend/dist、backend/target"
  exit 0
fi

# ---------- 构建（= make；产物落项目根目录） ----------
echo "==> 1/2 前端构建（frontend/，vite）"
(cd "$root/frontend" && npm run build)

if [ "$mode" = "build" ] && [ "${CCWEB_NO_RUST:-}" = "1" ]; then
  echo "==> 2/2 跳过 Rust 构建（CCWEB_NO_RUST=1）"
  exit 0
fi

echo "==> 2/2 Rust 构建（backend/target/release/ccweb → ./ccweb，qtom → ./qtom；前端全量嵌入，发布拷两个文件）"
(cd "$root/backend" && cargo build --release -p ccweb-server -p qtom)
cp "$root/backend/target/release/ccweb" "$root/ccweb"
cp "$root/backend/target/release/qtom" "$root/qtom"
chmod 755 "$root/ccweb" "$root/qtom"
mb=$(awk -v b="$(wc -c < "$root/ccweb" | tr -d ' ')" 'BEGIN{printf "%.1f", b/1024/1024}')
echo "完成：./ccweb（${mb}MB）+ ./qtom（qtom 引擎随行）"
[ "$mode" = "build" ] && exit 0

# ---------- 部署（= make install；Linux + systemd；rm -rf 连旧版目录形态一并清掉；sudo 只碰落位/系统位） ----------
PORT=${CCWEB_PORT:-18090}
DEST=/usr/local/ccweb
echo "==> 部署（${DEST}，port=${PORT}）"
sudo rm -rf "$DEST"
sudo mkdir -p "$DEST"
sudo install -m 755 "$root/ccweb" "$DEST/ccweb"
sudo install -m 755 "$root/qtom" "$DEST/qtom"

user=$(id -un)
home=$(getent passwd "$user" | cut -d: -f6)
[ -n "$home" ] || home=$HOME
cat >/tmp/ccweb.service.install <<UNIT
# ccweb systemd 单元（build.sh deploy 生成）
[Unit]
Description=ccweb（Claude Code 流式 Web 工作台）
After=network-online.target
Wants=network-online.target

[Service]
User=$user
Environment=HOME=$home
Environment=CCWEB_PORT=$PORT
WorkingDirectory=%h
ExecStart=$DEST/ccweb
Restart=always
RestartSec=3

[Install]
WantedBy=multi-user.target
UNIT
sudo cp /tmp/ccweb.service.install /etc/systemd/system/ccweb.service
sudo systemctl daemon-reload
sudo systemctl restart ccweb

# 健康检查
sleep 1.5
curl -fsS -o /dev/null "http://127.0.0.1:$PORT/"
echo "✓ ccweb 已上线 :${PORT}（${DEST}，服务 ccweb.service）"
