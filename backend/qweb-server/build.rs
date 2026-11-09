// desktop feature：tauri 的 context 生成（tauri.conf.json → 编译期代码）。
// 浏览器版（默认）无 build 步骤
fn main() {
    #[cfg(feature = "desktop")]
    tauri_build::build();
}
