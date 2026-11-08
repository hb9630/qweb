import { chromium } from "playwright";
const b = await chromium.launch(); const pg = await b.newPage();
// 模拟后端未就绪：/api/sessions 拦截延迟 3s → 恢复期应显示"正在恢复会话"而非"（空会话）"
await pg.route("**/api/sessions**", async (r) => {
  await new Promise(res => setTimeout(res, 3000));
  await r.continue();
});
await pg.goto("http://127.0.0.1:18095/");
await pg.waitForTimeout(1500);
const during = await pg.locator("body").innerText();
console.log(during.includes("正在恢复会话") && !during.includes("（空会话）")
  ? "✓ 恢复期显示'正在恢复会话'（无'空会话'迷惑态）" : `✗ 恢复期异常: ${during.slice(0, 80).replace(/\n/g, "|")}`);
await pg.waitForTimeout(6000); // 等 sessions 到达 + attach
const after = await pg.locator("body").innerText();
console.log(after.includes("（空会话）") && !after.includes("正在恢复会话")
  ? "✓ 恢复完成后正常落位（真实空会话）" : `（完成态: ${after.includes("正在恢复") ? "仍在恢复" : "已就位"}）`);
const list = await (await fetch("http://127.0.0.1:18095/api/sessions")).json();
for (const s of list) await fetch(`http://127.0.0.1:18095/api/sessions/${s.id}`, { method: "DELETE" });
await b.close(); process.exit(0);
