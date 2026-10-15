import type { Register } from 'claude-code'

import type { Watch } from '../types'

// Watchmen only wakes in the session the launcher starts (WATCHMEN=1), so the plugin can be
// installed everywhere and stay silent in every other session. The persona and the briefing are
// the launcher's (--append-system-prompt): a user-installed plugin's prompt.compose hook is
// bypassed by Claude Code's built-in security plugin, so this module only shows the watch.

const GLYPH = '⚛'
const HANDOFF_DIR = '.companion'
const HANDOFF_PREFIX = 'handoff-'
const TICK_MS = 15_000
const HANDOFF_AT = 75

const WATCH = { plugin: 'watchmen', key: 'watch' } as const

export function newestHandoff(names: readonly string[]): string | undefined {
  return names
    .filter(name => name.startsWith(HANDOFF_PREFIX) && name.endsWith('.md'))
    .sort()
    .at(-1)
}

export function statusLine(percent: number | undefined, elapsedMs: number): string {
  const hours = Math.floor(elapsedMs / 3_600_000)
  const minutes = Math.floor((elapsedMs % 3_600_000) / 60_000)
  const held = `${hours}h${String(minutes).padStart(2, '0')}`
  if (percent === undefined) return `${GLYPH} watchmen · ${held}`
  const fill = `${percent}%`
  return percent >= HANDOFF_AT
    ? `${GLYPH} watchmen · ${fill} · write the handoff`
    : `${GLYPH} watchmen · ${fill} · ${held}`
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    const result = await next(e)

    // The flag is read once and kept in the session's state, then cleared from the environment so
    // a claude started from this session's shell is not taken for the watch. A hot reload runs
    // session.start again and finds the watch in state.
    let watch = (await $.state.get(WATCH)).value
    if (!watch) {
      if ((await $.env.get('WATCHMEN')) !== '1') return result
      const entries = (await $.fs.exists(HANDOFF_DIR)) ? await $.fs.list(HANDOFF_DIR) : []
      const latest = newestHandoff(entries.filter(one => one.kind === 'file').map(one => one.name))
      watch = {
        handoff: latest && `${HANDOFF_DIR}/${latest}`,
        skill: (await $.env.get('WATCHMEN_SKILL')) || undefined,
        startedAt: await $.clock.now(),
        warned: false,
      }
      await $.state.set(WATCH, watch)
    }
    await $.env.set('WATCHMEN', undefined)
    await $.env.set('WATCHMEN_SKILL', undefined)

    await $.command.register({
      name: 'watchmen',
      description: 'Show what the watch holds: handoff, skill, context fill',
    })

    const tick = async () => {
      const held = (await $.state.get(WATCH)).value
      if (!held) return
      const { context } = await $.session.usage()
      const now = await $.clock.now()
      const percent = context.percent ?? 0
      $.ui.status(statusLine(context.percent, now - held.startedAt))
      // Warn once per long window: re-arm when the window drops back, as after /clear or compaction.
      if (!held.warned && percent >= HANDOFF_AT) {
        $.ui.toast('The watch is long. Write the handoff before the window fills.', { timeoutMs: 10_000 })
        await $.state.set(WATCH, { ...held, warned: true })
      } else if (held.warned && percent < HANDOFF_AT) {
        await $.state.set(WATCH, { ...held, warned: false })
      }
    }
    await tick()
    $.clock.every(TICK_MS, () => void tick())

    return result
  })

  on('command.run', { command: 'watchmen' }, async $ => {
    const watch = (await $.state.get(WATCH)).value
    if (!watch) return { text: 'Watchmen is not keeping the watch in this session.' }
    const { context } = await $.session.usage()
    const lines = [
      `${GLYPH} watchmen`,
      `handoff: ${watch.handoff ?? 'none yet'}`,
      `skill:   ${watch.skill ?? 'not found'}`,
      `context: ${context.percent ?? '?'}% of ${context.window} tokens`,
    ]
    return { text: lines.join('\n') }
  })
}
