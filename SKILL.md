---
name: climanager-session
description: >-
  Open a visible terminal session inside the CLI Manager desktop app (macOS), run a coding
  agent (Claude Code, Codex CLI or any command) in it, send prompts, wait until it finishes, and
  read the screen — while the user watches and can take over at any time. Uses `scripts/clim.mjs`
  (REST, no dependencies), so no MCP setup is needed. Use when the user says "open it in CLI
  Manager", "spin up a terminal and have an agent do X", "delegate this to another agent
  session", "clim", or "AI Control API", and when they ask about a session opened this way ("is
  it done?"). From CLI Manager 1.11 it can also drive sessions the user opened — only when the
  request points at one. Also use it to hand the user a clickable session link, to ping the user
  through the app inbox ("tell me when you need a login"), to keep a header checklist, to sort
  sessions into folders, to split a conversation when the user asks ("fork this into a new
  session"), and to run an agent on a schedule ("every weekday at 9").
---

# CLI Manager sessions (`clim`)

Open a **visible** terminal inside the user's CLI Manager and run an agent there. The result stays on
the user's screen, and the user can type into it or disconnect the AI at any time.

## First-time setup (do this once)

1. **CLI Manager v1.10.0 or later** — <https://github.com/woorichicken/CLI_manager/releases/latest>.
   The basics work from v1.10.0; newer features need newer apps (the version is on each row of the
   feature map below). An older app answers those commands with `no_route` and exit 1.
2. In the app: **Settings > Agents > AI Control API** → on. The app writes
   `~/.climanager/control-api.json` (url + token, mode 600, deleted when the app quits).
3. Check the connection. `CLI` is `scripts/clim.mjs` inside this skill's directory:

```bash
CLI="<this skill's directory>/scripts/clim.mjs"
node "$CLI" doctor        # always first — exit 0 means ready; it also prints the app version
node "$CLI" templates     # what can be launched (names come from the user's Settings > Templates)
```

If `doctor` exits 5, ask the user to start the app and turn the API on. Do not work around it.

## Feature map — find what you need

Not a checklist to run — pick the row you need. Details for the app features are in
[`references/app-features.md`](references/app-features.md).

| Feature | Command | One line | App |
| --- | --- | --- | --- |
| Status · lists | `doctor` · `templates` · `workspaces` · `sessions [--all]` | is the API on, what can be opened, which sessions exist | 1.10 (`--all` 1.11) |
| Open and drive | `open` · `send` · `wait` · `read` · `focus` | open a visible terminal, type, wait, read the screen | 1.10 |
| Pick the agent | `open --agent claude\|codex\|codex-research --model … --effort …` | no template needed; see [Picking an agent](#picking-an-agent) | any |
| Name · hand over · close | `rename [--claude]` · `release` · `close [--force] [--hand-to <s>]` | `close` refuses a busy session (exit 7) | 1.11 (`--hand-to` 1.21) |
| Tidy the sidebar | `unregister` · `open --ephemeral` · `open --folder` | scratch folders go away with their last session | 1.12 |
| Needs the user | `inbox login\|review\|question\|other "<one line>"` · `inbox list` · `inbox read` | bell + orange dot on the session; the user clicks to get there | 1.18 (read rule 1.22) |
| Session folders · Related | `folders` · `folder new\|rename\|rm\|put\|out` · `relations` · `open --session-folder` | group sessions in *All sessions*; see who opened whom | 1.21 |
| Group what one session opened | `group [<session>]` · `open --group <name>` | collect the sessions one session opened into a `Group: …` folder | 1.21 |
| Header checklist | `checklists` · `checklist new\|show\|add\|check\|edit\|rm-item\|rm` | the plan both of you see; it outlives sessions | 1.24 |
| Split a conversation | `fork [<session>] --message "…" [--excerpt]` | **only when the user asks** — a new session continues the conversation | 1.31 |
| On a schedule | `crons` · `cron new\|show\|edit\|run\|runs\|pause\|resume\|rm` | Autocron — the app opens a session (or types into a loop) at set times | 1.34 |
| Wait on many | `watch [--prefix "AI: "]` | one line per event: `IDLE` · `QUESTION` · `LOAD` · `TIMEOUT` | 1.10 |
| Shared rules | `policy` · `open --no-policy` | optional text appended to every first prompt | any |

## Basic flow

```bash
# Keep the id from open --json and use it for every later call.
ID=$(node "$CLI" open ~/code/my-project --template claude-code \
     --name "AI: fix failing test" --prompt "fix the failing test" --json \
     | node -pe 'JSON.parse(require("fs").readFileSync(0,"utf8")).session.id')
# The prompt is typed once the program is ready.

node "$CLI" wait "$ID" --timeout 300             # wait until idle, then print the screen
node "$CLI" send "$ID" "now commit it" --wait 300   # follow up and wait again (never into a busy session)
node "$CLI" send "$ID" --file ./brief.md         # long instructions: one line pointing at the file
node "$CLI" read "$ID" --tail --lines 120        # include scrollback
node "$CLI" release "$ID"                        # hand it to the user (session keeps running)
node "$CLI" close "$ID"                          # kill it when nothing is left to see
```

A session argument can be an id prefix, part of the session name, or `last`. **`last` is the session
connected most recently, not the one you opened** — when other agents drive sessions on the same
machine it can be theirs, so use the id from `open --json`. Template names differ per user — pick one
from `templates`, or use `--agent` / `--command`.

## Picking an agent

`--agent` opens an agent without a template. The command is built for you:

| `--agent` | Runs | Use for |
| --- | --- | --- |
| `claude` | `claude --dangerously-skip-permissions` | most work |
| `codex` | `codex --dangerously-bypass-approvals-and-sandbox` | most work; a second opinion from another vendor |
| `codex-research` | `codex -s workspace-write -a never --search` | reading untrusted web pages — writes stay in the folder, the shell has no network, only built-in web search |

- `--model` and `--effort` are added in each agent's own syntax (`--model`/`--effort` for Claude Code,
  `-m`/`-c model_reasoning_effort=…` for Codex) and also work with `--template` and `--command`.
  Valid values are whatever the user's CLI accepts.
- Codex is always started with `-c check_for_update_on_startup=false`, so the update menu (cursor on
  "Update now") cannot eat the first Enter.
- The `--dangerously-…` presets skip the agent's own permission prompts. Use them only in folders the
  user asked you to work in; prefer `codex-research` when the session reads content you don't trust.

## Branch on the exit code (never parse the wording)

| Code | Meaning | Do |
| --- | --- | --- |
| 0 | ok | next step |
| 3 | **a question or menu is on screen** | read the screen, answer with `--keys` |
| 4 | no such session / the user clicked Disconnect AI while you waited | stop using it; it reconnects if the user asks you to continue |
| 5 | API off, app not running | ask the user to turn it on (see Troubleshooting) |
| 6 | `send`: the start of your text is not visible on screen — it may have been cut | `read --tail`; if cut, send again with `--file` |
| 7 | wait timed out — **still running** (also: `close` refused a busy session) | not a failure; wait again or report progress |
| 2 | usage error | fix the arguments |
| 1 | other API error (`no_route` = the app is too old for this command) | read the message |

## Safety rules (break these and the user's work breaks)

1. **Answer questions with keys.** While a choice is on screen, text is refused (exit 3). Enter picks
   the highlighted item — in Claude Code's folder-trust dialog, a blind Enter can pick "No, exit".
   ```bash
   node "$CLI" read "$ID"                      # look at the options first
   node "$CLI" send "$ID" --keys down,enter    # then answer
   ```
2. **Folder trust and permission prompts are the user's call.** Accept trust only when the user asked
   for work in that folder. When unsure, report the screen and ask.
   - `clim open` answers **Claude Code's folder-trust question with Yes** by itself and then sends the
     first prompt — you open a session to work in that folder. That question starts with the cursor on
     **"No, exit"**, so a bare Enter quits the agent.
   - It handles **Codex** too: the update offer (cursor on **"1. Update now"**, runs `brew upgrade`) gets
     `2` (Skip), and Codex's folder-trust question (`› 1. Yes, continue` highlighted) gets Enter.
   - Those three are the only questions clim answers on its own; anything else (permission prompts,
     warnings) still stops with exit 3. `--no-trust` turns it off.
3. **Do not use `--force` on `send`** except to answer a free-text question ("What should I do differently?").
4. **Exit 4 means stop.** The user clicked *Disconnect AI*. From app 1.11 another call would technically
   reconnect, so this rule is what keeps you out — continue only when the user asks.
5. **Sessions the user opened: only when the request points at them.** `clim sessions --all` finds them,
   and read / send / rename / close all work (app 1.11+). The first read or send turns the session green
   in the sidebar. If the user is typing there, your text mixes with theirs — read the screen first.
   Only `close` a session you did not open when the user asked for it.
6. **Use `--focus` only when the user asked to watch.** Switching the displayed session takes the
   caret away from whatever the user was typing in. The green sidebar entry is enough by default.
7. **Tell the user before `close`.** It kills the process. `close` refuses a **busy** session (exit 7) —
   a session that looks done may still be committing or writing; wait, then close. `--force` only to
   discard work on purpose. Use `release` to leave the result behind.
8. **Fork only when the user asks** ("split this into a new session"). Don't split conversations on your own.
9. **CAPTCHAs and security checks go to the user.** Never solve or guess a CAPTCHA (no OCR, no AI, no
   solving services). Stop that step, send `inbox login "…"` with the page, and carry on with other work.
   Put the same rule in instructions you hand to sessions you open.
10. **Long jobs: give `--wait` a long timeout and report in between.** Exit 7 is not a failure.

## Reading the screen correctly

- **Dim text in an empty input box is not user input.** Claude Code shows a next-prompt suggestion
  there. The API reports it separately as `suggestion` (and `clim read` prints it on its own line);
  don't treat it as an instruction. A prompt was really submitted only if it appears above with `❯`.
- **`open --prompt` and `send` check that the text was actually submitted.** Sometimes it lands in the
  input box and the Enter is lost (or Codex folds a long paste into `[Pasted Content N chars]`), so the
  session sits idle while you think it is working. clim looks again and sends Enter once more. The result
  is in `--json` as `promptCheck` (open) / `submitCheck` (send): `started` · `retried` · `unconfirmed`.
  On `unconfirmed`, read the screen and press `send <session> --keys enter` yourself.
- **Long instructions can arrive cut.** `send` checks that the first 24 characters are on screen and
  exits 6 when they are not. For anything longer than a few lines, write it to a file and use
  `send --file <path>` — the agent gets one line telling it to read the file.
- **`wait` returns only when the screen is really idle.** If a spinner or `esc to interrupt` is still on
  the returned screen it waits again within your timeout (`--no-busy-check` turns that off).
- **"shell still running"** on an idle screen means the agent is waiting on its own background job
  and will wake itself — it is not finished.
- Claude Code's "How is Claude doing this session?" survey closes with `--keys 0`.

## Handing something to the user — one clickable line

When the user should go somewhere next, print a line they can **click** in the CLI Manager terminal
instead of describing where it is.

| Hand over | Print | Clickable when |
| --- | --- | --- |
| A session | `climanager://session/<first 8 chars of the id>` — several joined by `,` (up to 4) open side by side | CLI Manager 1.14.2+ |
| A code file | `src/app.ts:42` | file links on (the default) — ⌘-click opens the editor |

- **Keep links short.** Claude Code breaks a word longer than the screen onto an indented next line,
  and only the part before the break stays clickable. That is why session links use 8 characters.
- A session link only switches the view — clicking it never types anything.
- The session you are running in is `$CLIMANAGER_SESSION_ID`; `clim sessions` lists the others.

## When the user's hands are needed — the inbox (app 1.18+)

A login, 2FA or CAPTCHA, a result to look at, a decision you can't make: don't just ask in the terminal
and stop — also put one line in the app's inbox. The user sees a bell count, an orange dot on the
session and a Dock badge, and one click takes them to the session.

```bash
node "$CLI" inbox login "Sign in to GitHub in the browser, then type 'done' here" --url https://github.com/login
node "$CLI" inbox list --unread
node "$CLI" inbox read <request id>     # you solved it yourself, or the user answered
```

- Write the line as **what the user should do** and how to tell you it's done (≤200 characters).
- Inside a CLI Manager terminal the session is attached for you. Elsewhere — and inside **Codex**, whose
  shell does not pass `CLIMANAGER_SESSION_ID` on — add `--session <id>`.
- Repeating the same line does not pile up; it moves to the top.
- From 1.22 a request is read only when the user checks it (✓ or *Mark all read*) — opening the session
  doesn't. **Mark it read yourself** once it's solved, or the count stays.
- **Closing a session deletes its requests.** Before closing one that still has unread requests the user
  must act on, send them again from a session that stays open.

## Running several sessions

- **Wait on all of them at once** with `node "$CLI" watch` (run it in the background if your harness
  supports that). It prints `IDLE <id>`, `QUESTION <id>`, `LOAD <n>` or `TIMEOUT` and exits. An `IDLE`
  is reported only after the session stays idle on consecutive polls, so a pause between two tool calls
  doesn't wake you. `--prefix "AI: "` limits it to sessions whose name starts with that; `--load-alert 40`
  also exits when the 1-minute load average goes above 40.
- **Give sessions that share a repository an order** ("B merges only after A's deploy is ready").
- **Heavy test suites, not agents, are what overload a machine.** Several agents each running
  browser E2E in parallel will saturate the CPU while the agent CLIs themselves stay near idle.
  Keep test runs narrow, or use a session policy (below).
- Different sessions writing reports should use **different output folders** — same-named folders
  overwrite each other.
- **Keep the plan where the user sees it**: one header checklist per batch (`checklist new "<title>" "<item>"…`),
  checked off as items finish. It survives closing the sessions.
- **Folders keep the sidebar readable**: `open --session-folder "<name>"`, or `group` to collect what one
  session opened. Set `CLIM_AUTO_GROUP=1` to have `open` do that by itself once a session has opened
  `CLIM_GROUP_AT` (default 5) live sessions. Don't reorganise sessions the user didn't ask you to touch.

## Optional: rules appended to every first prompt

Off by default. If `~/.climanager/session-policy.md` exists (or `CLIM_POLICY_FILE` points to a file),
`open --prompt` appends its text, collapsed to one line, to the first prompt. `{S}` becomes `$` for
Codex templates and `/` otherwise, so skill references work in both. Start from
`prompts/session-policy.example.md`. `clim policy` shows what would be appended; `--no-policy` skips it.

## How data flows

```
[agent]                         [CLI Manager app — one process]                [user]
  node clim …
   │ 1. url + token from ~/.climanager/control-api.json
   │ 2. HTTP → http://127.0.0.1:47821/v1/…   Authorization: Bearer <token>
   ├──────────────▶ ControlApiServer  (loopback only · token, Host, Origin checked)
   │                ControlApiService (every session while the API is on, 1.11+)
   │                TerminalManager → node-pty → shell → agent  ──▶ green session in the sidebar
   │                   pty output ─┬─▶ app terminal (what the user sees)
   │                               └─▶ headless mirror
   │ 3. wait / read ◀── one screen, rendered from the mirror
```

- **Network is one loopback hop.** Nothing leaves the machine.
- **Input takes the same path as typing**, so the user can keep typing in the same terminal.
- **Reads return the rendered screen, not a log**, so TUIs that redraw in place read correctly.
  "Idle" means no output for 1.5s and no `esc to interrupt` on screen.

## Troubleshooting

| Symptom | Cause | Fix |
| --- | --- | --- |
| `doctor` exits 5 | app not running or API toggle off | Settings > Agents > **AI Control API** |
| No "AI Control API" in Settings | app older than v1.9.0 | update CLI Manager |
| `no_route` (exit 1) | the app is older than that command | update CLI Manager; the error names the version |
| `terminal not started` | the app window is closed (app in background) | ask the user to open the window |
| `first prompt NOT sent` + note | the program is asking something other than folder trust | `read`, answer with `--keys`, then `send` the prompt |
| Prompt typed but never submitted | Enter was eaten under heavy load | `send <session> --keys enter` |
| `send` exits 6 | the text arrived cut or scrolled away | `read --tail`; resend with `--file` |
| `inbox` from a Codex session can't find its session | Codex doesn't pass `CLIMANAGER_SESSION_ID` to its shell | add `--session <id>` |
| A long `wait` ends with exit 5 | the long request was dropped; the app is fine | `doctor`, then `wait` in chunks of ≤240s |
| Every session restarted, background jobs gone | installing an app update closes all terminals | sessions come back and agents resume the conversation, but running turns, dev servers and builds don't — check each session before you continue |
| Port conflict | something else holds 47821 | change the port in Settings (user's decision) |
| Running from another account/container | no discovery file | set `CLIM_URL` and `CLIM_TOKEN` |

## MCP alternative

The same app serves MCP at `/mcp`. Copy the exact command (with token) from Settings > Agents:

```bash
claude mcp add --scope user --transport http cli-manager http://127.0.0.1:47821/mcp \
  --header "Authorization: Bearer <token>"
```

Tools (app 1.36): `list_workspaces`, `list_templates`, `list_sessions`, `open_session`, `send_input`,
`wait_for_idle`, `read_output`, `focus_session`, `rename_session`, `release_session`, `close_session`,
session folders (`list_session_folders`, `create_session_folder`, `rename_session_folder`,
`delete_session_folder`, `move_session_to_folder`), `list_session_relations`, `fork_session`,
`unregister_workspace`, `inbox_notify`, `inbox_list`, and `checklist_*`. Autocron has no MCP tools —
use `clim cron`. This skill uses the REST path so it works without MCP configuration; the rules above
apply to both.

## Build your own process on top of this

This skill only **drives** sessions. What to do, when to stop and ask, and what to show at the end
depend on the person using it — so put that in **your own skill** that calls this one, not here.
Start from [`references/process-template.md`](references/process-template.md): pick the cases you
actually repeat (batch across projects, items from your queue, audits…), and for each one write down
what you confirm once up front, where it must stop, and the one-page summary it ends with.

## When not to use this

- The user asked **you** to do it in this conversation — don't open another terminal for it.
- One-off commands nobody will watch — just run them. The value here is the **visible** terminal.
- Terminals the user opened that their request doesn't point at — the API reaches them (1.11+),
  but leave them alone.
