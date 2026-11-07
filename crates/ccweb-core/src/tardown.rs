// 目录 → tar.gz 流式打包 —— 替代 server.mjs:580-588 的外部 tar 子进程
// （内建 tar+flate2；客户端中断响应体 → receiver drop → 打包即刻停止）
use axum::body::Body;
use axum::http::{header, Response, StatusCode};
use std::io::Write;

/// 把 dir 下的内容以 `name/` 前缀打成 gzip 流（等价 `tar czf - -C parent name` 的条目布局）
pub fn tar_gz_response(dir: &str, name: &str) -> Response<Body> {
    // 有界通道背压；响应体被丢弃（客户端断开）→ rx drop → blocking_send 失败 → 打包中止
    let (tx, rx) = tokio::sync::mpsc::channel::<Result<Vec<u8>, std::io::Error>>(16);
    let (dir, arc_name) = (dir.to_string(), name.to_string());
    tokio::task::spawn_blocking(move || {
        let writer = ChunkWriter { tx: &tx };
        let enc = flate2::write::GzEncoder::new(writer, flate2::Compression::default());
        let mut tar = tar::Builder::new(enc);
        let _ = tar.append_dir_all(&arc_name, &dir); // 失败（目录消失等）→ 静默短包，与 Node tar 退出即 end 对齐
        let _ = tar.into_inner().and_then(|enc| enc.finish().map(|mut w| w.flush()));
    });
    Response::builder()
        .status(StatusCode::OK)
        .header(header::CONTENT_TYPE, "application/x-gzip")
        .header(
            header::CONTENT_DISPOSITION,
            format!("attachment; filename*=UTF-8''{}.tar.gz", crate::util::js_encode_uri_component(name)),
        )
        .body(Body::from_stream(tokio_stream::wrappers::ReceiverStream::new(rx)))
        .expect("tar response")
}

/// std::io::Write → 分块送进通道；通道关闭（下游断开）时报错中止打包
struct ChunkWriter<'a> {
    tx: &'a tokio::sync::mpsc::Sender<Result<Vec<u8>, std::io::Error>>,
}

impl Write for ChunkWriter<'_> {
    fn write(&mut self, buf: &[u8]) -> std::io::Result<usize> {
        self.tx
            .blocking_send(Ok(buf.to_vec()))
            .map_err(|_| std::io::Error::other("下游已断开"))?;
        Ok(buf.len())
    }
    fn flush(&mut self) -> std::io::Result<()> {
        Ok(())
    }
}
