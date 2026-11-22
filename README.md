# climanager-session

[![skills.sh](https://skills.sh/b/woorichicken/climanager-session)](https://skills.sh/woorichicken/climanager-session)
[![License: MIT](https://img.shields.io/badge/license-MIT-green.svg)](LICENSE)

Let your coding agent open **visible** terminal sessions in [CLI Manager](https://github.com/woorichicken/CLI_manager),
run another agent there, wait for it, and read the screen — while you watch the same terminal and can
take over at any time.

[한국어 README](README.ko.md) · Demo video: _coming soon_ <!-- TODO: site URL -->

```bash
npx skills add woorichicken/climanager-session@climanager-session
```

## What you can say

- "Open `~/code/api` in CLI Manager with Claude Code and have it fix the failing test."
- "Spin up three sessions, one per package, and tell me when each one finishes."
- "Is the session you opened done? What is it doing now?"
- "Give me a link to those two sessions." — prints `climanager://session/…`; click it to open them side by side (CLI Manager 1.14.2+).
- "If you need me to sign in, put it in the inbox." — a bell and an orange dot on that session (1.18+).
- "Keep the plan as a checklist in the header." — a chip both of you see, checked off as work finishes (1.24+).
- "Split this into a new session." — the conversation continues in a new session in the background (1.31+).
- "Every weekday at 9, open Claude in `~/code/api` and run the morning check." — an Autocron job (1.34+).

## What it does — and doesn't

| Does | Doesn't |
| --- | --- |
| Opens sessions in CLI Manager with any template or command | Touch your own terminals unless you point it at them |
| Types prompts, waits until idle, reads the rendered screen | Keep waiting on a session after you click **Disconnect AI** |
| Works in sessions you opened, renames and closes sessions (CLI Manager 1.11+) | Answer questions on its own — except folder trust and Codex's update offer |
| Answers menus with keys, never with a blind Enter | Send anything off your machine (loopback only) |
| Waits on many sessions at once (`clim watch`) | Need MCP, npm packages, or an account |
| Opens Claude Code or Codex without a template (`--agent`, `--model`, `--effort`) | Solve CAPTCHAs — those go to you through the inbox |
| Checks that a prompt was really submitted, and refuses to close a busy session | Split a conversation unless you ask |
| Inbox requests, header checklists, session folders, forks, scheduled jobs | Work with an app that lacks a feature — it says which version is needed |

## Setup: from install to first session

**1. Install CLI Manager v1.10.0 or later** (macOS) —
[latest release](https://github.com/woorichicken/CLI_manager/releases/latest).
The API exists since v1.9.0; v1.10.0 fixes lost input under load and reports dim input-box
suggestions separately, which this skill relies on. Newer features need newer apps: inbox 1.18,
session folders and Related 1.21, header checklists 1.24, fork 1.31, Autocron 1.34 — the latest
release has all of them.

**2. Turn on the API** — CLI Manager › **Settings › Agents › AI Control API**. The app then writes
`~/.climanager/control-api.json` (address + token, mode 600, removed when the app quits) and listens
on `127.0.0.1:47821`.

**3. Install the skill**

```bash
npx skills add woorichicken/climanager-session@climanager-session        # this project
npx skills add woorichicken/climanager-session@climanager-session -g     # all projects
```

**4. Check the connection** (Node 18+). With `-g` for Claude Code the script lands in
`~/.claude/skills/climanager-session/scripts/clim.mjs`; other agents use their own skills folder.

```bash
CLI=~/.claude/skills/climanager-session/scripts/clim.mjs
node "$CLI" doctor
# OK  CLI Manager 1.10.0
#   address    http://127.0.0.1:47821
#   ...
node "$CLI" templates      # names come from your Settings › Templates
```

**5. First session** — or just ask your agent in plain words; it runs these for you.

```bash
node "$CLI" open ~/code/my-project --template claude-code \
     --name "AI: fix failing test" --prompt "fix the failing test"
node "$CLI" wait last --timeout 300          # wait until idle, print the screen
node "$CLI" read last --tail --lines 120     # include scrollback
node "$CLI" release last                     # hand it to you; the session keeps running
```

A green session with a bot icon appears in the sidebar. Type into it whenever you like.

## Make it yours

This skill is the **engine**: open, type, wait, read. The **process** — which projects, what an agent
may ship on its own, where it must stop and ask you, what you want to see in the morning — is personal.
Write it as your own skill that calls `climanager-session`, starting from
[`references/process-template.md`](references/process-template.md). Begin with the work you have
already repeated two or three times; a process you have never run is a guess.

## Exit codes

Scripts and agents branch on these, not on the wording.

| Code | Meaning | Next step |
| --- | --- | --- |
| 0 | ok | continue |
| 1 | other API error | read the message |
| 2 | usage error | fix the arguments |
| 3 | a question or menu is on screen | `read`, then answer with `send <session> --keys down,enter` |
| 4 | no such session, or you took it back | stop using that session |
| 5 | API off or app not running | turn the API on (step 2) |
| 6 | `send`: the start of the text isn't visible — it may have arrived cut | `read --tail`, then resend with `send --file` |
| 7 | wait timed out — still running (or `close` refused a busy session) | wait again; not a failure |

## Alternative: MCP

The app also serves MCP. Copy the exact command (it includes your token) from Settings › Agents:

```bash
claude mcp add --scope user --transport http cli-manager http://127.0.0.1:47821/mcp \
  --header "Authorization: Bearer <token>"
```

Tools: `open_session`, `send_input`, `wait_for_idle`, `read_output`, `list_sessions`,
`list_templates`, `list_workspaces`, `focus_session`, `rename_session`, `release_session`, `close_session`,
session folders, `list_session_relations`, `fork_session`, `inbox_notify`, `inbox_list` and `checklist_*`
(Autocron is REST-only — use `clim cron`).
The skill's rules (answer questions with keys, don't focus unless asked, …) apply either way.

## Optional: shared rules for every session

If you run several agents at once, you can make every first prompt carry the same rules
(for example, "check the load average before running E2E"). Copy
[`prompts/session-policy.example.md`](prompts/session-policy.example.md) to
`~/.climanager/session-policy.md` and edit it. Without that file nothing is appended.
`clim policy` shows the current text; `--no-policy` skips it for one session.

## Troubleshooting

| Symptom | Fix |
| --- | --- |
| `doctor` exits 5 | Start CLI Manager and turn on Settings › Agents › AI Control API |
| No "AI Control API" in Settings | Update CLI Manager (v1.9.0+, v1.10.0+ recommended) |
| `terminal not started` | Open the app window — sessions start in the window, not in the background |
| `first prompt NOT sent` | The program is asking something (folder trust is answered for you unless `--no-trust`): `read`, answer with `--keys`, then `send` |
| Prompt sits in the input box unsent | `send <session> --keys enter` |
| `no_route` (exit 1) | The app is older than that command — update CLI Manager |
| `send` exits 6 | Long text arrived cut: write it to a file and use `send --file <path>` |
| Every session restarted after an update | Installing an app update closes all terminals; agents resume the conversation, but running turns, dev servers and builds don't — check each session |
| A long `wait` ends with exit 5 | Run `doctor`, then wait in chunks of ≤240 s |
| Port 47821 is taken | Change the port in Settings |
| Another user account or a container | Set `CLIM_URL` and `CLIM_TOKEN` instead of the discovery file |

## Security

The API binds to `127.0.0.1` only, requires the bearer token, and rejects foreign `Host`/`Origin`
headers, so web pages can't call it. From CLI Manager 1.11, while the API is on it can read and type into
every session in the app — sessions it works in turn green, and switching the API off ends access. Report
vulnerabilities privately via [GitHub security advisories](https://github.com/woorichicken/climanager-session/security/advisories/new).

API contract: [control-api.md](https://github.com/woorichicken/CLI_manager/blob/main/docs/architecture/control-api.md).

## Development

`scripts/clim.mjs` has no dependencies. Its tests run against a fake API, no app needed:

```bash
node --test scripts/clim.test.mjs scripts/group.test.mjs
```

## License

[MIT](LICENSE), same as CLI Manager.
