---
name: climanager-session
description: >-
  Open a visible terminal session inside the CLI Manager desktop app (macOS), run a coding
  agent (Claude Code, Codex CLI, Gemini CLI, or any command) in it, send prompts, wait until it
  finishes, and read the screen — while the user watches the same session and can take over at
  any time. Unlike `claude -p`, nothing runs out of sight. Uses `scripts/clim.mjs` (REST, no
  dependencies), so no MCP setup is needed. Use when the user says "open it in CLI Manager",
  "run this in a CLI Manager session", "spin up a terminal and have an agent do X", "delegate
  this to another agent session", "run Claude in that folder and show me", "clim", or "AI
  Control API", and when they ask about a session already opened this way ("is it done?",
  "what is it doing now?"). From CLI Manager 1.11 it can also read, type into, rename and close
  sessions the user opened — only when the user's request points at that session.
---

# CLI Manager sessions (`clim`)

Open a **visible** terminal inside the user's CLI Manager and run an agent there. The result stays on
the user's screen, and the user can type into it or disconnect the AI at any time.

## First-time setup (do this once)

1. **CLI Manager v1.10.0 or later** — <https://github.com/woorichicken/CLI_manager/releases/latest>.
   The API exists since v1.9.0; v1.10.0 adds the input-box checks, suggestion detection, and the
   ESC-then-text fix this skill relies on.
2. In the app: **Settings > Agents > AI Control API** → on. The app writes
   `~/.climanager/control-api.json` (url + token, mode 600, deleted when the app quits).
3. Check the connection. `CLI` is `scripts/clim.mjs` inside this skill's directory:

```bash
CLI="<this skill's directory>/scripts/clim.mjs"
node "$CLI" doctor        # always first — exit 0 means ready
node "$CLI" templates     # what can be launched (names come from the user's Settings > Templates)
```

If `doctor` exits 5, ask the user to start the app and turn the API on. Do not work around it.

## Basic flow

```bash
node "$CLI" open ~/code/my-project --template claude-code \
     --name "AI: fix failing test" --prompt "fix the failing test"
# → prints the session id. The prompt is typed once the program is ready.

node "$CLI" wait last --timeout 300      # wait until idle, then print the screen
node "$CLI" send last "now commit it" --wait 300   # follow up and wait again
node "$CLI" read last --tail --lines 120 # include scrollback
node "$CLI" release last                 # hand it to the user (session keeps running)
node "$CLI" close last                   # kill it when nothing is left to see
```

A session argument can be `last`, an id prefix, or part of the session name. Template names differ
per user — pick one from `templates`, or pass `--command "claude"` instead.

## Branch on the exit code (never parse the wording)

| Code | Meaning | Do |
| --- | --- | --- |
| 0 | ok | next step |
| 3 | **a question or menu is on screen** | read the screen, answer with `--keys` |
| 4 | no such session / the user clicked Disconnect AI while you waited | stop using it; it reconnects if the user asks you to continue |
| 5 | API off, app not running | ask the user to turn it on (see Troubleshooting) |
| 7 | wait timed out — **still running** | not a failure; wait again or report progress |
| 2 | usage error | fix the arguments |
| 1 | other API error | read the message |

## Safety rules (break these and the user's work breaks)

1. **Answer questions with keys.** While a choice is on screen, text is refused (exit 3). Enter picks
   the highlighted item — in Claude Code's folder-trust dialog, a blind Enter can pick "No, exit".
   ```bash
   node "$CLI" read last                      # look at the options first
   node "$CLI" send last --keys down,enter    # then answer
   ```
2. **Folder trust and permission prompts are the user's call.** Accept trust only when the user asked
   for work in that folder. When unsure, report the screen and ask.
   - `clim open` answers **Claude Code's folder-trust question with Yes** by itself and then sends the
     first prompt — you open a session to work in that folder. That question starts with the cursor on
     **"No, exit"**, so a bare Enter quits the agent. It is the only question clim answers on its own;
     anything else (permission prompts, warnings) still stops with exit 3. `--no-trust` turns it off.
