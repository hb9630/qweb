#!/usr/bin/env node
// 一键构建：frontend vite build → Rust 单文件（build/ccweb）
// npm run build 全量；CCWEB_NO_RUST=1 npm run build 只出前端
import { execSync } from "node:child_process";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const sh = (cmd, opts = {}) => execSync(cmd, { stdio: "inherit", ...opts });

console.log("==> 1/2 前端构建（frontend/，vite）");
sh("npm run build", { cwd: join(root, "frontend") });

if (process.env.CCWEB_NO_RUST === "1") { console.log("==> 2/2 跳过单文件打包（CCWEB_NO_RUST=1）"); process.exit(0); }
console.log("==> 2/2 Rust 单文件打包（build/ccweb，前端全量嵌入，发布即拷这一个文件）");
sh("node scripts/build-rust.mjs", { cwd: root });
console.log("完成：frontend/dist + build/ccweb（单文件分发）");
