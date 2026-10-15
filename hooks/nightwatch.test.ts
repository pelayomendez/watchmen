import { expect, mock, test } from 'claude-code/testing'

import { newestHandoff, statusLine } from './register'

test('picks the newest dated handoff and ignores other files', () => {
  expect(newestHandoff(['notes.md', 'handoff-2026-10-14.md', 'handoff-2026-10-15.md', 'handoff-x.txt'])).toBe(
    'handoff-2026-10-15.md',
  )
  expect(newestHandoff(['memory.md'])).toBeUndefined()
})

test('status line shows fill and time held, and asks for a handoff when the window runs long', () => {
  expect(statusLine(42, 3 * 3_600_000 + 7 * 60_000)).toBe('⚛ nightwatch · 42% · 3h07')
  expect(statusLine(80, 0)).toBe('⚛ nightwatch · 80% · write the handoff')
  expect(statusLine(undefined, 60_000)).toBe('⚛ nightwatch · 0h01')
})

function engine(on: Parameters<Parameters<typeof test>[1]>[1], files: string[], percent: number) {
  mock.clock(on, { now: 0 })
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('fs.exists', () => ({ value: files.length > 0 }))
  on('fs.list', () => ({ value: files.map(name => ({ name, kind: 'file' as const, size: 1, mtimeMs: 0, isLink: false })) }))
  on('session.usage', () => ({ value: { startedAt: 0, context: { window: 200_000, percent }, rateLimits: [] } }))
  on('command.register', () => ({ value: undefined }) as never)
  const status: (string | undefined)[] = []
  const toasts: string[] = []
  on('ui.status', ($, e) => (status.push(e.text), { value: undefined }))
  on('ui.toast', ($, e) => (toasts.push(e.text), { value: undefined }))
  return { status, toasts }
}

test('stays silent when the session was not launched as nightwatch', async ($, on) => {
  mock.env(on, {})
  const seen = engine(on, ['handoff-2026-10-15.md'], 10)
  await $.session.start({ cwd: '/w', surface: 'terminal', isInteractive: true })
  expect(seen.status).toEqual([])
})

test('as nightwatch: shows the watch in the status line and warns once when the window runs long', async ($, on) => {
  mock.env(on, { NIGHTWATCH: '1', NIGHTWATCH_SKILL: '/skills/ambient-companion/SKILL.md' })
  const seen = engine(on, ['handoff-2026-10-14.md', 'handoff-2026-10-15.md'], 80)
  await $.session.start({ cwd: '/w', surface: 'terminal', isInteractive: true })
  expect(seen.status.at(-1)).toBe('⚛ nightwatch · 80% · write the handoff')
  expect(seen.toasts).toHaveLength(1)
})
