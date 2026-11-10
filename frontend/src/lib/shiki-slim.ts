// 精简 shiki 门面：vite.config 的 alias 把裸 "shiki" 重定向到本文件
// （与 mermaid stub 同款打包期手段）。背景：@streamdown/code（聊天 markdown 代码
// 高亮）与 ai-elements/code-block 从全量 shiki 引 bundledLanguages——300+ 语言语法
// 全部进产物（dist 12MB / 350+ 文件 / 主 chunk 2.2MB）。聊天输出的语言面很窄：
// 这里只登记常用 ~30 种（保持按需懒加载），未登记语言沿用调用方原有回落（纯文本）。
import { createHighlighterCore } from "shiki/core";
import { createJavaScriptRegexEngine } from "shiki/engine/javascript";

type Loader = () => Promise<{ default: any }>;

// 常用语言 id → 懒加载 grammar（@shikijs/langs 与 shiki 同源同版本，类型自带）
const LANGS: Record<string, Loader> = {
  typescript: () => import("@shikijs/langs/typescript"),
  tsx: () => import("@shikijs/langs/tsx"),
  javascript: () => import("@shikijs/langs/javascript"),
  jsx: () => import("@shikijs/langs/jsx"),
  json: () => import("@shikijs/langs/json"),
  jsonc: () => import("@shikijs/langs/jsonc"),
  python: () => import("@shikijs/langs/python"),
  rust: () => import("@shikijs/langs/rust"),
  go: () => import("@shikijs/langs/go"),
  java: () => import("@shikijs/langs/java"),
  c: () => import("@shikijs/langs/c"),
  cpp: () => import("@shikijs/langs/cpp"),
  csharp: () => import("@shikijs/langs/csharp"),
  css: () => import("@shikijs/langs/css"),
  scss: () => import("@shikijs/langs/scss"),
  html: () => import("@shikijs/langs/html"),
  xml: () => import("@shikijs/langs/xml"),
  markdown: () => import("@shikijs/langs/markdown"),
  yaml: () => import("@shikijs/langs/yaml"),
  toml: () => import("@shikijs/langs/toml"),
  ini: () => import("@shikijs/langs/ini"),
  sql: () => import("@shikijs/langs/sql"),
  bash: () => import("@shikijs/langs/bash"),
  shellscript: () => import("@shikijs/langs/shellscript"),
  dockerfile: () => import("@shikijs/langs/dockerfile"),
  diff: () => import("@shikijs/langs/diff"),
  vue: () => import("@shikijs/langs/vue"),
  kotlin: () => import("@shikijs/langs/kotlin"),
  protobuf: () => import("@shikijs/langs/protobuf"),
};

// 别名 → id（@streamdown/code 经 bundledLanguagesInfo.aliases 建别名索引）
const ALIASES: Record<string, string> = {
  ts: "typescript", js: "javascript", py: "python", rs: "rust",
  sh: "bash", zsh: "bash", shell: "bash", "c++": "cpp", cs: "csharp", "c#": "csharp",
  yml: "yaml", md: "markdown", docker: "dockerfile", kt: "kotlin",
  proto: "protobuf", properties: "ini",
};

const THEMES: Record<string, Loader> = {
  "github-light": () => import("@shikijs/themes/github-light"),
  "github-dark": () => import("@shikijs/themes/github-dark"),
};

// —— 与全量 shiki 同名同形的注册表（消费方：@streamdown/code、code-block.tsx）——
export const bundledLanguages: Record<string, Loader> = { ...LANGS };
for (const [alias, id] of Object.entries(ALIASES)) bundledLanguages[alias] = LANGS[id];
export const bundledLanguagesInfo = Object.keys(LANGS).map((id) => ({
  id,
  name: id,
  import: LANGS[id],
  aliases: Object.entries(ALIASES).filter(([, t]) => t === id).map(([a]) => a),
}));
export const bundledThemes: Record<string, Loader> = { ...THEMES };

// text/plain/ansi：core 免注册的特殊语言（无需 grammar）
const SPECIAL = new Set(["text", "plain", "ansi"]);

// 同形 createHighlighter：langs/themes 经精简注册表解析（动态 import 惰性加载）；
// 引擎默认 JS regex（与 @streamdown/code 一致，免去 oniguruma wasm ~600KB）
export async function createHighlighter(opts: {
  langs?: string[];
  themes?: string[];
  engine?: unknown;
} = {}) {
  const themes = opts.themes?.length ? opts.themes : ["github-light", "github-dark"];
  return createHighlighterCore({
    engine: (opts.engine as never) ?? createJavaScriptRegexEngine({ forgiving: true }),
    themes: themes.map((t) => (THEMES[t] ?? THEMES["github-light"])()),
    // LanguageInput 不收裸字符串（注册表内 id 由工厂解析）——map 结果放宽为 any
    langs: (opts.langs ?? []).map((l): any => {
      const load = bundledLanguages[l];
      if (load) return load();
      return SPECIAL.has(l) ? l : "text"; // 未登记语言 → 纯文本
    }),
  });
}
