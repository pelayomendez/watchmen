export type Watch = {
  handoff?: string
  skill?: string
  startedAt: number
  warned: boolean
  /** Set when board.json could not be read: the file is not written until the human reloads or resets. */
  boardError?: string
  /** Where to publish the sidebar token when the watch runs inside herdr. */
  herdr?: { bin: string; workspace: string }
  /** Changed items waiting to wake the watch, and when it last woke. */
  wake?: { pending: string[]; lastWakeAt?: number }
  /** The band above the prompt was hidden for this session. */
  isBandHidden?: boolean
}

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
  /** The check's last output, cut short for display. */
  last?: string
  /** A hash of the check's whole last output: what a change is detected by. */
  lastHash?: string
  /** Why the last check failed; cleared by the next one that succeeds. The note stays the model's. */
  checkError?: string
  /** The check's command has not been approved by the human, so it does not run. */
  isAwaitingApproval?: boolean
  /** The short hash of the command awaiting approval: what /watchmen approve <id> <hash> must name. */
  approvalHash?: string
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
