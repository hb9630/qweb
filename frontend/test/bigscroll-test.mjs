import { chromium } from "playwright";
const b = await chromium.launch(); const pg = await b.newPage({ viewport: { width: 1280, height: 900 } });
await pg.goto("http://127.0.0.1:18095/"); await pg.waitForTimeout(4000);
const el = await pg.locator(".relative.overflow-y-hidden > div").first().elementHandle();
const snap = async (tag) => {
  const s = await el.evaluate((e) => ({ top: Math.round(e.scrollTop), h: Math.round(e.scrollHeight), vh: e.clientHeight }));
  const ind = await pg.locator("text=/上面还有/").first().textContent().catch(() => "无提示");
  const kids = await el.evaluate(() => document.querySelector(".mx-auto.max-w-5xl").children.length);
  console.log(tag, "| top", s.top, "总高", s.h, "视口", s.vh, "| 子元素", kids, "|", ind);
};
await snap("初始  ");
await pg.mouse.move(1000, 450);
for (let i = 1; i <= 6; i++) { await pg.mouse.wheel(0, -2500); await pg.waitForTimeout(500); await snap("上翻" + i + " "); }
const list = await (await fetch("http://127.0.0.1:18095/api/sessions")).json();
for (const s of list) await fetch(`http://127.0.0.1:18095/api/sessions/${s.id}`, { method: "DELETE" });
await b.close(); process.exit(0);
