# qtom 引擎：下一步工作清单（2026-11-09 · amdr9 接力）

> 前情：2026-11-08 在 Mac 上完成 qtom 引擎全链路开发（qtom Rust 猫 + qweb 接入 +
> 前端选择器 + dsweb daemon adapter 插件化）。stub 链路 e2e 15/15 全绿；真链路已通
> （无头模式 + 工具桥返回标准 tool_calls，详见文末"关键结论"）。工作转移到 amdr9 继续。

## 一、收尾验证（按序，全部在 amdr9 上做）

### 1. 环境就绪
```bash
cd ~/Code/qweb
rm -f qweb qtom                                  # 删掉 Mac 编译的旧二进制（Linux 用不了）
(cd frontend && npm install)                      # 前端依赖
(cd backend && cargo build -p qtom -p qweb-server)   # Rust 依赖编译（走 rsproxy 镜像）
rm -f ~/Code/qweb/qweb ~/Code/qweb/qtom        # 若 build 产物异常再清
```

### 2. dsweb daemon 起 + 登录（amdr9 上首次）
```bash
cd ~/Code/qweb/contrib/dsweb && npm install
PORT=8300 DSWEB_TOKEN=t node daemon.js            # 默认有头：Linux 无 X 需要 xvfb（apt install xvfb）
# 有头窗口里登录 DeepSeek 一次（登录态落 ~/.dsweb/profile，之后免登）
# 登录完成后改无头长跑：
#   pkill -f "node daemon.js"; DSWEB_HEADLESS=1 PORT=8300 DSWEB_TOKEN=t node daemon.js
```
> ⚠️ amdr9 若是无 GUI 服务器：有头登录那步借 `xvfb-run -a node daemon.js` + VNC/截图确认登录页，
> 或者把 Mac 上 `~/.dsweb/profile` 整目录 rsync 过去（已登录态直接可用，推荐）。

### 3. SSE 流式单验（11-08 唯一未完项）
```bash
curl -s -N http://127.0.0.1:8300/v1/chat/completions -H 'Content-Type: application/json' \
  -H 'Authorization: Bearer t' \
  -d '{"stream":true,"messages":[{"role":"user","content":"只回两个字：在吗"}]}'
```
期望：`data: {...delta.content...}` 多帧 + `finish_reason:"stop"` + `data: [DONE]`。
11-08 晚非流式已通、流式分支代码已就位但未及复验（当晚 curl head 截断把队列搞乱过一次，
重测即可分辨真问题/偶然）。若流式不稳，可先让 qtom 走非流式兜底（见下）。

### 4. qtom 全链路真跑（多工具任务）
```bash
mkdir -p /tmp/qtom-real && echo "# 测试" > /tmp/qtom-real/note.md
cd /tmp/qtom-real && ~/Code/qweb/backend/target/debug/qtom \
  --dsweb-url http://127.0.0.1:8300 --dsweb-token t \
  --cwd /tmp/qtom-real --projects /tmp/qtom-real/.projects \
  -p "看看这个目录里有什么文件，读出 .md 文件的内容" --yes
```
期望：流式输出 → glob/bash 工具调用 → read_file → 收尾总结。

### 5. qweb 集成 e2e（stub + 真链路各一遍）
```bash
node frontend/test/dsweb-stub.mjs &               # 桩（8312）
QWEB_QTOM=$PWD/backend/target/debug/qtom backend/target/debug/qweb \
  --port 18099 --home /tmp/qtom-home --dsweb http://127.0.0.1:8312 --dsweb-token t &
node frontend/test/qtom-e2e.mjs http://127.0.0.1:18099    # 15 断言全绿
# 真链路：--dsweb 指向 8300（真 daemon），UI 开 qtom 会话跑一个真实多工具任务
```

### 6. 发布构建
```bash
./build.sh          # 产出 ./qweb + ./qtom 双二进制
```

## 二、遗留改进项（非阻塞，按价值排序）

1. **流式降级开关**：qtom 客户端若 daemon 流式异常，自动改发 `stream:false`
   （daemon 非流式分支 11-08 已验证稳定）——dsclient.rs 的 chat() 加个重试参数即可。
2. **16090/amdr9 部署形态**：restart.sh 目前只管 qweb；qtom 部署在 qweb 同目录
   （build.sh deploy 已处理），daemon 用 systemd user unit（模板抄 gb10 的
   ~/.config/systemd/user/dsweb.service，加 `Environment=DSWEB_HEADLESS=1`）。
3. **审批策略扩展**：v1 固定 bash 必问/文件工具不问；后续可映射 qweb 前端的
   权限模式（dontAsk→跳过 bash 审批，plan→全问）——qtom 侧已收 Ctrl 帧，只差语义。
4. **usage 真值**：现在按字符/3 估算；daemon 侧其实能从网页抓到 token 数（回复区
   角落有显示），可让 daemon 回传 `usage` 字段，qtom 透传。
5. **多 adapter**：daemon 已按 adapters/ 目录热加载；将来接其他网页版模型（kimi/
   元宝）各放一个 adapter 文件即可，daemon 的 urlMatch 路由已留好。

## 三、关键结论（11-08 排障记录，避免重踩）

| 现象 | 根因 | 解法（已落码） |
|---|---|---|
| 消息发出但 `.ds-message`=0 | **后台窗口渲染节流**冻住虚拟列表（Mac 有头窗在后台） | `DSWEB_HEADLESS=1` 无头跑（Linux 服务器天然无此问题——Xvfb 恒前台） |
| 点击发送键无效 | native setter 填充绕过 React ValueTracker，组件 state 空 | CDP `Input.insertText` 输入法级填充（daemon 已实现） |
| 多行文本 Enter 没发出去 | 新版页面 Enter=换行 | 点发送键（几何定位 ds-button--primary，精确类名——iconLabelPrimary 是别的键） |
| 锚点 lastIndexOf 命中输入残留 | textarea.value 进 innerText 且排 DOM 序末尾 | readMain 用右列几何定位（输入框上方同列取最长文本容器），天然排除 |
| 稳态判定被侧栏抖动重置 | AI 标题/新会话插入离散变化 | 稳态阈值 8 次采样（4s）跨过抖动；发送成功判定用 URL 跳转双信号 |

**架构分层**（改版只动 adapter，15 分钟热修）：
- `daemon.js` = 引擎无关核心：HTTP/OpenAI 面、串行队列、工具桥、锚点差分驱动循环、
  发送重试、稳态检测、浏览器生命周期（30s 自愈）
- `adapters/deepseek.js` = 页面适配：isReady/fill/send/readMain/uiTail 全部 DOM 细节，
  mtime 热加载（浏览器/登录态/队列不动）

**协议链**：qweb UI ←WS→ qweb(spawn qtom，CC stream-json 同构) ←stdio→ qtom 猫
（六工具+审批+transcript） ←SSE→ dsweb daemon（文本工具协议桥） ←CDP→ DeepSeek 网页
