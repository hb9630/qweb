// keeperd 反代 —— 对照 server.mjs:352-377
// /api/keeper/{path} → keeperd/{path}：透传方法/query/authorization/body；
// 非 GET 强制 content-type: application/json；超时 GET 60s / 其他 600s。
use crate::httpbase::{json_resp, read_body, text_resp};
use crate::App;
use axum::body::Body;
use axum::http::{header, HeaderValue, Method, Response, StatusCode};


pub async fn proxy(
    app: &App,
    method: &Method,
    pathname: &str,
    query: Option<&str>,
    authorization: Option<HeaderValue>,
    body: Option<Body>,
) -> Response<Body> {
    let target = format!(
        "{}{}{}",
        app.cfg.keeperd_url,
        &pathname["/api/keeper".len()..],
        query.map(|q| format!("?{q}")).unwrap_or_default(),
    );
    let mut req = app.http.proxy.request(method.clone(), &target);
    if *method == Method::GET {
        req = req.timeout(std::time::Duration::from_secs(60));
    } else {
        req = req
            .timeout(std::time::Duration::from_secs(600))
            .header(header::CONTENT_TYPE, "application/json");
        if let Some(body) = body {
            match read_body(body, 96 * 1024 * 1024).await {
                Ok(b) => {
                    if !b.is_empty() {
                        req = req.body(b);
                    }
                }
                Err("too large") => return json_resp(StatusCode::PAYLOAD_TOO_LARGE, serde_json::json!({ "error": "文件过大" })),
                Err(_) => return text_resp(StatusCode::BAD_REQUEST, ""),
            }
        }
    }
    if let Some(a) = authorization {
        req = req.header(header::AUTHORIZATION, a);
    }
    match req.send().await {
        Ok(r) => {
            let ct = r
                .headers()
                .get(header::CONTENT_TYPE)
                .and_then(|v| v.to_str().ok())
                .unwrap_or("application/json")
                .to_string();
            let status = StatusCode::from_u16(r.status().as_u16()).unwrap_or(StatusCode::BAD_GATEWAY);
            let body = r.bytes().await.unwrap_or_default();
            Response::builder()
                .status(status)
                .header(header::CONTENT_TYPE, ct)
                .body(Body::from(body))
                .expect("keeper proxy response")
        }
        Err(e) => json_resp(
            StatusCode::BAD_GATEWAY,
            serde_json::json!({ "error": format!("keeperd 不可达: {e}") }),
        ),
    }
}
