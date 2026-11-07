// fs API —— 对照 server.mjs:417-591（列表/读存/raw/六种 op/下载）
use axum::body::Body;
use axum::http::{header, Response, StatusCode};
use base64::engine::general_purpose::STANDARD as B64;
use base64::Engine as _;
use serde_json::json;

use crate::httpbase::{json_resp, query_param, read_body, text_resp};
use crate::util::{io_msg, js_encode_uri_component, safe_path, utf16_len};
use crate::App;

fn err_400(msg: String) -> Response<Body> {
    json_resp(StatusCode::BAD_REQUEST, json!({ "error": msg }))
}

/// localeCompare 近似：先大小写不敏感，再大小写敏感决胜（ASCII 常见序与 ICU 一致）
fn ci_cmp(a: &str, b: &str) -> std::cmp::Ordering {
    let la = a.to_lowercase();
    let lb = b.to_lowercase();
    la.cmp(&lb).then(a.cmp(b))
}

/// GET/任意 /api/fs —— 目录列表（server.mjs:417-432）
pub async fn list(app: &App, query: Option<&str>) -> Response<Body> {
    let p = safe_path(&query_param(query, "path").unwrap_or_else(|| app.cfg.child_home.clone()));
    let hidden = query_param(query, "hidden").as_deref() == Some("1");
    let mut rd = match tokio::fs::read_dir(&p).await {
        Ok(rd) => rd,
        Err(e) => return err_400(io_msg(&e, &format!("scandir '{p}'"))),
    };
    let mut dirs: Vec<String> = vec![];
    let mut files: Vec<(String, u64)> = vec![];
    while let Ok(Some(ent)) = rd.next_entry().await {
        let name = ent.file_name().to_string_lossy().into_owned();
        if !hidden && name.starts_with('.') {
            continue;
        }
        // Node withFileTypes：symlink 既非 dir 也非 file → 两边都不出现，保持一致
        let Ok(ft) = ent.file_type().await else { continue };
        if ft.is_dir() {
            dirs.push(name);
        } else if ft.is_file() {
            let size = match tokio::fs::metadata(ent.path()).await {
                Ok(m) => m.len(),
                Err(_) => continue,
            };
            files.push((name, size));
        }
    }
    dirs.sort();
    files.sort_by(|a, b| ci_cmp(&a.0, &b.0));
    let files: Vec<_> = files.into_iter().map(|(name, size)| json!({ "name": name, "size": size })).collect();
    json_resp(
        StatusCode::OK,
        json!({ "path": p, "dirs": dirs, "files": files }),
    )
}

/// /api/fs/dirs —— 只列子目录（工作目录选择器；win 根级给盘符）（server.mjs:434-453）
pub async fn dirs_list(_app: &App, query: Option<&str>) -> Response<Body> {
    let q = safe_path(&query_param(query, "path").unwrap_or_default());
    let hidden = query_param(query, "hidden").as_deref() == Some("1");
    let root_level = q.is_empty() || q == "/";
    if crate::config::IS_WIN && root_level {
        let mut drives = vec![];
        for c in b'A'..=b'Z' {
            let d = format!("{}:", c as char);
            if tokio::fs::metadata(format!("{d}/")).await.is_ok() {
                drives.push(d);
            }
        }
        return json_resp(StatusCode::OK, json!({ "path": "", "dirs": drives, "drives": true }));
    }
    let base = if root_level { "/".to_string() } else { q };
    let mut rd = match tokio::fs::read_dir(&base).await {
        Ok(rd) => rd,
        Err(e) => return err_400(io_msg(&e, &format!("scandir '{base}'"))),
    };
    let mut dirs = vec![];
    while let Ok(Some(ent)) = rd.next_entry().await {
        let name = ent.file_name().to_string_lossy().into_owned();
        if !hidden && name.starts_with('.') {
            continue;
        }
        if ent.file_type().await.map(|t| t.is_dir()).unwrap_or(false) {
            dirs.push(name);
        }
    }
    dirs.sort();
    json_resp(StatusCode::OK, json!({ "path": base, "dirs": dirs, "drives": false }))
}

