// Cache Keeper: watches this session's prompt cache, keeps big caches warm on
// request, refuses a cold send without asking first, and shows the agents of a
// chat (/ck-agents).
//
// Why: each request re-reads the whole context. From the cache that costs about
// a tenth of normal input. Once the cache expires (1 hour idle on a subscription,
// 5 minutes on the default API TTL), the next message writes the whole context
// again at 1.25x to 2x input. A cache read also restarts the timer, so a tiny
// ping before expiry costs a fraction of a rewrite.

import { rewriteCost, requestCost, totalInput, cachedShare, priceFor } from './pricing.mjs'
import { tokens, usd, minutes, clock, clip, basename, pad } from './fmt.mjs'
import { makeMasker } from './privacy.mjs'

const MIN = 60000
const HEARTBEAT_EVERY = 30000
const APANE = 'agents-pane'

// This session
const S = {
  id: '',
  cwd: '',
  model: '',
  lastActivity: 0, // last main-loop request or keep-warm ping that touched the cache
  ctx: 0,
  window: 0,
  costUsd: 0,
  ttlMin: 60,
  ttlSource: 'default',
  coldRestarts: [],
  working: false,
  turnId: '', // the main loop's running (or last) turn
  waitingSince: 0,
  waitingFor: '',
  tool: '',
  lastTurnEnd: 0,
  keepWarm: false,
  keepWarmUntil: 0,
  pings: 0,
  pingUsd: 0,
  lastPingAt: 0,
  warnedFor: 0,
  agentsRunning: 0,
  rateLimits: [],
}

const settings = { bigTokens: 150000, guard: true, ttlMin: 0, alerts: true, keepWarmHours: 4 }
const names = { cache: 'cache', keepwarm: 'keepwarm', agents: 'agents' }

let now = 0
async function readJson($, path, fallback) {
  try {
    return JSON.parse(await $.fs.read(path))
  } catch {
    return fallback
  }
}
let home = ''
let rec = { on: false, strict: false }
let mask = (s) => s
const alerted = new Map() // sessionId -> state or warning key already announced
let agentsOpen = false
const AG = new Map() // agentId -> { tokens, costUsd, requests, model, lastAt }
let AGI = [] // $.agent.list()
let justCompacted = false

function ttlMin() {
  return settings.ttlMin || S.ttlMin
}

// Plan limit windows as the API reports them: five_hour, seven_day, spend_limit
const LIMIT_LABEL = { five_hour: '5h', seven_day: 'week', spend_limit: 'spend' }

function limitsText(limits) {
  return limits.map((l) => `${LIMIT_LABEL[l.kind] || l.kind} ${Math.round(l.percentUsed)}%`).join(' · ')
}

function limitTone(limits, extra) {
  const top = Math.max(...limits.map((l) => l.percentUsed || 0))
  if (top >= 95) return { ...extra, color: 'red', bold: true }
  if (top >= 80) return { ...extra, color: 'yellow' }
  return { ...extra, dimColor: true }
}

function money(v) {
  return rec.strict ? '$•••' : usd(v)
}

function msLeft(lastActivity, ttl) {
  if (!lastActivity) return null
  return ttl * MIN - (now - lastActivity)
}

function cacheState(hb) {
  const left = msLeft(hb.lastActivity, hb.ttlMin)
  if (left === null) return { kind: 'unknown', left: 0 }
  if (hb.keepWarm) return { kind: 'kept', left }
  if (left <= 0) return { kind: 'cold', left }
  if (left <= 5 * MIN) return { kind: 'cooling', left }
  return { kind: 'warm', left }
}

// Model + context % handed over by the status line script (it alone gets them from Claude Code).
let ctxCache = { at: 0, v: null }
async function ctxState($) {
  if (!S.id || !home) return null
  if (Date.now() - ctxCache.at < 1500) return ctxCache.v
  let v = await readJson($, home + '/.claude/ctx-state/' + S.id + '.json', null)
  // No status line script running (VS Code): take model and context from the session itself
  if (!v) {
    if (!S.ctx || !S.window) {
      try {
        const u = await $.session.usage()
        if (u.context && u.context.tokens) S.ctx = u.context.tokens
        if (u.context && u.context.window) S.window = u.context.window
      } catch {
        // usage not available yet
      }
    }
    const pct = S.ctx && S.window ? (100 * S.ctx) / S.window : null
    if (S.model || pct != null) v = { model: prettyModel(S.model), pct }
  }
  ctxCache = { at: Date.now(), v }
  return v
}

