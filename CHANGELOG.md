# Changelog

Releases are tagged `watchmen--v<version>` (Claude Code) and `v<version>` (herdr `--ref`).

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
