#!/usr/bin/env node
// keeper ccweb —— Claude Code 流式 Web UI 后端
// 会话模型：每个 tab = 一个长驻 claude 进程（stream-json 双向管道），
// 关闭 tab 才 kill；刷新页面经 ring buffer 回放恢复。
import { createServer } from "node:http";
import { readFile, stat, readdir, open, mkdir, rm, writeFile, rename as renamePath, cp, copyFile } from "node:fs/promises";
import { existsSync, createReadStream, readFileSync, watch as fsWatch, mkdirSync, copyFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { join, dirname, extname, resolve } from "node:path";
import { homedir } from "node:os";
import { WebSocketServer } from "ws";

const PORT = process.env.CCWEB_PORT || 8090;
// 零配置 base_path（code-server 4.144 同款姿势）：前端资源全相对引用（vite base:'./'），
// 本服务只认根形态路由；路径中最早出现的路由锚点（/api /ws /assets favicon index.html）
// 之前一律视为 base 剥掉——nginx 剥前缀、透传带任意前缀、本地根形态，三种姿势同一套逻辑，
// 不再依赖 KEEPER_BASE_{PORT} env。无锚点 = SPA 入口（尾斜杠由 handler 内 301 保证）
const ANCHORS = ["/api/", "/ws/", "/assets/", "/favicon.ico", "/index.html"];
const stripBase = (p) => {
  let cut = -1;
  for (const a of ANCHORS) {
    const i = p.indexOf(a);
    if (i >= 0 && (cut < 0 || i < cut)) cut = i;
  }
  return cut < 0 ? null : p.slice(cut) || "/";
};
const IS_WIN = process.platform === "win32";
// 单会话形态（发布版）：CCWEB_SINGLE=1 → 至多一个活会话（POST 时 kill 旧的再开新的，
// 绕过前端直接调 API 也开不出第二个），/api/env 下发 single → 前端隐藏会话切换 UI。
// 自用多会话形态：不设此变量。
const SINGLE = process.env.CCWEB_SINGLE === "1";

// 跨平台路径约定：对外一律正斜杠（node fs 在 Windows 同样接受 /，前端拼接才不会混分隔符）
const P = (p) => String(p).replace(/\\/g, "/");
const jj = (...a) => P(join(...a));
const dd = (p) => P(dirname(p));

// ---- 静态资源层：两种发布形态同一份代码 ----
// ① SEA 单文件（分发形态，build-sea.mjs 产出）：dist 全量 + manifest 嵌入二进制，
//    经 node:sea 取——一个可执行文件跑起来即完整服务（code-server 式自包含的彻底版）
// ② 裸跑（开发态）：本文件同目录 dist/ 从文件系统读
// ccweb 不管 .claude 配置（认证/模型映射归 claude code 自己与环境，部署层给容器配）
import { isSea, getAsset } from "node:sea";
let SEA_MANIFEST = null; // { dist相对路径(正斜杠): assetKey }
if (isSea()) SEA_MANIFEST = JSON.parse(Buffer.from(getAsset("manifest")).toString("utf8"));
const devDist = () => jj(dd(P(new URL(import.meta.url).pathname)), "dist");
async function readStatic(rel) { // rel: dist 内相对路径；不存在返回 null
  if (isSea()) { const k = SEA_MANIFEST[rel]; return k ? Buffer.from(getAsset(k)) : null; }
  const fp = jj(devDist(), rel);
  if (!fp.startsWith(devDist() + "/")) return null; // 防穿越（resolve 消解 ../ 后钳回 dist 内）
  try { return await readFile(fp); } catch { return null; }
}
const CHILD_HOME = P(process.env.CCWEB_HOME || homedir()); // 工作区根 = 环境 HOME（CCWEB_HOME 可覆盖）
const KEEPERD_URL = process.env.KEEPERD_URL || "http://127.0.0.1:7998"; // 宿主形态时的容器编排 API
const PROJECTS = jj(CHILD_HOME, ".claude", "projects"); // 官方 transcript 根目录

// ---- ctx 窗口记忆（归一名 → contextWindow）----
// transcript 不写 result 行，历史回放的合成 result 没有 modelUsage，前端只能靠
// 浏览器 localStorage / env [1m] 提示推分母——换设备/清缓存/部署环境 settings 无
// [1m] 时兜底 200k，1M 会话直接算成 5 倍虚高。live 流的 result.modelUsage 键是
// 原名（glm-5.3[1m]）且带真实 contextWindow，这里在服务端落盘一份，历史回放时
// 回注合成 result，分母不再依赖任何浏览器侧状态。
const CTXWIN_PATH = jj(CHILD_HOME, ".claude", "ccweb-ctxwin.json");
let ctxWinMem = null; // 启动懒加载；运行中合并写回
function ctxWinRemember(mu) {
  let dirty = false;
  for (const [k, v] of Object.entries(mu ?? {}))
    if (v?.contextWindow && ctxWinMem?.[k.replace(/\[1m\]$/i, "")] !== v.contextWindow) {
      ctxWinMem ??= {};
      ctxWinMem[k.replace(/\[1m\]$/i, "")] = v.contextWindow;
      dirty = true;
    }
  if (dirty) writeFile(CTXWIN_PATH, JSON.stringify(ctxWinMem), "utf8").catch(() => {});
}
async function ctxWinOf(model) { // 该模型（裸名）的记忆窗口；无记忆返回 undefined
  if (!ctxWinMem) { try { ctxWinMem = JSON.parse(await readFile(CTXWIN_PATH, "utf8")); } catch { ctxWinMem = {}; } }
  return ctxWinMem?.[String(model ?? "").replace(/\[1m\]$/i, "")];
}

// .claude 配置分发已移除(2026-11-05 定策):ccweb 只 spawn 环境 PATH 里的 claude,
// 认证/模型映射归 claude code 自身与环境;容器形态的配置分发由部署层负责(agent
// 创建容器时写入 HOME 卷),不再由服务运行时播种/对账覆盖用户文件。


// 读请求体。客户端中途断开（手机刷新页面/网络切换极常见）时流以 aborted 拒绝，
// 未经 catch 会升级为 unhandledRejection 直接杀死进程——全部会话陪葬（已在线上炸过）。
async function readBody(req, cap = 96 * 1024 * 1024) {
  const chunks = [];
  let total = 0;
  for await (const c of req) {
    total += c.length;
    if (total > cap) throw new Error("body too large");
    chunks.push(c);
  }
  return Buffer.concat(chunks).toString("utf8");
}
// 兜底网：任何漏网的拒绝只记日志，不再崩服务（keeper-init 重启会灭掉全部会话）
process.on("unhandledRejection", (e) => console.log("[ccweb] unhandledRejection 已吞:", String(e)));

// claude 入口跨平台解析：env 显式 > win32 npm-global cli.js（node 直跑，绕开 .cmd spawn 坑）
// > linux 容器惯例路径 > PATH 里的 claude
function claudeCmd() {
  if (process.env.CCWEB_CLAUDE) return { bin: process.env.CCWEB_CLAUDE, pre: [] };
  if (IS_WIN) {
    const npmRoot = P(process.env.APPDATA || jj(homedir(), "AppData", "Roaming")) + "/npm";
    const cli = jj(npmRoot, "node_modules", "@anthropic-ai", "claude-code", "cli.js");
    if (existsSync(cli)) return { bin: "node", pre: [cli] };
    return { bin: "claude", pre: [] }; // 退路：PATH 里的 claude.cmd（需 PATH 配好）
  }
  for (const c of ["/root/.npm-global/bin/claude", jj(CHILD_HOME, ".npm-global/bin/claude"), "/usr/local/bin/claude"])
    if (existsSync(c)) return { bin: c, pre: [] };
  return { bin: "claude", pre: [] };
}

// 文件管理路径安全：resolve 消解 ../ 逃逸并规范斜杠。
// 2026-10-29 起 safePath 不再做 home 子树钳制——工作目录可任意选（Windows 可跨盘符，
// 与 code-server/Jupyter 对齐：本地个人工具全盘可浏览）；"禁删根"保护在 remove 分支单独做。
function safePath(p) {
  return P(resolve(String(p || "")));
}
const CHILD_ENV = {
  ...process.env, // PATH 继承当前环境（跨平台；容器里 ksvc 已带 npm-global 路径）
  HOME: CHILD_HOME,
  TERM: "xterm-256color",
};

/** @type {Map<string, Session>} */
const sessions = new Map();

class Session {
  constructor(id, cwd, resumeSid) {
    this.id = id;
    this.cwd = cwd;
    this.resumeSid = resumeSid || null;
    // resume 的官方会话 ID 即入参（init 要到首条消息才发，先标上，/api/sessions 才能定位 transcript）
    this.claudeSid = resumeSid || null;
    this.startedAt = Date.now();
    this.alive = true;
    this.buf = [];          // 回放缓冲：已定稿事件（不含 stream_event 增量）
    this.partial = null;    // 当前流式中的增量（重连时补发）
    this.clients = new Set();
    this.proc = this.spawn();
  }
  touch() { this.lastActive = Date.now(); }
  get spawnArgs() {
    const args = [
      "--input-format", "stream-json",
      "--output-format", "stream-json",
      "--include-partial-messages",
      "--verbose",
    ];
    if (this.resumeSid) args.push("--resume", this.resumeSid);
    return args;
  }
  spawn() {
    const c = claudeCmd();
    const p = spawn(c.bin, [...c.pre, ...this.spawnArgs], { cwd: this.cwd, env: CHILD_ENV, windowsHide: true });
    p.stdout.setEncoding("utf8");
    let carry = "";
    p.stdout.on("data", (chunk) => {
      carry += chunk;
      let nl;
      while ((nl = carry.indexOf("\n")) >= 0) {
        const line = carry.slice(0, nl).trim();
        carry = carry.slice(nl + 1);
        if (!line) continue;
        let ev;
        try { ev = JSON.parse(line); } catch { continue; }
        this.onEvent(ev);
      }
    });
    p.stderr.setEncoding("utf8");
    p.stderr.on("data", (s) => this.broadcast({ t: "stderr", s }, false));
    p.on("exit", (code) => {
      this.alive = false;
      this.broadcast({ t: "exit", code });
    });
    return p;
  }
  onEvent(ev) {
    this.touch();
    if (ev.type === "system" && ev.subtype === "init" && ev.session_id) {
      this.claudeSid = ev.session_id; // 官方会话 ID（transcript 文件名，resume 用）
    }
    if (ev.type === "stream_event") {
      // 增量不进 buf，只推流；记录当前块的累积以支持重连续播
      const d = ev.event?.delta?.text ?? "";
      this.partial = (this.partial ?? "") + d;
      this.broadcast({ t: "cc", ev });
      return;
    }
    // 定稿事件（system/assistant/user/result/control_response…）入 buf
    this.buf.push(ev);
    if (ev.type === "result") {
      this.partial = null; // 一轮结束
      ctxWinRemember(ev.modelUsage); // 分母记忆落盘（见 CTXWIN_PATH 注释）
    }
    this.broadcast({ t: "cc", ev });
  }
  broadcast(msg, toBufOnly = null) {
    const s = JSON.stringify(msg);
    for (const ws of this.clients) if (ws.readyState === 1) ws.send(s);
  }
  sendUser(text) {
    // 官方 SDK stdin 格式：content 数组 + session_id 空串；持久化由 claude transcript 完成
    this.proc.stdin.write(JSON.stringify({
      type: "user", session_id: "",
      message: { role: "user", content: [{ type: "text", text }] },
    }) + "\n");
  }
  interrupt() {
    this.proc.stdin.write(JSON.stringify({
      type: "control_request", request_id: randomUUID(),
      request: { subtype: "interrupt" },
    }) + "\n");
  }
  // control_request 通用通道：interrupt / set_permission_mode / set_model / …
  // （CLI v2.1 实测：合法模式 default|plan|acceptEdits|auto|dontAsk；set_model 校验失败回 control_response error）
  ctrl(subtype, args = {}) {
    this.proc.stdin.write(JSON.stringify({
      type: "control_request", request_id: randomUUID(),
      request: { subtype, ...args },
    }) + "\n");
  }
  kill() {
    if (this.alive) {
      this.proc.kill("SIGTERM");
      setTimeout(() => this.alive && this.proc.kill("SIGKILL"), 3000);
    }
  }
}

const MIME = {
  ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".css": "text/css",
  ".json": "application/json", ".svg": "image/svg+xml", ".png": "image/png",
  ".ico": "image/x-icon", ".woff2": "font/woff2", ".map": "application/json",
};

// 空闲会话回收：无 WS 客户端且 20 分钟无事件 → kill 进程（防 claude 常驻堆积耗尽容器内存；历史可 resume 续聊）
setInterval(() => {
  const now = Date.now();
  for (const [id, s] of sessions) {
    if (s.clients.size === 0 && s.alive && now - s.lastActive > 20 * 60 * 1000) {
      console.log(`[ccweb] 会话 ${id} 空闲回收（可从历史恢复）`);
      s.kill();
      sessions.delete(id);
    }
  }
}, 60_000).unref();

// ---- 官方 transcript（~/.claude/projects）----
// 持久化全部交给 claude 自动落盘；此处只读。
// 目录名是 cwd 编码（/root → -root），但编码规则可能随版本变，
// 故不从目录名反推 cwd，一律读行内 cwd 字段。
async function readHeadLines(p, maxBytes = 65536) {
  const fh = await open(p, "r");
  try {
    const buf = Buffer.alloc(maxBytes);
    const { bytesRead } = await fh.read(buf, 0, maxBytes, 0);
    const lines = buf.subarray(0, bytesRead).toString("utf8").split("\n");
    lines.pop(); // 尾行可能被截断，丢弃
    return lines.filter((l) => l.trim());
  } finally { await fh.close(); }
}
function parseLine(l) { try { return JSON.parse(l); } catch { return null; } }
// 首个真实用户文本（跳过斜杠命令与系统注入），作标题；也是历史回放里保留该行的判据
function titleText(ev) {
  if (ev?.type !== "user" || ev.isMeta) return null;
  const c = ev.message?.content;
  const text = typeof c === "string" ? c
    : Array.isArray(c) ? c.filter((x) => x.type === "text").map((x) => x.text).join("") : "";
  const t = text.trim();
  if (!t || t.startsWith("/") || t.startsWith("<") || t.startsWith("Caveat:")
    || t.startsWith("This session is being continued")) return null;
  return t.slice(0, 40);
}
async function listTranscripts() {
  const out = [];
  try {
    for (const dir of await readdir(PROJECTS, { withFileTypes: true })) {
      if (!dir.isDirectory()) continue;
      let files = [];
      try { files = await readdir(jj(PROJECTS, dir.name)); } catch { continue; }
      for (const f of files) {
        if (!f.endsWith(".jsonl")) continue;
        const p = jj(PROJECTS, dir.name, f);
        try {
          const st = await stat(p);
          let cwd = "", title = "";
          for (const l of await readHeadLines(p)) {
            const ev = parseLine(l);
            if (!ev) continue;
            cwd = cwd || ev.cwd;
            if (!title) title = titleText(ev) || "";
            if (cwd && title) break;
          }
          if (cwd) out.push({ id: f.replace(/\.jsonl$/, ""), cwd, title, startedAt: st.mtimeMs });
        } catch {}
      }
    }
  } catch {}
  return out;
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url, "http://x");
  let pathname = stripBase(url.pathname);
  if (pathname === null) {
    // SPA 入口（整个路径 = base）：尾斜杠是相对资源解析的前提，缺则 301 补上（保留 query）
    if (!url.pathname.endsWith("/")) {
      res.writeHead(301, { Location: url.pathname + "/" + url.search });
      return res.end();
    }
    pathname = "/";
  }
  const json = (code, obj) => {
    res.writeHead(code, { "Content-Type": "application/json" });
    res.end(JSON.stringify(obj));
  };
  // ---- API ----
  // 环境报告:容器内(仅本容器管理) vs 宿主机(多管容器/微服务);keeperd 可达性
  // + 工作区/模型清单(面板探针)。注意只有这一个 /api/env：管理终端(kdEnv)与
  // 面板(App)各取所需字段——曾因两个同名路由，前者先命中把 models/home 挡成
  // 不可达，前端 ctx 窗口 hints 因此恒空、历史模式分母兜底 200k 虚高 5 倍
  if (pathname === "/api/env" && req.method === "GET") {
    const container = existsSync("/.dockerenv");
    let keeperd = false;
    try {
      const r = await fetch(`${KEEPERD_URL}/healthz`, { signal: AbortSignal.timeout(1500) });
      keeperd = r.ok;
    } catch {}
    // 模型清单（运行时从 claude settings 推导，不硬编码）：
    // 别名恒有效（CLI 经 ANTHROPIC_DEFAULT_*_MODEL 解析）；直连值来自映射本身与顶层 model 字段
    const models = new Set(["sonnet", "opus", "haiku"]);
    try {
      const st = JSON.parse(readFileSync(jj(CHILD_HOME, ".claude", "settings.json"), "utf8"));
      const env = st.env ?? {};
      for (const k of ["ANTHROPIC_DEFAULT_SONNET_MODEL", "ANTHROPIC_DEFAULT_OPUS_MODEL", "ANTHROPIC_DEFAULT_HAIKU_MODEL"])
        if (env[k]) models.add(env[k]);
      if (st.model) models.add(st.model);
    } catch {}
    models.add("default");
    return json(200, {
      container, keeperd, keeperd_url: KEEPERD_URL,
      home: CHILD_HOME, platform: process.platform, claude: claudeCmd().bin, models: [...models], single: SINGLE,
    });
  }
  // keeperd 反代:/api/keeper/{path} → keeperd/{path}(透传方法/头/体;鉴权由前端带 Authorization)
  if (pathname.startsWith("/api/keeper/") && req.method !== "GET") {
    let body = ""; try { body = await readBody(req); } catch { return; }
    try {
      const r = await fetch(`${KEEPERD_URL}${pathname.slice("/api/keeper".length)}${req.url.includes("?") ? "?" + req.url.split("?")[1] : ""}`, {
        method: req.method,
        headers: { "content-type": "application/json", ...(req.headers.authorization ? { authorization: req.headers.authorization } : {}) },
        body: body || undefined,
        signal: AbortSignal.timeout(600_000),
      });
      const text = await r.text();
      res.writeHead(r.status, { "content-type": r.headers.get("content-type") || "application/json" });
      return res.end(text);
    } catch (e) { return json(502, { error: "keeperd 不可达: " + String(e.message) }); }
  }
  if (pathname.startsWith("/api/keeper/")) {
    try {
      const r = await fetch(`${KEEPERD_URL}${pathname.slice("/api/keeper".length)}${req.url.includes("?") ? "?" + req.url.split("?")[1] : ""}`, {
        headers: req.headers.authorization ? { authorization: req.headers.authorization } : {},
        signal: AbortSignal.timeout(60_000),
      });
      const text = await r.text();
      res.writeHead(r.status, { "content-type": r.headers.get("content-type") || "application/json" });
      return res.end(text);
    } catch (e) { return json(502, { error: "keeperd 不可达: " + String(e.message) }); }
  }
  if (pathname === "/api/sessions" && req.method === "GET") {
    // n = buf 事件数：>0 表示进程已发过事件（回放即全量，前端无需再取 transcript）
    return json(200, [...sessions.values()].map(s => ({
      id: s.id, cwd: s.cwd, startedAt: s.startedAt, alive: s.alive, pid: s.proc.pid, claude_sid: s.claudeSid || null,
      n: s.buf.length,
    })));
  }
  if (pathname === "/api/sessions" && req.method === "POST") {
    let body = "";
    try { body = await readBody(req); } catch { return; } // 客户端已断开/超大，回包无意义
    let cwd = CHILD_HOME, resume = null;
    try { const q = JSON.parse(body); cwd = q.cwd || cwd; resume = q.resume || null; } catch {}
    cwd = safePath(cwd) || CHILD_HOME; // 会话 cwd 钳制到工作区（历史 transcript 的 cwd 可能在任意目录）
    try { await stat(cwd); } catch { return json(400, { error: "目录不存在: " + cwd }); }
    // resume 幂等：该官方会话已有活进程持有（前端重复 resume / 刷新竞态）→ 返回既有会话不 spawn。
    // 否则同 sid 双进程交错追加写同一 transcript，历史分叉不可恢复
    if (resume) {
      for (const s of sessions.values())
        if (s.claudeSid === resume && s.alive)
          return json(200, { id: s.id, cwd: s.cwd, resumed: true, claudeSid: resume, dedup: true });
    }
    // 单会话形态：resume 幂等未命中 → kill 既有活会话再开新的（回到"一个会话顶掉一个"）
    if (SINGLE) {
      for (const s of sessions.values()) { s.kill(); sessions.delete(s.id); }
    }
    const id = randomUUID().slice(0, 8);
    sessions.set(id, new Session(id, cwd, resume));
    // claudeSid：resume 时即官方会话 ID——前端用它做 ChatPanel 的 key，
    // 历史→resume 续聊不换 key 就不重挂，消息列表不会整个重刷
    return json(200, { id, cwd, resumed: !!resume, claudeSid: resume || null });
  }
  const del = pathname.match(/^\/api\/sessions\/([\w-]+)$/);
  if (del && req.method === "DELETE") {
    const s = sessions.get(del[1]);
    if (!s) return json(404, { error: "会话不存在" });
    s.kill();
    sessions.delete(del[1]);
    return json(200, { ok: true });
  }
  if (pathname === "/api/fs") {
    const p = safePath(url.searchParams.get("path") || CHILD_HOME);
    const hidden = url.searchParams.get("hidden") === "1";
    try {
      const ents = await readdir(p, { withFileTypes: true });
      const dirs = ents.filter(e => e.isDirectory() && (hidden || !e.name.startsWith(".")))
        .map(e => e.name).sort();
      const files = [];
      for (const e of ents) {
        if (!e.isFile() || (!hidden && e.name.startsWith("."))) continue;
        files.push({ name: e.name, size: (await stat(jj(p, e.name))).size });
      }
      files.sort((a, b) => a.name.localeCompare(b.name));
      return json(200, { path: p, dirs, files });
    } catch (e) { return json(400, { error: String(e.message) }); }
  }
  // 目录浏览（工作目录选择器用）：只列子目录；path 空 = 根级（win 盘符列表 / linux /）
  if (pathname === "/api/fs/dirs") {
    const q = safePath(url.searchParams.get("path") || "");
    const hidden = url.searchParams.get("hidden") === "1";
    const rootLevel = !q || q === "/";
    if (IS_WIN && rootLevel) {
      const drives = [];
      for (let c = 65; c <= 90; c++) {
        const d = String.fromCharCode(c) + ":";
        try { await stat(d + "/"); drives.push(d); } catch {}
      }
      return json(200, { path: "", dirs: drives, drives: true });
    }
    const base = rootLevel ? "/" : q;
    try {
      const ents = await readdir(base, { withFileTypes: true });
      const dirs = ents.filter(e => e.isDirectory() && (hidden || !e.name.startsWith(".")))
        .map(e => e.name).sort();
      return json(200, { path: base, dirs, drives: false });
    } catch (e) { return json(400, { error: String(e.message) }); }
  }
  if (pathname === "/api/fs/file" && req.method === "GET") {
    const p = safePath(url.searchParams.get("path") || "");
    if (!p) return json(400, { error: "路径超出工作区范围" });
    try {
      const st = await stat(p);
      if (st.isDirectory()) return json(400, { error: "是目录" });
      const size = st.size;
      const fh = await readFile(p, { encoding: null, flag: "r" });
      const head = fh.subarray ? fh.subarray(0, 8000) : fh;
      let binary = false;
      for (const b of head) { if (b === 0) { binary = true; break; } }
      if (binary || size > 512 * 1024)
        return json(200, { path: p, size, binary: true, content: null });
      const content = fh.toString("utf8");
      return json(200, { path: p, size, binary: false, content });
    } catch (e) { return json(400, { error: String(e.message) }); }
  }
  // ---- 文件原始字节流（图片/SVG 等预览用；按扩展名给 MIME，流式直发）----
  if (pathname === "/api/fs/raw" && req.method === "GET") {
    const MIME = {
      ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif",
      ".webp": "image/webp", ".bmp": "image/bmp", ".ico": "image/x-icon", ".avif": "image/avif",
      ".svg": "image/svg+xml", ".pdf": "application/pdf",
    };
    const p = safePath(url.searchParams.get("path") || "");
    if (!p) return json(400, { error: "路径超出工作区范围" });
    try {
      const st = await stat(p);
      if (st.isDirectory()) return json(400, { error: "是目录" });
      res.writeHead(200, {
        "Content-Type": MIME[extname(p).toLowerCase()] || "application/octet-stream",
        "Content-Length": st.size, "Cache-Control": "no-store",
        "Content-Disposition": "inline",
      });
      createReadStream(p).pipe(res);
      return; // 勿落入静态文件 fallback（会二次写头导致进程崩溃）
    } catch (e) { return json(400, { error: String(e.message) }); }
  }
  if (pathname === "/api/fs/file" && req.method === "PUT") {
    let body = "";
    try { body = await readBody(req); } catch { return; }
    let q;
    try { q = JSON.parse(body); } catch { return json(400, { error: "bad json" }); }
    const p = safePath(q.path || "");
    if (!p) return json(400, { error: "路径超出工作区范围" });
    try {
      const { writeFile } = await import("node:fs/promises");
      await writeFile(p, String(q.content ?? ""), "utf8");
      return json(200, { ok: true, path: p, size: String(q.content ?? "").length });
    } catch (e) { return json(400, { error: String(e.message) }); }
  }
  // ---- 资源管理器右键操作：mkdir / touch / rename / delete / upload（base64）----
  if (pathname === "/api/fs/op" && req.method === "POST") {
    let body = "";
    try { body = await readBody(req, 90 * 1024 * 1024); } catch (e) {
      if (String(e.message).includes("too large")) return json(413, { error: "文件过大（base64 后 >90MB）" });
      return; // 客户端断开
    }
    let q; try { q = JSON.parse(body); } catch { return json(400, { error: "bad json" }); }
    try {
      if (q.op === "mkdir") {
        const p = safePath(jj(q.path, q.name || ""));
        if (!p || p === CHILD_HOME) throw new Error("非法路径");
        if (existsSync(p)) throw new Error("已存在同名文件/文件夹"); // recursive 对已存在静默，新建必须报重名
        await mkdir(p, { recursive: true });
        return json(200, { ok: true, path: p });
      }
      if (q.op === "touch") {
        const p = safePath(jj(q.path, q.name || ""));
        if (!p || p === CHILD_HOME) throw new Error("非法路径");
        if (existsSync(p)) throw new Error("已存在同名文件");
        await writeFile(p, "", "utf8");
        return json(200, { ok: true, path: p });
      }
      if (q.op === "copy") {
        const from = safePath(q.path), to = safePath(q.to);
        if (!from || !to || from === CHILD_HOME || from === to) throw new Error("非法路径");
        if (existsSync(to)) throw new Error("目标已存在同名文件/文件夹");
        if (to.startsWith(from + "/")) throw new Error("不能复制到自身内部");
        const st = await stat(from);
        if (st.isDirectory()) await cp(from, to, { recursive: true });
        else await copyFile(from, to);
        return json(200, { ok: true, path: to });
      }
      if (q.op === "rename") {
        const from = safePath(q.path), to = safePath(q.to);
        if (!from || !to || from === CHILD_HOME) throw new Error("非法路径");
        if (from === to) return json(200, { ok: true, path: to }); // 未改名直接确认=幂等 no-op
        if (existsSync(to)) throw new Error("目标已存在");
        await renamePath(from, to);
        return json(200, { ok: true, path: to });
      }
      if (q.op === "delete") {
        const p = safePath(q.path);
        if (!p || p === "/" || p === CHILD_HOME || /^[A-Za-z]:\/?$/.test(p))
          throw new Error("不能删除根目录/盘符");
        await rm(p, { recursive: true, force: true });
        return json(200, { ok: true });
      }
      if (q.op === "upload") {
        const p = safePath(jj(q.path, q.name || ""));
        if (!p) throw new Error("非法路径");
        const buf = Buffer.from(String(q.data || ""), "base64");
        await mkdir(dd(p), { recursive: true }); // 文件夹上传时 name 带子路径
        await writeFile(p, buf);
        return json(200, { ok: true, path: p, size: buf.length });
      }
      return json(400, { error: "未知操作 " + q.op });
    } catch (e) { return json(400, { error: String(e.message) }); }
  }
  // 下载：文件直传，目录打包 tar.gz 流式返回
  if (pathname === "/api/fs/download" && req.method === "GET") {
    const p = safePath(url.searchParams.get("path") || "");
    if (!p || p === CHILD_HOME) return json(400, { error: "非法路径" });
    const name = p.split("/").pop();
    try {
      const st = await stat(p);
      if (st.isFile()) {
        res.writeHead(200, {
          "Content-Type": "application/octet-stream",
          "Content-Length": st.size,
          "Content-Disposition": `attachment; filename*=UTF-8''${encodeURIComponent(name)}`,
        });
        createReadStream(p).pipe(res);
        return;
      }
      const tar = spawn("tar", ["czf", "-", "-C", dd(p), name], { env: CHILD_ENV, windowsHide: true });
      tar.stderr.on("data", () => {});
      req.on("close", () => tar.kill());
      res.writeHead(200, {
        "Content-Type": "application/x-gzip",
        "Content-Disposition": `attachment; filename*=UTF-8''${encodeURIComponent(name + ".tar.gz")}`,
      });
      tar.stdout.pipe(res);
      tar.on("exit", () => res.end());
      return; // 已接管响应，勿落入静态文件 fallback（会二次写头导致进程崩溃）
    } catch (e) { return json(400, { error: String(e.message) }); }
  }
  if (pathname === "/api/history") {
    // 历史 = 官方 transcript（按行内 cwd 分组，mtime 排序）
    const groups = new Map();
    for (const m of await listTranscripts()) {
      if (!groups.has(m.cwd)) groups.set(m.cwd, []);
      groups.get(m.cwd).push(m);
    }
    return json(200, [...groups.entries()].map(([cwd, list]) => ({
      cwd, sessions: list.sort((a, b) => b.startedAt - a.startedAt).slice(0, 50),
    })));
  }
  const hist = pathname.match(/^\/api\/history\/([\w-]+)$/);
  if (hist && req.method === "GET") {
    // 回放单个 transcript：id 即 claude session_id（transcript 文件名）
    const sid = hist[1];
    let path = null;
    try {
      for (const dir of await readdir(PROJECTS, { withFileTypes: true })) {
        if (!dir.isDirectory()) continue;
        const p = jj(PROJECTS, dir.name, sid + ".jsonl");
        if (existsSync(p)) { path = p; break; }
      }
    } catch {}
    if (!path) return json(404, { error: "历史不存在" });
    const events = [];
    let model = null; // 最后一次 assistant 的模型（transcript 无 init，前端恢复会话时用它显示模型名）
    // 用量：transcript 无 result 行，最后一条 assistant 的 message.usage 即该轮总上下文（恢复时还原 ctx%）
    let usage = null, modelUsage = null;
    for (const l of (await readFile(path, "utf8")).split("\n")) {
      const ev = parseLine(l);
      if (!ev) continue;
      if (ev.type === "assistant") {
        // sidechain（Task 子代理）/meta 行不进主消息流，usage 也不算 ctx——
        // 子代理上下文远小于主链，取到会把恢复会话的 ctx% 骤然算小
        // （老 keeper CtxUsage 同款过滤，有 farm ctx 5x%↔10% 跳变实锤案例）
        if (ev.isSidechain || ev.isMeta) continue;
        if (ev.message?.model) model = ev.message.model;
        if (ev.message?.usage) usage = ev.message.usage;
        if (Array.isArray(ev.message?.content) && ev.message.content.length)
          events.push({ type: "assistant", message: ev.message });
      } else if (ev.type === "user" && !ev.isMeta) {
        const c = ev.message?.content;
        const hasTR = Array.isArray(c) && c.some((x) => x.type === "tool_result");
        if (hasTR || titleText(ev)) events.push({ type: "user", message: { role: "user", content: c } });
      } else if (ev.type === "result") {
        if (ev.usage) usage = ev.usage;
        if (ev.modelUsage) modelUsage = ev.modelUsage;
      }
    }
    // 尾部追加合成 result 事件：前端 reducer 一遍处理即还原 ctx%（无需新协议）。
    // transcript 无 result 行 → modelUsage 为空，用落盘的窗口记忆合成（裸名键，
    // 前端 exact 级直接命中），分母不再依赖浏览器 localStorage
    if (usage) {
      if (!modelUsage) {
        const win = await ctxWinOf(model);
        if (win) modelUsage = { [String(model ?? "")]: { contextWindow: win } };
      }
      events.push({ type: "result", subtype: "success", usage, modelUsage, model });
    }
    return json(200, { id: sid, events, model });
  }
  // ---- 静态 ----（SEA 嵌入态/裸跑 dist 双态，见 readStatic）
  // index.html 原样发：资源全相对引用（vite base:'./'），base 由前端从地址栏自推导
  // 缓存策略：index.html 必须 no-cache（每次回源校验），否则浏览器启发式缓存导致部署后普通刷新拿到旧 JS；
  // /assets/ 均为内容哈希文件名，可 immutable 长缓存
  let rel = decodeURIComponent(pathname);
  if (rel.endsWith("/")) rel += "index.html"; // 目录语义 → index（SEA 态无 fs，统一按 dist 相对路径查）
  rel = rel.replace(/^\//, "");
  const cacheFor = (r) => r.startsWith("assets/")
    ? "public, max-age=31536000, immutable"
    : "no-cache";
  let data = await readStatic(rel);
  if (!data && rel !== "index.html") data = await readStatic("index.html"); // SPA fallback
  if (!data) { res.writeHead(404); return res.end("dist 未构建"); }
  res.writeHead(200, { "Content-Type": MIME[extname(rel)] || "application/octet-stream", "Cache-Control": cacheFor(rel) });
  return res.end(data);
});

