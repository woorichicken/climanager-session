#!/usr/bin/env node
/**
 * clim — open and drive CLI Manager sessions from the command line.
 *
 * This is the no-MCP path: it only calls the app's AI Control API (REST) and reads the
 * address and token from the discovery file (~/.climanager/control-api.json).
 * No dependencies (Node 18+).
 *
 *   clim doctor                      is the API on?
 *   clim templates                   what can be launched
 *   clim open <folder> --template claude-code --prompt "..."
 *   clim send <session> "..." --wait 300
 *   clim read <session> [--tail]
 *   clim close <session>
 *
 * Branch on the exit code — do not parse screen text:
 *   0 ok · 2 usage error · 3 a question is on screen (answer with keys)
 *   4 no such session / not yours · 5 API off or unreachable · 7 wait timed out (still running)
 */

import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir, loadavg, tmpdir } from 'node:os'
import { join } from 'node:path'

const EXIT = { OK: 0, USAGE: 2, AWAITING: 3, NO_SESSION: 4, NO_API: 5, TIMEOUT: 7 }

const HOME = process.env.CLIMANAGER_HOME || join(homedir(), '.climanager')
const DISCOVERY = join(HOME, 'control-api.json')

/**
 * Optional rules appended to every first prompt. Off unless the file exists, so installing the
 * skill never changes what your agents are told. It lives outside the skill directory so that
 * updating the skill does not overwrite it. See prompts/session-policy.example.md.
 */
const POLICY_FILE = process.env.CLIM_POLICY_FILE || join(HOME, 'session-policy.md')

function sessionPolicy(runner) {
    if (!existsSync(POLICY_FILE)) return ''
    // Codex invokes skills as $name, Claude Code as /name.
    const sigil = /codex/i.test(runner ?? '') ? '$' : '/'
    // The first prompt must be one line — a newline can submit early in an agent's input box.
    return readFileSync(POLICY_FILE, 'utf8').replaceAll('{S}', sigil).replace(/\s+/g, ' ').trim()
}

function withPolicy(prompt, flags) {
    if (flags['no-policy']) return prompt
    const policy = sessionPolicy(flags.template ?? flags.command)
    return policy ? `${prompt} · ${policy}` : prompt
}

const USAGE = `clim — drive CLI Manager sessions (AI Control API / REST)

  clim doctor                                   API status, address, connectivity
  clim templates                                templates (name → command)
  clim workspaces [query]                       registered folders
  clim sessions [query] [--all]                 sessions marked as AI-driven (--all: every session, app 1.11+)
  clim policy [--template name]                 show the rules appended to first prompts (if any)

  clim open <folder> [options]                  open a session
      --template <name>   run a template (see: clim templates)
      --command "<cmd>"   run a command instead of a template
      --name <label>      name shown in the sidebar
      --prompt "<text>"   first prompt, sent once the program is ready
      --no-policy         do not append the session policy file
      --focus             switch the app to this session (costs the user's caret)
      --no-trust          do not answer Claude Code's "trust this folder?" question with Yes
      --workspace <id>    target a workspace id instead of a folder

  clim send <session> "<text>" [options]        type into a session (Enter by default)
      --keys enter,down   special keys (always answer questions/menus with these)
      --no-submit         do not press Enter
      --force             send text even while a question is on screen (risky)
      --wait <sec>        then wait until idle and print the screen

  clim wait <session> [--timeout <sec>] [--lines <n>]   wait until idle
  clim read <session> [--tail] [--lines <n>]            read the screen (--tail includes scrollback)
  clim watch [--prefix <name>] [--interval <sec>] [--timeout <sec>] [--load-alert <n>]
                                                wait until ANY session goes busy→idle or asks a question
  clim focus <session>                          switch the app to this session
  clim rename <session> "<name>"                change the name shown in the sidebar (app 1.11+)
  clim release <session>                        hand it to the user (keeps running, AI mark cleared)
  clim close <session>                          kill and remove the session (any session — only close ones you opened unless asked)

  common: --json (raw JSON) · <session> = id prefix, part of the name, or 'last'`