function prettyModel(id) {
  const m = /claude-([a-z]+)-(\d+)(?:-(\d+))?/.exec(String(id || ''))
  if (!m) return String(id || 'Claude')
  return m[1][0].toUpperCase() + m[1].slice(1) + ' ' + m[2] + (m[3] ? '.' + m[3] : '')
}

function myHeartbeat() {
  const coldUsd = S.coldRestarts.reduce((a, c) => a + c.usd, 0)
  let state = 'idle'
  if (S.waitingSince && now - S.waitingSince > 5000) state = 'waiting'
  else if (S.working) state = 'working'
  return {
    id: S.id,
    cwd: S.cwd,
    model: S.model,
    state,
    waitingFor: S.waitingFor,
    tool: S.tool,
    ctx: S.ctx,
    window: S.window,
    ttlMin: ttlMin(),
    lastActivity: S.lastActivity,
    keepWarm: S.keepWarm,
    keepWarmUntil: S.keepWarmUntil,
    pings: S.pings,
    pingUsd: S.pingUsd,
    costUsd: S.costUsd,
    coldCount: S.coldRestarts.length,
    coldUsd,
    agentsRunning: S.agentsRunning,
    lastTurnEnd: S.lastTurnEnd,
    updatedAt: now,
  }
}

async function registerCommand($, name, description, argumentHint, immediate) {
  const spec = immediate ? { name, description, argumentHint, immediate: true } : { name, description, argumentHint }
  try {
    await $.command.register(spec)
    return name
  } catch {
    try {
      await $.command.register({ ...spec, name: 'ck-' + name })
      return 'ck-' + name
    } catch {
      return null
    }
  }
}

async function readRecording($) {
  try {
    const path = (home || '.') + '/.claude/mods-data/recording.json'
    if (!(await $.fs.exists(path))) {
      rec = { on: false, strict: false }
    } else {
      const flag = JSON.parse(await $.fs.read(path))
      rec = { on: !!flag.on, strict: !!flag.on && !!flag.strict }
    }
  } catch {
    rec = { on: false, strict: false }
  }
  mask = rec.on ? makeMasker({ strict: rec.strict }) : (s) => s
}

function startKeepWarm($, hours) {
  S.keepWarm = true
  S.keepWarmUntil = now + hours * 60 * MIN
  $.ui.toast(`Keeping this cache warm until ${clock(S.keepWarmUntil)}. A ping reads the cache before it expires.`)
}

function stopKeepWarm($, why) {
  if (!S.keepWarm) return
  S.keepWarm = false
  $.ui.toast(`Keep warm off (${why}). ${S.pings} ping(s), ${money(S.pingUsd)}.`, { timeoutMs: 8000 })
}

async function keepWarmStep($) {
  if (!S.keepWarm) return
  if (now >= S.keepWarmUntil) return stopKeepWarm($, 'time limit reached')
  if (S.working || !S.lastActivity) return
  const ttl = ttlMin()
  const margin = ttl >= 60 ? 8 * MIN : 90000
  if (now - S.lastActivity < ttl * MIN - margin) return
  let reply = null
  try {
    reply = await $.model.fork({ prompt: 'cache-keeper keep-alive ping. Reply with only: ok' })
  } catch {
    reply = null
  }
  if (!reply || !reply.usage) {
    return stopKeepWarm($, 'the ping got no answer, so the cache may already be cold')
  }
  const u = reply.usage
  S.pings += 1
  S.lastPingAt = now
  S.pingUsd += requestCost(u, S.model, ttl)
  // A ping that writes instead of reading did not hit the cache: stop paying for it
  if ((u.cache_creation_input_tokens || 0) > 0.1 * Math.max(1, u.cache_read_input_tokens || 0)) {
    return stopKeepWarm($, `the ping wrote ${tokens(u.cache_creation_input_tokens)} tokens instead of reading the cache`)
  }
  S.lastActivity = now
}

