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
 *   clim open <folder> --agent claude --prompt "..."
 *   clim send <session> "..." --wait 300
 *   clim read <session> [--tail]
 *   clim close <session> [--force]   (a busy session is refused, exit code 7)
 *   clim inbox login "Sign-in needed" --url https://...   ask a human for help via the app inbox (app 1.18+)
 *   clim checklist new "release" "build" "publish"             header checklist (app 1.24+)
 *   clim cron new "morning check" --schedule "0 9 * * 1-5" --cwd ~/x --agent claude --prompt "..."   Autocron (app 1.34+)
 *
 * Branch on the exit code — do not parse screen text:
 *   0 ok · 2 usage error · 3 a question is on screen (answer with keys)
 *   4 no such session / not yours · 5 API off or unreachable
 *   6 the start of what `send` typed is not visible on screen (it may have been cut off)
 *   7 wait timed out (still running) · or close refused because the session is busy
 */

import { existsSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { homedir, loadavg, tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const EXIT = { OK: 0, USAGE: 2, AWAITING: 3, NO_SESSION: 4, NO_API: 5, NOT_VISIBLE: 6, TIMEOUT: 7 }

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

// ---------------------------------------------------------------- group folders

/**
 * Group folder — when one session has directly opened `groupAt` (default 5) live sessions, they are
 * gathered into a "Group: <opener's name>" session folder so the sidebar list stays readable.
 * Opt-in: automatic on `open` only with CLIM_AUTO_GROUP=1, or for one open with `--group <name>`.
 * The explicit `clim group` command always works. Grandchildren are neither counted nor moved
 * (the Tree view shows them), and a session already in another folder stays there — a session
 * belongs to one folder only. "Opened" sessions are counted from the Related pairs too, because
 * `openedBy` is empty after the app restarts.
 */

/** Like api(), but a failure returns null instead of exiting — grouping is a bonus and must not break an open. */
async function apiSoft(method, path, body) {
    try {
        const { url, token } = discovery()
        const response = await fetch(url + path, {
            method,
            headers: {
                Authorization: `Bearer ${token}`,
                'Content-Type': 'application/json',
                'X-Client-Name': process.env.CLIM_CLIENT || 'clim',
                ...(process.env.CLIMANAGER_SESSION_ID ? { 'X-Caller-Session': process.env.CLIMANAGER_SESSION_ID } : {})
            },
            body: body === undefined ? undefined : JSON.stringify(body),
            signal: AbortSignal.timeout(15_000)
        })
        const text = await response.text()
        return response.ok ? (text ? JSON.parse(text) : {}) : null
    } catch {
        return null
    }
}

const GROUP_AT_DEFAULT = 5
const GROUP_NAME_MAX = 40

function groupAt() {
    const fromEnv = Number(process.env.CLIM_GROUP_AT)
    return Number.isInteger(fromEnv) && fromEnv > 0 ? fromEnv : GROUP_AT_DEFAULT
}

const groupFolderName = (parentName) => `Group: ${String(parentName ?? '').trim()}`.slice(0, GROUP_NAME_MAX).trim()

/** Live sessions that parentId opened directly, plus the parent itself. null when lookup fails (grouping is skipped). */
async function liveChildrenOf(parentId) {
    const sessions = await apiSoft('GET', '/v1/sessions?scope=all')
    if (!sessions) return null
    const list = Array.isArray(sessions) ? sessions : (sessions.sessions ?? [])
    const parent = list.find((s) => s.id === parentId)
    if (!parent) return null
    const opened = new Set(list.filter((s) => s.openedBy === parentId).map((s) => s.id))
    // An app without the relations route falls back to openedBy alone.
    const related = await apiSoft('GET', `/v1/sessions/${parentId}/relations`)
    for (const r of related?.relations ?? []) if (r.kind === 'opened' && r.direction === 'outgoing') opened.add(r.sessionId)
    const children = list.filter((s) => opened.has(s.id) && s.id !== parentId && s.state !== 'exited')
    return { parent, children }
}

/** Move children into the group folder, skipping ones already in a folder. { moved, failed } — one failure does not stop the rest. */
async function moveIntoGroup(children, folderName) {
    let moved = 0
    const failed = []
    // The session-folder route only accepts an existing folder (folder_not_found), so create it by name first.
    if (children.some((c) => !c.sessionFolder) && !(await apiSoft('POST', '/v1/session-folders', { name: folderName }))) {
        return { moved, failed: children.filter((c) => !c.sessionFolder).map((c) => c.id.slice(0, 8)) }
    }
    for (const child of children) {
        if (child.sessionFolder) continue
        if (await apiSoft('POST', `/v1/sessions/${child.id}/session-folder`, { folder: folderName })) moved++
        else failed.push(child.id.slice(0, 8))
    }
    return { moved, failed }
}

const USAGE = `clim — drive CLI Manager sessions (AI Control API / REST)

  clim doctor                                   API status, address, connectivity
  clim templates                                templates (name → command)
  clim workspaces [query]                       registered folders
  clim unregister <workspace>                   unregister a workspace the AI registered (app 1.12+; files stay)
  clim policy [--template name]                 show the rules appended to first prompts (if any)
  clim sessions [query] [--all]                 sessions marked as AI-driven (--all: every session, app 1.11+)

  clim open <folder> [options]                  open a session
      --template <name>   run a template (see: clim templates)
      --command "<cmd>"   run a command instead of a template
      --agent <claude|codex|codex-research>  open an agent without a template
                          claude = claude --dangerously-skip-permissions
                          codex = codex --dangerously-bypass-approvals-and-sandbox
                          codex-research = codex -s workspace-write -a never --search
                          (sandbox: writes only in the open folder, no shell network, web search only — for reading outside text)
      --model <model>     claude: opus · sonnet · haiku ... / codex: any model id your Codex accepts
                          (attaches to --agent, --template and --command; replaces a model already in the command)
      --effort <level>    claude: low · medium · high ... / codex: sets model_reasoning_effort
                          Codex is always started with -c check_for_update_on_startup=false (a first Enter used to pick "Update now")
      --name <label>      name shown in the sidebar
      --prompt "<text>"   first prompt, sent once the program is ready
      --no-policy         do not append the session policy file
      --focus             switch the app to this session (costs the user's caret)
      --no-trust          do not answer the start-up "trust this folder?" question with Yes
      --no-submit-check   do not re-check that the first prompt was submitted (Enter is re-sent when it is stuck)
      --workspace <id>    target a workspace id instead of a folder
      --folder <name|id>  sidebar folder for a newly registered workspace (app 1.12+; created if missing)
      --session-folder <name|id>  session folder for the new session (app 1.21+; created if missing)
      --group <name>      put this session and the live sessions it opened earlier into a session folder with this name
      --no-group          never group on this open (automatic grouping is off unless CLIM_AUTO_GROUP=1)
      --ephemeral         temporary registration, removed with its last session (automatic for /tmp and scratch paths)

  clim send <session> "<text>" [options]        type into a session (Enter by default)
  clim send <session> --file <path> [options]   long instructions — keep the body in a file; sends ONE line:
                                                "Full instructions are in <path> — read it to the end and carry it out."
      --keys enter,down   special keys (always answer questions/menus with these)
      --no-submit         do not press Enter
      --force             send text even while a question is on screen (risky)
      --wait <sec>        then wait until idle and print the screen
      --no-submit-check   do not check that the text left the input box and that its start is on screen
                          (by default Enter is re-sent when the text is stuck; --json shows submitCheck and visible)
      If the first 24 non-space characters of what you sent are not on screen, clim warns on stderr and exits 6
      — the text may have been cut off (and --wait is skipped).

  clim wait <session> [--timeout <sec>] [--lines <n>]   wait until idle; if a spinner or "esc to interrupt" is still
                                                on the returned screen it waits again within the remaining time (off: --no-busy-check)
  clim read <session> [--tail] [--lines <n>]    read the screen (--tail includes scrollback)
  clim watch [--prefix <name>] [--interval <sec>] [--timeout <sec>] [--load-alert <n>] [--idle-polls <n>]
                                                wait until ANY session goes busy→idle or asks a question. An idle must be
                                                seen on N consecutive polls (default 2) before IDLE is printed, so a busy/idle flicker is ignored
  clim focus <session>                          switch the app to this session
  clim rename <session> "<name>" [--claude]     change the sidebar name (app 1.11+); --claude also runs /rename in Claude Code
  clim release <session>                        hand it to the user (keeps running, AI mark cleared)
  clim close <session> [--force] [--hand-to <session>]   kill and remove the session (any session — only close ones you opened unless asked)
      A busy session is refused (exit 7) — only --force closes one that is working.
      --hand-to <session>  before closing, hand this session's Related pairs to that session (app 1.21+; if it does not exist nothing is closed)

  clim folders                                  session folders and the sessions in them (app 1.21+)
  clim folder new <name>                        create a session folder — returns the existing one if the name is taken (app 1.21+)
  clim folder rename <folder> "<new name>"      rename (refused if another folder has that name)
  clim folder rm <folder>                       delete the folder — sessions stay open, only the membership goes
  clim folder put <session> <folder>            put a session into a folder
  clim folder out <session>                     take a session out of its folder
      <folder> is an id or a name (case-insensitive); two folders with one name are refused (use the id).
  clim group [<session>] [--name <name>] [--force]   gather the live sessions that session (default: the current one) opened
                                                into a "Group: <name>" folder — fewer than CLIM_GROUP_AT (5) only with --force
  clim relations <session>                      Related pairs — opened / first worked on / added by hand (app 1.21+; ones a person removed are hidden)
  clim fork [<session>] [options]               split a conversation into a new session, like the Chat view's Fork button (app 1.31+)
      Only when a person explicitly asks to split. No session = the current one (inside an app terminal).
      --message "<text>"  what the new session should do — typed once the agent is up
      --excerpt           copy only the recent turns up to the last reply to the new agent, instead of forking the whole conversation
      --quote             quote that reply above the message (whole conversation only)
      --turn <n>          which reply to split at (0-based among all turns) — default: the last
      The new session opens in the background and becomes a child of this one in Related. Tell the person the session link it prints.

  clim inbox <login|review|question|other> "<one line>" [options]   tell the app inbox a person's hands are needed (app 1.18+)
      --url <address>     page to open when clicked (a login or review page)
      --session <session> the sending session (omit inside an app terminal — CLIMANAGER_SESSION_ID is used)
      The same session + kind + text still unread only refreshes its time instead of stacking.
      It is read only when a person ticks it or uses Mark all read (app 1.22+) — mark it yourself with inbox read once it is solved.
  clim inbox list [--unread]                    inbox requests (newest first)
  clim inbox read <request id>                  mark a request read (you solved it yourself — the login is done)

  clim checklists [--done|--all] [--project <workspace>]   header checklists (default: unfinished, app 1.24+)
  clim checklist new "<title>" ["<item>"...] [--due YYYY-MM-DD] [--project <workspace>]
                                                create — an unfinished list with the same title is reused and only new items are added
  clim checklist show <list>                    items with their numbers
  clim checklist add <list> "<item>"...         add items (text already there is skipped)
  clim checklist check <list> <number|id>... [--undo]   tick (--undo: untick)
  clim checklist edit <list> [--title "..."] [--due YYYY-MM-DD|none] [--project <workspace>|none]
  clim checklist rm-item <list> <number|id>     delete one item
  clim checklist rm <list>                      delete the checklist
      <list> is an id (first characters) or a title (case-insensitive). Checklists live apart from sessions and stay when a session closes.

  clim crons                                    Autocron jobs — next run, last run, problems (app 1.34+)
  clim cron new "<name>" --schedule "<cron>" --prompt "..." [options]   open a session (or type into a loop) on a schedule
      --schedule "0 9 * * 1-5"   five fields in this Mac's local time (min hour day month weekday) · @hourly · @daily · @weekly · @monthly
      new session (default):  --cwd <folder> with --agent <command, e.g. claude> or --template <template>
      type into a loop:       --mode attach --loop <Loop project id>
      --missed once|skip|notify  runs missed while the app was off — once (default; one run if within --within <min>) · skip · notify
      --off                      create it switched off
      A job made through the API only runs while the Control API is on (nothing runs while it is off, and missed runs are not replayed).
  clim cron show <job>                          one job (next run, problems)
  clim cron edit <job> [options above · --name "..."]   change only what you pass
  clim cron run <job>                           run now (waits until the session is up and the prompt is typed)
  clim cron runs <job>                          run history (newest first)
  clim cron pause|resume <job>                  switch off / on
  clim cron rm <job>                            delete (history too)
      <job> is an id (first characters) or a name (case-insensitive).

  common: --json (raw JSON) · <session> = id prefix, part of the name, or 'last'
          'last' = the session with the newest connection time (not the end of the list) — if you open sessions
          from several places, do not use it; use the session.id that open --json returned

  environment: CLIM_URL + CLIM_TOKEN (skip the discovery file) · CLIMANAGER_HOME (default ~/.climanager)
               CLIM_POLICY_FILE (session policy, default ~/.climanager/session-policy.md; off if missing)
               CLIM_GROUP_AT (sessions before grouping, default 5) · CLIM_AUTO_GROUP=1 (group automatically on open)
               CLIM_WATCH_STATE (watch state file) · CLIM_WATCH_IDLE_POLLS (watch idle confirmation, default 2)
               CLIM_CLIENT (client label sent as X-Client-Name)`

// ---------------------------------------------------------------- args

// Every flag that takes a value must be listed here. A missing one reads as boolean true and its value becomes a
// stray positional that is silently dropped (--folder used to go to the request body as an empty string).
const FLAGS_WITH_VALUE = new Set([
    'template', 'command', 'name', 'prompt', 'workspace', 'folder', 'keys', 'wait', 'timeout', 'lines', 'quiet-ms',
    'prefix', 'interval', 'load-alert', 'idle-polls',
    'url', 'session', 'session-folder', 'hand-to', 'title', 'due', 'project', 'agent', 'model', 'effort', 'file',
    'message', 'turn', 'schedule', 'mode', 'cwd', 'loop', 'missed', 'within', 'group'
])

// ---------------------------------------------------------------- building the agent command
// Which agent and model to open is built here so nobody has to hand-write the command each time.

const AGENT_BASE = {
    claude: 'claude --dangerously-skip-permissions',
    codex: 'codex --dangerously-bypass-approvals-and-sandbox',
    // For sessions that read outside text: the OS sandbox limits writes to the open folder and blocks shell
    // network access (the web is reachable only through the built-in search).
    'codex-research': 'codex -s workspace-write -a never --search'
}

// Codex shows a menu with "1. Update now" highlighted at every start when a newer release exists. The first prompt's
// Enter picked it, a package upgrade ran and the session ended. Turning the check off removes the menu itself.
const CODEX_NO_UPDATE = '-c check_for_update_on_startup=false'
const CODEX_WORD = /(^|[\s;&|/])codex(?=\s|$)/

function agentOf(command) {
    if (CODEX_WORD.test(command)) return 'codex'
    if (/(^|[\s;&|/])claude(?=\s|$)/.test(command)) return 'claude'
    return null
}

/** Attach model/effort flags to a command and, for Codex, turn the update menu off. null when the agent is unknown. */
function agentCommand(base, { model, effort } = {}) {
    const agent = agentOf(base)
    if (!agent) return null
    let command = base.trim()
    // Remove an existing value first, then add exactly one. A quoted option value counts as one argument.
    const value = `(?:"(?:\\\\.|[^"\\\\])*"|'[^']*'|[^\\s;&|]+)`
    if (model) command = command.replace(new RegExp(`\\s(?:-m|--model)(?:=|\\s+)${value}`, 'g'), '')
    if (effort) {
        const option = agent === 'codex'
            ? `-c\\s+(?:"model_reasoning_effort=[^"]*"|'model_reasoning_effort=[^']*'|model_reasoning_effort=${value})`
            : `--effort(?:=|\\s+)${value}`
        command = command.replace(new RegExp(`\\s${option}`, 'g'), '')
    }
    if (agent === 'codex') {
        if (!command.includes('check_for_update_on_startup')) {
            command = command.replace(CODEX_WORD, (_m, lead) => `${lead}codex ${CODEX_NO_UPDATE}`)
        }
        if (model) command += ` -m ${model}`
        if (effort) command += ` -c model_reasoning_effort="${effort}"`
    } else {
        if (model) command += ` --model ${model}`
        if (effort) command += ` --effort ${effort}`
    }
    return command
}

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
                'X-Client-Name': process.env.CLIM_CLIENT || 'clim',
                // Inside a CLI Manager terminal the app sets your session id. Sending it lets the app
                // mark this session as the "master" (rose tint) once it opens other sessions.
                // Display-only, self-reported; older app versions ignore the header.
                ...(process.env.CLIMANAGER_SESSION_ID ? { 'X-Caller-Session': process.env.CLIMANAGER_SESSION_ID } : {})
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
        // An older app that does not know this command — the app has to be updated.
        if (code === 'no_route') fail(1, `${code}: ${message}`, 'This command needs a newer CLI Manager (inbox: app 1.18+ · session folders, relations, --hand-to: app 1.21+ · checklist: app 1.24+ · fork: app 1.31+ · cron: app 1.34+).')
        fail(1, `${code}: ${message}`)
    }
    return payload
}

