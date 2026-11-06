// 端到端:入口HTML→JS完整性→POST会话→WS hello→等claude回复
import WebSocket from "ws";
const base = process.argv[2]; // 如 http://127.0.0.1:8880/app/xxx-8090
const j = await fetch(`${base}/`).then(r => r.text());
const js = j.match(/src="(\.\/assets\/[^"]+)"/)?.[1];
const u = new URL(js, base + "/").href;
const buf = await fetch(u).then(r => r.arrayBuffer());
console.log(`✓ 入口HTML + JS ${js} 拉取 ${(buf.byteLength/1024).toFixed(0)}KB`);
const s = await fetch(`${base}/api/sessions`, { method: "POST", headers: {"content-type":"application/json"}, body: JSON.stringify({cwd:"/tmp"}) }).then(r => r.json());
console.log(`✓ 会话创建 id=${s.id}`);
const b = new URL(base);
const ws = new WebSocket(b.protocol.replace(/^http/, "ws") + "//" + b.host + b.pathname.replace(/\/$/, "") + `/ws/${s.id}`);
const done = new Promise((ok, no) => { const t = setTimeout(() => no(new Error("60s 无回复")), 60000); ws.on("message", raw => { const m = JSON.parse(raw); if (m.t==="cc" && m.ev?.type==="stream_event" && m.ev.event?.delta?.text) { console.log("✓ claude 回复中:", JSON.stringify(m.ev.event.delta.text.slice(0,60))); clearTimeout(t); ok(); } if (m.t==="exit") { no(new Error("claude 退出 code="+m.code)); } }); });
await new Promise(r => ws.on("open", r));
ws.send(JSON.stringify({t:"user", text:"回复ok两个字母即可"}));
await done; ws.close(); console.log("✓ 端到端全通\n");
