// 三修复真链路验证：A) spawn 唤醒 → init 免首消息下发（slash 立即可用）
// B) set_permission_mode 经 qweb WS 的回包 + status 广播  C) result.usage 被 transcript
// 单请求真值替换（不再按整轮累计虚高）。用法：node fix3-verify.mjs [base]
import { setTimeout as sleep } from "node:timers/promises";
import fs from "node:fs";
import path from "node:path";
const base = (process.argv[2] || "http://127.0.0.1:18090").replace(/\/+$/, "");
const CWD = path.join(process.env.TEMP || "/tmp", "qweb-verify");
fs.mkdirSync(CWD, { recursive: true });

const s = await fetch(`${base}/api/sessions`, {
  method: "POST", headers: { "content-type": "application/json" },
  body: JSON.stringify({ cwd: CWD }),
}).then(r => r.json());
console.log(`✓ 会话创建 id=${s.id}`);

const events = [];
let sid = null;
const ws = new WebSocket(base.replace(/^http/, "ws") + `/ws/${s.id}`);
const wait = ms => new Promise(res => { const t = setTimeout(res, ms); return t; });
ws.onmessage = e => { const m = JSON.parse(e.data); if (m.t === "cc") events.push(m.ev); };

// A：不发任何用户消息，纯等唤醒触发的 init
await new Promise(r => ws.onopen = r);
const t0 = Date.now();
let init = null;
while (Date.now() - t0 < 8000 && !init) { init = events.find(v => v.type === "system" && v.subtype === "init"); await wait(150); }
if (!init) throw new Error("✗ A：8s 内无 init（唤醒未生效）");
if (!init.session_id) throw new Error("✗ A：init 无 session_id");
sid = init.session_id;
console.log(`✓ A：init ${(Date.now() - t0)}ms 即达（未发首条消息）—— slash_commands=${init.slash_commands?.length ?? 0} 项，permissionMode=${init.permissionMode}`);

// B：经 qweb WS 通道切模式
ws.send(JSON.stringify({ t: "ctrl", sub: "set_permission_mode", args: { mode: "plan" } }));
let modeEcho = null, statusBc = null;
const t1 = Date.now();
while (Date.now() - t1 < 5000 && !(modeEcho && statusBc)) {
  modeEcho ||= events.find(v => v.type === "control_response" && v.response?.response?.mode === "plan");
  statusBc ||= events.find(v => v.type === "system" && v.subtype === "status" && v.permissionMode === "plan");
  await wait(150);
}
if (!modeEcho) throw new Error("✗ B：无 control_response mode 回显");
if (!statusBc) throw new Error("✗ B：无 status 广播");
console.log("✓ B：set_permission_mode 经 WS 通道回显 + status 广播双确认");
// 切回 default，别影响后续验证轮的 Bash 执行
ws.send(JSON.stringify({ t: "ctrl", sub: "set_permission_mode", args: { mode: "default" } }));
await wait(600);

// C：带工具调用的轮 → result.usage 应为 transcript 最后一条主行 assistant 的单请求真值
ws.send(JSON.stringify({ t: "user", text: "用 Bash 工具运行 echo hi，拿到输出后回复 done" }));
let result = null;
const t2 = Date.now();
// 唤醒的 /model 也产一条 num_turns=0 的 result（"isn't available"，零 usage）——过滤掉
while (Date.now() - t2 < 90000 && !result) { result = events.find(v => v.type === "result" && v.subtype === "success" && v.num_turns > 0); await wait(300); }
if (!result) throw new Error("✗ C：90s 无 result");
const sum = u => (u.input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0);
console.log(`✓ C：result 到达（num_turns=${result.num_turns}），usage 三项和=${sum(result.usage)}，modelUsage 窗口=${Object.values(result.modelUsage ?? {})[0]?.contextWindow}`);

// transcript 真值（最后一条非 sidechain/meta 的 assistant 行 usage）
await sleep(500); // 落盘余量
const projDir = path.join(process.env.USERPROFILE || process.env.HOME, ".claude", "projects");
let tr = null;
for (const d of fs.readdirSync(projDir)) {
  const p = path.join(projDir, d, `${sid}.jsonl`);
  if (fs.existsSync(p)) { tr = p; break; }
}
if (!tr) throw new Error("✗ C：transcript 未找到");
let truth = null;
for (const l of fs.readFileSync(tr, "utf8").split("\n").reverse()) {
  if (!l.trim()) continue;
  let ev; try { ev = JSON.parse(l); } catch { continue; }
  if (ev.type === "assistant" && !ev.isSidechain && !ev.isMeta && sum(ev.message?.usage ?? {}) > 0) { truth = ev.message.usage; break; }
}
if (!truth) throw new Error("✗ C：transcript 无真值行");
const got = sum(result.usage), want = sum(truth);
const pct = Math.min(100, Math.round(got / (Object.values(result.modelUsage ?? {})[0]?.contextWindow || 200000) * 100));
// 替换判据：got 是"某一条单请求真值"（≤ 末行 want + 容差；偶发落盘竞态读到前一条，
// 略小于 want 且下一轮自愈），而中转累积假值 ≈ 2×want（各请求之和）必然显著超出
if (!(got > 0 && got >= want * 0.5 && got <= want * 1.05))
  throw new Error(`✗ C：分子异常 got=${got} want=${want}（未替换的累积假值 ≈ ${got + want}+）`);
console.log(`✓ C：分子 = transcript 单请求真值（${got}，末行 ${want}）→ ctx ≈ ${pct}%（未修复的累积假值会 ≈ ${got + want}）`);
ws.close();
await fetch(`${base}/api/sessions/${s.id}`, { method: "DELETE" }).catch(() => {});
console.log("\n✓ 三项全过\n");
