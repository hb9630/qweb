// 工具集六件套 + 路径守卫 + tools schema + 系统提示词。
// 全部为纯逻辑（bash 走 tokio::process），审批在 agent 层（bash 必问）。
use serde_json::{json, Value};
use std::path::{Path, PathBuf};

/// 词法规范化并限制在 cwd 内（拒绝逃逸）。文件类工具统一入口。
pub fn resolve(cwd: &str, p: &str) -> Result<PathBuf, String> {
    let raw = p.trim();
    if raw.is_empty() {
        return Err("path is empty".into());
    }
    let joined = if raw.starts_with('/') || (raw.len() > 1 && raw.as_bytes()[1] == b':') {
        PathBuf::from(raw) // 绝对路径（含盘符）
    } else {
        Path::new(cwd).join(raw)
    };
    let mut norm: Vec<std::ffi::OsString> = vec![];
    for seg in joined.iter() {
        match seg.to_str() {
            Some(".") | Some("") => {}
            Some("..") => {
                if norm.pop().is_none() {
                    return Err(format!("path outside session cwd: {p}"));
                }
            }
            _ => norm.push(seg.to_os_string()),
        }
    }
    let out: PathBuf = norm.into_iter().collect();
    // 根路径逃逸检查（.. 抵到根后再 .. 会 pop 空）已在上面拦截；再核最终在 cwd 下
    let cwd_n = normalize_root(Path::new(cwd));
    if !out.starts_with(&cwd_n) {
        return Err(format!("path outside session cwd: {p}"));
    }
    Ok(out)
}

fn normalize_root(p: &Path) -> PathBuf {
    let mut v: Vec<_> = p.iter().collect();
    // 尾部冗余段压缩（/a/b/ 与 /a/b 等价）
    while v.len() > 1 && (v.last().unwrap() == &"." || v.last().unwrap() == &"") {
        v.pop();
    }
    v.into_iter().collect()
}

const READ_CAP: usize = 256 * 1024;
const OUT_CAP: usize = 64 * 1024;

pub async fn read_file(cwd: &str, input: &Value) -> Result<String, String> {
    let path = resolve(cwd, str_arg(input, "path")?)?;
    let data = tokio::fs::read(&path).await.map_err(|e| format!("{path:?}: {e}"))?;
    if data.windows(8).take(1000).any(|w| w.contains(&0)) || data.contains(&0) {
        return Err(format!("{path:?}: binary file"));
    }
    let text = String::from_utf8_lossy(&data).into_owned();
    let offset = input.get("offset").and_then(|v| v.as_u64()).unwrap_or(1).max(1) as usize;
    let limit = input.get("limit").and_then(|v| v.as_u64()).unwrap_or(2000) as usize;
    let lines: Vec<&str> = text.lines().skip(offset - 1).take(limit).collect();
    let mut out = String::new();
    for (i, l) in lines.iter().enumerate() {
        out.push_str(&format!("{}\t{}\n", offset + i, l));
        if out.len() > READ_CAP {
            out.push_str("… (truncated)\n");
            break;
        }
    }
    if out.is_empty() {
        out.push_str("(empty)\n");
    }
    Ok(out)
}

pub async fn write_file(cwd: &str, input: &Value) -> Result<String, String> {
    let path = resolve(cwd, str_arg(input, "path")?)?;
    let content = str_arg(input, "content")?;
    if let Some(dir) = path.parent() {
        tokio::fs::create_dir_all(dir).await.map_err(|e| format!("{dir:?}: {e}"))?;
    }
    let n = content.len();
    tokio::fs::write(&path, content).await.map_err(|e| format!("{path:?}: {e}"))?;
    Ok(format!("wrote {n} bytes"))
}

pub async fn edit(cwd: &str, input: &Value) -> Result<String, String> {
    let path = resolve(cwd, str_arg(input, "path")?)?;
    let old = str_arg(input, "old_str")?;
    let new = str_arg(input, "new_str")?;
    let all = input.get("replace_all").and_then(|v| v.as_bool()).unwrap_or(false);
    let text = tokio::fs::read_to_string(&path).await.map_err(|e| format!("{path:?}: {e}"))?;
    let n = text.matches(&old).count();
    if n == 0 {
        return Err("old_str not found".into());
    }
    if n > 1 && !all {
        return Err(format!("old_str not unique ({n} occurrences); pass replace_all=true or add context"));
    }
    let out = if all { text.replace(&old, &new) } else { text.replacen(&old, &new, 1) };
    tokio::fs::write(&path, out).await.map_err(|e| format!("{path:?}: {e}"))?;
    Ok(format!("replaced {n} occurrence(s)"))
}

