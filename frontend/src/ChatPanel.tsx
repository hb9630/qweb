// 对话面板（AI Elements 官方 example-chatbot 风格）——chat-first 布局的底层主角：
// 铺满全宽（App 侧 absolute inset-0），头部即全局标题栏（左上三件套：cwd chip 开关目录树 /
// ▾ 历史工作目录 / 换目录选择器 DirPicker）。目录树/编辑器浮层由 App 叠在本层之上。
// 支持两种形态：live 会话（WS 双向）与只读历史回放（/api/history/{id}）
import { useEffect, useLayoutEffect, useReducer, useRef, useState, useCallback, useMemo, type KeyboardEvent } from "react";
import type { StickToBottomContext } from "use-stick-to-bottom";
import { Conversation, ConversationContent, ConversationScrollButton } from "@/components/ai-elements/conversation";
import { Message, MessageContent, MessageResponse } from "@/components/ai-elements/message";
import { Reasoning, ReasoningContent, ReasoningTrigger } from "@/components/ai-elements/reasoning";
import { Tool, ToolHeader, ToolContent, ToolInput, ToolOutput } from "@/components/ai-elements/tool";
import {
  PromptInput, PromptInputBody, PromptInputTextarea,
  PromptInputFooter, PromptInputTools, PromptInputSubmit,
} from "@/components/ai-elements/prompt-input";
import { cn, dispPath } from "@/lib/utils";
import { API, BASE, setHashSid } from "@/lib/api";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { CircleStop, FolderOpen, History, Plus, MessageSquare, RefreshCw, Loader2, X, Check, Shrink, Eraser, Zap, ListTodo, FilePen, Sparkles, FastForward, ShieldAlert, Ban, ArrowUp, Clock, Copy, ChevronDown, FolderSync, Cat, File as FileIcon, HelpCircle } from "lucide-react";
import DirPicker from "./DirPicker";
import type { UIBlock } from "./types";

interface State { blocks: UIBlock[]; busy: boolean; alive: boolean; connected: boolean; model: string; permMode: string; slashCmds: string[]; ctxAbs?: number; thinkTokens: number }
type Action =
  | { t: "cc"; ev: any }
  | { t: "replay"; events: any[] }
  | { t: "user"; text: string; imgs?: number }
  | { t: "perm"; rid: string; allow: boolean }
  | { t: "formAns"; rid: string; summary: string; answers?: Record<string, string | string[]> } // 表单提交/跳过落账（done 整卡保留，answers 供选项高亮）
  | { t: "note"; text: string }
  | { t: "clear" }
  | { t: "connected"; v: boolean }
  | { t: "model"; v: string } // 乐观模型显示（set_model 回包不回显，下一轮 message_start 校真）
  | { t: "exit" };

// 权限模式（CLI v2.1 实测合法值；bypassPermissions 需 --dangerously-skip-permissions 启动，不提供）
const MODES = [
  { id: "default", label: "act", desc: "默认：按允许清单执行工具", Icon: Zap },
  { id: "plan", label: "plan", desc: "只读规划，不动手改", Icon: ListTodo },
  { id: "acceptEdits", label: "acceptEdits", desc: "自动接受文件编辑", Icon: FilePen },
  { id: "auto", label: "auto", desc: "自动模式：模型自查安全后执行", Icon: Sparkles },
  { id: "dontAsk", label: "dontAsk", desc: "跳过询问，直接执行", Icon: FastForward },
];
// 模型建议兜底（正常应使用 /api/env 下发的、从 claude settings 推导的列表）：
// 别名由 CLI 经 ANTHROPIC_DEFAULT_*_MODEL 解析，恒有效；任意 ID 仍可自由输入（代理端校验）
const MODEL_PRESETS = ["sonnet", "opus", "haiku", "default"];
// 斜杠命令无兜底死列表：真清单只来自 live 会话 init.slash_commands（含 skills）；
// 无会话/未启动时如实提示，不放假数据误导（后端 spawn 即唤醒 CLI 下发 init，无需等首轮消息）
const SLASH_DESC: Record<string, string> = {
  compact: "压缩上下文", model: "查看/切换模型", effort: "思考力度", clear: "清屏",
  usage: "用量统计", context: "上下文详情", agents: "子代理", mcp: "MCP 服务器",
  rename: "重命名会话", "output-style": "输出风格", config: "设置项", init: "初始化项目",
  doctor: "诊断", insights: "会话洞察", fast: "快速模式", autocompact: "自动压缩设置",
};

// ---- 上下文窗口推定（ctx% 分母）----
// 中转会把模型名剥成裸名（glm-5.3[1m] → glm-5.3），兜底 200k 会把 1M 会话算成
// 5 倍虚高。推定链（只在渲染时取，ctx% 不在 state 定格——晚到的信息也能生效）：
//   1) localStorage 记忆：result 的 modelUsage.contextWindow（live 流带原名键；
//      历史回放的合成 result 由服务端落盘记忆回注，见 server 的 qweb-ctxwin.json）
//      经 rememberCtxWin 按归一名写入
//   2) /api/env 的模型清单（settings 推导，含 [1m] 原名）→ 裸名命中即 1M
const normModel = (m: unknown) => String(m ?? "").replace(/\[1m\]$/i, "");
const ctxWinHints = new Set<string>(); // env 清单里带 [1m] 的模型归一名（ChatPanel 同步）
const rememberCtxWin = (mu: any) => {
  try {
    for (const [k, v] of Object.entries(mu ?? {}))
      if ((v as any)?.contextWindow) localStorage.setItem(`qweb.ctxwin.${normModel(k)}`, String((v as any).contextWindow));
  } catch {}
};
const ctxWindowOf = (model: string): number => {
  try {
    const saved = Number(localStorage.getItem(`qweb.ctxwin.${normModel(model)}`));
    if (saved > 0) return saved;
  } catch {}
  if (ctxWinHints.has(normModel(model))) return 1_000_000;
  return /1m/i.test(model) ? 1_000_000 : 200_000;
};

function toolState(b: Extract<UIBlock, { k: "tool" }>) {
  if (b.result !== undefined) return b.isError ? "output-error" : "output-available";
  if (b.live) return "input-streaming";
  return "input-available";
}

// 块稳定 id：render key 用（位置键在窗口移动时整列 remount，滚动锚定失效）。
// 计数器挂 globalThis：Fast Refresh 重跑模块不清零——清零后新块 bid 与旧块撞 key，
// 消息列表闪烁、块互相顶掉（仅开发态热替换触发，但正是调试时的日常路径）
const nextBid = () => ((globalThis as any).__qwebBID = ((globalThis as any).__qwebBID ?? 0) + 1);

