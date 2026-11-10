// 零记忆首开计时：树区首个目录行出现的总耗时（history 复用优化验证）
import { chromium } from "playwright";
let b; try { b = await chromium.launch(); } catch { b = await chromium.launch({ channel: "chrome" }); }
const pg = await b.newPage();
const t0 = Date.now();
await pg.goto("http://127.0.0.1:18090/");
// 树渲染出首个目录行（文件夹/文件图标行）——用 locator（非 evaluate 沙箱）
await pg.locator("[class*='lucide-folder'], [class*='lucide-file']").first().waitFor({ timeout: 30000 });
console.log(`树渲染完成: ${Date.now() - t0}ms（含网络+定位+扎根+列表）`);
await b.close();
