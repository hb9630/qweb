#!/bin/bash
# 一键构建：web 前端 → 根 dist 链接 → SEA 单文件（build/ccweb，发布即拷这一个文件）
# 用法：./build.sh            # 全量（前端 + SEA）
#       ./build.sh --no-sea   # 只出前端 dist（裸跑形态够用）
set -euo pipefail
cd "$(dirname "$0")"

echo "==> 1/3 前端构建（web/，vite）"
( cd web && { [ -d node_modules ] || npm install --no-audit --no-fund; } && npm run build )

echo "==> 2/3 根 dist（相对 symlink，server.mjs 裸跑形态读它）"
[ -e dist ] && [ ! -L dist ] && { echo "    dist 已存在且非链接，保留"; } || ln -sfn web/dist dist

if [ "${1:-}" = "--no-sea" ]; then echo "==> 3/3 跳过 SEA（--no-sea）"; exit 0; fi
echo "==> 3/3 SEA 单文件打包（build/ccweb）"
node build-sea.mjs
echo "完成：web/dist（裸跑）+ build/ccweb（单文件分发）"
