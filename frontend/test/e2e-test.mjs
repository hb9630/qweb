// 端到端:入口HTML→JS完整性→POST会话→WS hello→等claude回复（原生 WebSocket，零依赖）
import os from "node:os"; // 会话 cwd 用系统临时目录（跨平台：win 无 /tmp）
const base = process.argv[2].replace(/\/+$/, ""); // 如 http://127.0.0.1:8880/app/xxx-8090；容忍带尾斜杠（npm script 默认带）
const j = await fetch(`${base}/`).then(r => r.text());
const js = j.match(/src="(\.\/assets\/[^"]+)"/)?.[1];
const u = new URL(js, base + "/").href;
const buf = await fetch(u).then(r => r.arrayBuffer());
console.log(`✓ 入口HTML + JS ${js} 拉取 ${(buf.byteLength/1024).toFixed(0)}KB`);
const s = await fetch(`${base}/api/sessions`, { method: "POST", headers: {"content-type":"application/json"}, body: JSON.stringify({cwd: os.tmpdir()}) }).then(r => r.json());
console.log(`✓ 会话创建 id=${s.id}`);
const b = new URL(base);
const ws = new WebSocket(b.protocol.replace(/^http/, "ws") + "//" + b.host + b.pathname.replace(/\/$/, "") + `/ws/${s.id}`);
const done = new Promise((ok, no) => {
  const t = setTimeout(() => no(new Error("60s 无回复")), 60000);
  ws.onmessage = (e) => { const m = JSON.parse(e.data);
    if (m.t==="cc" && m.ev?.type==="stream_event" && m.ev.event?.delta?.text) { console.log("✓ claude 回复中:", JSON.stringify(m.ev.event.delta.text.slice(0,60))); clearTimeout(t); ok(); }
    if (m.t==="exit") { no(new Error("claude 退出 code="+m.code)); } };
  ws.onerror = () => no(new Error("WS 连接错误"));
});
await new Promise(r => ws.onopen = r);
ws.send(JSON.stringify({t:"user", text:"回复ok两个字母即可"}));
await done; ws.close();
await fetch(`${base}/api/sessions/${s.id}`, { method: "DELETE" }).catch(() => {}); // 清理：不留 /tmp 活会话污染前端刷新引导
console.log("✓ 端到端全通\n");
