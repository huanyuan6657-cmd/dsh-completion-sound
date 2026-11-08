/**
 * dsh-completion-sound —— Host half.
 *
 * Responsibilities (everything that must survive a browser refresh / port change):
 *   1. Watch the authoritative completion signal (`session/event` → `turn/end` with
 *      `reason.kind === 'completed'`) and bump a monotonic turn counter.
 *   2. Persist the user's preferences to `$DSH_HOME/dsh-completion-sound/config.json`
 *      (a GUI port change must not lose the chosen sound, so `localStorage` is not enough).
 *   3. Serve that state over plain HTTP so the Client half can poll it:
 *        GET    /dsh-completion-sound            liveness
 *        GET    /dsh-completion-sound/state       { ok, boot, seq, at, sessionId }
 *        GET    /dsh-completion-sound/config      effective config
 *        PUT    /dsh-completion-sound/config      merge a partial config
 *        GET    /dsh-completion-sound/custom      the uploaded audio bytes
 *        POST   /dsh-completion-sound/custom?name=x.mp3   replace the uploaded audio
 *        DELETE /dsh-completion-sound/custom      drop the uploaded audio
 *
 * The sound itself is synthesised / decoded in the browser, so this module ships no
 * audio assets and does not depend on `@deepseek-ai/*` runtime packages.
 */
import { createReadStream, existsSync, mkdirSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, join } from 'node:path'

export const name = 'completion-sound'
export const inject = ['webServer']

const ROUTE = '/dsh-completion-sound'
const MAX_UPLOAD = 8 * 1024 * 1024
const MAX_URL_LENGTH = 2048
const MAX_TRACKED_SESSIONS = 512

const AUDIO_MIME = new Map([
  ['.mp3', 'audio/mpeg'],
  ['.wav', 'audio/wav'],
  ['.ogg', 'audio/ogg'],
  ['.m4a', 'audio/mp4'],
  ['.aac', 'audio/aac'],
  ['.flac', 'audio/flac'],
  ['.webm', 'audio/webm']
])

const PRESET_IDS = new Set(['chime', 'rise', 'soft', 'wood', 'drop', 'blip', 'fanfare'])

const DEFAULTS = Object.freeze({
  enabled: true,
  muteBuiltin: true,
  playInForeground: true,
  presetId: 'chime',
  volume: 0.8,
  custom: null
})

