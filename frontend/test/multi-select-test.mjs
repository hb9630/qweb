// 多选冒烟:普通点 A → Ctrl 点 B → 两行均选中;Shift 点 C → 范围选中
import { chromium } from "playwright";

const b = await chromium.launch();
const seen = [];
const pgConsole = (m) => { if (m.text().startsWith("EV") || m.text().startsWith("MD")) seen.push(m.text()); };
const page = await b.newPage();
page.on("console", pgConsole);
page.on("pageerror", (e) => console.log("PAGE-ERR:", e.message));
await page.goto("http://127.0.0.1:18090/", { waitUntil: "networkidle" });
await page.waitForSelector("button[data-path]", { timeout: 15000 });
await page.waitForTimeout(1500);

const rows = await page.$$("button[data-path]");
console.log("树行数:", rows.length);
const paths = [];
for (const r of rows.slice(0, 6)) paths.push(await r.getAttribute("data-path"));
console.log("前几行:", paths.slice(0, 4));

const selPaths = async () => JSON.parse(await page.evaluate(() => localStorage.getItem("qweb.sel")) || "{}").paths || [];

await rows[1].click();
await page.waitForTimeout(200);
console.log("点 A:", paths[1], "sel:", await selPaths());

await page.keyboard.down("Control");
await rows[3].click();
await page.keyboard.up("Control");
await page.waitForTimeout(300);
const sp = await selPaths();
console.log("Ctrl 点 B 后 sel:", sp);
console.log("CTRL-多选:", sp.includes(paths[1]) && sp.includes(paths[3]) ? "PASS" : "FAIL");

await page.keyboard.down("Shift");
await rows[5].click();
await page.keyboard.up("Shift");
await page.waitForTimeout(300);
const sp2 = await selPaths();
console.log("Shift 点 C 后 sel:", sp2);
const want = paths.slice(3, 6);
console.log("SHIFT-范围:", want.every((p) => sp2.includes(p)) ? "PASS" : "FAIL");

// 视觉验证:Shift 后 anchor=C,rows[1..4] 应为非当前选中(淡橙底),rows[5] 当前(实底)
const clsNc = await rows[3].getAttribute("class");
const clsCur = await rows[5].getAttribute("class");
const all = [];
for (let i = 3; i <= 5; i++) all.push((await rows[i].getAttribute("class")).includes("0.85_0.10_65"));
console.log("三项统一杏橙:", all.every(Boolean) ? "PASS" : "FAIL", all.join(","));

// 拖拽不坍缩:多选后 mouseDown 到选中项上(不 mouseUp)→ sel 仍 2 项
await page.evaluate(() => localStorage.setItem("qweb.sel", JSON.stringify({})));
await rows[7].click();
await page.keyboard.down("Control"); await rows[9].click(); await page.keyboard.up("Control");
const before = await selPaths();
const clicked = await rows[9].getAttribute("data-path");
// 拖拽前重取 boundingBox(先前布局可能已变,坐标错位点到别的行)
await page.evaluate(() => window.scrollTo(0, 0));
const el9 = page.locator(`button[data-path="${clicked}"]`);
await el9.scrollIntoViewIfNeeded();
const b2 = await el9.boundingBox();
await page.mouse.move(b2.x + b2.width / 2, b2.y + b2.height / 2);
await page.mouse.down();
await page.mouse.move(b2.x + b2.width / 2 + 8, b2.y + b2.height / 2 + 4, { steps: 3 });
const during = await selPaths();
await page.mouse.up();
console.log("拖拽起点不坍缩:", during.length === 2 ? "PASS" : "FAIL", "|", before.length, "->", during.length);


// 文件行多选:找两个 .py/.mjs 文件行
const fileRows = await page.$$("button[data-path]");
const files = [];
for (const r of fileRows) {
  const p = await r.getAttribute("data-path");
  if (/\.(mjs|py|ts|json)$/.test(p)) files.push({ r, p });
}
console.log("文件行样本:", files.slice(0, 2).map((f) => f.p));
if (files.length >= 2) {
  await files[0].r.click();
  await page.keyboard.down("Control");
  await files[1].r.click();
  await page.keyboard.up("Control");
  await page.waitForTimeout(300);
  const sp = await selPaths();
  console.log("文件 Ctrl 多选:", sp.includes(files[0].p) && sp.includes(files[1].p) ? "PASS" : "FAIL", sp.slice(0, 3));
}
await page.screenshot({ path: "multiselect-proof.png" });
console.log("EVENTS:", ...seen);
await b.close();
