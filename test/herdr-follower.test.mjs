import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import net from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

import { isPaneEnd, isTabFocus } from '../scripts/herdr-follow-decision.mjs'

test('reads tab focus and pane end events in either spelling', () => {
  assert.equal(isTabFocus({ event: 'tab_focused', data: { type: 'tab_focused', tab_id: 'w1:t2' } }), true)
  assert.equal(isTabFocus({ event: 'tab.focused', data: {} }), true)
  assert.equal(isTabFocus({ event: 'pane.focused', data: { type: 'pane_focused' } }), false)
  assert.equal(isPaneEnd({ event: 'pane_closed', data: { type: 'pane_closed' } }), true)
  assert.equal(isPaneEnd({ event: 'pane.exited', data: {} }), true)
  assert.equal(isPaneEnd({ result: { type: 'subscription_started' } }), false)
})

// A fake herdr: a socket server that records the subscribe request and sends events, and a CLI
// that answers pane list and tab list from files and logs every other call.
function world() {
  // A short base path: a unix socket path must stay under about 100 bytes.
  const dir = mkdtempSync(join('/tmp', 'wf-'))
  const bin = join(dir, 'herdr')
  writeFileSync(
    bin,
    `#!/usr/bin/env bash
case "$1 $2" in
  "pane list") cat "$FAKE_PANES" ;;
  "tab list") cat "$FAKE_TABS" ;;
  *) printf '%s\\n' "herdr $*" >> "$FAKE_LOG" ;;
esac
`,
  )
  chmodSync(bin, 0o755)
  const files = { panes: join(dir, 'panes.json'), tabs: join(dir, 'tabs.json'), log: join(dir, 'log') }
  writeFileSync(files.tabs, JSON.stringify({ result: { tabs: [{ tab_id: 'w1:t1', label: 'api' }, { tab_id: 'w1:t2', label: 'web' }] } }))
  writeFileSync(files.log, '')
  const state = join(dir, 'state')
  mkdirSync(join(state, 'watchmen'), { recursive: true })
  writeFileSync(join(state, 'watchmen', 'follow'), 'on\n')
  const socketPath = join(dir, 's.sock')
  const requests = []
  let client
  const connected = new Promise(resolve => {
    const server = net.createServer(socket => {
      client = socket
      socket.setEncoding('utf8')
      socket.on('data', chunk => {
        for (const line of chunk.split('\n').filter(Boolean)) requests.push(JSON.parse(line))
        socket.write(`${JSON.stringify({ id: requests[0]?.id, result: { type: 'subscription_started' } })}\n`)
        resolve(server)
      })
    })
    server.listen(socketPath)
  })
  const env = {
    ...process.env,
    HERDR_SOCKET_PATH: socketPath,
    HERDR_BIN_PATH: bin,
    XDG_STATE_HOME: state,
    FAKE_PANES: files.panes,
    FAKE_TABS: files.tabs,
    FAKE_LOG: files.log,
  }
  const start = () => spawn(process.execPath, [fileURLToPath(new URL('../scripts/herdr-follower.mjs', import.meta.url))], { env, stdio: 'ignore' })
  const send = message => client.write(`${JSON.stringify(message)}\n`)
  const calls = () => readFileSync(files.log, 'utf8').trim().split('\n').filter(Boolean)
  const setPanes = panes => writeFileSync(files.panes, JSON.stringify({ result: { panes } }))
  const cleanup = () => rmSync(dir, { recursive: true, force: true })
  return { start, send, calls, setPanes, connected, requests, cleanup, state: join(state, 'watchmen') }
}

const wait = ms => new Promise(resolve => setTimeout(resolve, ms))
// Polls until check() holds or the time runs out, so a loaded machine does not fail the test.
async function until(check, ms = 5_000) {
  const end = Date.now() + ms
  while (Date.now() < end && !check()) await wait(20)
}
const exited = child => new Promise(resolve => (child.exitCode !== null ? resolve(child.exitCode) : child.on('exit', resolve)))

test('the follower subscribes, follows a tab switch, and stops when the watch pane is gone', async () => {
  const w = world()
  w.setPanes([
    { pane_id: 'w1:p7', tab_id: 'w1:t1', workspace_id: 'w1', label: 'watchmen' },
    { pane_id: 'w1:p2', tab_id: 'w1:t2', workspace_id: 'w1', focused: true },
  ])
  const child = w.start()
  const server = await w.connected
  try {
    assert.equal(w.requests[0].method, 'events.subscribe')
    assert.deepEqual(w.requests[0].params.subscriptions.map(one => one.type), ['tab.focused', 'pane.closed', 'pane.exited'])
    assert.equal(readFileSync(join(w.state, 'follower.pid'), 'utf8').trim(), String(child.pid))

    // Two quick switches: only the last is followed.
    w.send({ event: 'tab_focused', data: { type: 'tab_focused', tab_id: 'w1:t1', workspace_id: 'w1' } })
    w.send({ event: 'tab_focused', data: { type: 'tab_focused', tab_id: 'w1:t2', workspace_id: 'w1' } })
    await until(() => w.calls().length > 0)
    await wait(300)
    assert.deepEqual(w.calls(), ['herdr pane move w1:p7 --tab w1:t2 --target-pane w1:p2 --split right --ratio 0.35 --no-focus'])

    w.setPanes([{ pane_id: 'w1:p2', tab_id: 'w1:t2', workspace_id: 'w1', focused: true }])
    w.send({ event: 'pane_exited', data: { type: 'pane_exited', pane_id: 'w1:p7', workspace_id: 'w1' } })
    assert.equal(await exited(child), 0)
    assert.equal(readFileSync(join(w.state, 'follow'), 'utf8').trim(), 'off')
    assert.equal(existsSync(join(w.state, 'follower.pid')), false)
  } finally {
    if (child.exitCode === null) child.kill('SIGTERM')
    server.close()
    w.cleanup()
  }
})

test('a second follower does not start while one runs, and none starts while follow is off', async () => {
  const w = world()
  w.setPanes([{ pane_id: 'w1:p7', tab_id: 'w1:t1', workspace_id: 'w1', label: 'watchmen', focused: true }])
  const first = w.start()
  const server = await w.connected
  const second = w.start()
  assert.equal(await exited(second), 0)
  assert.equal(w.requests.length, 1)
  first.kill('SIGTERM')
  await exited(first)
  server.close()

  writeFileSync(join(w.state, 'follow'), 'off\n')
  assert.equal(await exited(w.start()), 0)
  w.cleanup()
})