/// bash 执行（审批由 agent 层先行）。kill_on_drop：await 被 drop 即整组终止。
pub async fn bash(cwd: &str, env_home: &str, input: &Value) -> Result<String, String> {
    let cmd = str_arg(input, "command")?;
    let timeout = input.get("timeout_ms").and_then(|v| v.as_u64()).unwrap_or(30_000).min(120_000);
    // Windows 系统 PATH 无 sh：取 Git for Windows 常规装位（命中前缀带 .exe 的完整路径）
    #[cfg(windows)]
    let sh = [r"C:\Program Files\Git\bin\sh.exe", r"C:\Program Files\Git\usr\bin\sh.exe"]
        .into_iter().find(|c| Path::new(c).exists()).unwrap_or("sh");
    #[cfg(not(windows))]
    let sh = "sh";
    let mut c = tokio::process::Command::new(sh);
    c.arg("-c").arg(&cmd).current_dir(cwd).env("HOME", env_home).env("TERM", "xterm-256color")
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .kill_on_drop(true);
    #[cfg(unix)]
    c.process_group(0); // 整组信号清理（与 ccweb spawn claude 同款）
    #[cfg(not(unix))]
    let _ = &mut c;
    let mut child = c.spawn().map_err(|e| format!("spawn sh: {e}"))?;
    let mut stdout = child.stdout.take().unwrap();
    let mut stderr = child.stderr.take().unwrap();
    let status = tokio::select! {
        st = child.wait() => st.map_err(|e| e.to_string())?,
        _ = tokio::time::sleep(std::time::Duration::from_millis(timeout)) => {
            return Err(format!("timed out after {timeout}ms"));
        }
    };
    use tokio::io::AsyncReadExt;
    let mut o = String::new();
    let _ = stdout.read_to_string(&mut o).await;
    let mut e = String::new();
    let _ = stderr.read_to_string(&mut e).await;
    let mut out = format!("{o}{e}");
    if out.len() > OUT_CAP {
        out = out.chars().take(OUT_CAP).collect::<String>() + "\n… (output truncated)";
    }
    if out.is_empty() {
        out = "(no output)".into();
    }
    Ok(format!("{out}\n(exit {})", status.code().unwrap_or(-1)))
}

const SKIP_DIRS: [&str; 4] = [".git", "node_modules", "target", ".venv"];
const WALK_CAP: usize = 2000;
const MATCH_CAP: usize = 200;
const MAX_DEPTH: usize = 8;

pub async fn glob(cwd: &str, input: &Value) -> Result<String, String> {
    let pattern = str_arg(input, "pattern")?;
    let root = if let Some(sub) = input.get("path").and_then(|v| v.as_str()) {
        resolve(cwd, sub)?
    } else {
        PathBuf::from(cwd)
    };
    let mut hits = vec![];
    walk(&root, "", 0, &mut |rel, is_dir| {
        if is_dir {
            return true;
        }
        if glob_match(&pattern, rel) {
            hits.push(rel.to_string());
        }
        hits.len() < WALK_CAP
    });
    if hits.is_empty() {
        return Ok("no matches".into());
    }
    let mut s = hits.join("\n");
    if hits.len() >= WALK_CAP {
        s.push_str(&format!("\n… (capped at {WALK_CAP})"));
    }
    Ok(s)
}

pub async fn grep(cwd: &str, input: &Value) -> Result<String, String> {
    let pattern = str_arg(input, "pattern")?;
    let include = input.get("include").and_then(|v| v.as_str()).unwrap_or("");
    let root = if let Some(sub) = input.get("path").and_then(|v| v.as_str()) {
        resolve(cwd, sub)?
    } else {
        PathBuf::from(cwd)
    };
    let mut lines = vec![];
    walk(&root, "", 0, &mut |rel, is_dir| {
        if is_dir {
            return true;
        }
        if !include.is_empty() && !rel.ends_with(include) {
            return true;
        }
        if let Ok(text) = std::fs::read_to_string(root.join(rel)) {
            for (i, l) in text.lines().enumerate() {
                if l.contains(&pattern) {
                    lines.push(format!("{rel}:{}:{}", i + 1, l.trim()));
                    if lines.len() >= MATCH_CAP {
                        return false;
                    }
                }
            }
        }
        lines.len() < MATCH_CAP
    });
    if lines.is_empty() {
        return Ok("no matches".into());
    }
    Ok(lines.join("\n"))
}

