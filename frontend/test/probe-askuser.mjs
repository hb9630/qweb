// AskUserQuestion 协议探针：驱动 claude stream-json，捕获 control_request 原始形状，
// 并按指定策略应答，观察后续事件（tool_result 形状 / 模型反应）。
// 用法：node probe-askuser.mjs <strategy>   strategy: plain-allow | deny | answer:<label>
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const strategy = process.argv[2] || "plain-allow";
const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "ccweb-ask-"));
const bin = String.raw`C:\Users\cnhua\AppData\Roaming\npm\node_modules\@anthropic-ai\claude-code\bin\claude.exe`;
const p = spawn(bin, [
  "--input-format", "stream-json", "--output-format", "stream-json",
  "--include-partial-messages", "--verbose", "--permission-prompt-tool", "stdio",
], { cwd, env: { ...process.env, HOME: "C:\\Users\\cnhua" } });

const w = (o) => p.stdin.write(JSON.stringify(o) + "\n");
let buf = "";
const t0 = Date.now();
const el = () => ((Date.now() - t0) / 1000).toFixed(1) + "s";

p.stdout.on("data", (d) => {
  buf += d.toString();
  let i;
  while ((i = buf.indexOf("\n")) >= 0) {
    const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1);
    if (!line) continue;
    let ev; try { ev = JSON.parse(line); } catch { continue; }
    if (ev.type === "control_request") {
      console.log(`[${el()}] >>> control_request 全文:\n${JSON.stringify(ev, null, 1)}`);
      const rid = ev.request_id;
      setTimeout(() => {
        if (strategy === "deny") {
          console.log(`[${el()}] <<< deny`);
          w({ type: "control_response", response: { subtype: "success", request_id: rid, response: { behavior: "deny", message: "User denied via probe" } } });
        } else if (strategy.startsWith("answer:")) {
          // 假设格式（二进制逆向所得）：updatedInput = 原输入 + answers:{问题文本:选中标签}
          // + 可选 response 自由文本。answer:乙,丙 = 逐题依次选（多选题用逗号并）
          const wanted = strategy.slice(7).split("‖"); // 多题用 ‖ 分隔
          const qs = ev.request?.input?.questions ?? [];
          const answers = {};
          qs.forEach((q, i) => {
            const pick = (wanted[i] ?? "").trim();
            if (pick) answers[q.question] = pick;
          });
          const resp = { behavior: "allow", updatedInput: { ...ev.request?.input, answers } };
          console.log(`[${el()}] <<< answer-尝试:\n${JSON.stringify(resp)}`);
          w({ type: "control_response", response: { subtype: "success", request_id: rid, response: resp } });
        } else if (strategy.startsWith("multi:")) {
          // 多选：answers 值传数组（labels 逗号分隔）
          const wanted = strategy.slice(6).split("‖");
          const qs = ev.request?.input?.questions ?? [];
          const answers = {};
          qs.forEach((q, i) => {
            const picks = (wanted[i] ?? "").split(",").map((s) => s.trim()).filter(Boolean);
            if (picks.length) answers[q.question] = q.multiSelect ? picks : picks[0];
          });
          const resp = { behavior: "allow", updatedInput: { ...ev.request?.input, answers } };
          console.log(`[${el()}] <<< multi-尝试:\n${JSON.stringify(resp)}`);
          w({ type: "control_response", response: { subtype: "success", request_id: rid, response: resp } });
        } else if (strategy.startsWith("freetext:")) {
          const resp = { behavior: "allow", updatedInput: { ...ev.request?.input, answers: {}, response: strategy.slice(9) } };
          console.log(`[${el()}] <<< freetext-尝试:\n${JSON.stringify(resp)}`);
          w({ type: "control_response", response: { subtype: "success", request_id: rid, response: resp } });
        } else {
          // plain-allow：原 input 原样回（ccweb 现状）
          console.log(`[${el()}] <<< plain-allow（原样 input，ccweb 现状）`);
          w({ type: "control_response", response: { subtype: "success", request_id: rid, response: { behavior: "allow", updatedInput: ev.request?.input } } });
        }
      }, 1500);
    } else if (ev.type === "user") {
      const c = ev.message?.content;
      const tr = Array.isArray(c) ? c.find((x) => x.type === "tool_result") : null;
      if (tr) console.log(`[${el()}] --- tool_result: is_error=${tr.is_error} content=${JSON.stringify(tr.content).slice(0, 300)}`);
      else if (Array.isArray(c)) { const t = c.filter((x) => x.type === "text").map((x) => x.text).join(""); if (t.trim()) console.log(`[${el()}] --- user: ${t.slice(0, 150)}`); }
      else if (typeof c === "string") console.log(`[${el()}] --- user: ${c.slice(0, 150)}`);
    } else if (ev.type === "result") {
      console.log(`[${el()}] === result (${ev.subtype}): ${String(ev.result).slice(0, 200)}`);
    } else if (ev.type === "system" && ev.subtype === "init") {
      console.log(`[${el()}] init sid=${ev.session_id}`);
    } else if (ev.type === "assistant") {
      const c = ev.message?.content ?? [];
      for (const b of c) if (b.type === "tool_use") console.log(`[${el()}] === tool_use: ${b.name} input=${JSON.stringify(b.input).slice(0, 300)}`);
      for (const b of c) if (b.type === "text" && b.text.trim()) console.log(`[${el()}] === 助手: ${b.text.slice(0, 200)}`);
    }
  }
});
p.stderr.on("data", (d) => process.stderr.write(d.toString().slice(0, 200)));
p.on("exit", (c) => { console.log(`[${el()}] 进程退出 code=${c}`); process.exit(0); });

const askMulti = strategy.startsWith("multi:");
setTimeout(() => w({ type: "user", message: { role: "user", content: [{ type: "text", text: askMulti
  ? "调用 AskUserQuestion 工具问我一个问题：题目'测试多选'，header 用'表单'，multiSelect 设为 true，给三个选项（标签 甲、乙、丙，各带一句描述）。就问这一个，问完等我的回答。"
  : "调用 AskUserQuestion 工具问我一个问题：题目'测试单选'，header 用'表单'，给三个选项（标签分别为 甲、乙、丙，各带一句描述）。就问这一个，问完等我的回答。" }] }}), 2500);
setTimeout(() => { try { p.kill(); } catch {} process.exit(0); }, 75000);
