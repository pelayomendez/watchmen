# Plan: watchmen as your assistant, on the desktop

## Why

watchmen is an assistant for work: you tell it what to watch (an MR, a comment, a session, a todo),
it keeps the list, checks each item, and tells you what needs you. Today it starts only from the
terminal launcher (`watchmen`), which passes `WATCHMEN=1` and the briefing as a system prompt. The
Claude desktop app cannot pass either, so the watch cannot live there, although the desktop already
draws plugin panes, and can shrink a pane to a small widget.

## What changes

### 1. Start the watch from any session: `/watchmen start`

- `/watchmen` is registered in every session. Outside the watch it answers only `start` (and says
  how to start); the board tools stay unregistered there, so other sessions stay quiet.
- `/watchmen start` turns the current session into the watch: loads `.companion/board.json`, keeps
  the watch in state, registers the board tools, starts the check timer, opens the board pane, and
  sends the briefing as the first message (the launcher's persona, skill, task and handoff lines,
  built in the module instead of in bash).
- The launcher keeps working as before; both paths share one `startWatch`.
- The desktop session runs on the model the person picked there; the briefing still sends real tasks
  to an opus subagent.

### 2. A widget for the desktop

- The pane, when the desktop seats it as a widget (`placement: "widget"`), draws a glance: the
  mascot, lane counts and the first needs-you item. The full board shows when expanded.

### 3. It remembers you: `.companion/about-you.md`

- A short file of the person's standing preferences ("CI flakes don't matter", "comments from the
  design team do", "brief me at 9 in three lines").
- The briefing points the watch at it; the persona tells it to read it at the start and to add a line
  when the person corrects how it should report. It never records secrets or other people's data.

### 4. Say what it is

- README and the landing page lead with the assistant: "Tell it what to watch. It tells you what
  needs you." The board becomes what it looks after; the charter is how far you trust it.
- A "On the desktop" section: install the plugin, open a session in your workspace folder, type
  `/watchmen start`.
- CHANGELOG 0.3.0.

### 5. Feel like an assistant, not a session with a todo list

After the first try the owner called it "a session with a todo list". Four changes make it act first:

- **First run proposes what to watch.** When the watch starts, the plugin runs a fixed set of
  read-only lookups, shipped in the module and never chosen by the model, each only where its CLI is
  installed, each with a short timeout, failures ignored: open GitHub PRs authored by and awaiting
  review from the person (`gh search prs`), the same on GitLab (`glab api`, the reviewer search only
  when `glab api user` names a username), Jira work in progress assigned to them (`acli jira
  workitem search`), and how many Claude sessions changed a transcript here or below in the last
  three hours (no transcript content). Up to 15 items not already on the board (titles, ids and
  links only, titles JSON-quoted) follow the briefing as the plugin's own message, never as the
  person's words. The watch proposes them in one short message and adds only what the person
  accepts. `/watchmen approve all`, typed by the person, lists every waiting check and a hash over
  that set; `/watchmen approve all <hash>` approves exactly that set, refused if it changed.
- **It speaks first.** A morning brief once a day, on the first tick at or after
  `WATCHMEN_BRIEF_HOUR` (9 by default), never over a running turn, the person's typing or a
  rotation, counted as a wake for the rate limit. And when the person types after an hour or more
  away, the band says "since you looked: N need you · M moved" until they type again, computed
  without a model call.
- **Less board, more conversation.** `/watchmen start` opens the pane as a widget on the desktop
  app and not at all in a terminal; the band carries the counts, `/watchmen` opens the board, and
  the fullscreen layout still docks it.
- **It learns from what you ignore.** Items of a kind dropped while they sat in
  needs-you are counted per workspace (a move to done is triage and never counts); at two, `board_changes` asks
  the watch, once, to ask whether to stop raising that kind and to note the answer in
  `.companion/about-you.md`. The persona honours that file when deciding what needs the person.

Security stays as it was: the lookups are fixed and read-only, and nothing found runs a check until
the person approves it.

### 6. Park a session: `/watchmen park`

From any session, `/watchmen park [waiting|todo] [note]` hands the work to the watch so the session
can be closed. The plugin asks the session (from a timer, as a command hook cannot submit) to write
a handoff to `${XDG_STATE_HOME:-~/.local/state}/watchmen/parked/<date>-<short id>.md`, front matter
first: title, lane, waiting_on, link, check. Once a turn ends with that file written (or ten minutes
pass, and it gives up), it writes `…/watchmen/inbox/<short id>.json` with the session id, folder,
handoff and the parsed fields, and tells the person they can close the session; a watch heartbeat
under `…/watchmen/heartbeat/` tells it whether a watch has that folder now.

Each tick the watch reads the inbox, takes the entries whose folder is inside its own, and adds or
updates the item `park-<short id>` (kind `session`, waiting or needs-you, a note ending with
`resume: cd <folder> && claude --resume <session id>`, the handoff as link, the proposed check
awaiting approval), moves the entry to `inbox/done/`, and wakes the watch. Entries that do not
validate go to `inbox/rejected/`; entries for other folders stay for their watch.

A watch covers an entry when its workspace holds the entry's folder or, for a git worktree, the repository's main worktree recorded at park time. The parked session says it is parked in watchmen only when a live heartbeat covers it by the same rule; otherwise it suggests a parent folder to start a watch in. Entries no live watch covers, older than a minute, show as a dim line in every watch's band and pane and once in `board_changes`; they are not taken or changed.

All of it is untrusted: types checked, lengths capped, text cleaned and JSON-quoted where the model
reads it, links http(s) only, the handoff inside the parked folder, a check an array of at most 20
strings; nothing is approved for the person.

## Out of scope for now

Phone/Telegram, a separate menu-bar app, choosing another model provider.

## Done when

- `claude plugin test` and `node --test` pass, with tests for `/watchmen start` in a session that was
  not launched, the board tools refused before start, and the widget glance.
- `claude plugin validate` is clean.
- Reviewed by a subagent; PR open on pelayomendez/watchmen. Merging waits for the owner.
- After merge: release 0.3.0, update the installed plugin, and start the watch in the desktop app.
