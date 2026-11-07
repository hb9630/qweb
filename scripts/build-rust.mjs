#!/usr/bin/env node
// Rust 后端构建：frontend/dist 前置检查 → cargo build --release → build/ccweb 单文件
// （替代 SEA 打包：内嵌 dist 的原生二进制，~10MB 级，无 node 运行时依赖）
import { execSync } from "node:child_process";
import { existsSync, mkdirSync, copyFileSync, chmodSync, statSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");
const sh = (cmd, opts = {}) => execSync(cmd, { stdio: "inherit", cwd: root, ...opts });

const dist = join(root, "frontend", "dist", "index.html");
if (!existsSync(dist)) {
  console.error("× frontend/dist 缺失：先执行 `npm run build -w frontend`（或 npm run build 全量）");
  process.exit(1);
}

console.log("==> Rust 后端构建（cargo build --release）");
sh("cargo build --release -p ccweb-server");

const src = join(root, "target", "release", "ccweb-server");
const out = join(root, "build", "ccweb");
mkdirSync(join(root, "build"), { recursive: true });
copyFileSync(src, out);
chmodSync(out, 0o755);
const mb = (statSync(out).size / 1024 / 1024).toFixed(1);
console.log(`完成：build/ccweb（${mb}MB，替代原 SEA 137MB）`);