export function apply(ctx) {
  const homeDir = process.env.DSH_HOME && process.env.DSH_HOME.trim() ? process.env.DSH_HOME.trim() : join(homedir(), '.dsh')
  const dataDir = join(homeDir, 'dsh-completion-sound')
  const configFile = join(dataDir, 'config.json')
  const boot = Math.random().toString(36).slice(2, 10) + Date.now().toString(36)
  const turnFlags = new Map()
  const counters = { seq: 0, at: 0, sessionId: '' }
  // 诊断缓冲：页面上每次「别人想发声」的尝试都由客户端批量上报到这里，用来定位
  // 「完成时还有一声不是我放的提示音」到底是页面里的插件、还是页面之外（系统通知）。
  const diag = { guard: null, entries: [], updatedAt: 0 }
  const MAX_DIAG_ENTRIES = 80

  /* ------------------------------------------------------------------ storage */

  function ensureDir() {
    try {
      mkdirSync(dataDir, { recursive: true })
      return true
    } catch (err) {
      console.warn('[completion-sound] cannot create data dir:', messageOf(err))
      return false
    }
  }

  function sanitize(input, prev) {
    const next = {
      enabled: typeof prev.enabled === 'boolean' ? prev.enabled : DEFAULTS.enabled,
      muteBuiltin: typeof prev.muteBuiltin === 'boolean' ? prev.muteBuiltin : DEFAULTS.muteBuiltin,
      playInForeground:
        typeof prev.playInForeground === 'boolean'
          ? prev.playInForeground
          : prev.onlyWhenUnfocused === true
            ? false
            : DEFAULTS.playInForeground,
      presetId: typeof prev.presetId === 'string' ? prev.presetId : DEFAULTS.presetId,
      volume: typeof prev.volume === 'number' ? prev.volume : DEFAULTS.volume,
      custom: prev.custom || null
    }
    if (!input || typeof input !== 'object') return next
    if (typeof input.enabled === 'boolean') next.enabled = input.enabled
    if (typeof input.muteBuiltin === 'boolean') next.muteBuiltin = input.muteBuiltin
    if (typeof input.playInForeground === 'boolean') next.playInForeground = input.playInForeground
    if (typeof input.presetId === 'string' && PRESET_IDS.has(input.presetId)) next.presetId = input.presetId
    if (typeof input.volume === 'number' && Number.isFinite(input.volume)) {
      next.volume = Math.round(Math.min(1, Math.max(0, input.volume)) * 100) / 100
    }
    if (input.custom === null) {
      next.custom = null
    } else if (input.custom && typeof input.custom === 'object' && input.custom.kind === 'url') {
      const url = String(input.custom.url || '').trim()
      if (!url) next.custom = null
      else if (url.length <= MAX_URL_LENGTH && /^https?:\/\/\S+$/i.test(url)) next.custom = { kind: 'url', url }
    }
    return next
  }

  function customPath(ext) {
    if (typeof ext !== 'string' || !AUDIO_MIME.has(ext)) return null
    return join(dataDir, 'custom' + ext)
  }

  function loadConfig() {
    let config = { ...DEFAULTS }
    try {
      config = sanitize(JSON.parse(readFileSync(configFile, 'utf8')), config)
    } catch (err) {
      if (err && err.code !== 'ENOENT') console.warn('[completion-sound] config unreadable, using defaults:', messageOf(err))
    }
    if (config.custom && config.custom.kind === 'file') {
      const file = customPath(config.custom.ext)
      if (!file || !existsSync(file)) config.custom = null
    }
    return config
  }

  let config = loadConfig()

  function saveConfig(next) {
    config = next
    if (!ensureDir()) return next
    const tmp = configFile + '.tmp'
    try {
      writeFileSync(tmp, JSON.stringify(next, null, 2) + '\n', 'utf8')
      renameSync(tmp, configFile)
    } catch (err) {
      console.warn('[completion-sound] cannot persist config:', messageOf(err))
      try {
        unlinkSync(tmp)
      } catch {}
    }
    return next
  }

  function dropCustomFiles(keep) {
    for (const ext of AUDIO_MIME.keys()) {
      if (ext === keep) continue
      try {
        unlinkSync(join(dataDir, 'custom' + ext))
      } catch {}
    }
  }

  /* ------------------------------------------------------------------- events */

  ctx.effect(
    () => {
      const dispose = ctx.on('session/event', (session, event) => {
        const type = event && event.type
        if (!type) return
        const sessionId = sessionIdOf(session)

        if (type === 'turn/start') {
          if (turnFlags.size > MAX_TRACKED_SESSIONS) turnFlags.clear()
          turnFlags.set(sessionId, { goalRound: false })
          return
        }

        if (type === 'user/message') {
          const source = event.data && event.data.source
          if (!source || source.kind !== 'goal') return
          const flags = turnFlags.get(sessionId) || { goalRound: false }
          flags.goalRound = true
          turnFlags.set(sessionId, flags)
          return
        }

        if (type !== 'turn/end') return
        const flags = turnFlags.get(sessionId)
        turnFlags.delete(sessionId)
        // A goal continuation round only finishes one automatic step of a longer job —
        // stay quiet until the whole goal is done (mirrors dsh-pet's behaviour).
        if (flags && flags.goalRound) return
        const reason = event.data && event.data.reason
        if (!reason || reason.kind !== 'completed') return
        if (!isRootSession(session)) return
        counters.seq += 1
        counters.at = Date.now()
        counters.sessionId = sessionId
      })
      return () => {
        try {
          dispose()
        } catch {}
        turnFlags.clear()
      }
    },
    'completion-sound: turn completion counter'
  )

  /* ------------------------------------------------------------------- routes */

  ctx.effect(
    () =>
      ctx.webServer.register({
        kind: 'prefix',
        path: ROUTE,
        handler: async (req, res) => {
          const deny = rejectionStatus(ctx, req)
          if (deny) {
            sendJson(res, deny, { ok: false, error: 'forbidden' })
            return
          }
          try {
            await route(req, res)
          } catch (err) {
            console.warn('[completion-sound] request failed:', messageOf(err))
            if (!res.destroyed && !res.writableEnded) sendJson(res, 500, { ok: false, error: 'internal' })
          }
        }
      }),
    'completion-sound: http routes'
  )

  async function route(req, res) {
    const method = String(req.method || 'GET').toUpperCase()
    const url = new URL(req.url || '/', 'http://127.0.0.1')
    const path = url.pathname.replace(/\/+$/, '')
    if (path !== ROUTE && !path.startsWith(ROUTE + '/')) return sendJson(res, 404, { ok: false, error: 'not-found' })
    const sub = path.slice(ROUTE.length)

    if (sub === '') {
      if (!isRead(method)) return sendJson(res, 405, { ok: false, error: 'method' })
      sendText(res, 200, 'dsh-completion-sound is running\n')
      return
    }

    if (sub === '/state') {
      if (!isRead(method)) return sendJson(res, 405, { ok: false, error: 'method' })
      sendJson(res, 200, { ok: true, boot, seq: counters.seq, at: counters.at, sessionId: counters.sessionId, now: Date.now() })
      return
    }

    if (sub === '/config') {
      if (method === 'GET') return sendJson(res, 200, config)
      if (method === 'PUT' || method === 'POST') {
        const body = await readJson(req)
        if (!body.ok) return sendJson(res, body.status, { ok: false, error: body.error })
        return sendJson(res, 200, saveConfig(sanitize(body.value, config)))
      }
      return sendJson(res, 405, { ok: false, error: 'method' })
    }

    if (sub === '/diag') {
      if (method === 'DELETE') {
        diag.entries.length = 0
        diag.guard = null
        diag.updatedAt = Date.now()
        return sendJson(res, 200, { ok: true, cleared: true })
      }
      if (method === 'GET') {
        return sendJson(res, 200, { ok: true, boot, guard: diag.guard, entries: diag.entries, updatedAt: diag.updatedAt, now: Date.now() })
      }
      if (method === 'POST') {
        const body = await readJson(req)
        if (!body.ok) return sendJson(res, body.status, { ok: false, error: body.error })
        const value = body.value
        if (!value || typeof value !== 'object') return sendJson(res, 400, { ok: false, error: 'bad-body' })
        if (value.guard && typeof value.guard === 'object') diag.guard = { ...value.guard, at: Date.now() }
        const list = Array.isArray(value.entries) ? value.entries : []
        for (const entry of list.slice(0, 40)) {
          if (!entry || typeof entry !== 'object') continue
          diag.entries.push({ ...entry, receivedAt: Date.now() })
        }
        while (diag.entries.length > MAX_DIAG_ENTRIES) diag.entries.shift()
        diag.updatedAt = Date.now()
        return sendJson(res, 200, { ok: true, stored: diag.entries.length })
      }
      return sendJson(res, 405, { ok: false, error: 'method' })
    }

    if (sub === '/custom') {
      if (method === 'GET') return sendCustomAudio(res)
      if (method === 'POST') return receiveCustomAudio(req, res, url)
      if (method === 'DELETE') {
        dropCustomFiles(null)
        return sendJson(res, 200, { ok: true, config: saveConfig({ ...config, custom: null }) })
      }
      return sendJson(res, 405, { ok: false, error: 'method' })
    }

    sendJson(res, 404, { ok: false, error: 'not-found' })
  }

  function sendCustomAudio(res) {
    const custom = config.custom
    if (!custom || custom.kind !== 'file') return sendJson(res, 404, { ok: false, error: 'no-custom-audio' })
    const file = customPath(custom.ext)
    if (!file || !existsSync(file)) return sendJson(res, 404, { ok: false, error: 'no-custom-audio' })
    let size = 0
    try {
      size = statSync(file).size
    } catch {}
    res.writeHead(200, {
      'content-type': AUDIO_MIME.get(custom.ext) || 'application/octet-stream',
      'content-length': String(size),
      'cache-control': 'no-store',
      'x-content-type-options': 'nosniff'
    })
    const stream = createReadStream(file)
    stream.on('error', (err) => {
      console.warn('[completion-sound] custom audio read failed:', messageOf(err))
      try {
        res.destroy()
      } catch {}
    })
    res.on('close', () => {
      try {
        stream.destroy()
      } catch {}
    })
    stream.pipe(res)
  }

  async function receiveCustomAudio(req, res, url) {
    const rawName = url.searchParams.get('name') || req.headers['x-file-name'] || ''
    const ext = extensionOf(String(rawName))
    if (!ext) return sendJson(res, 415, { ok: false, error: 'unsupported-type' })
    let bytes
    try {
      bytes = await readRawBody(req, MAX_UPLOAD)
    } catch (err) {
      const code = err && err.code === 413 ? 413 : 400
      return sendJson(res, code, { ok: false, error: code === 413 ? 'too-large' : 'bad-body' })
    }
    if (!bytes || bytes.length < 64) return sendJson(res, 400, { ok: false, error: 'empty' })
    if (!ensureDir()) return sendJson(res, 500, { ok: false, error: 'no-data-dir' })
    const target = join(dataDir, 'custom' + ext)
    try {
      writeFileSync(target, bytes)
    } catch (err) {
      console.warn('[completion-sound] cannot store custom audio:', messageOf(err))
      return sendJson(res, 500, { ok: false, error: 'write-failed' })
    }
    dropCustomFiles(ext)
    const next = saveConfig({
      ...config,
      custom: { kind: 'file', name: safeName(rawName, ext), ext, size: bytes.length, v: Date.now() }
    })
    sendJson(res, 200, { ok: true, config: next })
  }
}