/// GET /api/fs/file —— 读文件（binary 嗅探：头 8000 字节含 NUL 或 >512KiB）（server.mjs:454-470）
pub async fn file_get(query: Option<&str>) -> Response<Body> {
    let p = safe_path(&query_param(query, "path").unwrap_or_default());
    if p.is_empty() {
        return err_400("路径超出工作区范围".into());
    }
    let st = match tokio::fs::metadata(&p).await {
        Ok(st) => st,
        Err(e) => return err_400(io_msg(&e, &format!("stat '{p}'"))),
    };
    if st.is_dir() {
        return err_400("是目录".into());
    }
    let size = st.len();
    // 只读头 8000 字节嗅探（Node 全量读再切片——大文件改进点，行为等价）
    use tokio::io::AsyncReadExt;
    let mut head = vec![0u8; 8000.min(size as usize)];
    if !head.is_empty() {
        if let Ok(mut f) = tokio::fs::File::open(&p).await {
            let _ = f.read_exact(&mut head).await;
        }
    }
    let binary = head.contains(&0);
    if binary || size > 512 * 1024 {
        return json_resp(StatusCode::OK, json!({ "path": p, "size": size, "binary": true, "content": null }));
    }
    let content = match tokio::fs::read(&p).await {
        Ok(b) => String::from_utf8_lossy(&b).into_owned(), // Node toString("utf8") 同为有损
        Err(e) => return err_400(io_msg(&e, &format!("open '{p}'"))),
    };
    json_resp(StatusCode::OK, json!({ "path": p, "size": size, "binary": false, "content": content }))
}

/// GET /api/fs/raw —— 原始字节流（图片/SVG/PDF 预览）（server.mjs:472-491）
pub async fn raw(query: Option<&str>) -> Response<Body> {
    let p = safe_path(&query_param(query, "path").unwrap_or_default());
    if p.is_empty() {
        return err_400("路径超出工作区范围".into());
    }
    let st = match tokio::fs::metadata(&p).await {
        Ok(st) => st,
        Err(e) => return err_400(io_msg(&e, &format!("stat '{p}'"))),
    };
    if st.is_dir() {
        return err_400("是目录".into());
    }
    let mime = {
        let name = p.rsplit('/').next().unwrap_or(&p);
        let e = match name.rfind('.') {
            Some(i) => name[i..].to_lowercase(),
            None => String::new(),
        };
        match e.as_str() {
            ".png" => "image/png",
            ".jpg" | ".jpeg" => "image/jpeg",
            ".gif" => "image/gif",
            ".webp" => "image/webp",
            ".bmp" => "image/bmp",
            ".ico" => "image/x-icon",
            ".avif" => "image/avif",
            ".svg" => "image/svg+xml",
            ".pdf" => "application/pdf",
            _ => "application/octet-stream",
        }
    };
    let f = match tokio::fs::File::open(&p).await {
        Ok(f) => f,
        Err(e) => return err_400(io_msg(&e, &format!("open '{p}'"))),
    };
    Response::builder()
        .status(StatusCode::OK)
        .header(header::CONTENT_TYPE, mime)
        .header(header::CONTENT_LENGTH, st.len())
        .header(header::CACHE_CONTROL, "no-store")
        .header(header::CONTENT_DISPOSITION, "inline")
        .body(Body::from_stream(tokio_util::io::ReaderStream::new(f)))
        .expect("raw response")
}

/// PUT /api/fs/file —— 保存（size=JS UTF-16 码元数，与 Node .length 对齐）（server.mjs:492-504）
pub async fn file_put(body: Body) -> Response<Body> {
    let body = match read_body(body, 96 * 1024 * 1024).await {
        Ok(b) => b,
        Err("too large") => return json_resp(StatusCode::PAYLOAD_TOO_LARGE, json!({ "error": "文件过大" })),
        Err(_) => return text_resp(StatusCode::BAD_REQUEST, ""),
    };
    let q: serde_json::Value = match serde_json::from_slice(&body) {
        Ok(v) => v,
        Err(_) => return err_400("bad json".into()),
    };
    let p = safe_path(q.get("path").and_then(|v| v.as_str()).unwrap_or(""));
    if p.is_empty() {
        return err_400("路径超出工作区范围".into());
    }
    let content = q.get("content").and_then(|v| v.as_str()).unwrap_or("");
    match tokio::fs::write(&p, content).await {
        Ok(_) => json_resp(StatusCode::OK, json!({ "ok": true, "path": p, "size": utf16_len(content) })),
        Err(e) => err_400(io_msg(&e, &format!("open '{p}'"))),
    }
}

