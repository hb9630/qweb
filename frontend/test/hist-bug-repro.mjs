// 复现"无法加载会话历史"：DirPicker 选目录（正斜杠入 qweb.root）→ 刷新 → 历史浮层按目录过滤为空
// 根因：transcript cwd 反斜杠（C:\Users\cnhua\ccweb）vs 前端 root 正斜杠（C:/Users/cnhua/ccweb），严格相等永不成立
import { chromium } from "playwright";
const base = "http://127.0.0.1:18090/";
let b; try { b = await chromium.launch(); } catch { b = await chromium.launch({ channel: "chrome" }); }
const pg = await b.newPage();
await pg.addInitScript(() => {
  // 只清一次（首次导航）：后续 reload 保留注入的 qweb.root
  if (!sessionStorage.getItem("__once")) { localStorage.clear(); sessionStorage.setItem("__once", "1"); }
});
await pg.goto(base);
await pg.waitForLoadState("networkidle");
await pg.waitForTimeout(4000); // boot：root 智能回落（transcript 反斜杠形式）

const histBtn = () => pg.locator('button[title^="历史会话（工作目录"]').first();
console.log("1) 零记忆回落 root:", await histBtn().getAttribute("title"));

// 直接注入"用户曾用选择器选过目录"的持久化结果（DirPicker 产出恒为正斜杠）
await pg.evaluate(() => localStorage.setItem("qweb.root", "C:/Users/cnhua/ccweb"));
console.log("2) 注入 qweb.root = C:/Users/cnhua/ccweb（正斜杠，等价 picker 选定）");
await pg.reload();
await pg.waitForLoadState("networkidle");
await pg.waitForTimeout(2500);

await histBtn().click();
await pg.waitForTimeout(800);
const layer = pg.locator("div.absolute.z-30").first();
const header = (await layer.locator("div.mb-1").innerText().catch(() => "(未找到)")).trim();
const empty = await layer.getByText("此目录暂无历史").count();
const items = await layer.locator("button:not([title='刷新'])").count();
console.log("3) 刷新后浮层 header:", JSON.stringify(header));
console.log("4) 浮层条目数:", items, empty ? "| 显示「此目录暂无历史」→ BUG 复现" : "| 有条目");
await pg.screenshot({ path: "hist-bug-repro.png" });
await b.close();
