# watchmen

> *Quis custodiet ipsos custodes?* Who watches the watchmen? Here: you do, through the charter.

One long-lived Claude Code session that keeps the watch over your work while other sessions come and go.

It runs the [`ambient-companion`](https://github.com/pelayomendez/pelayo-skills/tree/main/skills/productivity/ambient-companion) process: it watches the work's event streams, moves each item through workers and independent review, and brings you only the decisions, under a charter of what it may do alone, must ask first, and never does.

## The idea

A calm observer that stands a little outside the work and sees it across time: the handoff the last watch left, the streams moving now, the sessions running beside it. It speaks briefly and only when something needs you. It never writes the product code; workers do.

In the status line it shows as `⚛ watchmen · 42% · 3h07`: how full the context window is, and how long this watch has been held. At 75% it asks for a handoff before the window fills, because a watch that runs too long forgets what it saw.

## Use it

```bash
git clone https://github.com/pelayomendez/watchmen
npx skills@latest add pelayomendez/pelayo-skills   # the ambient-companion skill
cd <your workspace>
<path-to>/watchmen/bin/watchmen
```

The launcher:

- starts a session named `watchmen` (`claude --name watchmen`), so your other sessions can message it by that name;
- briefs it with the persona, the newest `.companion/handoff-*.md` in the workspace, and where the skill lives;
- loads this plugin, which shows the watch in the status line, warns once when the context runs long, and adds `/watchmen` to show what the watch holds.

The plugin stays silent in every session the launcher did not start, so it is safe to install globally.

In [herdr](https://herdr.dev), give the watch its own tab: run `watchmen` there and keep your working sessions in the others.

## Layout

| Path | What |
|---|---|
| `bin/watchmen` | Launcher: finds the skill and the newest handoff, builds the briefing, starts the session |
| `prompts/persona.md` | Who the watch is |
| `hooks/register.ts` | Status line, context warning, `/watchmen` |
| `hooks/watchmen.test.ts` | `claude plugin test .` |

Why the persona is in the launcher and not the plugin: Claude Code's built-in security plugin bypasses a user-installed plugin's changes to the system prompt, so the launcher passes it with `--append-system-prompt`.

## Next

Ideas taken from similar projects, not built yet:

- **A decision inbox**: each item the watch raises carries the answers it allows (accept, edit, respond, ignore) and stays open until you have seen it.
- **The status line reads, never computes**: hooks write the watch's state to a file, and a standalone status-line script only reads it.
- **A two-part handoff**: a hook writes the facts, the model adds the judgement, and the session won't end until the handoff is written.
- **Events over polling**: subscribe to herdr's agent events instead of checking on a timer.

## License

MIT
