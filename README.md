# dsh-conversation-find

在当前 DSH 会话里按关键词搜索消息，并把命中项**滚动定位**到对话视图中的对应位置。

> 补的是官方 Trajectory 视图缺的那一段：轨迹能搜到内容，但它自己的 README 写明
> record/timeline selection 是 local 的、**没有 anchor deep links**，所以从轨迹无法跳到
> Chat 里的那条消息。社区现成的 `dsh-session-search-toggle` / `dsh-history` 又硬依赖
> 已在 0.2.x 被移除的 `@deepseek-ai/dsh-client-runtime`，装不上。这个插件就是填这个空。

## 功能

- **搜索覆盖整段会话历史**：打开面板后先把会话历史翻到最早一页（面板显示「加载历史 N」进度），再在全文范围内搜索
- 会话头部（header utilities 座位）新增一个放大镜按钮，`⌘/Ctrl + Shift + F` 也能唤起
- 输入即搜（160ms 防抖），命中数显示为 `当前/总数`，`Enter` 下一个、`Shift+Enter` 上一个、`Esc` 关闭
- 命中项用**叠加层**高亮（当前项为橙色），不修改 React 拥有的 DOM，因此流式输出和重渲染都不会留下脏标记
- 跳转按 Range 的真实 client rect 把命中项滚到视口中间
- 流式输出时自动重算（400ms 防抖）；切换会话自动关闭面板

## 为什么要先「加载历史」

会话视图不是把整段对话一次性放进 DOM 的：它维护一个窗口，`hasMore` 为真时列表顶部有「加载更早」。
所以只搜 DOM 的话，结论会是「没找到」，而那句话其实只是还没加载。本插件因此先调用会话 store 的
`loadOlder()` 把窗口翻到起点（`hasMore === false`）再搜索；视图自己会监听 `loadingOlder` 并保持
阅读位置，所以翻页不会把视口拽走。

翻页上限 400 页：真的撞到上限时，命中计数会带「历史未加载完」提示，明确告诉你结果只覆盖已加载部分，
不会假装搜全了。关闭面板会立即中止正在进行的翻页。

## 安装

从 GitHub 安装（本仓库根目录即插件包，`link:` 指向克隆下来的目录）：

```bash
git clone https://github.com/vagur1689/dsh-conversation-find.git ~/dsh-conversation-find
dsh plugin --profile web add link:~/dsh-conversation-find
```

也可以直接 `link:` 到你自己的任意克隆位置（路径用绝对路径或 `~` 展开后的路径）：

```bash
dsh plugin --profile web add link:/path/to/dsh-conversation-find
```

然后重启 `dsh web`，再强刷页面（`Cmd + Shift + R`）。

> 用 `link:` 而不是 npm 安装，是因为本插件尚未发布到 npm；`link:` 的另一个好处是改源码后只需强刷页面即可生效（bundle 由宿主按请求读取）。

## 使用

1. 打开任意会话，点右上角的放大镜（或按 `⌘/Ctrl + Shift + F`）
2. 输入关键词，回车在命中项之间循环

## 边界（重要，避免误解）

- **只在当前会话内搜索**，不跨会话；跨会话需要另做检索层（读 `$DSH_HOME/sessions` 或用 `session-query-sqlite`）
- **搜索前会翻页到会话起点**，因此第一次搜索需要等历史加载（面板有进度），超长会话耗时更明显；上限 400 页，撞到上限会提示「历史未加载完」
- 不搜输入框草稿（`data-composer-seat`），也不搜 `<script>` / `<style>` 和插件自己的面板
- 单次结果上限 2000 条命中、单帧最多绘制 400 个高亮框，避免一次按键把长会话卡住

## 实现要点

- 纯客户端插件：`index.js` 是空宿主半部，只用于让 Loader 挂载一个声明了 `dsh.client` 的包
- 运行时只 `require("react")`，不引入任何 `@deepseek-ai/*` 运行时模块（这正是它能在 0.2.0-rc.2 上跑的原因）
- 历史翻页走会话 store 的公开面：`ctx.get('sessions').binding(id).session.getSnapshot().hasMore` + `loadOlder()`
- 通过 `ctx.slots.inject('conversation.session.header.utilities', …)` 注册入口；`ctx.effect` 负责卸载
- 重复挂载用引用计数 + `window.__dshConversationFind` 单例收敛，不会出现两个面板或两套监听
- DOM 锚点只用官方稳定的数据属性：`[data-conversation-scroll]`、`[data-conversation-session]`、`[data-composer-seat]`

## 测试

测试用 jsdom 跑在真实 DOM 之上，不需要 DSH 运行：

```bash
npm install
npm test
```

覆盖的行为：

- `collect()` 命中数、大小写不敏感、跳过 composer / `<script>` / 插件自有 UI
- 面板开合、计数器 `1/2 → 2/2 → 循环`、Esc 关闭、高亮层释放
- 叠加层：每个命中一个高亮框、恰好一个 `data-current="true"`、几何来自命中 rect
- 历史翻页：打开面板后「更早页」里的文本可被搜到；撞上限时计数带「历史未加载完」；关闭面板立即停止翻页
- 降级可见：拿不到 `sessions` 服务时计数必须出现 `⚠` 与解释，不允许静默失败

## 许可

MIT
