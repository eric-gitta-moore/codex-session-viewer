# Codex Session Viewer

[English README](./README.md)

Codex Session Viewer 是一个本地网页工具，用来把 Codex 的 session 日志按聊天流的方式回放出来。
相比直接读原始 `jsonl` 文件，它更适合用来复盘一次 agent 执行过程，查看用户消息、助手回复、工具调用和调试事件。

<table>
  <thead>
    <tr>
      <th>首页</th>
      <th>回放对话</th>
    </tr>
  </thead>
  <tbody>
    <tr>
      <td><img alt="image" src="https://github.com/user-attachments/assets/1c9d27bd-1df3-4d04-ae1f-bc058901f744" /></td>
      <td><img alt="image" src="https://github.com/user-attachments/assets/d136c75f-97a2-4182-bea0-b29dd8827c6c" /></td>
    </tr>
  </tbody>
</table>


## 项目定位

这个项目目前是一个“单文件、本地优先”的查看器：

- 只处理你主动上传的单个 `jsonl` 文件
- 不扫描 `~/.codex/sessions` 目录
- 运行在浏览器中，前端技术栈为 Vue + Vite
- 重点是把原始事件流转换成更容易阅读的聊天界面

## 主要功能

- 上传单个 Codex session `.jsonl` 文件
- 按聊天流回放 session，而不是直接展示原始事件表
- 按时间顺序展示用户消息、助手回复和工具调用
- 默认隐藏系统、上下文、token 等调试噪音
- 需要时可以展开单条事件查看完整内容和原始 JSON
- 面向大文件场景做了性能优化

## 为什么能处理大文件

这个项目已经针对大体积 session 文件做了专门处理，比如 `25MB` 级别的 JSONL。

当前采用的技术方案包括：

- **Web Worker 流式解析**
  使用 `File.stream()` 在 worker 中增量读取文件，并逐行解析 JSONL。

- **主线程只保留轻量索引**
  UI 侧只拿到简化后的事件对象，不直接持有完整原始记录。

- **虚拟列表渲染**
  聊天流使用 `@tanstack/vue-virtual`，只渲染当前可视区域附近的消息。

- **详情懒加载**
  单条事件的完整正文和原始 JSON 只会在用户展开时再加载。

这样做的目标是：

- 避免主线程长时间卡死
- 避免大文件导致内存重复膨胀
- 避免一次性渲染几千上万条 DOM

## 界面说明

### 1. 文件选择

首页支持：

- 点击选择单个 `.jsonl` 文件
- 拖拽文件到上传区域

### 2. 聊天流回放

上传后，页面会把 session 渲染成聊天流：

- 用户消息：聊天气泡，默认直接展示完整正文
- 助手回复：聊天气泡，默认直接展示完整正文
- Tool / Metrics / Lifecycle 等节点：紧凑的一行卡片

### 3. Tool 卡片

为了避免工具调用过于啰嗦：

- 默认只显示一行摘要
- 展开后才显示完整内容和原始事件

### 4. 调试节点开关

页面支持切换是否显示：

- system
- context
- reasoning
- metrics
- lifecycle

## 技术栈

- Vue 3
- TypeScript
- Vite
- Web Workers
- `@tanstack/vue-virtual`

## 目录结构

```text
src/
  App.vue                          主页面与上传流程
  components/
    ChatMessageRow.vue             单条消息 / 工具卡片
    ChatStream.vue                 虚拟列表消息流
    FileDropzone.vue               文件选择区域
  types/
    session.ts                     共享类型定义
  utils/
    sessionParser.ts               主线程与 worker 的桥接层
  workers/
    sessionParser.worker.ts        流式 JSONL 解析 worker
```

## 本地开发

### 安装依赖

```bash
npm install
```

### 启动开发环境

```bash
npm run dev
```

### 生产构建

```bash
npm run build
```

### 预览构建结果

```bash
npm run preview
```

## 输入文件格式

输入应为 Codex session 的 JSONL 文件，例如：

```text
~/.codex/sessions/2026/03/30/rollout-2026-03-30T15-20-01-....jsonl
```

要求：

- 每一行都是合法 JSON
- 文件内容是 Codex session 事件流

## 当前限制

- 当前只支持单文件查看
- 搜索主要基于轻量索引，不是完整原文全文检索
- 原始详情由 worker 按需提供，不会默认全部加载进 UI

## 后续可以继续扩展的方向

- 把搜索完全迁移到 worker
- 增加“取消解析”能力
- 使用 IndexedDB 缓存解析结果
- 支持多个上传文件之间的对比分析
