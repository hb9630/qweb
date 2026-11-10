// 二次打开场景（有 lastRoot 记忆）：树应与消息同刻甚至更早出现
import { chromium } from "playwright";
let b; try { b = await chromium.launch(); } catch { b = await chromium.launch({ channel: "chrome" }); }
const pg = await b.newPage();
// 模拟二次打开：预置 lastRoot（首开脚本跑过一次会写入，这里显式确认）
await pg.addInitScript(() => localStorage.setItem("qweb.lastRoot", "C:/Users/cnhua/ccweb"));
const t0 = Date.now();
await pg.goto("http://127.0.0.1:18090/");
await pg.locator("[class*='lucide-folder'], [class*='lucide-file']").first().waitFor({ timeout: 15000 });
console.log(`二次开树首行: ${Date.now() - t0}ms`);
await pg.locator(".group\/msg").first().waitFor({ timeout: 30000 }).catch(() => {});
console.log(`首条消息: ${Date.now() - t0}ms`);
await b.close();
