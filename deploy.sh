#!/bin/bash
# 本地部署：按当前机器生成 systemd 单元并安装/重启（默认端口 18090，CCWEB_PORT 可覆盖）
# 远程分发用 SEA 形态：scp build/ccweb 到目标机，任意目录 ./ccweb 即跑（无需本脚本）
set -euo pipefail
cd "$(dirname "$0")"
PORT=${CCWEB_PORT:-18090}

echo "==> 生成单元（port=$PORT user=$(id -un) dir=$PWD）"
sed -e "s|^User=.*|User=$(id -un)|" \
    -e "s|^Environment=HOME=.*|Environment=HOME=$HOME|" \
    -e "s|^Environment=CCWEB_PORT=.*|Environment=CCWEB_PORT=$PORT|" \
    -e "s|^WorkingDirectory=.*|WorkingDirectory=$PWD|" \
    ccweb.service > /tmp/ccweb.service.install

echo "==> 安装并重启"
sudo cp /tmp/ccweb.service.install /etc/systemd/system/ccweb.service
sudo systemctl daemon-reload
sudo systemctl restart ccweb

sleep 1.5
curl -fsS -o /dev/null "http://127.0.0.1:$PORT/" && echo "✓ ccweb 已上线 :$PORT"
