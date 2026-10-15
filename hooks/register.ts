import type { Register } from 'claude-code'

// Nightwatch only wakes in the session the launcher starts (NIGHTWATCH=1), so the plugin can be
// installed everywhere and stay silent in every other session. The persona and the briefing are
// the launcher's (--append-system-prompt): a user-installed plugin's prompt.compose hook is
// bypassed by Claude Code's built-in security plugin, so this module only shows the watch.

const GLYPH = '⚛'
const HANDOFF_DIR = '.companion'
const HANDOFF_PREFIX = 'handoff-'
const TICK_MS = 15_000
const HANDOFF_AT = 75

type Watch = { handoff?: string; skill?: string; startedAt: number; warned: boolean }

let watch: Watch | undefined

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
  if (percent === undefined) return `${GLYPH} nightwatch · ${held}`
  const fill = `${percent}%`
  return percent >= HANDOFF_AT
    ? `${GLYPH} nightwatch · ${fill} · write the handoff`
    : `${GLYPH} nightwatch · ${fill} · ${held}`
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    const result = await next(e)
    if ((await $.env.get('NIGHTWATCH')) !== '1') return result

    const entries = (await $.fs.exists(HANDOFF_DIR)) ? await $.fs.list(HANDOFF_DIR) : []
    const latest = newestHandoff(entries.filter(one => one.kind === 'file').map(one => one.name))
    watch = {
      handoff: latest && `${HANDOFF_DIR}/${latest}`,
      skill: await $.env.get('NIGHTWATCH_SKILL'),
      startedAt: await $.clock.now(),
      warned: false,
    }

    await $.command.register({
      name: 'nightwatch',
      description: 'Show what the watch holds: handoff, skill, context fill',
    })

    const tick = async () => {
      if (!watch) return
      const { context } = await $.session.usage()
      const now = await $.clock.now()
      $.ui.status(statusLine(context.percent, now - watch.startedAt))
      if (!watch.warned && (context.percent ?? 0) >= HANDOFF_AT) {
        watch.warned = true
        $.ui.toast('The watch is long. Write the handoff before the window fills.', { timeoutMs: 10_000 })
      }
    }
    await tick()
    $.clock.every(TICK_MS, () => void tick())

    return result
  })

  on('command.run', { command: 'nightwatch' }, async $ => {
    if (!watch) return { text: 'Nightwatch is not keeping the watch in this session.' }
    const { context } = await $.session.usage()
    const lines = [
      `${GLYPH} nightwatch`,
      `handoff: ${watch.handoff ?? 'none yet'}`,
      `skill:   ${watch.skill ?? 'not found'}`,
      `context: ${context.percent ?? '?'}% of ${context.window} tokens`,
    ]
    return { text: lines.join('\n') }
  })
}
