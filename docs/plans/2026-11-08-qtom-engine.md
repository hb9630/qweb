# qtom：qweb 自带的免费 agent（独立子进程，DeepSeek 网页版驱动）

## Context

qweb 目前唯一引擎是 `claude` CLI（stream-json stdio 子进程）。gb10 上已跑通 dsweb daemon（CDP 驱动 chat.deepseek.com 的 OpenAI 兼容端点），且实测网页版 DeepSeek 严格遵循文本工具协议（`<tool_call>{"name":..,"arguments":..}</tool_call>`，两轮实测：调用格式正确、结果回传后正常收尾）。

**终态（用户定调）**：做一个**自己的 pi——qtom（一只猫，qkeeper 动物园第一只居民）**，独立二进制子进程，被 qweb 像spawn claude 一样 spawn。stdio 直接说 Claude Code stream-json 协议 → qweb Session 层几乎零改动。模型通道是用户自部署的 dsweb 端点（文档 + contrib/dsweb/daemon.js 随仓库分发，用户开 CDP 浏览器登录 DeepSeek）。配置后 UI 出现「qtom · DeepSeek 网页版（免费）」引擎——**装 qweb 白送一个免费 agent**，零额外安装；qtom 也可脱离 qweb 终端直用（`qtom -p "..."`）。

## 架构（全部已对照源码验证）

1. **qtom = 独立 crate `backend/qtom/`（bin）**，stdio 协议 = CC stream-json 同构：
   - stdout：`system/init`、`stream_event`（message_start/content_block_start/content_block_delta）、`assistant` 定稿、`user`(tool_result)、`result`、`control_request`(can_use_tool 审批)
   - stdin：CC SDK 格式 `{"type":"user","message":{...}}`、`control_response`（审批回包）、`control_request`(interrupt)
   - **qweb 的 stdin 写入/stdout 读取/stderr/exit watcher/SIGTERM kill/审批往返/interrupt 全部原样复用**——sessions.rs 只在 spawn 命令构造处分叉
2. **qtom 自含 agent 内核**：OpenAI 兼容 SSE 客户端（reqwest，需加 stream feature）+ 轮次循环 + 工具集 + 审批（发 control_request 后 select! 等 stdin control_response/SSE/工具 future）+ transcript 读写
3. **resume**：`qtom --resume <sid>` 自己读 transcript（--projects <dir> 默认 ~/.claude/projects）；写 CC JSONL 格式 → qweb 的 /api/history 列表/回放/跨重启 resume 全套免费。**每轮全量发 messages**（daemon 会话亲和无关紧要）
4. **审批 v1**：bash 必问（control_request → 前端审批卡 → control_response），read/write/edit/glob/grep 不问。审批挂起不超时（qweb 20min reaper 兜底 kill）
5. **工具集 v1（六个）**：read_file / write_file / edit（old_str 精确替换）/ bash（sh -c + kill_on_drop + process_group，64KB 上限，默认 30s 超时）/ glob（手写 matcher，跳 .git/node_modules/target）/ grep（子串 file:line:text）。文件工具词法限制在 cwd 内
6. **id 重写**：daemon 的 call_dsweb_N 每请求重复 → qtom 重写为单调 `toolu_{counter:08x}`（resume 时从 transcript 最大 id 续）；usage 估算（字符/3），assistant 行与 result 行同值
7. **dsweb daemon 文本工具桥**（contrib/dsweb/daemon.js，gb10 现版 delta）：tools 渲染进 system prompt（实测协议）；assistant tool_calls（content 可 null）与 role:"tool"（content 可数组）渲染进拼平文本（`<tool_result name=..>` 块）；流式 holdback 疑似 `<tool_call` 前缀；稳态解析 `<tool_call>` → 一次性 tool_calls delta 块 + finish_reason:"tool_calls"；失败降级纯文本；**带 tools 禁用会话亲和**

## 事件序列（qtom stdout 契约；qweb on_event 原样消费）

启动一次：`system/init`{session_id:uuid, model:"deepseek-web", permissionMode:"default", slash_commands:["clear"], tools:[六件套]}。`/clear` → `conversation_reset`。

一轮（文本+工具）：
1. T `user` 回显 → 2. POST → `stream_event` message_start{model} → 3. text 增量 text_delta → 4. 工具 content_block_start(tool_use) + 原子 input_json_delta → 5. T `assistant` 定稿（content=[text?,tool_use…], stop_reason:"tool_use", usage）+ messages 追加 OpenAI 形态 → 6. 逐工具：bash 先 `control_request`{can_use_tool} 等 control_response（deny → is_error tool_result "User denied"；Interrupt → "[Request interrupted by user]"）→ 执行 → T `user`{tool_result} + role:"tool" 追加 → 7. 回 2 循环 → 8. 收尾 T `result`{usage, model:"deepseek-web", modelUsage{deepseek-web:{contextWindow:65536}}}

Interrupt：drop SSE/工具 future；已定稿工具补合成 is_error tool_result；文本中途丢半截；补 user 行 `[Request interrupted by user]` + result。传输错误：result{subtype:"error_during_execution", usage 全 0}。图片输入：忽略并在回复中说明（v1 不支持）。

## 文件清单

