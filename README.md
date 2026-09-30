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

## What it does — and doesn't

| Does | Doesn't |
| --- | --- |
| Opens sessions in CLI Manager with any template or command | Touch terminals you opened yourself |
| Types prompts, waits until idle, reads the rendered screen | Keep driving a session after you click **Disconnect AI** |
| Answers menus with keys, never with a blind Enter | Send anything off your machine (loopback only) |
| Waits on many sessions at once (`clim watch`) | Need MCP, npm packages, or an account |

## Setup: from install to first session

**1. Install CLI Manager v1.10.0 or later** (macOS) —
[latest release](https://github.com/woorichicken/CLI_manager/releases/latest).
The API exists since v1.9.0; v1.10.0 fixes lost input under load and reports dim input-box
suggestions separately, which this skill relies on.

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
| 7 | wait timed out — still running | wait again; not a failure |

## Alternative: MCP

The app also serves MCP. Copy the exact command (it includes your token) from Settings › Agents:

```bash
claude mcp add --scope user --transport http cli-manager http://127.0.0.1:47821/mcp \
  --header "Authorization: Bearer <token>"
```

Tools: `open_session`, `send_input`, `wait_for_idle`, `read_output`, `list_sessions`,
`list_templates`, `list_workspaces`, `focus_session`, `release_session`, `close_session`.
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
| `first prompt NOT sent` | The program is asking something (often folder trust): `read`, answer with `--keys`, then `send` |
| Prompt sits in the input box unsent | `send <session> --keys enter` |
| A long `wait` ends with exit 5 | Run `doctor`, then wait in chunks of ≤240 s |
| Port 47821 is taken | Change the port in Settings |
| Another user account or a container | Set `CLIM_URL` and `CLIM_TOKEN` instead of the discovery file |

## Security

The API binds to `127.0.0.1` only, requires the bearer token, and rejects foreign `Host`/`Origin`
headers, so web pages can't call it. It can only read or type into sessions it opened. Report
vulnerabilities privately via [GitHub security advisories](https://github.com/woorichicken/climanager-session/security/advisories/new).

API contract: [control-api.md](https://github.com/woorichicken/CLI_manager/blob/main/docs/architecture/control-api.md).

## License

[MIT](LICENSE), same as CLI Manager.
