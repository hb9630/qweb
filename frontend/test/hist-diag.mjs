// 诊断"无法加载会话历史"：零记忆首开（等价更名后所有用户），观察 boot、root 设定与历史浮层内容
import { chromium } from "playwright";
const base = "http://127.0.0.1:18090/";
let b; try { b = await chromium.launch(); } catch { b = await chromium.launch({ channel: "chrome" }); }
const pg = await b.newPage();
const errs = [], reqFails = [];
pg.on("console", m => { if (m.type() === "error") errs.push(m.text()); });
pg.on("requestfailed", r => reqFails.push(`${r.method()} ${r.url()} :: ${r.failure()?.errorText}`));
pg.on("response", r => { if (r.status() >= 400) reqFails.push(`${r.status()} ${r.url()}`); });

await pg.addInitScript(() => localStorage.clear()); // 模拟 qweb.* 键全新（更名重置）
await pg.goto(base);
await pg.waitForLoadState("networkidle");
await pg.waitForTimeout(4500); // boot：env → root 回落 → 活会话重连/自动 resume 全链路

const chip = await pg.locator('button[title^="工作目录："]').first().innerText();
const histBtn = pg.locator('button[title^="历史会话（工作目录"]').first();
const btnTitle = await histBtn.getAttribute("title");
console.log("cwd chip:", JSON.stringify(chip.trim()));
console.log("hist btn title:", JSON.stringify(btnTitle));

// 对话区状态（boot 是否成功恢复出内容）
const blocks = await pg.locator('[data-block], .group\\/message').count().catch(() => -1);
console.log("message blocks (rough):", blocks);

await histBtn.click();
await pg.waitForTimeout(800);
const layer = pg.locator("div.absolute.z-30").first();
console.log("history layer visible:", await layer.isVisible().catch(() => false));
console.log("layer header:", JSON.stringify((await layer.locator("div.mb-1").innerText().catch(() => "(未找到)")).trim()));
const items = await layer.locator("button:not([title='刷新'])").count().catch(() => -1);
console.log("layer entries:", items);
if (await layer.getByText("此目录暂无历史").count()) console.log("layer says: 此目录暂无历史");
await pg.screenshot({ path: "hist-diag.png", fullPage: false });

console.log("console errors:", errs.length ? errs : "(无)");
console.log("request failures:", reqFails.length ? reqFails : "(无)");
await b.close();
