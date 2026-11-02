// The tab.focused event hook. herdr 0.9.0 runs it only when a plugin action focuses a tab; from
// 0.9.5 it also fires on UI switches. The follower process (herdr-follower.mjs) covers 0.9.0. Both
// run the same follow step under one move lock, and whichever looks second finds the watch already
// in the tab and skips, so one switch moves the pane once.
//
// Rapid events are debounced: each run waits 150 ms and gives way if a newer one arrived.

import { readFileSync, writeFileSync } from 'node:fs'

import { followOnce, isFollowing, paths } from './herdr-follow-move.mjs'

const DEBOUNCE_MS = 150

if (!isFollowing()) process.exit(0)

const { latest } = paths()
const stamp = `${process.pid}:${Date.now()}`
writeFileSync(latest, stamp)
await new Promise(resolve => setTimeout(resolve, DEBOUNCE_MS))
if (readFileSync(latest, 'utf8') !== stamp) process.exit(0)

try {
  const decision = followOnce(process.env.HERDR_PLUGIN_EVENT_JSON ?? '')
  if (/^(STOP|ERROR) /.test(decision)) process.stderr.write(`watchmen follow: ${decision}\n`)
} catch (error) {
  process.stderr.write(`watchmen follow: ${error.message}\n`)
}