// 不 export：此文件要保持"仅组件导出"，Fast Refresh 才能热替换（多一个非组件导出就退化成整页刷新）
function ccReducer(s: State, a: Action): State {
  switch (a.t) {
    // WS 连上即进程存活：历史面板（alive 初始 false）被原地升级为 live 时不重挂，
    // alive 只能靠这里恢复，否则 send 会一直被"进程已退出"拦掉
    case "connected": return a.v ? { ...s, connected: true, alive: true } : { ...s, connected: false };
    case "replay":
      // 挂载时回放 transcript/初始事件；面板已有内容（历史→resume 原地升级，无重挂）
      // 则跳过——再注一遍会整列表重复
      if (s.blocks.length) return s;
      return a.events.reduce((st: State, ev: any) => ccReducer(st, { t: "cc", ev }), s);
    case "exit": return { ...s, alive: false, busy: false };
    // 乐观模型显示：set_model 的 control_response 是光杆 success（实测不回显模型名、
    // 也不校验非法值），点了没反馈像没生效——先显示所请求的，下一轮 message_start 校真
    case "model": return { ...s, model: a.v };
    case "user": return { ...s, blocks: [...s.blocks, { bid: nextBid(), k: "user", text: a.text, ...(a.imgs ? { imgs: a.imgs } : {}) }], busy: true };
    // 审批决定本地落账（WS 回包照发；重复/迟到回包 CLI 侧自会忽略）
    case "perm":
      return { ...s, blocks: s.blocks.map((b) => b.k === "ask" && b.rid === a.rid ? { ...b, done: a.allow ? "allow" as const : "deny" as const } : b) };
    // 表单作答/跳过落账（WS 回包照发；tool_result 到达的兜底落定见 user 分支）
    case "formAns":
      return { ...s, blocks: s.blocks.map((b) => b.k === "form" && b.rid === a.rid && !b.done
        ? { ...b, done: { summary: a.summary, answers: a.answers } } : b) };
    case "note": return { ...s, blocks: [...s.blocks, { bid: nextBid(), k: "note", text: a.text }] };
    case "clear": return { ...s, blocks: [] };
    case "cc": {
      const ev = a.ev;
      const blocks = [...s.blocks];
      const last = () => blocks[blocks.length - 1];
      if (ev.type === "system" && ev.subtype === "init") {
        const model = ev.model || ev.model_info?.display_name || ev.model_info?.id || "";
        // init 携带 slash_commands 全量清单（terminal_* 为本地终端绑定命令，远程 UI 应隐藏）
        const term = new Set(ev.terminal_slash_commands ?? []);
        const slashCmds = (ev.slash_commands ?? [])
          .filter((c: any) => typeof c === "string" && !term.has(c) && !c.startsWith("__"));
        return { ...s, model: String(model), permMode: String(ev.permissionMode || "default"), slashCmds };
      }
      // 模式切换广播（set_permission_mode 成功后 CLI 主动下发 status 事件）
      if (ev.type === "system" && ev.subtype === "status" && ev.permissionMode)
        return { ...s, permMode: String(ev.permissionMode) };
      // /clear 等会话重置（v2.1 实测）：CLI 侧上下文已清空，ctx 基线必须归零——
      // 不归零会被单调防抖挡住（clear 后的合成 result usage 全 0，max 永远取旧值）。
      // trigger=clear 同时清屏（对齐 CLI 行为）；其他 trigger（压缩类）只归基线
      if (ev.type === "conversation_reset")
        return ev.trigger === "clear" ? { ...s, blocks: [], ctxAbs: 0 } : { ...s, ctxAbs: 0 };
      // control_request 回包：set_model / set_permission_mode 成败都从这里走
      if (ev.type === "control_response") {
        const r = ev.response ?? {};
        if (r.subtype === "error")
          return { ...s, blocks: [...blocks, { bid: nextBid(), k: "note", text: `操作失败：${r.error}` }] };
        const out = r.response ?? {};
        if (typeof out.model === "string") return { ...s, model: out.model };
        if (typeof out.mode === "string") return { ...s, permMode: out.mode };
        return s;
      }
      // 权限询问（--permission-prompt-tool stdio 武装后，"ask" 路径不再静默拒绝）：
      // 入卡片挂起；tool_use_id 关联后续 tool_result 判定解决态。其他子类型（弹窗类）忽略
      if (ev.type === "control_request") {
        const r = ev.request ?? {};
        if (r.subtype === "can_use_tool") {
          // AskUserQuestion 走结构化表单块（单选/多选/其他输入，TUI 同款）；
          // 空壳/畸形题面退回通用权限卡兜底。assistant 定稿可能已建同 tuid 块（回放/
          // live 双路径共建），此处只补写 rid（作答回包要用）
          if (r.tool_name === "AskUserQuestion" && Array.isArray(r.input?.questions) && r.input.questions.length) {
            const tuid = String(r.tool_use_id ?? "");
            const i = blocks.findIndex((b: any) => b.k === "form" && b.tuid === tuid);
            if (i >= 0) blocks[i] = { ...(blocks[i] as any), rid: String(ev.request_id ?? "") };
            else blocks.push({
              bid: nextBid(),
              k: "form", rid: String(ev.request_id ?? ""), tuid,
              questions: r.input.questions,
            });
            return { ...s, blocks };
          }
          return { ...s, blocks: [...blocks, {
            bid: nextBid(),
            k: "ask", rid: String(ev.request_id ?? ""), tuid: String(r.tool_use_id ?? ""),
            tool: String(r.tool_name ?? r.display_name ?? "?"),
            inputJson: JSON.stringify(r.input ?? {}, null, 2),
          }] };
        }
        return s;
      }
      // 思考计数（system/estimated_tokens_delta 增量累加；result 归零，replay 时重放累计）
      if (ev.type === "system" && ev.subtype === "thinking_tokens")
        return { ...s, thinkTokens: s.thinkTokens + (ev.estimated_tokens_delta ?? 0) };
      if (ev.type === "stream_event") {
        const e = ev.event ?? {};
        // message_start 携带实际服务模型（/model 或 set_model 切换后以此为准）；
        // 同时置 busy：刷新/重连后本地 busy 是 false，但这一轮是别处发起、正在进行——
        // 不置的话输入区不显示进行态，ESC 打断也会被 busy 守卫拦掉
        if (e.type === "message_start" && e.message?.model) s = { ...s, busy: true, model: String(e.message.model) };
        if (e.type === "message_start") s = { ...s, thinkTokens: 0 };
        if (e.type === "content_block_start") {
          const b = e.content_block;
          if (b?.type === "tool_use") blocks.push({ bid: nextBid(), k: "tool", id: b.id, name: b.name, inputJson: "", live: true });
          return { ...s, blocks };
        }
        if (e.type === "content_block_delta") {
          const d = e.delta ?? {};
          const L = last();
          if (d.type === "text_delta" && d.text) {
            if (L && L.k === "text" && L.live) blocks[blocks.length - 1] = { ...L, text: L.text + d.text };
            else blocks.push({ bid: nextBid(), k: "text", text: d.text, live: true });
          } else if (d.type === "thinking_delta" && d.thinking) {
            if (L && L.k === "think" && L.live) blocks[blocks.length - 1] = { ...L, text: L.text + d.thinking };
            else blocks.push({ bid: nextBid(), k: "think", text: d.thinking, live: true });
          } else if (d.type === "input_json_delta" && d.partial_json) {
            if (L && L.k === "tool" && L.live) blocks[blocks.length - 1] = { ...L, inputJson: L.inputJson + d.partial_json };
          }
          return { ...s, blocks };
        }
        return s;
      }
      if (ev.type === "assistant") {
        // 定稿块插到本轮首个流式块的位置（而非全 push 到末尾）：busy 时排队发出的
        // 用户消息排在流式块之后，filter+末尾 push 会把排队消息顶到定稿前面——
        // 顺序错，且索引 key 连锁重挂（肉眼可见的尾部"跳块重刷"）
        const sub = ev.parent_tool_use_id != null; // 子代理（Task sidechain）事件缩进弱化
        const first = blocks.findIndex((b: any) => b.live);
        const finals: UIBlock[] = [];
        for (const c of ev.message?.content ?? []) {
          if (c.type === "text") finals.push({ bid: nextBid(), k: "text", text: c.text, sub });
          else if (c.type === "thinking") finals.push({ bid: nextBid(), k: "think", text: c.thinking, sub });
          else if (c.type === "tool_use") {
            finals.push({ bid: nextBid(), k: "tool", id: c.id, name: c.name, inputJson: JSON.stringify(c.input, null, 2) ?? "", sub });
            // AskUserQuestion 回放重建：transcript 不记 control_request 行，题面在
            // assistant 定稿的 tool_use.input 里——此处建 form 块（rid 空，后到的
            // control_request 补写；纯回放则由 tool_result 文本解析落定成高亮卡）
            if (c.name === "AskUserQuestion" && Array.isArray(c.input?.questions) && c.input.questions.length
              && !blocks.some((b: any) => b.k === "form" && b.tuid === c.id)
              && !finals.some((b: any) => b.k === "form" && b.tuid === c.id))
              finals.push({ bid: nextBid(), k: "form", rid: "", tuid: String(c.id), questions: c.input.questions });
          }
        }
        const kept = blocks.filter((b: any) => !b.live);
        if (first < 0) kept.push(...finals);
        else kept.splice(first, 0, ...finals); // first 前都是非流式块，kept 中下标不变
        return { ...s, blocks: kept };
      }
      if (ev.type === "user") {
        // 用户消息（历史回放来自官方 transcript；live 流中本地已入块，去重跳过）
        const c0 = ev.message?.content;
        const text = typeof c0 === "string" ? c0
          : Array.isArray(c0) ? c0.filter((x: any) => x.type === "text").map((x: any) => x.text).join("") : "";
        const nImg = Array.isArray(c0) ? c0.filter((x: any) => x.type === "image").length : 0;
        if (text.trim() || nImg) {
          // compact 的系统注入：不渲染成用户消息，并重置上下文基线（压缩后骤降是合法的）
          if (text.trim().startsWith("This session is being continued"))
            return { ...s, ctxAbs: 0 };
          const L = last();
          // 斜杠命令的 transcript 回显（<command-name>/x</command-name>…）与本地已入块的 "/x args" 重复，跳过
          const cn = /<command-name>([^<]+)<\/command-name>/.exec(text);
          if (cn && L && L.k === "user" && L.text.trim().startsWith(cn[1].trim()))
            return { ...s, blocks };
          if (!(L && L.k === "user" && L.text === text.trim())) {
            blocks.push({ bid: nextBid(), k: "user", text: text.trim(), ...(nImg ? { imgs: nImg } : {}) });
          }
          return { ...s, blocks };
        }
        for (const c of Array.isArray(c0) ? c0 : []) {
          if (c.type === "tool_result") {
            // 文本化的结果内容（tool 块落定与表单兜底解析共用）
            const rc = typeof c.content === "string" ? c.content
              : Array.isArray(c.content) ? c.content.filter((x: any) => x.type === "text").map((x: any) => x.text).join("\n") : "";
            const i = blocks.findIndex((b: any) => b.k === "tool" && b.id === c.tool_use_id);
            if (i >= 0) {
              const b: any = blocks[i];
              blocks[i] = { ...b, live: false, result: rc, isError: !!c.is_error };
            }
            // 权限卡片跟着落定（deny 的 tool_result 是 is_error + 拒绝文案）
            const ai = blocks.findIndex((b: any) => b.k === "ask" && b.tuid === c.tool_use_id && !b.done);
            if (ai >= 0)
              blocks[ai] = { ...(blocks[ai] as any), done: c.is_error ? "deny" : "allow" };
            // 表单块同理（重连/回放时本地未作答）：从官方 tool_result 文本尽力还原
            // 各题答案（"题"="值" 逐对解析；值含逗号且各段均命中该题选项 → 多选数组，
            // 否则整串=自定义文本），供 done 卡的选项高亮
            const fi = blocks.findIndex((b: any) => b.k === "form" && b.tuid === c.tool_use_id && !b.done);
            if (fi >= 0) {
              const fb: any = blocks[fi];
              if (c.is_error) {
                blocks[fi] = { ...fb, done: { summary: "已跳过" } };
              } else {
                const answers: Record<string, string | string[]> = {};
                for (const mm of String(rc).matchAll(/"([^"]+)"="([^"]*)"/g)) {
                  const labels = (fb.questions ?? []).find((q: any) => q.question === mm[1])?.options?.map((o: any) => o.label) ?? [];
                  const parts = mm[2].split(",");
                  answers[mm[1]] = parts.length > 1 && parts.every((p: string) => labels.includes(p)) ? parts : mm[2];
                }
                blocks[fi] = { ...fb, done: { summary: "已回答", answers: Object.keys(answers).length ? answers : undefined } };
              }
            }
          }
        }
        return { ...s, blocks };
      }
      if (ev.type === "result") {
        // 上下文占用：input + cache 三项之和 = 该轮请求总上下文
        rememberCtxWin(ev.modelUsage);
        const u = ev.usage ?? {};
        const usedAbs = (u.input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0);
        // 窗口自校正：占用显著超过推定窗口（>5%）说明分母低估（中转剥了 [1m] 标记又不在
        // env 清单里）——按 1M 记忆该模型，ctx% 不再虚超 100%
        const mName = normModel(ev.model ?? s.model);
        try {
          if (usedAbs > ctxWindowOf(mName) * 1.05)
            localStorage.setItem(`qweb.ctxwin.${mName}`, "1000000");
        } catch {}
        // 窗口推定（modelUsage→localStorage→hints→默认）移到渲染处：见 ctxPct 派生注释
        // 单调防抖：上下文只增不减（compact/clear 已各自重置），防网关 usage 偶发波动。
        // ctx% 不在这里定格：分母信息渐进到达（见渲染处派生注释）
        const ctxAbs = Math.max(usedAbs, s.ctxAbs ?? 0);
        return { ...s, busy: false, thinkTokens: 0, model: ev.model ? String(ev.model) : s.model, ctxAbs };
      }
      return s;
    }
  }
}

// 思考内容页内上限（CC TUI 同思路）：超出只留前段，点开浮窗看全文，
// 防长思考把页面撑出几屏
const THINK_INLINE_MAX = 600;

function ThinkBlock({ b }: { b: Extract<UIBlock, { k: "think" }> }) {
  const [open, setOpen] = useState(!!b.live);
  const [zoom, setZoom] = useState(false);
  const zoomRef = useRef<HTMLDivElement>(null);
  // 浮窗打开默认滚到底：思考流式追加，最新内容在末尾（打开时总想看"想到哪了"）
  useEffect(() => {
    if (zoom) requestAnimationFrame(() => {
      const el = zoomRef.current;
      if (el) el.scrollTop = el.scrollHeight;
    });
  }, [zoom]);
  const over = b.text.length > THINK_INLINE_MAX;
  return (
    <Reasoning open={open} onOpenChange={setOpen}
      className="w-full text-xs">
      <ReasoningTrigger />
      {/* ReasoningContent 只收 string（Streamdown markdown）——按钮放折叠区外，展开且超长时才出现 */}
      <ReasoningContent>{over ? b.text.slice(0, THINK_INLINE_MAX) + "…" : b.text}</ReasoningContent>
      {over && open && (
        <button className="ml-4 mt-1 block text-[0.6875rem] text-primary/80 underline-offset-2 hover:underline"
          onClick={() => setZoom(true)}>
          查看全部 {b.text.length} 字
        </button>
      )}
      <Dialog open={zoom} onOpenChange={setZoom}>
        <DialogContent className="sm:max-w-2xl">
          <DialogHeader>
            <DialogTitle className="text-sm">思考过程 · {b.text.length} 字</DialogTitle>
          </DialogHeader>
          <div ref={zoomRef} className="max-h-[70vh] overflow-y-auto whitespace-pre-wrap break-words rounded-md bg-muted/40 p-3 font-mono text-xs leading-relaxed">
            {b.text}
          </div>
        </DialogContent>
      </Dialog>
    </Reasoning>
  );
}

// 本地命令输出（/model 等）带 <local-command-stdout>…</local-command-stdout> 包裹标签，展示时剥掉只留内容
const stripCmdTags = (t: string) => t.replace(/<\/?local-command-(?:stdout|stderr)>/g, "").trim();

// 拷贝到剪贴板：优先 clipboard API（需安全上下文），非 https 退 execCommand（Explorer 同款）
async function copyTextUtil(text: string) {
  try {
    if (navigator.clipboard && window.isSecureContext) { await navigator.clipboard.writeText(text); return true; }
  } catch {}
  try {
    const ta = document.createElement("textarea");
    ta.value = text; ta.style.position = "fixed"; ta.style.opacity = "0";
    document.body.append(ta); ta.select();
    const ok = document.execCommand("copy");
    ta.remove();
    return ok;
  } catch { return false; }
}

// 程序化写入输入框：PromptInput 的 value prop 只做初始值，控制器内部 state 才是真源，
// 外部 setInput 到不了输入框——直接写 DOM 并派发 input 事件走 onChange 链（控制器/镜像态全同步）
const setTaValue = (v: string, caret: number | "end") => {
  const ta = document.querySelector("textarea[name='message']") as HTMLTextAreaElement | null;
  if (!ta) return;
  ta.value = v;
  ta.dispatchEvent(new Event("input", { bubbles: true }));
  requestAnimationFrame(() => {
    const p = caret === "end" ? v.length : caret;
    ta.setSelectionRange(p, p);
  });
};

// 消息右下角复制按钮：hover 所属消息时浮现（半悬浮在气泡底边上）
function CopyBtn({ text }: { text: string }) {
  const [ok, setOk] = useState(false);
  return (
    <button
      className="absolute bottom-0 right-0 flex translate-y-1/2 items-center gap-1 rounded-md border border-border/70 bg-popover px-1.5 py-0.5 text-[0.625rem] text-muted-foreground opacity-0 shadow-sm transition-opacity hover:text-foreground group-hover/msg:opacity-100"
      title="复制全文"
      onMouseDown={(e) => e.stopPropagation()}
      onClick={async (e) => {
        e.stopPropagation();
        setOk(await copyTextUtil(text));
        setTimeout(() => setOk(false), 1500);
      }}>
      {ok ? <Check className="h-3 w-3 text-primary" /> : <Copy className="h-3 w-3" />}
    </button>
  );
}

// MCP 工具名美化：mcp__server__tool → mcp:server/tool（type 保持原名，仅展示层改名）
const toolLabel = (n: string) => n.startsWith("mcp__") ? `mcp:${n.slice(5).replace(/__/g, "/")}` : n;

