/**
 * dsh-completion-sound —— Client half.
 *
 * - Settings page lives in the `settings.section` slot (order 35, right after 宠物设置).
 * - Completion is detected by polling the Host half (`/<route>/state`): the Host watches
 *   `session/event` → `turn/end` with `reason.kind === 'completed'` and bumps `seq`.
 *   A `seq` that grows by exactly one while the Host process id is unchanged means
 *   "a turn just finished" → play. The very first observation (page load, Host restart)
 *   only realigns, so a refresh never replays an old sound.
 * - When the Host route is unreachable (older host, restart in flight) playback falls back
 *   to an isolated `conversation.chat.turnTail` mount, which is where a finished Turn
 *   renders its action row.
 * - Presets are synthesised with WebAudio, so the bundle ships no audio files. Custom audio
 *   is an uploaded file or an http(s) URL, decoded once per URL and cached.
 */
window.__ModuleLoader__.load({
  id: 'dsh-completion-sound',
  factory: function (require) {
    'use strict'

    const React = require('react')
    const h = React.createElement

    const NS = 'completion-sound'
    const ROUTE = '/dsh-completion-sound'
    const STORAGE_KEY = 'dsh-completion-sound:last-seq'
    const POLL_IDLE_MS = 1000
    const POLL_OFFLINE_MS = 3000
    const AUDIO_IDLE_MS = 60000
    const HEURISTIC_DELAY_MS = 700
    const HEURISTIC_BURST_MS = 450
    const MAX_SEQ_AGE_MS = 24 * 60 * 60 * 1000
    const MAX_CUSTOM_BYTES = 8 * 1024 * 1024
    const ACCEPTED_FILE = /\.(mp3|wav|ogg|m4a|aac|flac|webm)$/i

    /* --------------------------------------------------------------- dictionaries */

    const zh = {
      nav: '完成任务音效',
      title: '完成任务音效',
      desc: '每轮对话跑完时播放一段提示音。可以在这里试听、换音效、调音量，或换成自己的音频。',
      enable: '开启提示音',
      enableHint: '关闭后不播放，也不占用音频设备。',
      foreground: '前台也播放提示音',
      foregroundHint: '关掉后只有窗口不在前台时才响：盯着窗口时不打扰，去做别的事才提醒。',
      muteBuiltin: '屏蔽其他提示音',
      muteBuiltinHint: '开着时静音同一页面里其他插件（鲸鱼小组件等）的提示音，只留本插件这一声；关掉即恢复。',
      sound: '音效',
      soundHint: '点一下即试听并保存。「自定义音频」生效时，这里的音效会暂时让位。',
      preview: '试听',
      volume: '音量',
      custom: '自定义音频',
      customHint: '支持 mp3 / wav / ogg / m4a / aac / flac / webm，单个不超过 8 MB。文件保存在本机 DSH 数据目录，不随浏览器缓存丢失。',
      chooseFile: '选择音频文件',
      uploading: '正在上传…',
      useUrl: '使用直链',
      urlPlaceholder: 'https://example.com/done.mp3',
      clear: '清除',
      noFile: '未选择（使用上方音效）',
      usingUrl: '正在使用音频直链',
      active: '生效中',
      saving: '正在保存…',
      loading: '正在读取设置…',
      offline: '连不上插件宿主，音效会在页面恢复连接后自动重试。',
      uploadFail: '上传失败，换一个文件再试。',
      badUrl: '请输入完整的 http(s) 音频地址。',
      badType: '不支持该文件类型。',
      tooBig: '文件超过 8 MB。',
      preset_chime: '清脆铃',
      preset_rise: '上扬',
      preset_soft: '柔和钟',
      preset_wood: '木质敲击',
      preset_drop: '水滴',
      preset_blip: '短提示',
      preset_fanfare: '小号角'
    }

    const en = {
      nav: 'Completion Sound',
      title: 'Completion Sound',
      desc: 'Plays a short cue whenever a turn finishes. Preview sounds, pick one, set the volume, or use your own audio.',
      enable: 'Play a sound',
      enableHint: 'Turning this off stops playback and frees the audio device.',
      foreground: 'Also chime while the window is in front',
      foregroundHint: 'Turn off to chime only when the window is not in front: quiet while you watch, audible when you look away.',
      muteBuiltin: 'Silence other chimes',
      muteBuiltinHint: 'While on, any chime another plugin plays on this page (the whale widget and friends) is muted, leaving only this one. Turn it off to get them back.',
      sound: 'Sound',
      soundHint: 'Click to preview and save. A custom sound below temporarily takes precedence.',
      preview: 'Preview',
      volume: 'Volume',
      custom: 'Custom audio',
      customHint: 'mp3 / wav / ogg / m4a / aac / flac / webm, up to 8 MB. Stored in the local DSH data directory, so it survives browser cache resets.',
      chooseFile: 'Choose audio file',
      uploading: 'Uploading…',
      useUrl: 'Use URL',
      urlPlaceholder: 'https://example.com/done.mp3',
      clear: 'Clear',
      noFile: 'None (using the sounds above)',
      usingUrl: 'Using a remote audio URL',
      active: 'Active',
      saving: 'Saving…',
      loading: 'Loading settings…',
      offline: 'Cannot reach the plugin host. Sound will resume automatically once the page reconnects.',
      uploadFail: 'Upload failed. Try another file.',
      badUrl: 'Enter a full http(s) audio URL.',
      badType: 'Unsupported file type.',
      tooBig: 'File exceeds 8 MB.',
      preset_chime: 'Chime',
      preset_rise: 'Rise',
      preset_soft: 'Soft bell',
      preset_wood: 'Woodblock',
      preset_drop: 'Drop',
      preset_blip: 'Blip',
      preset_fanfare: 'Fanfare'
    }

    /* ------------------------------------------------------------------ presets */

    function tone(ac, out, spec) {
      const at = spec.at
      const dur = Math.max(0.04, spec.dur || 0.2)
      const osc = ac.createOscillator()
      const gain = ac.createGain()
      osc.type = spec.type || 'sine'
      const from = Math.max(20, spec.from)
      const to = Math.max(20, spec.to || from)
      osc.frequency.setValueAtTime(from, at)
      if (to !== from) osc.frequency.exponentialRampToValueAtTime(to, at + dur)
      const peak = Math.max(0.0005, spec.gain === undefined ? 0.16 : spec.gain)
      const attack = Math.min(dur * 0.4, Math.max(0.003, spec.attack === undefined ? 0.01 : spec.attack))
      gain.gain.setValueAtTime(0.0005, at)
      gain.gain.exponentialRampToValueAtTime(peak, at + attack)
      gain.gain.exponentialRampToValueAtTime(0.0005, at + dur)
      osc.connect(gain)
      gain.connect(out)
      osc.start(at)
      osc.stop(at + dur + 0.05)
    }

    const PRESETS = [
      {
        id: 'chime',
        draw: (ac, out, t) => {
          tone(ac, out, { at: t, from: 1318.51, dur: 0.55, gain: 0.2 })
          tone(ac, out, { at: t + 0.1, from: 1975.53, dur: 0.42, gain: 0.09 })
          tone(ac, out, { at: t, from: 659.25, dur: 0.16, gain: 0.09, type: 'triangle' })
        }
      },
      {
        id: 'rise',
        draw: (ac, out, t) => {
          ;[523.25, 659.25, 783.99, 1046.5].forEach((frequency, index) => {
            tone(ac, out, { at: t + index * 0.075, from: frequency, dur: 0.3, gain: 0.13, type: 'triangle' })
          })
        }
      },
      {
        id: 'soft',
        draw: (ac, out, t) => {
          tone(ac, out, { at: t, from: 587.33, dur: 1, gain: 0.15, attack: 0.05 })
          tone(ac, out, { at: t + 0.05, from: 880, dur: 0.9, gain: 0.07, attack: 0.06 })
        }
      },
      {
        id: 'wood',
        draw: (ac, out, t) => {
          tone(ac, out, { at: t, from: 900, to: 480, dur: 0.09, gain: 0.2, type: 'square', attack: 0.002 })
          tone(ac, out, { at: t + 0.005, from: 1600, dur: 0.03, gain: 0.06, type: 'triangle', attack: 0.001 })
        }
      },
      {
        id: 'drop',
        draw: (ac, out, t) => {
          tone(ac, out, { at: t, from: 1500, to: 420, dur: 0.2, gain: 0.22, attack: 0.003 })
          tone(ac, out, { at: t + 0.04, from: 900, to: 300, dur: 0.16, gain: 0.08 })
        }
      },
      {
        id: 'blip',
        draw: (ac, out, t) => {
          tone(ac, out, { at: t, from: 1046.5, dur: 0.055, gain: 0.12, type: 'square' })
          tone(ac, out, { at: t + 0.075, from: 1568, dur: 0.06, gain: 0.1, type: 'square' })
        }
      },
      {
        id: 'fanfare',
        draw: (ac, out, t) => {
          ;[523.25, 659.25, 783.99].forEach((frequency) => {
            tone(ac, out, { at: t, from: frequency, dur: 0.45, gain: 0.09, type: 'triangle' })
          })
          tone(ac, out, { at: t + 0.18, from: 1046.5, dur: 0.5, gain: 0.14 })
          tone(ac, out, { at: t + 0.3, from: 1568, dur: 0.32, gain: 0.06 })
        }
      }
    ]

    const PRESET_IDS = PRESETS.map((preset) => preset.id)

    /* -------------------------------------------------------------------- styles */

    const CSS = [
      '.dcs{container-type:inline-size;display:flex;flex-direction:column;gap:14px;color:var(--dsw-alias-label-primary);font-size:13px;line-height:20px}',
      '.dcs__head{display:flex;flex-direction:column;gap:4px}',
      '.dcs__title{margin:0;font-size:15px;font-weight:600;line-height:22px;color:var(--dsw-alias-label-primary)}',
      '.dcs__desc{margin:0;color:var(--dsw-alias-label-secondary);font-size:12px;line-height:18px}',
      '.dcs__card{display:flex;flex-direction:column;gap:10px;padding:12px 14px;border:1px solid var(--dsw-alias-border-l2);border-radius:12px;background:var(--dsw-alias-bg-layer-1)}',
      '.dcs__row{display:flex;align-items:center;gap:10px;min-height:28px}',
      '.dcs__rowHead{display:flex;align-items:center;justify-content:space-between;gap:10px}',
      '.dcs__rowText{display:flex;flex:1 1 auto;flex-direction:column;gap:2px;min-width:0}',
      '.dcs__cardTitle{font-size:13px;font-weight:600;color:var(--dsw-alias-label-primary)}',
      '.dcs__label{font-size:13px;color:var(--dsw-alias-label-primary)}',
      '.dcs__hint{color:var(--dsw-alias-label-secondary);font-size:12px;line-height:17px}',
      '.dcs__hint--block{display:block;margin:0}',
      '.dcs__hint--error{color:var(--dsw-alias-state-error-primary)}',
      '.dcs__value{color:var(--dsw-alias-label-secondary);font-size:12px;font-variant-numeric:tabular-nums}',
      '.dcs__badge{padding:1px 8px;border-radius:999px;background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-secondary);font-size:11px;line-height:16px}',
      '.dcs__grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(104px,1fr));gap:8px}',
      '.dcs__chip{display:flex;align-items:center;justify-content:center;box-sizing:border-box;min-height:34px;padding:6px 10px;border:1px solid var(--dsw-alias-border-l2);border-radius:10px;background:transparent;color:var(--dsw-alias-label-primary);font:inherit;font-size:12px;cursor:pointer;transition:border-color .12s ease,background .12s ease}',
      '.dcs__chip:hover:not(:disabled){background:var(--dsw-alias-bg-layer-2)}',
      '.dcs__chip.is-active{border-color:var(--dsw-alias-brand-primary);background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-brand-primary)}',
      '.dcs__chip:disabled{opacity:.5;cursor:default}',
      '.dcs__btn{box-sizing:border-box;min-height:28px;padding:4px 12px;border:1px solid var(--dsw-alias-border-l2);border-radius:8px;background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary);font:inherit;font-size:12px;cursor:pointer;white-space:nowrap}',
      '.dcs__btn:hover:not(:disabled){border-color:var(--dsw-alias-brand-primary)}',
      '.dcs__btn:disabled{opacity:.55;cursor:default}',
      '.dcs__btn--ghost{background:transparent}',
      '.dcs__inp{box-sizing:border-box;flex:1 1 auto;min-width:0;min-height:28px;padding:4px 10px;border:1px solid var(--dsw-alias-border-l2);border-radius:8px;background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary);font:inherit;font-size:12px;outline:none}',
      '.dcs__inp:focus{border-color:var(--dsw-alias-brand-primary)}',
      '.dcs__inp.is-error{border-color:var(--dsw-alias-state-error-primary)}',
      '.dcs__file{flex:0 1 auto;min-width:0;overflow:hidden;color:var(--dsw-alias-label-secondary);font-size:12px;text-overflow:ellipsis;white-space:nowrap}',
      '.dcs__fileInput{display:none}',
      '.dcs__range{width:100%;accent-color:var(--dsw-alias-brand-primary)}',
      '.dcs__switch{position:relative;flex:0 0 auto;width:36px;height:20px;padding:0;border:1px solid var(--dsw-alias-border-l1);border-radius:999px;background:var(--dsw-alias-bg-layer-2);cursor:pointer;transition:background .15s ease,border-color .15s ease}',
      '.dcs__switch.is-on{border-color:var(--dsw-alias-brand-primary);background:var(--dsw-alias-brand-primary)}',
      '.dcs__switch:disabled{opacity:.5;cursor:default}',
      '.dcs__knob{position:absolute;top:2px;left:2px;width:14px;height:14px;border-radius:50%;background:var(--dsw-alias-bg-base);transition:transform .15s ease}',
      '.dcs__switch.is-on .dcs__knob{transform:translateX(16px)}',
      '.dcs__status{color:var(--dsw-alias-label-secondary);font-size:12px;line-height:17px}',
      '.dcs__status.is-error{color:var(--dsw-alias-state-error-primary)}'
    ].join('\n')

    function injectStyles() {
      if (typeof document === 'undefined' || !document.head) return
      if (document.querySelector('style[data-completion-sound-css]')) return
      const style = document.createElement('style')
      style.setAttribute('data-completion-sound-css', '')
      style.textContent = CSS
      document.head.appendChild(style)
    }

    /* --------------------------------- other-sound guard + "who rang that bell?" */

    // 目标：本插件接管「任务完成」这一刻之后，页面上不该再有第二声。
    // 三条发声路径都要堵：fetch 取音频（鲸鱼走这条）、AudioBufferSourceNode.start（已经预解码
    // 进缓存的那份走这条）、HTMLMediaElement.play（<audio>/<video>/new Audio() 走这条，含自动播放）。
    // 同时把「谁想发声、拦没拦住」记进环形缓冲、批量上报宿主 /diag —— 这样「还有一声」究竟来自
    // 页面里的某个插件，还是页面之外（Windows 通知音之类），能直接从日志上分辨。
    // 守卫状态必须挂在 window 上，不能放在模块闭包里：客户端热加载会 dispose 旧实例、跑一次
    // cleanup，而补丁已经打在 window.fetch / 原型上了，新实例看到"已打过补丁"就会跳过重新包装。
    // 结果就是真正生效的那套函数读的还是旧闭包里的 mute —— 永远是 false，静音静默失效。
    // 所以共享一个单例：谁打补丁都读它，谁改开关都改它。
    const GUARD_VERSION = 2
    const guardState =
      typeof window === 'undefined'
        ? { mute: false, installed: false, version: GUARD_VERSION, ownSources: new WeakSet(), ownMedia: new WeakSet() }
        : window.__dcsSoundGuard && window.__dcsSoundGuard.version === GUARD_VERSION
          ? window.__dcsSoundGuard
          : { mute: false, installed: false, version: GUARD_VERSION, ownSources: new WeakSet(), ownMedia: new WeakSet() }

    if (typeof window !== 'undefined') window.__dcsSoundGuard = guardState

    const ownSources = guardState.ownSources
    const ownMedia = guardState.ownMedia
    const FOREIGN_SOUND_URL = /\/dsh-whale\/(audio|.*sound)/i

    const soundLog = []
    const MAX_SOUND_LOG = 40
    let flushTimer = null

    function shortStack() {
      try {
        const raw = String(new Error().stack || '')
        return raw
          .split('\n')
          .slice(2, 7)
          .map((line) => line.trim().replace(/^at\s+/, ''))
          .join(' | ')
          .slice(0, 600)
      } catch (err) {
        return ''
      }
    }

    function recordSound(kind, detail) {
      try {
        soundLog.push(Object.assign({ t: Date.now(), kind, muteOthers: guardState.mute }, detail))
        while (soundLog.length > MAX_SOUND_LOG) soundLog.shift()
        if (flushTimer === null) flushTimer = setTimeout(flushSoundLog, 1000)
      } catch (err) {
        /* diagnostics must never break playback */
      }
    }

    function flushSoundLog() {
      flushTimer = null
      if (soundLog.length === 0) return
      const entries = soundLog.splice(0, soundLog.length)
      try {
        fetch(ROUTE + '/diag', {
          method: 'POST',
          credentials: 'same-origin',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ guard: { installed: guardState.installed, muteOthers: guardState.mute }, entries })
        }).catch(noop)
      } catch (err) {
        /* dropping a diagnostic batch is harmless */
      }
    }

    function looksLikeForeignSound(input) {
      const url = typeof input === 'string' ? input : input && typeof input.url === 'string' ? input.url : ''
      return url ? FOREIGN_SOUND_URL.test(url) : false
    }

    function installSoundGuard() {
      try {
        if (typeof window.fetch === 'function' && window.fetch.__dcsGuardVersion !== GUARD_VERSION) {
          const originalFetch = window.fetch
          const guardedFetch = function fetch(input, init) {
            if (looksLikeForeignSound(input)) {
              const url = typeof input === 'string' ? input : String((input && input.url) || '')
              if (guardState.mute) {
                recordSound('fetch-blocked', { url, stack: shortStack() })
                // 用 404 而不是 204：对方的解码缓存在成功时写入、失败时自行清掉，
                // 所以撤掉静音后能马上重新取到真声，不会永久卡在一段静音上。
                return Promise.resolve(new Response(null, { status: 404, statusText: 'muted by dsh-completion-sound' }))
              }
              recordSound('fetch', { url, stack: shortStack() })
            }
            return originalFetch.call(this, input, init)
          }
          guardedFetch.__dcsGuardVersion = GUARD_VERSION
          window.fetch = guardedFetch
        }

        const bufferProto = typeof AudioBufferSourceNode !== 'undefined' ? AudioBufferSourceNode.prototype : null
        if (bufferProto && typeof bufferProto.start === 'function' && bufferProto.start.__dcsGuardVersion !== GUARD_VERSION) {
          const originalStart = bufferProto.start
          const guardedStart = function start(when, offset, duration) {
            if (!ownSources.has(this)) {
              if (guardState.mute) {
                recordSound('buffer-blocked', { stack: shortStack() })
                return
              }
              recordSound('buffer', { stack: shortStack() })
            }
            return originalStart.call(this, when, offset, duration)
          }
          guardedStart.__dcsGuardVersion = GUARD_VERSION
          try {
            Object.defineProperty(bufferProto, 'start', { value: guardedStart, writable: true, configurable: true })
          } catch (err) {
            /* 老引擎不允许改原型：退化成只拦 fetch */
          }
        }

        // <audio> / <video> / new Audio()：静音元素照常播（不动人家的播放时序），但把声音掐掉。
        const mediaProto = typeof HTMLMediaElement !== 'undefined' ? HTMLMediaElement.prototype : null
        if (mediaProto && typeof mediaProto.play === 'function' && mediaProto.play.__dcsGuardVersion !== GUARD_VERSION) {
          const originalPlay = mediaProto.play
          const guardedPlay = function play() {
            try {
              // 本来就 muted 的元素不必记账 —— 宠物动画的 <video> 走这条，否则日志会被刷满。
              if (!ownMedia.has(this) && this.muted !== true) {
                const url = String(this.currentSrc || this.src || '')
                if (guardState.mute) {
                  this.muted = true
                  recordSound('media-blocked', { url, stack: shortStack() })
                } else {
                  recordSound('media', { url, stack: shortStack() })
                }
              }
            } catch (err) {}
            return originalPlay.apply(this, arguments)
          }
          guardedPlay.__dcsGuardVersion = GUARD_VERSION
          try {
            Object.defineProperty(mediaProto, 'play', { value: guardedPlay, writable: true, configurable: true })
          } catch (err) {}
        }

        // autoplay 的元素不经过 .play()，用捕获阶段的 play 事件兜住。
        if (window.__dcsMediaWatchVersion !== GUARD_VERSION) {
          window.__dcsMediaWatchVersion = GUARD_VERSION
          document.addEventListener(
            'play',
            (event) => {
              const el = event.target
              if (!el || typeof el !== 'object' || ownMedia.has(el) || !('muted' in el)) return
              if (el.muted === true) return
              try {
                if (guardState.mute) el.muted = true
              } catch (err) {}
              recordSound(guardState.mute ? 'media-blocked' : 'media', { url: String(el.currentSrc || el.src || ''), stack: shortStack() })
            },
            true
          )
        }

        guardState.installed = true
      } catch (err) {
        console.warn('[completion-sound] could not install the sound guard:', err)
      }
    }

    function syncSoundGuard(config) {
      const on = !!config && config.enabled !== false && config.muteBuiltin !== false
      if (on === guardState.mute) return
      guardState.mute = on
      recordSound('guard', { on })
    }

    /* -------------------------------------------------------------------- store */

    let store = { config: null, loading: true, saving: false, busy: false, error: '' }
    const listeners = new Set()

    function snapshot() {
      return store
    }

    function subscribe(listener) {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    }

    function patchStore(patch) {
      store = Object.assign({}, store, patch)
      if (patch && Object.prototype.hasOwnProperty.call(patch, 'config')) syncSoundGuard(store.config)
      for (const listener of Array.from(listeners)) {
        try {
          listener()
        } catch (err) {
          /* a broken subscriber must not break the others */
        }
      }
    }

    const useStore =
      typeof React.useSyncExternalStore === 'function'
        ? function useStoreSync() {
            return React.useSyncExternalStore(subscribe, snapshot, snapshot)
          }
        : function useStoreFallback() {
            const [value, setValue] = React.useState(snapshot)
            React.useEffect(() => {
              let live = true
              const off = subscribe(() => {
                if (live) setValue(snapshot())
              })
              return () => {
                live = false
                off()
              }
            }, [])
            return value
          }

    function clamp01(value) {
      if (!Number.isFinite(value)) return 0.8
      return Math.min(1, Math.max(0, value))
    }

    function normalizeConfig(raw) {
      const source = raw && typeof raw === 'object' ? raw : {}
      let custom = null
      const rawCustom = source.custom
      if (rawCustom && typeof rawCustom === 'object') {
        if (rawCustom.kind === 'file' && typeof rawCustom.ext === 'string') {
          custom = {
            kind: 'file',
            ext: rawCustom.ext,
            name: typeof rawCustom.name === 'string' ? rawCustom.name : 'custom' + rawCustom.ext,
            v: Number(rawCustom.v) || 0
          }
        } else if (rawCustom.kind === 'url' && typeof rawCustom.url === 'string' && rawCustom.url) {
          custom = { kind: 'url', url: rawCustom.url }
        }
      }
      const legacyUnfocused = source.onlyWhenUnfocused === true
      return {
        enabled: source.enabled !== false,
        muteBuiltin: source.muteBuiltin !== false,
        playInForeground: typeof source.playInForeground === 'boolean' ? source.playInForeground : !legacyUnfocused,
        presetId: PRESET_IDS.indexOf(source.presetId) >= 0 ? source.presetId : 'chime',
        volume: clamp01(typeof source.volume === 'number' ? source.volume : 0.8),
        custom
      }
    }

    function presetOf(id) {
      for (const preset of PRESETS) {
        if (preset.id === id) return preset
      }
      return PRESETS[0]
    }

    /* ------------------------------------------------------------------- engine */

    function createEngine() {
      let ac = null
      let master = null
      let idleTimer = 0
      let unlocked = false
      const buffers = new Map()
      const pending = new Map()

      function clearIdle() {
        if (!idleTimer) return
        clearTimeout(idleTimer)
        idleTimer = 0
      }

      function armIdle() {
        clearIdle()
        idleTimer = setTimeout(() => {
          idleTimer = 0
          suspendNow()
        }, AUDIO_IDLE_MS)
      }

      function suspendNow() {
        try {
          if (!ac || ac.state !== 'running') return
          const task = ac.suspend()
          if (task && typeof task.catch === 'function') task.catch(noop)
        } catch (err) {
          /* ignore: suspending is best effort */
        }
      }

      function ensure() {
        if (ac) {
          const state = ac.state
          if (state === 'suspended' || state === 'interrupted') {
            try {
              const task = ac.resume()
              if (task && typeof task.catch === 'function') task.catch(noop)
            } catch (err) {
              /* a rejected resume just means we stay silent until the next gesture */
            }
          }
          armIdle()
          return ac
        }
        const Ctor = window.AudioContext || window.webkitAudioContext
        if (!Ctor) return null
        let created = null
        try {
          created = new Ctor({ latencyHint: 'interactive' })
        } catch (err) {
          try {
            created = new Ctor()
          } catch (err2) {
            created = null
          }
        }
        if (!created) return null
        try {
          master = created.createGain()
          master.gain.value = 1
          const limiter = created.createDynamicsCompressor()
          limiter.threshold.value = -6
          limiter.knee.value = 8
          limiter.ratio.value = 12
          limiter.attack.value = 0.003
          limiter.release.value = 0.25
          master.connect(limiter)
          limiter.connect(created.destination)
        } catch (err) {
          master = null
        }
        ac = created
        if (ac.state === 'suspended' && unlocked) {
          try {
            const task = ac.resume()
            if (task && typeof task.catch === 'function') task.catch(noop)
          } catch (err) {
            /* ignore */
          }
        }
        armIdle()
        return ac
      }

      function unlock() {
        unlocked = true
        ensure()
      }

      function play(cfg) {
        if (!cfg || cfg.enabled === false) return
        const volume = clamp01(cfg.volume)
        const custom = cfg.custom
        if (custom && custom.kind === 'url' && custom.url) {
          playStream(custom.url, volume)
          return
        }
        if (custom && custom.kind === 'file' && custom.ext) {
          playStream(ROUTE + '/custom?v=' + encodeURIComponent(String(custom.v || 0)), volume)
          return
        }
        const context = ensure()
        if (!context || !master) return
        master.gain.value = volume
        try {
          presetOf(cfg.presetId).draw(context, master, context.currentTime + 0.02)
        } catch (err) {
          console.warn('[completion-sound] preset playback failed:', err)
        }
      }

      function playStream(url, volume) {
        const context = ensure()
        if (!context || !master) return
        const cached = buffers.get(url)
        if (cached) {
          start(context, cached, volume)
          return
        }
        load(context, url).then(
          (buffer) => {
            start(context, buffer, volume)
          },
          () => {
            /* load() already logged the reason */
          }
        )
      }

      function start(context, buffer, volume) {
        try {
          if (master) master.gain.value = volume
          const source = context.createBufferSource()
          source.buffer = buffer
          source.connect(master)
          ownSources.add(source)
          source.start()
        } catch (err) {
          console.warn('[completion-sound] custom audio playback failed:', err)
        }
      }

      function remember(url, buffer) {
        buffers.set(url, buffer)
        while (buffers.size > 4) {
          const oldest = buffers.keys().next()
          if (oldest.done) break
          buffers.delete(oldest.value)
        }
      }

      function load(context, url) {
        const running = pending.get(url)
        if (running) return running
        const task = fetch(url, { cache: 'no-store', credentials: 'same-origin' })
          .then((response) => {
            if (response.status === 204) throw new Error('empty audio response (HTTP 204)')
            if (!response.ok) throw new Error('audio request failed (HTTP ' + response.status + ')')
            return response.arrayBuffer()
          })
          .then((raw) => {
            const bytes = raw ? raw.byteLength : 0
            if (bytes < 128) throw new Error('audio payload too small (' + bytes + ' bytes)')
            return new Promise((resolve, reject) => {
              let settled = false
              const done = (buffer) => {
                if (settled) return
                settled = true
                resolve(buffer)
              }
              const fail = (err) => {
                if (settled) return
                settled = true
                reject(err || new Error('decode failed'))
              }
              try {
                const task = context.decodeAudioData(raw, done, fail)
                if (task && typeof task.then === 'function') task.then(done, fail)
              } catch (err) {
                fail(err)
              }
            })
          })
          .then((buffer) => {
            pending.delete(url)
            remember(url, buffer)
            return buffer
          })
          .catch((err) => {
            pending.delete(url)
            console.warn('[completion-sound] custom audio unavailable:', url, err && err.message ? err.message : err)
            throw err
          })
        pending.set(url, task)
        return task
      }

      return { play, unlock, suspend: suspendNow, ensure }
    }

    const engine = createEngine()

    function noop() {}

    /* --------------------------------------------------------- config transport */

    let configRequested = false
    let savePatch = null
    let saveTimer = 0
    let saveQueue = Promise.resolve()

    function loadConfig(force) {
      if (configRequested && !force) return Promise.resolve()
      configRequested = true
      return fetch(ROUTE + '/config', { cache: 'no-store', credentials: 'same-origin' })
        .then((response) => {
          if (!response.ok) throw new Error('HTTP ' + response.status)
          return response.json()
        })
        .then((data) => {
          patchStore({ config: normalizeConfig(data), loading: false, error: '' })
        })
        .catch(() => {
          patchStore({ loading: false, config: store.config || normalizeConfig(null), error: store.error || 'offline' })
        })
    }

    function updateConfig(patch) {
      patchStore({ config: normalizeConfig(Object.assign({}, store.config, patch)) })
      savePatch = Object.assign({}, savePatch || {}, patch)
      if (saveTimer) clearTimeout(saveTimer)
      saveTimer = setTimeout(() => {
        saveTimer = 0
        commitConfig()
      }, 240)
    }

    function commitConfig() {
      const patch = savePatch
      savePatch = null
      if (!patch) return saveQueue
      patchStore({ saving: true })
      saveQueue = saveQueue.then(() => {
        return fetch(ROUTE + '/config', {
          method: 'PUT',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(patch)
        })
          .then((response) => {
            if (!response.ok) throw new Error('HTTP ' + response.status)
            return response.json()
          })
          .then((data) => {
            if (savePatch) patchStore({ saving: false, error: '' })
            else patchStore({ config: normalizeConfig(data), saving: false, error: '' })
          })
          .catch(() => {
            patchStore({ saving: false, error: 'offline' })
          })
      })
      return saveQueue
    }

    function uploadAudio(file) {
      patchStore({ busy: true, error: '' })
      return fetch(ROUTE + '/custom?name=' + encodeURIComponent(file.name || 'audio.mp3'), {
        method: 'POST',
        headers: { 'content-type': file.type || 'application/octet-stream' },
        body: file
      })
        .then((response) => {
          return response.json().then(
            (data) => ({ response, data }),
            () => ({ response, data: null })
          )
        })
        .then(({ response, data }) => {
          if (!response.ok || !data || data.ok !== true) throw new Error((data && data.error) || 'HTTP ' + response.status)
          patchStore({ config: normalizeConfig(data.config), busy: false, error: '' })
          return true
        })
        .catch(() => {
          patchStore({ busy: false, error: 'upload-failed' })
          return false
        })
    }

    function clearCustom() {
      updateConfig({ custom: null })
      fetch(ROUTE + '/custom', { method: 'DELETE' }).catch(noop)
    }

    /* ------------------------------------------------------------------- polling */

    const runtime = { running: false, timer: 0, stop: false, hostOk: false, boot: '', lastSeq: 0, lastAt: 0 }

    function isForeground() {
      if (typeof document === 'undefined') return true
      if (document.hidden === true) return false
      if (typeof document.hasFocus === 'function') return document.hasFocus()
      return true
    }

    function playNow() {
      const config = store.config
      if (!config || config.enabled === false) return
      if (config.playInForeground === false && isForeground()) return
      engine.play(config)
    }

    function readStoredSeq() {
      try {
        const raw = window.localStorage.getItem(STORAGE_KEY)
        if (!raw) return
        const parsed = JSON.parse(raw)
        if (!parsed || typeof parsed !== 'object') return
        const seq = Number(parsed.seq)
        const at = Number(parsed.at)
        if (!Number.isFinite(seq) || seq <= 0) return
        if (Number.isFinite(at) && at > 0 && Date.now() - at > MAX_SEQ_AGE_MS) return
        runtime.lastSeq = seq
        runtime.lastAt = Number.isFinite(at) ? at : 0
      } catch (err) {
        /* private mode / disabled storage: the in-memory counter still works */
      }
    }

    function storeSeq(seq, at, boot) {
      try {
        window.localStorage.setItem(STORAGE_KEY, JSON.stringify({ seq, at, boot }))
      } catch (err) {
        /* ignore */
      }
    }

    function schedulePoll(delay) {
      if (runtime.stop) return
      if (runtime.timer) clearTimeout(runtime.timer)
      runtime.timer = setTimeout(pollOnce, delay)
    }

    function pollOnce() {
      runtime.timer = 0
      if (runtime.stop) return
      const sentAt = Date.now()
      fetch(ROUTE + '/state', { cache: 'no-store', credentials: 'same-origin' })
        .then((response) => {
          if (response.status === 404) throw new Error('route missing')
          if (!response.ok) throw new Error('HTTP ' + response.status)
          return response.json()
        })
        .then((state) => {
          applyState(state, sentAt)
          schedulePoll(POLL_IDLE_MS)
        })
        .catch(() => {
          runtime.hostOk = false
          schedulePoll(POLL_OFFLINE_MS)
        })
    }

    function applyState(state, sentAt) {
      if (!state || typeof state !== 'object') return
      const seq = Number.isFinite(state.seq) ? Math.max(0, Math.floor(state.seq)) : 0
      const boot = typeof state.boot === 'string' ? state.boot : ''
      const at = Number.isFinite(state.at) ? state.at : 0
      const fresh = !runtime.hostOk || runtime.boot !== boot
      runtime.hostOk = true
      runtime.boot = boot

      if (seq > runtime.lastSeq) {
        const playable = !fresh && seq === runtime.lastSeq + 1 && Date.now() - at <= MAX_SEQ_AGE_MS
        runtime.lastSeq = seq
        runtime.lastAt = at
        storeSeq(seq, at, boot)
        if (playable) playNow()
      } else if (fresh && seq !== runtime.lastSeq) {
        runtime.lastSeq = seq
        runtime.lastAt = at
        storeSeq(seq, at, boot)
      }
    }

    function startPolling() {
      if (runtime.running) return
      runtime.running = true
      runtime.stop = false
      readStoredSeq()
      schedulePoll(60)
    }

    function stopPolling() {
      runtime.stop = true
      runtime.running = false
      if (runtime.timer) {
        clearTimeout(runtime.timer)
        runtime.timer = 0
      }
    }

    /* ------------------------------------------------- turnTail mount heuristic */

    const seenTurns = typeof WeakSet === 'function' ? new WeakSet() : null
    const heuristic = { primed: false, lastMount: 0, timer: 0 }

    function noteTurnMount(props) {
      if (runtime.hostOk) return
      const config = store.config
      if (config && config.enabled === false) return
      const turn = props && props.turn
      if (turn && typeof turn === 'object' && seenTurns) {
        if (seenTurns.has(turn)) return
        seenTurns.add(turn)
      }
      const now = Date.now()
      const isolated = heuristic.primed && now - heuristic.lastMount > HEURISTIC_BURST_MS
      heuristic.primed = true
      heuristic.lastMount = now
      if (!isolated) return
      if (heuristic.timer) clearTimeout(heuristic.timer)
      heuristic.timer = setTimeout(() => {
        heuristic.timer = 0
        if (!runtime.hostOk) playNow()
      }, HEURISTIC_DELAY_MS)
    }

    function TurnWatcher(props) {
      React.useEffect(() => {
        noteTurnMount(props)
      })
      return null
    }

    /* -------------------------------------------------------------------- pieces */

    function Toggle(props) {
      return h(
        'button',
        {
          type: 'button',
          role: 'switch',
          'aria-checked': props.checked ? 'true' : 'false',
          className: 'dcs__switch' + (props.checked ? ' is-on' : ''),
          disabled: props.disabled === true,
          onClick: () => {
            if (props.disabled === true) return
            props.onChange(!props.checked)
          }
        },
        h('span', { className: 'dcs__knob' })
      )
    }

    function box(className, ...children) {
      return h('div', { className }, ...children)
    }

    function SettingsSection(props) {
      const t = props && typeof props.t === 'function' ? props.t : (key) => key
      const state = useStore()
      const config = state.config || normalizeConfig(null)
      const fileRef = React.useRef(null)
      const urlLoaded = React.useRef(false)
      const [urlDraft, setUrlDraft] = React.useState('')
      const [urlBad, setUrlBad] = React.useState(false)
      const [note, setNote] = React.useState('')

      React.useEffect(() => {
        loadConfig()
      }, [])

      React.useEffect(() => {
        if (urlLoaded.current || !state.config) return
        urlLoaded.current = true
        if (config.custom && config.custom.kind === 'url') setUrlDraft(config.custom.url)
      }, [state.config])

      const enabled = config.enabled !== false
      const activePreset = config.custom ? '' : config.presetId

      function preview() {
        engine.play(Object.assign({}, config, { enabled: true, custom: config.custom }))
      }

      function pickPreset(id) {
        updateConfig({ presetId: id, custom: null })
        engine.play({ enabled: true, volume: config.volume, presetId: id, custom: null })
      }

      function toggleEnabled(value) {
        updateConfig({ enabled: value })
        if (value) engine.play(Object.assign({}, config, { enabled: true }))
      }

      function chooseFile() {
        if (fileRef.current) fileRef.current.click()
      }

      function handleFile(event) {
        const input = event.target
        const file = input.files && input.files[0]
        input.value = ''
        if (!file) return
        if (!ACCEPTED_FILE.test(file.name || '')) {
          setNote(t('badType'))
          return
        }
        if (file.size > MAX_CUSTOM_BYTES) {
          setNote(t('tooBig'))
          return
        }
        setNote('')
        uploadAudio(file).then((ok) => {
          if (ok) {
            const next = store.config
            if (next) engine.play(next)
          }
        })
      }

      function applyUrl() {
        const url = urlDraft.trim()
        if (url.length > 2048 || !/^https?:\/\/\S+$/i.test(url)) {
          setUrlBad(true)
          return
        }
        setUrlBad(false)
        updateConfig({ custom: { kind: 'url', url } })
        engine.play({ enabled: true, volume: config.volume, presetId: config.presetId, custom: { kind: 'url', url } })
      }

      const customLabel =
        config.custom && config.custom.kind === 'file'
          ? config.custom.name
          : config.custom && config.custom.kind === 'url'
            ? t('usingUrl')
            : t('noFile')

      const statusText =
        state.error === 'offline'
          ? t('offline')
          : state.error === 'upload-failed'
            ? t('uploadFail')
            : state.saving
              ? t('saving')
              : state.loading
                ? t('loading')
                : ''

      return box(
        'dcs',
        box('dcs__head', h('h2', { className: 'dcs__title' }, t('title')), h('p', { className: 'dcs__desc' }, t('desc'))),
        box(
          'dcs__card',
          box(
            'dcs__row',
            box('dcs__rowText', h('span', { className: 'dcs__label' }, t('enable')), h('span', { className: 'dcs__hint' }, t('enableHint'))),
            h(Toggle, { checked: enabled, onChange: toggleEnabled })
          ),
          box(
            'dcs__row',
            box(
              'dcs__rowText',
              h('span', { className: 'dcs__label' }, t('foreground')),
              h('span', { className: 'dcs__hint' }, t('foregroundHint'))
            ),
            h(Toggle, {
              checked: config.playInForeground !== false,
              disabled: !enabled,
              onChange: (value) => updateConfig({ playInForeground: value })
            })
          ),
          box(
            'dcs__row',
            box(
              'dcs__rowText',
              h('span', { className: 'dcs__label' }, t('muteBuiltin')),
              h('span', { className: 'dcs__hint' }, t('muteBuiltinHint'))
            ),
            h(Toggle, {
              checked: config.muteBuiltin !== false,
              disabled: !enabled,
              onChange: (value) => updateConfig({ muteBuiltin: value })
            })
          )
        ),
        box(
          'dcs__card',
          box(
            'dcs__rowHead',
            h('span', { className: 'dcs__cardTitle' }, t('sound')),
            h(
              'button',
              { type: 'button', className: 'dcs__btn dcs__btn--ghost', disabled: !enabled, onClick: preview },
              t('preview')
            )
          ),
          h('p', { className: 'dcs__hint dcs__hint--block' }, t('soundHint')),
          box(
            'dcs__grid',
            PRESETS.map((preset) =>
              h(
                'button',
                {
                  key: preset.id,
                  type: 'button',
                  className: 'dcs__chip' + (activePreset === preset.id ? ' is-active' : ''),
                  disabled: !enabled,
                  onClick: () => pickPreset(preset.id)
                },
                t('preset_' + preset.id)
              )
            )
          )
        ),
        box(
          'dcs__card',
          box(
            'dcs__rowHead',
            h('span', { className: 'dcs__cardTitle' }, t('volume')),
            h('span', { className: 'dcs__value' }, Math.round(config.volume * 100) + '%')
          ),
          h('input', {
            type: 'range',
            className: 'dcs__range',
            min: 0,
            max: 100,
            step: 1,
            value: Math.round(config.volume * 100),
            disabled: !enabled,
            onChange: (event) => updateConfig({ volume: Number(event.target.value) / 100 }),
            onPointerUp: preview,
            onKeyUp: preview
          })
        ),
        box(
          'dcs__card',
          box(
            'dcs__rowHead',
            h('span', { className: 'dcs__cardTitle' }, t('custom')),
            config.custom
              ? h(
                  'button',
                  { type: 'button', className: 'dcs__btn dcs__btn--ghost', disabled: !enabled, onClick: preview },
                  t('preview')
                )
              : null
          ),
          h('p', { className: 'dcs__hint dcs__hint--block' }, t('customHint')),
          box(
            'dcs__row',
            h(
              'button',
              { type: 'button', className: 'dcs__btn', onClick: chooseFile, disabled: state.busy },
              state.busy ? t('uploading') : t('chooseFile')
            ),
            h('span', { className: 'dcs__file', title: customLabel }, customLabel),
            config.custom
              ? h('button', { type: 'button', className: 'dcs__btn dcs__btn--ghost', onClick: clearCustom }, t('clear'))
              : null,
            h('input', {
              ref: fileRef,
              type: 'file',
              className: 'dcs__fileInput',
              accept: 'audio/*,.mp3,.wav,.ogg,.m4a,.aac,.flac,.webm',
              onChange: handleFile
            })
          ),
          box(
            'dcs__row',
            h('input', {
              type: 'text',
              className: 'dcs__inp' + (urlBad ? ' is-error' : ''),
              placeholder: t('urlPlaceholder'),
              value: urlDraft,
              onChange: (event) => {
                setUrlDraft(event.target.value)
                if (urlBad) setUrlBad(false)
              },
              onKeyDown: (event) => {
                if (event.key === 'Enter') applyUrl()
              }
            }),
            h('button', { type: 'button', className: 'dcs__btn', onClick: applyUrl }, t('useUrl'))
          ),
          urlBad ? h('span', { className: 'dcs__hint dcs__hint--error' }, t('badUrl')) : null,
          note ? h('span', { className: 'dcs__hint dcs__hint--error' }, note) : null
        ),
        statusText ? box('dcs__status' + (state.error ? ' is-error' : ''), statusText) : null
      )
    }

    /* ------------------------------------------------------------- plugin wiring */

    let detachGestures = null

    function installGestures() {
      if (detachGestures || typeof document === 'undefined') return
      const onGesture = (event) => {
        if (event && (event.isComposing === true || event.keyCode === 229)) return
        const config = store.config
        if (config && config.enabled === false) return
        engine.unlock()
      }
      const onVisibility = () => {
        if (document.hidden === true) engine.suspend()
      }
      document.addEventListener('pointerdown', onGesture, true)
      document.addEventListener('keydown', onGesture, true)
      document.addEventListener('visibilitychange', onVisibility)
      detachGestures = () => {
        document.removeEventListener('pointerdown', onGesture, true)
        document.removeEventListener('keydown', onGesture, true)
        document.removeEventListener('visibilitychange', onVisibility)
        detachGestures = null
      }
    }

    function apply(ctx) {
      ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'completion-sound: dictionaries')

      const t = ctx.locale.bind(NS)

      ctx.effect(() => {
        injectStyles()
        installSoundGuard()
        loadConfig()
        startPolling()
        installGestures()
        return () => {
          syncSoundGuard(null)
          stopPolling()
          if (detachGestures) detachGestures()
        }
      }, 'completion-sound: runtime')

      ctx.slots.inject('settings.section', function* () {
        yield ctx.slots.register(
          {
            name: 'settings.section',
            id: 'completion-sound',
            order: 35,
            label: () => t('nav'),
            inject: () => ({ t })
          },
          SettingsSection
        )
      })

      ctx.slots.inject('conversation.chat.turnTail', function* () {
        yield ctx.slots.register({ name: 'conversation.chat.turnTail', id: 'completion-sound', order: 50 }, TurnWatcher)
      })
    }

    return { name: 'completion-sound', inject: ['slots', 'locale'], apply }
  }
})
