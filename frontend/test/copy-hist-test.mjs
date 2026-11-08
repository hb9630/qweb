import { chromium } from "playwright";
const b = await chromium.launch(); const pg = await b.newPage({ viewport: { width: 1280, height: 900 } });
await pg.goto("http://127.0.0.1:18095/"); await pg.waitForTimeout(2500);
const ta = pg.locator("textarea").first();
// 发两条（第二条进插话队列，也算输入历史）
await ta.fill("历史召回第一条abc"); await ta.press("Enter"); await pg.waitForTimeout(1500);
await ta.fill("历史召回第二条xyz"); await ta.press("Enter"); await pg.waitForTimeout(500);

// 2) ↑ 召回：空输入框光标在首位
await ta.click(); await ta.press("ArrowUp");
let v1 = await ta.inputValue();
console.log(v1 === "历史召回第二条xyz" ? `✓ 第一次 ↑ 召回最新一条（${v1}）` : `✗ 召回异常: ${v1}`);
await pg.waitForTimeout(150);
await ta.press("ArrowUp"); await pg.waitForTimeout(150);
const v2 = await ta.inputValue();
console.log(v2 === "历史召回第一条abc" ? `✓ 连续 ↑ 向前翻（${v2}）` : `✗ 向前翻异常: ${v2}`);
await ta.press("ArrowDown");
const v3 = await ta.inputValue();
console.log(v3 === "历史召回第二条xyz" ? `✓ ↓ 向后翻（${v3}）` : `✗ 向后翻异常: ${v3}`);
await ta.press("ArrowDown");
const v4 = await ta.inputValue();
console.log(v4 === "" ? "✓ ↓ 越界还原草稿（空）" : `✗ 还原异常: ${v4}`);

// 1) 消息复制按钮：hover 用户消息 → 按钮可见 → 点击回显
const msg = pg.locator("div.group\\/msg").filter({ hasText: "历史召回第一条abc" }).first();
await msg.hover(); await pg.waitForTimeout(300);
const btn = msg.locator("button[title='复制全文']");
const opacity = await btn.evaluate((e) => getComputedStyle(e).opacity);
console.log(opacity === "1" ? "✓ hover 消息后复制按钮浮现" : `（按钮 opacity=${opacity}）`);
await btn.click(); await pg.waitForTimeout(400);
console.log((await msg.locator("button:has-text('已复制')").count()) > 0 ? "✓ 点击复制回显已复制" : "✗ 复制回显缺失");
await pg.screenshot({ path: "test/copy-proof.png" });
const list = await (await fetch("http://127.0.0.1:18095/api/sessions")).json();
for (const s of list) await fetch(`http://127.0.0.1:18095/api/sessions/${s.id}`, { method: "DELETE" });
await b.close();