3. **Do not use `--force`** except to answer a free-text question ("What should I do differently?").
4. **Exit 4 means stop.** The user clicked *Disconnect AI*. From app 1.11 another call would technically
   reconnect, so this rule is what keeps you out — continue only when the user asks.
4a. **Sessions the user opened: only when the request points at them.** `clim sessions --all` finds them,
   and read / send / rename / close all work (app 1.11+). The first read or send turns the session green
   in the sidebar. If the user is typing there, your text mixes with theirs — read the screen first.
   Only `close` a session you did not open when the user asked for it.
5. **Use `--focus` only when the user asked to watch.** Switching the displayed session takes the
   caret away from whatever the user was typing in. The green sidebar entry is enough by default.
6. **Tell the user before `close`.** It kills the process. Use `release` to leave the result behind.
7. **Long jobs: give `--wait` a long timeout and report in between.** Exit 7 is not a failure.

## Reading the screen correctly

- **Dim text in an empty input box is not user input.** Claude Code shows a next-prompt suggestion
  there. The API reports it separately as `suggestion` (and `clim read` prints it on its own line);
  don't treat it as an instruction. A prompt was really submitted only if it appears above with `❯`.
- **Right after `open --prompt`, read once** and check for `esc to interrupt` / `Working`. If the
  prompt is sitting in the input box unsent, press `send <session> --keys enter`.
- **"shell still running"** on an idle screen means the agent is waiting on its own background job
  and will wake itself — it is not finished.
- Claude Code's "How is Claude doing this session?" survey closes with `--keys 0`.

## Running several sessions

- **Wait on all of them at once** with `node "$CLI" watch` (run it in the background if your harness
  supports that). It prints `IDLE <id>`, `QUESTION <id>`, `LOAD <n>` or `TIMEOUT` and exits.
  `--prefix "AI: "` limits it to sessions whose name starts with that; `--load-alert 40` also exits
  when the 1-minute load average goes above 40.
- **Give sessions that share a repository an order** ("B merges only after A's deploy is ready").
- **Heavy test suites, not agents, are what overload a machine.** Several agents each running
  browser E2E in parallel will saturate the CPU while the agent CLIs themselves stay near idle.
  Keep test runs narrow, or use a session policy (below).
- Different sessions writing reports should use **different output folders** — same-named folders
  overwrite each other.

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
| `terminal not started` | the app window is closed (app in background) | ask the user to open the window |
| `first prompt NOT sent` + note | the program is asking something other than folder trust | `read`, answer with `--keys`, then `send` the prompt |
| Prompt typed but never submitted | Enter was eaten under heavy load | `send <session> --keys enter` |
| A long `wait` ends with exit 5 | the long request was dropped; the app is fine | `doctor`, then `wait` in chunks of ≤240s |
| Port conflict | something else holds 47821 | change the port in Settings (user's decision) |
| Running from another account/container | no discovery file | set `CLIM_URL` and `CLIM_TOKEN` |

## MCP alternative

The same app serves MCP at `/mcp`. Copy the exact command (with token) from Settings > Agents:

```bash
claude mcp add --scope user --transport http cli-manager http://127.0.0.1:47821/mcp \
  --header "Authorization: Bearer <token>"
```

Tools: `list_workspaces`, `list_templates`, `list_sessions`, `open_session`, `send_input`,
`wait_for_idle`, `read_output`, `focus_session`, `release_session`, `close_session`. This skill uses
the REST path so it works without MCP configuration; the rules above apply to both.

## Build your own process on top of this

This skill only **drives** sessions. What to do, when to stop and ask, and what to show at the end
depend on the person using it — so put that in **your own skill** that calls this one, not here.
Start from [`references/process-template.md`](references/process-template.md): pick the cases you
actually repeat (batch across projects, items from your queue, audits…), and for each one write down
what you confirm once up front, where it must stop, and the one-page summary it ends with.

## When not to use this

- The user asked **you** to do it in this conversation — don't open another terminal for it.
- One-off commands nobody will watch — just run them. The value here is the **visible** terminal.
- The user's own terminals — outside the API's permission (exit 4).
