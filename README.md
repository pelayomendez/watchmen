<p align="center"><img src="assets/icon.png" width="160" alt=""></p>

# watchmen

[Website](https://pelayomendez.github.io/watchmen/) · [Changelog](CHANGELOG.md)

> *Quis custodiet ipsos custodes?* Who watches the watchmen? Here: you do, through the charter.

**Tell it what to watch. It tells you what needs you.**

watchmen is an assistant for your work, as a Claude Code plugin. You tell it what to keep an eye on: a merge request, a review comment, a worker session, a ticket, a todo. It keeps the list, checks each item, and comes back to you only when something needs you; the rest it sorts into what is moving and what is waiting, and stays quiet. It remembers how you like to hear from it.

It is one Claude Code session, the watch, beside your working ones, in a terminal or in the Claude desktop app. The board is what it looks after; the charter is how far you trust it. Its persona tells it never to write product code or act in your other sessions: it watches, sorts and asks.

```
 your work sessions                    the watch
 ┌─ ABC-101 ───────────┐               ┌─ ⚛ watchmen ──────────────────────────┐
 │ implementing…       │  /watchmen    │ Needs you (2)                          │
 └─────────────────────┘     park ───▶ │   ◆ [mr] !42 frames — 2 new comments   │
 ┌─ ABC-102 ───────────┐               │   • [todo] Update plan v3              │
 │ /watchmen take …    │ ◀─── take     │ Moving (1)                             │
 └─────────────────────┘               │   • [session] ABC-101 — slice 2/4      │
   gh · glab · acli · handoffs ──────▶ │ Waiting (1)                            │
                                       │   • [jira] ABC-103 — backend fields    │
                                       └────────────────────────────────────────┘
```

## Install

As a Claude Code plugin, from this repository as a marketplace:

```
/plugin marketplace add pelayomendez/watchmen
/plugin install watchmen@pelayomendez-watchmen
```

It is safe to install globally: in every session but the watch it only offers `/watchmen start`, `park` and `take`, and its board tools stay off.

Requirements:

- [Claude Code](https://code.claude.com) 2.1.287 or newer (plugin hooks modules), Node.js 20 or newer, and bash.
- The `ambient-companion` skill, the watch's process. The plugin looks for it in `WATCHMEN_SKILL`, `~/.claude/skills/ambient-companion/`, `~/.agents/skills/ambient-companion/`, then any `pelayo-skills` bucket in the plugin cache. Without it the watch says so and works from its persona and the last handoff.
- Optional: the CLIs your checks call (`gh`, `glab`, `acli`…). They are also what discovery uses.
- Optional: [herdr](https://herdr.dev) 0.9 or newer (0.9.5 recommended), on macOS or Linux, for summon, follow mode and the sidebar token.

### The launcher (optional)

In a terminal you can also start the watch with the `watchmen` launcher, which starts a session named `watchmen` on `sonnet` with the briefing as its system prompt:

```bash
git clone https://github.com/pelayomendez/watchmen
ln -s "$PWD/watchmen/bin/watchmen" ~/.local/bin/watchmen
cd <your workspace> && watchmen
```

`WATCHMEN_PRINT_BRIEFING=1 watchmen` prints the briefing without starting a session.

## A day with watchmen

**1. Start the watch.** Open a session in your workspace folder, the one whose `.companion/` will hold the board and the handoffs, and type `/watchmen start` (or press `⚛ watchmen · start` in the footer, or run `watchmen` in a terminal). That session becomes the watch. It reads the last handoff and your preferences, and runs a few read-only lookups to propose what to watch:

> You have 3 open PRs and 2 reviews waiting on you. Watch them?

It adds only what you accept. The workspace is fixed at start, and the watch survives a restart of Claude Code: a resumed session (`claude --resume`, or after an update) is the watch again, of the same workspace.

**2. Hear the brief.** Once a day, at 9 or at `WATCHMEN_BRIEF_HOUR`, it gives you the day's brief without being asked: what needs you first, then what moved. Come back after an hour or more and the band says what happened meanwhile, `since you looked: 1 need you · 3 moved`, until you type again. Otherwise it talks to you in sentences, and only when something lands in needs-you.

**3. Approve its checks.** Each item can carry a check, a command whose output tells its state (`glab mr view 42`, `gh pr view 7`, `acli jira workitem view ABC-123`). No check runs until you approve that exact command. Type `/watchmen approve all` to see every waiting check and one hash over that set, then `/watchmen approve all <hash>` to approve exactly those. Approvals count when typed in a terminal or through Remote Control, not yet in the desktop app.

**4. Park and take.** Done for now with a session whose work waits on someone? Type `/watchmen park` in it: it writes a handoff, the watch puts it on the board with the command to resume it, and you close the session. When you want to work on an item, type `/watchmen take <id>` in any other session: the item arrives as your first message, and the watch marks it as being worked on there.

Tell the watch anything else in plain words: "keep an eye on MR 42", "remind me to update the plan", "stop telling me about CI flakes".

## Commands

| Command | Where | What it does |
|---|---|---|
| `/watchmen start` | any session | Makes this session the watch of its folder. The footer's `⚛ watchmen · start` does the same, unless a running watch already covers the folder: then a toast names it and points at `take`. |
| `/watchmen park [waiting\|todo] [note] [--to <workspace>]` | any session but the watch | Hands this session to the watch: a handoff, a board item, and you close it. |
| `/watchmen take [id] [--to <workspace>]` | any session but the watch | Alone, lists the open items of the watch that covers this folder; with an id, works on that item here. |
| `/watchmen` | the watch | Opens the board pane and prints the board, the handoff, the skill and the context fill. |
| `/watchmen brief` | the watch | Prints the board grouped by lane. |
| `/watchmen track <title>` | the watch | Adds a todo to needs-you. |
| `/watchmen approve <id> <hash>` | the watch | Lets that item's exact check run, in this workspace. |
| `/watchmen approve all [<hash>]` | the watch | Lists every waiting check with one hash over the set; with the hash, approves exactly that set. |
| `/watchmen band` | the watch | Hides or shows the band. |
| `/watchmen reload`, `/watchmen reset` | the watch | Recovers from an unreadable `board.json`: read it again, or write it from the board in memory. |

`start`, `park`, `take` and `approve` count only when you type them; the model and other plugins are refused.

## Safety

- **Approvals.** A check is a command on your machine, and a `board.json` in a repo or a prompt-injected `board_track` call could name any command. So each new command waits, marked `⚠ check awaiting approval`, until you approve it. The hash names exactly the command you read; a command changed since is refused, and `approve all` is refused if the set changed in between. Approval is per exact command and workspace, kept across sessions. The model cannot approve.
- **Read-only discovery.** The lookups that propose what to watch are shipped with the plugin, never chosen by the model, and run only where their CLI is installed: your open GitHub PRs and the reviews asked of you (`gh search prs`), the same on GitLab (`glab api`, asked of each host in glab's config by name, at most three, gitlab.com only with a token of its own; tokens are never read out), your Jira work in progress (`acli jira workitem search`), and how many Claude sessions were active in this folder, below it or in sibling folders with the same prefix (`repo-TICKET` beside `repo`) in the last three hours. Only pull and merge requests updated in the last 60 days count, at most 15 items. Nothing found runs a check before you approve it.
- **Titles are data.** What discovery finds reaches the watch as the plugin's own message, titles JSON-quoted, never as your words. The wake message has a fixed wording; item titles reach the model only as tool data. A parked session's title, note and handoff are validated as untrusted (cleaned, capped, links http(s) only, the handoff inside the parked folder), and a taken item's fields are quoted. Commands and parked titles with hidden characters (format, bidi and other invisible code points) are refused, so an approval line shows exactly what runs.
- **The charter.** The watch runs the `ambient-companion` process under a charter of what it may do alone, must ask first, and never does, recorded in its handoff; with no handoff yet it starts by asking you for the work, its sources and the charter. It is instructed to put anything beyond the charter in needs-you as a question, to hand real tasks (write, fix, research, review) to a subagent, and never to start sessions itself. These are instructions to the model; the approvals above are what the plugin enforces.

## What you see

- **The footer button.** In the watch, `⚛ watchmen` in blue beside the session's modes, with a red count when something needs you (`⚛ watchmen · 2`); it opens the board pane with the keyboard, and Escape closes it. In every other session it reads `⚛ watchmen · start`.
- **The band.** One slim row above the prompt in the watch, a glance with nothing to press: the mascot, the lane counts (needs you red, moving blue, waiting dim), what happened since you looked, and the watch's own figures (`42% · idle 12m`, which turn into `write the handoff` at 75%). It shortens as the terminal narrows.
- **The pane.** `⚛ watchmen`, opened by the footer button or `/watchmen`, and docked by itself in the fullscreen layout:

  ```
    ▄▀▄▄▄▄▄▄▄▀▄      watchmen
    █   ·⊛·   █      Tell it what to watch.
    █  ◉   ◉  █      It tells you what needs you.
    ▀▄   ▾   ▄▀
      ▀▀▙▄▟▀▀        [ brief ] [ + watch ] ↻

  Needs you (2)
    ◆ mr !42 frames — two review comments
      todo Update plan v3

  Moving (1)
      jira Import slice 2/4 — worker running
        would run: ["acli","jira"]
        to approve: /watchmen approve ABC-1 88c580cb16ea2e4b

  Waiting (1)
      jira Backend fields for frames
        waiting on the backend team to add the new frame fiel…
  ```

  `brief` asks for a brief, `+ watch` starts a "Watch …" request, `↻` runs every check now. Done folds into its count past three items. Click an item's title to put `about <id>: ` in the prompt and talk about it.
- **The desktop widget.** In the Claude desktop app, `/watchmen start` opens the pane as a small widget: the mascot, the lane counts and the first thing that needs you; expand it for the whole board. In a terminal the pane stays closed until you open it.
- **The mascot.** A hydrogen atom (`assets/atom.svg`), blue when calm, its electron amber when something changed, red when something needs you; the `⚛` glyph in a terminal.
- **Notifications.** An item the watch moves into needs-you raises a native notification (and a herdr one inside herdr); quiet changes stay in the item's note.

## It remembers you

The watch keeps your standing preferences in `.companion/about-you.md`, one line each: "CI flakes don't matter", "comments from the design team do", "brief me at 9 in three lines". It reads the file when the watch begins and adds or edits a line when you correct how it reports. What you said does not matter goes to moving or waiting, never to needs-you. When you have it drop two items of the same kind from needs-you, it asks once whether to stop raising that kind, and notes the answer. It never writes secrets, credentials or anything about other people there; the file is yours to edit.

## The board

An item is a title in a lane, with an optional free `kind` label, note, link and check. watchmen knows nothing about Jira or GitLab; the check does.

| Lane | Means |
|---|---|
| `needs-you` | you must act or decide |
| `moving` | it advances without you |
| `waiting` | it waits on someone else |
| `done` | kept until dropped; no longer checked |

Every 15 seconds the plugin runs the approved checks that are due, each on its own interval (5 minutes by default, never under 1 minute, never two runs of the same check at once). The first output is the baseline; when a later one differs, the item is marked changed (◆) and the watch wakes by itself with `◆ 2 items changed — call board_changes`, at most once every three minutes and never while a turn runs or while you are typing. It reads what each check says now and moves each item to its lane with a one-line note. A failing check shows `⚠ check failed` and leaves the note alone.

Check recipes:

| Track | Check (`argv`) |
|---|---|
| A Jira ticket's status | `["acli", "jira", "workitem", "view", "ABC-123", "--fields", "status"]` |
| A GitLab MR's state and approvals | `["sh", "-c", "glab mr view 42 -F json \| jq -r '[.state, .detailed_merge_status] \| join(\" \")'"]` |
| A GitHub PR | `["gh", "pr", "view", "7", "--json", "state,reviewDecision", "-q", ".state + \" \" + .reviewDecision"]` |
| Another session, by its handoff | `["sh", "-c", "tail -1 ../other-repo/.companion/handoff-*.md"]` |
| A branch moving | `["git", "ls-remote", "origin", "refs/heads/main"]` |
| A todo | no check: it stays where you put it |

The model's tools are `board_track`, `board_move`, `board_drop` and `board_changes`, available only in the watch. The board lives in `.companion/board.json` of the workspace (written through a temp file and a rename), so the next watch picks it up. If it cannot be read, it is copied to a timestamped `board.json.<time>.bak` and never written over until you `/watchmen reload` or `/watchmen reset`.

**Rotation.** The prompt cache lasts an hour. When the watch has been idle 50 minutes and its conversation has grown 40k tokens past its fresh start, it writes its handoff, the conversation is cleared, and it resumes from that handoff, so the next wake finds a small conversation.

**Models.** The launcher runs the watch on `sonnet` (`WATCHMEN_MODEL`); `/watchmen start` keeps the session's model. Either way a task you ask it to perform goes to a subagent on `opus` (`WATCHMEN_TASK_MODEL`; `haiku`, `sonnet`, `opus` or `fable`).

## Park and take, in detail

```
/watchmen park                      # the session decides: waiting if it waits on something, else a todo in needs-you
/watchmen park waiting ask Ana Monday
/watchmen park --to ~/dev           # several watches run and none covers this folder: pick one
```

1. The session writes a handoff to `${XDG_STATE_HOME:-~/.local/state}/watchmen/parked/<date>-<session>.md`: what is done, what is left, what it waits on and from whom, how to resume. A short front matter gives its title, lane, what it waits on, a link, and optionally a check that tells when the wait is over.
2. When that turn ends with the file written, the plugin drops an entry in `…/watchmen/inbox/` and says `Parked in watchmen. You can close this session.` It gives up after ten minutes without a handoff.
3. A watch covers a parked session when its workspace holds the session's folder, or its repository: a git worktree such as `repo-TICKET` beside `repo` is covered by a watch over `repo` or above. The covering watch (the deepest, under nested watches) takes it onto the board as a `session` item whose note ends with `cd <folder> && claude --resume <session id>`, and tells you in a sentence. When its check changes, the item is marked changed and the watch moves it to needs-you once the wait is over.

When no running watch covers the folder: with one watch running, the park goes there and says so; with several, `/watchmen park` lists them and asks for `--to <workspace>`; with none, it suggests a parent folder to `/watchmen start` in, and the park waits in the inbox, shown as a dim line in every watch (`1 parked session waits for a watch in ~/dev/repo`).

`/watchmen take <id>` finds the watch the same way and sends the item (title, kind, lane, note, link), quoted as data, as your first message; a parked item's handoff is named as the file to read first. While a parked item's note still has its resume line, `take` prints that line instead and sends nothing: resume it where it was. The taking session never writes the board: it drops a take record in the inbox, and the watch moves the item to moving with `worked on in session <id> (<folder>)`.

## On the desktop

The Claude desktop app cannot run the launcher, so start the watch from inside a session there: install the plugin, open a session in your workspace folder, and type `/watchmen start` or press `⚛ watchmen · start`. `start`, `park` and `take` count when typed in the desktop app.

**Approving checks.** `/watchmen approve` counts only when typed in a terminal or through Remote Control; typed in the desktop app it is refused for now. So for a watch on the desktop, approve through Remote Control. It must reach the watch session itself: in a session that is not the watch, `/watchmen approve` only says how to start one.

## The board outside Claude

`watchmen board` is a read-only viewer of `.companion/board.json` for a terminal of its own: lanes in order, each item with its label, note, how long ago it changed, its link, and a failing or unapproved check. It redraws when the file changes, never writes, respects `NO_COLOR`, and `--once` prints the board and exits.

It finds the board in this order: a path given as an argument; `WATCHMEN_BOARD`; under herdr, the nearest `.companion/board.json` at or above the focused pane; a `.companion` folder in the current directory; then the folder the last `watchmen` launcher started in (`${XDG_STATE_HOME:-~/.local/state}/watchmen/current`, marked `(stale)` when that watch is gone).

## In herdr

The repo is also a [herdr](https://herdr.dev) plugin (macOS and Linux, herdr 0.9 or later). It installs nothing; its install checks that node and claude are there:

```bash
herdr plugin install pelayomendez/watchmen      # pin a release tag with --ref
# or, from a clone:
herdr plugin link ~/path/to/watchmen
```

Bind `summon` in `~/.config/herdr/config.toml`:

```toml
[[keys.command]]
key = "prefix+m"
type = "plugin_action"
command = "pelayomendez.watchmen.summon"
description = "summon the watch"
```

- **Summon.** With no watch running, it splits the current tab on the right and starts the `watchmen` launcher there, in the folder the last launcher started in, else the focused pane's; with the watch in another tab of the same space, it moves it beside you; pressed again, it sends the watch back to a tab of its own labelled "watchmen". It finds only a watch the launcher started (and labelled); a watch started with `/watchmen start` inside herdr is not summoned, and a watch in another space is not moved.
- **Follow mode.** Summoning turns it on: each tab you focus in the same space brings the watch beside you as a right split, your pane keeping focus and 70% of the tab (`WATCHMEN_RATIO`, 0.1 to 0.9). Sending it home turns it off. Summon also starts a small follower process (`scripts/herdr-follower.mjs`) that subscribes to `tab.focused` on the herdr socket, since herdr before 0.9.5 does not run plugin hooks on UI tab switches.
- **Sidebar token.** The watch publishes `$watchmen` for its space (`⚛ 2 need you`, `⚛ 1 changed`, `⚛ quiet`), refreshed every 15 seconds with a 45-second time to live:

  ```toml
  [ui.sidebar.spaces]
  rows = [["state_icon", "workspace"], ["branch", "git_status"], ["$watchmen"]]
  ```

  For colour, use the three state tokens instead, of which only the current one carries text:

  ```toml
  [ui.sidebar.spaces]
  rows = [["state_icon", "workspace"], ["branch", "git_status"], [{ token = "$watchmen_alert", fg = "#E5484D", bold = true }, { token = "$watchmen_changed", fg = "#F5A524" }, { token = "$watchmen_quiet", dim = true }]]
  ```
- **Board list.** `pelayomendez.watchmen.toggle-board` opens the read-only board list in a split instead of the conversation.

Inside herdr the launcher labels its pane `watchmen` and records it under `${XDG_STATE_HOME:-~/.local/state}/watchmen/panes/<pane id>`; follow and summon judge a labelled pane by that record, so a stale pane is cleared rather than trusted.

## Layout

| Path | What |
|---|---|
| `hooks/register.tsx` | Wiring: state, timer, checks, tools, the `/watchmen` commands, the footer button, the pane and its widget, the band, rotation, restart recovery |
| `hooks/board.ts` | The board's rules: tracking, checks, change detection, lanes, the brief and since-you-looked |
| `hooks/briefing.ts` | The briefing `/watchmen start` sends |
| `hooks/discover.ts` | The read-only discovery lookups and their parsing |
| `hooks/park.ts`, `hooks/take.ts` | Park and take: inbox entries, validation, coverage, the take prompt |
| `prompts/persona.md` | Who the watch is, and how it triages |
| `bin/watchmen` | The launcher: the same briefing in bash, then `claude --append-system-prompt` |
| `bin/watchmen-board`, `bin/board-render.mjs` | The read-only board viewer |
| `herdr-plugin.toml`, `scripts/herdr-*` | The herdr plugin |
| `hooks/watchmen.test.ts`, `test/*.test.mjs` | Tests |

Why the persona is not in the system prompt through the plugin: Claude Code's built-in security plugin bypasses a user-installed plugin's changes to the system prompt, so the launcher passes it with `--append-system-prompt`, and `/watchmen start` sends it as the session's first message.

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

CI runs all three on every pull request. To release: bump `version` in both `.claude-plugin/plugin.json` and `herdr-plugin.toml`, move the Unreleased notes in `CHANGELOG.md` under it, merge, then on main `claude plugin tag --push` (tag `watchmen--v<version>`) and `git tag v<version> && git push origin v<version>` for herdr's `--ref`. The website is `docs/index.html`, generated from a separate brand repository (do not edit it by hand), and served by GitHub Pages from `main`.

## Next

- **A decision inbox**: each needs-you item carries the answers it allows (accept, edit, respond, ignore).
- **A two-part handoff**: a hook writes the board's facts, the model adds the judgement.
- **Events over polling**: subscribe to herdr's agent events instead of checking on a timer.

## License

MIT