// ---------------------------------------------------------------- args

const FLAGS_WITH_VALUE = new Set([
    'template', 'command', 'name', 'prompt', 'workspace', 'keys', 'wait', 'timeout', 'lines', 'quiet-ms',
    'prefix', 'interval', 'load-alert'
])

function parseArgs(argv) {
    const positional = []
    const flags = {}
    for (let i = 0; i < argv.length; i++) {
        const arg = argv[i]
        if (!arg.startsWith('--')) {
            positional.push(arg)
            continue
        }
        const [name, inline] = arg.slice(2).split(/=(.*)/s)
        if (FLAGS_WITH_VALUE.has(name)) {
            const value = inline ?? argv[++i]
            if (value === undefined) fail(EXIT.USAGE, `--${name} needs a value.`)
            flags[name] = value
        } else {
            flags[name] = true
        }
    }
    return { positional, flags }
}

function fail(code, message, hint) {
    process.stderr.write(`${message}\n`)
    if (hint) process.stderr.write(`${hint}\n`)
    process.exit(code)
}

// ---------------------------------------------------------------- API access

function discovery() {
    // Environment variables win — the path for remote machines or containers without the file.
    if (process.env.CLIM_URL && process.env.CLIM_TOKEN) {
        return { url: process.env.CLIM_URL.replace(/\/$/, ''), token: process.env.CLIM_TOKEN }
    }
    if (!existsSync(DISCOVERY)) {
        fail(
            EXIT.NO_API,
            `The AI Control API is off (${DISCOVERY} not found).`,
            'Open CLI Manager > Settings > Agents and turn on "AI Control API". The app must be running.'
        )
    }
    try {
        const data = JSON.parse(readFileSync(DISCOVERY, 'utf-8'))
        if (!data.url || !data.token) throw new Error('missing url/token')
        return { url: String(data.url).replace(/\/$/, ''), token: data.token, pid: data.pid }
    } catch (error) {
        fail(EXIT.NO_API, `Could not read the discovery file: ${DISCOVERY}`, String(error.message ?? error))
    }
}

async function api(method, path, body, { timeoutMs = 30_000 } = {}) {
    const { url, token } = discovery()
    let response
    try {
        response = await fetch(url + path, {
            method,
            headers: {
                Authorization: `Bearer ${token}`,
                'Content-Type': 'application/json',
                'X-Client-Name': process.env.CLIM_CLIENT || 'clim'
            },
            body: body === undefined ? undefined : JSON.stringify(body),
            signal: AbortSignal.timeout(timeoutMs)
        })
    } catch (error) {
        fail(
            EXIT.NO_API,
            `Could not connect to the API: ${url}`,
            'Check that CLI Manager is running and the API is on in Settings > Agents. (clim doctor)'
        )
    }

    const text = await response.text()
    const payload = text ? JSON.parse(text) : null

    if (!response.ok) {
        const code = payload?.error?.code ?? String(response.status)
        const message = payload?.error?.message ?? text
        if (code === 'awaiting_input') {
            process.stderr.write(`A question is on screen: ${message}\n`)
            process.stderr.write('Read the screen (clim read) and answer with keys: clim send <session> --keys down,enter\n')
            process.exit(EXIT.AWAITING)
        }
        // disconnected: the user clicked Disconnect AI while you were waiting (app 1.11+).
        // not_controlled: what app 1.10 and earlier returned for that and for "not yours".
        if (code === 'disconnected' || code === 'not_controlled' || code === 'not_found') {
            fail(EXIT.NO_SESSION, `${code}: ${message}`)
        }
        fail(1, `${code}: ${message}`)
    }
    return payload
}

// ---------------------------------------------------------------- output

const json = (value) => JSON.stringify(value, null, 1)

function printSession(session, extra = []) {
    const lines = [
        `session ${session.id}`,
        `  name     ${session.name}  (${session.workspaceName})`,
        `  folder   ${session.cwd}`,
        `  command  ${session.command ?? '(shell only)'}`,
        `  state    ${session.state}${session.awaitingInput ? ' · awaiting input' : ''}`,
        ...extra
    ]
    process.stdout.write(lines.join('\n') + '\n')
}