const wss = new WebSocketServer({ noServer: true });

// ---- 文件变更推送（/ws/fs）：fs.watch(inotify) 按需订阅，事件驱动零轮询 ----
// 客户端 sub 当前关注的目录集合（树展开目录 + 打开文件所在目录，replace 语义）；
// 服务端对被订阅目录建 watch，事件去抖 120ms 聚合，按各 ws 的订阅交集推 {t:"fs",dirs:[...]}。
// 客户端收到后定向重取目录列表/文件内容——树与编辑器随外部修改（claude 写文件/终端操作）
// 自动刷新，多标签页之间也天然同步。收起的目录自动退订，watch 数量始终 = 可见展开数。
const fsWss = new WebSocketServer({ noServer: true });
/** @type {Map<WebSocket, Set<string>>} 每个 ws 订阅的目录集合 */
const wsDirs = new Map();
/** @type {Map<string, {subs:Set<WebSocket>, w:import("node:fs").FSWatcher}>} */
const dirWatches = new Map();
let fsDirty = new Set(), fsDirtyTimer = null;

function fsFlush() {
  fsDirtyTimer = null;
  const dirs = [...fsDirty];
  fsDirty = new Set();
  for (const [ws, set] of wsDirs) {
    if (ws.readyState !== 1) continue;
    const hit = dirs.filter((d) => set.has(d));
    if (hit.length) ws.send(JSON.stringify({ t: "fs", dirs: hit }));
  }
}
function fsMarkDirty(dir) {
  fsDirty.add(dir);
  if (!fsDirtyTimer) fsDirtyTimer = setTimeout(fsFlush, 120);
}
function fsDropWatch(dir) {
  const e = dirWatches.get(dir);
  if (!e || e.subs.size) return;
  dirWatches.delete(dir);
  try { e.w.close(); } catch {}
}
function fsAddWatch(dir, ws) {
  let e = dirWatches.get(dir);
  if (e) { e.subs.add(ws); return; }
  let w;
  try {
    // 目录内任何增删改名都归并为「该目录有变」——不逐事件转发，客户端重取列表最稳
    w = fsWatch(dir, () => fsMarkDirty(dir));
  } catch { return; } // 目录不可观（已删/权限）：静默跳过，客户端退回手动刷新
  e = { subs: new Set([ws]), w };
  dirWatches.set(dir, e);
  w.on("error", () => {
    // watch 失效（目录被删/移走）：通知订阅者刷新后清理
    for (const s of e.subs) if (s.readyState === 1) s.send(JSON.stringify({ t: "fs", dirs: [dir] }));
    e.subs.clear();
    fsDropWatch(dir);
  });
}
function fsSetSubs(ws, dirs) {
  const old = wsDirs.get(ws) || new Set();
  const next = new Set(dirs.filter(Boolean));
  wsDirs.set(ws, next);
  for (const d of next) if (!old.has(d)) fsAddWatch(d, ws);
  for (const d of old) {
    if (next.has(d)) continue;
    dirWatches.get(d)?.subs.delete(ws);
    fsDropWatch(d);
  }
}