function warnStep($) {
  if (!settings.alerts) return
  const hb = myHeartbeat()
  if (hb.keepWarm || (hb.ctx || 0) < settings.bigTokens) return
  const st = cacheState(hb)
  if (st.kind !== 'cooling') return
  const key = 'cool:' + hb.lastActivity
  if (alerted.get(hb.id) === key) return
  alerted.set(hb.id, key)
  const cost = money(rewriteCost(hb.ctx, hb.model, hb.ttlMin))
  $.ui.toast(`This session: ${tokens(hb.ctx)}-token cache goes cold in ${minutes(st.left)}. Rewriting it costs about ${cost}. Type /${names.keepwarm} or press 1.`, { timeoutMs: 15000 })
}

async function tick($) {
  now = await $.clock.now()
  await readRecording($)
  await keepWarmStep($)
  warnStep($)
  $.ui.invalidate('ui.render')
}

async function loadSettings($) {
  const saved = await $.store.get('settings')
  if (saved && typeof saved === 'object') Object.assign(settings, saved)
}

function statusText() {
  const st = cacheState(myHeartbeat())
  const ttl = ttlMin()
  const lines = []
  lines.push(`Cache Keeper: ${tokens(S.ctx)} tokens in context on ${priceFor(S.model).id}, cache window ${ttl} min (${settings.ttlMin ? 'set by you' : S.ttlSource}).`)
  if (st.kind === 'unknown') lines.push('No request yet this session, so the cache state is unknown.')
  if (st.kind === 'warm' || st.kind === 'cooling') lines.push(`Cache is warm for about ${minutes(st.left)} more.`)
  if (st.kind === 'cold') lines.push(`Cache went cold ${minutes(-st.left)} ago. The next message rewrites it for about ${money(rewriteCost(S.ctx, S.model, ttl))}.`)
  if (S.keepWarm) lines.push(`Keep warm is on until ${clock(S.keepWarmUntil)}: ${S.pings} ping(s), ${money(S.pingUsd)} so far.`)
  if (S.rateLimits.length) lines.push(`Plan limits used: ${limitsText(S.rateLimits)}.`)
  lines.push(`Session cost so far: ${money(S.costUsd)}. Cold restarts this session: ${S.coldRestarts.length} (${money(S.coldRestarts.reduce((a, c) => a + c.usd, 0))}).`)
  lines.push(`Cold-send guard: ${settings.guard ? 'on' : 'off'} for contexts over ${tokens(settings.bigTokens)} tokens. Alerts: ${settings.alerts ? 'on' : 'off'}.`)
  lines.push(`Settings: /${names.cache} ttl 5|60|auto, /${names.cache} guard on|off, /${names.cache} big 150k, /${names.cache} alerts on|off.`)
  return lines.join('\n')
}

function parseTokens(text) {
  const m = String(text || '').trim().toLowerCase().match(/^(\d+(?:\.\d+)?)\s*([km]?)$/)
  if (!m) return null
  return Math.round(Number(m[1]) * (m[2] === 'm' ? 1e6 : m[2] === 'k' ? 1e3 : 1))
}

