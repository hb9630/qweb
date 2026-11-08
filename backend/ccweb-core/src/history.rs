// 官方 transcript 读取 —— 对照 server.mjs:252-304,592-652
// 目录名是 cwd 编码（/root → -root）但规则可能随版本变——一律读行内 cwd 字段。
use crate::ctxwin::CtxWin;
use crate::httpbase::json_resp;
use crate::App;
use axum::body::Body;
use axum::http::{Response, StatusCode};
use serde_json::{json, Value};
use std::sync::Arc;

/// 读文件头 64KiB 的行（尾行可能截断，无条件丢弃；空行过滤）
fn read_head_lines(p: &str) -> Vec<String> {
    let Ok(mut buf) = std::fs::read(p) else { return vec![] };
    buf.truncate(65536);
    let text = String::from_utf8_lossy(&buf);
    let mut lines: Vec<String> = text.split('\n').map(str::to_string).collect();
    lines.pop();
    lines.into_iter().filter(|l| !l.trim().is_empty()).collect()
}

/// 首个真实用户文本（跳过斜杠命令与系统注入），作标题；也是回放保留该行的判据
fn title_text(ev: &Value) -> Option<String> {
    if ev.get("type").and_then(|v| v.as_str()) != Some("user") || ev.get("isMeta").is_truthy() {
        return None;
    }
    let c = ev.pointer("/message/content")?;
    let text = match c {
        Value::String(s) => s.clone(),
        Value::Array(arr) => arr
            .iter()
            .filter(|x| x.get("type").and_then(|t| t.as_str()) == Some("text"))
            .filter_map(|x| x.get("text").and_then(|t| t.as_str()))
            .collect::<String>(),
        _ => String::new(),
    };
    let t = text.trim();
    if t.is_empty()
        || t.starts_with('/')
        || t.starts_with('<')
        || t.starts_with('[') // CLI 系统标记：[Request interrupted by user] 也落成 user 事件，不能当标题
        || t.starts_with("Caveat:")
        || t.starts_with("This session is being continued")
    {
        return None;
    }
    Some(t.chars().take(40).collect())
}

struct TranscriptMeta {
    id: String,
    cwd: String,
    title: String,
    started_at: serde_json::Value,
}

fn list_transcripts(app: &App) -> Vec<TranscriptMeta> {
    let mut out = vec![];
    let Ok(dirs) = std::fs::read_dir(&app.cfg.projects) else { return out };
    for d in dirs.flatten() {
        if !d.path().is_dir() {
            continue;
        }
        let Ok(files) = std::fs::read_dir(d.path()) else { continue };
        for f in files.flatten() {
            let name = f.file_name().to_string_lossy().into_owned();
            if !name.ends_with(".jsonl") {
                continue;
            }
            let p = f.path();
            let Ok(md) = std::fs::metadata(&p) else { continue };
            let started_at = md
                .modified()
                .ok()
                .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
                .map(|d| d.as_secs_f64() * 1000.0) // Node mtimeMs：浮点毫秒
                .unwrap_or(0.0);
            let started_at = if started_at.fract() == 0.0 {
                json!(started_at as u64)
            } else {
                json!(started_at)
            };
            let mut cwd = String::new();
            let mut title = String::new();
            for l in read_head_lines(&p.to_string_lossy()) {
                let Ok(ev) = serde_json::from_str::<Value>(&l) else { continue };
                if cwd.is_empty() {
                    if let Some(c) = ev.get("cwd").and_then(|v| v.as_str()) {
                        cwd = c.to_string();
                    }
                }
                if title.is_empty() {
                    title = title_text(&ev).unwrap_or_default();
                }
                if !cwd.is_empty() && !title.is_empty() {
                    break;
                }
            }
            if cwd.is_empty() {
                continue;
            }
            out.push(TranscriptMeta {
                id: name.trim_end_matches(".jsonl").to_string(),
                cwd,
                title,
                started_at,
            });
        }
    }
    out
}