// 权限询问卡片：pending 态可裁决；done 后塌缩成一行结果。
// 参数人话化：优先字段（command/file_path/…）大字展示，其余键小字 k-v 一行一个；
// 解析失败或无键可读才退回裸 JSON（避免一上来就是一坨 json 的观感）
const ASK_KEY_LABEL: Record<string, string> = {
  command: "命令", file_path: "文件", path: "路径", notebook_path: "笔记本",
  url: "网址", pattern: "匹配", prompt: "提示词", description: "说明", query: "查询",
  script: "脚本", code: "代码", edits: "编辑内容", content: "内容", old_string: "原文本", new_string: "新文本",
};
function AskBlock({ b, canAct, onRespond }: {
  b: Extract<UIBlock, { k: "ask" }>;
  canAct: boolean;
  onRespond: (rid: string, allow: boolean) => void;
}) {
  if (b.done)
    return (
      <div className={cn("my-1 flex items-center gap-1.5 text-xs font-medium",
        b.done === "allow" ? "text-emerald-600 dark:text-emerald-400" : "text-red-600 dark:text-red-400")}>
        {b.done === "allow" ? <Check className="h-3.5 w-3.5 shrink-0" /> : <Ban className="h-3.5 w-3.5 shrink-0" />}
        已{b.done === "allow" ? "允许" : "拒绝"} · {toolLabel(b.tool)}
      </div>
    );
  // 参数拆解：主字段（第一个命中的优先键）+ 其余键
  let input: any = null;
  try { input = JSON.parse(b.inputJson || "{}"); } catch {}
  const flat = input && typeof input === "object" && !Array.isArray(input)
    ? Object.entries(input).filter(([, v]) => v !== undefined && v !== null && v !== "") : [];
  const mainKey = flat.find(([k]) => ASK_KEY_LABEL[k] && typeof (input as any)[k] === "string")?.[0];
  const mainVal = mainKey ? String((input as any)[mainKey]) : null;
  const rest = flat.filter(([k]) => k !== mainKey);
  return (
    <div className="my-1.5 w-full rounded-lg border border-amber-500/50 bg-amber-500/10 p-3">
      <div className="flex items-center gap-1.5 text-xs font-medium text-amber-700 dark:text-amber-300">
        <ShieldAlert className="h-3.5 w-3.5 shrink-0" />
        {toolLabel(b.tool)} 请求授权
      </div>
      {mainVal != null ? (
        <>
          <div className="mt-1.5 text-[0.625rem] text-muted-foreground">{ASK_KEY_LABEL[mainKey]}</div>
          <pre className="mt-0.5 max-h-28 overflow-auto whitespace-pre-wrap break-all rounded bg-muted/50 p-2 font-mono text-[0.6875rem] leading-relaxed text-foreground/90">
            {mainVal}
          </pre>
        </>
      ) : null}
      {rest.length > 0 && (
        <div className="mt-1.5 flex max-h-28 flex-col gap-0.5 overflow-y-auto">
          {rest.map(([k, v]) => {
            const s = typeof v === "string" ? v : JSON.stringify(v);
            return (
              <div key={k} className="flex min-w-0 items-baseline gap-1.5 text-[0.6875rem]">
                <span className="shrink-0 text-muted-foreground">{ASK_KEY_LABEL[k] ?? k}</span>
                <span className="min-w-0 flex-1 truncate font-mono text-foreground/70" title={s}>{s}</span>
              </div>
            );
          })}
        </div>
      )}
      {!mainVal && !rest.length && (
        <pre className="mt-1.5 max-h-44 overflow-auto whitespace-pre-wrap break-all rounded bg-muted/50 p-2 font-mono text-[0.6875rem] leading-relaxed text-foreground/80">
          {b.inputJson}
        </pre>
      )}
      <div className="mt-2 flex items-center gap-2">
        <Button size="sm" type="button" disabled={!canAct} onClick={() => onRespond(b.rid, true)}>允许</Button>
        <Button size="sm" type="button" variant="outline" disabled={!canAct} onClick={() => onRespond(b.rid, false)}>拒绝</Button>
        <span className="ml-auto shrink-0 text-[0.625rem] text-muted-foreground/70">等待授权期间会话暂停</span>
      </div>
    </div>
  );
}

// AskUserQuestion 交互表单（TUI 同款交互）：单选圆点/多选方点 + 选项描述 + 每题"其他"
// 自由输入；键盘 ↑↓ 在选项间移焦、空格/点击勾选、单选 Enter=选中即提交、Esc=跳过
// （焦点在卡片内时全局 Esc 守卫放行，不打断会话）。提交经 WS perm 帧带 answers
// （协议实测：answers 搭 updatedInput 回传，{问题文本: 标签|[标签...]|自定义文本}，
// CLI 组装 tool_result "问题"="选项"）；答完塌缩成摘要行，tool_result 经 tuid 兜底落定
function FormBlock({ b, canAct, onRespond, onSkip }: {
  b: Extract<UIBlock, { k: "form" }>;
  canAct: boolean;
  onRespond: (rid: string, answers: Record<string, string | string[]>, summary: string) => void;
  onSkip: (rid: string) => void;
}) {
  const [sel, setSel] = useState<Record<number, string>>({});       // 单选：题号 → label
  const [multi, setMulti] = useState<Record<number, string[]>>({}); // 多选：题号 → labels
  const [other, setOther] = useState<Record<number, string>>({});   // 每题自定义文本（TUI "Other"）
  const btnRefs = useRef<(HTMLButtonElement | null)[]>([]);
  // 挂载抢焦点：表单出现时会话正阻塞等待回答，第一选项即焦点（↑↓ 由此起跳）
  useEffect(() => { if (canAct) btnRefs.current[0]?.focus(); }, []);

  const opts = (qi: number) => b.questions[qi]?.options ?? [];
  const isSel = (qi: number, oi: number) => {
    const l = opts(qi)[oi]?.label;
    return b.questions[qi]?.multiSelect ? (multi[qi] ?? []).includes(l) : sel[qi] === l;
  };
  const toggle = (qi: number, oi: number) => {
    const l = opts(qi)[oi]?.label;
    if (!l) return;
    if (b.questions[qi].multiSelect)
      setMulti((m) => ({ ...m, [qi]: (m[qi] ?? []).includes(l) ? m[qi].filter((x) => x !== l) : [...(m[qi] ?? []), l] }));
    else {
      setSel((v) => ({ ...v, [qi]: l }));
      setOther((o) => ({ ...o, [qi]: "" })); // 点选项清"其他"（单选二者互斥）
    }
  };
  // 提交：未作答的题不进 answers（CLI 按 no-option-selected 处理，实测允许部分作答）；
  // forceQi/forceLabel = 单选 Enter 选中即提交的强制覆盖（setState 异步，闭包态是旧的）
  const submit = (forceQi?: number, forceLabel?: string) => {
    const answers: Record<string, string | string[]> = {};
    const parts: string[] = [];
    b.questions.forEach((q: any, qi: number) => {
      const custom = (other[qi] ?? "").trim();
      const picked = q.multiSelect
        ? [...(multi[qi] ?? []), ...(custom ? [custom] : [])]
        : custom || (qi === forceQi ? forceLabel : sel[qi]) || "";
      if (Array.isArray(picked) ? picked.length : picked) {
        answers[q.question] = picked;
        parts.push(`${q.header ?? q.question}：${Array.isArray(picked) ? picked.join("、") : picked}`);
      }
    });
    onRespond(b.rid, answers, parts.length ? `已回答 · ${parts.join("；")}` : "已提交（未作答）");
  };
  // 卡片容器收口键盘：↑↓ 选项按钮间循环移焦（焦点高亮即导航位）、Esc=跳过；
  // 空格/Enter 在按钮上走原生 click（勾选），"其他"输入框的 Enter 在自身 onKeyDown 提交
  const onKey = (e: KeyboardEvent) => {
    if (e.key === "Escape") { e.preventDefault(); if (canAct) onSkip(b.rid); return; }
    if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
    e.preventDefault();
    const btns = btnRefs.current.filter(Boolean) as HTMLButtonElement[];
    const cur = btns.indexOf(document.activeElement as HTMLButtonElement);
    const next = cur < 0 ? 0 : (cur + (e.key === "ArrowDown" ? 1 : -1) + btns.length) % btns.length;
    btns[next]?.focus();
  };

  // 落定态：整卡保留（不塌缩）——全部选项照常显示，选中的高亮打勾、未选的灰化，
  // 自定义文本单独一行；answers 缺失（回放兜底未解析出）时全灰 + 摘要仍准确
  if (b.done) {
    const ans = (qi: number, label: string) => {
      const v = b.done?.answers?.[b.questions[qi]?.question];
      return Array.isArray(v) ? v.includes(label) : v === label;
    };
    const customOf = (qi: number) => {
      const q: any = b.questions[qi];
      const v = b.done?.answers?.[q?.question];
      if (v == null) return null;
      const labels = (q?.options ?? []).map((o: any) => o.label);
      const cus = (Array.isArray(v) ? v : [v]).filter((x) => !labels.includes(x));
      return cus.length ? cus.join("、") : null;
    };
    return (
      <div className="my-1.5 w-full rounded-lg border border-border bg-card p-3 opacity-90">
        <div className="flex items-center gap-1.5 text-xs font-medium text-sky-600 dark:text-sky-400">
          {b.done.summary.startsWith("已跳过") ? <Ban className="h-3.5 w-3.5 shrink-0" /> : <Check className="h-3.5 w-3.5 shrink-0" />}
          {b.done.summary.replace("已回答 · ", "已回答：")}
        </div>
        {b.questions.map((q: any, qi: number) => (
          <div key={qi} className="mt-2">
            <div className="flex items-baseline gap-1.5">
              <span className="shrink-0 rounded bg-sky-500/20 px-1 py-px font-mono text-[0.625rem] text-sky-700 dark:text-sky-300">{q.header || "问题"}</span>
              <span className="min-w-0 text-xs font-medium text-foreground/90">{q.question}</span>
            </div>
            <div className="mt-1 flex flex-col gap-1">
              {opts(qi).map((o: any, oi: number) => (
                <div key={oi}
                  className={cn("flex items-start gap-2 rounded-md border px-2 py-1.5",
                    ans(qi, o.label) ? "border-sky-500/70 bg-sky-500/20" : "border-border bg-background opacity-45")}>
                  <span className={cn("mt-0.5 flex h-3.5 w-3.5 shrink-0 items-center justify-center border",
                    q.multiSelect ? "rounded-[3px]" : "rounded-full",
                    ans(qi, o.label) ? "border-sky-500 bg-sky-500 text-white" : "border-muted-foreground/50")}>
                    {ans(qi, o.label) && <Check className="h-2.5 w-2.5" />}
                  </span>
                  <span className="min-w-0">
                    <span className="block text-xs font-medium leading-snug text-foreground/90">{o.label}</span>
                    {o.description && <span className="block text-[0.6875rem] leading-snug text-muted-foreground">{o.description}</span>}
                  </span>
                </div>
              ))}
              {customOf(qi) && (
                <div className="flex items-center gap-2 rounded-md border border-sky-500/70 bg-sky-500/20 px-2 py-1.5 text-xs">
                  <span className="shrink-0 text-[0.625rem] text-muted-foreground">其他</span>
                  <span className="min-w-0 font-medium text-foreground/90">{customOf(qi)}</span>
                </div>
              )}
            </div>
          </div>
        ))}
      </div>
    );
  }
  let flat = 0; // 平铺按钮序的累计起点（ref 下标用；const 每题定格，防闭包串位）
  return (
    <div data-form="pending" tabIndex={-1} onKeyDown={onKey}
      className="my-1.5 w-full rounded-lg border border-border bg-card p-3 shadow-sm">
      <div className="flex items-center gap-1.5 text-xs font-medium text-sky-700 dark:text-sky-300">
        <HelpCircle className="h-3.5 w-3.5 shrink-0" />
        需要你的选择
        {b.questions.length > 1 && <span className="text-muted-foreground">（{b.questions.length} 个问题）</span>}
      </div>
      {b.questions.map((q: any, qi: number) => {
        const start = flat; flat += opts(qi).length;
        return (
        <div key={qi} className={qi ? "mt-3" : "mt-2"}>
          <div className="flex items-baseline gap-1.5">
            <span className="shrink-0 rounded bg-sky-500/20 px-1 py-px font-mono text-[0.625rem] text-sky-700 dark:text-sky-300">{q.header || "问题"}</span>
            <span className="min-w-0 text-xs font-medium text-foreground/90">{q.question}</span>
            {q.multiSelect && <span className="shrink-0 text-[0.625rem] text-muted-foreground">可多选</span>}
          </div>
          <div className="mt-1 flex flex-col gap-1">
            {opts(qi).map((o: any, oi: number) => {
              const idx = start + oi;
              return (
              <button key={oi} ref={(el) => { btnRefs.current[idx] = el; }} type="button"
                disabled={!canAct}
                role={q.multiSelect ? "checkbox" : "radio"} aria-checked={isSel(qi, oi)}
                onClick={() => toggle(qi, oi)}
                onKeyDown={(e) => {
                  // 单选 Enter：选中即提交（preventDefault 阻断原生 click 的二次 toggle）
                  if (e.key === "Enter" && !q.multiSelect && canAct) {
                    e.preventDefault();
                    submit(qi, opts(qi)[oi]?.label);
                  }
                }}
                className={cn("flex items-start gap-2 rounded-md border px-2 py-1.5 text-left transition-colors",
                  "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50",
                  isSel(qi, oi) ? "border-sky-500/70 bg-sky-500/20" : "border-border bg-background hover:bg-accent/50")}>
                {/* 单选圆点 / 多选方点：选中实心打勾 */}
                <span className={cn("mt-0.5 flex h-3.5 w-3.5 shrink-0 items-center justify-center border",
                  q.multiSelect ? "rounded-[3px]" : "rounded-full",
                  isSel(qi, oi) ? "border-sky-500 bg-sky-500 text-white" : "border-muted-foreground/50")}>
                  {isSel(qi, oi) && <Check className="h-2.5 w-2.5" />}
                </span>
                <span className="min-w-0">
                  <span className="block text-xs font-medium leading-snug text-foreground/90">{o.label}</span>
                  {o.description && <span className="block text-[0.6875rem] leading-snug text-muted-foreground">{o.description}</span>}
                </span>
              </button>
              );
            })}
          </div>
          {/* "其他"自由输入（TUI Other 同款）：单选填入即覆盖选项选择；多选与勾选并存 */}
          <input
            className="mt-1 w-full rounded-md border border-border bg-background px-2 py-1 text-xs outline-none placeholder:text-muted-foreground/60 focus:border-sky-500/60 disabled:opacity-50"
            placeholder="或填写自定义答案（其他）…"
            disabled={!canAct}
            value={other[qi] ?? ""}
            onChange={(e) => {
              setOther((o) => ({ ...o, [qi]: e.target.value }));
              if (!b.questions[qi].multiSelect && e.target.value) setSel((v) => ({ ...v, [qi]: "" }));
            }}
            onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); if (canAct) submit(); } }} />
        </div>
      );
      })}
      <div className="mt-2 flex items-center gap-2">
        <Button size="sm" type="button" disabled={!canAct} onClick={() => submit()}>提交回答</Button>
        <Button size="sm" type="button" variant="outline" disabled={!canAct} onClick={() => onSkip(b.rid)}>跳过</Button>
        <span className="ml-auto shrink-0 text-[0.625rem] text-muted-foreground/70">↑↓ 移动 · 空格/点击 勾选 · Enter 提交 · Esc 跳过</span>
      </div>
    </div>
  );
}

