import { chromium } from "playwright";
const b = await chromium.launch(); const pg = await b.newPage({ viewport: { width: 1280, height: 900 } });
await pg.goto("http://127.0.0.1:18095/"); await pg.waitForTimeout(2500);
const ta = pg.locator("textarea").first();
const h = () => ta.evaluate(e => Math.round(e.getBoundingClientRect().height));

// 2) 自动增高：30 行内容（默认上限 192px=12rem，应涨破并接近 50vh=450px）
const h0 = await h();
await ta.fill(Array.from({ length: 30 }, (_, i) => `第${i + 1}行长文本内容`).join("\n"));
await pg.waitForTimeout(400);
const h1 = await h();
console.log(h1 > 192 ? `✓ 超行自动增高（${h0}px → ${h1}px，破 192px 上限）` : `✗ 未破上限（${h1}px）`);

// 1) 拖分割条：向上拖 150px → 输入框增高 ~150
const handle = pg.locator("div[title^='拖动调整输入框高度']").first();
const hb = await handle.boundingBox();
await pg.mouse.move(hb.x + hb.width / 2, hb.y + hb.height / 2);
await pg.mouse.down();
await pg.mouse.move(hb.x + hb.width / 2, hb.y - 150, { steps: 5 });
await pg.mouse.up(); await pg.waitForTimeout(300);
const h2 = await h();
console.log(Math.abs(h2 - h1 - 150) < 30 ? `✓ 拖拽调高（${h1}px → ${h2}px）` : `✗ 拖拽异常（${h1} → ${h2}）`);

// 双击恢复自动
await handle.dblclick(); await pg.waitForTimeout(300);
const h3 = await h();
console.log(Math.abs(h3 - h1) < 20 ? `✓ 双击恢复自动（${h2}px → ${h3}px）` : `✗ 恢复异常（${h3}px）`);
const list = await (await fetch("http://127.0.0.1:18095/api/sessions")).json();
for (const s of list) await fetch(`http://127.0.0.1:18095/api/sessions/${s.id}`, { method: "DELETE" });
await b.close(); process.exit(0);
