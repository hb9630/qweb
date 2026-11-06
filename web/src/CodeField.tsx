// CodeMirror 6 编辑器宿主（模块级定义，引用稳定）。
// - 按扩展名选语言高亮；值只在挂载时灌入，编辑经 onChange 单向上抛（不回写，避免光标跳动）
// - Mod-S 在编辑器内绑定保存；jsdom 回归测试环境走 textarea 兜底（CM 需要真实布局 API）
import { useEffect, useRef, useState } from "react";
import { EditorView, basicSetup } from "codemirror";
import { EditorState } from "@codemirror/state";
import { keymap } from "@codemirror/view";
import { oneDark } from "@codemirror/theme-one-dark";
import { json } from "@codemirror/lang-json";
import { html } from "@codemirror/lang-html";
import { css } from "@codemirror/lang-css";
import { javascript } from "@codemirror/lang-javascript";
import { python } from "@codemirror/lang-python";
import { markdown } from "@codemirror/lang-markdown";
import { StreamLanguage } from "@codemirror/language";
import { shell } from "@codemirror/legacy-modes/mode/shell";

function langOf(path: string, firstLine = "") {
  switch (path.split(".").pop()?.toLowerCase()) {
    case "json": return json();
    case "html": case "htm": case "xml": case "svg": return html();
    case "css": return css();
    case "js": case "jsx": case "mjs": case "cjs": return javascript();
    case "ts": case "tsx": return javascript({ typescript: true });
    case "py": return python();
    case "md": case "markdown": return markdown();
    case "sh": case "bash": case "zsh": case "ksh": return StreamLanguage.define(shell);
  }
  // 无扩展名脚本看 shebang（setup/run 这类）
  const base = path.split("/").pop() ?? path;
  if (!base.includes(".") && firstLine.startsWith("#!")) {
    if (/(ba|z|k|da)?sh\b/.test(firstLine)) return StreamLanguage.define(shell);
    if (/python/.test(firstLine)) return python();
    if (/node/.test(firstLine)) return javascript();
  }
  return null;
}

export default function CodeField({
  path, value, onChange, onSave,
}: {
  path: string; value: string; onChange: (v: string) => void; onSave: () => void;
}) {
  const host = useRef<HTMLDivElement>(null);
  const [fallback, setFallback] = useState(false);
  const onChangeRef = useRef(onChange); onChangeRef.current = onChange;
  const onSaveRef = useRef(onSave); onSaveRef.current = onSave;
  // 外部值同步（磁盘变更 live reload）：记录最后上报/接收值，仅 value 变化非源于
  // 本编辑器时整档替换——用户正在编辑的文档永不被外部更新打断（dirty 冲突在 Editor 层裁决）
  const viewRef = useRef<EditorView | null>(null);
  const lastSync = useRef(value);

  useEffect(() => {
    if (navigator.userAgent.includes("jsdom") || !host.current) { setFallback(true); return; }
    const view = new EditorView({
      state: EditorState.create({
        doc: value,
        extensions: [
          keymap.of([{ key: "Mod-s", run: () => { onSaveRef.current(); return true; } }]),
          basicSetup,
          langOf(path, value.split("\n")[0] ?? "") ?? [],
          matchMedia("(prefers-color-scheme: dark)").matches ? oneDark : [],
          EditorView.theme({
            "&": { fontSize: "0.75rem", height: "100%" },
            ".cm-scroller": { overflow: "auto", fontFamily: "ui-monospace, monospace" },
          }),
          EditorView.updateListener.of((u) => {
            if (!u.docChanged) return;
            const s = u.state.doc.toString();
            lastSync.current = s; // 自己编辑产生的新值视为已同步
            onChangeRef.current(s);
          }),
        ],
      }),
      parent: host.current,
    });
    viewRef.current = view;
    lastSync.current = value;
    return () => { viewRef.current = null; view.destroy(); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [path]);

  useEffect(() => {
    if (value === lastSync.current) return;
    lastSync.current = value;
    const view = viewRef.current;
    if (!view) return;
    view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: value } });
  }, [value]);

  if (fallback) {
    return (
      <textarea
        value={value} spellCheck={false}
        onChange={(e) => onChange(e.target.value)}
        className="h-full w-full resize-none bg-background p-4 font-mono text-xs leading-relaxed text-foreground/90 outline-none"
      />
    );
  }
  return <div ref={host} className="h-full w-full overflow-hidden" />;
}
