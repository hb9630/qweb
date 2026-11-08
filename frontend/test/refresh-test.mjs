// 手工刷新保留展开:展开 /home → 点刷新 → /home 仍展开(子行可见)
import { chromium } from "playwright";
const b = await chromium.launch();
const page = await b.newPage();
await page.goto("http://127.0.0.1:18090/", { waitUntil: "networkidle" });
await page.waitForSelector("button[data-path]", { timeout: 15000 });
await page.waitForTimeout(800);

// 展开 /home(点行)
const home = page.locator('button[data-path="/home"]');
await home.click();
await page.waitForTimeout(800);
const childBefore = await page.locator('button[data-path^="/home/"]').count();
console.log("展开 /home 子行:", childBefore, childBefore > 0 ? "OK" : "FAIL(未展开)");

// 点树头刷新按钮
await page.getByTitle("刷新").click();
await page.waitForTimeout(1200);
const childAfter = await page.locator('button[data-path^="/home/"]').count();
console.log("刷新后 /home 子行:", childAfter, childAfter > 0 ? "PASS" : "FAIL(展开丢失)");
await b.close();
