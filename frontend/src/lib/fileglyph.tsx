// 文件类型图标：按扩展名给不同的 lucide File* 图标 + 类型色（与目录金黄同思路）。
// 零新依赖；未知扩展退回灰色通用 File。选中态覆盖用 tailwind important（text-white!）
import { File, FileText, FileImage, FileAudio, FileVideo, FileCode, FileJson, FileArchive, FileSpreadsheet } from "lucide-react";

type Entry = [string[], typeof File, string];
// eslint-disable-next-line @typescript-eslint/no-unused-vars
const GROUPS: Entry[] = [
  [["pdf"], FileText, "text-red-500"],
  [["png", "jpg", "jpeg", "gif", "svg", "webp", "bmp", "ico", "avif"], FileImage, "text-violet-500"],
  [["js", "mjs", "cjs", "ts", "tsx", "jsx", "py", "rs", "go", "java", "c", "h", "cpp", "hpp", "sh", "bash", "html", "css", "scss", "vue", "svelte", "rb", "php", "sql", "lua"], FileCode, "text-sky-500"],
  [["json", "yaml", "yml", "toml", "xml"], FileJson, "text-amber-500"],
  [["zip", "tar", "gz", "tgz", "bz2", "xz", "zst", "7z", "rar"], FileArchive, "text-orange-500"],
  [["xls", "xlsx", "csv", "tsv", "ods"], FileSpreadsheet, "text-emerald-600"],
  [["mp3", "wav", "flac", "ogg", "m4a", "aac"], FileAudio, "text-pink-500"],
  [["mp4", "mkv", "avi", "mov", "webm", "flv"], FileVideo, "text-indigo-500"],
  [["md", "markdown", "txt", "log", "conf", "ini", "env", "cfg"], FileText, "text-slate-400"],
];
const MAP = new Map<string, [typeof File, string]>(GROUPS.flatMap(([exts, I, c]) => exts.map((e) => [e, [I, c]] as const)));

export function FileGlyph({ name, className }: { name: string; className?: string }) {
  const ext = (name.includes(".") ? name.split(".").pop()! : "").toLowerCase();
  const [Icon, color] = MAP.get(ext) || [File, "text-muted-foreground/60"];
  return <Icon className={className ? `${className} ${color}` : color} />;
}
