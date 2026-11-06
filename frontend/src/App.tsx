// ccweb 主界面：VSCode 三栏（可拖动调宽）
// 左=资源管理器 | 中=编辑器 | 右=Copilot Chat
// 手机（<768px）：竖排 + 顶部三选一 tab（对话默认），点文件自动切编辑 tab
import { useCallback, useEffect, useRef, useState } from "react";
import { API } from "./lib/api";
import { Bot, FileCode2, FolderOpen as FolderIcon, X } from "lucide-react";
import { cn } from "@/lib/utils";
import Explorer from "./Explorer";
import Editor from "./Editor";
import ChatPanel from "./ChatPanel";

interface LiveSession { id: string; cwd: string; claudeSid?: string | null }

const clamp = (v: number, min: number, max: number) => Math.min(max, Math.max(min, v));

function Resizer({ onDrag }: { onDrag: (dx: number) => void }) {
  const [active, setActive] = useState(false);
  const last = useRef(0);
  const down = (e: React.MouseEvent) => {
    setActive(true);
    last.current = e.clientX;
    const move = (ev: MouseEvent) => { onDrag(ev.clientX - last.current); last.current = ev.clientX; };
    const up = () => {
      setActive(false);
      document.removeEventListener("mousemove", move);
      document.removeEventListener("mouseup", up);
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
    };
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";
    document.addEventListener("mousemove", move);
    document.addEventListener("mouseup", up);
  };
  return (
    // 线贴左（不居中）：左面板多带底色（如 Explorer bg-card/30），线画在色块右缘
    // 上、与色差台阶重合——居中时台阶与线相距数像素，视觉成"双线"。
    // 容器铺 bg-background：透明会露出 body 底色，主题切换时不跟随。
    <div onMouseDown={down} className="group relative z-10 w-1.5 shrink-0 cursor-col-resize bg-background">
      <div
        className="pointer-events-none absolute inset-y-0 left-0 w-px bg-border transition-colors group-hover:bg-foreground/70"
        style={active ? { background: "oklch(var(--primary))" } : undefined}
      />
    </div>
  );
}

