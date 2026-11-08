import { chromium } from "playwright";
const b = await chromium.launch(); const pg = await b.newPage({ viewport: { width: 1280, height: 900 } });
await pg.goto("http://127.0.0.1:18095/"); await pg.waitForTimeout(2500);
const el = await pg.locator(".relative.overflow-y-hidden > div").first().elementHandle();
const ta = pg.locator("textarea").first();
let last = "";
const poll = async (phase) => {
  const s = await el.evaluate((e) => ({ d: Math.round(e.scrollHeight - e.scrollTop - e.clientHeight), tools: document.querySelectorAll("[data-slot='tool'], [class*='tool']").length }));
  const tag = `距底${s.d}px 工具块${s.tools}`;
  if (tag !== last) { console.log(`${phase}: ${tag}`); last = tag; }
};
// 触发工具调用，全程不碰滚动，轮询贴底距离
await ta.fill("用bash运行 ls /tmp ，然后告诉我有几行"); await ta.press("Enter");
for (let i = 0; i < 60; i++) { await poll(`t${(i * 0.5).toFixed(1)}s`); await pg.waitForTimeout(500); }
const final = await el.evaluate((e) => Math.round(e.scrollHeight - e.scrollTop - e.clientHeight));
console.log(final < 60 ? "✓ 全程贴底" : `✗ 结束时距底 ${final}px（跟随断了）`);
const list = await (await fetch("http://127.0.0.1:18095/api/sessions")).json();
for (const s of list) await fetch(`http://127.0.0.1:18095/api/sessions/${s.id}`, { method: "DELETE" });
await b.close(); process.exit(0);
