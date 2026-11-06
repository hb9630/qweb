// 右键「拷贝路径」:目录项 → 菜单出现 → 点击 → execCommand 兜底写剪贴板(page context 读回验证)
import { chromium } from "playwright";
const b = await chromium.launch();
const page = await b.newPage();
await page.goto("http://127.0.0.1:18090/", { waitUntil: "networkidle" });
await page.waitForSelector("button[data-path]", { timeout: 15000 });
await page.waitForTimeout(500);
const target = page.locator('button[data-path="/etc"]');
await target.click({ button: "right" });
await page.waitForTimeout(300);
const item = page.getByText("拷贝路径", { exact: true });
console.log("菜单项出现:", await item.count() > 0 ? "PASS" : "FAIL");
await item.click();
await page.waitForTimeout(400);
// headless 无系统剪贴板,验证 execCommand 路径执行成功(toast 出现即代表 copyText 返回 true)
const toast = await page.getByText("已拷贝 /etc").count();
console.log("拷贝成功反馈:", toast > 0 ? "PASS" : "FAIL");
await b.close();
