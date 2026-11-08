import { chromium } from "playwright";
const b = await chromium.launch(); const pg = await b.newPage({ viewport: { width: 1280, height: 900 } });
await pg.goto("http://127.0.0.1:18095/"); await pg.waitForTimeout(3000);
const el = await pg.locator(".relative.overflow-y-hidden > div").first().elementHandle();
const ta = pg.locator("textarea").first();
await ta.fill("用 bash 运行 ls -1 | head -40，然后用 Read 读 README.md，总结两句"); await ta.press("Enter");
let last = "";
for (let i = 0; i < 90; i++) {
  const s = await el.evaluate((e) => ({ d: Math.round(e.scrollHeight - e.scrollTop - e.clientHeight), tools: document.querySelectorAll(".not-prose").length }));
  const tag = `距底${s.d} 工具${s.tools}`;
  if (tag !== last) { console.log(`${(i * 0.5).toFixed(1)}s: ${tag}`); last = tag; }
  await pg.waitForTimeout(500);
}
const list = await (await fetch("http://127.0.0.1:18095/api/sessions")).json();
for (const s of list) await fetch(`http://127.0.0.1:18095/api/sessions/${s.id}`, { method: "DELETE" });
await b.close(); process.exit(0);
