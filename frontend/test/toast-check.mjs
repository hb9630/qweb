// 切换工作目录提示走 toast：出现后自动消失，不再常驻 UI
import { chromium } from "playwright";
let b; try { b = await chromium.launch(); } catch { b = await chromium.launch({ channel: "chrome" }); }
const pg = await b.newPage();
await pg.goto("http://127.0.0.1:18090/");
await pg.waitForTimeout(2500);
await pg.getByRole("button", { name: "切换工作目录" }).click();
await pg.waitForTimeout(400);
await pg.locator('[role="dialog"] button[title^="进入"]').first().waitFor({ timeout: 5000 });
await pg.locator('[role="dialog"] button[title^="进入"]').nth(1).click(); // 进一个子目录避免与当前相同
await pg.waitForTimeout(300);
await pg.getByRole("button", { name: "选这个目录", exact: true }).click();
await pg.waitForTimeout(600);
const t1 = await pg.locator('[data-sonner-toast]').count();
t1 >= 1 || (() => { throw new Error("✗ toast 未出现"); })();
const txt = await pg.locator('[data-sonner-toast]').first().innerText();
console.log(`✓ 切换后 toast 出现（${txt.replace(/\n/g, " / ").slice(0, 60)}…）`);
// 位置：水平居中（toast 中心 vs 视口中心，容差 80px）
const box = await pg.locator('[data-sonner-toast]').first().boundingBox();
const vc = pg.viewportSize().width / 2;
Math.abs(box.x + box.width / 2 - vc) < 80 || (() => { throw new Error(`✗ toast 未水平居中：中心 ${box.x + box.width / 2} vs 视口 ${vc}`); })();
console.log("✓ toast 水平居中（top-center）");
await pg.waitForTimeout(5500); // sonner 默认 4s 自动关
const t2 = await pg.locator('[data-sonner-toast]').count();
t2 === 0 || (() => { throw new Error(`✗ toast ${t2}s 后未消失（常驻了）`); })();
console.log("✓ toast 自动消失（非常驻）");
const list = await fetch("http://127.0.0.1:18090/api/sessions").then(r => r.json());
for (const s of list) await fetch(`http://127.0.0.1:18090/api/sessions/${s.id}`, { method: "DELETE" }).catch(() => {});
await b.close();
console.log("✓ toast 提示全通\n");