/// Node Buffer.from(s,"base64") 的宽容语义：剔除非法字符后再解码，缺省 padding 可容忍
fn b64_lenient(s: &str) -> Vec<u8> {
    let cleaned: String = s.chars().filter(|c| c.is_ascii_alphanumeric() || *c == '+' || *c == '/').collect();
    let padded = match cleaned.len() % 4 {
        2 => format!("{cleaned}=="),
        3 => format!("{cleaned}="),
        _ => cleaned,
    };
    B64.decode(padded.as_bytes()).unwrap_or_default()
}

fn join_name(path: &str, name: &str) -> String {
    if name.is_empty() {
        path.to_string()
    } else {
        format!("{path}/{name}")
    }
}

/// POST /api/fs/op —— mkdir/touch/copy/rename/delete/upload（server.mjs:506-563）
pub async fn op(app: &App, body: Body) -> Response<Body> {
    let body = match read_body(body, 90 * 1024 * 1024).await {
        Ok(b) => b,
        Err("too large") => return json_resp(StatusCode::PAYLOAD_TOO_LARGE, json!({ "error": "文件过大（base64 后 >90MB）" })),
        Err(_) => return text_resp(StatusCode::BAD_REQUEST, ""),
    };
    let q: serde_json::Value = match serde_json::from_slice(&body) {
        Ok(v) => v,
        Err(_) => return err_400("bad json".into()),
    };
    let s = |k: &str| q.get(k).and_then(|v| v.as_str()).unwrap_or("");
    let child_home = &app.cfg.child_home;
    let res: Result<serde_json::Value, String> = match q.get("op").and_then(|v| v.as_str()).unwrap_or("") {
        // 各分支包 async 块使 `?` 合法（外层函数返回 Response）
        "mkdir" => (async {
            let p = safe_path(&join_name(s("path"), s("name")));
            if p.is_empty() || p == *child_home {
                Err("非法路径".into())
            } else if std::path::Path::new(&p).exists() {
                Err("已存在同名文件/文件夹".into())
            } else {
                tokio::fs::create_dir_all(&p).await.map_err(|e| io_msg(&e, &format!("mkdir '{p}'")))?;
                Ok(json!({ "ok": true, "path": p }))
            }
        })
        .await,
        "touch" => (async {
            let p = safe_path(&join_name(s("path"), s("name")));
            if p.is_empty() || p == *child_home {
                Err("非法路径".into())
            } else if std::path::Path::new(&p).exists() {
                Err("已存在同名文件".into())
            } else {
                tokio::fs::write(&p, "").await.map_err(|e| io_msg(&e, &format!("open '{p}'")))?;
                Ok(json!({ "ok": true, "path": p }))
            }
        })
        .await,
        "copy" => (async {
            let from = safe_path(s("path"));
            let to = safe_path(s("to"));
            if from.is_empty() || to.is_empty() || from == *child_home || from == to {
                Err("非法路径".into())
            } else if std::path::Path::new(&to).exists() {
                Err("目标已存在同名文件/文件夹".into())
            } else if to.starts_with(&format!("{from}/")) {
                Err("不能复制到自身内部".into())
            } else {
                let st = tokio::fs::metadata(&from).await.map_err(|e| io_msg(&e, &format!("stat '{from}'")))?;
                if st.is_dir() {
                    copy_dir_all(&from, &to).await?;
                } else {
                    tokio::fs::copy(&from, &to).await.map_err(|e| io_msg(&e, &format!("copy '{from}' -> '{to}'")))?;
                }
                Ok(json!({ "ok": true, "path": to }))
            }
        })
        .await,
        "rename" => (async {
            let from = safe_path(s("path"));
            let to = safe_path(s("to"));
            if from.is_empty() || to.is_empty() || from == *child_home {
                Err("非法路径".into())
            } else if from == to {
                Ok(json!({ "ok": true, "path": to })) // 未改名直接确认=幂等 no-op
            } else if std::path::Path::new(&to).exists() {
                Err("目标已存在".into())
            } else {
                tokio::fs::rename(&from, &to).await.map_err(|e| io_msg(&e, &format!("rename '{from}' -> '{to}'")))?;
                Ok(json!({ "ok": true, "path": to }))
            }
        })
        .await,
        "delete" => (async {
            let p = safe_path(s("path"));
            let drive_root = p.len() == 2 && p.as_bytes()[1] == b':' && p.as_bytes()[0].is_ascii_alphabetic()
                || p.len() == 3 && p.as_bytes()[1] == b':' && p.as_bytes()[0].is_ascii_alphabetic() && p.ends_with('/');
            if p.is_empty() || p == "/" || p == *child_home || drive_root {
                Err("不能删除根目录/盘符".into())
            } else {
                // rm {recursive,force}：缺失视为成功；目录递归删，文件删
                match tokio::fs::metadata(&p).await {
                    Ok(m) if m.is_dir() => {
                        tokio::fs::remove_dir_all(&p).await.map_err(|e| io_msg(&e, &format!("rm '{p}'")))?;
                    }
                    Ok(_) => {
                        tokio::fs::remove_file(&p).await.map_err(|e| io_msg(&e, &format!("rm '{p}'")))?;
                    }
                    Err(_) => {} // force
                }
                Ok(json!({ "ok": true }))
            }
        })
        .await,
        "upload" => (async {
            let p = safe_path(&join_name(s("path"), s("name")));
            if p.is_empty() {
                Err("非法路径".into())
            } else {
                let buf = b64_lenient(s("data"));
                if let Some(parent) = std::path::Path::new(&p).parent() {
                    tokio::fs::create_dir_all(parent).await.map_err(|e| io_msg(&e, &format!("mkdir '{parent:?}'")))?;
                }
                let size = buf.len();
                tokio::fs::write(&p, &buf).await.map_err(|e| io_msg(&e, &format!("open '{p}'")))?;
                Ok(json!({ "ok": true, "path": p, "size": size }))
            }
        })
        .await,
        other => return err_400(format!("未知操作 {other}")),
    };
    match res {
        Ok(v) => json_resp(StatusCode::OK, v),
        Err(msg) => err_400(msg),
    }
}

