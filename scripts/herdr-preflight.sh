#!/usr/bin/env bash
# herdr's build step for watchmen: checks what the plugin needs and says how to get what is missing.
# It installs nothing. A missing node or claude fails the install; a missing skill only warns.
set -u

fail=0
if ! command -v node >/dev/null 2>&1; then
  echo "watchmen: node not found. Install Node.js 20 or newer: https://nodejs.org" >&2
  fail=1
elif [ "$(node -p 'process.versions.node.split(".")[0]')" -lt 20 ]; then
  echo "watchmen: node $(node --version) is too old. Install Node.js 20 or newer." >&2
  fail=1
fi
if ! command -v claude >/dev/null 2>&1; then
  echo "watchmen: the claude CLI was not found. Install Claude Code: https://code.claude.com" >&2
  fail=1
fi
if ! command -v watchmen >/dev/null 2>&1; then
  echo "watchmen: put the launcher on your PATH: ln -s \"$PWD/bin/watchmen\" ~/.local/bin/watchmen"
fi
skill_found=0
for path in "${WATCHMEN_SKILL:-}" "$HOME/.claude/skills/ambient-companion/SKILL.md" "$HOME/.agents/skills/ambient-companion/SKILL.md"; do
  [ -n "$path" ] && [ -f "$path" ] && skill_found=1
done
ls "$HOME"/.claude/plugins/cache/*/pelayo-skills/*/skills/productivity/ambient-companion/SKILL.md >/dev/null 2>&1 && skill_found=1
if [ "$skill_found" = 0 ]; then
  echo "watchmen: the ambient-companion skill is not installed yet: npx skills@latest add pelayomendez/pelayo-skills"
fi
exit "$fail"
