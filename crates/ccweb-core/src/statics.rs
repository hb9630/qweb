// 静态资源：rust-embed 嵌入 frontend/dist（debug 运行期读盘 / release 进二进制）
// —— 对照 server.mjs:39-53,234-238,653-667
use axum::body::Body;
use axum::http::{header, Response, StatusCode};
use axum::response::IntoResponse;
use rust_embed::RustEmbed;

#[derive(RustEmbed)]
#[folder = "../../frontend/dist"]
struct Dist;

/// 静态 MIME 表（server.mjs MIME；扩展名不做小写化——Node extname 原样查表）
fn static_mime(rel: &str) -> &'static str {
    let name = rel.rsplit('/').next().unwrap_or(rel);
    let ext = match name.rfind('.') {
        Some(i) => &name[i..],
        None => "",
    };
    match ext {
        ".html" => "text/html; charset=utf-8",
        ".js" => "text/javascript",
        ".css" => "text/css",
        ".json" => "application/json",
        ".svg" => "image/svg+xml",
        ".png" => "image/png",
        ".ico" => "image/x-icon",
        ".woff2" => "font/woff2",
        ".map" => "application/json",
        _ => "application/octet-stream",
    }
}

/// 静态分发（server.mjs:653-667）：pathname 已是 strip_base 后的值
pub fn serve(pathname: &str) -> Response<Body> {
    // decodeURIComponent：坏 % 序列 Node 挂连接 → 此处 400（偏差清单）
    let decoded = match crate::util::js_decode_uri_component(pathname) {
        Ok(d) => d,
        Err(_) => return (StatusCode::BAD_REQUEST, "bad request").into_response(),
    };
    let appended;
    let mut rel = decoded.as_str();
    if rel.ends_with('/') {
        // 目录语义 → index
        appended = format!("{rel}index.html");
        rel = appended.as_str();
    }
    let rel = rel.strip_prefix('/').unwrap_or(rel);
    let cache = if rel.starts_with("assets/") {
        "public, max-age=31536000, immutable"
    } else {
        "no-cache"
    };
    let mut data = Dist::get(rel);
    if data.is_none() && rel != "index.html" {
        data = Dist::get("index.html"); // SPA fallback
    }
    let Some(bytes) = data else {
        // 404：纯文本 body，无 content-type（Node 原样）
        return (StatusCode::NOT_FOUND, "dist 未构建").into_response();
    };
    // 怪癖复刻：Content-Type/Cache 按请求的 rel 计算——缺失资源 fallback 到 index.html
    // 时仍用请求扩展名的 MIME 与 assets/ 的 immutable（与 Node 行为一致）
    (
        StatusCode::OK,
        [
            (header::CONTENT_TYPE, static_mime(rel)),
            (header::CACHE_CONTROL, cache),
        ],
        bytes.data.into_owned(),
    )
        .into_response()
}