server.on("upgrade", (req, sock, head) => {
  const wsPath = stripBase(new URL(req.url, "http://x").pathname);
  if (wsPath === null) { sock.destroy(); return; }
  // 文件变更通道（全局，不挂会话）
  if (wsPath === "/ws/fs") {
    fsWss.handleUpgrade(req, sock, head, (ws) => {
      wsDirs.set(ws, new Set());
      ws.on("message", (raw) => {
        let m;
        try { m = JSON.parse(raw); } catch { return; }
        if (m.t === "sub" && Array.isArray(m.dirs)) fsSetSubs(ws, m.dirs.map(safePath));
      });
      ws.on("close", () => {
        const dirs = wsDirs.get(ws) || new Set();
        wsDirs.delete(ws);
        for (const d of dirs) {
          dirWatches.get(d)?.subs.delete(ws);
          fsDropWatch(d);
        }
      });
      ws.on("error", () => {});
    });
    return;
  }
  const m = wsPath.match(/^\/ws\/([\w-]+)$/);
  if (!m || !sessions.has(m[1])) { sock.destroy(); return; }
  wss.handleUpgrade(req, sock, head, (ws) => {
    const s = sessions.get(m[1]);
    s.clients.add(ws);
    // 回放：定稿事件 + 未完增量
    ws.send(JSON.stringify({ t: "replay", cwd: s.cwd, alive: s.alive }));
    for (const ev of s.buf) ws.send(JSON.stringify({ t: "cc", ev }));
    if (s.partial) ws.send(JSON.stringify({ t: "cc", ev: { type: "stream_event", event: { delta: { text: s.partial } } } }));
    ws.on("message", (raw) => {
      let msg;
      try { msg = JSON.parse(raw); } catch { return; }
      if (!s.alive) return;
      if (msg.t === "user") s.sendUser(msg.text);
      else if (msg.t === "interrupt") s.interrupt();
      else if (msg.t === "ctrl") s.ctrl(msg.sub, msg.args);
    });
    ws.on("close", () => s.clients.delete(ws));
  });
});

server.listen(PORT, () => {
  const cc = claudeCmd();
  console.log(`[ccweb] http://0.0.0.0:${PORT}  (home: ${CHILD_HOME}, claude: ${cc.bin})`);
});

// 退出清理：结束所有 claude 子进程，防孤儿耗尽容器内存
for (const sig of ["SIGTERM", "SIGINT"]) {
  process.on(sig, () => {
    for (const s of sessions.values()) s.kill();
    setTimeout(() => process.exit(0), 500);
  });
}
