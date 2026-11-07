// /api/env 与 /api/sessions —— 对照 server.mjs:329-351,378-416
use crate::httpbase::{json_resp, read_body, text_resp};
use crate::sessions::Session;
use crate::util::safe_path;
use crate::App;
use axum::body::Body;
use axum::http::{Method, Response, StatusCode};
use serde_json::json;

/// GET /api/env —— 环境报告 + 模型清单（唯一一个 /api/env，字段两方共用）
pub async fn env(app: &App) -> Response<Body> {
    let container = std::path::Path::new("/.dockerenv").exists();
    let keeperd = match app.http.probe.get(format!("{}/healthz", app.cfg.keeperd_url)).send().await {
        Ok(r) => r.status().is_success(),
        Err(_) => false,
    };
    // 模型清单：别名恒有效 + settings 推导值 + 兜底 default（Node Set 插入序）
    let mut models: Vec<String> = vec!["sonnet".into(), "opus".into(), "haiku".into()];
    if let Ok(st) = std::fs::read_to_string(format!("{}/.claude/settings.json", app.cfg.child_home)) {
        if let Ok(v) = serde_json::from_str::<serde_json::Value>(&st) {
            for k in [
                "ANTHROPIC_DEFAULT_SONNET_MODEL",
                "ANTHROPIC_DEFAULT_OPUS_MODEL",
                "ANTHROPIC_DEFAULT_HAIKU_MODEL",
            ] {
                if let Some(m) = v.pointer(&format!("/env/{k}")).and_then(|x| x.as_str()) {
                    if !models.iter().any(|x| x == m) {
                        models.push(m.to_string());
                    }
                }
            }
            if let Some(m) = v.get("model").and_then(|x| x.as_str()) {
                if !models.iter().any(|x| x == m) {
                    models.push(m.to_string());
                }
            }
        }
    }
    models.push("default".into());
    let (claude, _) = app.cfg.claude_cmd();
    json_resp(
        StatusCode::OK,
        json!({
            "container": container, "keeperd": keeperd, "keeperd_url": app.cfg.keeperd_url,
            "home": app.cfg.child_home, "platform": crate::config::platform(),
            "claude": claude, "models": models, "single": app.cfg.single,
        }),
    )
}

/// GET 列表 / POST 创建 / DELETE 结束（分发器已保证 path 前缀）
pub async fn sessions(app: &App, method: &Method, rest: &str, body: Option<Body>) -> Response<Body> {
    if rest.is_empty() && method == Method::GET {
        let map = app.sessions.read().await;
        let list: Vec<serde_json::Value> = map.values().map(|s| s.snapshot()).collect();
        return json_resp(StatusCode::OK, json!(list));
    }
    if rest.is_empty() && method == Method::POST {
        return post(app, body).await;
    }
    // DELETE /api/sessions/{id}（分发器已剥去 /api/sessions/ 前缀，rest 即 id）
    if method == Method::DELETE {
        if is_word_id(rest) {
            let s = app.sessions.read().await.get(rest).cloned();
            if let Some(s) = s {
                s.kill();
                app.sessions.write().await.remove(rest);
                return json_resp(StatusCode::OK, json!({ "ok": true }));
            }
            return json_resp(StatusCode::NOT_FOUND, json!({ "error": "会话不存在" }));
        }
        // 未匹配 → 静态兜底（Node 同款：regex 不命中落到静态分支）
        return crate::statics::serve("/index.html");
    }
    // 其他方法（PUT /api/sessions 等）→ Node 落静态
    crate::statics::serve("/index.html")
}

/// Node regex [\w-]+：字母数字下划线连字符
fn is_word_id(s: &str) -> bool {
    !s.is_empty() && s.chars().all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-')
}

async fn post(app: &App, body: Option<Body>) -> Response<Body> {
    let Some(body) = body else {
        return text_resp(StatusCode::BAD_REQUEST, "");
    };
    let raw = match read_body(body, 96 * 1024 * 1024).await {
        Ok(b) => b,
        Err("too large") => return json_resp(StatusCode::PAYLOAD_TOO_LARGE, json!({ "error": "文件过大" })),
        Err(_) => return text_resp(StatusCode::BAD_REQUEST, ""),
    };
    // 非法/空 JSON 容忍（默认值兜底）
    let q: serde_json::Value = serde_json::from_slice(&raw).unwrap_or(json!({}));
    let mut cwd = q.get("cwd").and_then(|v| v.as_str()).map(str::to_string).unwrap_or_default();
    if cwd.is_empty() {
        cwd = app.cfg.child_home.clone();
    }
    let resume = q.get("resume").and_then(|v| v.as_str()).map(str::to_string);
    let cwd = safe_path(&cwd);
    if tokio::fs::metadata(&cwd).await.is_err() {
        return json_resp(StatusCode::BAD_REQUEST, json!({ "error": format!("目录不存在: {cwd}") }));
    }
    // resume 幂等：同官方会话已有活进程 → 返回既有会话不 spawn（防双进程交错写坏 transcript）
    if let Some(r) = &resume {
        for s in app.sessions.read().await.values() {
            if s.claude_sid().as_deref() == Some(r.as_str()) && s.alive() {
                return json_resp(
                    StatusCode::OK,
                    json!({ "id": s.id, "cwd": s.cwd, "resumed": true, "claudeSid": r, "dedup": true }),
                );
            }
        }
    }
    // 单会话形态：kill 既有活会话再开新的
    if app.cfg.single {
        for (_, s) in app.sessions.write().await.drain() {
            s.kill();
        }
    }
    let id = crate::sessions::uuid_str()[..8].to_string();
    let s = Session::spawn_new(&id, &cwd, resume.as_deref(), &app.cfg, app.ctxwin.clone()).await;
    app.sessions.write().await.insert(id.clone(), s);
    // claudeSid：resume 时即官方会话 ID——前端 ChatPanel 的 key 不换就不重挂
    json_resp(
        StatusCode::OK,
        json!({ "id": id, "cwd": cwd, "resumed": resume.is_some(), "claudeSid": resume }),
    )
}