/// 递归遍历（同步 fs——目录树小、cap 兜底）；visitor 返回 false 停止
fn walk(root: &Path, rel: &str, depth: usize, f: &mut dyn FnMut(&str, bool) -> bool) {
    if depth > MAX_DEPTH {
        return;
    }
    let Ok(rd) = std::fs::read_dir(root) else { return };
    let mut entries: Vec<_> = rd.flatten().collect();
    entries.sort_by_key(|e| e.file_name());
    for e in entries {
        let name = e.file_name().to_string_lossy().into_owned();
        if name.starts_with('.') && SKIP_DIRS.contains(&name.as_str()) || SKIP_DIRS.contains(&name.as_str()) {
            continue;
        }
        let child_rel = if rel.is_empty() { name.clone() } else { format!("{rel}/{name}") };
        let is_dir = e.file_type().map(|t| t.is_dir()).unwrap_or(false);
        if !f(&child_rel, is_dir) {
            return;
        }
        if is_dir {
            walk(&e.path(), &child_rel, depth + 1, f);
        }
    }
}

/// 通配匹配：`**` 跨段，`*`/`?` 段内。大小写敏感。
pub fn glob_match(pattern: &str, path: &str) -> bool {
    let p: Vec<&str> = pattern.split('/').collect();
    let s: Vec<&str> = path.split('/').collect();
    seg_match(&p, &s)
}

fn seg_match(p: &[&str], s: &[&str]) -> bool {
    match p.first() {
        None => s.is_empty(),
        Some(&"**") => {
            // ** 匹配 0..n 段
            (0..=s.len()).any(|i| seg_match(&p[1..], &s[i..]))
        }
        Some(seg) => {
            if s.is_empty() {
                false
            } else if star_match(seg, s[0]) {
                seg_match(&p[1..], &s[1..])
            } else {
                false
            }
        }
    }
}

/// 段内通配（无 `**`）
fn star_match(pat: &str, s: &str) -> bool {
    let p: Vec<char> = pat.chars().collect();
    let t: Vec<char> = s.chars().collect();
    fn go(p: &[char], t: &[char]) -> bool {
        match (p.first(), t.first()) {
            (None, None) => true,
            (Some('*'), _) => go(&p[1..], t) || (!t.is_empty() && go(p, &t[1..])),
            (Some('?'), Some(_)) => go(&p[1..], &t[1..]),
            (Some(a), Some(b)) if a == b => go(&p[1..], &t[1..]),
            _ => false,
        }
    }
    go(&p, &t)
}

fn str_arg<'a>(input: &'a Value, key: &str) -> Result<&'a str, String> {
    input.get(key).and_then(|v| v.as_str()).ok_or_else(|| format!("missing string arg: {key}"))
}