export function register(on) {
  on('session.start', async ($, e, next) => {
    now = await $.clock.now()
    home = (await $.env.get('USERPROFILE')) || (await $.env.get('HOME')) || ''
    S.id = await $.session.id()
    S.cwd = await $.session.cwd()
    S.model = await $.session.model()
    await loadSettings($)
    await readRecording($)
    names.cache = (await registerCommand($, 'cache', 'Cache Keeper status and settings', '[ttl 5|60|auto] [guard on|off] [big 150k] [alerts on|off]')) || names.cache
    names.keepwarm = (await registerCommand($, 'keepwarm', 'Keep this session\'s prompt cache warm (default 4 hours), or /keepwarm off', '[hours|off]', true)) || names.keepwarm
    names.agents = (await registerCommand($, 'ck-agents', 'Agents in this session: status, context, cost', '', true)) || names.agents
    $.clock.every(HEARTBEAT_EVERY, () => tick($).catch(() => {}))
    return next(e)
  })

  // /clear, /resume and /branch start from an unknown cache. The process goes
  // on under a new session id, and no session.start fires for it.
  on('classic.SessionStart', { source: ['clear', 'resume', 'fork'] }, async ($, e, next) => {
    S.lastActivity = 0
    S.keepWarm = false
    try {
      S.id = (await $.session.id()) || S.id
    } catch {
      // keep the old id
    }
    return next(e)
  })

  on('prompt.submit', async ($, e, next) => {
    now = await $.clock.now()
    const ttl = ttlMin()
    const left = msLeft(S.lastActivity, ttl)
    const isCold = left !== null && left <= 0
    const fromUser = e.origin && (e.origin.kind === 'composer' || e.origin.kind === 'bridge')
    if (!settings.guard || !fromUser || !isCold || S.ctx < settings.bigTokens || e.turnId) return next(e)
    const cost = money(rewriteCost(S.ctx, S.model, ttl))
    let answer = 'Send anyway'
    try {
      answer = await $.ui.ask(
        `Cache went cold ${minutes(-left)} ago. Sending now rewrites ${tokens(S.ctx)} tokens of context (about ${cost}). What should happen?`,
        ['Send anyway', 'Compact first, then send', 'Cancel'],
      )
    } catch {
      // nobody to ask (a -p run, or the dialog was dismissed): send as typed
      return next(e)
    }
    if (answer === 'Compact first, then send') {
      try {
        await $.session.compact()
      } catch {
        // compaction refused or failed: send anyway
      }
      return next(e)
    }
    if (answer === 'Send anyway') return next(e)
    $.ui.toast('Not sent. A fresh session with a short handoff avoids the rewrite entirely.', { timeoutMs: 8000 })
    return { drop: 'Cancelled by cache-keeper before a cold cache rewrite' }
  })

  on('turn.start', async ($, e, next) => {
    now = await $.clock.now()
    S.working = true
    if (e.turnId) S.turnId = e.turnId
    return next(e)
  })

  // Each main-loop request: did it read the cache, or rewrite it?
  on('turn.step', async function* ($, e, next) {
    const startedAt = await $.clock.now()
    const result = yield* next(e)
    if (e.agentId && result && result.usage) trackAgent($, e.agentId, result.usage)
    if (e.agentId || !result || !result.usage) return result
    now = await $.clock.now()
    const u = result.usage
    const total = totalInput(u)
    const written = u.cache_creation_input_tokens || 0
    const gap = S.lastActivity ? startedAt - S.lastActivity : 0
    S.model = u.model || S.model
    const afterCompact = justCompacted
    justCompacted = false
    if (afterCompact) {
      // the first request after a compaction writes the new, shorter context: expected
    } else if (S.lastActivity && total > 30000 && written / total > 0.5) {
      // A rewrite after 5-60 idle minutes means this session runs on the 5-minute TTL
      if (!settings.ttlMin && gap > 5.5 * MIN && gap < S.ttlMin * MIN) {
        S.ttlMin = 5
        S.ttlSource = 'measured'
      }
      S.coldRestarts.push({ at: now, tokens: written, usd: rewriteCost(written, S.model, ttlMin()), gapMin: Math.round(gap / MIN) })
    } else if (S.lastActivity && total > 30000 && gap > 5.5 * MIN && cachedShare(u) > 0.8) {
      // A hit after more than 5 idle minutes proves the 1-hour TTL
      if (!settings.ttlMin) {
        S.ttlMin = 60
        S.ttlSource = 'measured'
      }
    }
    S.ctx = total
    S.lastActivity = now
    return result
  })

  on('turn.complete', async ($, e, next) => {
    const r = await next(e)
    if (e.agentId) {
      if (agentsOpen) {
        await refreshAgents($)
        $.ui.invalidate('ui.render')
      }
      return r
    }
    now = await $.clock.now()
    S.working = false
    S.waitingSince = 0
    S.tool = ''
    S.lastTurnEnd = now
    try {
      const usage = await $.session.usage()
      if (usage.context && usage.context.tokens) S.ctx = usage.context.tokens
      if (usage.context && usage.context.window) S.window = usage.context.window
      if (usage.cost) S.costUsd = usage.cost.usd
      if (Array.isArray(usage.rateLimits) && usage.rateLimits.length) S.rateLimits = usage.rateLimits
    } catch {
      // usage unavailable: keep the per-request figures
    }
    $.ui.invalidate('ui.render')
    return r
  })

  on('session.compact', async ($, e, next) => {
    const r = await next(e)
    justCompacted = true
    return r
  })

  on('session.measure', async ($, e, next) => {
    if (e.context && e.context.tokens) S.ctx = e.context.tokens
    if (e.context && e.context.window) S.window = e.context.window
    if (e.cost) S.costUsd = e.cost.usd
    if (Array.isArray(e.rateLimits) && e.rateLimits.length) S.rateLimits = e.rateLimits
    return next(e)
  })

  // Waiting on the person: a permission prompt or a question
  on('tool.check', async ($, e, next) => {
    const d = await next(e)
    if (d && d.decision === 'ask' && !S.waitingSince) {
      now = await $.clock.now()
      S.waitingSince = now
      S.waitingFor = 'permission for ' + e.tool
    }
    return d
  })

  on('tool.call', async ($, e, next) => {
    if (!e.agentId) S.tool = e.tool
    if (e.tool === 'AskUserQuestion') {
      now = await $.clock.now()
      S.waitingSince = now
      S.waitingFor = 'a question'
    }
    try {
      return await next(e)
    } finally {
      if (S.waitingSince) {
        S.waitingSince = 0
        S.waitingFor = ''
      }
    }
  })

  on('command.run', { command: ['cache', 'ck-cache'] }, async ($, e) => {
    now = await $.clock.now()
    const [key, value] = String(e.args || '').trim().toLowerCase().split(/\s+/)
    if (key === 'ttl') {
      settings.ttlMin = value === '5' ? 5 : value === '60' ? 60 : 0
    } else if (key === 'guard' || key === 'alerts') {
      settings[key] = value !== 'off'
    } else if (key === 'big') {
      const n = parseTokens(value)
      if (n) settings.bigTokens = n
    }
    if (key) {
      await $.store.set('settings', settings)
      $.ui.invalidate('ui.render')
    }
    return { text: statusText() }
  })

  on('command.run', { command: ['keepwarm', 'ck-keepwarm'] }, async ($, e) => {
    now = await $.clock.now()
    const arg = String(e.args || '').trim().toLowerCase()
    if (arg === 'off' || (arg === '' && S.keepWarm)) {
      stopKeepWarm($, 'turned off')
    } else {
      const hours = Number(arg) > 0 ? Math.min(24, Number(arg)) : settings.keepWarmHours
      startKeepWarm($, hours)
    }
    $.ui.invalidate('ui.render')
    return {}
  })

  on('command.run', { command: ['agents', 'ck-agents'] }, async ($, e, next) => openAgents($))

  on('ui.close', async ($, e, next) => {
    if (e.id === APANE) agentsOpen = false
    return next(e)
  })

  // The band above the prompt: this session's cache at a glance
  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const below = await next(e)
    if (e.props && e.props.hasSurvey) return below
    const { Box, Text, Button } = $.ui.resolve(e)
    const hb = myHeartbeat()
    const st = cacheState(hb)
    const ttl = ttlMin()
    const big = S.ctx >= settings.bigTokens
    const parts = []
    if (st.kind === 'kept') parts.push(Text({ color: 'cyan', children: [`◆ kept warm · ${S.pings} ping${S.pings === 1 ? '' : 's'} ${money(S.pingUsd)} · until ${clock(S.keepWarmUntil)}`] }))
    else if (st.kind === 'warm') parts.push(Text({ color: 'green', children: [`● cache warm ${minutes(st.left)}`] }))
    else if (st.kind === 'cooling') parts.push(Text({ color: 'yellow', bold: true, children: [`◐ cache cools in ${minutes(st.left)}`] }))
    else if (st.kind === 'cold') parts.push(Text(big ? { color: 'red', bold: true, children: [`○ cache cold ${minutes(-st.left)}`] } : { dimColor: true, children: [`○ cache cold ${minutes(-st.left)}`] }))
    if (st.kind === 'cold' && big) parts.push(Text({ color: 'red', children: [` │ next send rewrites it ≈ ${money(rewriteCost(S.ctx, S.model, ttl))}`] }))
    else if (st.kind !== 'unknown') parts.push(Text({ dimColor: true, children: [` │ rewrite ≈ ${money(rewriteCost(S.ctx, S.model, ttl))}`] }))
    if (S.rateLimits.length) parts.push(Text(limitTone(S.rateLimits, { children: [' │ ' + limitsText(S.rateLimits)] })))
    // A resumed chat has no activity yet: show placeholders, keep the buttons
    if (st.kind === 'unknown') parts.unshift(Text({ dimColor: true, children: ['○ cache unknown until next message'] }))
    parts.push(Text({ dimColor: true, children: [S.costUsd ? ` │ session ${money(S.costUsd)}` : ' │ session –'] }))
    if (S.coldRestarts.length) parts.push(Text({ dimColor: true, children: [` │ ${S.coldRestarts.length} cold restart${S.coldRestarts.length === 1 ? '' : 's'} ${money(S.coldRestarts.reduce((a, c) => a + c.usd, 0))}`] }))
    // Model + context bar lead the row, before the cache state
    const cx = await ctxState($)
    if (cx) {
      const pct = cx.pct == null ? null : Math.round(cx.pct)
      const lead = [Text({ dimColor: true, children: [cx.model] })]
      if (pct != null) {
        const f = Math.max(0, Math.min(10, Math.round(pct / 10)))
        lead.push(Text({ color: pct < 20 ? 'green' : pct < 25 ? 'yellow' : 'red', children: [` [${'#'.repeat(f)}${'-'.repeat(10 - f)}] ${pct}% ctx`] }))
      }
      lead.push(Text({ dimColor: true, children: [' │ '] }))
      parts.unshift(...lead)
    }
    const row = [Box({ flexDirection: 'row', children: parts })]
    if (st.kind === 'cooling' && big) {
      row.push(Button({ key: 'keepwarm', label: 'keep warm', hotkey: '1', plain: true, onPress: async () => { now = await $.clock.now(); startKeepWarm($, settings.keepWarmHours); $.ui.invalidate('ui.render') } }))
    } else if (st.kind === 'kept') {
      row.push(Button({ key: 'keepwarm', label: 'stop warm', hotkey: '1', plain: true, onPress: async () => { now = await $.clock.now(); stopKeepWarm($, 'turned off'); $.ui.invalidate('ui.render') } }))
    }
    const left = Box({ flexDirection: 'row', columnGap: 2, children: row })
    // a opens the agents pane (same as /ck-agents)
    const agentsBtn = Button({ key: 'agents', label: 'agents', hotkey: 'a', plain: true, dimColor: true, onPress: async () => { const r = await openAgents($); if (r && r.text) $.ui.toast(r.text, { timeoutMs: 15000 }) } })
    const right = Box({ flexDirection: 'row', columnGap: 2, children: [agentsBtn] })
    const mine = Box({ flexDirection: 'row', justifyContent: 'space-between', width: '100%', columnGap: 2, children: [left, right] })
    return Box({ flexDirection: 'column', children: below ? [mine, below] : [mine] })
  })

  on('ui.render', { component: 'Pane' }, async ($, e, next) => {
    if (e.requestId === APANE) {
      try {
        return drawAgents($, e)
      } catch (err) {
        const { Text } = $.ui.resolve(e)
        return Text({ color: 'red', children: ['Agents pane failed: ' + String((err && err.message) || err)] })
      }
    }
    return next(e)
  })

  // The band is terminal-only. The footer also draws in the Desktop app, so it
  // carries a short label, only when there's something to act on.
  on('ui.render', { component: 'SessionMode' }, async ($, e, next) => {
    const label = footerLabel()
    if (!label) return next(e)
    const modes = Array.isArray(e.props && e.props.modes) ? e.props.modes : []
    return next({ ...e, props: { ...e.props, modes: [...modes, label] } })
  })
}

