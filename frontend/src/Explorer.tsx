// 目录树浮层（chat-first 布局：从标题栏下方垂到底的辅助层）：
// 懒加载目录树 + 右键菜单全功能文件管理（新建/上传/下载/重命名/删除/剪切粘贴）。
// 根 = 工作目录，锁死其内（无 ".." 上溯；换工作目录唯一入口 = 标题栏左上三件套，见 ChatPanel/DirPicker）
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { API } from "./lib/api";
import { FileGlyph } from "./lib/fileglyph";
import { useFsEvent, watchDir } from "@/lib/fswatch";
import {
  ChevronRight, ChevronDown, ChevronUp, Loader2, FolderOpen, Folder, File as FileIcon, RefreshCw,
  FilePlus2, FolderPlus, Upload, Download, Pencil, Trash2, Scissors, Copy, ClipboardCopy, ClipboardPaste, X, Eye, EyeOff,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { kdEnv } from "./lib/keeperd";
import { ConfirmDialog } from "@/components/ui/confirm";
import { toast } from "sonner";

export interface TreeNode {
  path: string;
  name: string;
  dir: boolean;
  size?: number;
  open?: boolean;
  loading?: boolean;
  children?: TreeNode[];
}

// 错误提示走 toast(sonner):err 置位即弹、随即清空——不再常驻树顶小字行
function ErrToast({ msg, clear }: { msg: string; clear: () => void }) {
  useEffect(() => { if (msg) { toast.error(msg); clear(); } }, [msg]);
  return null;
}

const TEXT_EXT = /\.(txt|md|json|ya?ml|toml|ini|conf|log|py|js|ts|tsx|jsx|go|rs|java|c|h|cpp|sh|bash|html|css|xml|csv|sql|env|gitignore|lock)$/i;
const parentOf = (p: string) => p.split("/").slice(0, -1).join("/") || "/";
const fmtSize = (n?: number) =>
  n == null ? "" : n >= 1048576 ? (n / 1048576).toFixed(1) + "M" : n >= 1024 ? Math.round(n / 1024) + "K" : n + "B";

const fsOp = async (q: Record<string, unknown>) => {
  try {
    const r = await fetch(`${API}/fs/op`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(q),
    });
    const d = await r.json().catch(() => ({}));
    return { ok: r.ok && !d.error, error: d.error as string | undefined };
  } catch { return { ok: false, error: "网络错误" }; }
};
const toB64 = (f: File) => new Promise<string>((res, rej) => {
  const r = new FileReader();
  r.onload = () => { const s = String(r.result); res(s.slice(s.indexOf(",") + 1)); };
  r.onerror = rej;
  r.readAsDataURL(f);
});

// 内联输入行（新建/重命名共用，Enter 确认 Esc 取消；点击外部=失焦确认，done 防三路竞态）
// selectBase：重命名时只选中主文件名（不含扩展名）——直接敲字=只改名不改后缀（VSCode/Finder 行为）
function EditRow({ icon, lead, initial, selectBase, indent = 0, onOk, onCancel }: {
  icon: React.ReactNode; lead?: React.ReactNode; initial: string; selectBase?: boolean; indent?: number;
  onOk: (v: string) => void; onCancel: () => void;
}) {
  const [v, setV] = useState(initial);
  const ref = useRef<HTMLInputElement>(null);
  const vRef = useRef(v); vRef.current = v;
  const doneRef = useRef(false);
  const done = (fn: () => void) => { if (doneRef.current) return; doneRef.current = true; fn(); };
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.focus();
    const dot = selectBase ? initial.lastIndexOf(".") : -1;
    if (dot > 0) el.setSelectionRange(0, dot); // 无点/隐藏文件(.bashrc, dot=0)则全选
    else el.select();
  }, []);
  return (
    <div className="flex items-center gap-1 py-[3px] pr-2" style={{ paddingLeft: indent * 12 + 6 }}>
      {lead ?? <span className="w-3 shrink-0" />}
      {icon}
      <input ref={ref} value={v} spellCheck={false}
        onChange={(e) => setV(e.target.value)}
        onBlur={() => done(() => onOk(vRef.current.trim()))}
        onKeyDown={(e) => {
          if (e.key === "Enter") { e.preventDefault(); done(() => onOk(v.trim())); }
          if (e.key === "Escape") { e.preventDefault(); done(onCancel); }
        }}
        className="h-5 min-w-0 flex-1 rounded-sm border border-ring bg-background px-1 text-xs outline-none" />
    </div>
  );
}

// 右键菜单项。必须定义在模块级：若写在组件渲染函数体内，每次重渲染 MI 引用都是新函数，
// React 会把整棵菜单子树卸载重挂（按钮换成新 DOM 节点）。真实浏览器里 mousedown 会把焦点
// 从树移到菜单按钮 → treeBox onBlur → setTreeFocus 重渲染正好发生在 mousedown/mouseup 之间，
// click 落在被替换的节点上被吃掉——"右键打开第一次点不灵、第二次才开"的根因。
// （jsdom 不模拟 mousedown 聚焦，所以 DOM 测试复现不了，只有真浏览器能撞上）
function MI({ icon: Icon, label, onClick, danger, disabled, close }: {
  icon: any; label: string; onClick: () => void; danger?: boolean; disabled?: boolean; close: () => void;
}) {
  return (
    <button className={cn("flex w-full items-center gap-2 px-3 py-1.5 text-left hover:bg-accent",
      danger && "text-destructive", disabled && "pointer-events-none opacity-40")}
      onClick={() => { if (!disabled) { close(); onClick(); } }}>
      <Icon className="h-3.5 w-3.5 opacity-70" />{label}
    </button>
  );
}