/* -------------------------------------------------------------------- helpers */

function messageOf(err) {
  return err && err.message ? String(err.message) : String(err)
}

function isRead(method) {
  return method === 'GET' || method === 'HEAD'
}

function sessionIdOf(session) {
  const value = session && session.header && session.header.id !== undefined ? session.header.id : session && session.id
  return String(value === undefined ? 'unknown' : value)
}

/**
 * Sub-agent sessions (`origin === 'subagent'`, or any delegated depth) finish constantly and
 * must not fire the chime. `parentSession` is NOT a usable signal — a forked root session
 * carries it too.
 */
function isRootSession(session) {
  const header = session && session.header
  if (!header || typeof header !== 'object') return true
  if (header.origin === 'subagent') return false
  const depth = header.delegationDepth
  if (typeof depth === 'number' && Number.isFinite(depth) && depth > 0) return false
  return true
}

function extensionOf(fileName) {
  const match = /\.([a-z0-9]+)$/i.exec(String(fileName || ''))
  if (!match) return null
  const ext = '.' + match[1].toLowerCase()
  return AUDIO_MIME.has(ext) ? ext : null
}

function safeName(fileName, ext) {
  const name = basename(String(fileName || '').replace(/\\/g, '/')).trim()
  return name && name.length <= 120 ? name : 'custom' + ext
}

