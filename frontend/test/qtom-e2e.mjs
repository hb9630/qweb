// qtom 引擎端到端：POST engine:qtom → WS 帧序列断言（init→流式→工具→审批→tool_result→二轮→result）
// → 会话列表 engine → resume（transcript 推导引擎 + pre 回放）。前置：dsweb-stub.mjs 在 8312，
// qweb 以 --dsweb http://127.0.0.1:8312 启动。用法：node frontend/test/qtom-e2e.mjs http://127.0.0.1:18099
const base = process.argv[2]?.replace(/\/+$/, "");
if (!base) { console.error("用法: node qtom-e2e.mjs <qweb-base-url>"); process.exit(2); }
const fail = (m) => { console.error("✗ " + m); process.exit(1); };
const wsUrl = (id) => base.replace(/^http/, "ws") + `/ws/${id}`;

// ---- 1. /api/env 引擎清单 ----
const env = await fetch(`${base}/api/env`).then(r => r.json());
const q = env.engines?.find(e => e.id === "qtom") ?? fail("engines 无 qtom（qweb 未配 --dsweb？）");
console.log(`✓ 引擎清单: ${env.engines.map(e => e.id).join(", ")}（${q.label}）`);

// ---- 2. 创建 qtom 会话 ----
const s = await fetch(`${base}/api/sessions`, {
  method: "POST", headers: { "content-type": "application/json" },
  body: JSON.stringify({ engine: "qtom", cwd: "/tmp/qtom-e2e" }),
}).then(r => r.json());
s.engine === "qtom" || fail(`engine 应为 qtom，得到 ${s.engine}`);
console.log(`✓ qtom 会话创建 id=${s.id}`);

// ---- 3. WS 帧序列断言 ----
const expect = [
  ["init", (ev) => ev.subtype === "init" && ev.model === "deepseek-web" && /^[0-9a-f-]{8,}$/.test(ev.session_id)],
  ["user回显", (ev) => ev.type === "user" && ev.message?.content?.[0]?.text?.includes("echo hi")],
  ["message_start", (ev) => ev.type === "stream_event" && ev.event?.type === "message_start"],
  ["text流", (ev) => ev.type === "stream_event" && ev.event?.delta?.text],
  ["tool_use块", (ev) => ev.type === "stream_event" && ev.event?.content_block?.type === "tool_use"],
  ["assistant定稿", (ev) => ev.type === "assistant" && ev.message?.content?.some(b => b.type === "tool_use")],
  ["审批卡", (ev) => ev.type === "control_request" && ev.request?.subtype === "can_use_tool"],
  ["tool_result", (ev) => ev.type === "user" && ev.message?.content?.[0]?.type === "tool_result"],
  ["二轮message_start", (ev) => ev.type === "stream_event" && ev.event?.type === "message_start"],
  ["result", (ev) => ev.type === "result" && ev.modelUsage?.["deepseek-web"]?.contextWindow === 65536],
];
let i = 0;
let sid = null, permRid = null;
const ws = new WebSocket(wsUrl(s.id));
const turn = new Promise((ok, no) => {
  const t = setTimeout(() => no(new Error(`60s 未走完序列（卡在 ${expect[i]?.[0] ?? "完成"}）`)), 60000);
  ws.onmessage = (e) => {
    const m = JSON.parse(e.data);
    if (m.t !== "cc") return;
    const ev = m.ev;
    if (ev.type === "system" && ev.subtype === "init") sid = ev.session_id;
    // 审批卡：立即放行
    if (ev.type === "control_request" && ev.request?.subtype === "can_use_tool") {
      permRid = ev.request_id;
      ws.send(JSON.stringify({ t: "perm", rid: permRid, allow: true }));
    }
    while (i < expect.length && expect[i][1](ev)) {
      console.log(`✓ [${i + 1}/${expect.length}] ${expect[i][0]}`);
      i++;
    }
    if (i >= expect.length) { clearTimeout(t); ok(); }
  };
  ws.onerror = () => no(new Error("WS 连接错误"));
});
await new Promise(r => ws.onopen = r);
ws.send(JSON.stringify({ t: "user", text: "运行 echo hi" }));
await turn;

// ---- 4. 会话列表带 engine ----
const list = await fetch(`${base}/api/sessions`).then(r => r.json());
list.find(x => x.id === s.id)?.engine === "qtom" || fail("会话列表缺 engine:qtom");
console.log("✓ 会话列表 engine:qtom");

// ---- 5. resume：transcript 推导引擎 + pre 回放 ----
// 先杀活会话（dedup 会命中活进程走 buf 回放，测不到 pre 路径）
ws.close();
await fetch(`${base}/api/sessions/${s.id}`, { method: "DELETE" }).catch(() => {});
await new Promise(r => setTimeout(r, 500));
const r2 = await fetch(`${base}/api/sessions`, {
  method: "POST", headers: { "content-type": "application/json" },
  body: JSON.stringify({ resume: sid }),
}).then(r => r.json());
r2.engine === "qtom" || fail(`resume 引擎推导失败：${r2.engine}（应从 transcript 读出 qtom）`);
console.log(`✓ resume 引擎推导 qtom（sid=${sid.slice(0, 8)}… dedup=${!!r2.dedup}）`);
const ws2 = new WebSocket(wsUrl(r2.id));
const pre = await new Promise((ok, no) => {
  const t = setTimeout(() => no(new Error("resume pre 帧 10s 未到")), 10000);
  ws2.onmessage = (e) => {
    const m = JSON.parse(e.data);
    if (m.t === "pre") { clearTimeout(t); ok(m.events); }
  };
  ws2.onerror = () => no(new Error("resume WS 错误"));
});
pre.length >= 4 || fail(`pre 回放事件过少: ${pre.length}`);
console.log(`✓ resume pre 回放 ${pre.length} 事件`);
ws2.close();

// ---- 6. 清理 ----
for (const id of [s.id, r2.id]) await fetch(`${base}/api/sessions/${id}`, { method: "DELETE" }).catch(() => {});
console.log("✓ qtom e2e 全通\n");
