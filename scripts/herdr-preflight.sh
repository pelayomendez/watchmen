#!/usr/bin/env bash
# herdr's build step for watchmen: checks what the plugin needs and says how to get what is missing.
# It installs nothing. A missing node or claude fails the install.
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
exit "$fail"
