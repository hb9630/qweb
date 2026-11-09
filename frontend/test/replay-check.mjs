// 回放验证：刷新页面自动 resume 上轮测试会话 → done 卡来自 tool_result 文本解析兜底
import { chromium } from "playwright";
let b; try { b = await chromium.launch(); } catch { b = await chromium.launch({ channel: "chrome" }); }
const pg = await b.newPage();
await pg.goto("http://127.0.0.1:18090/");
await pg.waitForTimeout(5000); // boot → resume 最近 titled transcript
const t = await pg.locator("body").innerText();
const need = ["已回答", "火锅", "烧烤", "面条", "看电影", "宅家", "猫", "狗", "仓鼠", "爬山"];
const miss = need.filter((k) => !t.includes(k));
if (miss.length) throw new Error(`✗ 回放缺失: ${miss.join(", ")}`);
// 选中项高亮 vs 未选灰化：面条行高亮（border-sky），火锅行灰化（opacity-45）
const hi = await pg.evaluate(() => [...document.querySelectorAll("div[class*='border-sky-500/70']")].filter(el => el.textContent?.includes("面条")).length);
const dim = await pg.evaluate(() => [...document.querySelectorAll("div[class*='opacity-45']")].filter(el => el.textContent?.includes("火锅")).length);
if (hi < 1) throw new Error("✗ 选中项未高亮");
if (dim < 1) throw new Error("✗ 未选项未灰化");
const cus = await pg.evaluate(() => [...document.querySelectorAll("div[class*='border-sky-500/70']")].filter(el => el.textContent?.includes("仓鼠")).length);
if (cus < 1) throw new Error("✗ 自定义文本行未展示");
await b.close();
for (const s of await fetch("http://127.0.0.1:18090/api/sessions").then(r => r.json()))
  await fetch(`http://127.0.0.1:18090/api/sessions/${s.id}`, { method: "DELETE" }).catch(() => {});
console.log("✓ 回放路径：三张 done 卡选项齐全、选中高亮、未选灰化、自定义文本在");