function BlockView({ b, canAct, onRespond, onFormRespond, onFormSkip }: {
  b: UIBlock;
  canAct: boolean;
  onRespond: (rid: string, allow: boolean) => void;
  onFormRespond: (rid: string, answers: Record<string, string | string[]>, summary: string) => void;
  onFormSkip: (rid: string) => void;
}) {
  // AskUserQuestion 的 tool 块不渲染（表单卡片代表之——同一次调用两处出现会双份展示）
  if (b.k === "tool" && b.name === "AskUserQuestion") return null;
  if (b.k === "user")
    return (
      <Message from="user" className="ml-0 justify-start">
        <div className="group/msg relative">
          <MessageContent className="rounded-lg border border-primary/30 bg-primary/10 px-3 py-2 whitespace-pre-wrap break-words">
            {stripCmdTags(b.text)}
            {!!b.imgs && <span className="ml-1.5 shrink-0 align-middle text-[0.625rem] text-muted-foreground" title={`${b.imgs} 张图片`}>📎{b.imgs}</span>}
          </MessageContent>
          <CopyBtn text={stripCmdTags(b.text)} />
        </div>
      </Message>
    );
  if (b.k === "text")
    return (
      <Message from="assistant" className={cn("justify-start", b.sub && "pl-6 opacity-75")}>
        <div className="group/msg relative w-full">
          <MessageContent>
            <MessageResponse>{stripCmdTags(b.text)}</MessageResponse>
            {b.live && <span className="animate-pulse text-muted-foreground">▍</span>}
          </MessageContent>
          <CopyBtn text={stripCmdTags(b.text)} />
        </div>
      </Message>
    );
  if (b.k === "think") return <div className={b.sub ? "pl-6 opacity-75" : undefined}><ThinkBlock b={b} /></div>;
  if (b.k === "ask") return <AskBlock b={b} canAct={canAct} onRespond={onRespond} />;
  if (b.k === "form") return <FormBlock b={b} canAct={canAct} onRespond={onFormRespond} onSkip={onFormSkip} />;
  if (b.k === "tool") {
    let parsed: any = b.inputJson;
    try { parsed = JSON.parse(b.inputJson || "{}"); } catch {}
    return (
      <Tool className={cn("my-1 w-full", b.sub && "ml-6 opacity-80")}>
        <ToolHeader state={toolState(b) as any} type={`tool-${b.name}`} title={toolLabel(b.name)} />
        <ToolContent>
          <ToolInput input={parsed} />
          {b.result !== undefined && <ToolOutput output={b.result.slice(0, 4000)} />}
        </ToolContent>
      </Tool>
    );
  }
  return <div className="my-1 text-center text-xs text-amber-500/80">⏹ {b.text}</div>;
}

