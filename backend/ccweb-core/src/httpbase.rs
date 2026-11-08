// 请求基座：base 剥离 / SPA 301 / 畸形路径守卫 / body 上限 / query 解码
// —— 对照 server.mjs:19-27,306-323,88-97
use axum::body::Body;
use axum::http::{Response, StatusCode};
use axum::response::IntoResponse;

// 零配置 base_path：锚点前的一切视为反代前缀剥掉（server.mjs:19）
pub const ANCHORS: [&str; 7] = ["/api/", "/ws/", "/assets/", "/favicon.ico", "/index.html", "/login", "/logout"];

/// 最早出现的锚点下标；无锚点 → None（SPA 入口）
pub fn strip_base_cut(p: &str) -> Option<usize> {
    let mut cut: Option<usize> = None;
    for a in ANCHORS {
        if let Some(i) = p.find(a) {
            cut = Some(match cut {
                Some(c) if c < i => c,
                _ => i,
            });
        }
    }
    cut
}

/// 剥离后的路径（无锚点 → None）；`&p[..cut]` 即反代 base 前缀
pub fn strip_base(p: &str) -> Option<String> {
    strip_base_cut(p).map(|c| {
        let s = &p[c..];
        if s.is_empty() { "/".to_string() } else { s.to_string() }
    })
}

/// WHATWG URL 的 dot 段归一（new URL("/a/../b") → "/b"）：消解 `.`/`..`，
/// 不折叠空段、不去 percent 编码、不越根。
pub fn normalize_dot_segments(p: &str) -> String {
    let mut out: Vec<&str> = Vec::new();
    for seg in p.split('/') {
        match seg {
            "." => {}
            ".." => {
                out.pop(); // 越根（out 空）时 WHATWG 同样丢弃该段
            }
            other => out.push(other),
        }
    }
    // 拼回时保持段结构：out[0] 为前导空串（绝对路径）则天然还原前导 /
    out.join("/")
}

/// query 参数解码：URLSearchParams 语义（%XX + `+`→空格）。找不到返回 None。
pub fn query_param(query: Option<&str>, key: &str) -> Option<String> {
    let q = query?;
    for pair in q.split('&') {
        let (k, v) = match pair.split_once('=') {
            Some((k, v)) => (k, v),
            None => (pair, ""),
        };
        if k == key {
            return Some(
                percent_encoding::percent_decode_str(&v.replace('+', " "))
                    .decode_utf8()
                    .map(|s| s.into_owned())
                    .unwrap_or_else(|_| v.to_string()),
            );
        }
    }
    None
}

/// 读请求体（带上限）。超限 → Err("too large")；客户端断开 → Err("aborted")。
/// 对照 readBody：Node 对超限/断开「不回包吊连接」，此处由调用方决定 413/丢弃（偏差清单）。
pub async fn read_body(body: Body, cap: usize) -> Result<Vec<u8>, &'static str> {
    match axum::body::to_bytes(body, cap).await {
        Ok(b) => Ok(b.to_vec()),
        Err(e) => {
            let msg = e.to_string();
            if msg.contains("length limit") || msg.contains("too large") {
                Err("too large")
            } else {
                Err("aborted")
            }
        }
    }
}

pub fn json_resp(code: StatusCode, obj: serde_json::Value) -> Response<Body> {
    (
        code,
        [(axum::http::header::CONTENT_TYPE, "application/json")],
        serde_json::to_string(&obj).unwrap_or_default(),
    )
        .into_response()
}

pub fn text_resp(code: StatusCode, body: &str) -> Response<Body> {
    (code, body.to_string()).into_response()
}
