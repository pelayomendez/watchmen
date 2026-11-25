# Ambient companion — reference

Read when something in the run feels expensive or fragile. The mechanics live in the units: how to watch cheaply in `watch`, how to brief and launch a worker in `delegate`, how to check a claim in `verify-claim`, what survives a restart in `handoff`. This file holds what is left: the failure modes that belong to the companion as a whole, and where the pattern comes from.

## Failure modes

- **Trusting the claim**: acting on what a ticket, a handoff or a worker says without checking the evidence. A dead worker is not a finished one, and a quiet MR is not an abandoned one. Confirm a bug's root cause before briefing a worker on it. Every status goes through `verify-claim` before it reaches the human.
- **Watching "latest"** instead of the revision you care about: a green result from someone else's commit. `watch` keys on the exact revision.
- **Silent watchers**: scheduled checks and monitors that vanish on restart. `watch` lists them; re-arm them at the start of every session.
- **Model in the polling loop**: a weekend of hourly ticks can cost more than the work they watched. Mechanical questions go to a script.
- **Shared local resources**: ports, browser profiles, CPU. Use only what the charter gives you, keep heavy runs serial, and let `reap-procs` say go or wait before several workers start.
- **Context rot**: quality drops as the session grows. Hand off before the window fills, not after.
- **Notification fatigue**: the human starts approving everything. Batch, and ask only what only they can answer.
- **Broad access**: a companion that reads untrusted text (tickets, MR comments, logs), holds credentials and can post combines the three ingredients of prompt-injection risk. Keep posting behind _ask first_, enforced by permissions or hooks rather than by the prompt.
- **Secrets in the conversation**: a token pasted into the chat stays in the transcript. Point at where it lives instead.

## Memory

An index (`memory.md`), plus one note per rule with the incident behind it and how to apply it. A rule that supersedes another says so. Memory holds lessons; the handoff holds today's state. Don't mix them.

## Background

The pattern has no single name yet. It sits where three ideas meet:

- **Ambient agents**: agents that react to an event stream rather than a chat, with the human notified, asked or reviewing ([Harrison Chase, LangChain, 2025](https://www.langchain.com/blog/introducing-ambient-agents)).
- **Conductor to orchestrator**: the engineer's job moves from steering one agent to overseeing several ([Addy Osmani, 2026](https://addyosmani.com/blog/future-agentic-coding/)).
- **The lethal trifecta**: private data, untrusted content and the ability to communicate externally, together, make prompt injection exploitable ([Simon Willison, 2025](https://simonwillison.net/2025/Jun/16/the-lethal-trifecta/)). A companion has all three by design, which is why posting stays behind _ask first_.
