// Vault Login: a Vault picker for Claude Code. Click a Vault to switch the vault CLI to it,
// or to log in to it when the session is gone. /vault and a one-row band with the current Vault.
// Split out of cache-keeper (2.11.0). Part of ai-champion-mods (MIT, see LICENSE).

import { clip } from './fmt.mjs'

const S = { id: '', cwd: '' }
let now = 0
let home = ''

async function registerCommand($, name, description, argumentHint, immediate) {
  const spec = immediate ? { name, description, argumentHint, immediate: true } : { name, description, argumentHint }
  try {
    await $.command.register(spec)
    return name
  } catch {
    try {
      await $.command.register({ ...spec, name: 'vl-' + name })
      return 'vl-' + name
    } catch {
      return null
    }
  }
}

// ---- Vault picker: click a Vault to switch to it, or to log in to it when the
// session is gone. The list is `vault list` (every Vault this login reaches);
// without a session it falls back to the names cached by hooks/vault-track.py.
const VPANE = 'vault-picker'
const V = { user: '', list: [], current: '', valid: true, confirm: '', busy: '', msg: '', used: [], open: false, filter: '', refreshing: false, pending: '', dots: 0 }
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
  // login needs --username when no TTY (the CLI would prompt); status still prints it when the session is expired
  const u = /^User:\s*(\S+)/m.exec(out)
  if (u) V.user = u[1]
}

// Username for a non-interactive browser login: from status, else the stored users list.
async function loginUser($) {
  if (V.user) return V.user
  const r = await vrun($, ['user', 'list'])
  const m = /([^\s│┆]+@[^\s│┆]+)/.exec(r.stdout || '')
  if (m) V.user = m[1]
  return V.user || ''
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
  let r
  if (V.valid) r = await vrun($, ['switch', '--dns', v.dns, '-y'])
  else {
    const user = await loginUser($)
    r = user ? await vrun($, ['login', '--dns', v.dns, '--username', user, '-y'], 180000) : { exitCode: 1, stderr: 'No stored user: run `vault login` once in a terminal' }
  }
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
  const user = await loginUser($)
  const r = user ? await vrun($, ['login', '--username', user, '-y'], 180000) : { exitCode: 1, stderr: 'No stored user: run `vault login` once in a terminal' }
  now = await $.clock.now()
  V.busy = ''
  if (r.exitCode === 0) await vaultRefresh($)
  V.msg = r.exitCode === 0 ? 'Logged in.' : 'Failed: ' + clip(String(r.stderr || r.stdout || 'no output').trim().split('\n')[0], 120)
  $.ui.invalidate('ui.render')
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

export function register(on) {
  on('session.start', async ($, e, next) => {
    now = await $.clock.now()
    home = (await $.env.get('USERPROFILE')) || (await $.env.get('HOME')) || ''
    S.id = await $.session.id()
    S.cwd = await $.session.cwd()
    await registerCommand($, 'vault', 'Pick a Vault: switch the CLI to it, or log in to it', '', true)
    vaultStatus($).then(() => $.ui.invalidate('ui.render')).catch(() => {})
    $.clock.every(60000, () => vaultStatus($).then(() => $.ui.invalidate('ui.render')).catch(() => {}))
    // loading dots for the Vault picker: 0, 1, 2, 3 dots, again
    $.clock.every(450, () => {
      if (!V.busy) return
      V.dots = (V.dots + 1) % 4
      $.ui.invalidate('ui.render')
    })
    return next(e)
  })

  // /clear, /resume and /branch continue under a new session id with no session.start
  on('classic.SessionStart', { source: ['clear', 'resume', 'fork'] }, async ($, e, next) => {
    try {
      S.id = (await $.session.id()) || S.id
    } catch {
      // keep the old id
    }
    return next(e)
  })

  // With two or more active Vaults, a short note rides along with each typed prompt
  on('prompt.submit', async ($, e, next) => {
    now = await $.clock.now()
    const typed = e.origin && e.origin.kind === 'composer' && !String(e.text || '').trim().startsWith('/')
    const note = typed ? await vaultNote($).catch(() => '') : ''
    if (note) e = { ...e, context: [...(e.context ?? []), note] }
    return next(e)
  })

  on('command.run', { command: ['vault', 'vl-vault', 'ck-vault'] }, async ($, e) => {
    const text = await openVaultPicker($)
    return text ? { text } : {}
  })

  on('ui.close', async ($, e, next) => {
    if (e.id === VPANE) V.open = false
    return next(e)
  })

  // One row above the prompt: the CLI's current Vault and the button that opens the picker
  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const below = await next(e)
    if (e.props && e.props.hasSurvey) return below
    const { Box, Text, Button } = $.ui.resolve(e)
    const cur = V.list.find((x) => x.dns === V.current)
    const sb = V.current ? isSandbox({ dns: V.current, name: cur ? cur.name : '' }) : true
    const left = !V.valid
      ? Text({ color: 'red', children: ['vault: not signed in'] })
      : V.current
      ? Text({ children: [Text({ dimColor: true, children: ['vault: '] }), Text({ color: sb ? 'green' : 'yellow', children: [cur ? shortName(cur.name) : V.current] }), Text({ dimColor: true, children: [sb ? ' (sandbox)' : ' (⚠ production)'] })] })
      : Text({ dimColor: true, children: ['vault: –'] })
    const btn = Button({ key: 'vault', label: V.valid ? 'vault' : 'vault login', hotkey: 'v', plain: true, dimColor: V.valid, onPress: async () => { const t = await openVaultPicker($); if (t) $.ui.toast(t, { timeoutMs: 15000 }) } })
    const mine = Box({ flexDirection: 'row', justifyContent: 'space-between', width: '100%', columnGap: 2, children: [left, btn] })
    return Box({ flexDirection: 'column', children: below ? [mine, below] : [mine] })
  })

  on('ui.render', { component: 'Pane' }, async ($, e, next) => {
    if (e.requestId === VPANE) return drawVaultPicker($, e)
    return next(e)
  })
}