/**
 * Route fence. First ask the host's own Connection gate, which is the authority on browser
 * credentials. When that gate has nothing to admit (a plain loopback caller such as the
 * desktop shell, a health probe, or a browser whose cookie the transport did not carry) we
 * fall back to a loopback + same-origin check: peer address on loopback, `Host` naming a
 * loopback authority, and any `Origin` matching that authority exactly.
 *
 * That combination still blocks the attacks the gate exists for — a website in the same
 * browser (Origin mismatch) and DNS rebinding (Host is no longer loopback) — while keeping
 * the sound working when no credential is presented on a loopback-only server.
 */
function rejectionStatus(ctx, req) {
  let gate = 0
  try {
    const connection = typeof ctx.get === 'function' ? ctx.get('connection') : null
    if (connection && typeof connection.requestRejection === 'function') {
      gate = connection.requestRejection(req) || 0
    }
  } catch {
    gate = 0
  }
  if (!gate) return 0
  return loopbackAllowed(req) ? 0 : gate
}

function loopbackAllowed(req) {
  const socket = req && req.socket
  const peer = socket && socket.remoteAddress ? String(socket.remoteAddress) : ''
  if (peer && !isLoopbackAddress(peer)) return false
  const host = hostnameOf(req && req.headers ? req.headers.host : '')
  if (!isLoopbackHostname(host)) return false
  const origin = req && req.headers ? req.headers.origin : undefined
  if (origin) {
    const originHost = hostnameOf(origin)
    if (!originHost || originHost !== host) return false
  }
  return true
}

