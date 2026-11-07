// resume 幂等/续聊验证（原生 WebSocket，零依赖）：node resume-test.mjs <base> <sid> <cwd>
const [base, sid, cwd] = [process.argv[2]?.replace(/\/+$/, ""), process.argv[3], process.argv[4]];
const r = await fetch(`${base}/api/sessions`, { method: "POST", headers: {"content-type":"application/json"}, body: JSON.stringify({cwd, resume: sid}) });
const s = await r.json();
console.log(`POST → HTTP ${r.status}`, JSON.stringify(s));
if (!r.ok) process.exit(1);
const b = new URL(base);
const ws = new WebSocket(b.protocol.replace(/^http/, "ws") + "//" + b.host + b.pathname.replace(/\/$/, "") + `/ws/${s.id}`);
const t = setTimeout(() => { console.log("✗ 60s 无回复"); process.exit(1); }, 60000);
ws.onopen = () => { console.log("✓ WS open"); setTimeout(() => ws.send(JSON.stringify({t:"user", text:"回复ok两个字母即可"})), 300); };
ws.onmessage = (e) => { const m = JSON.parse(e.data);
  if (m.t==="cc" && m.ev?.type==="stream_event" && m.ev.event?.delta?.text) { console.log("✓ claude 回复:", JSON.stringify(m.ev.event.delta.text.slice(0,40))); clearTimeout(t); setTimeout(()=>process.exit(0), 300); }
  if (m.t==="exit") { console.log("✗ 进程退出 code=" + m.code); process.exit(1); } };
ws.onerror = () => { console.log("✗ WS 连接错误"); process.exit(1); };