function footerLabel() {
  const parts = []
  const st = cacheState(myHeartbeat())
  const big = S.ctx >= settings.bigTokens
  if (st.kind === 'kept') parts.push('cache kept warm')
  else if (st.kind === 'cooling' && big) parts.push(`cache cools in ${minutes(st.left)} · /keepwarm`)
  else if (st.kind === 'cold' && big) parts.push(`cache cold · rewrite ≈ ${money(rewriteCost(S.ctx, S.model, ttlMin()))}`)
  const high = S.rateLimits.filter((l) => (l.percentUsed || 0) >= 80)
  if (high.length) parts.push(limitsText(high))
  return parts.join(' · ')
}



// ---- Agents: the subagents of this session, their status, context and cost.
// Cost and context come from each agent loop's own requests (turn.step carries
// the agent id), so they cover what the agent has run so far.
function trackAgent($, id, u) {
  const model = u.model || S.model
  const a = AG.get(id) || { tokens: 0, costUsd: 0, requests: 0, model: '', lastAt: 0 }
  a.tokens = totalInput(u)
  a.costUsd += requestCost(u, model, ttlMin())
  a.requests += 1
  a.model = model
  a.lastAt = now
  AG.set(id, a)
  if (agentsOpen) $.ui.invalidate('ui.render')
}