function printScreen(result) {
    const s = result.session
    const waited = result.waitedMs === undefined ? '' : ` · waited ${(result.waitedMs / 1000).toFixed(1)}s`
    const timedOut = result.timedOut ? ' · still running (timed out)' : ''
    const suggestion = result.suggestion ? `\n(dim suggestion in the input box, not typed by anyone: ${result.suggestion})` : ''
    process.stdout.write(
        `[${s.name}] ${s.state}${s.awaitingInput ? ' · awaiting input' : ''}${waited}${timedOut}\n` +
        `--- screen (${result.mode}, ${result.lines.length} lines) ---\n` +
        result.lines.join('\n') + suggestion + '\n'
    )
}

// ---------------------------------------------------------------- session lookup

async function resolveSession(token) {
    if (!token) fail(EXIT.USAGE, 'Specify a session. (list them with: clim sessions)')
    const sessions = await api('GET', '/v1/sessions')

    if (token === 'last') {
        if (sessions.length === 0) fail(EXIT.NO_SESSION, 'No AI sessions are open. Open one with: clim open')
        return sessions[sessions.length - 1].id
    }

    // Look among AI-marked sessions first, then every session (the user's too).
    // App 1.10 and earlier ignore scope and return the same list, so nothing changes there.
    const match = (list) => {
        const exact = list.find((s) => s.id === token)
        if (exact) return exact.id
        const prefix = list.filter((s) => s.id.startsWith(token))
        if (prefix.length === 1) return prefix[0].id
        if (prefix.length > 1) fail(EXIT.USAGE, `Prefix "${token}" matches ${prefix.length} sessions. Use more characters.`)
        const byName = list.filter((s) => s.name.includes(token))
        if (byName.length === 1) return byName[0].id
        if (byName.length > 1) fail(EXIT.USAGE, `"${token}" is in the name of ${byName.length} sessions. Use the id.`)
        return null
    }
    const found = match(sessions) ?? match(await api('GET', '/v1/sessions?scope=all'))
    if (found) return found

    fail(EXIT.NO_SESSION, `Session not found: ${token}`, 'List sessions with: clim sessions --all')
}

/** The one question clim answers on its own. Permission prompts and other warnings are left to you. */
const TRUST_YES = /Yes, I trust this folder/
const TRUST_CURSOR = /^\s*[❯›>]\s/
const TRUST_SETTLE_MS = 15_000

/**
 * If the screen is Claude Code's folder-trust question, move the cursor to "Yes" and press Enter.
 * The options have no numbers, so it presses arrows for the distance between the cursor and "Yes".
 * True only once the question is gone.
 */
async function answerFolderTrust(id) {
    const screen = await api('GET', `/v1/sessions/${id}/output?lines=60`)
    const lines = screen.lines
    const yes = lines.findIndex((line) => TRUST_YES.test(line))
    const cursor = lines.findIndex((line) => TRUST_CURSOR.test(line))
    if (yes < 0 || cursor < 0) return false

    const distance = yes - cursor
    const keys = [...Array(Math.abs(distance)).fill(distance > 0 ? 'down' : 'up'), 'enter']
    await api('POST', `/v1/sessions/${id}/input`, { keys })

    const deadline = Date.now() + TRUST_SETTLE_MS
    while (Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 500))
        const after = await api('GET', `/v1/sessions/${id}/output?lines=60`)
        if (!after.lines.some((line) => TRUST_YES.test(line))) return true
    }
    return false
}

const MAX_WAIT_SECONDS = 600 // the API caps wait timeoutMs at 600000

