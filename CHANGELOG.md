# Changelog

Releases are tagged `watchmen--v<version>` (Claude Code) and `v<version>` (herdr `--ref`).

## 0.3.0

watchmen as your assistant, on the desktop too.

- `/watchmen start` makes any session the watch, the Claude desktop app's included: it loads the board, opens the pane and sends the launcher's briefing as the first message. The session keeps the model picked there. Only the person can start it, not the model.
- `/watchmen` is offered in every session; outside the watch it only says how to start, and the board tools stay off.
- The board pane draws a glance when the desktop app seats it as a widget: the mascot, the lane counts and the first thing that needs you.
- The watch remembers you in `.companion/about-you.md`: it reads it at the start and adds a line when you correct how it reports. It never records secrets, credentials or details about other people.
- The README leads with the assistant ("Tell it what to watch. It tells you what needs you.") and has an "On the desktop" section.

## 0.2.0

First release.

- The board pane, the band with lane counts and the watch's own figures, and the `/watchmen` commands.
- Checks run only after you approve the exact command; changes wake the watch, at most once every three minutes.
- Rotation: an idle, grown watch writes its handoff, clears and resumes before its cache goes cold.
- The watch runs on sonnet and hands tasks to an opus subagent.
- herdr: summon, follow mode with a follower process, the read-only board pane, and the sidebar token.
- The herdr plugin id is now `pelayomendez.watchmen`: rebind `pelayomendez.watchmen.summon` (and `.toggle-board`).
- The marketplace is now `pelayomendez-watchmen`: `/plugin install watchmen@pelayomendez-watchmen`.
- herdr's install checks node and the claude CLI, and says where the skill comes from.
- Plugin metadata, an icon, a GitHub Pages site, requirements, update and uninstall steps, and CI on every pull request.
