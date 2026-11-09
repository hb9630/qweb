// 复现：新会话唤醒后，"isn't available" 出现在哪条事件里
const base = "http://127.0.0.1:18090";
const os = await import("node:os");
const s = await fetch(`${base}/api/sessions`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ cwd: os.tmpdir() }) }).then(r => r.json());
console.log("会话", s.id);
const ws = new WebSocket(`ws://127.0.0.1:18090/ws/${s.id}`);
const frames = [];
ws.onmessage = (e) => frames.push(JSON.parse(e.data));
await new Promise(r => ws.onopen = r);
await new Promise(r => setTimeout(r, 6000));
ws.close();
await fetch(`${base}/api/sessions/${s.id}`, { method: "DELETE" }).catch(() => {});
for (const f of frames) {
  const ev = f.ev ?? f;
  const txt = JSON.stringify(ev);
  if (/isn't available|local-command|\/model/.test(txt))
    console.log(`帧 t=${f.t} type=${ev.type}/${ev.subtype ?? ev.event?.type ?? ""}:\n${txt.slice(0, 400)}\n---`);
}
console.log("总帧数", frames.length);
