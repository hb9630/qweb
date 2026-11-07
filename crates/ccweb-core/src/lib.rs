// ccweb-core：后端业务核心（lib）。ccweb-server bin 与将来的 Tauri 壳共用。
//
// 分发架构：与 Node 版同构——单个中央 handler 按源码顺序 if 链匹配
// （未知 /api/* 自然落入静态/SPA），而非 axum 声明式路由；strip_base 只做一处。
pub mod api;
pub mod config;
pub mod ctxwin;
pub mod fsapi;
pub mod fswatch;
pub mod history;
pub mod httpbase;
pub mod keeper;
pub mod sessions;
pub mod statics;
pub mod tardown;
pub mod util;
pub mod wsapi;

use std::sync::Arc;

use axum::body::Body;
use axum::extract::ws::WebSocketUpgrade;
use axum::extract::{FromRequestParts, Request, State};
use axum::http::{HeaderName, Method, Response, StatusCode};
use config::Config;
use ctxwin::CtxWin;
use fswatch::FsHub;
use sessions::SessionMap;

/// keeperd 探针（1.5s）/ 反代（按请求 60s/600s）两个客户端
pub struct Http {
    pub probe: reqwest::Client,
    pub proxy: reqwest::Client,
}

/// 全局共享状态
pub struct App {
    pub cfg: Config,
    pub fs_hub: Arc<FsHub>,
    pub sessions: SessionMap,
    pub ctxwin: Arc<CtxWin>,
    pub http: Http,
}

pub fn router(app: Arc<App>) -> axum::Router {
    axum::Router::new().fallback(dispatch).with_state(app)
}

/// 中央分发 —— 对照 server.mjs:306-323 请求前置 + 各 API 分支 + 653 静态兜底
async fn dispatch(State(app): State<Arc<App>>, req: Request) -> Response<Body> {
    let (mut parts, body) = req.into_parts();
    let path_raw = parts.uri.path().to_string();
    // 畸形 request-target（"//" = WHATWG 空 host → Invalid URL）→ 400（server.mjs:309-310）
    if path_raw.starts_with("//") {
        return httpbase::text_resp(StatusCode::BAD_REQUEST, "bad request");
    }
    // new URL() 的 dot 段归一（/a/../b → /b），随后剥离反代 base 前缀
    let path = httpbase::normalize_dot_segments(&path_raw);
    let query = parts.uri.query().map(str::to_string);
    let pathname = match httpbase::strip_base(&path) {
        None => {
            // SPA 入口：尾斜杠是相对资源解析前提，缺则 301 补上（保留 query）
            if !path.ends_with('/') {
                let loc = format!(
                    "{}/{}",
                    path,
                    query.as_deref().map(|q| format!("?{q}")).unwrap_or_default()
                );
                return Response::builder()
                    .status(StatusCode::MOVED_PERMANENTLY)
                    .header("location", loc)
                    .body(Body::empty())
                    .expect("301 response");
            }
            "/".to_string()
        }
        Some(p) => p,
    };
    let method = parts.method.clone();

    // ---- WS 升级（server.mjs:733-760 upgrade 事件）----
    let wants_ws = parts
        .headers
        .get(HeaderName::from_static("upgrade"))
        .and_then(|v| v.to_str().ok())
        .is_some_and(|v| v.eq_ignore_ascii_case("websocket"));
    if wants_ws {
        if pathname == "/ws/fs" {
            return match WebSocketUpgrade::from_request_parts(&mut parts, &()).await {
                Ok(up) => up.on_upgrade(move |socket| app.fs_hub.clone().handle_ws(socket)),
                Err(_) => httpbase::text_resp(StatusCode::BAD_REQUEST, "bad request"),
            };
        }
        if let Some(id) = pathname.strip_prefix("/ws/") {
            if !id.is_empty()
                && id.chars().all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-')
            {
                let s = app.sessions.read().await.get(id).cloned();
                if let Some(s) = s {
                    return match WebSocketUpgrade::from_request_parts(&mut parts, &()).await {
                        Ok(up) => up.on_upgrade(move |socket| wsapi::handle_session_ws(s, socket)),
                        Err(_) => httpbase::text_resp(StatusCode::BAD_REQUEST, "bad request"),
                    };
                }
            }
        }
        // 未知升级目标：Node 裸断 socket，此处 404（偏差清单）
        return httpbase::text_resp(StatusCode::NOT_FOUND, "no websocket");
    }

    // ---- API 分支（保持 server.mjs 源码顺序；未匹配的 /api/* 落入静态/SPA）----
    if pathname == "/api/env" && method == Method::GET {
        return api::env(&app).await;
    }
    if pathname.starts_with("/api/keeper/") {
        let auth = parts.headers.get(axum::http::header::AUTHORIZATION).cloned();
        let is_get = method == Method::GET;
        let body_opt = if is_get { None } else { Some(body) };
        return keeper::proxy(&app, &method, &pathname, query.as_deref(), auth, body_opt).await;
    }
    if pathname == "/api/history" {
        return history::list(app.clone()).await;
    }
    if let Some(sid) = pathname.strip_prefix("/api/history/") {
        if method == Method::GET
            && !sid.is_empty()
            && sid.chars().all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-')
        {
            return history::replay(app.clone(), app.ctxwin.clone(), sid).await;
        }
    }
    if pathname == "/api/sessions" {
        return api::sessions(&app, &method, "", Some(body)).await;
    }
    if let Some(rest) = pathname.strip_prefix("/api/sessions/") {
        return api::sessions(&app, &method, rest, Some(body)).await;
    }
    if pathname == "/api/fs" {
        return fsapi::list(&app, query.as_deref()).await;
    }
    if pathname == "/api/fs/dirs" {
        return fsapi::dirs_list(&app, query.as_deref()).await;
    }
    if pathname == "/api/fs/file" && method == Method::GET {
        return fsapi::file_get(query.as_deref()).await;
    }
    if pathname == "/api/fs/file" && method == Method::PUT {
        return fsapi::file_put(body).await;
    }
    if pathname == "/api/fs/raw" && method == Method::GET {
        return fsapi::raw(query.as_deref()).await;
    }
    if pathname == "/api/fs/op" && method == Method::POST {
        return fsapi::op(&app, body).await;
    }
    if pathname == "/api/fs/download" && method == Method::GET {
        return fsapi::download(&app, query.as_deref()).await;
    }

    // ---- 静态兜底 ----
    statics::serve(&pathname)
}

/// 后台任务：空闲会话回收（无 WS 客户端且 20 分钟无事件 → kill，防进程堆积）
pub fn spawn_background(app: Arc<App>) {
    tokio::spawn(async move {
        let mut tick = tokio::time::interval(std::time::Duration::from_secs(60));
        loop {
            tick.tick().await;
            let now = util::now_ms();
            let mut victims: Vec<String> = vec![];
            for (id, s) in app.sessions.read().await.iter() {
                if s.clients_empty() && s.alive() && now.saturating_sub(s.last_active()) > 20 * 60 * 1000 {
                    println!("[ccweb] 会话 {id} 空闲回收（可从历史恢复）");
                    s.kill();
                    victims.push(id.clone());
                }
            }
            if !victims.is_empty() {
                let mut w = app.sessions.write().await;
                for id in &victims {
                    w.remove(id);
                }
            }
        }
    });
}

/// SIGTERM/SIGINT 到达：结束全部 claude 子进程防孤儿
pub async fn shutdown(app: &App) {
    let all: Vec<Arc<sessions::Session>> = app.sessions.read().await.values().cloned().collect();
    for s in all {
        s.kill();
    }
}