**新**：
- `backend/qtom/`（crate，bin，~900 行）：main.rs（参数 --cwd/--resume/--projects/--dsweb-url/--dsweb-token（env DSWEB_URL/DSWEB_TOKEN 同名覆盖）/ -p 单发模式）、协议层（CC 事件发射到 stdout）、agent 核心（SSE 客户端/轮次循环/审批 select!/工具注册）、transcript 读写（CC JSONL；写入 {projects}/{cwd 编码}/{sid}.jsonl，每行带 cwd/engine:"qtom"/session_id/timestamp）
- `contrib/dsweb/daemon.js`：带工具桥的 daemon（+部署文档引用）
- `frontend/test/dsweb-stub.mjs`（桩服务）+ `frontend/test/qtom-e2e.mjs`（e2e，仿 e2e-test.mjs 零依赖）
- `docs/plans/2026-11-08-qtom-engine.md`（本设计落档）

**改**：
- `backend/Cargo.toml`：workspace 加 qtom 成员；qweb-core 的 reqwest 不动（SSE 客户端只在 qtom crate 里，依赖加在 qtom）
- `backend/qweb-core/src/config.rs`：dsweb_url/dsweb_token（env QWEB_DSWEB_URL/QWEB_DSWEB_TOKEN）+ `qtom_cmd()`（QWEB_QTOM env > 与 qweb 同目录 qtom > PATH，仿 claude_cmd():78-97）
- `backend/qweb-core/src/sessions.rs`：spawn()(:79-107) 命令构造按 engine 分叉（claude args vs `qtom` + `--resume sid`? + envs 加 DSWEB_URL/DSWEB_TOKEN）；`EngineKind{Claude,Qtom}` + snapshot(:304) 加 engine 字段；spawn_new 收 engine。**其余零改动**
- `backend/qweb-core/src/api.rs`：env() 返回 engines:[{id:"claude",label:"Claude Code"},配置后 {id:"qtom",label:"qtom · DeepSeek 网页版（免费）"}]；post() 收 engine 参数（未知→400；qtom 未配 dsweb→400）；resume 时经新 history::transcript_engine 从 transcript 推导（无 engine 字段=claude）
- `backend/qweb-core/src/history.rs`：transcript_engine()（~15 行，读 transcript 行的 engine 字段）
- `backend/qweb-server/src/main.rs`：--dsweb <URL> / --dsweb-token <T> CLI + 启动横幅 qtom 行
- `build.sh`：编译 qweb + qtom 双二进制；deploy 装两个
- `frontend/src/App.tsx`：engines/enginePref 状态（localStorage qweb.engine）、newSession 传 engine、resume 从响应/快照取 engine
- `frontend/src/ChatPanel.tsx`：引擎选择 chip（footer 工具栏，engines>1 时显示，影响下次新会话）；qtom 会话隐藏 TUI resume 按钮/模型菜单/模式菜单/图片附件；reducer 零改动
- `README.md`：qtom 章节（是什么/daemon 部署+CDP 登录/qweb 配置/终端直用 qtom -p/能力边界：单模型、bash 审批其余不问、无图片、估算 usage、选择器脆弱、65536 窗口）

## 实施顺序 + 验证

1. **qtom crate 先行，独立可测**（不碰 qweb）：SSE 解析单测（多行 data/[DONE]/非 SSE 体）→ 工具与路径守卫单测 → 录制 SSE fixture 走全轮断言 stdout 事件序列 → `qtom -p` 对 dsweb-stub.mjs 实跑（文本轮/bash 审批在 -p 模式自动 allow 或 --yes 标志/工具轮/收尾）
2. **qweb 接入**：config/sessions/api/main 改动 → curl POST /api/sessions {"engine":"qtom"} + qtom-e2e.mjs 断言 WS 帧序列（init→message_start→text→tool_use→assistant→can_use_tool→perm allow→tool_result→二轮→result 65536）→ 断开 resume 断言再水化 → 慢流 interrupt → /api/history 列表+回放
3. **前端**：选择器+隐藏项 → npm run build + **./build.sh 全链**（rust-embed，光 npm 无效——见记忆）
4. **daemon 桥**：contrib/dsweb/daemon.js → curl 脚本验证 <tool_call> 往返 → gb10 真网页
5. **真链路 e2e**：qweb --dsweb http://192.168.1.16:8300（token aa4c0802a880b3728fc8a173），UI 开 qtom 会话给真实多工具任务（列目录→读文件→改一处），验证审批卡/transcript 历史/刷新恢复；`qtom -p` 终端直跑一发
6. 改完只构建（./build.sh），**重启 18090 等用户确认**（活会话怕被杀——见记忆）

## 后续（独立任务，不进本 diff）

- **qweb 改名 qweb**（品牌统一：qkeeper 动物园 / qweb 宿主 / qtom 第一只猫）：crate 名、二进制名、env 前缀 QWEB_*→QWEB_*（留兼容读旧名）、README、deploy 路径 /usr/local/qweb。qtom 落地后单独立项做。

## 关键风险与处理

- **流式与定稿一致性**：定稿 content 从 delta 累积的同一缓冲出，live 替换不跳变
- **daemon id 重复**：一律重写 toolu_ 单调 id（resume 续号）
- **审批等待与 interrupt 竞态**：qtom select! 处理；迟到 control_response 按 rid 失配忽略；qweb pending_perms 泄漏由 perm_respond 现有 remove 防住
- **轮中并发用户消息**：qtom 排队，result 后开新轮（对齐 CLI stdin 语义）
- **qtom 崩溃/被杀**：qweb exit watcher/SIGTERM 语义原样（mark_exit 广播 exit 帧）
- **usage_exceeds_window 修复**：assistant 行与 result 行同值 → no-op
- **进程组**：qtom 跑 bash 时自建 process_group（kill_on_drop），被 qweb SIGTERM 时整组清理（qweb 已 process_group(0)+kill_on_drop）
