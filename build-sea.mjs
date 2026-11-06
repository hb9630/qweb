#!/usr/bin/env node
// ccweb 单文件构建（Node SEA）：server.mjs（ws 一并 bundle）+ dist 全量嵌入 node 副本，
// 产出一个自包含可执行文件 build/ccweb——发布即拷这一个文件，任何装了 claude 的机器直接跑。
// 前置：cd web && npm run build（产出 web/dist）；esbuild 复用 web/node_modules（vite 自带）。
// 裸跑形态（node server.mjs + 同目录 dist/）与单文件形态同一份代码，见 server.mjs readStatic。
import { execSync } from "node:child_process";
import { readdirSync, readFileSync, writeFileSync, copyFileSync, chmodSync, mkdirSync, statSync } from "node:fs";
import { join, dirname, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const WEB = join(here, "web");
const DIST = join(WEB, "dist");
const OUT = join(here, "build", "sea");
mkdirSync(OUT, { recursive: true });
const sh = (cmd) => execSync(cmd, { stdio: "inherit", cwd: here });

// 1. bundle：ws 纯 js 打入；node:* 自动 external；显式 external node:sea（防 bundle 报错）
const ESBUILD = join(WEB, "node_modules", ".bin", "esbuild");
sh(`${ESBUILD} ${join(here, "server.mjs")} --bundle --platform=node --format=cjs --outfile=${join(OUT, "server.cjs")} --external:node:sea`);

// 2. dist 清单：递归收集 → 稳定排序 → 序号 key（SEA asset key 只允许字母数字下划线，
//    点/斜杠一律不可；路径映射经 manifest 资产在运行时反查）
if (!readFileSync(join(DIST, "index.html"), "utf8").includes('src="./assets/'))
  throw new Error("web/dist 缺失或非相对引用形态：先 cd web && npm run build");
const files = [];
(function walk(d) {
  for (const e of readdirSync(d, { withFileTypes: true })) {
    const p = join(d, e.name);
    if (e.isDirectory()) walk(p);
    else files.push(relative(DIST, p).split(sep).join("/"));
  }
})(DIST);
files.sort();
const manifest = {};
const assets = { manifest: join(OUT, "manifest.json") };
files.forEach((f, i) => { manifest[f] = "a" + i; assets["a" + i] = join(DIST, f); });
writeFileSync(join(OUT, "manifest.json"), JSON.stringify(manifest));

// 3. SEA blob（useCodeCache 关：跨机注入时 code cache 与二进制版本绑定不稳）
writeFileSync(join(OUT, "sea-config.json"), JSON.stringify({
  main: join(OUT, "server.cjs"),
  output: join(OUT, "sea-prep.blob"),
  disableExperimentalSEAWarning: true,
  useCodeCache: false,
  assets,
}, null, 1));
sh(`node --experimental-sea-config ${join(OUT, "sea-config.json")}`);

// 4. 载体二进制：官方 node（SEA fuse 哨兵仅官方构建含——Ubuntu/发行版 node 无 fuse，
//    postject 报 sentinel 找不到）。经 npm node 包取同版本官方二进制
const BASEDIR = join(OUT, "nodebase");
sh(`npm install --no-audit --no-fund --prefix ${BASEDIR} node@${process.versions.node}`);
const exe = join(here, "build", "ccweb");
copyFileSync(join(BASEDIR, "node_modules", "node", "bin", "node"), exe);
sh(`npx --yes postject ${exe} NODE_SEA_BLOB ${join(OUT, "sea-prep.blob")} --sentinel-fuse NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2`);
chmodSync(exe, 0o755);
console.log(`✓ ${exe}（${(statSync(exe).size / 1e6).toFixed(1)}MB，含 ${files.length} 个前端文件）`);