async function refreshAgents($) {
  try {
    AGI = await $.agent.list()
  } catch {
    // keep the last list
  }
}

function agentRows() {
  const ids = new Set([...AGI.map((a) => a.id), ...AG.keys()])
  const rank = { running: 0, idle: 1 }
  return [...ids]
    .map((id) => {
      const info = AGI.find((a) => a.id === id) || {}
      const m = AG.get(id) || { tokens: 0, costUsd: 0, requests: 0, model: '' }
      return { id, status: info.status || 'done', title: info.description || info.name || id.slice(0, 8), type: info.type || '', ...m }
    })
    .sort((a, b) => (rank[a.status] ?? 2) - (rank[b.status] ?? 2) || b.costUsd - a.costUsd)
}

function agentCtx(a) {
  const w = S.window || 200000
  return a.tokens ? `${tokens(a.tokens)} (${Math.round((100 * a.tokens) / w)}%)` : '–'
}

function agentsText() {
  const rows = agentRows()
  if (!rows.length) return 'No agents in this session yet.'
  return ['Agents in this session:', ...rows.map((a) => `${pad(a.status, 8)} ${pad(clip(mask(a.title), 36), 37)} ${pad(a.type, 16)} ctx ${pad(agentCtx(a), 12)} ${money(a.costUsd)}`)].join('\n')
}