// ---------------------------------------------------------------- output

const json = (value) => JSON.stringify(value, null, 1)
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

function printSession(session, extra = []) {
    const lines = [
        `session ${session.id}`,
        `  name     ${session.name}  (${session.workspaceName})`,
        `  folder   ${session.cwd}`,
        `  command  ${session.command ?? '(shell only)'}`,
        `  state    ${session.state}${session.awaitingInput ? ' · awaiting input' : ''}`,
        // Fields only newer apps send (1.21+) — no line when absent.
        ...(session.sessionFolder ? [`  session folder  ${session.sessionFolder.name}`] : []),
        ...(Array.isArray(session.memoPages) && session.memoPages.length > 1 ? [`  memo     ${session.memoPages.length} pages`] : []),
        ...extra
    ]
    process.stdout.write(lines.join('\n') + '\n')
}

// "Still working" marks in the bottom lines of a screen: the Claude spinner ("… (1m 33s ·"), and "esc to interrupt" in
// Codex and Claude. Finished lines ("✻ Crunched for 4m 22s", "Worked for 5m") have no ellipsis plus parenthesised time.
const BUSY_RECHECK_MS = Number(process.env.CLIM_BUSY_RECHECK_MS ?? 1_000)
const BUSY_MARKS = [/esc to interrupt/i, /…\s*\((?:\d+h\s*)?(?:\d+m\s*)?\d+s\s*(?:·|\))/, /to run in background/i]
function screenLooksBusy(lines) {
    const tail = lines.filter((line) => line.trim()).slice(-12)
    return tail.some((line) => BUSY_MARKS.some((mark) => mark.test(line)))
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

// Also set the Claude Code conversation title (`/rename`) — the sidebar name lives in the app, this title
// shows in `claude --resume` and on the input box border. Keeping both in sync makes old sessions findable.
// Skip when the session is not Claude Code, is busy, or shows a question (typed text would get mixed in).
const CLAUDE_COMMAND = /\bclaude\b/
// The banner may scroll away; the status line under the input box (⏵⏵ mode, '? for shortcuts') stays.
const CLAUDE_SCREEN = /Claude Code|⏵⏵|\? for shortcuts|bypass permissions|accept edits|plan mode on/
async function renameClaudeConversation(id, name) {
    const s = await api('GET', `/v1/sessions/${id}`)
    const out = await api('GET', `/v1/sessions/${id}/output`)
    const screen = (out.lines ?? []).join('\n')
    const isClaude = CLAUDE_COMMAND.test(s.command ?? '') || CLAUDE_SCREEN.test(screen)
    if (!isClaude) fail(EXIT.USAGE, `Not a Claude Code session, /rename was not sent (command: ${s.command || 'unknown'}).`)
    if (s.awaitingInput) fail(EXIT.AWAITING, 'A question is on screen, /rename was not sent.', 'Read it with clim read, answer, then run again.')
    if (s.state === 'busy') fail(EXIT.TIMEOUT, 'The session is busy, /rename was not sent (sidebar name only).', 'Run again when it is idle.')
    await api('POST', `/v1/sessions/${id}/input`, { text: `/rename ${name}` })
    process.stdout.write(`Claude conversation title set: /rename ${name}\n`)
}

const SCRATCH_PATH = /^(\/tmp\/|\/private\/tmp\/|\/var\/folders\/)|\/scratchpad(\/|$)/
function isScratchPath(folder) {
    return SCRATCH_PATH.test(folder)
}

/**
 * 'last' = the AI session with the newest connection time (connectedAt) — not the last element of the API list.
 * The list is not ordered by connection time, so with several orchestrations opening sessions at once
 * `send last` could type into someone else's session. With no readable connectedAt (older apps) it falls back
 * to the last element.
 */
function latestSession(sessions) {
    let newest = null
    let newestAt = Number.NEGATIVE_INFINITY
    for (const session of sessions) {
        const at = Date.parse(session.connectedAt)
        if (Number.isFinite(at) && at >= newestAt) {
            newest = session
            newestAt = at
        }
    }
    return newest ?? sessions[sessions.length - 1]
}

async function resolveSession(token) {
    if (!token) fail(EXIT.USAGE, 'Specify a session. (list them with: clim sessions)')
    const sessions = await api('GET', '/v1/sessions')

    if (token === 'last') {
        if (sessions.length === 0) fail(EXIT.NO_SESSION, 'No AI sessions are open. Open one with: clim open')
        return latestSession(sessions).id
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

// ---------------------------------------------------------------- start-up questions

/** The only questions clim answers on its own. Permission prompts, hook reviews and other warnings are left to you. */
const TRUST_YES = /Yes, I trust this folder/
const TRUST_CURSOR = /^\s*[❯›>]\s/
const TRUST_SETTLE_MS = 15_000

/** Codex asks to update whenever a newer release exists, with "1. Update now" (a package upgrade) highlighted. */
const CODEX_UPDATE = /Update available!/
const CODEX_UPDATE_SKIP = /^\s*(?:[❯›>]\s*)?2\.\s*Skip\s*$/
// Codex up to 0.163 asks "Do you trust the contents of this directory … Yes, continue", 0.164+ asks
// "Trust this folder? … 1. Trust and continue". "Hooks need review" is deliberately not answered —
// trusting hooks is for a person who has read the code, so it stops with exit code 3 (a question is on screen).
const CODEX_TRUST = /Do you trust the contents of this directory|Trust this folder\?/
const CODEX_TRUST_YES = /\bYes, continue\b|\bTrust and continue\b/
const CLAUDE_TRUST_QUESTION = /Do you trust the files in this folder|Quick safety check:|Accessing workspace:/
const STARTUP_ROUNDS = 3
const STARTUP_RENDER_MS = Number(process.env.CLIM_STARTUP_RENDER_MS ?? 30_000)
const STARTUP_POLL_MS = 250

/** Arrow keys from the highlighted option nearest `target` to it, then Enter; null when none is near. */
function moveTo(lines, target) {
    let cursor = -1
    for (let distance = 0; distance <= 3 && cursor < 0; distance++) {
        for (const row of [target - distance, target + distance]) {
            if (row >= 0 && row < lines.length && TRUST_CURSOR.test(lines[row])) {
                cursor = row
                break
            }
        }
    }
    if (cursor < 0) return null
    const distance = target - cursor
    return [...Array(Math.abs(distance)).fill(distance > 0 ? 'down' : 'up'), 'enter']
}

/** Keys for the start-up question on screen, or null when it is not one clim answers. */
function startupAnswer(lines) {
    // Claude Code's options have no numbers, so it presses arrows for the distance between the cursor and "Yes".
    const claudeYes = lines.findIndex((line) => TRUST_YES.test(line))
    if (claudeYes >= 0) return moveTo(lines, claudeYes)
    // Skipping installs nothing and only defers the offer; "2" picks it and closes the question.
    if (lines.some((line) => CODEX_UPDATE.test(line)) && lines.some((line) => CODEX_UPDATE_SKIP.test(line))) return ['2']
    if (lines.some((line) => CODEX_TRUST.test(line))) {
        const yes = lines.findIndex((line) => CODEX_TRUST_YES.test(line))
        if (yes >= 0) return moveTo(lines, yes)
    }
    return null
}

const INPUT_RULE = /^\s*─{10,}/

function startupReady(screen) {
    const lines = screen.lines ?? []
    if (startupAnswer(lines)) return true
    // Menus are drawn in several steps. The cursor and horizontal rules of a question whose options are not all
    // there yet are not the input box. Codex's trust menu can draw its options ("› 1. Trust and continue") and
    // title ("Folder access") before the question sentence.
    if (lines.some((line) => CLAUDE_TRUST_QUESTION.test(line) || TRUST_YES.test(line) ||
        CODEX_TRUST.test(line) || CODEX_UPDATE.test(line) || CODEX_TRUST_YES.test(line) ||
        /^\s*Folder access\s*$/.test(line) || /^\s*[❯›]\s+\d+\.\s/.test(line))) return false
    return Boolean(screen.session?.awaitingInput ||
        lines.some((line) => INPUT_RULE.test(line) || /^\s*[❯›]\s/.test(line)))
}

// Sometimes the first prompt lands in the input box but is never submitted (the Enter is lost), and the
// session sits idle while the caller believes it is working. So open looks at the screen once more after
// sending and, if the prompt is still in the input box, sends Enter again.
const PROMPT_SETTLE_MS = Number(process.env.CLIM_PROMPT_SETTLE_MS ?? 4_000)
const PROMPT_SUBMIT_CHECKS = 3
// Lines to read so the whole input box (including its top rule) is in view — with a long prompt a short read
// pushes the top rule out and a prompt stuck in the box goes unnoticed.
const PROMPT_SCREEN_LINES = 400
const PROMPT_HEAD_CHARS = 6

/**
 * Codex has no horizontal rules around its input box: the "› <text>" line is the last one, and while no work
 * lines (• or ◦) follow it the text has not been submitted yet. A long paste is folded to
 * "› [Pasted Content 1534 chars]", so that shape is matched instead of the text.
 */
function codexPromptStuck(lines, head) {
    let at = -1
    for (let i = lines.length - 1; i >= 0; i--) {
        if (/^\s*›\s*\S/.test(lines[i]) && (lines[i].includes(head) || /\[Pasted Content \d+ chars\]/.test(lines[i]))) { at = i; break }
    }
    if (at < 0) return false
    return !lines.slice(at + 1).some((line) => /^\s*[•◦]\s/.test(line))
}

/**
 * True when the prompt still sits in the input box: Claude Code draws the box between the last two
 * horizontal rules, and a submitted prompt is echoed above them instead.
 */
function promptStuckInInput(lines, prompt) {
    const rules = lines.map((line, i) => (INPUT_RULE.test(line) ? i : -1)).filter((i) => i >= 0)
    if (rules.length < 2) return codexPromptStuck(lines, prompt.trim().slice(0, PROMPT_HEAD_CHARS))
    const box = lines.slice(rules[rules.length - 2] + 1, rules[rules.length - 1])
    const head = prompt.trim().slice(0, PROMPT_HEAD_CHARS)
    return box.some((line) => /^\s*[❯›>]\s*\S/.test(line) && line.includes(head))
}

/** 'started' · 'retried' (sent Enter again, then it started) · 'unconfirmed' (could not tell — read the screen) */
async function ensurePromptSubmitted(id, prompt) {
    let retried = false
    for (let check = 0; check < PROMPT_SUBMIT_CHECKS; check++) {
        await sleep(PROMPT_SETTLE_MS)
        const session = await api('GET', `/v1/sessions/${id}`)
        const screen = await api('GET', `/v1/sessions/${id}/output?lines=${PROMPT_SCREEN_LINES}`)
        // Do not stop at busy alone — under load the state can flicker to busy while the text is still in the box.
        if (promptStuckInInput(screen.lines ?? [], prompt)) {
            if (!retried && !session.awaitingInput) {
                await api('POST', `/v1/sessions/${id}/input`, { keys: ['enter'] })
                retried = true
            }
            continue
        }
        if (!session.awaitingInput && session.state === 'busy') return retried ? 'retried' : 'started'
    }
    return 'unconfirmed'
}

/**
 * Check for `send`: text sent to an idle session can stay in the input box unsubmitted, and the caller only
 * sees "sent". Results: 'submitted' (not in the input box) · 'retried' (it was stuck, Enter sent again) ·
 * 'busy' (the session is working, so it may be queued — left alone).
 */
async function ensureSendSubmitted(id, text) {
    await sleep(PROMPT_SETTLE_MS)
    const session = await api('GET', `/v1/sessions/${id}`)
    if (session.state === 'busy') return 'busy'
    const screen = await api('GET', `/v1/sessions/${id}/output?lines=${PROMPT_SCREEN_LINES}`)
    if (!promptStuckInInput(screen.lines ?? [], text)) return 'submitted'
    await api('POST', `/v1/sessions/${id}/input`, { keys: ['enter'] })
    return 'retried'
}

// Did the sent text really arrive? A long instruction sent to several sessions can end up typed from the middle in
// one of them while the sender only saw "sent" and exit 0. The tail mode reads scrollback, so the start is found.
const SEND_VERIFY_LINES = 200
const SEND_HEAD_CHARS = 24
// Codex folds a long paste into "[Pasted Content 1534 chars]" in the input box and the history — that is not
// truncation. On a narrow screen the marker wraps at spaces and tail returns it line by line, so it is matched
// with all whitespace removed.
const CODEX_FOLDED_SQUEEZED = /\[PastedContent(\d+)chars\]/g

/** True when the first 24 non-space characters of the text (all of it if shorter) are on screen, or Codex's folded length equals the text length. */
function sentTextVisible(lines, text) {
    const squeeze = (value) => value.replace(/\s+/g, '')
    // The Control API turns CRLF into LF when typing, so the folded character count is measured the same way.
    const delivered = text.replace(/\r\n/g, '\n')
    const head = [...squeeze(delivered)].slice(0, SEND_HEAD_CHARS).join('')
    if (!head) return true
    const screen = squeeze(lines.join(''))
    if (screen.includes(head)) return true
    const lengths = new Set([[...delivered].length, [...delivered.trim()].length, delivered.length])
    return [...screen.matchAll(CODEX_FOLDED_SQUEEZED)].some((m) => lengths.has(Number(m[1])))
}

/** The one line `send --file` types. The body stays in the file, so input box length and paste folding do not matter. */
function filePointer(file) {
    const target = resolve(file)
    const stat = existsSync(target) ? statSync(target) : null
    if (!stat?.isFile()) fail(EXIT.USAGE, `--file is not a file: ${target}`)
    if (stat.size === 0) fail(EXIT.USAGE, `--file is empty: ${target}`)
    return `Full instructions are in ${target} — read it to the end and carry it out.`
}

/**
 * Answers the questions an agent asks before its first prompt in a new folder: Claude Code's folder trust
 * (cursor on "No, exit"), Codex's update offer (cursor on "Update now") and Codex's folder trust.
 * Returns whether trust was answered and whether a usable start-up screen was seen.
 */
async function answerFolderTrust(id, { waitForStartup = false, noTrust = false } = {}) {
    let answered = 0
    const renderDeadline = Date.now() + STARTUP_RENDER_MS
    for (let round = 0; round < STARTUP_ROUNDS; round++) {
        let screen = await api('GET', `/v1/sessions/${id}/output?lines=60`)
        // The open response may be a bare shell or a half-drawn menu. Wait for a question we can answer, or the input box.
        while (waitForStartup && !startupReady(screen) &&
            Date.now() < renderDeadline) {
            await sleep(STARTUP_POLL_MS)
            screen = await api('GET', `/v1/sessions/${id}/output?lines=60`)
        }
        const keys = startupAnswer(screen.lines)
        if (!keys || noTrust) return { trusted: answered > 0 && !keys, ready: startupReady(screen) }
        await api('POST', `/v1/sessions/${id}/input`, { keys })
        answered++
        // Wait for the question to go; Codex may put the next one up right after.
        const deadline = Date.now() + TRUST_SETTLE_MS
        let after = screen.lines
        while (Date.now() < deadline) {
            await sleep(500)
            after = (await api('GET', `/v1/sessions/${id}/output?lines=60`)).lines
            const next = startupAnswer(after)
            if (!next || next.join() !== keys.join()) break
        }
        await sleep(1_000)
    }
    const final = await api('GET', `/v1/sessions/${id}/output?lines=60`)
    return {
        trusted: answered > 0 && startupAnswer(final.lines) === null,
        ready: startupReady(final)
    }
}

const MAX_WAIT_SECONDS = 600 // the API caps wait timeoutMs at 600000

const seconds = (value, fallback) => {
    const n = value === undefined ? fallback : Number(value)
    if (!Number.isFinite(n) || n < 0) fail(EXIT.USAGE, `Expected a number of seconds: ${value}`)
    return Math.min(n, MAX_WAIT_SECONDS)
}

// ---------------------------------------------------------------- checklists (app 1.24+)

/**
 * Lets a checklist be named by the first characters of its id — the app only takes the full id or the title.
 * Id-looking text (hex digits and -) that matches exactly one id resolves to it; anything else is passed on as a title.
 */
async function resolveChecklist(token) {
    if (!token) fail(EXIT.USAGE, 'A checklist id or title is required. (list them with: clim checklists)')
    if (/^[0-9a-f-]{4,}$/i.test(token)) {
        const { checklists } = await api('GET', '/v1/checklists?status=all')
        const hits = checklists.filter((c) => c.id.startsWith(token))
        if (hits.length === 1) return hits[0].id
        if (hits.length > 1) fail(EXIT.USAGE, `Checklist prefix "${token}" matches ${hits.length} lists. Use more characters.`)
    }
    return token
}

const checklistUrl = (ref) => `/v1/checklists/${encodeURIComponent(ref)}`

function checklistLine(c) {
    const due = c.due ? ` · due ${c.due}${c.overdue ? ' (overdue)' : ''}` : ''
    const project = c.workspaceName ? ` · ${c.workspaceName}` : ''
    return `${c.id.slice(0, 8)}  ${c.title}  ${c.done}/${c.total}${c.complete ? ' done' : ''}${due}${project}`
}

function printChecklist(c) {
    const lines = [checklistLine(c), ...c.items.map((i) => `  ${String(i.n).padStart(2)} ${i.done ? '[x]' : '[ ]'} ${i.text}`)]
    process.stdout.write(lines.join('\n') + '\n')
}

// ---------------------------------------------------------------- Autocron (app 1.34+)

/** Lets a job be named by the first characters of its id — the app only takes the full id or the name (same rule as checklists). */
async function resolveCron(token) {
    if (!token) fail(EXIT.USAGE, 'A job id or name is required. (list them with: clim crons)')
    if (/^[0-9a-f-]{4,}$/i.test(token)) {
        const { crons } = await api('GET', '/v1/crons')
        const hits = crons.filter((c) => c.id.startsWith(token))
        if (hits.length === 1) return hits[0].id
        if (hits.length > 1) fail(EXIT.USAGE, `Job prefix "${token}" matches ${hits.length} jobs. Use more characters.`)
    }
    return token
}

const cronUrl = (ref) => `/v1/crons/${encodeURIComponent(ref)}`
const clock = (ms) => (ms ? new Date(ms).toLocaleString('sv-SE') : '-')

function cronRunLine(r) {
    const folded = r.missedCount ? ` (+${r.missedCount} missed)` : ''
    return `${clock(r.at)}  ${r.status}${folded} · ${r.trigger}${r.sessionId ? ` · session ${r.sessionId.slice(0, 8)}` : ''}${r.note ? ` · ${r.note}` : ''}`
}

function cronLine(c) {
    const target = c.mode === 'attach' ? `loop ${c.loopProjectId ?? '?'}` : `${c.template ? `template ${c.template}` : c.agent ?? '?'} @ ${c.cwd ?? '?'}`
    const state = c.enabled ? `next ${clock(c.nextRunAt)}` : 'off'
    const problem = c.problem ? `  ⚠ ${c.problem}` : ''
    return `${c.id.slice(0, 8)}  ${c.name}  [${c.schedule}]  ${state} · ${target} · by ${c.createdBy}${problem}`
}

function printCron(c) {
    const lines = [cronLine(c), `  prompt: ${c.prompt}`, `  missed runs: ${c.missed.policy}${c.missed.policy === 'once' ? ` (within ${c.missed.withinMinutes} min)` : ''}`]
    if (c.lastRun) lines.push(`  last: ${cronRunLine(c.lastRun)}`)
    process.stdout.write(lines.join('\n') + '\n')
}

/** Flags → job body. Only what was passed is included (edit must send only what changes). */
function cronBody(flags) {
    const body = {}
    if (flags.name !== undefined) body.name = String(flags.name)
    if (flags.schedule !== undefined) body.schedule = String(flags.schedule)
    if (flags.mode !== undefined) body.mode = String(flags.mode)
    if (flags.agent !== undefined) body.agent = String(flags.agent)
    if (flags.template !== undefined) body.template = String(flags.template)
    if (flags.cwd !== undefined) body.cwd = resolve(String(flags.cwd).replace(/^~(?=$|\/)/, homedir()))
    if (flags.loop !== undefined) body.loopProjectId = String(flags.loop)
    if (flags.prompt !== undefined) body.prompt = String(flags.prompt)
    if (flags.missed !== undefined || flags.within !== undefined) {
        body.missed = {
            policy: String(flags.missed ?? 'once'),
            ...(flags.within !== undefined ? { withinMinutes: Number(flags.within) } : {})
        }
    }
    if (flags.off) body.enabled = false
    return body
}

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

    // Unregister a workspace the AI registered (app 1.12+). Only the sidebar entry goes; files stay.
    // The app refuses the user's own workspaces (403) and ones with open sessions (409).
    async unregister(positional, flags) {
        const token = positional[0]
        if (!token) fail(EXIT.USAGE, 'A workspace id or name is required: clim unregister <workspace>')
        const list = await api('GET', '/v1/workspaces')
        const items = Array.isArray(list) ? list : list.workspaces ?? []
        const hits = items.filter((w) => w.id.startsWith(token) || w.name === token || w.path === token)
        if (hits.length !== 1) fail(EXIT.USAGE, hits.length ? `Several match: ${hits.map((w) => w.id.slice(0, 8) + ' ' + w.name).join(', ')}` : `No workspace matches: ${token}`)
        await api('DELETE', `/v1/workspaces/${hits[0].id}`)
        process.stdout.write(`unregistered ${hits[0].name} (${hits[0].path}) — the folder itself is untouched\n`)
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
        // Both would leave it unclear what to start. Say how to fix it: a habit of adding --template to --command is common.
        if (flags.template && flags.command) fail(EXIT.USAGE, '--template and --command cannot be used together — if you use --command, drop --template (the command replaces the template).')
        if (flags.agent && (flags.template || flags.command)) fail(EXIT.USAGE, '--agent cannot be used with --template or --command — pass only one (--model attaches to all three).')
        if (flags.agent && !AGENT_BASE[flags.agent]) fail(EXIT.USAGE, `--agent must be one of ${Object.keys(AGENT_BASE).join(' · ')}: ${flags.agent}`)

        // Group folder. Automatic only with CLIM_AUTO_GROUP=1 (the opener's live sessions reach CLIM_GROUP_AT with this one);
        // --group <name> forces it for this open, --no-group turns it off. An explicit --session-folder always wins.
        let group = null
        const caller = process.env.CLIMANAGER_SESSION_ID
        const forced = flags.group !== undefined
        if (!flags['no-group'] && flags['session-folder'] === undefined && (forced || process.env.CLIM_AUTO_GROUP === '1')) {
            const family = caller ? await liveChildrenOf(caller) : null
            if (family && (forced || family.children.length + 1 >= groupAt())) {
                group = { name: forced ? String(flags.group) : groupFolderName(family.parent.name), children: family.children }
            }
            // Outside an app terminal (or when the lookup fails) --group still names the folder for the new session.
            if (group) flags['session-folder'] = group.name
            else if (forced) flags['session-folder'] = String(flags.group)
        }

        // --agent, --model or --effort, or any Codex launch, builds the command here (reading the command from the template if one is given).
        // It then opens by command instead of template name, which the app treats the same way.
        let base = flags.command ?? (flags.agent ? AGENT_BASE[flags.agent] : null)
        if (flags.template) {
            const wantsFlags = flags.model || flags.effort
            const templates = await api('GET', '/v1/templates')
            const hit = templates.find((t) => t.name === flags.template)
            if (!hit && wantsFlags) fail(EXIT.USAGE, `Template not found: ${flags.template} (see: clim templates)`)
            if (hit && (wantsFlags || agentOf(hit.command) === 'codex')) base = hit.command
        }
        if (base) {
            const built = agentCommand(base, { model: flags.model, effort: flags.effort })
            if (!built && (flags.model || flags.effort)) fail(EXIT.USAGE, `--model and --effort can only be attached to claude or codex commands: ${base}`)
            flags.command = built ?? base
            delete flags.template
        } else if (flags.model || flags.effort) {
            fail(EXIT.USAGE, '--model and --effort go with one of --agent, --template or --command.')
        }
        const kind = agentOf(flags.command ?? '')

        const body = {
            ...(folder ? { path: folder.startsWith('~') ? join(homedir(), folder.slice(1)) : folder } : {}),
            ...(flags.workspace ? { workspaceId: flags.workspace } : {}),
            ...(flags.template ? { template: flags.template } : {}),
            ...(flags.command ? { command: flags.command } : {}),
            ...(flags.name ? { name: flags.name } : {}),
            ...(flags.prompt ? { prompt: withPolicy(flags.prompt, flags) } : {}),
            ...(flags.focus ? { focus: true } : {}),
            // Sidebar folder (app 1.12+). A missing name is created; omitted = the app setting ('AI Work').
            ...(flags.folder !== undefined ? { folder: String(flags.folder) } : {}),
            ...(flags['session-folder'] !== undefined ? { sessionFolder: String(flags['session-folder']) } : {}),
            // Temporary registration (app 1.12+): unregistered when its last session closes.
            // Turned on automatically for /tmp and scratch folders so they don't pile up in the sidebar.
            ...(flags.ephemeral || (folder && isScratchPath(folder)) ? { ephemeral: true } : {})
        }
        // The first prompt is sent after the program starts, so the app holds the response longer.
        // A directly given agent command may start in a shell, so its prompt is typed by clim once the start-up screen is confirmed.
        const openBody = { ...body }
        if (kind && body.command && body.prompt) delete openBody.prompt
        const result = await api('POST', '/v1/sessions', openBody, { timeoutMs: flags.prompt ? 120_000 : 40_000 })

        if (group) {
            // The new session already carries the folder in its body — move only the earlier ones that have no folder.
            // A failed move leaves that session as it was.
            const { moved, failed } = await moveIntoGroup(group.children, group.name)
            process.stderr.write(`note: this session has opened ${group.children.length + 1} sessions, so they were gathered in the "${group.name}" folder (moved ${moved} earlier ones · pass --no-group to skip).\n`)
            if (failed.length) process.stderr.write(`note: could not move ${failed.join(' · ')} — try clim group\n`)
        }

        // In a folder it has not seen, Claude Code first asks whether to trust it — with the cursor on
        // "No, exit", so a single Enter quits the agent. You opened the session to work in this folder,
        // so clim picks "Yes, I trust this folder" and then sends the first prompt the app held back.
        let trusted = false
        if (result.session.awaitingInput || body.prompt) {
            const startup = await answerFolderTrust(result.session.id, { waitForStartup: Boolean(body.prompt), noTrust: Boolean(flags['no-trust']) })
            trusted = startup.trusted
            // Blocked by a start-up question: the app's promptSent may only be a record of typing into the shell.
            if (trusted) result.promptSent = false
            result.session = await api('GET', `/v1/sessions/${result.session.id}`)
            if (body.prompt && !startup.ready) {
                result.promptSent = false
                result.note = 'Could not confirm the start-up screen, so the first prompt was not sent — read it with clim read and send it with clim send'
            }
            if (body.prompt && startup.ready && !result.promptSent && !result.session.awaitingInput) {
                await api('POST', `/v1/sessions/${result.session.id}/wait`, { timeoutMs: 60_000, quietMs: 2_000 }, { timeoutMs: 70_000 })
                const screen = await api('GET', `/v1/sessions/${result.session.id}/output?lines=${PROMPT_SCREEN_LINES}`)
                // If the text is already in the input box, only Enter is needed — typing it again would double it.
                const input = promptStuckInInput(screen.lines ?? [], body.prompt) ? { keys: ['enter'] } : { text: body.prompt }
                await api('POST', `/v1/sessions/${result.session.id}/input`, input)
                result.promptSent = true
                delete result.note
                result.session = await api('GET', `/v1/sessions/${result.session.id}`)
            }
        }
        let promptCheck = null
        if (body.prompt && result.promptSent && !result.session.awaitingInput && !flags['no-submit-check']) {
            promptCheck = await ensurePromptSubmitted(result.session.id, body.prompt)
            result.session = await api('GET', `/v1/sessions/${result.session.id}`)
        }
        if (flags.json) {
            process.stdout.write(json({ ...result, trustedFolder: trusted, ...(promptCheck ? { promptCheck } : {}) }))
            if (result.session.awaitingInput) process.exitCode = EXIT.AWAITING
            return
        }

        const extra = []
        if (result.createdWorkspace) extra.push('  registered the folder as a new workspace')
        if (trusted) extra.push('  answered the start-up questions (folder trust, skipped the Codex update offer)')
        if (result.terminalStarted === false) extra.push('  ! terminal not started — is the app window open?')
        const checkLabel = { started: '· started', retried: '· was stuck in the input box, sent Enter again → started', unconfirmed: '· could not confirm it started — check with clim read' }
        if (flags.prompt) extra.push(`  first prompt ${result.promptSent ? 'sent' : 'NOT sent'} ${promptCheck ? checkLabel[promptCheck] : ''}`.trimEnd())
        if (result.note) extra.push(`  ! ${result.note}`)
        printSession(result.session, extra)
        if (result.session.awaitingInput) {
            process.stdout.write('\nRead the screen (clim read) and answer with keys: clim send <session> --keys down,enter\n')
            process.exit(EXIT.AWAITING)
        }
    },

    async send(positional, flags) {
        const id = await resolveSession(positional[0])
        const keys = flags.keys ? String(flags.keys).split(',').map((k) => k.trim()).filter(Boolean) : undefined
        if (flags.file && (positional.length > 1 || keys)) fail(EXIT.USAGE, '--file cannot be combined with text or --keys — keep the body in the file.')
        const text = flags.file ? filePointer(flags.file) : positional.slice(1).join(' ')
        if (!text && !keys) fail(EXIT.USAGE, 'Nothing to send: give text, --file or --keys.')

        await api('POST', `/v1/sessions/${id}/input`, {
            ...(text ? { text } : {}),
            ...(keys ? { keys } : {}),
            ...(flags['no-submit'] ? { submit: false } : {}),
            ...(flags.force ? { force: true } : {})
        })

        const shouldCheck = text && !keys && !flags['no-submit'] && !flags['no-submit-check']
        const submitCheck = shouldCheck ? await ensureSendSubmitted(id, text) : null

        // The input-box re-send (submitCheck) stays as it is; whether the start of the text is on screen is checked separately.
        // If Enter was re-sent or nothing waited yet, wait once more for the screen to settle.
        let visible = null
        if (text && !keys && !flags['no-submit-check']) {
            if (submitCheck === null || submitCheck === 'retried') await sleep(PROMPT_SETTLE_MS)
            const screen = await api('GET', `/v1/sessions/${id}/output?mode=tail&lines=${SEND_VERIFY_LINES}`)
            visible = sentTextVisible(screen.lines ?? [], text)
        }

        const extra = { ...(submitCheck ? { submitCheck } : {}), ...(visible !== null ? { visible } : {}) }
        if (flags.wait === undefined || visible === false) {
            if (flags.json) process.stdout.write(json({ id, sent: true, ...extra }))
            else process.stdout.write(`sent: ${id.slice(0, 8)}${submitCheck === 'retried' ? ' (it stayed in the input box, so Enter was sent again)' : ''}\n`)
            if (visible === false) {
                process.stderr.write(`warning: the start of what you sent (${SEND_HEAD_CHARS} characters) is not visible on screen — the text may have been cut off.\n`)
                process.stderr.write(`Check with \`clim read ${id.slice(0, 8)} --tail\`; if it was cut off, send it again with \`clim send ${id.slice(0, 8)} --file <path>\`.${flags.wait === undefined ? '' : ' (--wait was skipped)'}\n`)
                process.exitCode = EXIT.NOT_VISIBLE
            }
            return
        }
        await commands.wait([id], { ...flags, timeout: flags.wait })
    },

    async wait(positional, flags) {
        const id = await resolveSession(positional[0])
        const timeout = seconds(flags.timeout, 120)
        const deadline = Date.now() + timeout * 1000
        let result
        // The app returns "done" after 1.5 s of quiet with no work mark on screen. But while Claude runs a long shell its
        // spinner line looks like "✽ Catapulting… (1m 33s · ↓ 817 tokens)" with no "esc to interrupt", and that was taken as
        // finished. If the bottom of the returned screen still looks busy, wait again within the remaining time.
        // Turn off with --no-busy-check.
        for (;;) {
            const remainingMs = Math.max(deadline - Date.now(), 1_000)
            result = await api(
                'POST',
                `/v1/sessions/${id}/wait`,
                {
                    timeoutMs: remainingMs,
                    ...(flags['quiet-ms'] ? { quietMs: Number(flags['quiet-ms']) } : {}),
                    ...(flags.lines ? { lines: Number(flags.lines) } : {})
                },
                { timeoutMs: remainingMs + 20_000 }
            )
            if (result.timedOut || result.session.awaitingInput || flags['no-busy-check']) break
            if (!screenLooksBusy(result.lines ?? [])) break
            if (Date.now() >= deadline - 1_000) { result.timedOut = true; break }
            await sleep(BUSY_RECHECK_MS)
        }
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
     * Only a busy→idle *transition* counts — a session that was already idle would otherwise fire every time.
     * Under heavy load the app's state can flicker busy↔idle while the screen still shows work, so a session that
     * was seen busy must then be seen idle on N consecutive polls (--idle-polls / CLIM_WATCH_IDLE_POLLS, default 2)
     * before IDLE is printed; one busy poll in between starts the count over. The last snapshot is kept in a state
     * file so a transition that happens between two watch calls is not lost.
     */
    async watch(_positional, flags) {
        const prefix = flags.prefix ?? ''
        const intervalMs = seconds(flags.interval, 20) * 1000
        const timeoutMs = Number(flags.timeout ?? 1800) * 1000
        const loadAlert = flags['load-alert'] === undefined ? undefined : Number(flags['load-alert'])
        const stateFile = process.env.CLIM_WATCH_STATE || join(tmpdir(), 'clim-watch.state.json')
        const idlePolls = Number(flags['idle-polls'] ?? process.env.CLIM_WATCH_IDLE_POLLS ?? 2)
        if (!Number.isInteger(idlePolls) || idlePolls < 1) fail(EXIT.USAGE, `--idle-polls must be a whole number of 1 or more: ${flags['idle-polls'] ?? process.env.CLIM_WATCH_IDLE_POLLS}`)

        const snapshot = async () => {
            const sessions = await api('GET', '/v1/sessions')
            return Object.fromEntries(
                sessions.filter((s) => s.name.startsWith(prefix)).map((s) => [s.id, s.awaitingInput ? 'question' : s.state])
            )
        }

        // State: last states, ids seen busy since their last report, and consecutive idle counts.
        // The old file format was the bare map of states.
        let saved = null
        try { saved = JSON.parse(readFileSync(stateFile, 'utf8')) } catch { saved = null }
        const prev = saved ? (saved.states ?? saved) : await snapshot()
        const wasBusy = { ...(saved?.wasBusy ?? {}) }
        if (!saved?.wasBusy) for (const [id, state] of Object.entries(prev)) if (state === 'busy') wasBusy[id] = true
        const idleStreak = { ...(saved?.idleStreak ?? {}) }

        const persist = (states) => writeFileSync(stateFile, JSON.stringify({ states, wasBusy, idleStreak }))
        const done = (line, code = EXIT.OK, states) => {
            if (states) persist(states)
            process.stdout.write(line + '\n')
            process.exit(code)
        }

        const start = Date.now()
        while (true) {
            await sleep(intervalMs)
            const cur = await snapshot()
            for (const [id, state] of Object.entries(cur)) {
                if (state === 'question') done(`QUESTION ${id}`, EXIT.OK, cur)
                if (state === 'busy') {
                    wasBusy[id] = true
                    idleStreak[id] = 0
                } else if (state === 'idle') {
                    idleStreak[id] = (idleStreak[id] ?? 0) + 1
                    if (wasBusy[id] && idleStreak[id] >= idlePolls) {
                        wasBusy[id] = false
                        // An agent waiting on its own background shell or monitor is resting, not finished — it wakes itself.
                        const screen = await api('GET', `/v1/sessions/${id}/output?lines=12`)
                        if (!/(shells?|monitors?) still running|\d+ monitors?/.test((screen.lines ?? []).join('\n'))) done(`IDLE ${id}`, EXIT.OK, cur)
                    }
                } else {
                    idleStreak[id] = 0
                }
            }
            for (const id of Object.keys(idleStreak)) if (!(id in cur)) { delete idleStreak[id]; delete wasBusy[id] }
            persist(cur)
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
        if (flags.json && !flags.claude) return process.stdout.write(json(session))
        process.stdout.write(`renamed ${id.slice(0, 8)} → ${session.name}\n`)
        if (flags.claude) await renameClaudeConversation(id, name)
    },

    async release(positional) {
        const id = await resolveSession(positional[0])
        await api('POST', `/v1/sessions/${id}/release`)
        process.stdout.write(`handed to the user (keeps running, AI mark cleared): ${id.slice(0, 8)}\n`)
    },

    async close(positional, flags) {
        const id = await resolveSession(positional[0])
        // Work can continue after the agent says it is done (a wrap-up commit or PR) — closing a busy session loses it.
        const current = await api('GET', `/v1/sessions/${id}`)
        if (current.state === 'busy' && !flags.force) {
            fail(EXIT.TIMEOUT, `The session is busy, so it was not closed: ${id.slice(0, 8)}`, 'Wait for it to finish (clim wait) and close it then, or add --force only if you really want to discard its work.')
        }
        // Resolve the heir first — if it cannot be found we stop here and close nothing.
        const heir = flags['hand-to'] !== undefined ? await resolveSession(String(flags['hand-to'])) : undefined
        const result = await api('DELETE', `/v1/sessions/${id}${heir ? `?handTo=${encodeURIComponent(heir)}` : ''}`)
        if (flags.json) return process.stdout.write(json(result))
        process.stdout.write(`closed: ${id.slice(0, 8)}${heir ? ` · handed ${result.handedOver ?? 0} Related pairs to ${heir.slice(0, 8)}` : ''}\n`)
    },

    async folders(_positional, flags) {
        const { folders } = await api('GET', '/v1/session-folders')
        if (flags.json) return process.stdout.write(json({ folders }))
        if (folders.length === 0) return process.stdout.write('No session folders.\n')
        for (const f of folders) {
            process.stdout.write(`${f.id.slice(0, 8)}  ${f.name}  (${f.sessions.length})\n`)
            for (const s of f.sessions) process.stdout.write(`    ${s.id.slice(0, 8)}  ${s.name}  [${s.workspaceName}]\n`)
        }
    },

    async folder(positional, flags) {
        const [action, ...args] = positional
        const folderUrl = (ref) => `/v1/session-folders/${encodeURIComponent(ref)}`
        const need = (value, usage) => {
            if (!value) fail(EXIT.USAGE, `Missing argument: ${usage}`)
            return value
        }
        let result
        if (action === 'new') {
            result = await api('POST', '/v1/session-folders', { name: need(args.join(' ').trim(), 'clim folder new <name>') })
            if (!flags.json) process.stdout.write(`${result.created ? 'created' : 'already exists, returned as is'}: ${result.folder.id.slice(0, 8)}  ${result.folder.name}\n`)
        } else if (action === 'rename') {
            const ref = need(args[0], 'clim folder rename <folder> "<new name>"')
            result = await api('POST', `${folderUrl(ref)}/rename`, { name: need(args.slice(1).join(' ').trim(), 'clim folder rename <folder> "<new name>"') })
            if (!flags.json) process.stdout.write(`renamed: ${result.id.slice(0, 8)} → ${result.name}\n`)
        } else if (action === 'rm') {
            result = await api('DELETE', folderUrl(need(args[0], 'clim folder rm <folder>')))
            if (!flags.json) process.stdout.write(`folder deleted (${result.releasedSessions} sessions stay open).\n`)
        } else if (action === 'put') {
            const id = await resolveSession(args[0])
            result = await api('POST', `/v1/sessions/${id}/session-folder`, { folder: need(args.slice(1).join(' ').trim(), 'clim folder put <session> <folder>') })
            if (!flags.json) process.stdout.write(`put in folder: ${id.slice(0, 8)} → ${result.sessionFolder?.name}\n`)
        } else if (action === 'out') {
            const id = await resolveSession(args[0])
            result = await api('POST', `/v1/sessions/${id}/session-folder`, { folder: null })
            if (!flags.json) process.stdout.write(`taken out of its folder: ${id.slice(0, 8)}\n`)
        } else {
            fail(EXIT.USAGE, 'clim folder new|rename|rm|put|out — see clim --help.')
        }
        if (flags.json) process.stdout.write(json(result))
    },

    async group(positional, flags) {
        const parentId = positional[0] ? await resolveSession(positional[0]) : process.env.CLIMANAGER_SESSION_ID
        if (!parentId) fail(EXIT.USAGE, 'Pass a session — outside an app terminal the current session is unknown: clim group <session>')
        const family = await liveChildrenOf(parentId)
        if (!family) fail(EXIT.NO_SESSION, `Session not found: ${parentId}`)
        const at = groupAt()
        if (family.children.length < at && !flags.force) {
            fail(EXIT.USAGE, `It has opened ${family.children.length} live sessions, so nothing was grouped (threshold ${at}) — add --force to group anyway`)
        }
        const name = flags.name ? String(flags.name) : groupFolderName(family.parent.name)
        const skipped = family.children.filter((c) => c.sessionFolder)
        const { moved, failed } = await moveIntoGroup(family.children, name)
        if (failed.length) process.exitCode = EXIT.NO_SESSION
        if (flags.json) return process.stdout.write(json({ folder: name, moved, failed, skipped: skipped.map((c) => c.id) }))
        process.stdout.write(`gathered ${moved} sessions in the "${name}" folder.${failed.length ? ` Could not move: ${failed.join(' · ')}` : ''}\n`)
        for (const c of skipped) process.stdout.write(`  left alone (already in "${c.sessionFolder.name}"): ${c.id.slice(0, 8)}  ${c.name}\n`)
    },

    async relations(positional, flags) {
        const id = await resolveSession(positional[0])
        const result = await api('GET', `/v1/sessions/${id}/relations`)
        if (flags.json) return process.stdout.write(json(result))
        if (result.relations.length === 0) return process.stdout.write('No Related pairs.\n')
        const KIND = { opened: 'opened', connected: 'first worked on', manual: 'added by hand' }
        for (const r of result.relations) {
            const arrow = r.direction === 'outgoing' ? '→' : '←'
            // The API sends UTC ISO — show this Mac's local time as YYYY-MM-DD HH:MM
            const when = Number.isNaN(Date.parse(r.at)) ? r.at : new Date(r.at).toLocaleString('sv-SE').slice(0, 16)
            process.stdout.write(`${arrow} ${r.sessionId.slice(0, 8)}  ${KIND[r.kind] ?? r.kind}  ${r.name}  [${r.workspaceName}]  (${when})\n`)
        }
    },

    async fork(positional, flags) {
        // No session given means this session — "split this conversation" usually means itself.
        const token = positional[0] ?? process.env.CLIMANAGER_SESSION_ID
        if (!token) fail(EXIT.USAGE, 'Specify the session to split. (inside an app terminal you can omit it for the current session)')
        const id = await resolveSession(token)
        const body = { scope: flags.excerpt ? 'excerpt' : 'whole' }
        if (flags.message !== undefined) body.message = String(flags.message)
        if (flags.quote) body.quote = true
        if (flags.turn !== undefined) {
            const turn = Number(flags.turn)
            if (!Number.isInteger(turn) || turn < 0) fail(EXIT.USAGE, '--turn must be a whole number of 0 or more.')
            body.turnIndex = turn
        }
        const result = await api('POST', `/v1/sessions/${id}/fork`, body)
        if (flags.json) return process.stdout.write(json(result))
        const what = result.scope === 'excerpt' ? 'excerpt' : 'whole conversation'
        const sent = result.messageSent ? 'first message typed' : 'no first message / not typed'
        process.stdout.write(`new session "${result.session.name}" (${what} · ${sent})${result.note ? ` — ${result.note}` : ''}\n`)
        process.stdout.write(`climanager://session/${result.session.id.slice(0, 8)}\n`)
    },

    async inbox(positional, flags) {
        const [first, ...restArgs] = positional
        if (first === 'list') {
            const result = await api('GET', `/v1/inbox${flags.unread ? '?unread=1' : ''}`)
            if (flags.json) return process.stdout.write(json(result))
            if (result.requests.length === 0) return process.stdout.write(flags.unread ? 'No unread requests.\n' : 'The inbox is empty.\n')
            process.stdout.write(`unread ${result.unreadCount}\n`)
            for (const r of result.requests) {
                process.stdout.write(
                    `${r.id.slice(0, 8)}  ${r.read ? 'read  ' : 'unread'}  ${r.kind.padEnd(8)}${r.sessionName || r.sessionId.slice(0, 8)}  ${r.text}${r.url ? `  <${r.url}>` : ''}  (${r.at})\n`
                )
            }
            return
        }
        if (first === 'read') {
            const token = restArgs[0]
            if (!token) fail(EXIT.USAGE, 'A request id is required: clim inbox read <request id> (see: clim inbox list)')
            const { requests } = await api('GET', '/v1/inbox')
            const matches = requests.filter((r) => r.id === token || r.id.startsWith(token))
            if (matches.length === 0) fail(EXIT.NO_SESSION, `Request not found: ${token}`)
            if (matches.length > 1) fail(EXIT.USAGE, `Request prefix "${token}" matches ${matches.length} requests. Use more characters.`)
            const request = await api('POST', `/v1/inbox/${matches[0].id}/read`)
            if (flags.json) return process.stdout.write(json(request))
            return process.stdout.write(`marked read: ${request.id.slice(0, 8)}\n`)
        }

        const KINDS = ['login', 'review', 'question', 'other']
        if (!KINDS.includes(first)) fail(EXIT.USAGE, `The kind must be one of ${KINDS.join('|')}: clim inbox login "<one line>"`)
        const text = restArgs.join(' ').trim()
        if (!text) fail(EXIT.USAGE, 'One line is required: clim inbox ' + first + ' "<what the person should do>"')
        if (!flags.session && !process.env.CLIMANAGER_SESSION_ID) {
            fail(EXIT.USAGE, 'Cannot tell which session this request is from.', 'Outside a CLI Manager terminal pass --session <session>.')
        }
        const body = {
            kind: first,
            text,
            ...(flags.url ? { url: String(flags.url) } : {}),
            ...(flags.session ? { sessionId: await resolveSession(String(flags.session)) } : {})
        }
        const result = await api('POST', '/v1/inbox', body)
        if (flags.json) return process.stdout.write(json(result))
        const r = result.request
        process.stdout.write(
            `${result.created ? 'sent to the inbox' : 'the same request is already unread, only its time was refreshed'}: ${r.id.slice(0, 8)}  ${r.kind} · ${r.sessionName || r.sessionId.slice(0, 8)}\n`
        )
    },

    async checklists(positional, flags) {
        if (flags.done && flags.all) fail(EXIT.USAGE, 'Pass only one of --done and --all.')
        const params = new URLSearchParams({ status: flags.all ? 'all' : flags.done ? 'done' : 'open' })
        if (flags.project) params.set('project', String(flags.project))
        const result = await api('GET', `/v1/checklists?${params}`)
        if (flags.json) return process.stdout.write(json(result))
        if (result.checklists.length === 0) return process.stdout.write('No checklists.\n')
        for (const c of result.checklists) process.stdout.write(checklistLine(c) + '\n')
    },

    async checklist(positional, flags) {
        const [action, ...args] = positional
        const usage = 'clim checklist new|show|add|check|edit|rm-item|rm — see clim --help.'
        const need = (value, hint) => {
            if (!value) fail(EXIT.USAGE, `Missing argument: ${hint}`)
            return value
        }
        // --due none / --project none clear the field (null) — there is no way to pass an empty value, so a word is used.
        const clearable = (value) => (value === 'none' ? null : String(value))
        const show = (checklist) => (flags.json ? process.stdout.write(json(checklist)) : printChecklist(checklist))

        if (action === 'new') {
            const [title, ...items] = args
            const body = {
                title: need(title, 'clim checklist new "<title>" ["<item>"...]'),
                ...(items.length ? { items } : {}),
                ...(flags.due ? { due: String(flags.due) } : {}),
                ...(flags.project ? { project: String(flags.project) } : {})
            }
            const result = await api('POST', '/v1/checklists', body)
            if (flags.json) return process.stdout.write(json(result))
            process.stdout.write(result.created ? 'created:\n' : 'an unfinished list with the same title exists, so it is reused (only new items added):\n')
            return printChecklist(result.checklist)
        }
        if (action === 'show') {
            const ref = await resolveChecklist(need(args[0], 'clim checklist show <list>'))
            return show((await api('GET', checklistUrl(ref))).checklist)
        }
        if (action === 'add') {
            const ref = await resolveChecklist(need(args[0], 'clim checklist add <list> "<item>"...'))
            const items = args.slice(1)
            need(items.length, 'clim checklist add <list> "<item>"...')
            const result = await api('POST', `${checklistUrl(ref)}/items`, { items })
            if (flags.json) return process.stdout.write(json(result))
            process.stdout.write(`added ${result.added}${result.added < items.length ? ` (${items.length - result.added} skipped, already there)` : ''}:\n`)
            return printChecklist(result.checklist)
        }
        if (action === 'check') {
            const ref = await resolveChecklist(need(args[0], 'clim checklist check <list> <number|id>...'))
            const items = args.slice(1)
            need(items.length, 'clim checklist check <list> <number|id>...')
            let checklist
            // Item numbers do not change until something is deleted, so sending several in turn hits the same items.
            for (const item of items) {
                checklist = (await api('POST', `${checklistUrl(ref)}/items/${encodeURIComponent(item)}`, { done: !flags.undo })).checklist
            }
            return show(checklist)
        }
        if (action === 'edit') {
            const ref = await resolveChecklist(need(args[0], 'clim checklist edit <list> [--title ...] [--due ...] [--project ...]'))
            const body = {
                ...(flags.title !== undefined ? { title: String(flags.title) } : {}),
                ...(flags.due !== undefined ? { due: clearable(flags.due) } : {}),
                ...(flags.project !== undefined ? { project: clearable(flags.project) } : {})
            }
            if (Object.keys(body).length === 0) fail(EXIT.USAGE, 'Pass what to change: --title · --due · --project')
            return show((await api('POST', checklistUrl(ref), body)).checklist)
        }
        if (action === 'rm-item') {
            const ref = await resolveChecklist(need(args[0], 'clim checklist rm-item <list> <number|id>'))
            const item = need(args[1], 'clim checklist rm-item <list> <number|id>')
            return show((await api('DELETE', `${checklistUrl(ref)}/items/${encodeURIComponent(item)}`)).checklist)
        }
        if (action === 'rm') {
            const ref = await resolveChecklist(need(args[0], 'clim checklist rm <list>'))
            const result = await api('DELETE', checklistUrl(ref))
            if (flags.json) return process.stdout.write(json(result))
            return process.stdout.write(`checklist deleted: ${args[0]}\n`)
        }
        fail(EXIT.USAGE, usage)
    },

    async crons(positional, flags) {
        const result = await api('GET', '/v1/crons')
        if (flags.json) return process.stdout.write(json(result))
        if (result.crons.length === 0) return process.stdout.write('No Autocron jobs.\n')
        for (const c of result.crons) process.stdout.write(cronLine(c) + '\n')
    },

    async cron(positional, flags) {
        const [action, ...args] = positional
        const usage = 'clim cron new|show|edit|run|runs|pause|resume|rm — see clim --help.'
        const need = (value, hint) => {
            if (!value) fail(EXIT.USAGE, `Missing argument: ${hint}`)
            return value
        }
        const show = (cron) => (flags.json ? process.stdout.write(json(cron)) : printCron(cron))

        if (action === 'new') {
            const body = { ...cronBody(flags), name: need(args[0], 'clim cron new "<name>" --schedule ... --prompt ...') }
            need(body.schedule, '--schedule "<cron>"')
            need(body.prompt, '--prompt "..."')
            const result = await api('POST', '/v1/crons', body)
            if (flags.json) return process.stdout.write(json(result))
            process.stdout.write('created:\n')
            return printCron(result.cron)
        }
        if (action === 'show') {
            const ref = await resolveCron(need(args[0], 'clim cron show <job>'))
            return show((await api('GET', cronUrl(ref))).cron)
        }
        if (action === 'edit') {
            const ref = await resolveCron(need(args[0], 'clim cron edit <job> [options]'))
            const body = cronBody(flags)
            if (Object.keys(body).length === 0) fail(EXIT.USAGE, 'Pass what to change: --schedule · --prompt · --name · --cwd · --agent · --missed ...')
            return show((await api('POST', cronUrl(ref), body)).cron)
        }
        if (action === 'run') {
            const ref = await resolveCron(need(args[0], 'clim cron run <job>'))
            const result = await api('POST', `${cronUrl(ref)}/run`)
            if (flags.json) return process.stdout.write(json(result))
            process.stdout.write(cronRunLine(result.run) + '\n')
            // A failed run comes back as a record (failed) — do not exit as if it worked.
            if (result.run.status !== 'started') process.exit(1)
            return
        }
        if (action === 'runs') {
            const ref = await resolveCron(need(args[0], 'clim cron runs <job>'))
            const result = await api('GET', `${cronUrl(ref)}/runs`)
            if (flags.json) return process.stdout.write(json(result))
            if (result.runs.length === 0) return process.stdout.write('No run history.\n')
            for (const r of result.runs) process.stdout.write(cronRunLine(r) + '\n')
            return
        }
        if (action === 'pause' || action === 'resume') {
            const ref = await resolveCron(need(args[0], `clim cron ${action} <job>`))
            return show((await api('POST', `${cronUrl(ref)}/${action}`)).cron)
        }
        if (action === 'rm') {
            const ref = await resolveCron(need(args[0], 'clim cron rm <job>'))
            const result = await api('DELETE', cronUrl(ref))
            if (flags.json) return process.stdout.write(json(result))
            return process.stdout.write(`job deleted (history too): ${args[0]}\n`)
        }
        fail(EXIT.USAGE, usage)
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
