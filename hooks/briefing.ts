// The watch's briefing: the persona, then where its process, its tasks, the person's standing
// preferences and the last handoff are. bin/watchmen builds the same text in bash for the
// launcher's --append-system-prompt; `/watchmen start` builds it here and sends it as the first
// message, since a session the desktop app starts can pass neither a flag nor an environment.

export const ABOUT_YOU = '.companion/about-you.md'

export const MODELS = ['haiku', 'sonnet', 'opus', 'fable'] as const

/** A model name the watch accepts, or the fallback: anything else is ignored. */
export function pickModel(value: string | undefined, fallback: string): string {
  return (MODELS as readonly string[]).includes(value ?? '') ? value! : fallback
}

/**
 * Where the ambient-companion skill may be, in the launcher's order: WATCHMEN_SKILL, the two skill
 * folders, then the newest copy in the plugin cache (found apart, it needs a directory walk).
 */
export function skillCandidates(home: string | undefined, envSkill: string | undefined): string[] {
  return [envSkill, ...(home ? [`${home}/.claude/skills/ambient-companion/SKILL.md`, `${home}/.agents/skills/ambient-companion/SKILL.md`] : [])].filter(
    (path): path is string => !!path,
  )
}

export function skillLine(skill: string | undefined): string {
  return skill
    ? `Your process is the ambient-companion skill at ${skill}. Read it and follow its steps.`
    : 'The ambient-companion skill was not found. Tell the human, and work from the handoff alone until it is installed.'
}

export function taskLine(taskModel: string): string {
  return `Keep this session for the watch. When the human asks you to perform a task (write or fix something, research, review, draft, analyse), do not do it in this session: hand it to a subagent with the Agent tool and model "${taskModel}", with a complete brief, then report its result in a few sentences. Board work, triage, checks and quick answers stay with you.`
}

export function aboutYouLine(): string {
  return `What you know of the human's standing preferences is in ${ABOUT_YOU}: read it now if it exists, and keep it as the persona says.`
}

export function handoffLine(handoff: string | undefined): string {
  return handoff
    ? `The last watch left its handoff at ${handoff}. Read it before anything else, then check every item in it against evidence.`
    : 'There is no handoff in .companion/ yet. Start by asking the human for the work, its sources and the charter, one at a time.'
}

/** Where the watch's files live, fixed at start: the shell may cd, the .companion folder does not move. */
export function workspaceLine(workspace: string): string {
  return `Your workspace is ${workspace}. Every .companion/ path in these instructions and in your skill means ${workspace}/.companion/, wherever your shell's working directory goes: write the handoff and about-you.md there, never into a subfolder you cd into.`
}

export function briefing(input: { persona: string; skill?: string; handoff?: string; taskModel: string; workspace?: string }): string {
  return [
    input.persona.trimEnd(),
    skillLine(input.skill),
    taskLine(input.taskModel),
    ...(input.workspace ? [workspaceLine(input.workspace)] : []),
    aboutYouLine(),
    handoffLine(input.handoff),
  ].join('\n\n')
}
