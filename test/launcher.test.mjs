import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

test('inside herdr the launcher labels its pane and records claude\'s own pid for it', () => {
  const dir = mkdtempSync(join(tmpdir(), 'launch '))
  try {
    const bin = join(dir, 'bin')
    mkdirSync(bin)
    // A stand-in claude that writes the pid it runs as: exec keeps the launcher's.
    writeFileSync(join(bin, 'claude'), `#!/usr/bin/env bash\nprintf '%s' "$$" > "$CLAUDE_PID_FILE"\n`)
    writeFileSync(join(bin, 'herdr'), `#!/usr/bin/env bash\nprintf '%s\\n' "herdr $*" >> "$FAKE_LOG"\n`)
    chmodSync(join(bin, 'claude'), 0o755)
    chmodSync(join(bin, 'herdr'), 0o755)
    const skill = join(dir, 'SKILL.md')
    writeFileSync(skill, '# skill\n')
    const work = join(dir, 'work')
    mkdirSync(work)
    const state = join(dir, 'state')
    const run = spawnSync('bash', [fileURLToPath(new URL('../bin/watchmen', import.meta.url))], {
      cwd: work,
      encoding: 'utf8',
      env: {
        ...process.env,
        PATH: `${bin}:${process.env.PATH}`,
        HERDR_PANE_ID: 'w1:p5',
        HERDR_BIN_PATH: join(bin, 'herdr'),
        XDG_STATE_HOME: state,
        WATCHMEN_SKILL: skill,
        CLAUDE_PID_FILE: join(dir, 'claude.pid'),
        FAKE_LOG: join(dir, 'log'),
      },
    })
    assert.equal(run.status, 0, run.stderr)
    const record = JSON.parse(readFileSync(join(state, 'watchmen', 'panes', 'w1:p5'), 'utf8'))
    assert.deepEqual({ ...record, cwd: undefined }, { pane_id: 'w1:p5', pid: Number(readFileSync(join(dir, 'claude.pid'), 'utf8')), cwd: undefined })
    // The label goes on and stays: no exit trap clears it; summon replaces a dead watch's pane.
    assert.deepEqual(readFileSync(join(dir, 'log'), 'utf8').trim().split('\n'), ['herdr pane rename w1:p5 watchmen'])
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
