// The summon decision as a command: `herdr pane list` JSON on stdin, one decision line on stdout.

import { isPaneAlive } from './herdr-follow-move.mjs'
import { decideSummon } from './herdr-summon-decision.mjs'

let input = ''
process.stdin.setEncoding('utf8')
process.stdin.on('data', chunk => (input += chunk))
process.stdin.on('end', () => process.stdout.write(decideSummon(input, { isPaneAlive })))
