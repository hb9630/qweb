import { chromium } from "playwright";
const b = await chromium.launch(); const pg = await b.newPage();
await pg.goto("http://127.0.0.1:18095/"); await pg.waitForTimeout(2500);
const ta = pg.locator("textarea").first();
await ta.fill("标题拷贝按钮测试"); await ta.press("Enter"); await pg.waitForTimeout(2500);
// 按钮应紧跟标题右侧（水平间距 < 24px），且点击回显 Check
const btn = pg.locator("button[title^='复制终端续跑命令']").first();
const bb = await btn.boundingBox();
const ts = await pg.locator("h1,span").filter({ hasText: "标题拷贝按钮测试" }).first().boundingBox();
console.log(bb && ts && bb.x - (ts.x + ts.width) < 24 && Math.abs(bb.y - ts.y) < 12
  ? `✓ 按钮紧跟标题右侧（间距 ${Math.round(bb.x - ts.x - ts.width)}px）`
  : `✗ 位置异常（btn.x=${Math.round(bb?.x ?? -1)} title右缘=${Math.round((ts?.x ?? 0) + (ts?.width ?? 0))}）`);
await btn.click(); await pg.waitForTimeout(300);
const cls = await btn.innerHTML();
console.log(cls.includes("lucide-check") || cls.includes("M20 6") ? "✓ 点击回显已复制（Check）" : `（图标态: ${cls.slice(0, 60)}）`);
await pg.screenshot({ path: "test/title-copy-proof.png" });
const list = await (await fetch("http://127.0.0.1:18095/api/sessions")).json();
for (const s of list) await fetch(`http://127.0.0.1:18095/api/sessions/${s.id}`, { method: "DELETE" });
await b.close(); process.exit(0);
