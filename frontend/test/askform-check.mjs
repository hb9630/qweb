// AskUserQuestion 表单端到端：页面发消息让模型提问 → 表单卡出现（自动抢焦点）→
// 点选提交（单选）→ 多选勾两项提交 → "其他"自由输入提交；每轮验证卡片塌缩 + 模型收到所选。
import { chromium } from "playwright";
const base = process.argv[2] || "http://127.0.0.1:18090";
let b; try { b = await chromium.launch(); } catch { b = await chromium.launch({ channel: "chrome" }); }
const pg = await b.newPage();
await pg.goto(base + "/");
await pg.waitForTimeout(4000);
// 强制新会话：否则 boot 会自动 resume 上次测试的 transcript，上下文串场（模型行为发散）
await pg.getByRole("button", { name: "新会话" }).click();
await pg.waitForTimeout(1500);

const ta = pg.locator("textarea[name='message']");
const card = pg.locator("[data-form='pending']");
const lastAssistant = () => pg.locator("[data-message-author='assistant']").last();
// 等模型下一句（含关键词）：assistant 气泡 = .group/msg 且不含用户气泡的 border-primary/30
// （提问文本本身含选项词，必须排除用户侧；类名里的 / 在 CSS 选择器要转义）
const waitSay = async (kw, ms = 60000) => {
  await pg.waitForFunction(
    (k) => [...document.querySelectorAll(".group\\/msg:not(:has(.border-primary\\/30))")]
      .some((el) => el.textContent?.includes(k)),
    kw, { timeout: ms });
};
// 等一轮真正结束（流式文本匹配到时 result 可能未到，busy 中发消息会进插话队列）
const waitIdle = async (ms = 90000) =>
  pg.getByRole("button", { name: "打断" }).waitFor({ state: "detached", timeout: ms });

// ---- 第 1 轮：单选 ----
await ta.fill("用 AskUserQuestion 工具问我一个单选题：题目'今晚吃啥'，header'晚餐'，三个选项标签：火锅、烧烤、面条（各带一句描述）。问完停下等我的回答。");
await ta.press("Enter");
await card.waitFor({ timeout: 45000 });
console.log("✓ 单选表单卡出现");
// 自动抢焦点：activeElement 应在卡片内的选项按钮上
const focused = await pg.evaluate(() => {
  const el = document.activeElement;
  return { inCard: !!el?.closest("[data-form='pending']"), isBtn: el?.tagName === "BUTTON" };
});
if (!focused.inCard || !focused.isBtn) throw new Error(`✗ 未自动抢焦点: ${JSON.stringify(focused)}`);
console.log("✓ 焦点自动落在首选项（↑↓ 可导航）");
// 键盘 ↓↓ 再空格勾选 = 第三个（面条）
await pg.keyboard.press("ArrowDown"); await pg.keyboard.press("ArrowDown");
await pg.keyboard.press(" "); // 原生 click → 勾选
await pg.keyboard.press("Enter"); // 单选 Enter=选中即提交
await pg.waitForTimeout(500);
const collapsed = await pg.getByText(/^已回答/).last().innerText().catch(() => "");
if (!collapsed.includes("面条")) throw new Error(`✗ 塌缩摘要异常: "${collapsed}"`);
console.log(`✓ 键盘流提交成功，卡片塌缩：${collapsed}`);
await waitSay("面条"); await waitIdle();
console.log("✓ 模型收到了选择（回复提及“面条”）");

// ---- 第 2 轮：多选 ----
await ta.fill("再用 AskUserQuestion 问一个多选题：题目'周末干啥'，header'计划'，multiSelect=true，三个选项标签：爬山、看电影、宅家。问完停下等回答。");
await ta.press("Enter");
await card.waitFor({ timeout: 45000 });
await pg.locator("[data-form='pending'] button", { hasText: "爬山" }).click();
await pg.locator("[data-form='pending'] button", { hasText: "宅家" }).click();
await pg.getByRole("button", { name: "提交回答" }).click();
await pg.waitForTimeout(500);
const c2 = await pg.getByText(/^已回答/).last().innerText().catch(() => "");
if (!c2.includes("爬山") || !c2.includes("宅家") || c2.includes("看电影")) throw new Error(`✗ 多选摘要异常: "${c2}"`);
console.log(`✓ 多选提交成功：${c2}`);
await waitSay("爬山"); await waitIdle();
console.log("✓ 模型收到多选（回复提及“爬山”）");

// ---- 第 3 轮：其他（自由输入）----
await ta.fill("再问一个单选题：题目'猫还是狗'，header'宠物'，选项标签：猫、狗。我会用自定义答案回答。");
await ta.press("Enter");
await card.waitFor({ timeout: 45000 });
await pg.locator("[data-form='pending'] input").last().fill("我都要，仓鼠也行");
await pg.keyboard.press("Enter");
await pg.waitForTimeout(500);
const c3 = await pg.getByText(/^已回答/).last().innerText().catch(() => "");
if (!c3.includes("仓鼠")) throw new Error(`✗ 自定义输入摘要异常: "${c3}"`);
console.log(`✓ “其他”自由输入提交：${c3}`);
await waitSay("仓鼠");
console.log("✓ 模型收到自定义答案（回复提及“仓鼠”）");

await b.close();
for (const s of await fetch(`${base}/api/sessions`).then(r => r.json()))
  await fetch(`${base}/api/sessions/${s.id}`, { method: "DELETE" }).catch(() => {});
console.log("\n✓ AskUserQuestion 表单三形态全通过\n");
