// 真实场景模拟：带多层展开记忆首开——渐进渲染下根层应先出、深层逐层补
import { chromium } from "playwright";
let b; try { b = await chromium.launch(); } catch { b = await chromium.launch({ channel: "chrome" }); }
const pg = await b.newPage();
await pg.addInitScript(() => {
  localStorage.setItem("qweb.expanded", JSON.stringify([
    "C:/Users/cnhua/ccweb", "C:/Users/cnhua/ccweb/backend", "C:/Users/cnhua/ccweb/frontend",
    "C:/Users/cnhua/ccweb/frontend/src", "C:/Users/cnhua/ccweb/backend/qweb-core",
    "C:/Users/cnhua/ccweb/backend/target",
  ]));
});
const t0 = Date.now();
await pg.goto("http://127.0.0.1:57891/");
await pg.locator("[class*='lucide-folder'], [class*='lucide-file']").first().waitFor({ timeout: 15000 });
const rootAt = Date.now() - t0;
await pg.locator("text=target").first().waitFor({ timeout: 30000 }).catch(() => {});
const deepAt = Date.now() - t0;
console.log(`根层首现: ${rootAt}ms；深层(target)恢复完: ${deepAt}ms`);
await b.close();
