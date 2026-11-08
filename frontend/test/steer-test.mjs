// 插话队列位置验证：应出现在工具条上方；出现时消息区整体上抬
import { chromium } from "playwright";
const b = await chromium.launch(); const pg = await b.newPage({ viewport: { width: 1280, height: 900 } });
await pg.goto("http://127.0.0.1:18095/"); await pg.waitForTimeout(2500);
const ta = pg.locator("textarea").first();
await ta.fill("讲三句话，随便什么"); await ta.press("Enter");
await pg.waitForTimeout(2500); // busy 中
const listBefore = await pg.locator(".relative.overflow-y-hidden").first().boundingBox();
await ta.fill("这是插话第一条"); await ta.press("Enter"); // busy → 进排队
await pg.waitForTimeout(600);
const card = pg.locator(".border-dashed").first();
if (!(await card.count())) { console.log("✗ 队列卡片未出现"); process.exit(1); }
const cy = (await card.boundingBox()).y;
const toolbar = pg.locator("button:has-text('历史')").first();
const ty = (await toolbar.boundingBox()).y;
const listAfter = await pg.locator(".relative.overflow-y-hidden").first().boundingBox();
console.log(cy < ty ? `✓ 队列在工具条上方 (y=${Math.round(cy)} < ${Math.round(ty)})` : `✗ 队列在工具条下方 (y=${Math.round(cy)} >= ${Math.round(ty)})`);
console.log(listAfter.height < listBefore.height
  ? `✓ 消息区整体上抬 (${Math.round(listBefore.height)} → ${Math.round(listAfter.height)})`
  : `✗ 消息区没缩 (${listBefore.height} → ${listAfter.height})`);
await pg.screenshot({ path: "test/steer-proof.png", fullPage: false });
// 等自动送出 + 回复结束，队列应消失
await pg.waitForTimeout(30000);
console.log((await pg.locator(".border-dashed").count()) === 0 ? "✓ 轮末自动送出后队列消失" : "（超时未消失，可能回复仍进行）");
await b.close();