/// GET /api/history —— 按 cwd 分组、mtime 降序、每组 cap 50（server.mjs:592-602）
pub async fn list(app: Arc<App>) -> Response<Body> {
    let mut order: Vec<String> = vec![]; // 分组按首现顺序（Node Map 语义）
    let mut groups: Vec<Vec<Value>> = vec![];
    for m in list_transcripts(&app) {
        let gi = match order.iter().position(|c| c == &m.cwd) {
            Some(i) => i,
            None => {
                order.push(m.cwd.clone());
                groups.push(vec![]);
                groups.len() - 1
            }
        };
        groups[gi].push(json!({ "id": m.id, "cwd": m.cwd, "title": m.title, "startedAt": m.started_at }));
    }
    let out: Vec<Value> = order
        .iter()
        .zip(groups)
        .map(|(cwd, mut list)| {
            list.sort_by(|a, b| {
                let x = a.get("startedAt").and_then(|v| v.as_f64()).unwrap_or(0.0);
                let y = b.get("startedAt").and_then(|v| v.as_f64()).unwrap_or(0.0);
                y.partial_cmp(&x).unwrap_or(std::cmp::Ordering::Equal)
            }); // 稳定排序：同毫秒保持文件系统顺序（Node sort 稳定版语义近似）
            list.truncate(50);
            json!({ "cwd": cwd, "sessions": list })
        })
        .collect();
    json_resp(StatusCode::OK, json!(out))
}

/// GET /api/history/{sid} —— 单会话回放 + 合成尾部 result（server.mjs:603-652）
pub async fn replay(app: Arc<App>, ctxwin: Arc<CtxWin>, sid: &str) -> Response<Body> {
    let Some((events, model)) = replay_events(&app.cfg.projects, &ctxwin, sid) else {
        return json_resp(StatusCode::NOT_FOUND, json!({ "error": "历史不存在" }));
    };
    json_resp(StatusCode::OK, json!({ "id": sid, "events": events, "model": model }))
}

/// 定位 sid 的 transcript 文件（目录名是 cwd 编码但规则随版本变——按文件名全目录找）
fn transcript_path(projects: &str, sid: &str) -> Option<String> {
    let dirs = std::fs::read_dir(projects).ok()?;
    for d in dirs.flatten() {
        if !d.path().is_dir() {
            continue;
        }
        let p = d.path().join(format!("{sid}.jsonl"));
        if p.is_file() {
            return Some(p.to_string_lossy().into_owned());
        }
    }
    None
}

/// transcript 最后一条 assistant 行的单请求 usage（从尾往前找第一条非零的）。
/// 背景中转网关两头作假：流内 assistant 事件 usage 清零、轮末 result 按整轮累计
/// （单请求不可能超上下文窗口）——只有 transcript 的 assistant 行是单请求真值
pub fn last_request_usage(projects: &str, sid: &str) -> Option<Value> {
    let text = std::fs::read_to_string(transcript_path(projects, sid)?).ok()?;
    for l in text.lines().rev() {
        let Ok(ev) = serde_json::from_str::<Value>(l) else { continue };
        if ev.get("type").and_then(|v| v.as_str()) != Some("assistant")
            || ev.get("isSidechain").is_truthy()
            || ev.get("isMeta").is_truthy()
        {
            continue;
        }
        if let Some(u) = ev.pointer("/message/usage") {
            let used = ["input_tokens", "cache_read_input_tokens", "cache_creation_input_tokens"]
                .iter()
                .map(|k| u.get(*k).and_then(|v| v.as_u64()).unwrap_or(0))
                .sum::<u64>();
            if used > 0 {
                return Some(u.clone());
            }
        }
    }
    None
}

/// transcript 行内 cwd 字段（URL 锚点恢复只带 sid 时的工作目录推导）
pub fn transcript_cwd(projects: &str, sid: &str) -> Option<String> {
    let text = std::fs::read_to_string(transcript_path(projects, sid)?).ok()?;
    for l in text.lines() {
        let Ok(ev) = serde_json::from_str::<Value>(l) else { continue };
        if let Some(c) = ev.get("cwd").and_then(|v| v.as_str()) {
            if !c.is_empty() {
                return Some(c.to_string());
            }
        }
    }
    None
}

/// transcript 行内 engine 字段（qtom 每行写 engine:"qtom"；官方 transcript 无此字段 = claude）。
/// resume 时由 transcript 决定引擎（单一事实来源，body engine 不参与 resume）。
pub fn transcript_engine(projects: &str, sid: &str) -> Option<String> {
    let text = std::fs::read_to_string(transcript_path(projects, sid)?).ok()?;
    for l in text.lines() {
        let Ok(ev) = serde_json::from_str::<Value>(l) else { continue };
        if let Some(e) = ev.get("engine").and_then(|v| v.as_str()) {
            if !e.is_empty() {
                return Some(e.to_string());
            }
        }
    }
    None
}

