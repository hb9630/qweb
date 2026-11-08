import { chromium } from "playwright";
const b = await chromium.launch(); const pg = await b.newPage();
await pg.goto("http://127.0.0.1:18090/"); await pg.waitForTimeout(2000);
const ta = pg.locator("textarea").first();
await ta.fill("回复ok两个字母即可");
await ta.press("Enter");
// init 随首条消息到达（无历史 claudeSid 的全新会话 → initSid 本地补记 → 按钮出现）
await pg.waitForSelector("button:has-text('TUI')", { timeout: 30000 });
const btn = pg.locator("button:has-text('TUI')").first();
const title = await btn.getAttribute("title");
console.log("✓ TUI 按钮出现（首条消息后 init 到达）");
console.log(/claude --resume [0-9a-f-]{36}/.test(title ?? "") ? "✓ 命令含官方 sid" : "✗ title 异常", "|", title?.slice(-70));
await btn.click(); await pg.waitForTimeout(400);
console.log((await pg.locator("button:has-text('已复制')").count()) ? "✓ 复制回显" : "✗ 复制回显缺失");
// 清理本会话
const list = await (await fetch("http://127.0.0.1:18090/api/sessions")).json();
for (const s of list) if (s.cwd === "/tmp" || s.cwd?.includes("ccweb")) { if (s.cwd === "/tmp") await fetch(`http://127.0.0.1:18090/api/sessions/${s.id}`, { method: "DELETE" }).catch(()=>{}); }
await b.close();
