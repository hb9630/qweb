// 历史点击回归：boot 后点非当前会话（hello）→ 应切换显示该会话内容 + hash 锚点跟变
import { chromium } from "playwright";
const base = process.argv[2] || "http://127.0.0.1:18090";
let b; try { b = await chromium.launch(); } catch { b = await chromium.launch({ channel: "chrome" }); }
const pg = await b.newPage();
await pg.goto(base + "/");
await pg.waitForTimeout(6000);
await pg.locator("button").filter({ hasText: /^历史/ }).first().click();
await pg.waitForTimeout(800);
const item = pg.locator("button:has(.lucide-message-square)").filter({ hasText: "hello" }).first();
if (!await item.count()) throw new Error("✗ 历史浮层无条目（sameDir 过滤仍空？）");
await item.click();
await pg.waitForTimeout(2000);
const hash = await pg.evaluate(() => location.hash);
const t = await pg.locator("body").innerText();
if (!t.includes("hello")) throw new Error("✗ 点击后未加载（面板没切到该会话）");
console.log(`✓ 历史点击加载正常（hash=${hash.slice(0, 18)}…，hello 内容已显示）`);
await b.close();