export default function ChatPanel({
  session, historyEvents, histGroups, onResume, onNewSession, onOpenHistory, onRefreshHistory,
  root, models, home, treeOpen, onToggleTree, onSwitchRoot, chatInset = 0,
  initialEvents, pendingText, initModel,
  engines, enginePref, onEnginePref,
}: {
  session?: { id: string; cwd: string; claudeSid?: string | null; engine?: string | null };
  historyEvents?: { id: string; cwd: string; events: any[]; resumeSid?: string | null };
  initialEvents?: any[];
  pendingText?: string;
  initModel?: string;
  histGroups?: any[];
  onResume?: (text: string) => void;
  onNewSession?: () => void;
  onOpenHistory?: (id: string, cwd: string) => void;
  onRefreshHistory?: () => void;
  root?: string;
  models?: string[];
  engines?: { id: string; label: string }[]; // 可用引擎（后端 /api/env；qtom 配置 --dsweb 后出现）
  enginePref?: string; // 下次新会话引擎（localStorage 记忆）
  onEnginePref?: (id: string) => void;
  home?: string; // 环境 HOME（标题栏 cwd 显示 ~/ 相对路径用）
  treeOpen?: boolean; // 目录树浮层开合（chip 高亮反馈）
  onToggleTree?: () => void; // cwd chip 点击 = 开/关目录树浮层
  onSwitchRoot?: (p: string) => void; // 换工作目录（历史下拉/DirPicker 选定共用，App.setWorkspace）
  chatInset?: number; // 浮层组总宽：内容列/输入框在剩余可见区居中（0 = 无浮层，屏幕居中）
}) {
  const live = !!session;
  // qtom 引擎（自家 Rust 猫）：无模型切换/权限模式/图片/TUI-resume（`claude --resume` 对它无意义）
  const isQtom = session?.engine === "qtom";
  const sid = session?.id ?? historyEvents?.id ?? "";
  const cwd = session?.cwd ?? historyEvents?.cwd ?? "";
  const [tuiCopied, setTuiCopied] = useState(false);
  // 新会话连接早于首条消息时 App 拿不到 claude_sid——init 事件到达时本地补记（TUI 续跑按钮用）
  const [initSid, setInitSid] = useState<string | null>(null);
  // env 模型清单 → ctx 窗口提示（带 [1m] 的归一名；历史恢复无 modelUsage 时兜底 1M）
  useEffect(() => {
    ctxWinHints.clear();
    for (const m of models ?? []) if (/\[1m\]$/i.test(m)) ctxWinHints.add(normModel(m));
  }, [models]);
  // 模式/模型弹出菜单（锚定输入框左下）
  const [menu, setMenu] = useState<null | "mode" | "model">(null);
  const [modelInput, setModelInput] = useState("");
  // 标题栏左上三件套的弹出层：▾ 历史工作目录 / 换目录选择器（互斥，同时只开一个）
  const [hdrMenu, setHdrMenu] = useState<null | "recents" | "picker">(null);
  const recents = (() => {
    try { return JSON.parse(localStorage.getItem("qweb.recents") || "[]") as string[]; } catch { return []; }
  })();
  // cwd 显示：POSIX home 子树内 ~/ 相对；win（home 为盘符形态）直接绝对路径——用户不识 ~，
  // 且按 OS 分隔符显示（fs API 正斜杠 → win 渲染成 \，dispPath；POSIX 原样）
  const relPath = (p: string) =>
    /^[A-Za-z]:\//.test(home || "") ? dispPath(p)
      : home && p === home ? "~" : home && p.startsWith(home + "/") ? "~" + p.slice(home.length) : p;
  // 历史浮层：锚定按钮位置向上展开（记录按钮相对面板的坐标）
  const [view, setView] = useState<"chat" | "history">("chat");
  const [histPos, setHistPos] = useState<{ left: number; bottom: number } | null>(null);
  const hostRef = useRef<HTMLDivElement>(null);
  const histBtnRef = useRef<HTMLButtonElement>(null);
  // 历史严格跟随工作目录（root，标题栏三件套唯一设定）——不跟会话 cwd 走
  // （resume 别的目录的会话时面板 cwd 会偏离 root，历史浮层仍按工作目录显示）
  const cwdGroups = (histGroups ?? []).filter((g: any) => g.cwd === root);
  const toggleHistory = () => {
    if (view === "history") { setView("chat"); setHistPos(null); return; }
    const hb = histBtnRef.current, host = hostRef.current;
    if (hb && host) {
      const r = hb.getBoundingClientRect(), h = host.getBoundingClientRect();
      setHistPos({ left: Math.max(4, r.left - h.left), bottom: h.bottom - r.top + 4 });
    }
    onRefreshHistory?.(); // 打开即拉新：正在聊的会话 transcript 实时在长，旧快照里看不到它
    setView("history");
  };
  // 点空白关闭历史浮层（浮层自身 stopPropagation 防误关）
  useEffect(() => {
    if (view !== "history") return;
    const h = () => { setView("chat"); setHistPos(null); };
    window.addEventListener("mousedown", h);
    return () => window.removeEventListener("mousedown", h);
  }, [view]);
  // initModel：transcript 最后一次 assistant 的模型——resume/历史态下 init 事件还没来时先顶上
  const [s, dispatch] = useReducer(ccReducer, { blocks: [], busy: false, alive: live, connected: live, model: initModel ?? "", permMode: "default", slashCmds: [], thinkTokens: 0 });
  // ctx% 渲染时派生、不进 state 定格：分母窗口是渐进到达的（live/合成 result 的
  // modelUsage→localStorage、env 模型清单 hints 都可能晚于首个 result），state 里
  // 算好存住会在早到的 result 上拿 200k 兜底算错（1M 会话虚高 5 倍）且永不更新。
  // 官方口径（statusline 文档）：分子三项之和不含 output，分母完整 context window
  const ctxPct = s.ctxAbs == null ? null
    : Math.min(100, Math.round((s.ctxAbs / ctxWindowOf(s.model || "")) * 100));

  // ---- 滚动三件套：尾部优先渲染 / 上翻加载更早 / 后台跟随 ----
  // 1) 先只渲染最近 N 条（历史回放/重连大缓冲挂载即落底，无整屏扫过）
  // 2) 用户上翻后冻结起始下标（floor）：流式新增不推走正在读的窗口；回到底部自动解冻
  const [histWin, setHistWin] = useState<{ limit: number; floor: number | null }>({ limit: 40, floor: null });
  const histStart = histWin.floor ?? Math.max(0, s.blocks.length - histWin.limit);
  const histStartRef = useRef(histStart);
  histStartRef.current = histStart; // 滚动监听单次注册，经 ref 读最新值
  const stickCtx = useRef<StickToBottomContext | null>(null);
  // 跟随兜底：处于贴底态时任何内容变化（新块/流式增量/工具结果爆发）同步落底——
  // 不依赖库的 resize 跟随（工具大爆发场景偶发停止跟随）
  const followRef = useRef(true);
  // 滚动监听必须挂库的内层滚动元素（Content 的 scrollRef；scroll 事件不冒泡，
  // 外层容器上的 onScroll 收不到）。贴底解冻 / 触顶加载更早；
  // 加载后视口稳定交给浏览器原生滚动锚定（overflow-anchor 未被禁用，勿手动补偿——会双重调整）
  useEffect(() => {
    const el = stickCtx.current?.scrollRef.current;
    if (!el) return;
    const h = () => {
      followRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 48; // 跟随态供贴底兜底
      if (el.scrollHeight - el.scrollTop - el.clientHeight < 48) {
        // 贴底：解冻回跟随窗口（尾部 40 条 + 滚动跟随）
        setHistWin((w) => (w.floor === null ? w : { ...w, floor: null }));
      } else if (el.scrollTop < 120 && histStartRef.current > 0) {
        // 触顶：向上补一页（40 条）
        setHistWin((w) => w.floor !== null
          ? { ...w, floor: Math.max(0, w.floor - 40) }
          : { ...w, limit: w.limit + 40 });
      } else {
        // 一离底就冻结窗口起点：流式新增不再推走正在读的内容
        // （否则 busy 中窗口随新消息前滑，向上翻永远追不到顶）；回底自动解冻
        setHistWin((w) => (w.floor === null && histStartRef.current > 0
          ? { ...w, floor: histStartRef.current }
          : w));
      }
    };
    el.addEventListener("scroll", h, { passive: true });
    // 兜底：已钉在顶端时滚轮不再产生 scroll 事件（scrollTop 无法变化），wheel 上翻直接触发补页
    const onWheel = (we: WheelEvent) => {
      if (we.deltaY < 0 && el.scrollTop < 120 && histStartRef.current > 0) h();
    };
    el.addEventListener("wheel", onWheel, { passive: true });
    return () => { el.removeEventListener("scroll", h); el.removeEventListener("wheel", onWheel); };
  }, []);
  // 贴底兜底本体：blocks 一变（流式 delta/新块）且跟随态 → 绘制前同步落底
  useLayoutEffect(() => {
    const el = stickCtx.current?.scrollRef.current;
    if (el && followRef.current) el.scrollTop = el.scrollHeight;
  }, [s.blocks]);
  // 异步高度变化兜底：代码块语法高亮/图片加载等晚一拍撑高（不经 blocks state），
  // ResizeObserver 盯内容元素——跟随态下任何来源的增高都落底
  useEffect(() => {
    const ctx = stickCtx.current;
    const sc = ctx?.scrollRef.current;
    const ce = ctx?.contentRef.current;
    if (!sc || !ce) return;
    const ro = new ResizeObserver(() => { if (followRef.current) sc.scrollTop = sc.scrollHeight; });
    ro.observe(ce);
    return () => ro.disconnect();
  }, []);
  // 发送即贴底：解冻历史窗口 + 瞬时落底（上翻阅读中发送，新消息在视口外就看不到回复）
  const jumpToBottom = useCallback(() => {
    setHistWin((w) => (w.floor === null ? w : { ...w, floor: null }));
    stickCtx.current?.scrollToBottom("instant");
  }, []);
  // 3) 后台跟随：tab 隐藏时 rAF 暂停、跟随积压；切回可见的一瞬直接落底（先于绘制，无滚动动画）
  useEffect(() => {
    const h = () => {
      if (document.visibilityState !== "visible") return;
      const ctx = stickCtx.current;
      if (ctx?.isAtBottom) {
        const el = ctx.scrollRef.current;
        if (el) el.scrollTop = el.scrollHeight;
      }
    };
    document.addEventListener("visibilitychange", h);
    return () => document.removeEventListener("visibilitychange", h);
  }, []);
  const wsRef = useRef<WebSocket | null>(null);
  const [input, setInput] = useState("");
  // 输入框高度：null=自动（field-sizing 随内容长高，上限 50vh）；拖分割条后=固定高（内容超出内部滚动），
  // 双击分割条回自动。拖拽只记起点+起高，pointermove 里算差值。
  const [inputH, setInputH] = useState<number | null>(null);
  const inputDrag = useRef<{ y: number; h: number } | null>(null);
  // 插话队列：busy 时发送不进消息流、不写 stdin——钉在输入框上方，
  // 轮末（result 到达）自动整队送出，或用户 ↑ 立即送出 / ✕ 删除。
  // 按会话持久化（localStorage）：刷新/重开标签不丢——轮还没结束恢复后接着等 result；
  // 轮已结束则重连回放里的 result 直接触发送出（对"轮末送出"的承诺诚实）。
  // 未送达的消息只存在于此（CLI 无感知），不跨端同步。
  interface SteerItem { id: number; text: string; urls: string[] }
  const steerSeq = useRef(0);
  const steerKey = session ? `qweb.steer.${session.claudeSid ?? session.id}` : null;
  const [steerQ, setSteerQ] = useState<SteerItem[]>(() => {
    if (!steerKey) return [];
    try {
      const saved = JSON.parse(localStorage.getItem(steerKey) || "[]");
      if (!Array.isArray(saved) || !saved.length) return [];
      const items = saved.map((x: any, i: number) =>
        ({ id: i + 1, text: String(x.text ?? ""), urls: Array.isArray(x.urls) ? x.urls : [] }));
      steerSeq.current = items.length;
      return items;
    } catch { return []; }
  });
  // 队列变化即落盘（空=清键）；图片 dataURL 可能撑爆配额——退化重写为纯文本
  useEffect(() => {
    if (!steerKey) return;
    try {
      if (!steerQ.length) { localStorage.removeItem(steerKey); return; }
      const plain = steerQ.map(({ text, urls }) => ({ text, urls }));
      try { localStorage.setItem(steerKey, JSON.stringify(plain)); }
      catch {
        localStorage.setItem(steerKey, JSON.stringify(steerQ.map(({ text }) => ({ text, urls: [] }))));
      }
    } catch {}
  }, [steerQ, steerKey]);
  const steerQRef = useRef(steerQ);
  steerQRef.current = steerQ;
  // 输入历史召回：光标在首位按 ↑ 取上一条（bash 同款）；↓ 在末尾前进，越界还原草稿。
  // localStorage 持久化：刷新后 ↑ 仍能召回（含已排队未送的插话）
  const inputHist = useRef<string[]>((() => {
    try {
      const a = JSON.parse(localStorage.getItem("qweb.inputhist") || "[]");
      return Array.isArray(a) ? a.filter((x: any) => typeof x === "string").slice(-100) : [];
    } catch { return []; }
  })());
  const histNavIdx = useRef(-1);
  const histDraft = useRef("");
  // 待发图片（data URL；后端解析 data: 前缀转 base64 块）。本地添加入口已下线
  // （附件按钮移除，上传走目录树 / @ 引用），仅保留 WS images 协议位以兼容后端
  const [imgs, setImgs] = useState<{ url: string; name: string }[]>([]);
  // ctrl 请求在途中（set_model 需后端连代理校验，数秒）：chip 上转圈，control_response 到达即清
  const [ctrlPend, setCtrlPend] = useState<null | "mode" | "model">(null);
  useEffect(() => {
    if (!ctrlPend) return;
    const t = window.setTimeout(() => setCtrlPend(null), 20_000); // 兜底：回包丢失不再永久转圈
    return () => clearTimeout(t);
  }, [ctrlPend]);

  useEffect(() => {
    // replay 动作自带"已有内容跳过"守卫：历史→resume 原地升级（sid 变、面板不重挂）
    // 时这些事件已渲染过，不能再注一遍
    if (initialEvents?.length) dispatch({ t: "replay", events: initialEvents });
    if (session) {
      // 断线自动重连（server 重启/网络抖动后免刷新恢复；重连即回放 buf 补齐错过的事件）。
      // 进程退出（exit 事件）后停止重试——重连也无济于事，需新建会话。
      let dead = false, retry = 0, sentPending = false;
      const connect = () => {
        if (dead) return;
        const ws = new WebSocket(`${location.protocol === "https:" ? "wss" : "ws"}://${location.host}${BASE}/ws/${session.id}`);
        wsRef.current = ws;
        ws.onopen = () => {
          retry = 0;
          dispatch({ t: "connected", v: true });
          if (!sentPending && pendingText) {
            sentPending = true;
            ws.send(JSON.stringify({ t: "user", text: pendingText }));
            dispatch({ t: "user", text: pendingText });
          }
        };
        ws.onclose = () => {
          if (dead) return;
          dispatch({ t: "connected", v: false });
          retry++;
          setTimeout(connect, Math.min(8000, 400 * 2 ** Math.min(retry, 4)));
        };
        ws.onmessage = (m) => {
          const msg = JSON.parse(m.data);
          if (msg.t === "cc") {
            if (msg.ev?.type === "system" && msg.ev?.subtype === "init" && msg.ev?.session_id) setInitSid(msg.ev.session_id);
            if (msg.ev?.type === "control_response") {
              setCtrlPend(null); // 回包到达，停转圈
              // 模式切换成功的显式反馈（实测 control_response 回显 mode + status 广播双确认，
              // 链路本身是通的；无此 toast 时只有胶囊换字，"不知有没有生效"）
              const mode = msg.ev.response?.response?.mode;
              if (typeof mode === "string" && MODES.some((m) => m.id === mode))
                toast.success(`权限模式已切换：${MODES.find((m) => m.id === mode)!.label}`);
            }
            // 轮末送出插话队列（CLI 对轮后新消息照常处理；本地块与 CLI 回显去重见 reducer）
            if (msg.ev?.type === "result" && steerQRef.current.length && ws.readyState === 1) {
              for (const it of steerQRef.current) {
                ws.send(JSON.stringify({ t: "user", text: it.text, images: it.urls }));
                dispatch({ t: "user", text: it.text, ...(it.urls.length ? { imgs: it.urls.length } : {}) });
              }
              setSteerQ([]);
            }
            dispatch({ t: "cc", ev: msg.ev });
          }
          else if (msg.t === "pre" && msg.events?.length) {
            // 恢复前历史（resume 会话 buf 只含恢复后事件）：replay 动作的"已有内容跳过"
            // 守卫会与挂载时注入的 transcript initialEvents 自动去重
            dispatch({ t: "replay", events: msg.events });
          }
          else if (msg.t === "exit") { dead = true; dispatch({ t: "exit" }); }
        };
      };
      connect();
      return () => { dead = true; wsRef.current?.close(); };
    }
    if (historyEvents?.events.length) dispatch({ t: "replay", events: historyEvents.events });
  }, [sid]); // pendingText 每个 sid 只消费一次（原地升级时随 effect 重跑再发）

  const send = useCallback(({ text }: { text: string }) => {
    if (!text.trim() && imgs.length === 0) return;
    // 历史回放态：先恢复进程（--resume），App 升级为 live 后再发
    if (!live) { onResume?.(text); return; }
    if (!s.alive) { dispatch({ t: "note", text: "进程已退出，请新建会话" }); return; }
    if (!s.connected) { dispatch({ t: "note", text: "连接断开（自动重连中），稍候再发" }); return; }
    const t = text.trim();
    // 输入历史入列（↑ 召回用）：连续重复只记一次；落盘（刷新后仍可召回）
    const h = inputHist.current;
    if (t && h[h.length - 1] !== t) {
      h.push(t);
      if (h.length > 100) h.shift();
      try { localStorage.setItem("qweb.inputhist", JSON.stringify(h)); } catch {}
    }
    histNavIdx.current = -1;
    const urls = imgs.map((i) => i.url);
    // busy 中 = 插话：钉在输入框上方排队（轮末自动送出），不进消息流
    if (s.busy) {
      setSteerQ((q) => [...q, { id: ++steerSeq.current, text: t || "（图片）", urls }]);
      setInput("");
      setImgs([]);
      jumpToBottom();
      return;
    }
    wsRef.current?.send(JSON.stringify({ t: "user", text: t, images: urls }));
    jumpToBottom();
    dispatch({ t: "user", text: t || "（图片）", ...(urls.length ? { imgs: urls.length } : {}) });
    setInput("");
    setImgs([]);
  }, [s.connected, s.alive, s.busy, imgs]);

  // 撤回排队消息回输入框：多条撤回按提交顺序排（早的上面、晚的下面）。
  // 已撤回的文本段用 withdrawnRef 跟踪；若草稿末尾仍是"上次撤回块"整体，则剥掉重排
  // （乱序点撤回也能还原提交顺序），用户改过草稿则退化为普通追加
  const withdrawnRef = useRef<Map<number, string>>(new Map());
  const withdrawSteer = useCallback((it: { id: number; text: string }) => {
    const cur = (document.querySelector("textarea[name='message']") as HTMLTextAreaElement | null)?.value ?? "";
    const sorted = (m: Map<number, string>) => [...m.entries()].sort((a, b) => a[0] - b[0]).map(([, t]) => t);
    const prevBlock = sorted(withdrawnRef.current).join("\n");
    withdrawnRef.current.set(it.id, it.text);
    let base = cur;
    if (prevBlock && cur.endsWith(prevBlock)) base = cur.slice(0, -prevBlock.length).replace(/\n$/, "");
    const all = sorted(withdrawnRef.current);
    writeTa(base ? base + "\n" + all.join("\n") : all.join("\n"), "end");
    setSteerQ((q) => q.filter((x) => x.id !== it.id));
  }, []);
  useEffect(() => { if (!steerQ.length) withdrawnRef.current.clear(); }, [steerQ.length]);

  // 队列单条"立即送出"：写 stdin（CLI 排队）+ 本地上屏（用户主动送上去）
  const sendSteerNow = useCallback((id: number) => {
    const it = steerQRef.current.find((x) => x.id === id);
    if (!it) return;
    if (wsRef.current?.readyState !== 1) { dispatch({ t: "note", text: "连接未就绪，稍后再送" }); return; }
    wsRef.current.send(JSON.stringify({ t: "user", text: it.text, images: it.urls }));
    dispatch({ t: "user", text: it.text, ...(it.urls.length ? { imgs: it.urls.length } : {}) });
    setSteerQ((q) => q.filter((x) => x.id !== id));
    jumpToBottom();
  }, [jumpToBottom]);

  // 审批裁决：WS 下发 + 本地落账（重复/迟到回包 CLI 侧自会忽略）
  const respondPerm = useCallback((rid: string, allow: boolean) => {
    if (wsRef.current?.readyState === 1) wsRef.current.send(JSON.stringify({ t: "perm", rid, allow }));
    else dispatch({ t: "note", text: "连接未就绪，决定未送达" });
    dispatch({ t: "perm", rid, allow });
  }, []);

  // AskUserQuestion 表单提交/跳过：WS perm 帧带 answers（后端注 updatedInput.answers 回
  // CLI，协议实测）+ 本地塌缩成摘要行。跳过带空 answers：后端借此区分表单（deny 文案
  // 用 CLI 官方的 declined to answer，模型能正确理解改问）
  const respondForm = useCallback((rid: string, answers: Record<string, string | string[]>, summary: string) => {
    if (wsRef.current?.readyState === 1) wsRef.current.send(JSON.stringify({ t: "perm", rid, allow: true, answers }));
    else dispatch({ t: "note", text: "连接未就绪，回答未送达" });
    dispatch({ t: "formAns", rid, summary, answers });
  }, []);
  const skipForm = useCallback((rid: string) => {
    if (wsRef.current?.readyState === 1) wsRef.current.send(JSON.stringify({ t: "perm", rid, allow: false, answers: {} }));
    else dispatch({ t: "note", text: "连接未就绪，跳过未送达" });
    dispatch({ t: "formAns", rid, summary: "已跳过" });
  }, []);

  // control_request 通道（set_permission_mode / set_model / …）；未连接时显式提示而非静默丢弃
  const sendCtrl = useCallback((sub: string, args: Record<string, unknown> = {}) => {
    if (wsRef.current?.readyState === 1) wsRef.current.send(JSON.stringify({ t: "ctrl", sub, args }));
    else dispatch({ t: "note", text: "连接未就绪（自动重连中），操作未发送" });
  }, []);

  // 可选模型：优先后端下发（从 claude settings 推导），带自记忆的最近使用
  const presets = useMemo(
    () => (models?.length ? models : MODEL_PRESETS),
    [models],
  );
  // 切换模型：default 显式传 null（CLI 语义=回退会话默认）；自定义模型名记入最近使用。
  // CLI 对 set_model 只回光杆 success（不回显模型名、不预校验非法值，实测）——
  // 乐观显示所请求的名字 + toast 确认提交，下一轮 message_start 携真名校准
  const applyModel = useCallback((m: string) => {
    const v = m.trim();
    if (!v) return;
    sendCtrl("set_model", { model: v === "default" ? null : v });
    setCtrlPend("model");
    if (v !== "default") dispatch({ t: "model", v });
    toast.info(`模型切换已提交：${v}`, { description: v === "default" ? "回会话默认模型，下一轮对话生效" : "下一轮对话生效；非法模型名将在请求时报错" });
    if (!presets.includes(v)) {
      try {
        const rec = [v, ...JSON.parse(localStorage.getItem("qweb.models") || "[]").filter((x: string) => x !== v)].slice(0, 6);
        localStorage.setItem("qweb.models", JSON.stringify(rec));
      } catch {}
    }
    setMenu(null);
    setModelInput("");
  }, [sendCtrl, presets]);

  const interrupt = useCallback(() => {
    // 不看 busy：刷新后本地 busy 重置为 false，但进程可能仍在生成（跨页/别的 tab 发起），
    // 按 busy 拦会把 ESC 变成静默无效；空闲时发 interrupt 也无害（CLI 回 success）
    if (wsRef.current?.readyState === 1) {
      wsRef.current.send(JSON.stringify({ t: "interrupt" }));
      dispatch({ t: "note", text: "已打断 (ESC)" });
    }
  }, []);

  // 程序化写输入框（联想补全/撤回/历史召回共用）：setInput 驱动受控 value（React 重渲染），
  // setTaValue 即时写 DOM + 定光标。两轨并行——派发 input 事件进不了 React onChange，
  // 只写 DOM 的话镜像态（联想过滤等）不跟随
  const writeTa = (v: string, caret: number | "end" = "end") => { setInput(v); setTaValue(v, caret); };

  // ---- 斜杠命令联想：输入 / 前缀（未带空格/参数）即弹出 ----
  const [slashIdx, setSlashIdx] = useState(0);
  const [slashOff, setSlashOff] = useState(false); // Esc 关闭后不再弹，直到输入变化
  const slashOpenRef = useRef(false); // 供 window 捕获阶段的 ESC 监听读取（先关联想再打断）
  const slashList = useMemo(() => {
    const m = /^\/([a-zA-Z0-9_-]*)$/.exec(input.trim());
    if (!m || !s.slashCmds.length) return null; // 无真清单：不出列表（提示语见弹层）
    const pool = s.slashCmds.filter((c) => c.toLowerCase().startsWith(m[1].toLowerCase()));
    return pool.length ? pool : null; // 全量给（弹层内滚动，不再截 12 条）
  }, [input, s.slashCmds]);
  // 弹层可见：有命中列表，或"没有真清单"时的如实提示（输 /zzz 过滤无命中则不弹）
  const slashOpen = !slashOff && (!!slashList || (!s.slashCmds.length && !!/^\/[a-zA-Z0-9_-]*$/.test(input.trim())));
  slashOpenRef.current = slashOpen;
  const slashIdxC = Math.min(slashIdx, Math.max(0, (slashList?.length ?? 1) - 1));
  const onInput = (v: string) => { setInput(v); setSlashOff(false); setSlashIdx(0); setAtOff(false); setAtIdx(0); };
  const pickSlash = (c: string) => { writeTa("/" + c + " "); setSlashOff(false); };

  // ---- @ 文件引用联想：行首/空白后输入 @（可 dir/ 逐级下钻）弹出工作目录内条目 ----
  // 图片上传入口已移除（目录树支持上传）；引用文件用 @ 联想补全相对路径，模型按 cwd 解析
  const [atIdx, setAtIdx] = useState(0);
  const [atOff, setAtOff] = useState(false); // Esc 关闭后不再弹，直到输入变化
  const atOpenRef = useRef(false); // ESC 守卫同 slashOpenRef（先关联想再打断）
  const atToken = useMemo(() => {
    const m = /(?:^|\s)@([^\s@]*)$/.exec(input);
    return m ? m[1] : null; // 如 "src/ap"（dir 前缀 + 过滤词）
  }, [input]);
  const atQuery = useMemo(() => {
    if (atToken == null) return null;
    const i = atToken.lastIndexOf("/");
    return { dir: i < 0 ? "" : atToken.slice(0, i + 1), q: i < 0 ? atToken : atToken.slice(i + 1) };
  }, [atToken]);
  const [atDir, setAtDir] = useState<{ dir: string; dirs: string[]; files: string[] } | null>(null);
  useEffect(() => {
    if (atToken == null || atOff) { setAtDir(null); return; }
    const rel = atQuery?.dir ?? "";
    const full = rel ? (root || "/").replace(/\/+$/, "") + "/" + rel.replace(/^\/+|\/+$/g, "") : root || "/";
    let dead = false;
    fetch(`${API}/fs?path=${encodeURIComponent(full)}`)
      .then((r) => r.json())
      .then((d: any) => { if (!dead && Array.isArray(d.dirs)) setAtDir({ dir: rel, dirs: d.dirs, files: (d.files ?? []).map((f: any) => f.name) }); })
      .catch(() => {});
    return () => { dead = true; };
    // 只随下钻目录重新拉取；过滤词纯本地筛
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [atToken == null || atOff ? null : atQuery?.dir, root]);
  const atList = useMemo(() => {
    if (atToken == null || atOff || !atDir) return null;
    const q = (atQuery?.q ?? "").toLowerCase();
    const items = [
      ...atDir.dirs.filter((n) => n.toLowerCase().includes(q)).map((n) => ({ n, dir: true })),
      ...atDir.files.filter((n) => n.toLowerCase().includes(q)).map((n) => ({ n, dir: false })),
    ];
    return items.length ? items.slice(0, 14) : null;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [atToken, atOff, atDir, atQuery?.q]);
  const atOpen = !!atList;
  atOpenRef.current = atOpen;
  const atIdxC = Math.min(atIdx, Math.max(0, (atList?.length ?? 1) - 1));
  const pickAt = (item: { n: string; dir: boolean }) => {
    if (atToken == null) return;
    // 末尾 @token 整体替换；目录补 "dir/" 继续下钻（联想不关），文件补 "path " 收尾（token 破坏即自然关闭）
    const base = input.replace(/@[^\s@]*$/, "");
    writeTa(base + "@" + (atQuery?.dir ?? "") + item.n + (item.dir ? "/" : " "));
    setAtIdx(0);
  };

  useEffect(() => {
    // globalThis 显式取 DOM 版（文件顶部 import 了 React 的 KeyboardEvent）
    const h = (e: globalThis.KeyboardEvent) => {
      if (e.key !== "Escape") return;
      // 联想浮层（斜杠 / @）开着时 ESC 只关浮层（textarea 的 onKeyDown 负责），不打断会话
      if (slashOpenRef.current || atOpenRef.current) return;
      // 表单卡片挂着且焦点在卡内：Esc 只作"跳过回答"（卡片 onKeyDown 处理），不打断会话
      const pf = document.querySelector("[data-form='pending']");
      if (pf && pf.contains(document.activeElement)) return;
      // Dialog 浮窗（思考全文等）开着时 ESC 只关浮窗：不拦默认行为，交给 radix；
      // 这里 preventDefault 会挡掉 radix 的关闭逻辑
      if (document.querySelector("[role='dialog']")) return;
      e.preventDefault();
      interrupt();
    };
    window.addEventListener("keydown", h, true);
    return () => window.removeEventListener("keydown", h, true);
  }, [interrupt]);

  // 菜单开着点空白关闭（浮层自身 stopPropagation 防误关）
  useEffect(() => {
    if (!menu) return;
    const h = () => setMenu(null);
    window.addEventListener("mousedown", h);
    return () => window.removeEventListener("mousedown", h);
  }, [menu]);

  // 标题栏弹出层（▾ 历史 / 换目录）：点空白关闭。Esc 关闭走各自组件的 keydown
  //（recents 面板同样带 role="dialog"——ChatPanel 全局 Esc 处理器见此即放行）
  useEffect(() => {
    if (!hdrMenu) return;
    const h = () => setHdrMenu(null);
    window.addEventListener("mousedown", h);
    return () => window.removeEventListener("mousedown", h);
  }, [hdrMenu]);


  // 会话标题：首句用户提问前 20 字（与 resume/历史列表同源），占位把消息列表往下压
  const firstUser: any = s.blocks.find((b: any) => b.k === "user");
  const title = firstUser
    ? String(firstUser.text).replace(/\s+/g, " ").trim().slice(0, 20)
    : live ? "新会话" : "（空会话）";

  // 终端续跑命令：TUI 的 resume 列表不收 SDK/stream-json 会话（无 ai-title 索引），
  // cd 到工作目录 + 官方 sid 直连是唯一入口；一键复制给"qweb 功能不全时切 TUI 继续"
  const claudeSid = session?.claudeSid ?? initSid ?? historyEvents?.resumeSid;
  // 新会话 init 到达才有官方 sid——此刻补写 URL 锚点（App 侧只在已知 sid 的路径写）
  useEffect(() => { if (claudeSid) setHashSid(claudeSid); }, [claudeSid]);
  // win 终端用引号+分号：PowerShell 5.1 不认 &&（cmd/Git Bash 对含空格路径也要引号）
  const tuiCmd = !isQtom && claudeSid && cwd
    ? /^[A-Za-z]:\//.test(cwd)
      ? `cd "${cwd}"; claude --resume ${claudeSid}`
      : `cd ${cwd} && claude --resume ${claudeSid}`
    : "";

  return (
    <div ref={hostRef} className="relative flex h-full flex-col">
      {/* 全局标题栏（chat-first：本面板头部横贯全宽；左上三件套，标题居中，无关闭 X——对话不可关） */}
      <div className="flex h-8 shrink-0 items-center justify-center border-b border-border/40 bg-card/40 px-10">
        {/* 三件套：cwd chip（点击开关目录树浮层）/ ▾ 历史工作目录 / 换目录选择器。
            按钮 mousedown stopPropagation：弹出层开着时点按钮本身不触发"点空白关闭"再被 onClick 重开 */}
        <div className="absolute left-2 flex items-center gap-0.5">
          <button
            className={cn("flex min-w-0 max-w-[30vw] items-center gap-1 rounded px-1.5 py-0.5 font-mono text-[0.625rem] transition-colors hover:bg-accent",
              treeOpen ? "bg-accent text-accent-foreground" : "text-muted-foreground")}
            title={`工作目录：${dispPath(root || home || "—")}（点击${treeOpen ? "收起" : "展开"}目录树）`}
            onMouseDown={(e) => e.stopPropagation()}
            onClick={() => { setHdrMenu(null); onToggleTree?.(); }}>
            <FolderOpen className="h-3 w-3 shrink-0" />
            <span className="truncate">{root ? relPath(root) : home ? relPath(home) : "…"}</span>
          </button>
          <button
            className={cn("rounded p-0.5 text-muted-foreground hover:bg-accent hover:text-foreground",
              hdrMenu === "recents" && "bg-accent text-accent-foreground")}
            title="历史工作目录（快速切换）"
            onMouseDown={(e) => e.stopPropagation()}
            onClick={() => setHdrMenu((v) => (v === "recents" ? null : "recents"))}>
            <ChevronDown className="h-3 w-3" />
          </button>
          <button
            className={cn("ml-0.5 flex items-center gap-1 rounded px-1 py-0.5 text-[0.625rem] text-muted-foreground hover:bg-accent hover:text-foreground",
              hdrMenu === "picker" && "bg-accent text-accent-foreground")}
            title="切换工作目录（选择器自由导航；切换 = 开新会话）"
            onMouseDown={(e) => e.stopPropagation()}
            onClick={() => setHdrMenu((v) => (v === "picker" ? null : "picker"))}>
            <FolderSync className="h-3 w-3" />切换工作目录
          </button>
        </div>
        {/* 标题 + 紧随其后的终端续跑复制按钮（整体居中） */}
        <span className="flex min-w-0 max-w-full items-center gap-1">
          <span className="min-w-0 truncate text-xs font-medium text-foreground/80" title={firstUser ? firstUser.text : title}>
            {title}
          </span>
          {tuiCmd && (
            <button
              className="shrink-0 rounded p-0.5 text-muted-foreground/60 hover:bg-accent hover:text-foreground"
              title={`复制终端续跑命令（在 TUI 里继续本会话）：${tuiCmd}`}
              onClick={async () => {
                setTuiCopied(await copyTextUtil(tuiCmd));
                setTimeout(() => setTuiCopied(false), 1500);
              }}>
              {tuiCopied ? <Check className="h-3 w-3 text-primary" /> : <Copy className="h-3 w-3" />}
            </button>
          )}
        </span>
      </div>
      {/* ▾ 历史工作目录（快速切换；当前目录打勾，点选即换 = 开新会话） */}
      {hdrMenu === "recents" && (
        <div role="dialog"
          className="absolute left-2 top-9 z-40 w-72 rounded-md border border-border bg-popover py-1 text-xs shadow-xl"
          onMouseDown={(e) => e.stopPropagation()}>
          <div className="px-3 py-1 text-[0.625rem] font-semibold uppercase tracking-wider text-muted-foreground">历史工作目录</div>
          {recents.length ? recents.map((p) => (
            <button key={p}
              className="flex w-full items-center gap-1.5 px-3 py-1.5 text-left hover:bg-accent/60"
              title={dispPath(p)}
              onClick={() => { setHdrMenu(null); if (p !== root) onSwitchRoot?.(p); }}>
              <FolderOpen className="h-3 w-3 shrink-0 opacity-60" />
              <span className="min-w-0 flex-1 truncate font-mono text-[0.6875rem]">{relPath(p)}</span>
              {p === root && <Check className="h-3 w-3 shrink-0 text-primary" />}
            </button>
          )) : (
            <p className="p-3 text-center text-muted-foreground/70">暂无历史（换过工作目录后记录于此）</p>
          )}
        </div>
      )}
      {/* 换目录选择器（DirPicker：面包屑自由导航 + ✓ 确认；选定 = setWorkspace = 开新会话 + 树扎根并展开） */}
      {hdrMenu === "picker" && (
        <div className="absolute left-2 top-9 z-40" onMouseDown={(e) => e.stopPropagation()}>
          <DirPicker home={home || ""} current={root || ""}
            onPick={(p) => { setHdrMenu(null); onSwitchRoot?.(p); }}
            onClose={() => setHdrMenu(null)} />
        </div>
      )}
      {/* 历史浮层：从历史按钮位置向上展开；只显示当前目录的会话；点空白/选择后关闭 */}
      {view === "history" && histPos && (
        <div
          className="absolute z-30 max-h-72 w-80 overflow-y-auto rounded-md border border-border bg-popover p-2 shadow-lg"
          style={{ left: histPos.left, bottom: histPos.bottom }}
          onMouseDown={(e) => e.stopPropagation()}>
          <div className="mb-1 flex items-center justify-between px-1 text-[0.625rem] font-semibold uppercase tracking-wider text-muted-foreground">
            历史会话 · {root || "（无）"}
            <button className="rounded p-0.5 hover:bg-accent" title="刷新" onClick={onRefreshHistory}>
              <RefreshCw className="h-3 w-3" />
            </button>
          </div>
          {cwdGroups.map((g: any) => g.sessions.map((ss: any) => (
            <button key={ss.id}
              className="flex w-full flex-col items-start gap-0.5 rounded-md px-3 py-1.5 text-left hover:bg-accent/60"
              onClick={() => { onOpenHistory?.(ss.id, g.cwd); setView("chat"); }}>
              <span className="flex w-full items-center gap-1.5 text-xs text-foreground/90">
                <MessageSquare className="h-3 w-3 shrink-0 opacity-60" />
                <span className="truncate text-muted-foreground/80">{ss.title || "（空会话）"}</span>
              </span>
              <span className="pl-[18px] text-[0.625rem] text-muted-foreground">
                {new Date(ss.startedAt).toLocaleString("zh-CN", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" })}
              </span>
            </button>
          )))}
          {!cwdGroups.length && <p className="p-3 text-center text-xs text-muted-foreground/70">此目录暂无历史</p>}
        </div>
      )}
      {/* chatInset = 浮层组总宽：内容列在剩余可见区居中（paddingLeft 缩小可用宽度，mx-auto 随之偏移） */}
      <Conversation className="flex-1" contextRef={stickCtx} style={{ paddingLeft: chatInset }}>
        <ConversationContent className="mx-auto w-full max-w-5xl px-5 pt-6 pb-2">
          {histStart > 0 && (
            <div className="pb-1 text-center text-[0.625rem] text-muted-foreground/60">
              ↑ 上面还有 {histStart} 条，向上滚动加载
            </div>
          )}
          {s.blocks.slice(histStart).map((b) => <BlockView key={b.bid} b={b} canAct={live && s.connected && s.alive} onRespond={respondPerm} onFormRespond={respondForm} onFormSkip={skipForm} />)}
          {/* 底部状态行常驻占位（min-h-8 = 图标行满高）：busy 结束只隐去内容不收行，消息列表不跳动 */}
          <div className="flex min-h-8 items-center gap-2 px-1 text-xs text-muted-foreground">
            {s.busy && (
              <>
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
                {s.blocks.some((b: any) => (b.k === "ask" || b.k === "form") && !b.done)
                  ? s.blocks.some((b: any) => b.k === "form" && !b.done) ? "等待你的回答…" : "等待授权…"
                  : s.blocks.some((b: any) => b.live)
                    ? "回复中…"
                    : s.thinkTokens > 0 ? `思考中… ~${s.thinkTokens} tokens` : "思考中…"}
              </>
            )}
          </div>
        </ConversationContent>
        {/* 滚到底箭头：库内 left-50% 按全宽居中——浮层避让时补 marginLeft 半宽，
            使箭头在消息列（可见区）内居中 */}
        <ConversationScrollButton style={{ marginLeft: chatInset ? chatInset / 2 : 0 }} />
      </Conversation>

      {/* 插话队列：工具条上方（占位于文档流——出现时消息列表整体上抬，不遮挡对话内容）。
          与消息列对齐：外层只给 chatInset，20px 边距放进 max-w-5xl 列内（同 ConversationContent px-5） */}
      {steerQ.length > 0 && (
        <div className="shrink-0 pt-2 pb-1.5" style={{ paddingLeft: chatInset }}>
          <div className="mx-auto flex w-full max-w-5xl flex-col gap-1.5 px-5">
            {steerQ.map((it) => (
              // items-start + pre-wrap：多行消息保留换行展示（truncate 会把换行压成一行省略），
              // 超高（max-h-24）内部滚动，图标/按钮对齐首行
              <div key={it.id}
                className="flex items-start gap-2 rounded-lg border border-dashed border-amber-500/50 bg-amber-500/5 px-2.5 py-1.5 text-xs">
                <Clock className="h-3.5 w-3.5 shrink-0 text-amber-600 dark:text-amber-400" />
                <span className="max-h-24 min-w-0 flex-1 overflow-y-auto whitespace-pre-wrap break-words text-foreground/85" title={it.text}>{it.text}</span>
                {!!it.urls.length && <span className="shrink-0 text-[0.625rem] text-muted-foreground">📎{it.urls.length}</span>}
                {/* ↑ = 立即送出（与输入框发送键一致）；✕ = 撤回到输入框（多条按提交序回填：早的上面晚的下面） */}
                <button className="shrink-0 rounded p-0.5 text-muted-foreground hover:bg-accent hover:text-foreground"
                  title="立即送出（交给 CLI 队列并上屏）" onClick={() => sendSteerNow(it.id)}>
                  <ArrowUp className="h-3.5 w-3.5" />
                </button>
                <button className="shrink-0 rounded p-0.5 text-muted-foreground hover:bg-accent hover:text-foreground"
                  title="撤回到输入框（按提交顺序回填，图片附件不回填）" onClick={() => withdrawSteer(it)}>
                  <X className="h-3.5 w-3.5" />
                </button>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* 底部工具条+输入框：px-5 放进各 max-w-5xl 列内（外层只给 chatInset）——
          消息列/工具条/输入框三者左右边缘完全对齐，浮层开时一并右让 */}
      <div className="bg-background/80 pb-3 pt-0.5 backdrop-blur" style={{ paddingLeft: chatInset }}>
        {/* 工具条 + 输入框高度拖拽区同排（省一行纵向空间）：按钮在左，剩余区域为隐形调高手柄 */}
        <div className="mx-auto mb-2.5 flex h-6 w-full max-w-5xl items-center gap-1 px-5 text-[0.6875rem] text-muted-foreground">
          <button ref={histBtnRef} className={cn("flex items-center gap-1 rounded px-1.5 py-0.5 hover:bg-accent",
            view === "history" && "bg-accent text-accent-foreground")}
            title={`历史会话（工作目录 ${root || "—"}，点空白关闭）`}
            onClick={toggleHistory}><History className="h-3.5 w-3.5" />历史</button>
          <button className="flex items-center gap-1 rounded px-1.5 py-0.5 hover:bg-accent" title="新建会话（工作目录 = 当前工作目录，左上角可切换）"
            onClick={() => onNewSession?.()}><Plus className="h-3.5 w-3.5" />新会话</button>
          <button className="flex items-center gap-1 rounded px-1.5 py-0.5 hover:bg-accent disabled:opacity-40" title="压缩上下文（/compact）"
            disabled={!live || !s.connected || s.busy}
            onClick={() => { if (wsRef.current?.readyState === 1) wsRef.current.send(JSON.stringify({ t: "user", text: "/compact" })); }}>
            <Shrink className="h-3.5 w-3.5" />压缩</button>
          <button className="flex items-center gap-1 rounded px-1.5 py-0.5 hover:bg-accent" title="清除屏幕（仅清当前显示，进程上下文保留）"
            onClick={() => dispatch({ t: "clear" })}>
            <Eraser className="h-3.5 w-3.5" />清除</button>
          {/* 引擎切换：循环切换下次新会话的引擎（多引擎且非当前态才有意义） */}
          {engines && engines.length > 1 && onEnginePref && (
            <button
              className={cn("flex items-center gap-1 rounded px-1.5 py-0.5 hover:bg-accent",
                enginePref === "qtom" && "bg-primary/10 text-primary hover:bg-primary/20")}
              title={`新会话引擎：${engines.find((e) => e.id === enginePref)?.label ?? enginePref}（点击切换；对下一次「新会话」生效）`}
              onClick={() => {
                const cur = engines.findIndex((e) => e.id === enginePref);
                onEnginePref(engines[(cur + 1) % engines.length].id);
              }}>
              <Cat className="h-3.5 w-3.5" />
              {enginePref === "qtom" ? "qtom" : "Claude"}
            </button>
          )}
          {/* 调高手柄（不可见；拖动调输入框高度、双击恢复自动）：占据按钮右侧全部余白 */}
          <div
            className="min-w-16 flex-1 self-stretch cursor-row-resize touch-none"
            title="拖动调整输入框高度（双击恢复自动）"
            onPointerDown={(e) => {
              const ta = document.querySelector("textarea[name='message']") as HTMLTextAreaElement | null;
              if (!ta) return;
              e.preventDefault();
              inputDrag.current = { y: e.clientY, h: ta.getBoundingClientRect().height };
              (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
            }}
            onPointerMove={(e) => {
              const d = inputDrag.current;
              if (!d) return;
              const h = Math.round(Math.max(88, Math.min(window.innerHeight * 0.7, d.h + (d.y - e.clientY))));
              setInputH(h);
            }}
            onPointerUp={() => { inputDrag.current = null; }}
            onDoubleClick={() => setInputH(null)}
          />
        </div>
        <div className="mx-auto w-full max-w-5xl px-5">
          {/* 斜杠命令联想（输入 / 前缀即弹出；无真清单时如实提示会话状态） */}
          {slashOpen && (
            <div className="relative">
              <div className="absolute bottom-full left-0 z-30 mb-1 w-80 overflow-hidden rounded-md border border-border bg-popover py-1 shadow-lg">
                {slashList ? (
                  <div className="max-h-72 overflow-y-auto">
                    {slashList.map((c, i) => (
                      <button key={c}
                        onMouseDown={(e) => e.preventDefault()} // 不抢焦点，补全后继续输入
                        onClick={() => pickSlash(c)}
                        // 键盘导航时高亮项滚进视窗（列表可能长于弹层）
                        ref={i === slashIdxC ? (el) => el?.scrollIntoView({ block: "nearest" }) : undefined}
                        className={cn("flex w-full items-center gap-2 px-3 py-1 text-left text-xs",
                          i === slashIdxC ? "bg-accent text-accent-foreground" : "hover:bg-accent/50")}>
                        <span className="font-mono">/{c}</span>
                        {SLASH_DESC[c] && <span className="ml-auto shrink-0 text-[0.625rem] text-muted-foreground">{SLASH_DESC[c]}</span>}
                      </button>
                    ))}
                  </div>
                ) : (
                  // 命令清单只在 live init 下发（含 skills）——拿不到就不造假。
                  // 后端 spawn 即唤醒 CLI（无害 interrupt），init 连上就来，此提示只闪现一瞬
                  <div className="px-3 py-2 text-xs text-muted-foreground">
                    {live
                      ? "会话进程启动中，命令清单下发中…"
                      : "暂无活动会话——发送消息恢复/新建会话后，命令联想可用"}
                  </div>
                )}
                {slashList && <div className="border-t border-border/60 px-3 py-0.5 text-[0.625rem] text-muted-foreground/70">↑↓ 选择 · Tab/Enter 补全 · Esc 关闭</div>}
              </div>
            </div>
          )}
          {/* @ 文件引用联想（@src/… 可下钻；目录选择继续列内容、文件选择补全收尾） */}
          {atOpen && atList && (
            <div className="relative">
              <div className="absolute bottom-full left-0 z-30 mb-1 w-80 overflow-hidden rounded-md border border-border bg-popover py-1 shadow-lg">
                <div className="px-3 py-0.5 text-[0.625rem] text-muted-foreground/70">@ {atQuery?.dir || "（工作目录）"}</div>
                {atList.map((it, i) => (
                  <button key={(it.dir ? "d:" : "f:") + it.n}
                    onMouseDown={(e) => e.preventDefault()} // 不抢焦点，补全后继续输入
                    onClick={() => pickAt(it)}
                    className={cn("flex w-full items-center gap-2 px-3 py-1 text-left text-xs",
                      i === atIdxC ? "bg-accent text-accent-foreground" : "hover:bg-accent/50")}>
                    {it.dir
                      ? <FolderOpen className="h-3 w-3 shrink-0 text-[oklch(0.75_0.14_85)]" />
                      : <FileIcon className="h-3 w-3 shrink-0 text-muted-foreground" />}
                    <span className="truncate font-mono">{it.n}</span>
                    {it.dir && <span className="ml-auto shrink-0 text-[0.625rem] text-muted-foreground/70">进入 /</span>}
                  </button>
                ))}
                <div className="border-t border-border/60 px-3 py-0.5 text-[0.625rem] text-muted-foreground/70">@ 引用文件 · ↑↓ 选择 · Tab/Enter 补全 · Esc 关闭</div>
              </div>
            </div>
          )}
          {/* 模式菜单（set_permission_mode control_request，切换后 CLI 广播 status 事件回显） */}
          {menu === "mode" && (
            <div className="relative">
              <div className="absolute bottom-full left-0 z-30 mb-1 w-72 rounded-md border border-border bg-popover py-1 shadow-lg"
                onMouseDown={(e) => e.stopPropagation()}>
                <div className="px-3 py-1 text-[0.625rem] font-semibold uppercase tracking-wider text-muted-foreground">权限模式</div>
                {!live && (
                  <button className="flex w-full items-center gap-2 border-b border-border/60 px-3 py-1.5 text-left text-xs text-primary hover:bg-accent/60"
                    title="恢复 claude 进程（--resume 保持上下文），恢复后即可切换"
                    onClick={() => { setMenu(null); onResume?.(""); }}>
                    <RefreshCw className="h-3 w-3" />恢复会话后可切换（点击恢复，上下文保留）
                  </button>
                )}
                {MODES.map((m) => (
                  <button key={m.id} disabled={!live}
                    className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-xs hover:bg-accent/60 disabled:opacity-40"
                    onClick={() => { sendCtrl("set_permission_mode", { mode: m.id }); setCtrlPend("mode"); setMenu(null); }}>
                    <Check className={cn("h-3 w-3 shrink-0", s.permMode === m.id ? "text-primary" : "opacity-0")} />
                    <m.Icon className="h-3 w-3 shrink-0 text-muted-foreground" />
                    <span className={cn("font-mono", s.permMode === m.id && "font-medium text-foreground")}>{m.label}</span>
                    <span className="ml-auto truncate text-[0.625rem] text-muted-foreground">{m.desc}</span>
                  </button>
                ))}
              </div>
            </div>
          )}
          {/* 模型菜单（set_model；代理端校验，失败经 control_response 回显错误） */}
          {menu === "model" && (
            <div className="relative">
              <div className="absolute bottom-full left-0 z-30 mb-1 w-80 rounded-md border border-border bg-popover p-2 shadow-lg"
                onMouseDown={(e) => e.stopPropagation()}>
                <div className="mb-1 px-1 text-[0.625rem] text-muted-foreground">
                  当前：<span className="font-mono text-foreground">{s.model || "—"}</span>
                </div>
                {!live && (
                  <button className="mb-2 flex w-full items-center gap-2 rounded px-1 py-1 text-left text-xs text-primary hover:bg-accent/60"
                    title="恢复 claude 进程（--resume 保持上下文），恢复后即可切换"
                    onClick={() => { setMenu(null); onResume?.(""); }}>
                    <RefreshCw className="h-3 w-3" />恢复会话后可切换（点击恢复，上下文保留）
                  </button>
                )}
                <div className="mb-2 flex gap-1">
                  <input
                    className="min-w-0 flex-1 rounded border border-border bg-background px-2 py-1 font-mono text-xs outline-none focus:border-ring"
                    placeholder="输入任意模型 ID…"
                    value={modelInput}
                    onChange={(e) => setModelInput(e.target.value)}
                    onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); applyModel(modelInput); } }} />
                  <button className="shrink-0 rounded bg-primary px-2 py-1 text-xs text-primary-foreground"
                    onClick={() => applyModel(modelInput)}>切换</button>
                </div>
                <div className="flex flex-wrap gap-1">
                  {(() => {
                    let rec: string[] = [];
                    try { rec = JSON.parse(localStorage.getItem("qweb.models") || "[]"); } catch {}
                    return [...rec.filter((x) => !presets.includes(x) && x !== s.model), ...presets]
                      .filter((x, i, a) => a.indexOf(x) === i && x !== s.model).slice(0, 13);
                  })().map((m) => (
                    <button key={m} disabled={!live}
                      className="rounded border border-border/70 px-1.5 py-0.5 font-mono text-[0.625rem] hover:bg-accent disabled:opacity-40"
                      onClick={() => applyModel(m)}>{m}</button>
                  ))}
                </div>
                <div className="mt-1.5 border-t border-border/60 px-1 pt-1 text-[0.625rem] text-muted-foreground/70">
                  default = 回会话默认模型；CLI 不预校验模型名，非法值下一轮请求时报错
                </div>
              </div>
            </div>
          )}
          {/* 图片上传入口已移除（2026-11-08：目录树支持上传，引用文件用 @ 联想）；
              imgs 状态与 WS images 通道保留——无入口即恒空，协议面不动 */}
          <PromptInput onSubmit={send} className="bg-card">
            <PromptInputBody>
              <PromptInputTextarea
                /* 受控接线（ai-elements 升级后 PromptInput 不再收 onValueChange——曾被
                   透传丢弃导致 input 镜像不更新，斜杠/@ 联想全失效）。setTaValue 的程序化
                   写入走派发 input 事件 → 同样进 onChange 链，镜像自动同步 */
                value={input}
                onChange={(e) => onInput(e.currentTarget.value)}
                /* flex-1 在列向 flex 里 basis:0 无视 height——flex:none 让显式高度/内容高度生效 */
                style={{ flex: "0 0 auto", height: inputH ?? undefined, maxHeight: inputH ?? "60vh" }}
                placeholder={live
                  ? (s.alive
                    ? (isQtom
                      ? "给 qtom 发消息…（/ 命令联想 · Enter 发送 · ESC 打断）"
                      : "发消息…（/ 命令 · @ 引用文件 · Enter 发送 · ESC 打断）")
                    : "进程已退出，请新建会话")
                  : "历史会话 · 输入即恢复上下文继续对话（Enter 发送）"}
                onKeyDown={(e) => {
                  if (slashOpen) {
                    if (e.key === "Escape") { e.preventDefault(); setSlashOff(true); return; }
                    // 导航/补全只在有真列表时（提示态 Enter 保持正常发送语义）
                    if (slashList) {
                      if (e.key === "ArrowDown") { e.preventDefault(); setSlashIdx((slashIdxC + 1) % slashList.length); return; }
                      else if (e.key === "ArrowUp") { e.preventDefault(); setSlashIdx((slashIdxC - 1 + slashList.length) % slashList.length); return; }
                      else if (e.key === "Enter" || e.key === "Tab") { e.preventDefault(); pickSlash(slashList[slashIdxC]); return; }
                    }
                  }
                  if (atOpen && atList) {
                    if (e.key === "ArrowDown") { e.preventDefault(); setAtIdx((atIdxC + 1) % atList.length); }
                    else if (e.key === "ArrowUp") { e.preventDefault(); setAtIdx((atIdxC - 1 + atList.length) % atList.length); }
                    else if (e.key === "Enter" || e.key === "Tab") { e.preventDefault(); pickAt(atList[atIdxC]); }
                    else if (e.key === "Escape") { e.preventDefault(); setAtOff(true); }
                    return;
                  }
                  // 输入历史召回：光标在第一行第一列（selectionStart 0）按 ↑；末尾按 ↓ 前进/还原草稿
                  // （判定/草稿都取原生 ta.value——input state 是镜像，可能滞后）
                  const ta = e.currentTarget as HTMLTextAreaElement;
                  if (e.key === "ArrowUp" && ta.selectionStart === 0 && ta.selectionEnd === 0 && inputHist.current.length) {
                    e.preventDefault();
                    if (histNavIdx.current === -1) {
                      histDraft.current = ta.value;
                      histNavIdx.current = inputHist.current.length - 1;
                    } else histNavIdx.current = Math.max(0, histNavIdx.current - 1);
                    // 召回后光标放回首位，连续 ↑ 才能继续向前翻
                    writeTa(inputHist.current[histNavIdx.current], 0);
                  } else if (e.key === "ArrowDown" && histNavIdx.current !== -1
                    && (ta.selectionStart === 0 || ta.selectionStart === ta.value.length)
                    && ta.selectionEnd === ta.selectionStart) {
                    // 光标在头部（↑ 召回后的状态）或尾部才前进；中部留给正常编辑移光标
                    e.preventDefault();
                    histNavIdx.current++;
                    if (histNavIdx.current >= inputHist.current.length) {
                      histNavIdx.current = -1;
                      writeTa(histDraft.current);
                    } else writeTa(inputHist.current[histNavIdx.current]);
                  }
                }}
              />
            </PromptInputBody>
            <PromptInputFooter>
              <PromptInputTools>
                {/* 图片附件按钮已移除（上传走目录树；@ 联想引用文件）——上方 imgs 仅存
                    WS images 协议位，无 UI 添加入口 */}
                {/* ctx 占用徽章：中性底，仅数字按阈值着色（纯展示；压缩/清除走上方工具条）。
                    常驻不隐藏：无数据（首轮 result 未到）按 0% 展示并占住位置，避免出现时 footer 抖动 */}
                <span
                  className="flex items-center gap-1 rounded-full border border-border/80 bg-secondary/70 px-2 py-0.5 font-mono text-[0.625rem] tabular-nums text-muted-foreground"
                  title="上下文占用（压缩/清屏见上方工具条）">
                  ctx <span className={cn(
                    ctxPct == null || ctxPct < 60
                      ? "text-emerald-600 dark:text-emerald-400"
                      : ctxPct < 85
                        ? "text-amber-600 dark:text-amber-400"
                        : "text-red-600 dark:text-red-400",
                  )}>{ctxPct ?? 0}%</span>
                </span>
                {/* 模式 + 模型 + 连接态（cwd 见标题栏左角） */}
                {/* 模式 badge：default 中性灰；非默认模式主色系提醒（一眼看出在特殊模式）；qtom 固定策略不显示 */}
                {!isQtom && (
                  <button type="button"
                    className={cn(
                      "flex items-center gap-1 rounded-full border px-2 py-0.5 font-mono text-[0.625rem] transition-colors",
                      s.permMode !== "default"
                        ? "border-primary/40 bg-primary/15 text-primary hover:bg-primary/25"
                        : "border-border/80 bg-secondary/70 text-muted-foreground hover:bg-accent hover:text-foreground",
                    )}
                    title={`权限模式：${s.permMode}（点击切换 default/plan/acceptEdits/auto/dontAsk）`}
                    onClick={() => setMenu(menu === "mode" ? null : "mode")}>
                    {ctrlPend === "mode"
                      ? <Loader2 className="h-3 w-3 animate-spin" />
                      : (() => { const M = MODES.find((m) => m.id === s.permMode); return M ? <M.Icon className="h-3 w-3" /> : null; })()}
                    {MODES.find((m) => m.id === s.permMode)?.label ?? s.permMode}
                  </button>
                )}
                {/* 模型 badge：中性胶囊 + 连接态圆点；切换中主色；qtom 单模型只展示不可切 */}
                <button type="button"
                  disabled={isQtom}
                  className={cn(
                    "flex items-center gap-1.5 rounded-full border px-2 py-0.5 font-mono text-[0.625rem] transition-colors",
                    ctrlPend === "model"
                      ? "border-primary/40 bg-primary/10 text-primary hover:bg-primary/20"
                      : "border-border/80 bg-secondary/70 text-foreground/80 hover:bg-accent hover:text-foreground",
                    isQtom && "cursor-default hover:bg-secondary/70 hover:text-foreground/80",
                  )}
                  title={isQtom ? "qtom 单模型（DeepSeek 网页版）" : `模型：${s.model || "—"}（点击切换）`}
                  onClick={() => { if (!isQtom) setMenu(menu === "model" ? null : "model"); }}>
                  {ctrlPend === "model"
                    ? <Loader2 className="h-3 w-3 animate-spin" />
                    : <span className={cn("h-1.5 w-1.5 rounded-full", live ? (s.connected ? "bg-emerald-500" : "bg-muted-foreground/40") : "bg-muted-foreground/40")} />}
                  {s.model || "…"}
                  {ctrlPend === "model" && <span className="text-primary/80">切换中…</span>}
                </button>
              </PromptInputTools>
              {live && s.busy ? (
                <Button size="sm" variant="destructive" type="button" onClick={interrupt}>
                  <CircleStop className="h-4 w-4" /> 打断
                </Button>
              ) : (
                <PromptInputSubmit disabled={live && (!s.alive || !s.connected)} />
              )}
            </PromptInputFooter>
          </PromptInput>
        </div>
      </div>
    </div>
  );
}
