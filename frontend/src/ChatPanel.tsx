// 右栏：对话面板（AI Elements 官方 example-chatbot 风格）
// 支持两种形态：live 会话（WS 双向）与只读历史回放（/api/history/{id}）
import { useEffect, useReducer, useRef, useState, useCallback, useMemo } from "react";
import { Conversation, ConversationContent, ConversationScrollButton } from "@/components/ai-elements/conversation";
import { Message, MessageContent, MessageResponse } from "@/components/ai-elements/message";
import { Reasoning, ReasoningContent, ReasoningTrigger } from "@/components/ai-elements/reasoning";
import { Tool, ToolHeader, ToolContent, ToolInput, ToolOutput } from "@/components/ai-elements/tool";
import {
  PromptInput, PromptInputBody, PromptInputTextarea,
  PromptInputFooter, PromptInputTools, PromptInputSubmit,
} from "@/components/ai-elements/prompt-input";
import { cn } from "@/lib/utils";
import { BASE } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { CircleStop, FolderOpen, History, Plus, MessageSquare, RefreshCw, Loader2, X, Check, Shrink, Eraser, Zap, ListTodo, FilePen, Sparkles, FastForward } from "lucide-react";
import type { UIBlock } from "./types";

interface State { blocks: UIBlock[]; busy: boolean; alive: boolean; connected: boolean; model: string; permMode: string; slashCmds: string[]; ctxAbs?: number; queued: number }
type Action =
  | { t: "cc"; ev: any }
  | { t: "replay"; events: any[] }
  | { t: "user"; text: string }
  | { t: "note"; text: string }
  | { t: "clear" }
  | { t: "connected"; v: boolean }
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
// 无 live 会话（历史回放）时的斜杠命令兜底列表（live init.slash_commands 会覆盖）
const FALLBACK_SLASH = [
  "agents", "auto-mode-setup", "autocompact", "clear", "color", "compact", "config",
  "context", "effort", "fast", "focus", "init", "insights", "mcp", "model", "output-style", "rename", "usage",
];
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
//      历史回放的合成 result 由服务端落盘记忆回注，见 server 的 ccweb-ctxwin.json）
//      经 rememberCtxWin 按归一名写入
//   2) /api/env 的模型清单（settings 推导，含 [1m] 原名）→ 裸名命中即 1M
const normModel = (m: unknown) => String(m ?? "").replace(/\[1m\]$/i, "");
const ctxWinHints = new Set<string>(); // env 清单里带 [1m] 的模型归一名（ChatPanel 同步）
const rememberCtxWin = (mu: any) => {
  try {
    for (const [k, v] of Object.entries(mu ?? {}))
      if ((v as any)?.contextWindow) localStorage.setItem(`ccweb.ctxwin.${normModel(k)}`, String(v.contextWindow));
  } catch {}
};
const ctxWindowOf = (model: string): number => {
  try {
    const saved = Number(localStorage.getItem(`ccweb.ctxwin.${normModel(model)}`));
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

export function ccReducer(s: State, a: Action): State {
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
    case "user": return { ...s, blocks: [...s.blocks, { k: "user", text: a.text }], busy: true, queued: s.busy ? s.queued + 1 : s.queued };
    case "note": return { ...s, blocks: [...s.blocks, { k: "note", text: a.text }] };
    case "clear": return { ...s, blocks: [], partial: null };
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
          return { ...s, blocks: [...blocks, { k: "note", text: `操作失败：${r.error}` }] };
        const out = r.response ?? {};
        if (typeof out.model === "string") return { ...s, model: out.model };
        if (typeof out.mode === "string") return { ...s, permMode: out.mode };
        return s;
      }
      if (ev.type === "stream_event") {
        const e = ev.event ?? {};
        // message_start 携带实际服务模型（/model 或 set_model 切换后以此为准）；
        // 同时置 busy：刷新/重连后本地 busy 是 false，但这一轮是别处发起、正在进行——
        // 不置的话输入区不显示进行态，ESC 打断也会被 busy 守卫拦掉
        if (e.type === "message_start" && e.message?.model) s = { ...s, busy: true, model: String(e.message.model) };
        if (e.type === "content_block_start") {
          const b = e.content_block;
          if (b?.type === "tool_use") blocks.push({ k: "tool", id: b.id, name: b.name, inputJson: "", live: true });
          return { ...s, blocks };
        }
        if (e.type === "content_block_delta") {
          const d = e.delta ?? {};
          const L = last();
          if (d.type === "text_delta" && d.text) {
            if (L && L.k === "text" && L.live) blocks[blocks.length - 1] = { ...L, text: L.text + d.text };
            else blocks.push({ k: "text", text: d.text, live: true });
          } else if (d.type === "thinking_delta" && d.thinking) {
            if (L && L.k === "think" && L.live) blocks[blocks.length - 1] = { ...L, text: L.text + d.thinking };
            else blocks.push({ k: "think", text: d.thinking, live: true });
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
        const first = blocks.findIndex((b: any) => b.live);
        const finals: UIBlock[] = [];
        for (const c of ev.message?.content ?? []) {
          if (c.type === "text") finals.push({ k: "text", text: c.text });
          else if (c.type === "thinking") finals.push({ k: "think", text: c.thinking });
          else if (c.type === "tool_use")
            finals.push({ k: "tool", id: c.id, name: c.name, inputJson: JSON.stringify(c.input, null, 2) ?? "" });
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
        if (text.trim()) {
          // compact 的系统注入：不渲染成用户消息，并重置上下文基线（压缩后骤降是合法的）
          if (text.trim().startsWith("This session is being continued"))
            return { ...s, ctxAbs: 0 };
          const L = last();
          // 斜杠命令的 transcript 回显（<command-name>/x</command-name>…）与本地已入块的 "/x args" 重复，跳过
          const cn = /<command-name>([^<]+)<\/command-name>/.exec(text);
          if (cn && L && L.k === "user" && L.text.trim().startsWith(cn[1].trim()))
            return { ...s, blocks };
          if (!(L && L.k === "user" && L.text === text.trim())) {
            blocks.push({ k: "user", text: text.trim() });
          }
          return { ...s, blocks };
        }
        for (const c of Array.isArray(c0) ? c0 : []) {
          if (c.type === "tool_result") {
            const i = blocks.findIndex((b: any) => b.k === "tool" && b.id === c.tool_use_id);
            if (i >= 0) {
              const b: any = blocks[i];
              const rc = typeof c.content === "string" ? c.content
                : Array.isArray(c.content) ? c.content.filter((x: any) => x.type === "text").map((x: any) => x.text).join("\n") : "";
              blocks[i] = { ...b, live: false, result: rc, isError: !!c.is_error };
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
        // 窗口推定（modelUsage→localStorage→hints→默认）移到渲染处：见 ctxPct 派生注释
        // 单调防抖：上下文只增不减（compact/clear 已各自重置），防网关 usage 偶发波动。
        // ctx% 不在这里定格：分母信息渐进到达（见渲染处派生注释）
        const ctxAbs = Math.max(usedAbs, s.ctxAbs ?? 0);
        return { ...s, busy: false, queued: 0, model: ev.model ? String(ev.model) : s.model, ctxAbs };
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
  const over = b.text.length > THINK_INLINE_MAX;
  return (
    <Reasoning open={open} onOpenChange={setOpen} hasContent={!!b.text}
      className="w-full text-xs">
      <ReasoningTrigger />
      {/* ReasoningContent 只收 string（Streamdown markdown）——按钮放折叠区外，展开且超长时才出现 */}
      <ReasoningContent>{over ? b.text.slice(0, THINK_INLINE_MAX) + "…" : b.text}</ReasoningContent>
      {over && open && (
        <button className="ml-4 mt-1 block text-[0.6875rem] text-primary/80 underline-offset-2 hover:underline"
          onClick={() => setZoom(true)}>
          查看全部 {b.text.length} 字（浮窗）
        </button>
      )}
      <Dialog open={zoom} onOpenChange={setZoom}>
        <DialogContent className="sm:max-w-2xl">
          <DialogHeader>
            <DialogTitle className="text-sm">思考过程 · {b.text.length} 字</DialogTitle>
          </DialogHeader>
          <div className="max-h-[70vh] overflow-y-auto whitespace-pre-wrap break-words rounded-md bg-muted/40 p-3 font-mono text-xs leading-relaxed">
            {b.text}
          </div>
        </DialogContent>
      </Dialog>
    </Reasoning>
  );
}

// 本地命令输出（/model 等）带 <local-command-stdout>…</local-command-stdout> 包裹标签，展示时剥掉只留内容
const stripCmdTags = (t: string) => t.replace(/<\/?local-command-(?:stdout|stderr)>/g, "").trim();

function BlockView({ b }: { b: UIBlock }) {
  if (b.k === "user")
    return (
      <Message from="user" className="ml-0 justify-start">
        <MessageContent className="rounded-lg border border-primary/30 bg-primary/10 px-3 py-2">
          {stripCmdTags(b.text)}
        </MessageContent>
      </Message>
    );
  if (b.k === "text")
    return (
      <Message from="assistant" className="justify-start">
        <MessageContent>
          <MessageResponse>{stripCmdTags(b.text)}</MessageResponse>
          {b.live && <span className="animate-pulse text-muted-foreground">▍</span>}
        </MessageContent>
      </Message>
    );
  if (b.k === "think") return <ThinkBlock b={b} />;
  if (b.k === "tool") {
    let parsed: any = b.inputJson;
    try { parsed = JSON.parse(b.inputJson || "{}"); } catch {}
    return (
      <Tool className="my-1 w-full">
        <ToolHeader state={toolState(b) as any} type={`tool-${b.name}`} />
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
  session, historyEvents, histGroups, onResume, onNewSession, onOpenHistory, onRefreshHistory, onToggleHistory,
  notice, onDismissNotice, root, models,
  initialEvents, pendingText, initModel,
}: {
  session?: { id: string; cwd: string };
  historyEvents?: { id: string; cwd: string; events: any[] };
  initialEvents?: any[];
  pendingText?: string;
  initModel?: string;
  histGroups?: any[];
  onResume?: (text: string) => void;
  onNewSession?: () => void;
  onOpenHistory?: (id: string, cwd: string) => void;
  onRefreshHistory?: () => void;
  onToggleHistory?: () => void;
  notice?: string | null;
  onDismissNotice?: () => void;
  root?: string;
  models?: string[];
}) {
  const live = !!session;
  const sid = session?.id ?? historyEvents?.id ?? "";
  const cwd = session?.cwd ?? historyEvents?.cwd ?? "";
  // env 模型清单 → ctx 窗口提示（带 [1m] 的归一名；历史恢复无 modelUsage 时兜底 1M）
  useEffect(() => {
    ctxWinHints.clear();
    for (const m of models ?? []) if (/\[1m\]$/i.test(m)) ctxWinHints.add(normModel(m));
  }, [models]);
  // 模式/模型弹出菜单（锚定输入框左下）
  const [menu, setMenu] = useState<null | "mode" | "model">(null);
  const [modelInput, setModelInput] = useState("");
  // 历史浮层：锚定按钮位置向上展开（记录按钮相对面板的坐标）
  const [view, setView] = useState<"chat" | "history">("chat");
  const [histPos, setHistPos] = useState<{ left: number; bottom: number } | null>(null);
  const hostRef = useRef<HTMLDivElement>(null);
  const histBtnRef = useRef<HTMLButtonElement>(null);
  // 历史严格跟随左树（工作目录 root）——树是目录的唯一事实源，不跟会话 cwd 走
  // （resume 别的目录的会话时面板 cwd 会偏离 root，历史浮层仍按树显示）
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
  const [s, dispatch] = useReducer(ccReducer, { blocks: [], busy: false, alive: live, connected: live, model: initModel ?? "", permMode: "default", slashCmds: [], queued: 0 });
  // ctx% 渲染时派生、不进 state 定格：分母窗口是渐进到达的（live/合成 result 的
  // modelUsage→localStorage、env 模型清单 hints 都可能晚于首个 result），state 里
  // 算好存住会在早到的 result 上拿 200k 兜底算错（1M 会话虚高 5 倍）且永不更新。
  // 官方口径（statusline 文档）：分子三项之和不含 output，分母完整 context window
  const ctxPct = s.ctxAbs == null ? null
    : Math.round((s.ctxAbs / ctxWindowOf(s.model || "", null, null)) * 100);
  const wsRef = useRef<WebSocket | null>(null);
  const [input, setInput] = useState("");
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
            if (msg.ev?.type === "control_response") setCtrlPend(null); // 回包到达，停转圈
            dispatch({ t: "cc", ev: msg.ev });
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
    if (!text.trim()) return;
    // 历史回放态：先恢复进程（--resume），App 升级为 live 后再发
    if (!live) { onResume?.(text); return; }
    // busy 时不拦：CLI 实测排队（当前轮结束后送达），与终端 steer 行为一致
    if (!s.alive) { dispatch({ t: "note", text: "进程已退出，请新建会话" }); return; }
    if (!s.connected) { dispatch({ t: "note", text: "连接断开（自动重连中），稍候再发" }); return; }
    wsRef.current?.send(JSON.stringify({ t: "user", text: text.trim() }));
    dispatch({ t: "user", text: text.trim() });
    setInput("");
  }, [s.connected, s.alive]);

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
  // 切换模型：default 显式传 null（CLI 语义=回退会话默认）；自定义模型名记入最近使用
  const applyModel = useCallback((m: string) => {
    const v = m.trim();
    if (!v) return;
    sendCtrl("set_model", { model: v === "default" ? null : v });
    setCtrlPend("model");
    if (!presets.includes(v)) {
      try {
        const rec = [v, ...JSON.parse(localStorage.getItem("ccweb.models") || "[]").filter((x: string) => x !== v)].slice(0, 6);
        localStorage.setItem("ccweb.models", JSON.stringify(rec));
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

  // ---- 斜杠命令联想：输入 / 前缀（未带空格/参数）即弹出 ----
  const [slashIdx, setSlashIdx] = useState(0);
  const [slashOff, setSlashOff] = useState(false); // Esc 关闭后不再弹，直到输入变化
  const slashOpenRef = useRef(false); // 供 window 捕获阶段的 ESC 监听读取（先关联想再打断）
  const slashList = useMemo(() => {
    const m = /^\/([a-zA-Z0-9_-]*)$/.exec(input.trim());
    if (!m) return null;
    const pool = (s.slashCmds.length ? s.slashCmds : FALLBACK_SLASH)
      .filter((c) => c.toLowerCase().startsWith(m[1].toLowerCase()));
    return pool.length ? pool.slice(0, 12) : null;
  }, [input, s.slashCmds]);
  const slashOpen = !!slashList && !slashOff;
  slashOpenRef.current = slashOpen;
  const slashIdxC = Math.min(slashIdx, Math.max(0, (slashList?.length ?? 1) - 1));
  const onInput = (v: string) => { setInput(v); setSlashOff(false); setSlashIdx(0); };
  const pickSlash = (c: string) => { setInput("/" + c + " "); setSlashOff(false); };

  useEffect(() => {
    const h = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      // 联想浮层开着时 ESC 只关浮层（textarea 的 onKeyDown 负责），不打断会话
      if (slashOpenRef.current) return;
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


  // 会话标题：首句用户提问前 20 字（与 resume/历史列表同源），占位把消息列表往下压
  const firstUser: any = s.blocks.find((b: any) => b.k === "user");
  const title = firstUser
    ? String(firstUser.text).replace(/\s+/g, " ").trim().slice(0, 20)
    : live ? "新会话" : "（空会话）";

  return (
    <div ref={hostRef} className="relative flex h-full flex-col">
      {/* 会话标题栏（居中；左角常驻显示会话工作目录，右角悬浮 X） */}
      <div className="flex h-8 shrink-0 items-center justify-center border-b border-border/40 bg-card/40 px-10">
        {cwd && (
          <span className="absolute left-2 flex min-w-0 max-w-[38%] items-center gap-1 font-mono text-[0.625rem] text-muted-foreground/70" title={`claude 工作目录：${cwd}`}>
            <FolderOpen className="h-3 w-3 shrink-0" />
            <span className="truncate">{cwd}</span>
          </span>
        )}
        <span className="min-w-0 max-w-full truncate text-xs font-medium text-foreground/80" title={firstUser ? firstUser.text : title}>
          {title}
        </span>
      </div>
      {/* 换工作目录系统提示：明确"新会话=新 claude 实例"（历史消息在官方 transcript，可 resume 续聊） */}
      {notice && (
        <div className="flex h-7 shrink-0 items-center gap-2 border-b border-primary/20 bg-primary/10 px-3 text-[0.6875rem] text-foreground/80">
          <FolderOpen className="h-3 w-3 shrink-0 text-primary/70" />
          <span className="min-w-0 flex-1 truncate">{notice}</span>
          <button className="shrink-0 rounded p-0.5 text-muted-foreground hover:bg-accent hover:text-foreground" title="关闭提示" onClick={() => onDismissNotice?.()}>
            <X className="h-3 w-3" />
          </button>
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
      <Conversation className="flex-1">
        <ConversationContent className="mx-auto w-full max-w-5xl px-5 pt-6 pb-2">
          {s.blocks.map((b, i) => <BlockView key={i} b={b} />)}
          {live && s.busy && (
            <div className="flex items-center gap-2 px-1 py-2 text-xs text-muted-foreground">
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
              {s.blocks.some((b: any) => b.live) ? "回复中…" : "思考中…"}
              {s.queued > 0 && <span className="text-amber-600 dark:text-amber-400">已排队 {s.queued} 条（当前轮结束后送达）</span>}
            </div>
          )}
        </ConversationContent>
        <ConversationScrollButton />
      </Conversation>

      {/* 统一工具条（输入框上方）：历史 · 新会话 · 压缩 · 清除（模式/模型/ctx 在输入框内） */}
      <div className="flex h-9 shrink-0 bg-card/40 text-[0.6875rem] text-muted-foreground">
        <div className="mx-auto flex w-full max-w-5xl items-center gap-1 px-5">
        <button ref={histBtnRef} className={cn("flex items-center gap-1 rounded px-2 py-1 hover:bg-accent",
          view === "history" && "bg-accent text-accent-foreground")}
          title={`历史会话（工作目录 ${root || "—"}，点空白关闭）`}
          onClick={toggleHistory}><History className="h-3.5 w-3.5" />历史</button>
        <button className="flex items-center gap-1 rounded px-2 py-1 hover:bg-accent" title="新建会话（工作目录 = 资源管理器根目录）"
          onClick={() => onNewSession?.()}><Plus className="h-3.5 w-3.5" />新会话</button>
        <button className="flex items-center gap-1 rounded px-2 py-1 hover:bg-accent disabled:opacity-40" title="压缩上下文（/compact）"
          disabled={!live || !s.connected || s.busy}
          onClick={() => { if (wsRef.current?.readyState === 1) wsRef.current.send(JSON.stringify({ t: "user", text: "/compact" })); }}>
          <Shrink className="h-3.5 w-3.5" />压缩</button>
        <button className="flex items-center gap-1 rounded px-2 py-1 hover:bg-accent" title="清除屏幕（仅清当前显示，进程上下文保留）"
          onClick={() => dispatch({ t: "clear" })}>
          <Eraser className="h-3.5 w-3.5" />清除</button>
        </div>
      </div>
      <div className="bg-background/80 px-5 pb-3 pt-2 backdrop-blur">
        <div className="mx-auto w-full max-w-5xl">
          {/* 斜杠命令联想（输入 / 前缀即弹出；↑↓ 选 · Tab/Enter 补全 · Esc 关闭） */}
          {slashOpen && slashList && (
            <div className="relative">
              <div className="absolute bottom-full left-0 z-30 mb-1 w-80 overflow-hidden rounded-md border border-border bg-popover py-1 shadow-lg">
                {slashList.map((c, i) => (
                  <button key={c}
                    onMouseDown={(e) => e.preventDefault()} // 不抢焦点，补全后继续输入
                    onClick={() => pickSlash(c)}
                    className={cn("flex w-full items-center gap-2 px-3 py-1 text-left text-xs",
                      i === slashIdxC ? "bg-accent text-accent-foreground" : "hover:bg-accent/50")}>
                    <span className="font-mono">/{c}</span>
                    {SLASH_DESC[c] && <span className="ml-auto shrink-0 text-[0.625rem] text-muted-foreground">{SLASH_DESC[c]}</span>}
                  </button>
                ))}
                <div className="border-t border-border/60 px-3 py-0.5 text-[0.625rem] text-muted-foreground/70">↑↓ 选择 · Tab/Enter 补全 · Esc 关闭</div>
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
                    try { rec = JSON.parse(localStorage.getItem("ccweb.models") || "[]"); } catch {}
                    return [...rec.filter((x) => !presets.includes(x) && x !== s.model), ...presets]
                      .filter((x, i, a) => a.indexOf(x) === i && x !== s.model).slice(0, 13);
                  })().map((m) => (
                    <button key={m} disabled={!live}
                      className="rounded border border-border/70 px-1.5 py-0.5 font-mono text-[0.625rem] hover:bg-accent disabled:opacity-40"
                      onClick={() => applyModel(m)}>{m}</button>
                  ))}
                </div>
                <div className="mt-1.5 border-t border-border/60 px-1 pt-1 text-[0.625rem] text-muted-foreground/70">
                  default = 回会话默认模型；非法模型由后端校验并提示
                </div>
              </div>
            </div>
          )}
          <PromptInput value={input} onValueChange={onInput} onSubmit={send} className="bg-card">
            <PromptInputBody>
              <PromptInputTextarea
                placeholder={live
                  ? (s.alive ? "给 Claude 发消息…（/ 命令联想 · Enter 发送 · ESC 打断）" : "进程已退出，请新建会话")
                  : "历史会话 · 输入即恢复上下文继续对话（Enter 发送）"}
                onKeyDown={(e) => {
                  if (!slashOpen || !slashList) return;
                  if (e.key === "ArrowDown") { e.preventDefault(); setSlashIdx((slashIdxC + 1) % slashList.length); }
                  else if (e.key === "ArrowUp") { e.preventDefault(); setSlashIdx((slashIdxC - 1 + slashList.length) % slashList.length); }
                  else if (e.key === "Enter" || e.key === "Tab") { e.preventDefault(); pickSlash(slashList[slashIdxC]); }
                  else if (e.key === "Escape") { e.preventDefault(); setSlashOff(true); }
                }}
              />
            </PromptInputBody>
            <PromptInputFooter>
              <PromptInputTools>
                {/* ctx 占用徽章：中性底，仅数字按阈值着色（纯展示；压缩/清除走上方工具条） */}
                {ctxPct != null && (
                  <span
                    className="flex items-center gap-1 rounded-full border border-border/80 bg-secondary/70 px-2 py-0.5 font-mono text-[0.625rem] tabular-nums text-muted-foreground"
                    title="上下文占用（压缩/清屏见上方工具条）">
                    ctx <span className={cn(
                      ctxPct < 60
                        ? "text-emerald-600 dark:text-emerald-400"
                        : ctxPct < 85
                          ? "text-amber-600 dark:text-amber-400"
                          : "text-red-600 dark:text-red-400",
                    )}>{ctxPct}%</span>
                  </span>
                )}
                {/* 模式 + 模型 + 连接态（cwd 见标题栏左角） */}
                {/* 模式 badge：default 中性灰；非默认模式主色系提醒（一眼看出在特殊模式） */}
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
                {/* 模型 badge：中性胶囊 + 连接态圆点；切换中主色 */}
                <button type="button"
                  className={cn(
                    "flex items-center gap-1.5 rounded-full border px-2 py-0.5 font-mono text-[0.625rem] transition-colors",
                    ctrlPend === "model"
                      ? "border-primary/40 bg-primary/10 text-primary hover:bg-primary/20"
                      : "border-border/80 bg-secondary/70 text-foreground/80 hover:bg-accent hover:text-foreground",
                  )}
                  title={`模型：${s.model || "—"}（点击切换）`}
                  onClick={() => setMenu(menu === "model" ? null : "model")}>
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
