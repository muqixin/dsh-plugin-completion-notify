# dsh-plugin-completion-notify

Turn-completion notifications for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness): when a session finishes a turn, a native system notification shows the session title and a summary of that turn, and clicking it brings the window forward and opens that session.

会话跑完一轮时弹一条**系统原生通知**：标题是会话标题，正文是这一轮的结果摘要，点通知会聚焦窗口并切回该会话。桌面版（DSH Tauri）走壳的原生通知桥，普通浏览器走标准 Notification API。

## 特性

- **原生横幅**：不依赖页面窗口可见，别的应用盖住 DSH 也没关系（点一下通知即回到对应会话）。
- **内容**：标题 = 会话标题（`title` 投影，缺省 `displayTitle`）；正文 = 这一轮 `turnOutline` 投影里最后的助手回复预览（最多三行）。
- **点击**：聚焦窗口 + `uiWorkspace.openSession(sessionId)`；桌面壳里同时带 `sessionId` 和 `dsh-notification-<sessionId>-<ts>` 标签，壳的点击逻辑也能识别。
- **提示音**：Web Audio 现场合成两音（880Hz → 1318.5Hz，约 0.45 秒），无需音频文件；首次点击/按键解锁音频上下文，被静音策略挡住时静默降级。
- **不打扰**：用户主动中断（`aborted` / `interrupted`）和已归档（`archived`）的回合不发；subagent 子会话不单独发。
- **兜底**：拿不到 Notification API 或权限被拒时，改用页面右上角卡片（shadow root、最多 3 张、20 秒淡出）。

## 安装

要求 DSH `0.2.x`（`dsh.client` 双面插件 + bundle 补丁层）。

```bash
# 1) 把插件装进目标 profile（桌面版是 tauri，命令行版通常是 web）
dsh plugin --profile tauri add https://github.com/muqixin/dsh-plugin-completion-notify

# 2) 让它成为 profile 的一个 bundle 层
#    编辑 ~/.dsh/profiles/tauri/package.json，在 dsh.profile.bundles 里追加：
#    "dsh-plugin-completion-notify"

# 3) 重载
#    带 HMR 的 profile 会就地重组；否则重开 DSH Tauri（或重新 `dsh web`）后刷新页面
```

也可以直接用本地目录：`dsh plugin --profile tauri add /path/to/dsh-plugin-completion-notify`。

插件没有构建步骤：`lib/client.js` 就是按 `window.__ModuleLoader__.load({ id, factory })` 约定手写的浏览器端 bundle，`lib/index.js` 是空实现的宿主半边。

## 实现要点

- 触发：`remote.$on('api-session/status')` 观察到某会话从「运行中」变成「已停止」。插件挂载时已在跑的会话会被当作「见过开始」，所以挂载当轮结束也会提醒。
- 数据：`remote.session.projections` 现读 `title` 与 `turnOutline`（不依赖列表里的缓存块），所以正文总是描述刚结束的那一轮。
- 投递：桌面壳把 `window.Notification` 换成 `DshNativeNotification`，`new Notification(title, { body, tag, sessionId })` 经 `postMessage` 交给 Rust 侧的原生通知；普通浏览器走标准 Notification API。
- 迁移/跳过：`/api/tauri/notification/turn-end` 存在时用它判断 `aborted` / `interrupted` / `archived`，不存在就按"照常通知"处理。

## 与桌面版内置通知插件的关系

DSH Tauri 自带 `dsh-tauri-notification`（轮次完成 / 授权 / 提问提醒，默认「仅未聚焦时」）。两个插件同时开会各弹一条完成通知。二选一：

- 用本插件：把内置插件的整行关掉，或在 `cordis.patch.yml` 里写 `- id: dsh-tauri-notification` + `disabled: true`。注意关掉整行会一并失去它的「授权 / 提问」原生提醒（应用内授权卡片不受影响）。
- 想保留内置的授权提醒：保留该行，只把它的 **轮次完成通知** 设为「从不」（设置 → 通用），完成提醒交给本插件。

## 已知限制

- 通知的样式（横幅 / 持续 / 无）和是否响铃由 macOS 系统设置里该 app 的条目决定；插件只负责投递内容。
- 桌面壳的原生横幅实测不发声，所以提示音由页面用 Web Audio 补一声；进程退出后不会有任何提醒。

## 结构

```
package.json      # dsh.bundle（自身补丁层）+ dsh.client（浏览器半边）
cordis.patch.yml  # 插入 completion-notify 这一行
lib/index.js      # 宿主半边：空实现
lib/client.js     # 浏览器半边：回合结束 → 读投影 → 原生通知 / 卡片
```

## License

MIT
