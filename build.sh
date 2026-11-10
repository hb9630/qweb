#!/bin/sh
# 一键构建/部署/清理（POSIX sh；npm 机制只用于 frontend/ 内部，根目录编排全 shell）
# 语义同 make：产物 qweb 出在项目根目录，与源码同级
# ./build.sh                    构建：frontend vite → 根目录 ./qweb（单文件）
# ./build.sh desktop            Windows 桌面版：./qweb-desktop.exe（Tauri+WebView2，无控制台，
#                                默认本机随机端口开原生窗口；需 MSVC 环境——vcvars64 后跑）
# ./build.sh deploy | install   构建 + 部署：装 /usr/local/qweb + systemd 重启 + 健康检查
# ./build.sh clean              清产物：./qweb + frontend/dist + cargo target（下次全量重建）
# QWEB_NO_RUST=1 ./build.sh    只出前端（deploy 恒全量，装机器需要单文件）
# QWEB_PORT=xxx ./build.sh deploy   部署端口（默认 18090）
set -eu
root=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
mode=${1:-build}
[ "$mode" = "install" ] && mode=deploy
[ "$mode" = "build" ] || [ "$mode" = "deploy" ] || [ "$mode" = "desktop" ] || [ "$mode" = "clean" ] || { echo "用法: ./build.sh [desktop|deploy|install|clean]" >&2; exit 2; }

# ---------- 清理（= make clean） ----------
if [ "$mode" = "clean" ]; then
  rm -f "$root/qweb" "$root/qweb.exe" "$root/qtom" "$root/qtom.exe"
  rm -rf "$root/frontend/dist"
  (cd "$root/backend" && cargo clean)
  echo "✓ 已清理：./qweb、frontend/dist、backend/target"
  exit 0
fi

# ---------- 构建（= make；产物落项目根目录） ----------
echo "==> 1/2 前端构建（frontend/，vite）"
(cd "$root/frontend" && npm run build)
# 静态资源预压缩：gzip -9 副本与原件并存（同入 embed），Rust 端按 Accept-Encoding
# 协商优先回 .gz（构建期压好 = 零运行时 CPU；首屏 index chunk 传输量 ~1/4）
find "$root/frontend/dist/assets" -type f \( -name '*.js' -o -name '*.css' -o -name '*.svg' \) -exec gzip -9k {} \;

if [ "$mode" = "build" ] && [ "${QWEB_NO_RUST:-}" = "1" ]; then
  echo "==> 2/2 跳过 Rust 构建（QWEB_NO_RUST=1）"
  exit 0
fi

if [ "$mode" = "desktop" ]; then
  echo "==> 2/2 Rust 构建（desktop feature：Tauri 壳 qweb-desktop.exe，前端全量嵌入）"
  (cd "$root/backend" && cargo build --release -p qweb-server --features desktop --bin qweb-desktop)
  cp "$root/backend/target/release/qweb-desktop.exe" "$root/qweb-desktop.exe"
  chmod 755 "$root/qweb-desktop.exe"
  mb=$(awk -v b="$(wc -c < "$root/qweb-desktop.exe" | tr -d ' ')" 'BEGIN{printf "%.1f", b/1024/1024}')
  echo "完成：./qweb-desktop.exe（${mb}MB）——双击即开原生窗口（默认本机随机端口；关窗=退出并结束会话子进程）"
  exit 0
fi

echo "==> 2/2 Rust 构建（backend/target/release/qweb → ./qweb；前端全量嵌入，单文件发布。qtom 已移出编译——代码保留在 backend/qtom/，见 backend/Cargo.toml 注释）"
(cd "$root/backend" && cargo build --release -p qweb-server)
exe=""
[ "$(uname -s)" = "Linux" ] || [ "$(uname -s)" = "Darwin" ] || exe=".exe"
cp "$root/backend/target/release/qweb${exe}" "$root/qweb${exe}"
chmod 755 "$root/qweb${exe}"
mb=$(awk -v b="$(wc -c < "$root/qweb${exe}" | tr -d ' ')" 'BEGIN{printf "%.1f", b/1024/1024}')
echo "完成：./qweb${exe}（${mb}MB）"
[ "$mode" = "build" ] && exit 0

# ---------- 部署（= make install；Linux + systemd；rm -rf 连旧版目录形态一并清掉；sudo 只碰落位/系统位） ----------
PORT=${QWEB_PORT:-18090}
DEST=/usr/local/qweb
echo "==> 部署（${DEST}，port=${PORT}）"
sudo rm -rf "$DEST"
sudo mkdir -p "$DEST"
sudo install -m 755 "$root/qweb" "$DEST/qweb"

user=$(id -un)
home=$(getent passwd "$user" | cut -d: -f6)
[ -n "$home" ] || home=$HOME
cat >/tmp/qweb.service.install <<UNIT
# qweb systemd 单元（build.sh deploy 生成）
[Unit]
Description=qweb（AI agent 流式 Web 工作台）
After=network-online.target
Wants=network-online.target

[Service]
User=$user
Environment=HOME=$home
Environment=QWEB_PORT=$PORT
WorkingDirectory=%h
ExecStart=$DEST/qweb
Restart=always
RestartSec=3

[Install]
WantedBy=multi-user.target
UNIT
sudo cp /tmp/qweb.service.install /etc/systemd/system/qweb.service
sudo systemctl daemon-reload
sudo systemctl restart qweb

# 健康检查
sleep 1.5
curl -fsS -o /dev/null "http://127.0.0.1:$PORT/"
echo "✓ qweb 已上线 :${PORT}（${DEST}，服务 qweb.service）"