const seconds = (value, fallback) => {
    const n = value === undefined ? fallback : Number(value)
    if (!Number.isFinite(n) || n < 0) fail(EXIT.USAGE, `Expected a number of seconds: ${value}`)
    return Math.min(n, MAX_WAIT_SECONDS)
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

// ---------------------------------------------------------------- commands

const commands = {
    async policy(_positional, flags) {
        const text = sessionPolicy(flags.template ?? flags.command)
        if (!text) {
            process.stdout.write(`No session policy (${POLICY_FILE} not found). First prompts are sent as-is.\n`)
            return
        }
        process.stdout.write(text + '\n')
    },

    async doctor(_positional, flags) {
        const { url, pid } = discovery()
        const health = await api('GET', '/v1/health', undefined, { timeoutMs: 5_000 })
        const sessions = await api('GET', '/v1/sessions')
        if (flags.json) return process.stdout.write(json({ url, pid, health, sessions: sessions.length }))
        process.stdout.write(
            `OK  ${health.app} ${health.version}\n` +
            `  address    ${url}\n` +
            `  discovery  ${process.env.CLIM_URL ? '(CLIM_URL/CLIM_TOKEN)' : DISCOVERY}${pid ? ` (app pid ${pid})` : ''}\n` +
            `  AI sessions ${sessions.length}\n` +
            `  policy     ${existsSync(POLICY_FILE) ? POLICY_FILE : 'off'}\n`
        )
    },

    async templates(_positional, flags) {
        const templates = await api('GET', '/v1/templates')
        if (flags.json) return process.stdout.write(json(templates))
        if (templates.length === 0) return process.stdout.write('No templates. (add them in Settings > Templates)\n')
        for (const t of templates) process.stdout.write(`${t.name.padEnd(18)} ${t.command}\n`)
    },

    async workspaces(positional, flags) {
        const query = positional[0] ? `?query=${encodeURIComponent(positional[0])}` : ''
        const workspaces = await api('GET', `/v1/workspaces${query}`)
        if (flags.json) return process.stdout.write(json(workspaces))
        const SHOWN = 60
        process.stdout.write(`${workspaces.length} workspaces\n`)
        for (const w of workspaces.slice(0, SHOWN)) {
            process.stdout.write(`${w.name.padEnd(24)} ${w.path}${w.aiSessionCount ? `  (AI ${w.aiSessionCount})` : ''}\n`)
        }
        if (workspaces.length > SHOWN) process.stdout.write(`… and ${workspaces.length - SHOWN} more. Pass a query.\n`)
    },

    async sessions(positional, flags) {
        const params = new URLSearchParams()
        if (flags.all) params.set('scope', 'all')
        if (positional[0]) params.set('query', positional[0])
        const query = params.toString()
        const sessions = await api('GET', `/v1/sessions${query ? `?${query}` : ''}`)
        if (flags.json) return process.stdout.write(json(sessions))
        if (sessions.length === 0) {
            return process.stdout.write(flags.all ? 'No sessions.\n' : 'No AI sessions are open. (--all includes your own)\n')
        }
        for (const s of sessions) {
            // aiControlled exists from app 1.11; without it every listed session is an AI session.
            const mark = s.aiControlled === false ? 'user ' : 'AI   '
            process.stdout.write(
                `${s.id.slice(0, 8)}  ${mark}${s.state.padEnd(8)}${s.awaitingInput ? 'question ' : '         '}${s.name}  (${s.cwd})\n`
            )
        }
    },

    async open(positional, flags) {
        const folder = positional[0]
        if (!folder && !flags.workspace) fail(EXIT.USAGE, 'A folder path or --workspace <id> is required.')
        if (flags.template && flags.command) fail(EXIT.USAGE, '--template and --command cannot be used together.')

        const body = {
            ...(folder ? { path: folder.startsWith('~') ? join(homedir(), folder.slice(1)) : folder } : {}),
            ...(flags.workspace ? { workspaceId: flags.workspace } : {}),
            ...(flags.template ? { template: flags.template } : {}),
            ...(flags.command ? { command: flags.command } : {}),
            ...(flags.name ? { name: flags.name } : {}),
            ...(flags.prompt ? { prompt: withPolicy(flags.prompt, flags) } : {}),
            ...(flags.focus ? { focus: true } : {})
        }
        // The first prompt is sent after the program starts, so the app holds the response longer.
        const result = await api('POST', '/v1/sessions', body, { timeoutMs: flags.prompt ? 120_000 : 40_000 })

        // In a folder it has not seen, Claude Code first asks whether to trust it — with the cursor on
        // "No, exit", so a single Enter quits the agent. You opened the session to work in this folder,
        // so clim picks "Yes, I trust this folder" and then sends the first prompt the app held back.
        let trusted = false
        if (result.session.awaitingInput && !flags['no-trust']) {
            trusted = await answerFolderTrust(result.session.id)
            if (trusted) {
                result.session = await api('GET', `/v1/sessions/${result.session.id}`)
                if (body.prompt && !result.promptSent && !result.session.awaitingInput) {
                    await api('POST', `/v1/sessions/${result.session.id}/wait`, { timeoutMs: 60_000, quietMs: 2_000 }, { timeoutMs: 70_000 })
                    await api('POST', `/v1/sessions/${result.session.id}/input`, { text: body.prompt })
                    result.promptSent = true
                    delete result.note
                    result.session = await api('GET', `/v1/sessions/${result.session.id}`)
                }
            }
        }
        if (flags.json) return process.stdout.write(json({ ...result, trustedFolder: trusted }))

        const extra = []
        if (result.createdWorkspace) extra.push('  registered the folder as a new workspace')
        if (trusted) extra.push('  answered the folder-trust question with "Yes, I trust this folder"')
        if (result.terminalStarted === false) extra.push('  ! terminal not started — is the app window open?')
        if (flags.prompt) extra.push(`  first prompt ${result.promptSent ? 'sent' : 'NOT sent'}`)
        if (result.note) extra.push(`  ! ${result.note}`)
        printSession(result.session, extra)
        if (result.session.awaitingInput) {
            process.stdout.write('\nRead the screen (clim read) and answer with keys: clim send <session> --keys down,enter\n')
            process.exit(EXIT.AWAITING)
        }
    },

    async send(positional, flags) {
        const id = await resolveSession(positional[0])
        const text = positional.slice(1).join(' ')
        const keys = flags.keys ? String(flags.keys).split(',').map((k) => k.trim()).filter(Boolean) : undefined
        if (!text && !keys) fail(EXIT.USAGE, 'Nothing to send: give text or --keys.')

        await api('POST', `/v1/sessions/${id}/input`, {
            ...(text ? { text } : {}),
            ...(keys ? { keys } : {}),
            ...(flags['no-submit'] ? { submit: false } : {}),
            ...(flags.force ? { force: true } : {})
        })

        if (flags.wait === undefined) {
            process.stdout.write(`sent: ${id.slice(0, 8)}\n`)
            return
        }
        await commands.wait([id], { ...flags, timeout: flags.wait })
    },

    async wait(positional, flags) {
        const id = await resolveSession(positional[0])
        const timeout = seconds(flags.timeout, 120)
        const result = await api(
            'POST',
            `/v1/sessions/${id}/wait`,
            {
                timeoutMs: timeout * 1000,
                ...(flags['quiet-ms'] ? { quietMs: Number(flags['quiet-ms']) } : {}),
                ...(flags.lines ? { lines: Number(flags.lines) } : {})
            },
            { timeoutMs: timeout * 1000 + 20_000 }
        )
        if (flags.json) process.stdout.write(json(result))
        else printScreen(result)
        if (result.session.awaitingInput) process.exit(EXIT.AWAITING)
        if (result.timedOut) process.exit(EXIT.TIMEOUT)
    },

    async read(positional, flags) {
        const id = await resolveSession(positional[0])
        const params = new URLSearchParams()
        if (flags.tail) params.set('mode', 'tail')
        if (flags.lines) params.set('lines', String(flags.lines))
        const query = params.toString()
        const result = await api('GET', `/v1/sessions/${id}/output${query ? `?${query}` : ''}`)
        if (flags.json) process.stdout.write(json(result))
        else printScreen(result)
        if (result.session.awaitingInput) process.exit(EXIT.AWAITING)
    },

    /**
     * Wait on many sessions at once. Prints one line and exits:
     *   IDLE <id> · QUESTION <id> · LOAD <n> (exit 0) · TIMEOUT (exit 7)
     * Only a busy→idle *transition* counts — a session that was already idle would otherwise fire
     * every time. The last snapshot is kept in a state file so a transition that happens between
     * two watch calls is not lost.
     */
    async watch(_positional, flags) {
        const prefix = flags.prefix ?? ''
        const intervalMs = seconds(flags.interval, 20) * 1000
        const timeoutMs = Number(flags.timeout ?? 1800) * 1000
        const loadAlert = flags['load-alert'] === undefined ? undefined : Number(flags['load-alert'])
        const stateFile = process.env.CLIM_WATCH_STATE || join(tmpdir(), 'clim-watch.state.json')

        const snapshot = async () => {
            const sessions = await api('GET', '/v1/sessions')
            return Object.fromEntries(
                sessions.filter((s) => s.name.startsWith(prefix)).map((s) => [s.id, s.awaitingInput ? 'question' : s.state])
            )
        }
        const done = (line, code = EXIT.OK, state) => {
            if (state) writeFileSync(stateFile, JSON.stringify(state))
            process.stdout.write(line + '\n')
            process.exit(code)
        }

        let prev
        try { prev = JSON.parse(readFileSync(stateFile, 'utf8')) } catch { prev = await snapshot() }
        const start = Date.now()
        while (true) {
            await sleep(intervalMs)
            const cur = await snapshot()
            for (const [id, state] of Object.entries(cur)) {
                if (state === 'question') done(`QUESTION ${id}`, EXIT.OK, cur)
                if (state === 'idle' && prev[id] === 'busy') {
                    // An agent waiting on its own background shell is resting, not finished — it wakes itself.
                    const screen = await api('GET', `/v1/sessions/${id}/output?lines=12`)
                    if (!/shells? still running/.test(screen.lines.join('\n'))) done(`IDLE ${id}`, EXIT.OK, cur)
                }
            }
            writeFileSync(stateFile, JSON.stringify(cur))
            prev = cur
            const oneMinuteLoad = loadavg()[0]
            if (loadAlert !== undefined && oneMinuteLoad > loadAlert) done(`LOAD ${oneMinuteLoad.toFixed(1)}`)
            if (Date.now() - start > timeoutMs) done('TIMEOUT', EXIT.TIMEOUT)
        }
    },

    async focus(positional) {
        const id = await resolveSession(positional[0])
        await api('POST', `/v1/sessions/${id}/focus`)
        process.stdout.write(`switched the app to: ${id.slice(0, 8)}\n`)
    },

    async rename(positional, flags) {
        const id = await resolveSession(positional[0])
        const name = positional.slice(1).join(' ').trim()
        if (!name) fail(EXIT.USAGE, 'A new name is required: clim rename <session> "<name>"')
        const session = await api('POST', `/v1/sessions/${id}/rename`, { name })
        if (flags.json) return process.stdout.write(json(session))
        process.stdout.write(`renamed ${id.slice(0, 8)} → ${session.name}\n`)
    },

    async release(positional) {
        const id = await resolveSession(positional[0])
        await api('POST', `/v1/sessions/${id}/release`)
        process.stdout.write(`handed to the user (keeps running, AI mark cleared): ${id.slice(0, 8)}\n`)
    },

    async close(positional) {
        const id = await resolveSession(positional[0])
        await api('DELETE', `/v1/sessions/${id}`)
        process.stdout.write(`closed: ${id.slice(0, 8)}\n`)
    }
}

// ---------------------------------------------------------------- entry

const [, , rawCommand, ...rest] = process.argv
if (!rawCommand || rawCommand === '--help' || rawCommand === '-h' || rawCommand === 'help') {
    process.stdout.write(USAGE + '\n')
    process.exit(rawCommand ? EXIT.OK : EXIT.USAGE)
}
const command = commands[rawCommand]
if (!command) {
    process.stderr.write(`Unknown command: ${rawCommand}\n\n${USAGE}\n`)
    process.exit(EXIT.USAGE)
}
const { positional, flags } = parseArgs(rest)
command(positional, flags).catch((error) => {
    process.stderr.write(`failed: ${error?.message ?? error}\n`)
    process.exit(1)
})