async function openAgents($) {
  now = await $.clock.now()
  await refreshAgents($)
  const surface = await $.session.surface()
  if (!surface) return { text: agentsText() }
  agentsOpen = true
  await $.ui.open({ id: APANE, title: 'Agents', focus: true, closeOnEscape: true })
  return {}
}

function drawAgents($, e) {
  const { Box, Text, Button } = $.ui.resolve(e)
  const vs = e.surface === 'vscode'
  const rows = agentRows()
  const running = rows.filter((a) => a.status === 'running').length
  const total = rows.reduce((t, a) => t + a.costUsd, 0)
  const head = Box({
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    children: [
      Text({ dimColor: true, children: [`${rows.length} agent${rows.length === 1 ? '' : 's'} · ${running} running · ${money(total)} total · context vs ${tokens(S.window || 200000)} window`] }),
      Button({ key: 'ag-refresh', label: 'Refresh', ...(vs ? {} : { plain: true, dimColor: true }), onPress: async () => { await refreshAgents($); $.ui.invalidate('ui.render') } }),
    ],
  })
  if (!rows.length) return Box({ flexDirection: 'column', rowGap: 1, children: [head, Text({ dimColor: true, children: ['No agents in this session yet. They show up here when Claude starts one.'] })] })
  const cards = rows.map((a) => {
    const pct = a.tokens ? Math.round((100 * a.tokens) / (S.window || 200000)) : 0
    const f = Math.max(0, Math.min(10, Math.round(pct / 10)))
    const dot = a.status === 'running' ? ['● running', 'cyan'] : a.status === 'idle' ? ['○ idle', undefined] : ['✓ done', 'green']
    const ctxColor = pct < 50 ? 'green' : pct < 75 ? 'yellow' : 'red'
    const line1 = Box({ flexDirection: 'row', columnGap: 2, children: [Text({ bold: true, children: [clip(mask(a.title), 48)] }), Text({ color: dot[1], dimColor: !dot[1], children: [dot[0]] }), ...(a.type ? [Text({ dimColor: true, children: [a.type] })] : [])] })
    const line2 = Box({
      flexDirection: 'row',
      columnGap: 2,
      children: [
        Text({ color: a.tokens ? ctxColor : undefined, dimColor: !a.tokens, children: [`ctx [${'#'.repeat(f)}${'-'.repeat(10 - f)}] ${agentCtx(a)}`] }),
        Text({ children: [money(a.costUsd)] }),
        Text({ dimColor: true, children: [`${a.requests} request${a.requests === 1 ? '' : 's'}${a.model ? ' · ' + a.model : ''}`] }),
      ],
    })
    const props = { key: 'agent-' + a.id, flexDirection: 'column', children: [line1, line2] }
    return Box(vs ? { ...props, borderStyle: 'round', borderColor: 'gray', paddingX: 1 } : props)
  })
  return Box({ flexDirection: 'column', rowGap: 1, children: [head, ...cards] })
}
