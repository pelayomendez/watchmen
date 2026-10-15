export type Watch = { handoff?: string; skill?: string; startedAt: number; warned: boolean }

/** Where an item stands for the human: what needs them, what moves on its own, what waits on others. */
export type Lane = 'needs-you' | 'moving' | 'waiting' | 'done'

/** Any host command, run by argv on a timer; its trimmed output is what the watch compares. */
export type Check = { argv: string[]; everyMs?: number }

/**
 * One thing the watch keeps track of. Nothing here knows about Jira, GitLab or sessions: `kind` is
 * a free label and `check` is whatever command tells the item's state.
 */
export type Item = {
  id: string
  title: string
  lane: Lane
  kind?: string
  note?: string
  link?: string
  check?: Check
  /** The check's last output. */
  last?: string
  /** When the check last started, so a slow check is not started twice. */
  checkedAt?: number
  /** When the check's output last changed. */
  changedAt?: number
  /** Set when the output changed; cleared once the model has triaged it. */
  isChanged?: boolean
}

declare module 'claude-code' {
  interface PluginState {
    watchmen: { watch: Watch; board: Item[] }
  }
}
