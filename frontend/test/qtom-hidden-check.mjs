// qtom 前端隐藏验证（2026-11-09 通道下线）：后端配了 --dsweb（engines 含 qtom）时，
// UI 引擎切换按钮不出现；localStorage 残留 qweb.engine=qtom 时新会话回落 claude。
// 前置：dsweb-stub.mjs 在 8312 + qweb 以 --dsweb http://127.0.0.1:8312 启动。
// 用法：node frontend/test/qtom-hidden-check.mjs http://127.0.0.1:18099
import { chromium } from "playwright";
const base = process.argv[2]?.replace(/\/+$/, "");
if (!base) { console.error("用法: node qtom-hidden-check.mjs <qweb-base-url>"); process.exit(2); }
const fail = (m) => { console.error("✗ " + m); process.exit(1); };

// 0. 后端确实暴露 qtom（前置成立才验证得上"前端隐藏"）
const env = await fetch(`${base}/api/env`).then(r => r.json());
const hasQtom = env.engines?.some(e => e.id === "qtom");
hasQtom || console.log("（注：后端未配 --dsweb，engines 本就无 qtom——隐藏逻辑空转验证）");

let b;
try { b = await chromium.launch(); }
catch { b = await chromium.launch({ channel: "chrome" }); } // 无 playwright 浏览器时用系统 Chrome
const pg = await b.newPage();
try {
  // 1. 残留 qtom 偏好 → 打开后应回落
  await pg.addInitScript(() => localStorage.setItem("qweb.engine", "qtom"));
  await pg.goto(base + "/");
  await pg.waitForTimeout(2500); // /api/env 到达 + 引擎清单处理
  const body = await pg.locator("body").innerText();
  // 工具栏引擎按钮文案是 "qtom"（Cat 图标+文字）；过滤后 length≤1 按钮不渲染
  const btn = body.split("\n").filter(l => l.trim() === "qtom");
  btn.length === 0 || fail(`引擎切换按钮仍暴露 qtom（工具栏出现 ${btn.length} 处）`);

  // 2. 新会话回落 claude：开新会话，list 里 engine 应为 claude
  await pg.getByRole("button", { name: /新会话/ }).click();
  await pg.waitForTimeout(1200);
  const list = await fetch(`${base}/api/sessions`).then(r => r.json());
  const mine = list.length ? list[list.length - 1] : null;
  mine && (mine.engine ?? "claude") === "claude" || fail(`残留 qtom 偏好未回落：新会话 engine=${mine?.engine}`);
  for (const s of list) await fetch(`${base}/api/sessions/${s.id}`, { method: "DELETE" }).catch(() => {});
  console.log(`✓ 引擎按钮已隐藏（后端 engines=${env.engines?.map(e => e.id).join(",") || "—"}${hasQtom ? "，含 qtom 但 UI 不暴露" : ""}）`);
  console.log("✓ localStorage 残留 qtom 偏好回落 claude（新会话 engine=claude）");
} finally { await b.close(); }
