// 启动链路分解：各 API 完成时刻 vs 首条消息出现 vs 树首行出现（相对 goto）
import { chromium } from "playwright";
let b; try { b = await chromium.launch(); } catch { b = await chromium.launch({ channel: "chrome" }); }
const pg = await b.newPage();
const t0 = Date.now();
const marks = {};
pg.on("response", (r) => {
  const u = r.url();
  if (!u.includes("/api/")) return;
  const key = u.split("/api")[1].split("?")[0];
  if (!marks[key]) marks[key] = Date.now() - t0; // 首次完成时刻
});
pg.on("console", (m) => { if (m.text().startsWith("[boot]")) marks[m.text().slice(6)] = Date.now() - t0; });
await pg.goto("http://127.0.0.1:18090/");
// 消息区首个内容（用户气泡或助手文本）
await pg.locator(".group\/msg").first().waitFor({ timeout: 30000 }).catch(() => {});
marks["首条消息可见"] = Date.now() - t0;
await pg.locator("[class*='lucide-folder'], [class*='lucide-file']").first().waitFor({ timeout: 30000 }).catch(() => {});
marks["树首行可见"] = Date.now() - t0;
console.log(JSON.stringify(marks, null, 1));
await b.close();
