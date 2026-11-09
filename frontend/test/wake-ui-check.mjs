// UI 层验证（playwright）：刷新即有斜杠真清单（唤醒后 init 免首消息）+ 模式切换 toast/胶囊
import { chromium } from "playwright";
const base = process.argv[2] || "http://127.0.0.1:18090";
let b; try { b = await chromium.launch(); } catch { b = await chromium.launch({ channel: "chrome" }); }
const pg = await b.newPage();
await pg.goto(base + "/");
await pg.waitForTimeout(4500); // app boot → 自动 resume 最近会话（唤醒让 init ~1-2s 到）

// 1) 未发任何消息，输入 / → 弹真清单（不是"清单下发中"提示态）
const ta = pg.locator("textarea[name='message']");
await ta.click();
await ta.fill("/");
await pg.waitForTimeout(800);
const popupBtns = await pg.locator("div.absolute.bottom-full.left-0 button").count();
const hint = await pg.getByText("命令清单下发中").count();
console.log(`斜杠弹层条目=${popupBtns}（提示态=${hint}）`);
if (popupBtns < 20) throw new Error("✗ 斜杠清单未随 init 下发（唤醒或联想失效）");
if (hint > 0) throw new Error("✗ 仍显示'清单未下发'提示");

// 2) 模式切换：胶囊菜单选 plan → toast + 胶囊更新
await ta.fill(""); // 关联想弹层
await pg.locator("button[title^='权限模式']").click();
await pg.waitForTimeout(300);
await pg.getByRole("button", { name: /plan/ }).first().click();
await pg.waitForTimeout(2000);
const toastTxt = (await pg.locator("[data-sonner-toast]").allInnerTexts()).join(" | ");
const chip = await pg.locator("button[title^='权限模式']").innerText();
console.log(`toast="${toastTxt}" 胶囊="${chip.trim()}"`);
if (!chip.includes("plan")) throw new Error("✗ 模式胶囊未更新为 plan");
if (!toastTxt.includes("plan")) throw new Error("✗ 模式切换 toast 未出现");

// 收尾：切回 default + 清理本页自动 resume 出来的会话
await pg.locator("button[title^='权限模式']").click();
await pg.waitForTimeout(300);
await pg.getByRole("button", { name: /act/ }).first().click();
await pg.waitForTimeout(1000);
await b.close();
const list = await fetch(`${base}/api/sessions`).then(r => r.json());
for (const s of list) await fetch(`${base}/api/sessions/${s.id}`, { method: "DELETE" }).catch(() => {});
console.log(`✓ UI 双检通过（清理 ${list.length} 个临时会话）`);
