# Template: your own process skill on top of `climanager-session`

`climanager-session` only knows how to **drive** sessions — open, type, wait, read. It does not know
*what* you want done, *when* to stop and ask you, or *what* you want to see at the end. That part is
yours. Copy this file into a new skill (for example `~/.claude/skills/my-agent-ops/SKILL.md`), keep the
cases you actually repeat, and delete the rest.

Start from what you have already done two or three times. A case you have never run is a guess.

## 1. Pick the case first

| Case | You say | Ends with |
| --- | --- | --- |
| **Batch** — the same kind of work across several projects (e.g. "fix the open bug reports in A, B and C overnight") | "run the bug sweep on A, B, C" | one summary page |
| **Queue** — items you wrote down earlier (an issue tracker, a to-do list, a stand-up board) | "do items 3 and 5" | one summary page |
| **Audit** — read-only checks whose output is a report (security, error tracking, code review) | "audit X" | one summary page |
| **Fan-out** — one brief, many targets ("upgrade each of these 12 templates") | "apply BRIEF.md to every target" | per-target result |
| **Review** — judge someone else's branch or output, no edits | "review branch X" | a verdict |
| **Long solo task** — one brief, run to the end | "build the prototype in BRIEF.md" | the deliverable |

## 2. For each case, write down four things

### Before starting — ask **once**, then stop asking

List what you confirm up front so the agent never has to interrupt you later:

- which projects / items
- what it may ship on its own (e.g. "small UI fixes that match the report: merge and deploy")
- the lines it must not cross (data migrations, schema changes, production data writes, anything
  needing a login it doesn't have)
- how many sessions at once (heavy test suites, not agents, are what overload a machine)

Make the machine checks a **script**, not a judgement. Judgement forgets one item every time:
app reachable (`clim doctor`), sleep prevented, load and disk below your limits, repositories clean.

### While running

- Wait with `clim watch` in the background; react only when a session goes idle or asks something.
- Give sessions that share a repository an order (B merges after A's deploy is ready).
- When you decide something for a session, **write the decision down outside the session** (a note on
  the item, a log file). When the session is closed its screen history is gone, and so is the answer
  to "who approved this?".

### Where it stops

Name the exact situations that go back to you. Everything else proceeds. If the list is longer than
four lines, the case is not well defined yet.

### How it ends

One page you can read in a minute: one row per session — status, a one-line result, a link to the
report or review it produced — plus the open questions with options to choose from. Ask each session
to end with a fixed marker line (for example `RESULT: <one line>`) so the page can be built
mechanically from the screens instead of by re-reading everything.

## 3. Keep it honest

- After each real run, update the case with what went wrong. Two corrections of the same kind mean a
  missing step.
- Keep project names, paths and accounts in your own skill — never in `climanager-session` itself.
