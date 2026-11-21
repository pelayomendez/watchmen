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

## Out of scope for now

Phone/Telegram, a separate menu-bar app, choosing another model provider.

## Done when

- `claude plugin test` and `node --test` pass, with tests for `/watchmen start` in a session that was
  not launched, the board tools refused before start, and the widget glance.
- `claude plugin validate` is clean.
- Reviewed by a subagent; PR open on pelayomendez/watchmen. Merging waits for the owner.
- After merge: release 0.3.0, update the installed plugin, and start the watch in the desktop app.
