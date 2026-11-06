# ccweb

Claude Code 的流式 Web 工作台：对话（stream-json 双向管道）+ 文件树（右键全功能文件管理）+ 编辑器 + 终端。前后端分离的单仓库（npm workspaces，一份 node_modules），`npm install` 一次装完。

> 2026-11-06 从 `keeper/deploy/ccweb` 拆出独立仓库。容器管理入口（经 keeperd 编排）已移除，将来以 SSH 直连方案回归。

## 目录结构

```
backend/            后端（依赖仅 ws）
  server.mjs        单文件服务：会话管理/静态资源/文件 API/WS 管道
frontend/           前端（React + TypeScript + Vite）
  src/Explorer      左栏文件树（右键菜单、多选、拖放、上传/下载）
  src/ChatPanel     对话区（流式渲染、ctx 窗口、会话切换）
  src/Editor        代码/文本编辑器
  *-test.mjs        playwright UI 冒烟（node xxx-test.mjs，默认连 18090）
scripts/            构建与部署
  build.mjs         npm run build：前端 → backend/dist 链接 → SEA 单文件
  build-sea.mjs     SEA 打包（bundle + dist 嵌入 node 副本）
  deploy.mjs        npm run deploy：组装 /usr/local/ccweb 安装树 + systemd
  ccweb.service     systemd 单元模板（deploy.mjs 的输入）
test/               服务端测试：e2e-test.mjs / resume-test.mjs
build/              构建产物（git 忽略）：sea/ 中间件 + ccweb 单文件
```

## 快速开始

```bash
npm install            # workspaces 一次装完前后端依赖
npm run build          # 全量构建：frontend/dist + build/ccweb（SEA 单文件）
CCWEB_NO_SEA=1 npm run build   # 只出前端（裸跑够用）

node backend/server.mjs        # 裸跑开发：http://0.0.0.0:8090
npm run dev                    # 前端开发（vite HMR）

npm run deploy         # 正式部署（见下）
```

## 部署

按目标环境取用，三种形态同一份代码：

- **裸跑**：`node backend/server.mjs`——任何有 node 的机器（同目录 dist 由 `npm run build` 建好链接）
- **SEA 单文件**：`build/ccweb`（server + 前端全量嵌入 node 副本，137MB）——拷到任何装了 claude 的机器，任意目录 `./ccweb` 即跑，无需 node、无需安装
- **npm run deploy**：假如使用 systemd 的话（Linux 服务器常态），一条命令完成正式安装——开发目录只是源码，服务装在系统位置、与源码解耦，升级 = `npm run build && npm run deploy`：
  1. 组装自包含安装树 **`/usr/local/ccweb`**（server.mjs + dist 实体 + ws 依赖）
  2. 生成 systemd 单元（自适应 User/HOME/端口，默认 **18090**；`CCWEB_PORT=xxx npm run deploy` 改端口）→ 安装重启
  3. 健康检查通过后输出上线确认

## 环境变量

| 变量 | 默认 | 说明 |
|---|---|---|
| `CCWEB_PORT` | 8090 | 监听端口 |
| `CCWEB_HOME` | `$HOME` | 工作区根（树根/会话 cwd 钳制边界） |
| `CCWEB_SINGLE` | – | `=1` 发布单会话形态：至多一个活会话，前端隐藏会话切换 |
| `CCWEB_CLAUDE` | PATH 探测 | claude 可执行文件路径覆盖 |
| `CCWEB_NO_SEA` | – | `=1` 时 npm run build 跳过 SEA 打包 |

## 路由：零配置 base_path

前端资源全相对引用（vite `base:'./'`），服务端把路径中最早出现的路由锚点（`/api/` `/ws/` `/assets/` …）之前的内容一律当 base 剥掉——nginx 剥前缀、透传带前缀、本地根形态，三种姿势同一套逻辑，反代无需任何配置。

## 会话模型

- 每个 tab = 一个长驻 claude 进程（`--output-format stream-json` 双向管道），关 tab 才 kill
- 刷新页面经 ring buffer 回放恢复完整对话；进程空闲 20min 自动回收
- resume 幂等：同一官方会话已有活进程时重复 POST 返回既有会话，不重复 spawn
- 工作目录 = 左栏目录树右键"设为工作目录"（唯一入口）；换目录 = 新会话（cwd 在 spawn 时固化）

## 测试

```bash
npm test                                   # 端到端冒烟：入口→会话→WS→claude 回复（需 claude 可用）
node test/resume-test.mjs <base> <sid> <cwd>   # resume 幂等/续聊验证
cd frontend && node multi-select-test.mjs  # playwright UI 冒烟（多选/拖放/跟随等）
```