/// OpenAI tools schema（daemon 会渲染进网页 system prompt 的文本协议）
pub fn tools_json() -> Vec<Value> {
    json!([
        { "type": "function", "function": { "name": "read_file",
            "description": "读取会话目录内文本文件，带行号返回",
            "parameters": { "type": "object", "properties": {
                "path": { "type": "string", "description": "相对会话目录的路径" },
                "offset": { "type": "number", "description": "起始行号（1 起，默认 1）" },
                "limit": { "type": "number", "description": "最多返回行数（默认 2000）" } },
                "required": ["path"] } } },
        { "type": "function", "function": { "name": "write_file",
            "description": "整文件写入（覆盖），自动建父目录",
            "parameters": { "type": "object", "properties": {
                "path": { "type": "string" }, "content": { "type": "string" } },
                "required": ["path", "content"] } } },
        { "type": "function", "function": { "name": "edit",
            "description": "精确字符串替换编辑文件",
            "parameters": { "type": "object", "properties": {
                "path": { "type": "string" },
                "old_str": { "type": "string", "description": "要替换的原文本（须唯一，除非 replace_all）" },
                "new_str": { "type": "string" },
                "replace_all": { "type": "boolean" } },
                "required": ["path", "old_str", "new_str"] } } },
        { "type": "function", "function": { "name": "bash",
            "description": "在会话目录执行 shell 命令（需用户批准）",
            "parameters": { "type": "object", "properties": {
                "command": { "type": "string" },
                "timeout_ms": { "type": "number", "description": "超时毫秒（默认 30000，上限 120000）" } },
                "required": ["command"] } } },
        { "type": "function", "function": { "name": "glob",
            "description": "按通配模式列文件（支持 * ** ?），忽略 .git/node_modules/target 等",
            "parameters": { "type": "object", "properties": {
                "pattern": { "type": "string" }, "path": { "type": "string", "description": "限定子目录（默认整个会话目录）" } },
                "required": ["pattern"] } } },
        { "type": "function", "function": { "name": "grep",
            "description": "子串搜索文件内容，返回 file:line:text",
            "parameters": { "type": "object", "properties": {
                "pattern": { "type": "string" },
                "path": { "type": "string", "description": "限定子目录（默认整个会话目录）" },
                "include": { "type": "string", "description": "文件名后缀过滤，如 .rs" } },
                "required": ["pattern"] } } },
    ])
    .as_array()
    .unwrap()
    .clone()
}

/// 系统提示词：pi 同款结构与文风（qtom 即 pi 的 Rust 兄弟），
/// 工具段适配六件套；{cwd} 由 Agent 注入。
pub const SYSTEM_PROMPT: &str = r#"You are a coding assistant running inside qtom, a coding agent harness (the Rust sibling of pi). Help users inspect files, run commands, and modify code.

<tools>
- read_file: Read file contents
- write_file: Create or overwrite files
- edit: Make precise file edits with exact text replacement
- bash: Execute bash commands (ls, grep, find, etc.)
- glob: List files matching a wildcard pattern
- grep: Search file contents for a substring

Additional tools may be available.
</tools>

<rules>
- Use bash for file operations like ls, rg, find
- Use read_file to examine files instead of cat or sed.
- Use edit for targeted changes. old_str must exactly and uniquely match the original file. Keep matches short and non-overlapping; do not include large unchanged regions.
- Use write_file only for new files or complete rewrites.
- bash requires user approval; say what a command does before running it.
- Be concise in your responses
- Show file paths clearly when working with files
</rules>

<cwd>
{cwd}
</cwd>"#;

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn path_guard() {
        let cwd = "/tmp/qtomtest";
        assert!(resolve(cwd, "a.txt").is_ok());
        assert!(resolve(cwd, "sub/../b.txt").is_ok());
        assert!(resolve(cwd, "../escape.txt").is_err());
        assert!(resolve(cwd, "/etc/passwd").is_err());
        assert!(resolve(cwd, "/tmp/qtomtest/ok.txt").is_ok());
        assert!(resolve(cwd, "/tmp/qtomtest/../evil").is_err());
    }

    #[test]
    fn glob_patterns() {
        assert!(glob_match("*.rs", "main.rs"));
        assert!(!glob_match("*.rs", "src/main.rs"));
        assert!(glob_match("**/*.rs", "src/main.rs"));
        assert!(glob_match("**/*.rs", "main.rs"));
        assert!(glob_match("src/**/*.ts", "src/a/b/c.ts"));
        assert!(glob_match("a?c.txt", "abc.txt"));
        assert!(!glob_match("a?c.txt", "ac.txt"));
        assert!(glob_match("**", "anything/deep/path"));
    }

    #[tokio::test]
    async fn write_edit_read_roundtrip() {
        let dir = std::env::temp_dir().join("qtom-tools-test");
        let _ = std::fs::remove_dir_all(&dir);
        let cwd = dir.to_str().unwrap();
        let w = write_file(cwd, &json!({"path":"sub/a.txt","content":"hello cat\n"}) ).await;
        assert!(w.is_ok(), "{w:?}");
        let e = edit(cwd, &json!({"path":"sub/a.txt","old_str":"cat","new_str":"tom"})).await;
        assert!(e.is_ok(), "{e:?}");
        let r = read_file(cwd, &json!({"path":"sub/a.txt"})).await.unwrap();
        assert_eq!(r, "1\thello tom\n");
    }
}
