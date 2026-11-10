// Cache Keeper: watches this session's prompt cache, keeps big caches warm on
// request, refuses a cold send without asking first, and shows every local
// session on one board (/board).
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
const PANE = 'cache-board'
const APANE = 'agents-pane'

// This session
const S = {
  id: '',
  cwd: '',
  label: '',
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
const names = { cache: 'cache', keepwarm: 'keepwarm', board: 'board', handoff: 'handoff', vault: 'vault', agents: 'agents' }

let now = 0
let home = ''
let lastHeartbeat = 0
let rec = { on: false, strict: false }
let mask = (s) => s
let fleet = [] // heartbeats of every session, this one included
const alerted = new Map() // sessionId -> state or warning key already announced
let paneOpen = false
let agentsOpen = false
const AG = new Map() // agentId -> { tokens, costUsd, requests, model, lastAt }
let AGI = [] // $.agent.list()
let justCompacted = false
let handoffPending = false

// The handoff flow. When /session-handoff runs (the band's button, /handoff, a
// typed command, or Claude calling the skill), the answer of the turn it starts
// is captured and saved to a file. "clear and continue" then runs /clear and
// sends the handoff as the fresh chat's first prompt.
const HANDOFF_SKILL = /(^|:)session-handoff$/
const H = {
  armed: false,
  notTurn: '', // a turn already running when the handoff was queued: not the handoff's
  askAfter: false, // /handoff asks "clear and continue?" once the handoff is in
  text: '',
  path: '',
  continuing: false,
  auto: false, // one-click: clear and continue as soon as the handoff is captured
}

function armHandoff(insideTurn) {
  H.armed = true
  H.notTurn = insideTurn ? '' : S.working ? S.turnId : ''
}

// The handoff without any preamble Claude put before its heading
function handoffBody(answer) {
  const text = String(answer || '').trim()
  const i = text.indexOf('# Session Handoff')
  return i > 0 ? text.slice(i) : text
}

function fileStamp(ms) {
  const d = new Date(ms)
  const two = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${two(d.getMonth() + 1)}-${two(d.getDate())}-${two(d.getHours())}${two(d.getMinutes())}`
}

async function saveHandoff($, text) {
  const project = basename(S.cwd).replace(/[^A-Za-z0-9-]+/g, '-') || 'session'
  const path = `${home || '.'}/.claude/mods-data/cache-keeper/handoffs/${fileStamp(now)}-${project}-${S.id.slice(0, 8)}.md`.replace(/\\/g, '/')
  await $.fs.write(path, text + '\n')
  return path
}

async function captureHandoff($, e) {
  H.armed = false
  H.notTurn = ''
  const askAfter = H.askAfter
  const auto = H.auto
  H.askAfter = false
  H.auto = false
  const body = e.reason === 'answer' ? handoffBody(e.answer) : ''
  if (body.length < 200) {
    $.ui.toast('The handoff turn ended without a handoff, so nothing was saved.', { timeoutMs: 8000 })
    return
  }
  H.text = body
  try {
    H.path = await saveHandoff($, body)
  } catch {
    H.path = ''
  }
  const saved = H.path ? `Handoff saved to ${H.path}.` : 'Handoff captured (the backup file could not be written).'
  $.ui.toast(auto ? `${saved} Clearing and continuing.` : `${saved} Press c on the band or type /${names.handoff} continue to clear and continue.`, { timeoutMs: 15000 })
  // Off the hook: the turn is ending, and a dialog or /clear would hold it open
  if (auto) $.clock.after(500, () => autoContinue($, 0).catch(() => {}))
  else if (askAfter) $.clock.after(300, () => offerContinue($).catch(() => {}))
}

// One-click path: wait for the handoff turn to finish (up to ~10s), then clear and continue
async function autoContinue($, tries) {
  if (!H.text) return
  if (S.working && tries < 20) {
    $.clock.after(500, () => autoContinue($, tries + 1).catch(() => {}))
    return
  }
  await clearAndContinue($)
}

async function offerContinue($) {
  if (!H.text) return
  let answer = ''
  try {
    answer = await $.ui.ask('Handoff saved. Clear this chat and continue with it in a fresh context?', ['Clear and continue', 'Keep this chat'])
  } catch {
    return // dismissed: the band button and /handoff continue still work
  }
  if (answer === 'Clear and continue') await clearAndContinue($)
}

function continuationPrompt() {
  const where = H.path ? ` (saved at ${H.path})` : ''
  return `Handoff from my previous session${where}:\n\n${H.text}`
}

async function clearAndContinue($) {
  if (H.continuing) return
  if (!H.text) {
    $.ui.toast(`No handoff ready. Press h on the band or type /${names.handoff} first.`, { timeoutMs: 8000 })
    return
  }
  if (S.working) {
    $.ui.toast('Claude is still working. Clear and continue once this turn ends.', { timeoutMs: 8000 })
    return
  }
  const text = continuationPrompt()
  const path = H.path
  H.continuing = true
  $.ui.invalidate('ui.render')
  try {
    await $.command.run({ command: 'clear', args: '' })
  } catch (err) {
    H.continuing = false
    $.ui.invalidate('ui.render')
    $.ui.toast('Could not run /clear: ' + clip(String((err && err.message) || err), 100) + (path ? ` The handoff is saved at ${path}.` : ''), { timeoutMs: 10000 })
    return
  }
  H.text = ''
  H.path = ''
  try {
    await $.prompt.submit({ text, asUser: true })
  } catch {
    // Not sent: leave it in the prompt box for one Enter
    let filled = false
    try {
      filled = !!(await $.prompt.fill({ text })).isFilled
    } catch {
      filled = false
    }
    $.ui.toast(filled ? 'Cleared. The handoff is in the prompt box: press Enter to send it.' : `Cleared, but the handoff could not be sent.${path ? ` It's saved at ${path}.` : ''}`, { timeoutMs: 10000 })
  } finally {
    H.continuing = false
    $.ui.invalidate('ui.render')
  }
}

// Runs the /session-handoff skill as if you typed it. The engine queues it
// until Claude finishes the current turn.
async function runHandoff($) {
  if (handoffPending) {
    $.ui.toast('Session handoff is already queued.')
    return
  }
  try {
    const commands = await $.command.list()
    const cmd = commands.find((c) => c.name === 'session-handoff') || commands.find((c) => HANDOFF_SKILL.test(c.name))
    if (!cmd) {
      H.askAfter = false
      H.auto = false
      $.ui.toast('No /session-handoff skill in this session.', { timeoutMs: 8000 })
      return
    }
    handoffPending = true
    armHandoff(false)
    H.auto = true
    $.ui.invalidate('ui.render')
    $.ui.toast(S.working ? 'Session handoff queued: it runs when Claude finishes this turn.' : 'Running /session-handoff.')
    await $.command.run({ command: cmd.name, args: '' })
  } catch (err) {
    H.armed = false
    H.askAfter = false
    H.auto = false
    $.ui.toast('Could not start /session-handoff: ' + clip(String((err && err.message) || err), 100), { timeoutMs: 8000 })
  } finally {
    handoffPending = false
    $.ui.invalidate('ui.render')
  }
}

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
    label: S.label,
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

async function heartbeat($, force) {
  if (!S.id) return
  if (!force && now - lastHeartbeat < 5000) return
  lastHeartbeat = now
  try {
    const agents = await $.agent.list()
    S.agentsRunning = agents.filter((a) => a.status === 'running').length
  } catch {
    // agent list unavailable: keep the last count
  }
  await $.store.set('hb:' + S.id, myHeartbeat())
}

async function readFleet($) {
  const keys = (await $.store.keys()).filter((k) => k.startsWith('hb:'))
  const list = []
  for (const k of keys) {
    const hb = await $.store.get(k)
    if (!hb || typeof hb !== 'object') continue
    if (hb.id === S.id) continue
    // a session that stopped heartbeating an hour ago has ended or crashed
    if (now - (hb.updatedAt || 0) > 60 * MIN) {
      await $.store.delete(k)
      continue
    }
    list.push({ ...hb, stale: now - (hb.updatedAt || 0) > 3 * MIN })
  }
  list.push({ ...myHeartbeat(), self: true })
  fleet = list
}

// Commands another session's board sent this one, through the shared store
async function applyRemoteCommands($) {
  const c = await $.store.get('cmd:' + S.id)
  if (!c) return
  await $.store.delete('cmd:' + S.id)
  if (c.keepWarm === true) startKeepWarm($, settings.keepWarmHours)
  if (c.keepWarm === false) stopKeepWarm($, 'stopped from the board')
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
  for (const hb of fleet) {
    if (hb.stale || hb.keepWarm || (hb.ctx || 0) < settings.bigTokens) continue
    const st = cacheState(hb)
    if (st.kind !== 'cooling') continue
    const key = 'cool:' + hb.lastActivity
    if (alerted.get(hb.id) === key) continue
    alerted.set(hb.id, key)
    const cost = money(rewriteCost(hb.ctx, hb.model, hb.ttlMin))
    const who = hb.self ? 'This session' : `"${mask(hb.label)}"`
    const how = hb.self ? `type /${names.keepwarm} or press 1` : `open /${names.board} to keep it warm`
    $.ui.toast(`${who}: ${tokens(hb.ctx)}-token cache goes cold in ${minutes(st.left)}. Rewriting it costs about ${cost}. ${how}.`, { timeoutMs: 15000 })
  }
  // Another session started waiting on a permission or a question
  for (const hb of fleet) {
    if (hb.self || hb.stale) continue
    const prev = alerted.get('state:' + hb.id)
    alerted.set('state:' + hb.id, hb.state)
    if (hb.state === 'waiting' && prev && prev !== 'waiting') {
      $.ui.toast(`"${mask(hb.label)}" is waiting on you${hb.waitingFor ? ': ' + hb.waitingFor : ''}`, { timeoutMs: 10000 })
    }
  }
}

async function tick($) {
  now = await $.clock.now()
  await readRecording($)
  await applyRemoteCommands($)
  await keepWarmStep($)
  await heartbeat($, true)
  await readFleet($)
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
  lines.push(`Settings: /${names.cache} ttl 5|60|auto, /${names.cache} guard on|off, /${names.cache} big 150k, /${names.cache} alerts on|off. Board: /${names.board}.`)
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
    S.label = basename(S.cwd)
    S.model = await $.session.model()
    await loadSettings($)
    await readRecording($)
    names.cache = (await registerCommand($, 'cache', 'Cache Keeper status and settings', '[ttl 5|60|auto] [guard on|off] [big 150k] [alerts on|off]')) || names.cache
    names.keepwarm = (await registerCommand($, 'keepwarm', 'Keep this session\'s prompt cache warm (default 4 hours), or /keepwarm off', '[hours|off]', true)) || names.keepwarm
    names.board = (await registerCommand($, 'board', 'Every local Claude Code session: state, context, cache, cost', '', true)) || names.board
    names.handoff = (await registerCommand($, 'handoff', 'Session handoff, then clear this chat and continue with it (/handoff continue)', '[continue]')) || names.handoff
    names.agents = (await registerCommand($, 'ck-agents', 'Agents in this session: status, context, cost', '', true)) || names.agents
    names.vault = (await registerCommand($, 'vault', 'Pick a Vault: switch the CLI to it, or log in to it', '', true)) || names.vault
    vaultStatus($).then(() => $.ui.invalidate('ui.render')).catch(() => {})
    $.clock.every(60000, () => vaultStatus($).then(() => $.ui.invalidate('ui.render')).catch(() => {}))
    $.clock.every(HEARTBEAT_EVERY, () => tick($).catch(() => {}))
    // loading dots for the Vault picker: 0, 1, 2, 3 dots, again
    $.clock.every(450, () => {
      if (!V.busy) return
      V.dots = (V.dots + 1) % 4
      $.ui.invalidate('ui.render')
    })
    await heartbeat($, true)
    return next(e)
  })

  // /clear, /resume and /branch start from an unknown cache. The process goes
  // on under a new session id, and no session.start fires for it.
  on('classic.SessionStart', { source: ['clear', 'resume', 'fork'] }, async ($, e, next) => {
    S.lastActivity = 0
    S.keepWarm = false
    H.armed = false
    try {
      S.id = (await $.session.id()) || S.id
    } catch {
      // keep the old id
    }
    S.label = basename(S.cwd)
    return next(e)
  })

  on('session.end', async ($, e, next) => {
    if (S.id) await $.store.delete('hb:' + S.id)
    return next(e)
  })

  // The first prompt names the session on the board
  on('prompt.submit', async ($, e, next) => {
    now = await $.clock.now()
    if (S.label === basename(S.cwd) && e.origin && e.origin.kind === 'composer' && e.text) {
      S.label = basename(S.cwd) + ' · ' + clip(e.text, 40)
    }
    // A new message in this chat makes a waiting handoff out of date (its file stays)
    if (H.text && !H.continuing && e.origin && e.origin.kind === 'composer' && !String(e.text || '').trim().startsWith('/')) {
      H.text = ''
      H.path = ''
      $.ui.invalidate('ui.render')
    }
    const typed = e.origin && e.origin.kind === 'composer' && !String(e.text || '').trim().startsWith('/')
    const note = typed ? await vaultNote($).catch(() => '') : ''
    if (note) e = { ...e, context: [...(e.context ?? []), note] }
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
    await heartbeat($, true)
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
    if (H.armed && e.turnId !== H.notTurn) await captureHandoff($, e)
    await heartbeat($, true)
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
    // Claude calling the handoff skill itself: this turn's answer is the handoff
    if (!e.agentId && e.tool === 'Skill' && HANDOFF_SKILL.test(String(e.skill || ''))) armHandoff(true)
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

  // /session-handoff from anywhere (typed, the band, /handoff): watch for its answer
  on('command.run', async ($, e, next) => {
    if (HANDOFF_SKILL.test(String(e.command || ''))) armHandoff(false)
    return next(e)
  })

  // /handoff runs the handoff and then asks to clear and continue (the band's
  // buttons draw only in the terminal); /handoff continue does the second half.
  // Both run off the hook: a command started inside a hook the session is
  // waiting on is refused.
  on('command.run', { command: ['handoff', 'ck-handoff'] }, async ($, e) => {
    now = await $.clock.now()
    const arg = String(e.args || '').trim().toLowerCase()
    if (arg === 'continue' || arg === 'go') {
      if (!H.text) return { text: `No handoff ready yet. Type /${names.handoff} to make one.` }
      $.clock.after(50, () => clearAndContinue($).catch(() => {}))
      return { text: 'Clearing this chat and continuing with the handoff.' }
    }
    H.askAfter = true
    $.clock.after(50, () => runHandoff($).catch(() => {}))
    return { text: 'Running the session handoff. When it finishes, you can clear this chat and continue with it.' }
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
    await heartbeat($, true)
    $.ui.invalidate('ui.render')
    return {}
  })

  on('command.run', { command: ['board', 'ck-board'] }, async ($, e) => openBoard($))

  on('command.run', { command: ['agents', 'ck-agents'] }, async ($, e, next) => openAgents($))

  on('command.run', { command: ['vault', 'ck-vault'] }, async ($, e) => {
    const text = await openVaultPicker($)
    return text ? { text } : {}
  })

  on('ui.close', async ($, e, next) => {
    if (e.id === VPANE) V.open = false
    if (e.id === PANE) paneOpen = false
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
      row.push(Button({ key: 'keepwarm', label: 'keep warm', hotkey: '1', plain: true, onPress: async () => { now = await $.clock.now(); startKeepWarm($, settings.keepWarmHours); await heartbeat($, true); $.ui.invalidate('ui.render') } }))
    } else if (st.kind === 'kept') {
      row.push(Button({ key: 'keepwarm', label: 'stop warm', hotkey: '1', plain: true, onPress: async () => { now = await $.clock.now(); stopKeepWarm($, 'turned off'); await heartbeat($, true); $.ui.invalidate('ui.render') } }))
    }
    const left = Box({ flexDirection: 'row', columnGap: 2, children: row })
    // Right edge: one click runs /session-handoff (h while the band has the focus;
    // a letter never fires from the prompt box, unlike a digit). Once a handoff
    // is in, c clears this chat and sends it as the fresh chat's first prompt.
    const busy = handoffPending || H.armed
    const handoff = Button({ key: 'handoff', label: handoffPending ? 'handoff queued' : H.armed ? 'handoff running' : 'handoff', hotkey: 'h', plain: true, dimColor: busy, onPress: () => runHandoff($) })
    // v opens the Vault picker; it reads "vault login" when the CLI has no valid session
    const vaultBtn = Button({ key: 'vault', label: V.valid ? 'vault' : 'vault login', hotkey: 'v', plain: true, dimColor: V.valid, onPress: async () => { const t = await openVaultPicker($); if (t) $.ui.toast(t, { timeoutMs: 15000 }) } })
    // a opens the agents pane (same as /ck-agents)
    const boardBtn = Button({ key: 'agents', label: 'agents', hotkey: 'a', plain: true, dimColor: true, onPress: async () => { const r = await openAgents($); if (r && r.text) $.ui.toast(r.text, { timeoutMs: 15000 }) } })
    let right = Box({ flexDirection: 'row', columnGap: 2, children: [boardBtn, vaultBtn, handoff] })
    if (H.text || H.continuing) {
      const go = Button({ key: 'continue', label: H.continuing ? 'clearing' : 'clear and continue', hotkey: 'c', plain: true, onPress: () => clearAndContinue($) })
      right = Box({ flexDirection: 'row', columnGap: 2, children: [go, boardBtn, vaultBtn, handoff] })
    }
    const mine = Box({ flexDirection: 'row', justifyContent: 'space-between', width: '100%', columnGap: 2, children: [left, right] })
    return Box({ flexDirection: 'column', children: below ? [mine, below] : [mine] })
  })

  on('ui.render', { component: 'Pane' }, async ($, e, next) => {
    if (e.requestId === VPANE) return drawVaultPicker($, e)
    if (e.requestId === APANE) {
      try {
        return drawAgents($, e)
      } catch (err) {
        const { Text } = $.ui.resolve(e)
        return Text({ color: 'red', children: ['Agents pane failed: ' + String((err && err.message) || err)] })
      }
    }
    if (e.requestId !== PANE) return next(e)
    return drawBoard($, e)
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

// ---- Vault picker: click a Vault to switch to it, or to log in to it when the
// session is gone. The list is `vault list` (every Vault this login reaches);
// without a session it falls back to the names cached by hooks/vault-track.py.
const VPANE = 'vault-picker'
const V = { list: [], current: '', valid: true, confirm: '', busy: '', msg: '', used: [], open: false, filter: '', refreshing: false, pending: '', dots: 0 }
// Same heuristic as the status line: anything not provably a sandbox counts as production.
const SANDBOX_RE = /^sb-|sandbox|uat|sbx|template|demo|test|rebuild|-dev[.-]|sit-20/
const isSandbox = (v) => SANDBOX_RE.test((v.dns + ' ' + v.name).toLowerCase())
const shortName = (n) => String(n || '').replace(/ \([^)]*\)$/, '')
const vdir = () => home + '/.claude/vault-sessions'

async function vrun($, args, timeoutMs = 20000) {
  try {
    return await $.process.run(['vault', ...args], { timeoutMs })
  } catch (err) {
    return { exitCode: 1, stdout: '', stderr: String((err && err.message) || err) }
  }
}

async function readJson($, path, fallback) {
  try {
    return JSON.parse(await $.fs.read(path))
  } catch {
    return fallback
  }
}

async function vaultStatus($) {
  const st = await vrun($, ['status'])
  const out = st.stdout || ''
  V.valid = st.exitCode === 0 && /^Auth:.*valid/im.test(out) && !/expired|invalid/i.test(out)
  const m = /^DNS:\s*(\S+)/m.exec(out)
  V.current = m ? m[1].toLowerCase() : ''
}

async function vaultRefresh($) {
  // status and list each take ~2s: run them side by side
  const [, listRun] = await Promise.all([vaultStatus($), vrun($, ['list', '--format', 'json'])])
  const names = await readJson($, vdir() + '/names.json', {})
  let list = []
  if (V.valid) {
    const r = listRun
    try {
      list = JSON.parse(r.stdout).map((x) => ({ dns: String(x.dns).toLowerCase(), name: x.name }))
      for (const v of list) names[v.dns] = v.name
      try {
        await $.fs.write(vdir() + '/names.json', JSON.stringify(names))
      } catch {
        // cache is optional
      }
    } catch {
      list = []
    }
  }
  if (!list.length) list = Object.entries(names).map(([dns, name]) => ({ dns, name }))
  const used = await readJson($, vdir() + '/' + S.id + '.json', [])
  V.used = used.map((u) => u.dns)
  // this chat's Vaults first, then the rest by name
  V.list = list.sort((a, b) => (V.used.includes(b.dns) ? 1 : 0) - (V.used.includes(a.dns) ? 1 : 0) || String(a.name).localeCompare(String(b.name)))
}

async function recordUsed($, v) {
  const path = vdir() + '/' + S.id + '.json'
  const used = (await readJson($, path, [])).filter((u) => u.dns !== v.dns)
  used.push({ dns: v.dns, name: v.name, ts: Math.round(now / 1000), cli: true })
  try {
    await $.fs.write(path, JSON.stringify(used.slice(-6)))
  } catch {
    // the hook records it on the next vault command anyway
  }
}

async function pickVault($, v) {
  // Production needs a second press
  if (!isSandbox(v) && V.confirm !== v.dns) {
    V.confirm = v.dns
    V.msg = ''
    $.ui.invalidate('ui.render')
    return
  }
  V.confirm = ''
  V.busy = shortName(v.name)
  V.dots = 0
  V.msg = V.valid ? `Switching to ${V.busy}` : `Logging in to ${V.busy}: finish in the browser`
  $.ui.invalidate('ui.render')
  const r = V.valid ? await vrun($, ['switch', '--dns', v.dns, '-y']) : await vrun($, ['login', '--dns', v.dns, '-y'], 180000)
  now = await $.clock.now()
  V.busy = ''
  if (r.exitCode === 0) {
    await vaultRefresh($)
    if (V.current === v.dns) await recordUsed($, v)
    V.msg = V.current === v.dns ? `Now on ${shortName(v.name)}.` : `Command finished but the CLI is on ${shortName(V.list.find((x) => x.dns === V.current)?.name || V.current)}.`
    await vaultRefresh($)
  } else {
    V.msg = 'Failed: ' + clip(String(r.stderr || r.stdout || 'no output').trim().split('\n')[0], 120)
  }
  $.ui.invalidate('ui.render')
}

async function loginPlain($) {
  // No Vault named: the CLI's own picker opens in the browser (first login ever)
  V.busy = 'login'
  V.dots = 0
  V.msg = 'Logging in: finish in the browser'
  $.ui.invalidate('ui.render')
  const r = await vrun($, ['login', '-y'], 180000)
  now = await $.clock.now()
  V.busy = ''
  if (r.exitCode === 0) await vaultRefresh($)
  V.msg = r.exitCode === 0 ? 'Logged in.' : 'Failed: ' + clip(String(r.stderr || r.stdout || 'no output').trim().split('\n')[0], 120)
  $.ui.invalidate('ui.render')
}

// The Sessions board: the /board command and the band's board button.
async function openBoard($) {
  now = await $.clock.now()
  await heartbeat($, true)
  await readFleet($)
  const surface = await $.session.surface()
  if (!surface) return { text: boardText() }
  paneOpen = true
  await $.ui.open({ id: PANE, title: 'Sessions', focus: true, closeOnEscape: true })
  return {}
}

async function openVaultPicker($) {
  now = await $.clock.now()
  const surface = await $.session.surface()
  if (surface === 'vscode') {
    V.confirm = ''
    V.msg = ''
    V.filter = ''
    V.open = true
    V.refreshing = true
    await $.ui.open({ id: VPANE, title: 'Vaults', focus: true, closeOnEscape: true })
    $.clock.after(20, () => vaultRefresh($).then(() => autoActivateCurrent($)).catch(() => {}).then(() => { V.refreshing = false; $.ui.invalidate('ui.render') }))
    return ''
  }
  await vaultRefresh($)
  if (!surface) {
    return V.list.map((v) => `${v.dns === V.current ? '▸' : ' '} ${isSandbox(v) ? '  ' : '⚠ '}${shortName(v.name)}  ${v.dns}`).join('\n') || 'No Vaults known. Run: vault login'
  }
  V.confirm = ''
  V.msg = ''
  V.filter = ''
  V.open = true
  await $.ui.open({ id: VPANE, title: 'Vaults', focus: true, closeOnEscape: true })
  return ''
}

function drawVaultPicker($, e) {
  const { Box, Text, Button, Input } = $.ui.resolve(e)
  const head = V.refreshing && e.surface === 'vscode'
    ? Text({ dimColor: true, children: ['Checking Vault status…'] })
    : V.valid
    ? Text({ dimColor: true, children: [e.surface === 'vscode' ? 'Signed in. Activate every Vault you are working in. Claude switches the CLI between them itself. ⚠ production asks twice.' : 'Signed in. Click a Vault to switch the CLI to it. ⚠ production asks twice.'] })
    : Text({ color: 'red', children: ['Not signed in. Click a Vault to log in to it (opens your browser).'] })
  const vs = e.surface === 'vscode'
  const q = V.filter.trim().toLowerCase()
  const shown = q ? V.list.filter((v) => (v.name + ' ' + v.dns).toLowerCase().includes(q)) : V.list
  const rows = shown.map((v) => {
    const sb = isSandbox(v)
    const confirm = V.confirm === v.dns
    const label = '  ' + (confirm ? 'press again to confirm: ' : '') + shortName(v.name)
    // Vaults used in this chat are coloured (green sandbox, yellow production); the CLI's current one is also bold. The tag stays dim.
    const used = V.used.includes(v.dns)
    const rest = `  ${sb ? 'sandbox' : '⚠ production'}${used ? '  · used in this chat' : ''}`
    const col = sb ? 'green' : 'yellow'
    const tone = !V.valid ? {} : used ? { color: col } : {}
    if (vs) return vscodeVaultRow($, { Box, Text, Button }, v, { sb, used, confirm, col })
    const props = { key: 'v-' + v.dns, label: label + rest, children: [Text({ ...tone, children: [label] }), Text({ dimColor: true, children: [rest] })], plain: true, dimColor: !!V.busy, onPress: () => (V.busy ? undefined : pickVault($, v)) }
    return Button(props)
  })
  const empty = V.refreshing ? 'Loading Vaults…' : q ? `No Vault matches "${V.filter.trim()}".` : 'No Vaults known yet. Use "log in" below.'
  const children = [head]
  children.push(Input({ key: 'v-search', placeholder: 'Search Vaults…', value: V.filter, submitLabel: 'search', onInput: (val) => { V.filter = val; V.confirm = ''; $.ui.invalidate('ui.render') }, onSubmit: () => {} }))
  children.push(Box({ flexDirection: 'column', children: rows.length ? rows : [Text({ dimColor: true, children: [empty] })] }))
  // On VS Code the login button only shows while signed out
  if (!(vs && V.valid)) children.push(Button({ key: 'v-login', label: V.valid ? 'log in again (browser)' : 'log in (browser picks the Vault)', plain: true, dimColor: !!V.busy, onPress: () => (V.busy ? undefined : loginPlain($)) }))
  if (V.msg) children.push(Text({ color: V.msg.startsWith('Failed') ? 'red' : undefined, dimColor: !V.msg.startsWith('Failed'), children: [V.msg + (V.busy ? '.'.repeat(V.dots) : '')] }))
  return Box({ flexDirection: 'column', rowGap: 1, children })
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
  if (H.text) parts.push(`handoff ready · /${names.handoff} continue`)
  return parts.join(' · ')
}

function sortFleet(list) {
  const rank = { waiting: 0, working: 1, idle: 2 }
  return [...list].sort((a, b) => {
    const r = (rank[a.state] ?? 3) - (rank[b.state] ?? 3)
    if (r !== 0) return r
    const la = msLeft(a.lastActivity, a.ttlMin) ?? Infinity
    const lb = msLeft(b.lastActivity, b.ttlMin) ?? Infinity
    return la - lb
  })
}

function cacheCell(hb) {
  const st = cacheState(hb)
  if (st.kind === 'kept') return ['kept warm', 'cyan']
  if (st.kind === 'warm') return ['warm ' + minutes(st.left), 'green']
  if (st.kind === 'cooling') return ['cools in ' + minutes(st.left), 'yellow']
  if (st.kind === 'cold') return ['cold ' + minutes(-st.left), (hb.ctx || 0) >= settings.bigTokens ? 'red' : 'gray']
  return ['–', 'gray']
}

function stateCell(hb) {
  if (hb.stale) return ['? silent', 'gray']
  if (hb.state === 'waiting') return ['⏳ waiting', 'magenta']
  if (hb.state === 'working') return ['● working', 'cyan']
  return ['○ idle', 'gray']
}

// Text props for a colour name; 'gray' draws dim, which every theme has
function tone(color, extra = {}) {
  return color === 'gray' ? { ...extra, dimColor: true } : { ...extra, color }
}

function boardText() {
  const rows = sortFleet(fleet).map((hb) => {
    const [state] = stateCell(hb)
    const [cache] = cacheCell(hb)
    return `${pad(state, 11)} ${pad(clip(mask(hb.label), 40), 41)} ${pad(tokens(hb.ctx), 6)} ${pad(cache, 13)} ${money(hb.costUsd)}${hb.agentsRunning ? '  ' + hb.agentsRunning + ' agents' : ''}${hb.self ? '  (this one)' : ''}`
  })
  return ['Sessions on this machine:', ...rows].join('\n')
}

function drawBoard($, e) {
  const { Box, Text, Button } = $.ui.resolve(e)
  const width = Math.max(60, (e.props && e.props.bodyColumns) || 100)
  const labelWidth = Math.max(16, Math.min(44, width - 62))
  const list = sortFleet(fleet)
  const header = Text({ dimColor: true, children: [`${pad('STATE', 11)} ${pad('SESSION', labelWidth + 1)} ${pad('CONTEXT', 8)} ${pad('CACHE', 14)} ${pad('COST', 7)} AGENTS`] })
  const rows = list.map((hb, i) => {
    const [state, stateColor] = stateCell(hb)
    const [cache, cacheColor] = cacheCell(hb)
    const label = clip(mask(hb.label || hb.id), labelWidth) + (hb.self ? ' ◂' : '')
    const ctx = tokens(hb.ctx) + (hb.window ? ' ' + Math.round((100 * (hb.ctx || 0)) / hb.window) + '%' : '')
    const cells = [
      Text(tone(stateColor, { children: [pad(state, 11) + ' '] })),
      Text({ bold: !!hb.self, children: [pad(label, labelWidth + 1) + ' '] }),
      Text({ children: [pad(ctx, 8) + ' '] }),
      Text(tone(cacheColor, { children: [pad(cache, 14) + ' '] })),
      Text({ children: [pad(money(hb.costUsd), 7) + ' '] }),
      Text({ dimColor: !hb.agentsRunning, children: [String(hb.agentsRunning || 0) + '  '] }),
    ]
    const big = (hb.ctx || 0) >= settings.bigTokens
    if (big && !hb.stale && i < 9) {
      cells.push(
        Button({
          key: 'kw-' + hb.id,
          label: hb.keepWarm ? 'stop warm' : 'keep warm',
          hotkey: String(i + 1),
          plain: true,
          dimColor: !hb.keepWarm && cacheState(hb).kind !== 'cooling',
          onPress: async () => {
            now = await $.clock.now()
            if (hb.self) {
              if (S.keepWarm) stopKeepWarm($, 'turned off')
              else startKeepWarm($, settings.keepWarmHours)
              await heartbeat($, true)
            } else {
              await $.store.set('cmd:' + hb.id, { keepWarm: !hb.keepWarm, at: now })
              $.ui.toast(`Sent to "${mask(hb.label)}". It applies within 30 seconds.`)
            }
            await readFleet($)
            $.ui.invalidate('ui.render')
          },
        }),
      )
    }
    const line = Box({ flexDirection: 'row', children: cells })
    const detail = []
    if (hb.state === 'waiting' && hb.waitingFor) detail.push(`needs you: ${hb.waitingFor}`)
    else if (hb.state === 'working' && hb.tool) detail.push(`running ${hb.tool}`)
    if (hb.coldCount) detail.push(`${hb.coldCount} cold restart${hb.coldCount === 1 ? '' : 's'} ${money(hb.coldUsd)}`)
    if (hb.keepWarm) detail.push(`warm until ${clock(hb.keepWarmUntil)}, ${hb.pings} ping(s) ${money(hb.pingUsd)}`)
    if (detail.length === 0) return line
    return Box({ flexDirection: 'column', children: [line, Text({ dimColor: true, children: ['            └ ' + detail.join(' · ')] })] })
  })
  const totalCost = list.reduce((a, hb) => a + (hb.costUsd || 0), 0)
  const totalCold = list.reduce((a, hb) => a + (hb.coldUsd || 0), 0)
  const waiting = list.filter((hb) => hb.state === 'waiting').length
  const footer = Text({
    dimColor: true,
    children: [`${list.length} session${list.length === 1 ? '' : 's'} · ${money(totalCost)} total · ${waiting} waiting on you · cold restarts ${money(totalCold)} · keep warm reads the cache before it expires · Esc closes`],
  })
  return Box({ flexDirection: 'column', children: [header, ...rows, Text({ children: [' '] }), footer] })
}

// ---- VS Code layout for the Vault picker: one card per Vault (name and badges
// left, a single native button right) instead of a column of full-width chips.
function vscodeVaultRow($, el, v, { sb, used, confirm, col }) {
  const { Box, Text, Button } = el
  const cur = v.dns === V.current && V.valid
  const on = V.valid && used
  const pending = V.pending === v.dns
  const name = Text({ bold: on, color: on ? col : undefined, children: [shortName(v.name)] })
  const badges = [Text({ color: sb ? 'green' : 'yellow', dimColor: !V.valid, children: [sb ? 'sandbox' : '⚠ production'] })]
  if (on) badges.push(Text({ color: 'green', children: ['● active'] }))
  if (cur) badges.push(Text({ dimColor: true, children: ['CLI here'] }))
  const busy = () => !!V.busy || !!V.pending
  const btn = (key, label, onPress, variant) => Button({ key: key + v.dns, label: pending ? (on ? 'Deactivating…' : 'Activating…') : label, variant, dimColor: busy(), onPress: () => (busy() ? undefined : onPress()) })
  const actions = []
  if (!V.valid) actions.push(btn('v-', 'Log in', () => pickVault($, v)))
  else {
    if (on) actions.push(btn('v-off-', 'Deactivate', () => deactivateVault($, v)))
    else actions.push(btn('v-', confirm ? 'Confirm activate' : 'Activate', () => activateVault($, v), confirm ? 'primary' : undefined))
  }
  return Box({
    key: 'vrow-' + v.dns,
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    borderStyle: 'round',
    borderColor: on ? 'green' : 'gray',
    paddingX: 1,
    children: [Box({ flexDirection: 'column', children: [name, Box({ flexDirection: 'row', columnGap: 2, children: badges })] }), Box({ flexDirection: 'row', columnGap: 1, children: actions })],
  })
}

// Mark a Vault active in this chat. The CLI is not touched: Claude switches between active Vaults itself.
async function activateVault($, v) {
  if (!isSandbox(v) && V.confirm !== v.dns) {
    V.confirm = v.dns
    $.ui.invalidate('ui.render')
    return
  }
  V.confirm = ''
  V.pending = v.dns
  $.ui.invalidate('ui.render')
  now = await $.clock.now()
  dismissed.delete(v.dns)
  const path = vdir() + '/' + S.id + '.json'
  const used = (await readJson($, path, [])).filter((u) => u.dns !== v.dns)
  used.push({ dns: v.dns, name: v.name, ts: Math.round(now / 1000), cli: false })
  try {
    await $.fs.write(path, JSON.stringify(used.slice(-6)))
  } catch {
    V.msg = 'Failed: could not save the active list.'
  }
  await vaultRefresh($).catch(() => {})
  V.pending = ''
  $.ui.invalidate('ui.render')
}

// Take a Vault out of this chat's active set (the hook adds it back if a command uses it again)
// The Vault the CLI is signed in to counts as active when the picker opens
// (unless the user deactivated it earlier in this session)
const dismissed = new Set()
async function autoActivateCurrent($) {
  if (!V.valid || !V.current || V.used.includes(V.current) || dismissed.has(V.current)) return
  const v = V.list.find((x) => x.dns === V.current)
  if (!v) return
  now = await $.clock.now()
  const path = vdir() + '/' + S.id + '.json'
  const used = (await readJson($, path, [])).filter((u) => u.dns !== v.dns)
  used.push({ dns: v.dns, name: v.name, ts: Math.round(now / 1000), cli: true })
  try {
    await $.fs.write(path, JSON.stringify(used.slice(-6)))
  } catch {
    return
  }
  V.used = [...V.used, v.dns]
}

async function deactivateVault($, v) {
  dismissed.add(v.dns)
  V.pending = v.dns
  $.ui.invalidate('ui.render')
  const path = vdir() + '/' + S.id + '.json'
  const left = (await readJson($, path, [])).filter((u) => u.dns !== v.dns)
  try {
    await $.fs.write(path, JSON.stringify(left))
  } catch {
    // nothing to remove if it cannot be written
  }
  await vaultRefresh($).catch(() => {})
  V.pending = ''
  $.ui.invalidate('ui.render')
}

// With two or more active Vaults, tell Claude, since the CLI can only point at one
async function vaultNote($) {
  const used = await readJson($, vdir() + '/' + S.id + '.json', [])
  if (used.length < 2) return ''
  let cur = ''
  try {
    cur = V.current || ''
  } catch {
    // unknown
  }
  const list = used.map((u) => `${shortName(u.name)} (${u.dns})${u.dns === cur ? ' [CLI now here]' : ''}${isSandbox(u) ? '' : ' [production]'}`).join('; ')
  return `Vaults the user marked active in this chat: ${list}. The Vault CLI points at one Vault at a time: before a vault query/api/mdl/config command for another active Vault, run \`vault switch --dns <dns> -y\` and check \`vault status\`. Never switch to or write in a [production] Vault unless the user asked.`
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
