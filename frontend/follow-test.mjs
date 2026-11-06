// 打开 mv-follow.txt → 树内拖到 dst/ → 编辑器 tab 路径应跟随(不标已删除)
import { chromium } from "playwright";
const b = await chromium.launch();
const page = await b.newPage();
await page.setViewportSize({ width: 1700, height: 1000 });
await page.goto("http://127.0.0.1:18090/", { waitUntil: "networkidle" });
await page.waitForTimeout(1500);
for (const d of ["/home", "/home/huangbin", "/home/huangbin/ktest"]) {
  await page.locator(`button[data-path="${d}"]`).click();
  await page.waitForTimeout(600);
}
// 打开文件(单击预览)
const f = page.locator('button[data-path="/home/huangbin/ktest/mv-follow.txt"]');
await f.scrollIntoViewIfNeeded();
await f.click();
await page.waitForTimeout(1200);
const tabBefore = await page.locator("text=mv-follow.txt").first().isVisible().catch(() => false);
console.log("编辑器打开 tab:", tabBefore ? "OK" : "FAIL");

// 拖到 dst 目录(HTML5 drag:按住移动到目标行上松手)
const fb = await f.boundingBox();
const dst = page.locator('button[data-path="/home/huangbin/ktest/dst"]');
await dst.scrollIntoViewIfNeeded();
const dbb = await dst.boundingBox();
await page.mouse.move(fb.x + fb.width / 2, fb.y + 2);
await page.mouse.down();
await page.mouse.move(dbb.x + dbb.width / 2, dbb.y + dbb.height / 2, { steps: 12 });
await page.waitForTimeout(400);
await page.mouse.up();
await page.waitForTimeout(1500);

// 断言:tab 还活着(路径跟随),不是"已删除"横幅
const deletedBanner = await page.getByText(/已删除|deleted/i).count();
const tabAlive = await page.locator(".truncate, [class*=tab]").filter({ hasText: "mv-follow.txt" }).count();
const exists = await page.evaluate(() => fetch("/api/fs/file?path=/home/huangbin/ktest/dst/mv-follow.txt").then(r => r.status));
console.log("文件实际已移动:", exists === 200 ? "OK" : `FAIL(${exists})`);
console.log("tab 跟随未标删除:", deletedBanner === 0 && tabAlive > 0 ? "PASS" : `FAIL(banner=${deletedBanner}, tab=${tabAlive})`);
await page.screenshot({ path: "follow-proof.png" });
await b.close();
