// transcript：CC JSONL 形状读写。写侧由 Emitter 追加定稿事件（已 wrap 过）；
// 读侧 = resume 再水化（transcript 事件 → OpenAI messages + tool id 续号）。
// 行形状按 qweb history.rs 的解析要求：每行带 cwd；assistant 行带
// /message/model + /message/usage{input_tokens,cache_read_input_tokens,
// cache_creation_input_tokens} + content 数组；user 行带 tool_result 或文本。
use serde_json::{json, Value};
use std::io::Write;
use std::path::PathBuf;

pub struct Transcript {
    file: Option<std::fs::File>,
}

impl Transcript {
    /// {projects}/{encode(cwd)}/{sid}.jsonl 追加打开（无 projects 时纯内存态）
    pub fn open(projects: &str, cwd: &str, sid: &str) -> Self {
        let file = (|| {
            let dir = PathBuf::from(projects).join(encode_dir(cwd));
            std::fs::create_dir_all(&dir).ok()?;
            std::fs::OpenOptions::new().create(true).append(true)
                .open(dir.join(format!("{sid}.jsonl"))).ok()
        })();
        Self { file }
    }

    pub fn none() -> Self {
        Self { file: None }
    }

    pub fn append(&mut self, ev: &Value) {
        if let Some(f) = self.file.as_mut() {
            let _ = writeln!(f, "{ev}");
            let _ = f.flush();
        }
    }
}

/// 目录名编码：非字母数字 → '-'（claude 同款风格，目录名不 load-bearing——history 全扫描）
pub fn encode_dir(cwd: &str) -> String {
    cwd.chars().map(|c| if c.is_ascii_alphanumeric() { c } else { '-' }).collect()
}

/// 全 projects 子目录扫描定位 {sid}.jsonl（与 qweb history::transcript_path 同策略）
pub fn find(projects: &str, sid: &str) -> Option<PathBuf> {
    let name = format!("{sid}.jsonl");
    let root = std::path::Path::new(projects);
    let rd = std::fs::read_dir(root).ok()?;
    for sub in rd.flatten() {
        let p = sub.path().join(&name);
        if p.is_file() {
            return Some(p);
        }
    }
    None
}

/// resume 再水化：transcript 事件行 → OpenAI messages。
/// 返回 (messages, max_tool_seq)——toolu_{seq:08x} 续号防 id 撞车。
pub fn rehydrate(path: &PathBuf) -> (Vec<Value>, u64) {
    let mut messages: Vec<Value> = vec![];
    let mut max_seq: u64 = 0;
    let Ok(text) = std::fs::read_to_string(path) else { return (messages, max_seq) };
    for line in text.lines() {
        let Ok(ev) = serde_json::from_str::<Value>(line) else { continue };
        match ev.get("type").and_then(|v| v.as_str()) {
            Some("user") => {
                let Some(content) = ev.pointer("/message/content") else { continue };
                match content {
                    Value::String(s) => {
                        messages.push(json!({ "role": "user", "content": s }));
                    }
                    Value::Array(items) => {
                        // 拆两类：tool_result → role:tool；text → user 文本（qweb 写入形态为块数组）
                        let mut texts = vec![];
                        for it in items {
                            if it.get("type").and_then(|v| v.as_str()) == Some("tool_result") {
                                let content = match it.get("content") {
                                    Some(Value::String(s)) => s.clone(),
                                    Some(Value::Array(parts)) => parts
                                        .iter()
                                        .filter_map(|p| p.get("text").and_then(|t| t.as_str()))
                                        .collect::<Vec<_>>()
                                        .join("\n"),
                                    _ => String::new(),
                                };
                                messages.push(json!({
                                    "role": "tool",
                                    "tool_call_id": it.get("tool_use_id").cloned().unwrap_or(Value::Null),
                                    "content": content,
                                }));
                            } else if it.get("type").and_then(|v| v.as_str()) == Some("text") {
                                if let Some(t) = it.get("text").and_then(|t| t.as_str()) {
                                    texts.push(t);
                                }
                            }
                        }
                        if !texts.is_empty() {
                            messages.push(json!({ "role": "user", "content": texts.join("\n") }));
                        }
                    }
                    _ => {}
                }
            }
            Some("assistant") => {
                let Some(content) = ev.pointer("/message/content").and_then(|c| c.as_array()) else { continue };
                let mut text = String::new();
                let mut calls = vec![];
                for b in content {
                    match b.get("type").and_then(|v| v.as_str()) {
                        Some("text") => {
                            if let Some(t) = b.get("text").and_then(|t| t.as_str()) {
                                text.push_str(t);
                            }
                        }
                        Some("tool_use") => {
                            let id = b.get("id").and_then(|v| v.as_str()).unwrap_or("");
                            if let Some(seq) = id.strip_prefix("toolu_").and_then(|h| u64::from_str_radix(h, 16).ok()) {
                                max_seq = max_seq.max(seq);
                            }
                            calls.push(json!({
                                "id": id, "type": "function",
                                "function": {
                                    "name": b.get("name").cloned().unwrap_or(Value::Null),
                                    "arguments": serde_json::to_string(
                                        b.get("input").unwrap_or(&Value::Null)).unwrap_or_else(|_| "{}".into()),
                                },
                            }));
                        }
                        _ => {}
                    }
                }
                messages.push(json!({
                    "role": "assistant",
                    "content": if text.is_empty() { Value::Null } else { json!(text) },
                    "tool_calls": calls,
                }));
            }
            _ => {} // result/system/其他不进模型上下文
        }
    }
    (messages, max_seq)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn dir_encode() {
        assert_eq!(encode_dir("/Users/huangbin/Code/qweb"), "-Users-huangbin-Code-qweb");
    }

    #[test]
    fn rehydrate_roundtrip() {
        let dir = std::env::temp_dir().join("qtom-tr-test");
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let p = dir.join("s1.jsonl");
        let lines = [
            r#"{"type":"user","cwd":"/w","session_id":"s1","message":{"role":"user","content":[{"type":"text","text":"列出文件"}]}}"#,
            r#"{"type":"assistant","cwd":"/w","session_id":"s1","message":{"role":"assistant","model":"deepseek-web","content":[{"type":"text","text":"看看"},{"type":"tool_use","id":"toolu_0000000a","name":"bash","input":{"command":"ls"}}],"stop_reason":"tool_use","usage":{"input_tokens":10,"cache_read_input_tokens":0,"cache_creation_input_tokens":0,"output_tokens":5}}}"#,
            r#"{"type":"user","cwd":"/w","session_id":"s1","message":{"role":"user","content":[{"type":"tool_result","tool_use_id":"toolu_0000000a","content":"a.txt","is_error":false}]}}"#,
            r#"{"type":"result","cwd":"/w","session_id":"s1","subtype":"success","usage":{"input_tokens":20,"cache_read_input_tokens":0,"cache_creation_input_tokens":0,"output_tokens":8}}"#,
        ];
        std::fs::write(&p, lines.join("\n")).unwrap();
        let (msgs, max_seq) = rehydrate(&p);
        assert_eq!(msgs.len(), 3);
        assert_eq!(msgs[0]["role"], "user");
        assert_eq!(msgs[0]["content"], "列出文件");
        assert_eq!(msgs[1]["tool_calls"][0]["function"]["name"], "bash");
        assert_eq!(msgs[2]["role"], "tool");
        assert_eq!(msgs[2]["tool_call_id"], "toolu_0000000a");
        assert_eq!(max_seq, 0xa);
    }
}