async fn copy_dir_all(src: &str, dst: &str) -> Result<(), String> {
    tokio::fs::create_dir_all(dst).await.map_err(|e| io_msg(&e, &format!("mkdir '{dst}'")))?;
    let mut rd = tokio::fs::read_dir(src)
        .await
        .map_err(|e| io_msg(&e, &format!("scandir '{src}'")))?;
    while let Some(ent) = rd
        .next_entry()
        .await
        .map_err(|e| io_msg(&e, &format!("readdir '{src}'")))?
    {
        let name = ent.file_name().to_string_lossy().into_owned();
        let from = format!("{src}/{name}");
        let to = format!("{dst}/{name}");
        let ft = ent.file_type().await.map_err(|e| e.to_string())?;
        if ft.is_dir() {
            Box::pin(copy_dir_all(&from, &to)).await?;
        } else {
            tokio::fs::copy(&from, &to).await.map_err(|e| io_msg(&e, &format!("copy '{from}' -> '{to}'")))?;
        }
    }
    Ok(())
}

/// GET /api/fs/download —— 文件直传 / 目录 tar.gz 流（server.mjs:565-591）
pub async fn download(app: &App, query: Option<&str>) -> Response<Body> {
    let p = safe_path(&query_param(query, "path").unwrap_or_default());
    if p.is_empty() || p == app.cfg.child_home {
        return err_400("非法路径".into());
    }
    let name = p.rsplit('/').next().unwrap_or(&p).to_string();
    let st = match tokio::fs::metadata(&p).await {
        Ok(st) => st,
        Err(e) => return err_400(io_msg(&e, &format!("stat '{p}'"))),
    };
    if st.is_file() {
        let f = match tokio::fs::File::open(&p).await {
            Ok(f) => f,
            Err(e) => return err_400(io_msg(&e, &format!("open '{p}'"))),
        };
        return Response::builder()
            .status(StatusCode::OK)
            .header(header::CONTENT_TYPE, "application/octet-stream")
            .header(header::CONTENT_LENGTH, st.len())
            .header(
                header::CONTENT_DISPOSITION,
                format!("attachment; filename*=UTF-8''{}", js_encode_uri_component(&name)),
            )
            .body(Body::from_stream(tokio_util::io::ReaderStream::new(f)))
            .expect("download response");
    }
    // 目录：tar.gz 流式打包（Node spawn 外部 tar → Rust 内建；客户端中断即停）
    crate::tardown::tar_gz_response(&p, &name)
}
