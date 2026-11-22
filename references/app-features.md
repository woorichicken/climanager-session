# App features in detail

The rows of the feature map in [`SKILL.md`](../SKILL.md) that need more than one line. Each section
names the CLI Manager version it needs; an older app answers with `no_route` (exit 1).
API contract: [control-api.md](https://github.com/woorichicken/CLI_manager/blob/main/docs/architecture/control-api.md).

## Inbox (app 1.18+)

| Kind | When |
| --- | --- |
| `login` | sign-in, 2FA, CAPTCHA — anything the user has to do in a browser |
| `review` | look at a result — a page, a screenshot, a PR (put it in `--url`) |
| `question` | a decision you can't make (scope, anything hard to undo) |
| `other` | anything else that needs the user |

- One line, up to 200 characters (longer is cut, newlines become spaces). Say what to do and how to
  tell you it's done.
- `--url` must be absolute; `javascript:`, `data:` and similar are refused (exit 1). Whether a click
  opens it follows the terminal link rules: web, file and editor links, plus app schemes the user added
  under Settings > Terminal.
- Keep the question in the terminal too — the inbox only says *where* someone is waiting.
- Read state: before 1.22 opening the session marked a request read; from 1.22 only ✓ or *Mark all
  read* by the user, or `clim inbox read <id>` by you.
- Requests are kept across restarts (up to 200) and deleted with their session.

## Session folders (app 1.21+)

*All sessions* in the sidebar has session folders, separate from workspace folders. A session is in at
most one folder.

| To | Run |
| --- | --- |
| list folders and their sessions | `clim folders` |
| create (an existing name is returned, so repeating is safe) | `clim folder new "<name>"` |
| rename · delete (sessions stay, only membership goes) | `clim folder rename <folder> "<new>"` · `clim folder rm <folder>` |
| put a session in · take it out | `clim folder put <session> <folder>` · `clim folder out <session>` |
| open straight into one (created if missing) | `clim open <path> --session-folder "<name>"` |

- `<folder>` is an id or a name (case ignored). Two folders with the same name → refused; use the id
  from `clim folders`.
- Folder changes are labels only: no AI mark, no Related pair. The sidebar follows without a reload.
- Expanded/collapsed is the user's view state and not in the API.

### Grouping what one session opened

`clim group [<session>]` collects the live sessions that one session opened (default: the session you
are in) into a folder named `Group: <that session's name>` (`--name` to choose another). It needs at
least `CLIM_GROUP_AT` (default 5) such sessions; `--force` groups fewer. Sessions already in a folder
stay where they are, and sessions opened by those sessions are not counted.

`open --group <name>` puts the new session in a group folder right away. With `CLIM_AUTO_GROUP=1` in the
environment, `open` groups by itself once the opening session reaches the threshold; `--no-group` skips
it for one open.

## Related sessions (app 1.15+, readable from 1.21)

The session header's **Related** dialog lists sessions that belong together. You don't register them:
when `clim` runs inside a CLI Manager terminal it sends its own session id, so a session you **open**
(`opened`) and the first session you **type into** (`connected`) are related to yours automatically.
Reading or waiting doesn't relate anything. Pairs survive restarts and disappear when either session
closes; pairs the user removed are not added back.

- `clim relations <session>` — `→` sessions this one opened or typed into first, `←` the one that opened
  it, and pairs the user added by hand.
- **Handing over to a new session**: open the successor `B`, then `clim close <A> --hand-to <B>` — A's
  pairs are copied to B, then A closes. If B doesn't exist nothing is closed.

## Header checklist (app 1.24+)

A chip in the app header (title · done/total · deadline). It belongs to no session, so it survives
closing them — use it for the plan of a batch, where the user can see it without reading your replies.

| To | Run |
| --- | --- |
| open lists (`--done` · `--all` · `--project <workspace>`) | `clim checklists` |
| create — items after the title | `clim checklist new "<title>" "<item>" "<item>" [--due YYYY-MM-DD] [--project <workspace>]` |
| show · add items | `clim checklist show <list>` · `clim checklist add <list> "<item>"…` |
| check · uncheck | `clim checklist check <list> <n>…` · the same with `--undo` |
| change title, deadline, project (`none` clears) | `clim checklist edit <list> --title "…" --due none` |
| delete an item · the whole list | `clim checklist rm-item <list> <n>` · `clim checklist rm <list>` |

- `<list>` is an id prefix or the title (case ignored). `new` with the title of an open list reuses it
  and adds only the missing items, so repeating is safe.
- Items are numbered from 1; numbers don't change until an item is deleted.

## Splitting a conversation — `clim fork` (app 1.31+)

Only when the user **explicitly** asks ("split this into a new session"). Same as the Fork button in the
Chat view.

```bash
node "$CLI" fork --message "Continue only the auth part here"     # the session you're in, whole conversation
node "$CLI" fork <session> --excerpt --message "…"                # a fresh agent with the last turns copied in
```

- Whole conversation (default): Claude `--resume <id> --fork-session`, Codex `fork <id>`, keeping the
  user's own start command. Turns after the chosen reply come along too.
- `--excerpt`: a fresh agent whose first message is the last ≤6 turns (the user's words and the final
  answers, secrets masked) followed by `--message`. A copy, not a summary.
- `--message` is typed once the agent is up, so quoting is not an issue. `--turn <n>` picks another reply.
- The new session opens **in the background** as `<name> · fork` in the same workspace and folder, and
  becomes a Related child. Give the user the session link from the output.
- Refused: no conversation yet, or that turn is not a reply (409); unknown session (404).

## On a schedule — `clim cron` (Autocron, app 1.34+)

Jobs the app runs on a schedule, instead of launchd, crontab or a `/loop` nobody can see. The Loop
window's **Autocron** tab shows the same list.

```bash
node "$CLI" cron new "Morning check" --schedule "0 9 * * 1-5" --cwd ~/code/api --agent claude --prompt "…"
node "$CLI" cron new "Nudge the loop" --mode attach --loop <loop project id> --schedule "@hourly" --prompt "…"
node "$CLI" crons     # next run · last run · problems
node "$CLI" cron show|edit|run|runs|pause|resume|rm <job>
```

- Five-field cron in the Mac's **local time**, or `@hourly`/`@daily`/`@weekly`/`@monthly`. A schedule
  that never matches (30 February) is refused.
- Runs missed while the Mac was off or asleep fold into one: `--missed once` (default — run once if within
  `--within <minutes>`), `skip`, or `notify`.
- **A job made through the API (clim) runs only while the Control API is on.** While it's off the job
  doesn't run and isn't caught up later; the list shows why. Jobs made in the app window always run.
- Names are unique (case ignored). An `attach` run types nothing if the loop's input box already has
  text or a question is on screen — it records `failed` instead.
- `cron run` exits 1 when the run failed. Make test jobs with `--off` and remove them afterwards.
