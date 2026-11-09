// ccweb 浏览器版 —— CLI 解析 + listen/启动横幅/退出清理 + 默认自动开浏览器。
// 业务在 ccweb-core；共用逻辑在 common.rs（desktop 壳同源引用）。
// Windows 桌面版见 bin/desktop.rs（--features desktop 编出 ccweb-desktop.exe）。
// aws-lc（rustls 默认密码库）汇编在 macOS ld64 下 "could not create compact unwind" 是已知噪音，
// 无功能影响；reqwest 0.13 无 ring 后台 feature，此处静音 linker_messages
#![allow(linker_messages)]
#[path = "common.rs"]
mod common;

use std::sync::Arc;

#[tokio::main]
async fn main() {
    let mut cfg = ccweb_core::config::Config::from_env();
    let cli = common::apply_cli(&mut cfg);
    let app = common::build_app(&cfg);
    ccweb_core::spawn_background(app.clone());

    let addr = format!("0.0.0.0:{}", cfg.port);
    let listener = tokio::net::TcpListener::bind(&addr)
        .await
        .unwrap_or_else(|e| panic!("监听 {addr} 失败: {e}"));
    common::banner(&cfg, cli.port_from, &addr);

    // 默认自动开浏览器（--no-browser / CCWEB_NO_BROWSER=1 关：服务器、反代、桌面壳内起浏览器版时）
    if !cli.no_browser {
        common::open_browser(&format!("http://127.0.0.1:{}", cfg.port));
    }

    // 退出清理：结束所有 claude 子进程，防孤儿
    let shutdown_app = app.clone();
    tokio::spawn(async move {
        wait_signal().await;
        ccweb_core::shutdown(&shutdown_app).await;
        tokio::time::sleep(std::time::Duration::from_millis(500)).await;
        std::process::exit(0);
    });

    axum::serve(listener, ccweb_core::router(app))
        .await
        .expect("server error");
}

async fn wait_signal() {
    #[cfg(unix)]
    {
        use tokio::signal::unix::{signal, SignalKind};
        let mut term = signal(SignalKind::terminate()).expect("SIGTERM handler");
        let mut int = signal(SignalKind::interrupt()).expect("SIGINT handler");
        tokio::select! {
            _ = term.recv() => {}
            _ = int.recv() => {}
        }
    }
    #[cfg(not(unix))]
    {
        let _ = tokio::signal::ctrl_c().await;
    }
}
