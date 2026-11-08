import { chromium } from "playwright";
const b = await chromium.launch(); const pg = await b.newPage({ viewport: { width: 1280, height: 900 } });
await pg.goto("http://127.0.0.1:18095/"); await pg.waitForTimeout(2500);
const ta = pg.locator("textarea").first();

// 1) 多行输入：Shift+Enter 换行发送后，用户气泡保留换行（渲染含 \n 高度 > 单行）
await ta.fill("第一行内容"); await ta.press("Shift+Enter");
await ta.type("第二行内容"); await ta.press("Enter"); await pg.waitForTimeout(1500);
const bubble = pg.locator("div.group\\/msg").filter({ hasText: "第一行内容" }).first();
const md = await bubble.evaluate((e) => {
  const el = [...e.querySelectorAll("div")].find(d => d.textContent.includes("第二行内容"));
  return { pre: getComputedStyle(el).whiteSpace, h: el.getBoundingClientRect().height };
});
console.log(md.pre === "pre-wrap" ? `✓ 多行保留（white-space:${md.pre}，高 ${Math.round(md.h)}px）` : `✗ 换行丢失（white-space:${md.pre}）`);

// 2) 排队条位置 + 撤回回填：busy 中发两条插话
await ta.fill("排队甲乙丙"); await ta.press("Enter"); await pg.waitForTimeout(300);
await ta.fill("排队丁戊己"); await ta.press("Enter"); await pg.waitForTimeout(600);
const card = pg.locator(".border-dashed").first();
const cy = (await card.boundingBox()).y;
const ty = (await (await pg.locator("button[title^='历史会话']").first().boundingBox())).y;
console.log(cy < ty ? `✓ 排队条在工具条上方 (y=${Math.round(cy)} < ${Math.round(ty)})` : `✗ 排队条位置异常 (y=${Math.round(cy)} >= ${Math.round(ty)})`);
// 撤回两条 → 按顺序回输入框
await pg.locator(".border-dashed button[title^='撤回']").first().click(); await pg.waitForTimeout(200);
await pg.locator(".border-dashed button[title^='撤回']").first().click(); await pg.waitForTimeout(400);
const v = await ta.inputValue();
console.log(v === "排队甲乙丙\n排队丁戊己" ? "✓ 撤回按排队顺序回填输入框" : `✗ 回填异常: ${JSON.stringify(v)}`);
console.log((await pg.locator(".border-dashed").count()) === 0 ? "✓ 队列清空" : "✗ 队列残留");
const list = await (await fetch("http://127.0.0.1:18095/api/sessions")).json();
for (const s of list) await fetch(`http://127.0.0.1:18095/api/sessions/${s.id}`, { method: "DELETE" });
await b.close(); process.exit(0);
