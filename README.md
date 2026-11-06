<p align="center"><img src="assets/icon.png" width="160" alt=""></p>

# watchmen

[Website](https://pelayomendez.github.io/watchmen/) · [Changelog](CHANGELOG.md)

> *Quis custodiet ipsos custodes?* Who watches the watchmen? Here: you do, through the charter.

An assistant session that runs beside your working sessions and keeps track of everything going on: the tickets you own, the merge requests waiting on review, the worker sessions implementing slices, the todos you handed it. It tells you what needs you, what is moving, and what is waiting, and stays quiet otherwise.

```
 your work sessions                    watchmen (always open, beside them)
 ┌─ APP-11249 ─────────┐               ┌─ ⚛ watchmen ──────────────────────────┐
 │ implementing…       │               │ Needs you (2)                          │
 └─────────────────────┘               │   ◆ [mr] !412 frames — 2 new comments  │
 ┌─ APP-12513 ─────────┐               │   • [todo] Review deck v3              │
 │ waiting on backend  │               │ Moving (1)                             │
 └─────────────────────┘               │   • [session] APP-11249 — slice 2/4    │
     Jira · GitLab · handoffs ───────▶ │ Waiting (1)                            │
                                       │   • [jira] APP-11560 — backend fields  │
                                       └────────────────────────────────────────┘
```

It runs the [`ambient-companion`](https://github.com/pelayomendez/pelayo-skills/tree/main/skills/productivity/ambient-companion) process under a charter of what it may do alone, must ask first, and never does. It never writes product code and never acts in your other sessions; it watches, sorts, and asks.

## Requirements

- [Claude Code](https://code.claude.com) 2.1.287 or newer (plugin hooks modules)
- Node.js 20 or newer, and bash
- The [`ambient-companion`](https://github.com/pelayomendez/pelayo-skills) skill: `npx skills@latest add pelayomendez/pelayo-skills`
- Optional: [herdr](https://herdr.dev) 0.9 or newer (0.9.5 recommended) for summon, follow and the sidebar token; macOS or Linux
- Optional: whatever CLIs your checks call (`acli`, `glab`, `gh`…)

## Use it

```bash
git clone https://github.com/pelayomendez/watchmen
npx skills@latest add pelayomendez/pelayo-skills   # the ambient-companion skill
ln -s "$PWD/watchmen/bin/watchmen" ~/.local/bin/watchmen
cd <your workspace>
watchmen
```

Or install the plugin from this repository as a marketplace; the launcher is still what starts the watch:

```
/plugin marketplace add pelayomendez/watchmen
/plugin install watchmen@pelayomendez-watchmen
```

The launcher starts a session named `watchmen`, briefs it with the persona, the newest `.companion/handoff-*.md` and where the skill lives, and loads this plugin. The plugin stays silent in every session the launcher did not start, so it is safe to install globally.

`WATCHMEN_PRINT_BRIEFING=1 watchmen` prints the briefing without starting a session.

**Models.** The watch stays on all day, so it runs on `sonnet`; a task you ask it to perform goes to a subagent on `opus`, and only that subagent costs the stronger model. `WATCHMEN_MODEL` and `WATCHMEN_TASK_MODEL` (`haiku`, `sonnet`, `opus`, `fable`) change them.

## The board

Items are deliberately loose. An item is a title in a lane, with an optional free `kind` label, note, link, and **check**: any host command whose output tells the item's state. watchmen knows nothing about Jira or GitLab; the check does.

| Lane | Means |
|---|---|
| `needs-you` | you must act or decide |
| `moving` | it advances without you |
| `waiting` | it waits on someone else |
| `done` | kept until dropped; no longer checked |

**A check runs only after you approve it.** A check is a command on your machine, and a board.json in a repo or a prompt-injected `board_track` call could name any command, so each new command waits, marked `⚠ check awaiting approval`, until you type `/watchmen approve <id> <hash>` yourself. `/watchmen brief` and the item show the command and its short hash; the hash names exactly the command you read, so a command changed since then is refused. Approval is per exact command and workspace, kept across sessions; the model cannot approve.

Every 15 seconds the plugin runs the checks that are due (each on its own interval: 5 minutes by default, never under 1 minute, never two at once). The first output is the baseline. When a later output differs, the item is marked changed (◆), a toast says so, and the watch calls `board_changes` and triages: it moves the item to its lane with a one-line note. A failing check shows `⚠ check failed` beside the item and leaves its note alone. A change is detected on the whole output; only its first 2,000 characters are kept for display.

Tell the watch what to track in plain words ("keep an eye on APP-123 and MR 42"), and it adds items with `board_track`. Check recipes:

| Track | Check (`argv`) |
|---|---|
| A Jira ticket's status | `["acli", "jira", "workitem", "view", "APP-123", "--fields", "status"]` |
| A GitLab MR's state and approvals | `["sh", "-c", "glab mr view 42 -F json \| jq -r '[.state, .detailed_merge_status] \| join(\" \")'"]` |
| A GitHub PR | `["gh", "pr", "view", "7", "--json", "state,reviewDecision", "-q", ".state + \" \" + .reviewDecision"]` |
| Another session, by its handoff | `["sh", "-c", "tail -1 ../other-repo/.companion/handoff-*.md"]` |
| A branch moving | `["git", "ls-remote", "origin", "refs/heads/main"]` |
| A todo | no check: it stays where you put it |

**The watch comes to you.** When checks change, the plugin starts a turn in the watch session by itself (`$.prompt.submit`) with `◆ 2 items changed — call board_changes` (a fixed wording: the titles reach the model only as tool data): at most one wake every three minutes, changes in between batched into the next, and never while a turn runs or while you have something typed in the prompt. The watch moves each item to its lane with a one-line note. An item that lands in needs-you raises a native notification and, inside herdr, a herdr notification, so you see it from any tab; quiet changes stay in the item's note.

The model's tools are `board_track`, `board_move`, `board_drop` and `board_changes`. The board is kept in `.companion/board.json` (written through a temp file and a rename), so the next watch picks it up. If the file cannot be read, it is copied to a timestamped `board.json.<time>.bak` (earlier backups are never replaced) and never written over until you fix it and `/watchmen reload`, or start over with `/watchmen reset`.

## What you see

- **The band**: one slim row above the prompt in the watch session: the mascot, the lane counts (needs you in red, moving in cyan, waiting dim), and two buttons, `board` (opens the board pane; Escape closes it) and `hide` (hidden until `/watchmen band` or the next session). It shortens its words, then drops the buttons and the other counts, as the terminal narrows.
- **The mascot**: a hydrogen atom, one nucleus, one orbit, one electron (`assets/atom.svg`, drawn for this project), coloured by state: blue when calm, the electron amber when something changed, red when something needs you. Surfaces that draw SVG (the desktop app, the editor) show the picture; a terminal has no SVG element, so there it is the `⚛` glyph in the state's colour.

- **The pane**, `⚛ watchmen`: the lanes with their items, changed ones marked ◆ and bold. It opens by itself beside the transcript in the fullscreen layout; on the main screen, `/watchmen` opens it.
- **The watch's own figures**, dim at the end of the band: `42% · idle 12m`, its context fill and how long since its last turn. At 75% they turn into `write the handoff`.
- **Rotation.** The prompt cache lasts an hour; a wake after that pays to cache the whole conversation again. So when the watch has been idle 50 minutes and its conversation has grown 40k tokens past its fresh start, it writes its handoff, the conversation is cleared, and it resumes from that handoff: the next wake finds a small conversation. A turn that wrote no handoff, or a refused clear, leaves the watch as it was.
- **Toasts**: one when an item changes, one when the watch runs long.
- **`/watchmen`** opens the pane and prints the board; `/watchmen brief` prints it grouped by lane; `/watchmen band` shows a hidden band again; `/watchmen track <title>` adds a todo to needs-you; `/watchmen approve <id> <hash>` lets an item's check run; `/watchmen reload` and `/watchmen reset` recover from an unreadable board.json.

## The board outside Claude

`watchmen board` is a read-only viewer of `.companion/board.json` for a terminal of its own: lanes in order (NEEDS YOU, MOVING, WAITING, DONE as a count), each item with its label, note, how long ago it changed, its link, and a failing or unapproved check. It redraws when the file changes and when the terminal resizes, never writes, respects `NO_COLOR`, and exits cleanly on Ctrl-C. `--once` prints the board and exits.

It finds the board in this order: a path given as an argument; `WATCHMEN_BOARD`; under herdr, the nearest `.companion/board.json` at or above the pane the panel was opened from (`focused_pane_cwd`); a `.companion` folder in the current directory (never the plugin's own folder, where herdr starts the panel); then the folder the last `watchmen` started in. The launcher records that folder and its process id in `${XDG_STATE_HOME:-~/.local/state}/watchmen/current`, and the header says `(stale)` when that watch is no longer running.

## In herdr

The repo is also a [herdr](https://herdr.dev) plugin (macOS and Linux, herdr 0.9 or later). Its main action, `summon`, brings the watchmen session itself beside you, from whatever tab you are on: the companion follows you between your session tabs.

Install it from GitHub (pin a release with `--ref`), or link a clone. The install checks that node and claude are there and installs nothing:

```bash
herdr plugin install pelayomendez/watchmen --ref v0.2.0
herdr plugin link ~/path/to/watchmen
```

Bind a key in `~/.config/herdr/config.toml`:

```toml
[[keys.command]]
key = "prefix+m"
type = "plugin_action"
command = "pelayomendez.watchmen.summon"
description = "summon the watch"
```

`prefix+m` summons the companion beside you, and a second press sends it back:

- no watch running: it splits the current tab on the right and starts `watchmen` there, in the folder of the last watch or else the current pane's;
- the watch runs in another tab: it moves into the current tab as a right split, focused;
- the watch is in the current tab: it goes back to a tab of its own labelled "watchmen", still running.

`watchmen` labels its own pane `watchmen` when it starts inside herdr (`herdr pane rename`); that label is how the action finds it.

**Follow mode.** Summoning turns it on: from then on, each tab you focus in the same space brings the watch beside you there as a right split, and your own pane keeps focus. The split leaves you 70% of the tab; `WATCHMEN_RATIO` (0.1 to 0.9, your share) changes it. Sending the watch home turns it off.

herdr 0.9.0 does not run plugin event hooks on tab switches made in the UI, so summon also starts a small follower process (`scripts/herdr-follower.mjs`: detached, one at a time, its pid in `follower.pid`) that subscribes to `tab.focused` on the herdr socket. From herdr 0.9.5 the manifest's `tab.focused` hook fires on UI switches too. Both run the same follow step under one move lock: the step skips the tab the watch is already in and its own `watchmen` tab, stays within its space, and a run that had to wait for the lock decides from the tab focused once it holds it, so the last switch wins and one switch moves the pane once. The follower exits when follow turns off, the watch pane is gone, the watch's launcher has exited, or the socket closes. The state lives in `${XDG_STATE_HOME:-~/.local/state}/watchmen/follow`.

Inside herdr the launcher records each watch under `watchmen/panes/<pane id>` (claude's pid, as the launcher execs it, and the folder), and a move carries the record to the pane's new id. Follow and summon judge a labelled pane by its own record, so a watch started elsewhere never answers for it: when that pid is gone, follow stops and summon clears the leftover pane's label and starts a new watch.

To try the follower by hand, with the watch already running in herdr:

```bash
echo on > "${XDG_STATE_HOME:-$HOME/.local/state}/watchmen/follow"
node scripts/herdr-follower.mjs        # foreground; Ctrl-C to stop
```

**In the spaces sidebar.** Inside herdr the watch publishes a short token for its space, `$watchmen` (`⚛ 2 need you`, `⚛ 1 changed`, `⚛ quiet`), refreshed every 15 seconds with a 45-second time to live, so it disappears soon after the watch stops. Show it by adding the token to the sidebar's space rows in `~/.config/herdr/config.toml`:

```toml
[ui.sidebar.spaces]
rows = [["state_icon", "workspace"], ["branch", "git_status"], ["$watchmen"]]
```

For colour, use the three state tokens instead: only the one for the current state carries text (red and bold when something needs you, amber when something changed, dim when quiet). `herdr config check` accepts this row:

```toml
[ui.sidebar.spaces]
rows = [["state_icon", "workspace"], ["branch", "git_status"], [{ token = "$watchmen_alert", fg = "#E5484D", bold = true }, { token = "$watchmen_changed", fg = "#F5A524" }, { token = "$watchmen_quiet", dim = true }]]
```

A secondary action, `pelayomendez.watchmen.toggle-board`, opens the read-only board list in a split instead; bind it too if you want the list without the conversation. Without the plugin, run `watchmen board` in a pane of its own.

## Layout

| Path | What |
|---|---|
| `bin/watchmen` | Launcher: finds the skill and the newest handoff, builds the briefing, starts the session |
| `prompts/persona.md` | Who the watch is, and how it triages the board |
| `hooks/board.ts` | The board's rules: tracking, checks, change detection, lanes |
| `hooks/register.tsx` | Wiring: state, timer, checks, tools, `/watchmen`, the pane, the band, rotation |
| `hooks/watchmen.test.ts` | `claude plugin test .` |
| `bin/watchmen-board`, `bin/board-render.mjs` | The read-only board viewer and its pure rendering |
| `herdr-plugin.toml`, `scripts/herdr-*` | The herdr plugin: install check, summon the session, toggle the board list |
| `test/*.test.mjs` | `node --test test/*.test.mjs` |

Why the persona is in the launcher and not the plugin: Claude Code's built-in security plugin bypasses a user-installed plugin's changes to the system prompt, so the launcher passes it with `--append-system-prompt`.

## Update and uninstall

- Claude Code: `/plugin update watchmen@pelayomendez-watchmen`; `/plugin uninstall watchmen@pelayomendez-watchmen`.
- herdr: `herdr plugin update pelayomendez.watchmen`; `herdr plugin uninstall pelayomendez.watchmen`, then remove its key binding.
- The launcher: remove the `~/.local/bin/watchmen` link. The watch's state is in `${XDG_STATE_HOME:-~/.local/state}/watchmen` and each workspace's `.companion/`.

## Develop

```bash
claude plugin validate --strict .
claude plugin test .
node --test test/*.test.mjs
```

CI runs all three on every pull request. To release: bump `version` in both `.claude-plugin/plugin.json` and `herdr-plugin.toml`, move the Unreleased notes in `CHANGELOG.md` under it, merge, then on main `claude plugin tag --push` (tag `watchmen--v<version>`) and `git tag v<version> && git push origin v<version>` for herdr's `--ref`.

## Next

- **A decision inbox**: each needs-you item carries the answers it allows (accept, edit, respond, ignore).
- **A two-part handoff**: a hook writes the board's facts, the model adds the judgement.
- **Events over polling**: subscribe to herdr's agent events instead of checking on a timer.

## License

MIT
