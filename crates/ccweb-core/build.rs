// 编译期守卫：rust-embed 需要 frontend/dist 存在，缺失时给出可操作报错
// （debug 构建运行期读盘，dist 可随时重建无需重编；release 嵌入二进制）
use std::path::Path;

fn main() {
    let dist = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../frontend/dist");
    println!("cargo:rerun-if-changed={}", dist.display());
    if !dist.join("index.html").is_file() {
        panic!("frontend/dist 缺失：先执行 `npm run build -w frontend` 再编译");
    }
}