/// transcript → 回放事件流（replay 端点与 WS「恢复前历史」共用）。
/// assistant/user 行过滤入流、result 只取 usage，尾部合成 result 携带 ctx 分母。
/// 返回 (events, 最后一次 assistant 的模型)；None = transcript 不存在。
pub fn replay_events(projects: &str, ctxwin: &CtxWin, sid: &str) -> Option<(Vec<Value>, Option<Value>)> {
    let text = std::fs::read_to_string(transcript_path(projects, sid)?).unwrap_or_default();
    let mut events: Vec<Value> = vec![];
    let mut model: Option<Value> = None; // 最后一次 assistant 的模型（transcript 无 init）
    let mut usage: Option<Value> = None;
    let mut model_usage: Option<Value> = None;
    for l in text.split('\n') {
        let Ok(ev) = serde_json::from_str::<Value>(l) else { continue };
        match ev.get("type").and_then(|v| v.as_str()) {
            Some("assistant") => {
                // sidechain（子代理）/meta 行不进主消息流，usage 也不算 ctx（防 ctx% 骤小）
                if ev.get("isSidechain").is_truthy() || ev.get("isMeta").is_truthy() {
                    continue;
                }
                if let Some(m) = ev.pointer("/message/model") {
                    if !m.is_null() {
                        model = Some(m.clone());
                    }
                }
                if let Some(u) = ev.pointer("/message/usage") {
                    // 只记非零：中转会把部分行清零，零值不能覆盖前一条真值
                    let used = ["input_tokens", "cache_read_input_tokens", "cache_creation_input_tokens"]
                        .iter()
                        .map(|k| u.get(*k).and_then(|v| v.as_u64()).unwrap_or(0))
                        .sum::<u64>();
                    if u.is_object() && used > 0 {
                        usage = Some(u.clone());
                    }
                }
                let content = ev.pointer("/message/content");
                if let Some(Value::Array(arr)) = content {
                    if !arr.is_empty() {
                        events.push(json!({ "type": "assistant", "message": ev.get("message") }));
                    }
                }
            }
            Some("user") => {
                if ev.get("isMeta").is_truthy() {
                    continue;
                }
                let c = ev.pointer("/message/content");
                let has_tr = matches!(c, Some(Value::Array(arr)) if arr.iter().any(|x| x.get("type").and_then(|t| t.as_str()) == Some("tool_result")));
                if has_tr || title_text(&ev).is_some() {
                    events.push(json!({ "type": "user", "message": { "role": "user", "content": c } }));
                }
            }
            Some("result") => {
                // usage 不取 result 行：中转把轮末 result 按整轮累计（单请求不可能超
                // 窗口），分子以 assistant 行的单请求 usage 为准（官方 API 下两者一致）
                if let Some(mu) = ev.get("modelUsage") {
                    if mu.is_object() {
                        model_usage = Some(mu.clone());
                    }
                }
            }
            _ => {}
        }
    }
    // 尾部合成 result：modelUsage 缺失时用落盘窗口记忆（裸名键），分母不依赖浏览器
    if let Some(u) = usage {
        let model_usage = match model_usage {
            Some(mu) => mu,
            None => {
                let model_name = model.as_ref().and_then(|m| m.as_str()).unwrap_or("");
                match ctxwin.of(model_name) {
                    Some(win) => json!({ model_name: { "contextWindow": win } }),
                    None => json!({}),
                }
            }
        };
        events.push(json!({
            "type": "result", "subtype": "success",
            "usage": u, "modelUsage": model_usage, "model": model,
        }));
    }
    Some((events, model))
}

/// is_truthy 简版：JSON 值的 JS 真值（null/false 缺省为假；数字 0 为假）
trait JsonTruthy {
    fn is_truthy(&self) -> bool;
}
impl JsonTruthy for Option<&Value> {
    fn is_truthy(&self) -> bool {
        match self {
            None => false,
            Some(Value::Null) => false,
            Some(Value::Bool(b)) => *b,
            Some(Value::Number(n)) => n.as_f64().map(|f| f != 0.0).unwrap_or(true),
            Some(Value::String(s)) => !s.is_empty(),
            Some(_) => true,
        }
    }
}
