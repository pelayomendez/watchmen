# watchmen

> *Quis custodiet ipsos custodes?* Who watches the watchmen? Here: you do, through the charter.

An assistant session that runs beside your working sessions and keeps track of everything going on: the tickets you own, the merge requests waiting on review, the worker sessions implementing slices, the todos you handed it. It tells you what needs you, what is moving, and what is waiting, and stays quiet otherwise.

```
 your work sessions                    watchmen (always open, beside them)
 ┌─ NRV-11249 ─────────┐               ┌─ ⚛ watchmen ──────────────────────────┐
 │ implementing…       │               │ Needs you (2)                          │
 └─────────────────────┘               │   ◆ [mr] !412 frames — 2 new comments  │
 ┌─ NRV-12513 ─────────┐               │   • [todo] Review deck v3              │
 │ waiting on backend  │               │ Moving (1)                             │
 └─────────────────────┘               │   • [session] NRV-11249 — slice 2/4    │
     Jira · GitLab · handoffs ───────▶ │ Waiting (1)                            │
                                       │   • [jira] NRV-11560 — backend fields  │
                                       └────────────────────────────────────────┘
```

It runs the [`ambient-companion`](https://github.com/pelayomendez/pelayo-skills/tree/main/skills/productivity/ambient-companion) process under a charter of what it may do alone, must ask first, and never does. It never writes product code and never acts in your other sessions; it watches, sorts, and asks.

## Use it

```bash
git clone https://github.com/pelayomendez/watchmen
npx skills@latest add pelayomendez/pelayo-skills   # the ambient-companion skill
ln -s "$PWD/watchmen/bin/watchmen" ~/.local/bin/watchmen
cd <your workspace>
watchmen
```

Or install the plugin alone with `/plugin install watchmen --marketplace pelayomendez/watchmen`; the launcher is still what starts the watch.

The launcher starts a session named `watchmen`, briefs it with the persona, the newest `.companion/handoff-*.md` and where the skill lives, and loads this plugin. The plugin stays silent in every session the launcher did not start, so it is safe to install globally.

`WATCHMEN_PRINT_BRIEFING=1 watchmen` prints the briefing without starting a session.

## The board

Items are deliberately loose. An item is a title in a lane, with an optional free `kind` label, note, link, and **check**: any host command whose output tells the item's state. watchmen knows nothing about Jira or GitLab; the check does.

| Lane | Means |
|---|---|
| `needs-you` | you must act or decide |
| `moving` | it advances without you |
| `waiting` | it waits on someone else |
| `done` | kept until dropped; no longer checked |

Every 15 seconds the plugin runs the checks that are due (each on its own interval: 5 minutes by default, never under 1 minute, never two at once). The first output is the baseline. When a later output differs, the item is marked changed (◆), a toast says so, and the watch calls `board_changes` and triages: it moves the item to its lane with a one-line note. A failing check only writes the failure into the note.

Tell the watch what to track in plain words ("keep an eye on NRV-123 and MR 42"), and it adds items with `board_track`. Check recipes:

| Track | Check (`argv`) |
|---|---|
| A Jira ticket's status | `["acli", "jira", "workitem", "view", "NRV-123", "--fields", "status"]` |
| A GitLab MR's state and approvals | `["sh", "-c", "glab mr view 42 -F json \| jq -r '[.state, .detailed_merge_status] \| join(\" \")'"]` |
| A GitHub PR | `["gh", "pr", "view", "7", "--json", "state,reviewDecision", "-q", ".state + \" \" + .reviewDecision"]` |
| Another session, by its handoff | `["sh", "-c", "tail -1 ../other-repo/.companion/handoff-*.md"]` |
| A branch moving | `["git", "ls-remote", "origin", "refs/heads/main"]` |
| A todo | no check: it stays where you put it |

The model's tools are `board_track`, `board_move`, `board_drop` and `board_changes`. The board is kept in `.companion/board.json`, so the next watch picks it up.

## What you see

- **The pane**, `⚛ watchmen`: the lanes with their items, changed ones marked ◆ and bold. It opens by itself beside the transcript in the fullscreen layout; on the main screen, `/watchmen` opens it.
- **The status line**: `⚛ watchmen · 2 need you · 1 moving · 1 changed · 42% · 3h07`. At 75% context it asks for a handoff before the window fills.
- **Toasts**: one when an item changes, one when the watch runs long.
- **`/watchmen`** opens the pane and prints the board; `/watchmen brief` prints it grouped by lane; `/watchmen track <title>` adds a todo to needs-you.

In [herdr](https://herdr.dev), give the watch its own tab and keep your working sessions in the others.

## Layout

| Path | What |
|---|---|
| `bin/watchmen` | Launcher: finds the skill and the newest handoff, builds the briefing, starts the session |
| `prompts/persona.md` | Who the watch is, and how it triages the board |
| `hooks/board.ts` | The board's rules: tracking, checks, change detection, lanes |
| `hooks/register.tsx` | Wiring: state, timer, checks, tools, `/watchmen`, the pane, the status line |
| `hooks/watchmen.test.ts` | `claude plugin test .` |

Why the persona is in the launcher and not the plugin: Claude Code's built-in security plugin bypasses a user-installed plugin's changes to the system prompt, so the launcher passes it with `--append-system-prompt`.

## Next

- **A decision inbox**: each needs-you item carries the answers it allows (accept, edit, respond, ignore).
- **A two-part handoff**: a hook writes the board's facts, the model adds the judgement.
- **Events over polling**: subscribe to herdr's agent events instead of checking on a timer.

## License

MIT
