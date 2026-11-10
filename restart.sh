#!/bin/sh
# 编译 + 重启 18090 服务。用法：nohup ./restart.sh >/tmp/qweb-restart.log 2>&1 &
# 构建失败即止（旧服务不动）；停旧 = SIGTERM 优雅退出（含 claude 子进程），等端口释放再起新实例并校验
# 注意：重启会断掉当前活会话；页面刷新后自动 resume 回来
set -eu
root=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
PORT=18090
LOG=/tmp/qweb-$PORT.log

echo "==> 1/3 构建（./build.sh）"
"$root/build.sh"

echo "==> 2/3 停旧实例 :${PORT}"
for pid in $(lsof -tnP -iTCP:$PORT -sTCP:LISTEN 2>/dev/null); do
  kill "$pid" 2>/dev/null || true
done
# 等端口真正释放（优雅退出要结束 claude 子进程，可能超过固定 sleep）
i=0
while lsof -tnP -iTCP:$PORT -sTCP:LISTEN >/dev/null 2>&1; do
  i=$((i + 1)); [ $i -gt 40 ] && { echo "× 端口 :${PORT} 迟迟未释放，放弃" >&2; exit 1; }
  sleep 0.5
done

echo "==> 3/3 起新实例 :${PORT}（log: ${LOG}）"
cd "$root"
nohup "$root/qweb" -p $PORT > "$LOG" 2>&1 &

# 校验真的起来了（绑定失败会在日志里 panic）
i=0
until curl -fsS -o /dev/null "http://127.0.0.1:$PORT/" 2>/dev/null; do
  i=$((i + 1)); [ $i -gt 20 ] && { echo "× 起动失败，查 ${LOG}" >&2; tail -5 "$LOG" >&2; exit 1; }
  sleep 0.5
done
echo "✓ qweb 已上线 :${PORT}"
