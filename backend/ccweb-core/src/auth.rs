// 访问认证（code-server 同款 --auth 语义）：nopass 默认放行；password 模式下
// 全部 HTTP/WS 需带会话 cookie（/login /logout 除外）。token 内存态，重启需重登。
use axum::body::Body;
use axum::http::{header, HeaderValue, Response, StatusCode};
use axum::response::IntoResponse;
use crate::config::AuthMode;
use std::collections::HashSet;
use std::sync::Mutex;

pub const COOKIE: &str = "ccweb_auth";

pub struct AuthState {
    pub mode: AuthMode,
    password: Option<String>,
    tokens: Mutex<HashSet<String>>, // 已登录会话（内存态；重启清空=重新登录）
}

impl AuthState {
    pub fn new(mode: AuthMode, password: Option<String>) -> Self {
        Self { mode, password, tokens: Mutex::new(HashSet::new()) }
    }

    pub fn required(&self) -> bool {
        self.mode == AuthMode::Password
    }

    /// 常数时间比较（长度差也折进去，不做早退）
    fn check_password(&self, input: &str) -> bool {
        let want = self.password.as_deref().unwrap_or("");
        let (a, b) = (input.as_bytes(), want.as_bytes());
        let mut diff = (a.len() ^ b.len()) as u8;
        for i in 0..a.len().max(b.len()) {
            let x = a.get(i).copied().unwrap_or(0);
            let y = b.get(i).copied().unwrap_or(0);
            diff |= x ^ y;
        }
        diff == 0
    }

    /// 校验密码 → 签发会话 token（Set-Cookie 由调用方附加）
    pub fn login(&self, password: &str) -> Option<String> {
        if !self.check_password(password) {
            return None;
        }
        let token = uuid::Uuid::new_v4().simple().to_string();
        self.tokens.lock().unwrap().insert(token.clone());
        Some(token)
    }

    pub fn logout(&self, token: &str) {
        self.tokens.lock().unwrap().remove(token);
    }

    /// 从 Cookie 头提取并校验会话
    pub fn validate(&self, cookie_header: Option<&HeaderValue>) -> bool {
        let Some(hv) = cookie_header else { return false };
        let Ok(cs) = hv.to_str() else { return false };
        for pair in cs.split(';') {
            let pair = pair.trim();
            if let Some(v) = pair.strip_prefix(&format!("{COOKIE}=")) {
                return self.tokens.lock().unwrap().contains(v.trim());
            }
        }
        false
    }
}

pub fn set_cookie(token: &str) -> String {
    // SameSite=Lax：WS 升级同源自动带；30 天免登
    format!("{COOKIE}={token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=2592000")
}

/// 登录页（无外部资源，深色简洁；错误时重渲染带提示）
pub fn login_page(error: bool, base: &str) -> Response<Body> {
    let err = if error {
        r#"<p class="err">密码不对，再试一次</p>"#
    } else {
        ""
    };
    let html = format!(
        r#"<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>qweb · 登录</title>
<style>
  :root {{ color-scheme: dark; }}
  body {{ margin:0; min-height:100vh; display:grid; place-items:center;
         background:#111318; color:#e6e6e6;
         font-family:-apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC",sans-serif; }}
  .card {{ width:min(320px,86vw); padding:2rem; border-radius:12px;
          background:#1a1d24; border:1px solid #2a2e38; }}
  h1 {{ margin:0 0 .4rem; font-size:1.1rem; }}
  p {{ margin:0 0 1.2rem; color:#8b90a0; font-size:.8rem; }}
  input {{ width:100%; box-sizing:border-box; padding:.6rem .8rem; margin-bottom:.9rem;
          border-radius:8px; border:1px solid #2f3440; background:#12141a; color:#e6e6e6; font-size:.95rem; }}
  input:focus {{ outline:none; border-color:#4a7dff; }}
  button {{ width:100%; padding:.6rem; border:0; border-radius:8px; cursor:pointer;
           background:#3b6cf6; color:#fff; font-size:.95rem; }}
  button:hover {{ background:#4a7dff; }}
  .err {{ color:#ff7b72; margin:-0.4rem 0 .9rem; }}
</style></head>
<body><form class="card" method="POST" action="{base}/login">
  <h1>qweb</h1><p>Claude Code 流式 Web 工作台 · 需要密码</p>
  {err}
  <input type="password" name="password" placeholder="密码" autofocus autocomplete="current-password">
  <button type="submit">进入</button>
</form></body></html>"#
    );
    (
        StatusCode::OK,
        [(header::CONTENT_TYPE, "text/html; charset=utf-8"), (header::CACHE_CONTROL, "no-store")],
        html,
    )
        .into_response()
}

/// POST /login：支持表单（浏览器）与 JSON {password}（curl/脚本）
pub async fn handle_login(app: &crate::App, body: Body, base: &str) -> Response<Body> {
    let bytes = match axum::body::to_bytes(body, 1 << 20).await {
        Ok(b) => b.to_vec(),
        Err(_) => return login_page(true, base),
    };
    let text = String::from_utf8_lossy(&bytes);
    let password = if text.trim_start().starts_with('{') {
        serde_json::from_str::<serde_json::Value>(&text)
            .ok()
            .and_then(|v| v.get("password").and_then(|p| p.as_str()).map(str::to_string))
    } else {
        text.split('&').find_map(|pair| {
            pair.strip_prefix("password=").map(|v| {
                crate::util::js_decode_uri_component(&v.replace('+', " ")).unwrap_or_else(|_| v.to_string())
            })
        })
    };
    let Some(password) = password else { return login_page(true, base) };
    match app.auth.login(&password) {
        Some(token) => Response::builder()
            .status(StatusCode::SEE_OTHER) // 303：POST 后浏览器改 GET
            .header(header::LOCATION, "./")
            .header(header::SET_COOKIE, set_cookie(&token))
            .header(header::CACHE_CONTROL, "no-store")
            .body(Body::empty())
            .expect("login redirect"),
        None => login_page(true, base),
    }
}

/// /logout：销毁会话 + 清 cookie → 回登录页
pub fn handle_logout(app: &crate::App, base: &str, cookie_header: Option<&HeaderValue>) -> Response<Body> {
    if let Some(hv) = cookie_header.and_then(|v| v.to_str().ok()) {
        for pair in hv.split(';') {
            if let Some(v) = pair.trim().strip_prefix(&format!("{COOKIE}=")) {
                app.auth.logout(v.trim());
            }
        }
    }
    Response::builder()
        .status(StatusCode::SEE_OTHER)
        .header(header::LOCATION, format!("{base}/login"))
        .header(header::SET_COOKIE, format!("{COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0"))
        .body(Body::empty())
        .expect("logout redirect")
}
