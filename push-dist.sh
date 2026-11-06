#!/bin/bash
# ccweb 前端热推：把 web/dist 覆盖到所有带 ccweb 的 keeper 容器（静态资源，免重启）。
# 用法：
#   ./push-dist.sh                            # 仅本机节点
#   ./push-dist.sh huangbin@192.168.1.16     # 顺带推远程节点（需 ssh 免密 + 对方 sudo 免密）
#   GX10=1 ./push-dist.sh                    # 等价于上面（默认 gx10 地址）
# 行为：
#   - 枚举 `ctr -n keeper tasks`，容器根里没有 /opt/ccweb 的自动跳过（mini-node/ubuntu/redis 等）
#   - 推完回读 dist/index.html 校验 bundle 哈希一致
# 限制（与镜像的关系）：
#   - 只改容器可写层；reimage / 删除重建会还原成镜像里的旧版——版本稳定后跑
#     deploy/build-toolbox.sh 重烤镜像，本脚本作日常快速迭代用
set -euo pipefail
cd "$(dirname "$0")"

SRC="web/dist"
INDEX_JS=$(grep -o 'assets/index-[^"]*\.js' "$SRC/index.html" 2>/dev/null | head -1 || true)
[ -n "$INDEX_JS" ] || { echo "✗ web/dist 缺失或未构建：cd web && npm run build"; exit 1; }
echo "推送产物：$INDEX_JS"

TARBALL=$(mktemp /tmp/ccweb-dist-XXXXXX.tar.gz)
WORKER=$(mktemp /tmp/ccweb-push-XXXXXX.sh)
trap 'rm -f "$TARBALL" "$WORKER"' EXIT
tar -C . -czf "$TARBALL" --transform 's|^web/dist|dist|' web/dist server.mjs seed

# worker 以 root 在目标节点上跑：解包 → 遍历 ctr tasks → 有 /opt/ccweb 的原子换 dist →
# server.mjs 有变化才换并杀 ccweb node（keeper-init 3s 内以新码拉起）→ 校验
cat > "$WORKER" <<'EOF'
#!/bin/bash
set -e
tmp=$(mktemp -d /tmp/ccweb-dist.XXXXXX)
trap 'rm -rf "$tmp"' EXIT
tar -xzf "$1" -C "$tmp"
pushed=0
while read -r cid pid; do
  root="/proc/$pid/root/opt/ccweb"
  [ -d "$root" ] || continue   # 非 ccweb 容器（mini-node/ubuntu/redis/…）跳过
  rm -rf "$root/dist.new"
  mkdir "$root/dist.new"
  cp -r "$tmp/dist/." "$root/dist.new/"
  rm -rf "$root/dist.old"
  [ -d "$root/dist" ] && mv "$root/dist" "$root/dist.old"
  mv "$root/dist.new" "$root/dist"
  rm -rf "$root/dist.old"
  # server.mjs / seed 同步：cmp 相同则不动（不打断在跑会话），不同则替换 + 杀进程重启
  # （seed = .claude 认证种子，server 启动时补缺播种进卷）
  srv_changed=0
  if ! cmp -s "$tmp/server.mjs" "$root/server.mjs" 2>/dev/null; then
    cp "$tmp/server.mjs" "$root/server.mjs.new"
    mv "$root/server.mjs.new" "$root/server.mjs"
    srv_changed=1
  fi
  if [ -d "$tmp/seed" ]; then
    diff -rq "$tmp/seed" "$root/seed" >/dev/null 2>&1 || {
      rm -rf "$root/seed.new"
      cp -r "$tmp/seed" "$root/seed.new"
      rm -rf "$root/seed"
      mv "$root/seed.new" "$root/seed"
      srv_changed=1
    }
  fi
  got=$(grep -o 'assets/index-[^"]*\.js' "$root/dist/index.html" | head -1)
  if [ "$got" = "$2" ]; then
    echo "  ✓ ${cid:0:8} -> $got$([ $srv_changed = 1 ] && echo ' +server.mjs(重启生效)')"
    pushed=$((pushed + 1))
  else
    echo "  ✗ ${cid:0:8} 校验失败（got=$got）"
  fi
  # 换过 server.mjs：nsenter 进容器杀 ccweb node（keeper-init 服务体 3s 节流自动拉起）
  if [ $srv_changed = 1 ]; then
    nsenter -t "$pid" -p -m -- pkill -f "ccweb/server.mjs" 2>/dev/null || true
  fi
done < <(ctr -n keeper tasks list | awk 'NR>1{print $1, $2}')
echo "  本节点共推送 $pushed 个容器"
EOF

push_target() { # $1 = local | user@host
  local host=$1
  if [ "$host" = local ]; then
    echo "== 本机 =="
    sudo bash "$WORKER" "$TARBALL" "$INDEX_JS"
  else
    echo "== $host =="
    scp -q "$TARBALL" "$host:/tmp/.ccweb-dist.tar.gz"
    scp -q "$WORKER" "$host:/tmp/.ccweb-push.sh"
    ssh "$host" "sudo bash /tmp/.ccweb-push.sh /tmp/.ccweb-dist.tar.gz '$INDEX_JS'; rm -f /tmp/.ccweb-dist.tar.gz /tmp/.ccweb-push.sh"
  fi
}

push_target local
for h in "$@"; do push_target "$h"; done
[ -z "${GX10:-}" ] || push_target "huangbin@192.168.1.16"