export default function Explorer({
  root, home, onOpenFile, activeFile, onClose, onMoved,
}: {
  root: string; // 工作目录 = 树根（树锁死其内，换根走标题栏）
  home: string; // 环境 HOME（/api/env 下发；不写死 /root，Windows 也能跑）
  onOpenFile: (path: string, pinned?: boolean) => void;
  activeFile: string | null;
  onClose?: () => void; // 树头部 X：独立收起目录树浮层（与编辑器互不影响）
  onMoved?: (moves: [string, string][]) => void; // 移动/改名成功(moves=[from,to][]),编辑器跟随更新打开路径
}) {
  const [tree, setTree] = useState<TreeNode[]>([]);
  const [err, setErr] = useState("");
  // 管理终端能力分级:容器内=仅本容器管理;宿主机+keeperd=可创建容器
  const [env, setEnv] = useState<{ container: boolean; keeperd: boolean }>({ container: false, keeperd: false });
  useEffect(() => { kdEnv().then(setEnv).catch(() => {}); }, []);
  // 隐藏文件开关（localStorage 记忆；listDir 依赖它 → 切换即整树刷新）
  const [showHidden, setShowHidden] = useState(() => {
    try { return localStorage.getItem("qweb.hidden") === "1"; } catch { return false; }
  });
  useEffect(() => { try { localStorage.setItem("qweb.hidden", showHidden ? "1" : "0"); } catch {} }, [showHidden]);
  // （工作目录的设定入口 = 标题栏左上三件套：cwd chip/历史目录/换目录选择器，见 ChatPanel 与 DirPicker）

  // 右键菜单 / 内联编辑 / 上传中 / 拖放目标 / 多选 / 框选
  const [ctx, setCtx] = useState<{ x: number; y: number; node: TreeNode | null; multi?: boolean } | null>(null);
  const [edit, setEdit] = useState<{ dir: string; kind: "file" | "dir" | "rename"; oldPath?: string } | null>(null);
  const [uploading, setUploading] = useState<string | null>(null);
  const [dragOver, setDragOver] = useState<string | null>(null);
  const [blankDrag, setBlankDrag] = useState(false); // 树下方空白区拖放悬停(落点=当前目录)
  const [sel, setSel] = useState<Set<string>>(new Set());
  const [treeFocus, setTreeFocus] = useState(false); // 树失焦时选中整体淡化（VSCode inactiveSelection）
  const [marq, setMarq] = useState<{ x0: number; y0: number; x1: number; y1: number } | null>(null);
  const anchorRef = useRef<string | null>(null);      // shift 范围选锚点
  const dragPathsRef = useRef<string[]>([]);          // 拖拽集合(集合内目标不可放置:drop 到自身=无效拖)
  const treeBoxRef = useRef<HTMLDivElement>(null);
  const treeRef = useRef<TreeNode[]>([]);
  const fileRef = useRef<HTMLInputElement>(null);
  const folderRef = useRef<HTMLInputElement>(null);
  const uploadDir = useRef(root);

  treeRef.current = tree;

  const listDir = useCallback(async (p: string): Promise<TreeNode[]> => {
    const r = await fetch(`${API}/fs?path=${encodeURIComponent(p)}${showHidden ? "&hidden=1" : ""}`);
    const d = await r.json();
    if (!r.ok) { setErr(d.error || "读取失败"); return []; }
    setErr("");
    const base = p.replace(/\/+$/, ""); // "/"→""、Windows "C:/"→"C:"，统一拼单斜杠
    const mk = (n: string, dir: boolean, size?: number) => ({ path: base + "/" + n, name: n, dir, size });
    return [
      ...d.dirs.map((n: string) => mk(n, true)),
      ...d.files.map((f: { name: string; size: number }) => mk(f.name, false, f.size)),
    ];
  }, [showHidden]);

  // 展开状态持久化（刷新后树恢复展开；收集当前树 open 的目录写 localStorage）
  const collectOpen = (nodes: TreeNode[]): string[] => {
    const out: string[] = [];
    const walk = (ns: TreeNode[]) => ns.forEach((n) => { if (n.dir && n.open) { out.push(n.path); walk(n.children || []); } });
    walk(nodes);
    return out;
  };
  const persistOpen = (nodes: TreeNode[]) => {
    try { localStorage.setItem("qweb.expanded", JSON.stringify(collectOpen(nodes))); } catch {}
  };
  // 恢复：saved 集合里的目录递归展开（父层必在集合内——展开深层前必先展开父层）
  const restoreOpen = async (nodes: TreeNode[], saved: Set<string>): Promise<TreeNode[]> =>
    Promise.all(nodes.map(async (n) => {
      if (!n.dir || !saved.has(n.path)) return n;
      return { ...n, open: true, loading: false, children: await restoreOpen(await listDir(n.path), saved) };
    }));

  useEffect(() => {
    let saved: Set<string>;
    let savedSel: { paths?: string[]; anchor?: string | null } | null = null;
    try { saved = new Set(JSON.parse(localStorage.getItem("qweb.expanded") || "[]")); } catch { saved = new Set(); }
    try { savedSel = JSON.parse(localStorage.getItem("qweb.sel") || "null"); } catch {}
    (async () => {
      let t = await listDir(root);
      if (saved.size) t = await restoreOpen(t, saved);
      setTree(t);
      // 选中状态恢复（路径可能在未展开层，先全量恢复；展开到那层自然显示选中样式）
      if (savedSel?.paths?.length) {
        setSel(new Set(savedSel.paths));
        anchorRef.current = savedSel.anchor ?? null;
        // 聚焦树容器：treeFocus=false 时当前项只显示失焦淡底，聚焦后恢复"真选中"深底白字
        treeBoxRef.current?.focus();
      }
    })();
  }, [root, listDir]);

  // 选中持久化：sel 变化即写（anchor 一并记录，恢复时"当前项"深底白字不丢）
  useEffect(() => {
    try { localStorage.setItem("qweb.sel", JSON.stringify({ paths: [...sel], anchor: anchorRef.current })); } catch {}
  }, [sel]);

  // 定向刷新：dir 是树中节点则重载其 children 并展开；dir = root 时全量
  // 展开状态迁移:改名/移动目录时,qweb.expanded 里的路径前缀跟随改写
  const migrateExpanded = (from: string, to: string) => {
    try {
      const ex = JSON.parse(localStorage.getItem("qweb.expanded") || "[]") as string[];
      const nx = ex.map((p) => (p === from || p.startsWith(from + "/") ? to + p.slice(from.length) : p));
      localStorage.setItem("qweb.expanded", JSON.stringify(nx));
    } catch {}
  };

  const reloadDir = useCallback(async (dir: string) => {
    if (dir === root) {
      // 整树重建必须带回展开状态(现树展开 ∪ 持久化),否则手工刷新会把树收平
      const open = new Set<string>();
      const walkOpen = (nodes: TreeNode[]) => nodes.forEach((n) => {
        if (n.dir && n.open) { open.add(n.path); if (n.children) walkOpen(n.children); }
      });
      walkOpen(treeRef.current);
      try { for (const p of JSON.parse(localStorage.getItem("qweb.expanded") || "[]")) open.add(p); } catch {}
      treeRef.current = await restoreOpen(await listDir(root), open);
      setTree(treeRef.current);
      return;
    }
    const walk = async (nodes: TreeNode[]): Promise<TreeNode[]> =>
      Promise.all(nodes.map(async (n) => {
        if (!n.dir) return n;
        if (n.path === dir) {
          let openSet = new Set<string>();
          try { openSet = new Set(JSON.parse(localStorage.getItem("qweb.expanded") || "[]")); } catch {}
          return { ...n, open: true, loading: false, children: await restoreOpen(await listDir(n.path), openSet) };
        }
        if (n.open && dir.startsWith(n.path + "/")) return { ...n, children: await walk(n.children || []) };
        return n;
      }));
    treeRef.current = await walk(treeRef.current);
    setTree(treeRef.current);
  }, [root, listDir]);

  // ---- 文件变更自动刷新（零轮询）：订阅当前展开目录，事件定向 reloadDir ----
  // cb 经 ref 取最新 reloadDir（依赖 showHidden 会变）；目录集合序列化作 effect key，
  // reloadDir 换新 tree 但展开集合不变时不重订阅（避免事件间隙丢事件）。
  const reloadRef = useRef(reloadDir);
  reloadRef.current = reloadDir;
  useFsEvent(useCallback((dirs) => { for (const d of dirs) reloadRef.current(d); }, []));
  const openDirsKey = useMemo(() => {
    const out: string[] = [root];
    const walk = (ns: TreeNode[]) => ns.forEach((n) => {
      if (n.dir && n.open) { out.push(n.path); walk(n.children || []); }
    });
    walk(tree);
    return out.join("\n");
  }, [tree, root]);
  useEffect(() => {
    const un = openDirsKey.split("\n").map((d) => watchDir(d));
    return () => un.forEach((f) => f());
  }, [openDirsKey]);

  const doUpload = async (dir: string, files: File[] | FileList | null) => {
    const arr = files ? Array.from(files as ArrayLike<File>) : [];
    if (!arr.length) return;
    setUploading(dir);
    const errs: string[] = [];
    const uploaded = new Set<string>(); // 上传成功项的完整路径（完成后默认选中）
    for (const f of arr) {
      // 文件夹上传：webkitRelativePath 含目录结构（name 带子路径，后端逐级 mkdir）
      const name = ((f as File & { webkitRelativePath?: string }).webkitRelativePath || "") || f.name;
      const r = await fsOp({ op: "upload", path: dir, name, data: await toB64(f) });
      if (!r.ok) errs.push(`${name}: ${r.error || "失败"}`);
      else uploaded.add(dir.replace(/\/+$/, "") + "/" + name.split("/")[0]); // 顶层项（文件夹上传取根目录名）
    }
    if (fileRef.current) fileRef.current.value = "";
    if (folderRef.current) folderRef.current.value = "";
    setUploading(null);
    if (errs.length) setErr("部分上传失败：" + errs.join("；"));
    await reloadDir(dir);
    // 上传完成：新落地的文件/目录默认选中（anchor=最后一项，便于紧接着右键/拖放操作）
    if (uploaded.size) {
      setSel(uploaded);
      anchorRef.current = [...uploaded][uploaded.size - 1];
    }
  };

  // 拷贝文本到剪贴板:优先 clipboard API(需安全上下文),非 https 退 execCommand
  const copyText = async (text: string) => {
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
  };
  const copyPaths = async (paths: string[]) => {
    const ok = await copyText(paths.join("\n"));
    if (ok) toast.success(paths.length > 1 ? `已拷贝 ${paths.length} 条路径` : `已拷贝 ${paths[0]}`);
    else toast.error("拷贝失败(浏览器限制)");
  };

  const download = (n: TreeNode) => {
    const a = document.createElement("a");
    a.href = `/api/fs/download?path=${encodeURIComponent(n.path)}`;
    document.body.append(a);
    a.click();
    a.remove();
  };
  // 删除确认（shadcn 模态，不再用原生 confirm）：单项 / 多选共用
  const [pendingDel, setPendingDel] = useState<{ node?: TreeNode; multi?: boolean } | null>(null);
  // 剪贴板（cut/copy → paste，Windows 资源管理器语义）：cut = 粘贴时 rename 移动
  const [clip, setClip] = useState<{ mode: "cut" | "copy"; paths: string[] } | null>(null);
  // 移动一组路径进目标目录（拖拽与"剪切→粘贴"共用）：逐项 rename，同名/嵌套报错走 toast
  const moveInto = async (paths: string[], dir: string) => {
    const srcParents = new Set<string>();
    const moves: [string, string][] = [];
    for (const p of paths) {
      const name = p.split("/").pop();
      if (dir === p || dir.startsWith(p + "/")) { setErr("不能移动到自身内部"); continue; }
      const to = dir === "/" ? "/" + name : dir + "/" + name;
      const r = await fsOp({ op: "rename", path: p, to });
      if (!r.ok) setErr(r.error || "移动失败");
      else { srcParents.add(parentOf(p)); moves.push([p, to]); }
    }
    for (const [f, t] of moves) migrateExpanded(f, t);
    if (moves.length && onMoved) onMoved(moves);
    setSel(new Set());
    // 源与目标都要刷:只刷目标会让移走的项在老位置残留
    for (const d of srcParents) if (d !== dir) await reloadDir(d);
    await reloadDir(dir);
  };
  const pasteInto = async (dir: string) => {
    if (!clip) return;
    if (clip.mode === "copy") {
      for (const p of clip.paths) {
        const name = p.split("/").pop();
        const to = dir === "/" ? "/" + name : dir + "/" + name;
        const r = await fsOp({ op: "copy", path: p, to });
        if (!r.ok) { setErr(r.error || "复制失败"); break; }
      }
    } else {
      await moveInto(clip.paths, dir);
      setClip(null);
    }
    await reloadDir(dir);
  };
  const removeNode = async (n: TreeNode) => {
    const r = await fsOp({ op: "delete", path: n.path });
    if (!r.ok) { setErr(r.error || "删除失败"); return; }
    setSel(new Set());
    await reloadDir(parentOf(n.path));
  };
  // 多选批量：逐项下载 / 逐项删除
  const downloadAll = async () => {
    for (const p of sel) {
      const a = document.createElement("a");
      a.href = `/api/fs/download?path=${encodeURIComponent(p)}`;
      document.body.append(a);
      a.click();
      a.remove();
      await new Promise((r) => setTimeout(r, 150)); // 间隔触发，防浏览器合并拦截
    }
  };
  const removeAll = async () => {
    const errs: string[] = [];
    for (const p of [...sel]) {
      const r = await fsOp({ op: "delete", path: p });
      if (!r.ok) errs.push(`${p.split("/").pop()}: ${r.error}`);
    }
    if (errs.length) setErr("部分删除失败：" + errs.join("；"));
    setSel(new Set());
    await reloadDir(root);
  };
  // 可视扁平序（shift 范围选/键盘导航用）
  const visiblePaths = useCallback(() => {
    const out: string[] = [];
    const walk = (nodes: TreeNode[]) => {
      for (const n of nodes) {
        out.push(n.path);
        if (n.dir && n.open && n.children) walk(n.children);
      }
    };
    walk(treeRef.current);
    return out;
  }, []);
  const findNode = useCallback((p?: string | null): TreeNode | null => {
    if (!p) return null;
    const walk = (ns: TreeNode[]): TreeNode | null => {
      for (const n of ns) {
        if (n.path === p) return n;
        if (n.dir && n.children) { const r = walk(n.children); if (r) return r; }
      }
      return null;
    };
    return walk(treeRef.current);
  }, []);
  // 键盘导航（VSCode 习惯）：↑↓ 移动、→ 展开/Enter 打开、← 收起/上跳、F2 重命名、Delete 删除
  const onTreeKey = (e: React.KeyboardEvent) => {
    if ((e.target as HTMLElement).tagName === "INPUT") return; // 内联编辑输入框不参与树导航
    const vis = visiblePaths();
    if (!vis.length) return;
    const idx = anchorRef.current ? vis.indexOf(anchorRef.current) : -1;
    const setCursor = (p: string) => {
      anchorRef.current = p;
      setSel(new Set([p]));
      treeBoxRef.current?.querySelector<HTMLElement>(`[data-path="${CSS.escape(p)}"]`)
        ?.scrollIntoView({ block: "nearest" });
    };
    if (e.key === "ArrowDown") { e.preventDefault(); setCursor(vis[Math.min(vis.length - 1, idx + 1)] ?? vis[0]); }
    else if (e.key === "ArrowUp") { e.preventDefault(); setCursor(vis[Math.max(0, idx - 1)] ?? vis[0]); }
    else if (e.key === "ArrowRight" || e.key === "Enter") {
      const n = findNode(anchorRef.current);
      if (!n) return;
      e.preventDefault();
      if (n.dir) { if (!n.open) toggle(n); }
      else onOpenFile(n.path);
    } else if (e.key === "ArrowLeft") {
      const n = findNode(anchorRef.current);
      if (!n) return;
      e.preventDefault();
      if (n.dir && n.open) toggle(n); // 树锁死工作目录内：← 只收起，不再上跳父级
    } else if (e.key === "F2") {
      const n = findNode(anchorRef.current);
      if (n && sel.size === 1) { e.preventDefault(); setEdit({ dir: parentOf(n.path), kind: "rename", oldPath: n.path }); }
    } else if (e.key === "Delete") {
      if (!sel.size) return;
      e.preventDefault();
      if (sel.size > 1) removeAll();
      else { const n = findNode([...sel][0]); if (n) removeNode(n); }
    }
  };
  const submitEdit = async (v: string) => {
    const e0 = edit;
    setEdit(null);
    if (!e0 || !v) return;
    if (v.includes("/")) { setErr("名称不能包含 /"); return; }
    const r = e0.kind === "rename"
      ? await fsOp({ op: "rename", path: e0.oldPath, to: parentOf(e0.oldPath!) + "/" + v })
      : await fsOp({ op: e0.kind === "file" ? "touch" : "mkdir", path: e0.dir, name: v });
    if (!r.ok) { setErr(r.error || "操作失败"); return; }
    if (e0.kind === "rename" && e0.oldPath) {
      // 重命名后新名字保持选中（VSCode 行为；anchor 同步=树聚焦时深底白字当前项）
      const np = parentOf(e0.oldPath) + "/" + v;
      onMoved?.([[e0.oldPath, np]]);
      migrateExpanded(e0.oldPath, np);
      await reloadDir(parentOf(np));
      setSel(new Set([np]));
      anchorRef.current = np;
    } else {
      // 新建的文件/文件夹默认选中（与重命名同款；后续回车/右键直接作用在它上）
      const np = e0.dir === "/" ? "/" + v : e0.dir + "/" + v;
      setSel(new Set([np]));
      anchorRef.current = np;
    }
    await reloadDir(e0.kind === "rename" ? parentOf(e0.oldPath!) : e0.dir);
  };
  const pickFiles = (dir: string, folder: boolean) => {
    uploadDir.current = dir;
    (folder ? folderRef : fileRef).current?.click();
  };

  // 任意处点击/右键/失焦关闭菜单（菜单本体 stopPropagation 防误关）
  useEffect(() => {
    if (!ctx) return;
    const h = () => setCtx(null);
    window.addEventListener("mousedown", h);
    window.addEventListener("contextmenu", h);
    window.addEventListener("blur", h);
    return () => {
      window.removeEventListener("mousedown", h);
      window.removeEventListener("contextmenu", h);
      window.removeEventListener("blur", h);
    };
  }, [ctx]);

  const editIcon = (kind: "file" | "dir" | "rename") =>
    kind === "dir" ? <Folder className="h-3.5 w-3.5 shrink-0 text-[oklch(0.75_0.14_85)]" />
      : <FileIcon className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />;

  const toggle = async (node: TreeNode) => {
    if (!node.dir) { onOpenFile(node.path); return; }
    if (node.children) {
      node.open = !node.open;
      setTree([...tree]);
      persistOpen(tree);
      return;
    }
    node.loading = true;
    setTree([...tree]);
    node.children = await listDir(node.path);
    node.loading = false;
    node.open = true;
    setTree([...tree]);
    persistOpen(tree);
  };

  const renderNode = (n: TreeNode, depth: number) => {
    // 重命名:行内 button 位换成输入行(子树渲染保留——改名过程中子目录不塌)
    const renaming = edit?.kind === "rename" && edit.oldPath === n.path;
    const isSel = sel.has(n.path);
    // VSCode 两级选中：当前操作项（树聚焦时）深底白字；其余选中/失焦选中 = 淡底
    const isCur = isSel && anchorRef.current === n.path;
    const isActive = activeFile === n.path && !n.dir && !isSel;
    return (
      <div key={n.path} className={cn("rounded-sm", dragOver === n.path && "bg-primary/10 outline outline-1 outline-dashed outline-primary")}>
        {renaming ? (
          <EditRow icon={editIcon(n.dir ? "dir" : "file")}
            lead={n.dir ? (n.open ? <ChevronDown className="h-3 w-3 shrink-0 opacity-80" /> : <ChevronRight className="h-3 w-3 shrink-0 opacity-80" />) : undefined}
            indent={depth} initial={n.name} selectBase onOk={submitEdit} onCancel={() => setEdit(null)} />
        ) : (
        <button
          data-path={n.path}
          onClick={(e) => {
            if (e.ctrlKey || e.metaKey || e.shiftKey) return;
            if (sel.size > 1 && sel.has(n.path)) { setSel(new Set([n.path])); anchorRef.current = n.path; }
            toggle(n);
          }}
          onDoubleClick={(e) => {
            // VSCode：双击文件=钉住为正式标签（单击已先开预览）
            if (e.ctrlKey || e.metaKey || e.shiftKey) return;
            if (!n.dir) onOpenFile(n.path, true);
          }}
          onMouseDown={(e) => {
            // 多选：Ctrl 单切 / Shift 锚点范围 / 普通=单选（文件单击打开、目录单击展开）
            if (e.button !== 0) return;
            e.stopPropagation();
            if (e.shiftKey && anchorRef.current) {
              const vis = visiblePaths();
              const a = vis.indexOf(anchorRef.current), b = vis.indexOf(n.path);
              if (a >= 0 && b >= 0) {
                const [s, t] = a < b ? [a, b] : [b, a];
                setSel(new Set(vis.slice(s, t + 1)));
              }
            } else if (e.ctrlKey || e.metaKey) {
              const next = new Set(sel);
              next.has(n.path) ? next.delete(n.path) : next.add(n.path);
              setSel(next);
              anchorRef.current = n.path; // Ctrl 点也更新锚点（Windows 语义：Shift 范围从上次点选起算）
            } else if (!(sel.has(n.path) && sel.size > 1)) {
              // 点在多选集合内不立即坍缩：mousedown 可能是拖拽起点(坍缩会丢多选),
              // 真"点击"由 onClick 收尾坍缩
              setSel(new Set([n.path]));
              anchorRef.current = n.path;
            }
          }}
          onContextMenu={(e) => {
            e.preventDefault(); e.stopPropagation();
            const multi = sel.has(n.path) && sel.size > 1;
            if (!multi) setSel(new Set([n.path]));
            setCtx({ x: e.clientX, y: e.clientY, node: n, multi });
          }}
          draggable
          onDragStart={(e) => {
            // 树内拖拽移动：多选时拖整组；dataTransfer 私有类型 kp 与外部文件拖入上传分流
            const paths = sel.has(n.path) && sel.size > 1 ? [...sel] : [n.path];
            dragPathsRef.current = paths;
            e.dataTransfer.setData("kp", JSON.stringify(paths));
            e.dataTransfer.effectAllowed = "move";
          }}
          onDragEnd={() => { dragPathsRef.current = []; }}
          // 拖拽集合内的目录不是合法落点:连冒泡一起断(否则落到 aside 兜底 = 意外移动到根)
          onDragOver={n.dir ? (e) => {
            if (dragPathsRef.current.includes(n.path)) { e.stopPropagation(); return; }
            e.preventDefault(); e.stopPropagation(); setDragOver(n.path);
          } : (e) => { e.preventDefault(); e.stopPropagation(); setDragOver(parentOf(n.path)); }}
          onDragLeave={n.dir ? (e) => { if (!e.currentTarget.contains(e.relatedTarget as Node)) setDragOver(null); } : (e) => { if (!e.currentTarget.contains(e.relatedTarget as Node)) setDragOver(null); }}
          onDrop={n.dir ? (e) => {
            e.preventDefault(); e.stopPropagation(); setDragOver(null);
            const kp = e.dataTransfer.getData("kp");
            if (kp) {
              // 树内：移动(rename)；拖到自身/子孙目录的防护在 moveInto/server rename
              const paths: string[] = JSON.parse(kp).filter((p: string) => p !== n.path);
              if (paths.length) moveInto(paths, n.path);
            } else doUpload(n.path, e.dataTransfer.files); // 外部文件：上传（原行为）
          } : (e) => {
            // 文件行=父目录的就近落点(目录展开区域里拖到子文件上也应能放进该目录)
            e.preventDefault(); e.stopPropagation(); setDragOver(null);
            const kp = e.dataTransfer.getData("kp");
            if (!kp) { doUpload(parentOf(n.path), e.dataTransfer.files); return; }
            const paths: string[] = JSON.parse(kp).filter((p: string) => p !== parentOf(n.path));
            if (paths.length) moveInto(paths, parentOf(n.path));
          }}
          className={cn(
            "flex w-full items-center gap-1 rounded-sm py-[3px] pr-2 text-left text-xs",
            // VSCode 层级：当前选中(深底白字) > 其余选中/失焦选中(淡底) > 编辑器打开(仅文字加重) > 拖放(虚线框) > hover
            !isSel && "hover:bg-foreground/10",
            // 选中一律同色(单选/多选统一):不透明亮杏橙(深底刺眼/透明底不可见的折中)
            isSel && "bg-[oklch(0.85_0.10_65)] font-medium",
            isActive && "font-medium text-foreground",

          )}
          style={{ paddingLeft: depth * 12 + 6 }}
        >
          {n.dir ? (
            <>
              {n.loading ? <Loader2 className="h-3 w-3 shrink-0 animate-spin opacity-80" /> : n.open ? <ChevronDown className="h-3 w-3 shrink-0 opacity-80" /> : <ChevronRight className="h-3 w-3 shrink-0 opacity-80" />}
              {n.open
                ? <FolderOpen className={cn("h-3.5 w-3.5 shrink-0", isSel ? "text-foreground" : "text-[oklch(0.75_0.14_85)]")} />
                : <Folder className={cn("h-3.5 w-3.5 shrink-0", isSel ? "text-foreground" : "text-[oklch(0.75_0.14_85)]")} />}
            </>
          ) : (
            <>
              <span className="w-3 shrink-0" />
              <FileGlyph name={n.name} className="h-3.5 w-3.5 shrink-0" />
            </>
          )}
          <span className="min-w-0 flex-1 truncate">{n.name}</span>
          {!n.dir && n.size != null && (
            <span className={cn("ml-auto shrink-0 pl-2 text-[0.625rem]", treeFocus && isCur ? "text-white/70" : "text-muted-foreground/50")}>
              {fmtSize(n.size)}
            </span>
          )}
        </button>
        )}
        {n.dir && n.open && edit?.dir === n.path && edit.kind !== "rename" && (
          <EditRow icon={editIcon(edit.kind)} indent={depth + 1} initial="" onOk={submitEdit} onCancel={() => setEdit(null)} />
        )}
        {n.dir && n.open && n.children?.map((c) => renderNode(c, depth + 1))}
      </div>
    );
  };

  return (
    <aside
      // min-h-0：浮层 wrapper 是列向 flex、aside 是其主轴子项——不钳 min-height:auto
      // 会被长树内容顶破浮层高度（树区 flex-1 overflow-y-auto 随之失去滚动）
      className="relative flex min-h-0 w-full select-none flex-col bg-card/30"
      onContextMenu={(e) => {
        // stopPropagation：防冒泡到 window 关菜单监听（否则开着菜单时空白右键会被立即关掉，"第一次不灵"）
        e.preventDefault(); e.stopPropagation();
        setSel(new Set());
        setCtx({ x: e.clientX, y: e.clientY, node: null });
      }}
      onDragOver={(e) => e.preventDefault()}
      onDrop={(e) => {
        e.preventDefault(); setDragOver(null);
        // 空白区(树内容外)= 浏览目标目录:树内拖拽落此=移入,外部文件=上传
        // (文件行/目录行均已 stopPropagation,能到这里的只有真空白)
        const kp = e.dataTransfer.getData("kp");
        if (kp) {
          const paths: string[] = JSON.parse(kp).filter((p: string) => p !== root);
          if (paths.length) moveInto(paths, root);
        } else doUpload(root, e.dataTransfer.files);
      }}
    >
      <div className="flex items-center gap-1 px-3 py-2 text-[0.625rem] font-semibold uppercase tracking-wider text-muted-foreground">
        资源管理器
        <span className="ml-auto flex items-center gap-1">
          {uploading && <span className="text-primary/80">上传中…</span>}
          <button className={cn("rounded p-0.5 hover:bg-accent", showHidden && "text-primary")}
            title={showHidden ? "隐藏文件：显示中（点击隐藏）" : "隐藏文件：已隐藏（点击显示）"}
            onClick={() => setShowHidden((v) => !v)}>
            {showHidden ? <Eye className="h-3 w-3" /> : <EyeOff className="h-3 w-3" />}
          </button>
          <button className="rounded p-0.5 hover:bg-accent" title="刷新"
            onClick={() => reloadDir(root)}>
            <RefreshCw className={cn("h-3 w-3", uploading && "animate-spin")} />
          </button>
          {onClose && (
            <button className="rounded p-0.5 text-muted-foreground hover:bg-accent hover:text-foreground" title="关闭面板"
              onClick={onClose}>
              <X className="h-3 w-3" />
            </button>
          )}
        </span>
      </div>
      {err && <ErrToast msg={err} clear={() => setErr("")} />}
      <div
        ref={treeBoxRef}
        tabIndex={0}
        className={cn("relative flex-1 overflow-y-auto pb-2 outline-none", blankDrag && "bg-primary/10 outline outline-1 outline-dashed outline-primary")}
        onFocus={() => setTreeFocus(true)}
        onBlur={() => setTreeFocus(false)}
        onKeyDown={onTreeKey}
        onMouseDown={(e) => {
          // 点空白 = 清空选集（此后右键/拖放/上传均作用于当前工作目录）+ 启动框选
          if (e.button !== 0) return;
          setSel(new Set());
          anchorRef.current = null;
          const x0 = e.clientX, y0 = e.clientY;
          const base = e.ctrlKey || e.metaKey ? new Set(sel) : new Set<string>();
          let moved = false;
          const move = (ev: MouseEvent) => {
            if (!moved && Math.hypot(ev.clientX - x0, ev.clientY - y0) < 4) return;
            moved = true;
            ev.preventDefault();
            setMarq({ x0, y0, x1: ev.clientX, y1: ev.clientY });
            // 实时命中：与行矩形相交即选中
            const l = Math.min(x0, ev.clientX), r = Math.max(x0, ev.clientX);
            const t = Math.min(y0, ev.clientY), b = Math.max(y0, ev.clientY);
            const hits = new Set(base);
            treeBoxRef.current?.querySelectorAll<HTMLElement>("[data-path]").forEach((el) => {
              const rc = el.getBoundingClientRect();
              if (rc.right > l && rc.left < r && rc.bottom > t && rc.top < b) hits.add(el.dataset.path!);
            });
            setSel(hits);
          };
          const up = () => {
            window.removeEventListener("mousemove", move);
            window.removeEventListener("mouseup", up);
            setMarq(null);
          };
          window.addEventListener("mousemove", move);
          window.addEventListener("mouseup", up);
        }}
      >
        {edit && edit.dir === root && edit.kind !== "rename" && (
          <EditRow icon={editIcon(edit.kind)} initial="" onOk={submitEdit} onCancel={() => setEdit(null)} />
        )}
        {tree.map((n) => renderNode(n, 0))}
        {/* 树下方空白:drop=当前工作目录,悬停整块高亮 */}
        <div
          className="min-h-40 flex-1"
          onDragOver={(e) => { e.preventDefault(); e.stopPropagation(); setBlankDrag(true); }}
          onDragLeave={(e) => { if (!e.currentTarget.contains(e.relatedTarget as Node)) setBlankDrag(false); }}
          onDrop={(e) => {
            e.preventDefault(); e.stopPropagation(); setBlankDrag(false);
            const kp = e.dataTransfer.getData("kp");
            if (kp) {
              const paths: string[] = JSON.parse(kp).filter((p: string) => p !== root);
              if (paths.length) moveInto(paths, root);
            } else doUpload(root, e.dataTransfer.files);
          }}
        />
        {!tree.length && !err && <p className="p-3 text-center text-[0.625rem] text-muted-foreground/70">空目录</p>}
        {/* 框选虚线框（client 坐标 → 容器相对坐标） */}
        {marq && treeBoxRef.current && (() => {
          const rc = treeBoxRef.current.getBoundingClientRect();
          return (
            <div className="pointer-events-none absolute z-10 border border-dashed border-primary/70 bg-primary/10"
              style={{
                left: Math.min(marq.x0, marq.x1) - rc.left,
                top: Math.min(marq.y0, marq.y1) - rc.top,
                width: Math.abs(marq.x1 - marq.x0),
                height: Math.abs(marq.y1 - marq.y0),
              }} />
          );
        })()}
      </div>

      {/* 隐藏的上传输入（文件夹模式经 webkitdirectory 保留目录结构） */}
      <input ref={fileRef} type="file" multiple hidden
        onChange={(e) => doUpload(uploadDir.current, e.target.files)} />
      <input ref={folderRef} type="file" hidden multiple
        {...({ webkitdirectory: "", directory: "" } as any)}
        onChange={(e) => doUpload(uploadDir.current, e.target.files)} />

      {/* 右键菜单（fixed 定位，点外部关闭） */}
      {ctx && (() => {
        const n = ctx.node;
        return (
          <div
            className="fixed z-50 min-w-44 rounded-md border border-border bg-popover py-1 text-xs shadow-xl"
            style={{
              left: Math.min(ctx.x, window.innerWidth - 190),
              top: Math.min(ctx.y, window.innerHeight - 270),
            }}
            onMouseDown={(e) => e.stopPropagation()}
            onContextMenu={(e) => e.preventDefault()}
          >
            {ctx.multi ? (
              <>
                <MI close={() => setCtx(null)} icon={Scissors} label={`剪切 ${sel.size} 项`} onClick={() => setClip({ mode: "cut", paths: [...sel] })} />
                <MI close={() => setCtx(null)} icon={Copy} label={`复制 ${sel.size} 项`} onClick={() => setClip({ mode: "copy", paths: [...sel] })} />
                <MI close={() => setCtx(null)} icon={ClipboardCopy} label={`拷贝路径(${sel.size})`} onClick={() => copyPaths([...sel])} />
                <div className="my-1 h-px bg-border/60" />
                <MI close={() => setCtx(null)} icon={Download} label={`下载 ${sel.size} 项`} onClick={downloadAll} />
                <div className="my-1 h-px bg-border/60" />
                <MI close={() => setCtx(null)} icon={Trash2} label={`删除 ${sel.size} 项`} danger onClick={() => setPendingDel({ multi: true })} />
              </>
            ) : n?.dir ? (
              <>
                <MI close={() => setCtx(null)} icon={ClipboardCopy} label="拷贝路径" onClick={() => copyPaths([n.path])} />
                {/* 容器管理暂缓（2026-11-06 定案：改 SSH 直连去 keeperd，这版先出），菜单项已删 */}
                <MI close={() => setCtx(null)} icon={Scissors} label="剪切" onClick={() => setClip({ mode: "cut", paths: [n.path] })} />
                <MI close={() => setCtx(null)} icon={Copy} label="复制" onClick={() => setClip({ mode: "copy", paths: [n.path] })} />
                <MI close={() => setCtx(null)} icon={ClipboardPaste} label="粘贴" disabled={!clip} onClick={() => pasteInto(n.path)} />
                <div className="my-1 h-px bg-border/60" />
                <MI close={() => setCtx(null)} icon={FilePlus2} label="新建文件" onClick={() => setEdit({ dir: n.path, kind: "file" })} />
                <MI close={() => setCtx(null)} icon={FolderPlus} label="新建文件夹" onClick={() => setEdit({ dir: n.path, kind: "dir" })} />
                <MI close={() => setCtx(null)} icon={Upload} label="上传文件…" onClick={() => pickFiles(n.path, false)} />
                <MI close={() => setCtx(null)} icon={Upload} label="上传文件夹…" onClick={() => pickFiles(n.path, true)} />
                <div className="my-1 h-px bg-border/60" />
                <MI close={() => setCtx(null)} icon={Download} label="下载（tar.gz）" onClick={() => download(n)} />
                <MI close={() => setCtx(null)} icon={Pencil} label="重命名" onClick={() => setEdit({ dir: parentOf(n.path), kind: "rename", oldPath: n.path })} />
                <MI close={() => setCtx(null)} icon={Trash2} label="删除" danger onClick={() => setPendingDel({ node: n })} />
              </>
            ) : n ? (
              <>
                <MI close={() => setCtx(null)} icon={FileIcon} label="打开" onClick={() => onOpenFile(n.path)} />
                <MI close={() => setCtx(null)} icon={ClipboardCopy} label="拷贝路径" onClick={() => copyPaths([n.path])} />
                <MI close={() => setCtx(null)} icon={Download} label="下载" onClick={() => download(n)} />
                <div className="my-1 h-px bg-border/60" />
                <MI close={() => setCtx(null)} icon={Scissors} label="剪切" onClick={() => setClip({ mode: "cut", paths: [n.path] })} />
                <MI close={() => setCtx(null)} icon={Copy} label="复制" onClick={() => setClip({ mode: "copy", paths: [n.path] })} />
                <div className="my-1 h-px bg-border/60" />
                <MI close={() => setCtx(null)} icon={Pencil} label="重命名" onClick={() => setEdit({ dir: parentOf(n.path), kind: "rename", oldPath: n.path })} />
                <MI close={() => setCtx(null)} icon={Trash2} label="删除" danger onClick={() => setPendingDel({ node: n })} />
              </>
            ) : (
              <>
                <MI close={() => setCtx(null)} icon={ClipboardPaste} label={`粘贴${clip ? `（${clip.paths.length} 项${clip.mode === "cut" ? "，剪切" : ""}）` : ""}`} disabled={!clip} onClick={() => pasteInto(root)} />
                <div className="my-1 h-px bg-border/60" />
                <MI close={() => setCtx(null)} icon={FilePlus2} label="新建文件" onClick={() => setEdit({ dir: root, kind: "file" })} />
                <MI close={() => setCtx(null)} icon={FolderPlus} label="新建文件夹" onClick={() => setEdit({ dir: root, kind: "dir" })} />
                <MI close={() => setCtx(null)} icon={Upload} label="上传文件…" onClick={() => pickFiles(root, false)} />
                <MI close={() => setCtx(null)} icon={Upload} label="上传文件夹…" onClick={() => pickFiles(root, true)} />
                <div className="my-1 h-px bg-border/60" />
                <MI close={() => setCtx(null)} icon={RefreshCw} label="刷新" onClick={() => reloadDir(root)} />
              </>
            )}
          </div>
        );
      })()}
      <ConfirmDialog
        open={!!pendingDel}
        title="删除确认"
        desc={pendingDel?.multi
          ? `删除选中的 ${sel.size} 项？目录将递归删除。`
          : `删除 ${pendingDel?.node?.name}${pendingDel?.node?.dir ? "（目录将递归删除）" : ""}？`}
        confirmText="删除" danger
        onCancel={() => setPendingDel(null)}
        onConfirm={async () => {
          const d = pendingDel;
          setPendingDel(null);
          if (d?.multi) await removeAll();
          else if (d?.node) await removeNode(d.node);
        }}
      />
    </aside>
  );
}
