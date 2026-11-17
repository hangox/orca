import { describe, expect, it } from 'vitest'
import { inferCapturedClaudeAgentTeamsMode } from './runtime-agent-launch-resolution'

describe('Claude Agent Teams launch mode recovery', () => {
  it('preserves it2 when a resumed launch only retains teammate-mode auto', () => {
    expect(
      inferCapturedClaudeAgentTeamsMode(
        { agentCommand: 'claude --teammate-mode auto', agentArgs: '', agentEnv: {} },
        undefined,
        'it2'
      )
    ).toBe('it2')
  })

  it('keeps native panes for auto launches without it2 mode', () => {
    expect(
      inferCapturedClaudeAgentTeamsMode(
        { agentCommand: 'claude --teammate-mode auto', agentArgs: '', agentEnv: {} },
        undefined,
        undefined
      )
    ).toBe('native-panes-shim')
  })
})
