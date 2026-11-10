const list = await fetch("http://127.0.0.1:9223/json").then(r => r.json());
const page = list.find(t => t.type === "page");
const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise(r => ws.onopen = r);
const call = (id, expr) => new Promise(res => {
  const h = (e) => { const m = JSON.parse(e.data); if (m.id === id) { ws.removeEventListener("message", h); res(m.result?.result?.value); } };
  ws.addEventListener("message", h);
  ws.send(JSON.stringify({ id, method: "Runtime.evaluate", params: { expression: expr, returnByValue: true } }));
});
const nav = await call(1, `JSON.stringify(performance.getEntriesByType("navigation").map(n=>({dns:Math.round(n.domainLookupEnd-n.domainLookupStart),conn:Math.round(n.connectEnd-n.connectStart),ttfb:Math.round(n.responseStart-n.requestStart),resp:Math.round(n.responseEnd-n.responseStart),dom:Math.round(n.domContentLoadedEventEnd),total:Math.round(n.loadEventEnd)})))`);
const res10 = await call(2, `JSON.stringify(performance.getEntriesByType("resource").sort((a,b)=>b.duration-a.duration).slice(0,12).map(r=>({dur:Math.round(r.duration),start:Math.round(r.startTime),name:(r.name.split("?")[0].split("/").slice(-1)[0]||r.name).slice(0,40)})))`);
console.log("navigation:", nav);
console.log("最慢资源:", res10);
ws.close();