function isLoopbackAddress(value) {
  const address = value.split('%')[0].toLowerCase()
  return address === '::1' || address === '127.0.0.1' || address.startsWith('127.') || address === '::ffff:127.0.0.1'
}

function isLoopbackHostname(host) {
  return host === '127.0.0.1' || host === 'localhost' || host === '::1' || host === '0:0:0:0:0:0:0:1'
}

function hostnameOf(value) {
  const raw = String(value || '').trim()
  if (!raw) return ''
  if (raw.startsWith('http://') || raw.startsWith('https://')) {
    try {
      return new URL(raw).hostname.replace(/^\[|\]$/g, '').toLowerCase()
    } catch {
      return ''
    }
  }
  const withoutPort = raw.replace(/:\d+$/, '')
  return withoutPort.replace(/^\[|\]$/g, '').toLowerCase()
}

function readJson(req) {
  return readRawBody(req, 256 * 1024).then(
    (bytes) => {
      try {
        return { ok: true, value: JSON.parse(bytes.toString('utf8')) }
      } catch {
        return { ok: false, status: 400, error: 'bad-json' }
      }
    },
    (err) => ({ ok: false, status: err && err.code === 413 ? 413 : 400, error: 'bad-body' })
  )
}

function readRawBody(req, limit) {
  return new Promise((resolve, reject) => {
    const declared = Number(req.headers['content-length'] || 0)
    if (Number.isFinite(declared) && declared > limit) {
      reject(Object.assign(new Error('too-large'), { code: 413 }))
      return
    }
    const chunks = []
    let size = 0
    let settled = false
    const fail = (err) => {
      if (settled) return
      settled = true
      reject(err)
    }
    req.on('data', (chunk) => {
      if (settled) return
      size += chunk.length
      if (size > limit) {
        fail(Object.assign(new Error('too-large'), { code: 413 }))
        try {
          req.destroy()
        } catch {}
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => {
      if (settled) return
      settled = true
      resolve(Buffer.concat(chunks))
    })
    req.on('error', (err) => fail(err || new Error('read-failed')))
    req.on('aborted', () => fail(Object.assign(new Error('aborted'), { code: 400 })))
  })
}

function sendJson(res, status, payload) {
  if (res.destroyed || res.writableEnded) return
  const body = JSON.stringify(payload)
  try {
    res.writeHead(status, {
      'content-type': 'application/json; charset=utf-8',
      'content-length': String(Buffer.byteLength(body)),
      'cache-control': 'no-store',
      'x-content-type-options': 'nosniff'
    })
    res.end(body)
  } catch (err) {
    console.warn('[completion-sound] response failed:', messageOf(err))
  }
}

function sendText(res, status, body) {
  if (res.destroyed || res.writableEnded) return
  try {
    res.writeHead(status, {
      'content-type': 'text/plain; charset=utf-8',
      'content-length': String(Buffer.byteLength(body)),
      'cache-control': 'no-store'
    })
    res.end(body)
  } catch (err) {
    console.warn('[completion-sound] response failed:', messageOf(err))
  }
}
