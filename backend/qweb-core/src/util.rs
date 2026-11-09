// 路径规范与文案工具 —— 对照 server.mjs:35-37,119-121 及各处错误文案
use percent_encoding::{AsciiSet, NON_ALPHANUMERIC, utf8_percent_encode};

/// 反斜杠一律转正斜杠（对外路径约定；win 盘符跨盘也安全）
// 与 server.mjs 同名，保留大写单字母形态
#[allow(non_snake_case)]
pub fn P(p: &str) -> String {
    p.replace('\\', "/")
}

/// 词法归一：等价 node path.resolve（不触盘、不解析符号链接）。
/// 相对路径拼服务进程 CWD；消解 `.`/`..`；折叠重复斜杠；空入参 → CWD。
/// 刻意不引 path-clean：守卫判断（`p=="/"`、盘符根、`to.starts_with(from+"/")`）
/// 需要与本函数输出逐字符可比。
pub fn safe_path(input: &str) -> String {
    let s = P(input);
    let cwd = std::env::current_dir()
        .map(|p| p.to_string_lossy().replace('\\', "/"))
        .unwrap_or_default();
    let is_drive = s.len() >= 2 && s.as_bytes()[1] == b':' && s.as_bytes()[0].is_ascii_alphabetic();
    let full = if s.starts_with('/') || is_drive {
        s.clone()
    } else if s.is_empty() {
        cwd
    } else {
        format!("{cwd}/{s}")
    };
    let mut out: Vec<String> = Vec::new();
    for seg in full.split('/') {
        match seg {
            "" | "." => {}
            ".." => {
                // 盘符段（"C:"）是盘根，不弹 —— 对应 node 的各盘根语义
                if let Some(last) = out.last() {
                    if last.len() != 2 || !last.ends_with(':') {
                        out.pop();
                    }
                }
            }
            other => out.push(other.to_string()),
        }
    }
    if is_drive {
        // out[0] 即盘符段："C:/x/y"；仅盘符时回 "C:"
        if out.is_empty() {
            s[..2].to_string()
        } else {
            format!("{}/{}", out[0], out[1..].join("/"))
        }
    } else {
        format!("/{}", out.join("/"))
    }
}

/// JS `String.length`（UTF-16 码元数）：BMP=1，增平面=2。
/// PUT /api/fs/file 的 size 字段与 Node 对齐用（GET 的 size 是字节数——Node 原有不一致，照抄）。
pub fn utf16_len(s: &str) -> usize {
    s.chars().map(|c| if (c as u32) > 0xFFFF { 2 } else { 1 }).sum()
}

/// JS encodeURIComponent 的精确不转义集：A-Za-z0-9 - _ . ! ~ * ' ( )
const JS_URI_SAFE: AsciiSet = NON_ALPHANUMERIC
    .remove(b'-').remove(b'_').remove(b'.').remove(b'!')
    .remove(b'~').remove(b'*').remove(b'\'').remove(b'(').remove(b')');
pub fn js_encode_uri_component(s: &str) -> String {
    utf8_percent_encode(s, &JS_URI_SAFE).to_string()
}

/// JS decodeURIComponent 严格语义：`%` 后必须跟两个十六进制位，且解码结果须为合法 UTF-8；
/// 否则 Err（Node 此处抛 URI malformed → 连接吊死；Rust 改判 400，见偏差清单）。
pub fn js_decode_uri_component(s: &str) -> Result<String, ()> {
    let bytes = s.as_bytes();
    let mut out: Vec<u8> = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' {
            let hex = bytes.get(i + 1..i + 3).ok_or(())?;
            let hi = (hex[0] as char).to_digit(16).ok_or(())?;
            let lo = (hex[1] as char).to_digit(16).ok_or(())?;
            out.push((hi * 16 + lo) as u8);
            i += 3;
        } else {
            out.push(bytes[i]);
            i += 1;
        }
    }
    String::from_utf8(out).map_err(|_| ())
}

/// fs 错误文案：NotFound 必须产出含 "no such file or directory" 的文案
/// （前端 Editor 以 /ENOENT|no such/i 匹配判断文件已删除）。
pub fn io_msg(e: &std::io::Error, ctx: &str) -> String {
    if e.kind() == std::io::ErrorKind::NotFound {
        format!("ENOENT: no such file or directory, {ctx}")
    } else {
        e.to_string()
    }
}

/// 毫秒时间戳（Date.now()）
pub fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}
