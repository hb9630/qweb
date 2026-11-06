# ccweb

Claude Code 的流式 Web 工作台：对话（stream-json 双向管道）+ 文件树（右键全功能文件管理）+ 编辑器 + 终端。单进程 Node 后端 + React 前端，可反代、可单文件分发。

> 2026-11-06 从 `keeper/deploy/ccweb` 拆出独立仓库（keeper 侧只留镜像构建时的产物引用）。容器管理入口（经 keeperd 编排）已移除，将来以 SSH 直连方案回归。

## 目录结构

```
server.mjs        后端：会话管理/静态资源/文件 API/WS 管道（唯一服务文件）
web/              前端源码（React + TypeScript + Vite）
  src/Explorer    左栏文件树（右键菜单、多选、拖放、上传/下载）
  src/ChatPanel   对话区（流式渲染、ctx 窗口、会话切换）
  src/Editor      代码/文本编辑器
  *-test.mjs      playwright UI 冒烟（在 web/ 下跑：node xxx-test.mjs）
build.sh          一键构建：前端 → 根 dist 链接 → SEA 单文件（--no-sea 可跳过）
deploy.sh         本地部署：生成 systemd 单元（自适应 user/dir/port）→ 安装重启
build-sea.mjs     SEA 单文件打包（bundle + dist 嵌入 node 副本；被 build.sh 调用）
ccweb.service     systemd 单元模板（deploy.sh 的输入）
test/             服务端测试：e2e-test.mjs（端到端）/ resume-test.mjs（resume 幂等）
```

## 两种发布形态（同一份代码）

| 形态 | 用法 | 说明 |
|---|---|---|
| 裸跑 | `node server.mjs`（同目录 `dist/` 从文件系统读） | 开发/宿主部署 |
| SEA 单文件 | `node build-sea.mjs` → `build/ccweb` | 一个自包含可执行文件，拷到任何装了 claude 的机器直接跑 |

## 快速开始

```bash
./build.sh                       # 一键构建：web/dist + build/ccweb（SEA 单文件）
./build.sh --no-sea              # 只出前端（裸跑形态够用时）

node server.mjs                  # 裸跑：http://0.0.0.0:8090（读同目录 dist/）
./deploy.sh                      # systemd 部署：默认 18090，CCWEB_PORT=xxx ./deploy.sh 改端口
CCWEB_PORT=18098 ./build/ccweb   # SEA 单文件直跑（分发即拷这一个文件）

# 前端开发（vite HMR）
cd web && npm install && npm run dev
```

## 环境变量

| 变量 | 默认 | 说明 |
|---|---|---|
| `CCWEB_PORT` | 8090 | 监听端口 |
| `CCWEB_HOME` | `$HOME` | 工作区根（树根/会话 cwd 钳制边界） |
| `CCWEB_SINGLE` | – | `=1` 发布单会话形态：至多一个活会话，前端隐藏会话切换 |
| `CCWEB_CLAUDE` | PATH 探测 | claude 可执行文件路径覆盖 |
| `KEEPERD_URL` | `127.0.0.1:7998` | 宿主形态探测 keeperd 可达性（容器管理已下线，仅能力分级用） |

## 路由：零配置 base_path

前端资源全相对引用（vite `base:'./'`），服务端把路径中最早出现的路由锚点（`/api/` `/ws/` `/assets/` …）之前的内容一律当 base 剥掉——nginx 剥前缀、透传带前缀、本地根形态，三种姿势同一套逻辑，反代无需任何配置。

## 会话模型

- 每个 tab = 一个长驻 claude 进程（`--output-format stream-json` 双向管道），关 tab 才 kill
- 刷新页面经 ring buffer 回放恢复完整对话；进程空闲 20min 自动回收
- resume 幂等：同一官方会话已有活进程时重复 POST 返回既有会话，不重复 spawn
- 工作目录 = 左栏目录树右键"设为工作目录"（唯一入口）；换目录 = 新会话（cwd 在 spawn 时固化）

## 测试

```bash
node test/e2e-test.mjs http://127.0.0.1:18090/  # 端到端冒烟：入口→会话→WS→claude 回复
node test/resume-test.mjs <base> <sid> <cwd>    # resume 幂等/续聊验证
cd web && node multi-select-test.mjs            # playwright UI 冒烟（多选/拖放/跟随等）
```

## systemd（宿主形态）

`./deploy.sh` 一条命令（生成自适应单元 → daemon-reload → restart → 健康检查）；`ccweb.service` 是模板。
