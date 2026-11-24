# Changelog

Releases are tagged `watchmen--v<version>` (Claude Code) and `v<version>` (herdr `--ref`).

## Unreleased

- `/watchmen park [waiting|todo] [note]` hands any session to the watch: the session writes a handoff with a small front matter, the plugin puts it in an inbox under the state folder, and the watch for that folder takes it onto the board as a `session` item with the command to resume it. Its proposed check waits for your approval; everything in it is validated as untrusted.
- Discovery leaves out pull and merge requests idle for 60 days, and asks each GitLab host in glab's config by name (`glab api --hostname`), so a glab set up for a company host finds its MRs.
- Park and checks refuse hidden characters (format, bidi and other invisible code points) in commands and parked titles, so an approval line shows exactly what runs.

## 0.3.0

watchmen as your assistant, on the desktop too.

- `/watchmen start` makes any session the watch, the Claude desktop app's included: it loads the board and sends the launcher's briefing as the first message. The session keeps the model picked there. It cannot be started by the model or another plugin.
- Check approvals (`/watchmen approve`) are still typed in a terminal session or through Remote Control; typing them in the desktop app may not count until that is confirmed.
- `/watchmen` is offered in every session; outside the watch it only says how to start, and the board tools stay off.
- The board pane draws a glance when the desktop app seats it as a widget: the mascot, the lane counts and the first thing that needs you.
- The watch remembers you in `.companion/about-you.md`: it reads it at the start and adds a line when you correct how it reports. It never records secrets, credentials or details about other people.
- First run proposes what to watch: fixed, read-only lookups (gh, glab, acli, recent Claude sessions here), each only if its CLI is installed, follow the briefing as the plugin's own message; the watch offers those items and adds only what you accept. Nothing found runs a check before you approve it.
- `/watchmen approve all` lists every waiting check with its command and a hash over that set; `/watchmen approve all <hash>` approves exactly that set, refused if it changed in between. Like `approve`, only when you type it.
- The watch speaks first: a morning brief once a day at `WATCHMEN_BRIEF_HOUR` (9 by default), and, back after an hour away, the band says "since you looked: N need you · M moved" until you type again.
- Less board: `/watchmen start` opens the pane as a widget on the desktop and leaves it closed in a terminal.
- It learns from what you ignore: after two items of a kind dropped while they sat in needs-you, it asks once whether to stop raising that kind and notes the answer in `.companion/about-you.md`.
- The panel looks and behaves like yatsude's: a `⚛ watchmen` footer button (with a red count when something needs you) opens the board with the keyboard; the band is a glance with no buttons (`/watchmen band` hides or shows it); the pane has the owl, the tagline and `brief`, `+ watch` and `↻` actions, coloured lanes, done folded past three, and item titles you click to talk about them.
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
