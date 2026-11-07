#!/usr/bin/env node
// 一键构建：frontend vite build → backend/dist 链接 → SEA 单文件（build/ccweb）
// npm run build 全量；CCWEB_NO_SEA=1 npm run build 只出前端（裸跑形态够用）
import { execSync } from "node:child_process";
import { symlinkSync, existsSync, lstatSync, readdirSync, statSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");
const sh = (cmd, opts = {}) => execSync(cmd, { stdio: "inherit", cwd: root, ...opts });

console.log("==> 1/3 前端构建（frontend/，vite）");
sh("npm run build -w frontend");

console.log("==> 2/3 backend/dist 链接（server.mjs 裸跑形态读它）");
const link = join(root, "backend", "dist");
const target = "../frontend/dist";
if (!existsSync(link) || lstatSync(link).isSymbolicLink?.()) {
  try { symlinkSync(target, link); } catch {}
} else if (!readdirSync(link).length && statSync(link).isDirectory()) {
  console.log("    backend/dist 已存在（空目录），替换为链接");
}

if (process.env.CCWEB_NO_SEA === "1") { console.log("==> 3/3 跳过单文件打包（CCWEB_NO_SEA=1）"); process.exit(0); }
console.log("==> 3/3 Rust 单文件打包（build/ccweb，前端全量嵌入，发布即拷这一个文件）");
sh("node scripts/build-rust.mjs");
console.log("完成：frontend/dist（Node 裸跑形态）+ build/ccweb（Rust 单文件分发）");
