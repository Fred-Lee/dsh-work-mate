/**
 * Guidance registration (design D2/D4 of `adopt-dsh-native-config-and-guidance`).
 *
 * Both registrations are LAZY (`ctx.inject([...])`): a composition without the
 * `skills` or `systemPrompt` service keeps the plugin ACTIVE — agent tools and
 * UI are unaffected, it simply contributes less. `effect` ties each
 * registration to this fiber, so a reload unregisters exactly what it added.
 */
import type { Context } from '@deepseek-ai/cordis'
import { TOOL_WORKFLOW_ORDER, type SystemPromptFace } from './faces.ts'
import {
  ARCHIVE_CHECKLIST_SKILL,
  FLOW_SECTION_NAME,
  FLOW_SECTION_TEXT,
  KNOWLEDGE_USAGE_SKILL,
  PROPOSAL_AUDIT_SKILL,
  PROPOSAL_FLOW_SKILL,
} from './content.ts'
import type { CommandFace } from './faces.ts'
import { registerWorkmateCommand, type CommandDeps } from '../command/definition.ts'

export function registerGuidance(ctx: Context, commandDeps?: CommandDeps): void {
  // `/workmate …` runs without sending the command to the model (host `commands`
  // service). Optional dependency: a profile without it simply loses this entry.
  if (commandDeps !== undefined) {
    ctx.inject(['commands'], (scope) => {
      const commands = (scope as unknown as { commands: CommandFace }).commands
      scope.effect(() => registerWorkmateCommand(commands, commandDeps), 'workmate:command')
    })
  }

  ctx.inject(['skills'], (scope) => {
    scope.effect(() => scope.skills.register(PROPOSAL_FLOW_SKILL), 'workmate:flow-skill')
    scope.effect(() => scope.skills.register(PROPOSAL_AUDIT_SKILL), 'workmate:audit-skill')
    scope.effect(() => scope.skills.register(ARCHIVE_CHECKLIST_SKILL), 'workmate:archive-checklist-skill')
    scope.effect(() => scope.skills.register(KNOWLEDGE_USAGE_SKILL), 'workmate:knowledge-usage-skill')
  })

  ctx.inject(['systemPrompt'], (scope) => {
    const prompt = scope.systemPrompt as unknown as SystemPromptFace
    scope.effect(
      () =>
        prompt.section({
          name: FLOW_SECTION_NAME,
          // Prefer the host's allocated position; fall back to the documented
          // constant when the running line predates `getSectionOrder`.
          order: prompt.getSectionOrder?.('TOOL_WORKFLOW') ?? TOOL_WORKFLOW_ORDER,
          text: FLOW_SECTION_TEXT,
        }),
      'workmate:flow-section',
    )
  })
}
