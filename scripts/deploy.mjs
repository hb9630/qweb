#!/usr/bin/env node
// 安装部署（面向 Linux + systemd；单文件形态任意平台裸跑 ./ccweb 即可）：
// 安装树 = 自包含 Rust 单文件 build/ccweb → /usr/local/ccweb，装 systemd 单元并重启（默认 18090）。
// 开发目录只是源码，系统位置跑服务——升级 = 重新 npm run build && npm run deploy。
// 用法：npm run deploy（CCWEB_PORT=xxx npm run deploy 改端口）
// 前置：npm run build 出 build/ccweb（Linux 目标需 linux 构建产物——目标机构建或交叉编译）
import { execSync } from "node:child_process";
import { readFileSync, writeFileSync, copyFileSync, chmodSync, existsSync, rmSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { homedir, userInfo } from "node:os";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");
const PORT = process.env.CCWEB_PORT || "18090";
const DEST = "/usr/local/ccweb";
const sh = (cmd) => execSync(cmd, { stdio: "inherit" });

// 0. 前置检查：单文件产物（不隐式构建，缺失直接报错）
const bin = join(root, "build", "ccweb");
if (!existsSync(bin)) {
  console.error("✗ build/ccweb 缺失：先 npm run build"); process.exit(1);
}

// 1. 组装安装树到 /tmp（就一个自包含二进制；普通用户权限组装，sudo 只碰最后落位）
const stage = "/tmp/ccweb-install";
rmSync(stage, { recursive: true, force: true });
mkdirSync(stage, { recursive: true });
console.log(`==> 组装安装树（${stage} → ${DEST}）`);
copyFileSync(bin, join(stage, "ccweb"));
chmodSync(join(stage, "ccweb"), 0o755);
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
console.log(`✓ ccweb 已上线 :${PORT}（${DEST}/ccweb，服务 ccweb.service）`);
