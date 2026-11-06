#!/usr/bin/env node
// 安装部署（面向 Linux + systemd；其他环境用裸跑 node server.mjs 或 SEA 单文件 build/ccweb）：
// 组装自包含安装树 → /usr/local/ccweb，装 systemd 单元并重启（默认 18090）。
// 开发目录只是源码，系统位置跑服务——升级 = 重新 npm run build && npm run deploy。
// 用法：npm run deploy（CCWEB_PORT=xxx npm run deploy 改端口）
// 前置：npm run build（frontend/dist 就绪；本脚本不隐式构建，产物缺失直接报错）
import { execSync } from "node:child_process";
import { readFileSync, writeFileSync, cpSync, existsSync, rmSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { homedir, userInfo } from "node:os";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");
const PORT = process.env.CCWEB_PORT || "18090";
const DEST = "/usr/local/ccweb";
const sh = (cmd) => execSync(cmd, { stdio: "inherit" });

// 0. 前置检查：前端产物
const dist = join(root, "frontend", "dist");
if (!existsSync(join(dist, "index.html"))) {
  console.error("✗ frontend/dist 缺失：先 npm run build"); process.exit(1);
}

// 1. 组装安装树到 /tmp（server.mjs + dist 实体 + ws 依赖；server.mjs 读同目录 dist，树自包含）
//    普通用户权限组装，sudo 只碰最后一步落位——组装失败不污染系统目录
const stage = "/tmp/ccweb-install";
rmSync(stage, { recursive: true, force: true });
console.log(`==> 组装安装树（${stage} → ${DEST}）`);
cpSync(join(root, "backend", "server.mjs"), join(stage, "server.mjs"));
cpSync(dist, join(stage, "dist"), { recursive: true });
cpSync(join(root, "node_modules", "ws"), join(stage, "node_modules", "ws"), { recursive: true }); // ws 零依赖，拷包即可
sh(`sudo rm -rf ${DEST} && sudo cp -r ${stage} ${DEST}`);

// 2. 生成并安装 unit
console.log(`==> 安装 systemd 单元（port=${PORT} user=${userInfo().username}）`);
const unit = readFileSync(join(here, "ccweb.service"), "utf8")
  .replace(/^User=.*$/m, `User=${userInfo().username}`)
  .replace(/^Environment=HOME=.*$/m, `Environment=HOME=${homedir()}`)
  .replace(/^Environment=CCWEB_PORT=.*$/m, `Environment=CCWEB_PORT=${PORT}`);
const unitPath = "/tmp/ccweb.service.install";
writeFileSync(unitPath, unit);
sh(`sudo cp ${unitPath} /etc/systemd/system/ccweb.service`);
sh("sudo systemctl daemon-reload");
sh("sudo systemctl restart ccweb");

// 3. 健康检查
await new Promise((r) => setTimeout(r, 1500));
execSync(`curl -fsS -o /dev/null http://127.0.0.1:${PORT}/`);
console.log(`✓ ccweb 已上线 :${PORT}（${DEST}，服务 ccweb.service）`);
