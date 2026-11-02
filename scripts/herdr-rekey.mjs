// After `herdr pane move`: moves the watch's record from the old pane id (argv) to the new one the
// move's answer on stdin names, then passes the answer through.

import { rekeyPane } from './herdr-follow-move.mjs'

let input = ''
process.stdin.setEncoding('utf8')
process.stdin.on('data', chunk => (input += chunk))
process.stdin.on('end', () => {
  rekeyPane(process.argv[2] ?? '', input)
  process.stdout.write(input)
})
