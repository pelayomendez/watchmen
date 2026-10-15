// The toggle's decision as a command: `herdr pane list` JSON on stdin, OPEN, FOCUS <id> or
// CLOSE <id> on stdout. A file of its own, so no is-main check can miss it through a symlink.

import { decide } from './herdr-board-decision.mjs'

let input = ''
process.stdin.setEncoding('utf8')
process.stdin.on('data', chunk => (input += chunk))
process.stdin.on('end', () => process.stdout.write(decide(input)))