export default function App() {
  // 工作目录记忆：用户设定过（localStorage）则刷新后沿用，不再跟会话 cwd 走。
  // 默认值不硬编码（ccweb 不总在容器里，HOME 不一定是 /root）：未知时为空，
  // 等 /api/env 下发 HOME 后由 env effect 设定
  const savedRoot = (() => { try { return localStorage.getItem("ccweb.root"); } catch { return null; } })();
  const userRoot = useRef(!!savedRoot);
  const [root, setRoot] = useState<string>(savedRoot || "");
  // 打开文件请求：seq 递增保证同路径重复请求也触发（双击=钉住已开的预览）
  const [openReq, setOpenReq] = useState<{ path: string; pinned: boolean; seq: number } | null>(null);
  // 文件移动/重命名通知(树 → 编辑器):tabs 路径跟随,不再标"已删除"
  const [movedReq, setMovedReq] = useState<{ moves: [string, string][]; seq: number } | null>(null);
  const onMoved = (moves: [string, string][]) => {
    setMovedReq({ moves, seq: Date.now() });
    setOpenReq((r) => {
      if (!r) return r;
      // 前缀感知:上级目录改名时,其下打开的文件一并跟随
      let p = r.path;
      for (const [f, t] of moves) {
        if (p === f) { p = t; break; }
        if (p.startsWith(f + "/")) { p = t + p.slice(f.length); break; }
      }
      return p === r.path ? r : { ...r, path: p };
    });
  };
  const openFile = (path: string, pinned?: boolean) => {
    setOpenReq((r) => ({ path, pinned: !!pinned, seq: (r?.seq ?? 0) + 1 }));
    setShowEditor(true); // 编辑器被关掉后，点文件应重新弹出
    setMtab("edit"); // 手机：点/双击文件即切到编辑 tab（桌面 mtab 不参与布局，无感）
  };
  const [groups, setGroups] = useState<any[]>([]);
  const [live, setLive] = useState<LiveSession | null>(null);
  const [histEv, setHistEv] = useState<{ id: string; cwd: string; events: any[]; resumeSid: string | null; model?: string | null } | null>(null);
  const [pending, setPending] = useState<{ events: any[]; text: string; model?: string | null } | null>(null);
  const [booted, setBooted] = useState(false);
  // 布局持久化：面板开合与宽度刷新后保持（localStorage）
  const saved = (() => {
    try { return JSON.parse(localStorage.getItem("ccweb.layout") || "{}"); }
    catch { return {}; }
  })();
  const [wLeft, setWLeft] = useState(saved.wLeft ?? 272);
  const [wRight, setWRight] = useState(saved.wRight ?? 420);
  const [showExplorer, setShowExplorer] = useState(saved.showExplorer ?? true);
  const [showChat, setShowChat] = useState(saved.showChat ?? true);
  const [showEditor, setShowEditor] = useState(saved.showEditor ?? true); // 人工开合（Activity Bar）
  // 手机布局（<768px）：三栏改顶部三选一 tab，默认对话；面板保持挂载只切显隐（编辑器未保存内容/树状态不丢）
  const [mobile, setMobile] = useState(() => window.matchMedia("(max-width: 767px)").matches);
  const [mtab, setMtab] = useState<"chat" | "files" | "edit">("chat");
  useEffect(() => {
    const mq = window.matchMedia("(max-width: 767px)");
    const h = () => setMobile(mq.matches);
    mq.addEventListener("change", h);
    return () => mq.removeEventListener("change", h);
  }, []);

  const refresh = useCallback(async () => {
    try {
      const r = await fetch(`${API}/history`);
      setGroups(await r.json());
    } catch {}
  }, []);
  useEffect(() => { refresh().then(() => setBooted(true)); }, [refresh]);
  useEffect(() => {
    localStorage.setItem("ccweb.layout",
      JSON.stringify({ wLeft, wRight, showExplorer, showEditor, showChat }));
  }, [wLeft, wRight, showExplorer, showEditor, showChat]);
  useEffect(() => { if (!live) setPending(null); }, [live]);

  // 全局字号：Ctrl+= 放大 / Ctrl+- 缩小 / Ctrl+0 重置（改 html font-size 基准，UI 均为 rem 等比缩放）
  const [fsTip, setFsTip] = useState<number | null>(null);
  const fsTimer = useRef<number>(0);
  useEffect(() => {
    const apply = (px: number, tip: boolean) => {
      document.documentElement.style.fontSize = px + "px";
      localStorage.setItem("ccweb.fontSize", String(px));
      if (tip) { setFsTip(px); clearTimeout(fsTimer.current); fsTimer.current = window.setTimeout(() => setFsTip(null), 1200); }
    };
    const saved = Number(localStorage.getItem("ccweb.fontSize"));
    if (saved >= 12 && saved <= 24 && saved !== 18) apply(saved, false); // 恢复记忆（18=默认，见 index.css 基准）
    const h = (e: KeyboardEvent) => {
      if (!(e.ctrlKey || e.metaKey) || e.altKey) return;
      const cur = Math.round(parseFloat(getComputedStyle(document.documentElement).fontSize)) || 18;
      const k = e.key;
      if (k === "=" || k === "+") { e.preventDefault(); apply(Math.min(24, cur + 1), true); }
      else if (k === "-" || k === "_") { e.preventDefault(); apply(Math.max(12, cur - 1), true); }
      else if (k === "0") { e.preventDefault(); apply(18, true); }
    };
    window.addEventListener("keydown", h);
    return () => { window.removeEventListener("keydown", h); clearTimeout(fsTimer.current); };
  }, []);

  // 工作区根 = 环境 HOME（后端 /api/env 下发，不写死 /root；拉到前用 /root 兜底）
  const [home, setHome] = useState(""); // /api/env 到达前未知（不再默认 /root：宿主机形态 HOME 各异）
  const [envModels, setEnvModels] = useState<string[]>([]);
  useEffect(() => {
    fetch(`${API}/env`).then((r) => r.json())
      .then((d: any) => {
        if (typeof d.home === "string" && d.home) {
          setHome(d.home);
          if (!userRoot.current) setRoot(d.home); // 从未人工设定过才用 home 兜底
        }
        if (Array.isArray(d.models)) setEnvModels(d.models.map(String));
      })
      .catch(() => {});
  }, []);

  useEffect(() => {
    if (!booted || live || histEv) return;
    (async () => {
      // 1) server 上还有活会话（如刷新/重开标签页）→ 直接重连。
      //    必须同时取 transcript：resume 出来的进程首条消息前不发任何事件（连 init 都没有），
      //    buf 回放是空的——不补历史的话对话区空、模型/ctx 都没有
      try {
        const r = await fetch(`${API}/sessions`);
        const list = await r.json();
        if (Array.isArray(list) && list.length) {
          const s = [...list].sort((a: any, b: any) => b.startedAt - a.startedAt)[0];
          const attach = (d: any) => {
            // d=null（buf 已有全量）也必须清 pending——上一会话残留的初始事件会注入新面板
            if (d?.events?.length || d?.model) setPending({ events: d.events ?? [], text: "", model: d.model ?? null });
            else setPending(null);
            setLive({ id: s.id, cwd: s.cwd, claudeSid: s.claude_sid ?? null });
            // 树不跟随会话 cwd（左树是目录唯一事实源，刷新只还原用户设定/HOME）
          };
          // n>0：进程已发过事件，buf 回放即完整对话+init+result（再注 transcript 会渲染两份）
          // n=0：静默 resume 进程（首条消息前无任何事件），需 transcript 补历史/模型/ctx
          if (s.n > 0 || !s.claude_sid) attach(null);
          else fetch(`${API}/history/${s.claude_sid}`).then((x) => x.json()).then(attach).catch(() => attach(null));
          return;
        }
      } catch {}
      // 2) 无活会话（被空闲回收 / server 重启过）→ 自动 --resume 最近一次会话，刷新即回到可聊状态。
      //    挑"最近使用且有真实对话"的那个：空会话（刚建的、纯命令探测的）title 为空，跳过——
      //    否则 resume 到一个空 transcript，对话区就是空的。
      //    同时取 transcript 事件做 initialEvents（对话区立即有历史）+ model（init 要等首条消息才发）
      const last = groups.flatMap((g: any) => g.sessions.map((ss: any) => ({ ...ss, cwd: g.cwd })))
        .sort((a: any, b: any) => b.startedAt - a.startedAt);
      const g = last.find((x: any) => x.title) ?? last[0];
      if (g) {
        try {
          const [hr, r] = await Promise.all([
            fetch(`${API}/history/${g.id}`).then((x) => x.json()).catch(() => null),
            fetch(`${API}/sessions`, {
              method: "POST", headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ cwd: g.cwd, resume: g.id }),
            }),
          ]);
          const d = await r.json();
          if (r.ok) {
            setPending({ events: hr?.events ?? [], text: "", model: hr?.model ?? null });
            setLive({ id: d.id, cwd: d.cwd, claudeSid: d.claudeSid ?? g.id });
            refresh();
            return;
          }
        } catch {}
        openHistory(g.id, g.cwd); // resume 失败兜底：只读历史（可手动恢复）
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [booted]);

  const newSession = async (cwd?: string) => {
    const r = await fetch(`${API}/sessions`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ cwd: cwd ?? (root || home || "/") }),
    });
    const d = await r.json();
    if (!r.ok) return;
    setHistEv(null);
    setPending(null); // 清旧初始事件：否则新 ChatPanel 挂载时又注入上一会话的 transcript
    setLive({ id: d.id, cwd: d.cwd });
    refresh();
  };

  // 设为工作目录：树切根 + 记忆（刷新后沿用）+ 会话联动。
  // 语义（对用户可见的承诺）：换目录 = 新会话 = 新 claude 实例（cwd 在 spawn 时固化，长驻进程改不了）；
  // 旧会话消息在官方 transcript 里，历史列表可 resume 续聊；server 侧空闲 20min 自动回收进程。
  const [wsNotice, setWsNotice] = useState<string | null>(null);
  const setWorkspace = (path: string) => {
    if (path === root) return;
    setRoot(path);
    userRoot.current = true;
    try { localStorage.setItem("ccweb.root", path); } catch {}
    if (live && live.cwd !== path) {
      newSession(path);
      setWsNotice(`工作目录已切换到 ${path} —— 已开启新会话（新 claude 实例）`);
    } else if (live) {
      setWsNotice(`工作目录 ${path} 与当前会话一致，继续当前会话`);
    }
  };

  const openHistory = async (id: string, cwd: string) => {
    try {
      const r = await fetch(`${API}/history/${id}`);
      const d = await r.json();
      if (!r.ok) return;
      // 历史 id 即官方 session_id（transcript 文件名），直接用于 --resume
      setWsNotice(null);
      setLive(null);
      setHistEv({ id, cwd, events: d.events, resumeSid: id, model: d.model ?? null });
    } catch {}
  };

  // 历史会话继续对话：--resume 恢复进程，历史消息保持显示，首条输入自动发出。
  // live.claudeSid = 历史的官方会话 ID → ChatPanel key 不变 → 面板不重挂，
  // 消息列表原地续聊（重挂会整列表重建 + 滚动重置，看起来"从头到尾重刷"）
  const resumeChat = async (text: string) => {
    if (!histEv) return;
    const r = await fetch(`${API}/sessions`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ cwd: histEv.cwd, resume: histEv.resumeSid }),
    });
    const d = await r.json();
    if (!r.ok) return;
    setPending({ events: histEv.events, text, model: histEv.model ?? null });
    setHistEv(null);
    setLive({ id: d.id, cwd: histEv.cwd, claudeSid: d.claudeSid ?? histEv.resumeSid });
    refresh();
  };

  const chatProps = {
    histGroups: groups,
    onNewSession: () => { setWsNotice(null); newSession(); },
    onOpenHistory: openHistory, onRefreshHistory: refresh, onResume: resumeChat,
    notice: wsNotice, onDismissNotice: () => setWsNotice(null), root,
    models: envModels,
  };

  // Activity Bar（VSCode 式细左条）：资源管理器 / Chat 开关
  const barBtn = (active: boolean, title: string, Icon: any, onClick: () => void) => (
    <button onClick={onClick} title={title}
      className="relative flex h-12 w-full items-center justify-center text-muted-foreground transition-colors hover:text-foreground">
      {active && <span className="absolute inset-y-1 left-0 w-[2px] rounded-full bg-primary" />}
      <Icon className="h-5 w-5" style={active ? { color: "oklch(var(--foreground))" } : undefined} />
    </button>
  );

  // 手机顶部三选一 tab（对话为默认；样式呼应 Activity Bar 的主色指示条）
  const mtabBtn = (k: "chat" | "files" | "edit", label: string, Icon: any) => {
    const active = mtab === k;
    return (
      <button key={k} onClick={() => setMtab(k)}
        className={cn("relative flex flex-1 items-center justify-center gap-1.5 text-xs transition-colors",
          active ? "font-medium text-foreground" : "text-muted-foreground hover:text-foreground")}>
        {active && <span className="absolute inset-x-3 bottom-0 h-[2.5px] rounded-t-sm bg-primary" />}
        <Icon className="h-4 w-4" />{label}
      </button>
    );
  };

  const chat =
    live ? (
      // key 用官方会话 ID（resume 前后不变）：历史→resume 续聊不重挂面板；
      // 新会话（无 claudeSid）用 server 会话 ID
      <ChatPanel key={live.claudeSid ?? live.id} session={live} initialEvents={pending?.events} pendingText={pending?.text} initModel={pending?.model ?? undefined} {...chatProps} />
    ) : histEv ? (
      <ChatPanel key={histEv.id} historyEvents={histEv} initModel={histEv.model ?? undefined} {...chatProps} />
    ) : (
      <ChatPanel {...chatProps} />
    );

  // 手机布局：三面板绝对定位叠放、visibility 切换 —— 绝不能用 display:none（高度归零会让
  // stick-to-bottom 重置滚动，切 tab 时消息列表"从上往下整个重刷"）；visibility 保留布局与滚动，
  // 切回瞬间恢复，编辑器未保存内容/树展开状态也不丢。
  if (mobile) return (
    <div className="flex h-screen w-screen flex-col overflow-hidden">
      <nav className="flex h-11 shrink-0 items-stretch border-b border-border/60 bg-card/40">
        {mtabBtn("chat", "对话", Bot)}
        {mtabBtn("files", "文件", FolderIcon)}
        {mtabBtn("edit", "编辑", FileCode2)}
      </nav>
      <div className="relative min-h-0 flex-1">
        <div className={cn("absolute inset-0 flex", mtab !== "files" && "invisible")}>
          <Explorer root={root || home || "/"} home={home} setRoot={setWorkspace} onOpenFile={openFile} activeFile={openReq?.path ?? null} onMoved={onMoved} />
        </div>
        <div className={cn("absolute inset-0 flex flex-col", mtab !== "edit" && "invisible")}>
          <Editor openReq={openReq} />
        </div>
        <main className={cn("absolute inset-0 flex flex-col", mtab !== "chat" && "invisible")}>
          {chat}
        </main>
      </div>
      {fsTip !== null && (
        <div className="pointer-events-none fixed bottom-6 left-1/2 z-50 -translate-x-1/2 rounded-md border border-border/60 bg-card px-3 py-1.5 text-xs text-foreground/90 shadow-lg">
          字号 {fsTip}px <span className="text-muted-foreground">（Ctrl+0 重置）</span>
        </div>
      )}
    </div>
  );

  return (
    <div className="flex h-screen w-screen overflow-hidden">
      <div className="flex w-12 shrink-0 flex-col items-center border-r border-border/60 bg-card/40 py-2">
        {barBtn(showExplorer, "资源管理器", FolderIcon, () => setShowExplorer((v) => !v))}
        {barBtn(showEditor, "编辑器", FileCode2, () => setShowEditor((v) => !v))}
        {barBtn(showChat, "Copilot 对话", Bot, () => setShowChat((v) => !v))}
      </div>
      {showExplorer && (
        <div className="flex shrink-0" style={{ width: wLeft }}>
          <Explorer root={root || home || "/"} home={home} setRoot={setWorkspace} onOpenFile={openFile} activeFile={openReq?.path ?? null} onMoved={onMoved}
            onClose={() => setShowExplorer(false)} />
        </div>
      )}
      {/* 分隔线按实际相邻面板渲染：Explorer 右缘只要还有面板就画（拖 wLeft） */}
      {showExplorer && (showEditor || showChat) && (
        <Resizer onDrag={(dx) => setWLeft((v) => clamp(v + dx, 190, 460))} />
      )}
      {showEditor && <Editor openReq={openReq} movedReq={movedReq} onClose={() => setShowEditor(false)} />}
      {showEditor && showChat && (
        <Resizer onDrag={(dx) => setWRight((v) => clamp(v - dx, 320, 640))} />
      )}
      {showChat && (
        <>
          {/* 编辑器关闭时对话区弹性占满整个宽度 */}
          <main className={cn("relative", showEditor ? "flex shrink-0 flex-col" : "flex min-w-0 flex-1 flex-col")} style={showEditor ? { width: wRight } : undefined}>
            <button
              className="absolute right-1.5 top-1.5 z-10 rounded p-1 text-muted-foreground hover:bg-accent hover:text-foreground"
              title="关闭面板" onClick={() => setShowChat(false)}>
              <X className="h-3.5 w-3.5" />
            </button>
            {chat}
          </main>
        </>
      )}
      {/* 字号提示（Ctrl+= / Ctrl+- / Ctrl+0） */}
      {fsTip !== null && (
        <div className="pointer-events-none fixed bottom-6 left-1/2 z-50 -translate-x-1/2 rounded-md border border-border/60 bg-card px-3 py-1.5 text-xs text-foreground/90 shadow-lg">
          字号 {fsTip}px <span className="text-muted-foreground">（Ctrl+0 重置）</span>
        </div>
      )}
    </div>
  );
}
