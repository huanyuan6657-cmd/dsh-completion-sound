# 更新日志

## 1.2.0 — 2026-11-08

- 「屏蔽其他提示音」从只盯鲸鱼的音频接口，升级为**覆盖页面上全部三条发声路径**：`window.fetch`（远端音频资源）、`AudioBufferSourceNode.prototype.start`（已预解码的缓存音，鲸鱼就走这条）、`HTMLMediaElement.prototype.play` + 捕获阶段 `play` 事件（`<audio>` / `<video>` / `new Audio()`，含自动播放）。任何插件想在这一刻出声都会被拦下。
- 新增**发声诊断**：每次拦截/放行都会记录调用栈并批量上报宿主 `GET /diag`，用来分辨「第二声来自页面里的哪个插件」还是「页面之外（系统通知音）」。
- 修掉一个会让屏蔽**静默失效**的 bug：守卫状态原先放在模块闭包里，客户端热加载会 dispose 旧实例并把开关置回 false，而补丁已经打在 `window.fetch` 和原型上、新实例看到「已打包」就跳过 —— 真正生效的那套函数读的永远是旧值。现在状态挂在 `window.__dcsSoundGuard` 单例上，并按补丁版本号（`__dcsGuardVersion`）重新包装，热加载不再解除武装。

## 1.1.0 — 2026-11-07

- 新增**屏蔽其他完成提示音**（默认开）：拦截同一页面里其他插件（鲸鱼小组件等）的完成音，只留本插件这一声。
  - 同时包 `window.fetch`（对 `/dsh-whale/audio*` 回 `404`，保证解除静音后能立刻取回真声）和 `AudioBufferSourceNode.prototype.start`（拦住已预解码、不再走网络的缓存音）。
  - 插件总开关关闭时自动解除屏蔽，原生提示音照旧。
- 新增**前台也播放提示音**开关（默认开），替换原来的「仅窗口在后台时播放」；判定改用 `document.hidden` + `document.hasFocus()`，老配置里的 `onlyWhenUnfocused` 会自动换算。
- 配置新增 `muteBuiltin`、`playInForeground` 两个字段。

## 1.0.0 — 2026-11-07

首个版本。

- Host 半侧监听 `session/event`，只在 `turn/end` 且 `reason.kind === 'completed'` 时计数；过滤 subagent / delegation 会话，抑制 goal 自动续跑的中间轮。
- Client 半侧轮询 `/state`，`seq` 前进即播放；用每进程 `boot` 标识区分「宿主重启」与「真的完成」，重启后只对齐不补播。
- 路由不可达时退化为 `conversation.chat.turnTail` 挂载启发式，带 450 ms 突发抑制。
- 7 种内置音效，全部由 WebAudio 现场合成，不携带音频素材。
- 支持音量、仅窗口在后台时播放、自定义音频（上传本地文件 ≤ 8 MB，或 http(s) 直链）。
- 设置页入口：设置 → 完成任务音效。
- 配置落在 `$DSH_HOME/dsh-completion-sound/config.json`，自定义音频存同目录。
- HTTP 路由带栅栏：先交宿主 `connection` 服务裁决，再回落到「回环地址 + 同源」校验。