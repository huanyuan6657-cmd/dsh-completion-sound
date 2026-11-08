# 完成任务音效 · dsh-completion-sound

> DSH 每跑完一轮对话就播一段提示音；音效可换、音量可调，也能换成自己的音频。

一个 [DeepSeek Harness](https://github.com/deepseek-ai) 插件（bundle），同时包含宿主与浏览器两半：宿主监听会话事件，浏览器负责发声与设置界面。插件**不带任何音频素材**，7 种音效都是 WebAudio 现场合成的。

- **7 种内置音效**：清脆铃 / 上扬 / 柔和钟 / 木质敲击 / 水滴 / 电子哔 / 小号角
- **音量 0–100%**，拖动松手即试听
- **前台也播放 / 只在后台播放**：可切换"盯着窗口时打扰"还是"离开才提醒"
- **屏蔽其他提示音**：鲸鱼小组件等插件在同一页面播的那一声也能一起静音，关掉即恢复
- **自定义音频**：上传本地文件（mp3 / wav / ogg / m4a / aac / flac / webm，≤ 8 MB），或填入 http(s) 直链
- **不误报**：子代理跑完不响，goal 自动续跑的中间轮不响，刷新页面不重播历史轮次

## 安装

需要已装好 DSH，并且能调用 `plugin_manager`（Host 侧工具）。

**方式一：下载仓库后用本地目录安装**（推荐，最稳）

在 <https://github.com/huanyuan6657-cmd/dsh-completion-sound> 点 **Code → Download ZIP** 解压，或用 Git：

```powershell
git clone https://github.com/huanyuan6657-cmd/dsh-completion-sound.git
```

然后在 DSH 里：

```text
plugin_manager install_bundle target="<解压/克隆出来的绝对路径>"
```

**方式二：直接给仓库 spec**

bundle 安装走的是包管理器语义，所以 `github:<账号>/<仓库>` 这类 spec 通常也能直接用：

```text
plugin_manager install_bundle target="github:huanyuan6657-cmd/dsh-completion-sound"
```

装完不需要重启 DSH：宿主半侧会随 bundle 装配生效，浏览器半侧会热加载；如果界面没变化，刷新一次页面即可。

**卸载**

```text
plugin_manager remove_bundle target="dsh-completion-sound"
```

## 使用

打开 **设置 → 完成任务音效**（排在「宠物设置」和「插件市场」之间）。

| 控件 | 说明 |
| --- | --- |
| 开启提示音 | 总开关。关掉后不播放，也不占音频设备；同时自动解除下面的「屏蔽」，原生提示音恢复 |
| 前台也播放提示音 | 关掉后只有窗口不在前台时才响（盯着窗口时不打扰） |
| 屏蔽其他提示音 | 开着时静音鲸鱼小组件等其他插件在同一页面播的完成音，只留本插件这一声；关掉即恢复原声 |
| 音效九宫格 | 点一下即试听并保存；当前生效的高亮 |
| 音量 | 拖动时实时改，松手试听一次 |
| 自定义音频 | 选文件上传，或填直链；「清除」回到内置音效 |

自定义音频存在时，内置音效暂时让位（配置里 `custom` 优先）；点任意内置音效会把 `custom` 清空。

配置落在 `$DSH_HOME/dsh-completion-sound/config.json`（Windows 默认 `C:\Users\<你>\.dsh\dsh-completion-sound\`），自定义音频存同目录 `custom.<ext>`。**放在主机侧而不是 `localStorage`**：换端口、清浏览器缓存、换浏览器都不会丢。

## 它是怎么知道「任务完成」的

浏览器侧拿不到 `turn/end` 事件，所以分两半：

1. **Host 半侧**（`index.js`）监听 `session/event`，只认 `type === 'turn/end'` 且 `data.reason.kind === 'completed'`；用 `header.origin === 'subagent'` 或 `delegationDepth > 0` 过滤子代理会话（否则每路子任务跑完都响），并抑制 goal 自动续跑的中间轮（`user/message` 的 `source.kind === 'goal'`）。通过后自增一个内存计数器。
2. **Client 半侧**（`client.js`）每秒 `GET /dsh-completion-sound/state`。`seq` 恰好 +1、且宿主进程 `boot` 标识没变 → 播放。首次观测（刷新页面、宿主重启）**只对齐不播放**，避免一打开页面就把历史轮次重播一遍。
3. 路由不可达时（宿主正在重启），退化为观察 `conversation.chat.turnTail` 的孤立挂载，用 450 ms 突发判定排除历史消息回填，两条路不会同时响。

WebAudio 上有几个坑，处理方式如下：`AudioContext` 用 `latencyHint: 'interactive'`；静默 60 秒或页面隐藏立刻 `suspend()`（运行中的 context 会阻止系统休眠），但**永不 `close()`** —— 完成音不是手势触发的，销毁后之后就再也响不了；首次 `pointerdown` / `keydown` 解锁，输入法组字期间（`isComposing` / `keyCode === 229`）跳过。自定义音频走 `fetch` + `decodeAudioData`，按 URL 缓存，显式拦截 `204` 和过小的响应体。

## 怎么把别人那一声也管住

DSH 本体（Electron 主进程 + 打包的 dsh 运行时 + 全部内置插件）里**没有任何发声代码**：没有音频素材，也没有 `new Audio` / `playSound` / `SystemSounds` / `MessageBeep` 这类调用。所以页面每轮结束的第二声，一定来自某个第三方插件在页面里播的音 —— 最常见的是**鲸鱼小组件**，它把音效预解码进 `AudioBuffer` 缓存，出声发生在 `AudioBufferSourceNode.start()`。

「屏蔽其他提示音」把三条路一起堵住：

1. `window.fetch`：对 `/dsh-whale/audio*` 这类远端音频请求直接回 `404`。不能用 `204` —— 对方的解码缓存只在成功时写入、失败会自己清掉，`404` 才能保证你关掉屏蔽后立刻取回真声。
2. `AudioBufferSourceNode.prototype.start`：静音期间只放行本插件自己的节点（`WeakSet` 记账），其余一律不启动 —— 这是拦住"已经预解码好、根本不再走网络"那份的唯一办法。
3. `HTMLMediaElement.prototype.play` + 捕获阶段的 `play` 事件：兜住 `<audio>` / `<video>` / `new Audio()`，包括自动播放。

三条都只在开关打开**且**本插件总开关打开时生效；关掉任一个（或卸载插件），下一秒播放就恢复原样。

想弄清第二声到底是谁发的，可以看诊断接口：每次拦截都会带上调用栈批量上报，`GET /dsh-completion-sound/diag` 能看到 `buffer-blocked` / `fetch-blocked` 记录里指向哪个脚本。**如果一轮结束、屏蔽开着，`/diag` 里却一条拦截记录都没有，说明那声音不来自页面**（多半是 Windows 的通知音或别处），本插件帮不上忙。

## 接口

| 方法 | 路径 | 作用 |
| --- | --- | --- |
| GET | `/dsh-completion-sound/state` | `{ ok, boot, seq, at, sessionId, now }` |
| GET / PUT | `/dsh-completion-sound/config` | 读取 / 合并配置 |
| GET / POST / DELETE | `/dsh-completion-sound/custom` | 读取 / 替换 / 删除自定义音频（POST 走原始 body，`?name=` 或 `x-file-name` 给扩展名） |
| GET | `/dsh-completion-sound` | 健康检查，返回一行文本 |

栅栏：先交宿主 `connection.requestRejection()` 裁决（浏览器凭据），不通过时回落到「回环地址 + `Host` 为回环 + `Origin` 与 `Host` 同源」。这样既能挡住同浏览器的第三方网页（`Origin` 不符）与 DNS rebinding（`Host` 不再回环），又允许桌面壳、健康探测等无 cookie 的回环调用。

## 开发

没有构建步骤，两个文件就是全部产物：

```powershell
npm run check     # node --check index.js && node --check client.js
npm run dry-run   # npm pack --dry-run，看会进包的文件
```

- `index.js` — 宿主半侧，ESM，导出 `name` / `inject` / `apply`。
- `client.js` — 浏览器半侧，**纯副作用脚本**（`window.__ModuleLoader__.load({ id, factory })`），不能有顶层 `import` / `export`。
- `cordis.patch.yml` — 装配补丁；`id` 必须与包名一致，且那行不能写行尾注释。

## 已知限制

- 浏览器不给音频解锁：页面加载后没有任何点击/按键时，第一次完成音可能是静音的。点一下页面即可，之后一直有效。
- 只验证过桌面版 DSH 的 Web UI（Windows）。宿主半侧依赖 `webServer` 服务与 `session/event` 事件，这两样在现版本 DSH 里都有。

## 许可

[MIT](LICENSE)