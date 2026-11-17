import { describe, expect, it, vi } from 'vitest'
import { ClaudeAgentTeamsService } from '../../../runtime/terminal/agent-teams/claude-agent-teams-service'
import { assemblePtyIpcSpawnEnv } from './spawn-env'
import { createPtyIpcSpawnState } from './spawn-state'
import type { PtySpawnIpcDeps } from './spawn-types'

vi.mock('./spawn-env-codex', () => ({ assemblePtyIpcSpawnCodexEnv: vi.fn() }))
vi.mock('../../../antigravity/native-account-launch', () => ({
  prepareAntigravityAccountForLaunch: vi.fn()
}))

describe('已有 Agent Teams 身份的终端启动', () => {
  it.each(['split', 'restore', 'auto Claude'])('%s 保留有效 team', async (scenario) => {
    const service = new ClaudeAgentTeamsService()
    const env = service.createLaunchEnv({
      leaderHandle: 'leader',
      baseEnv: {},
      shimDir: '/shim',
      shimBin: '/bin/orca',
      mode: 'it2'
    }).env
    const prepare = vi.fn()
    const deps = {
      runtime: {
        isLiveClaudeAgentTeam: (value: Record<string, string>) =>
          service.isLiveTeam(value, new Map([['pty', 'leader']]), new Map([['pty', {}]])),
        createPreAllocatedTerminalHandle: vi.fn(() => 'new-handle'),
        prepareClaudeAgentTeamsLeaderForHandle: prepare
      },
      getSettings: () => ({ claudeAgentTeamsMode: 'it2' })
    } as unknown as PtySpawnIpcDeps
    const ctx = createPtyIpcSpawnState(deps, {
      cols: 80,
      rows: 24,
      tabId: 'tab-1',
      leafId: 'f68712b2-33e5-489d-9fc3-1cc11d0ff4a7',
      env: scenario === 'restore' ? {} : env,
      command: scenario === 'auto Claude' ? 'claude --teammate-mode auto' : undefined,
      launchConfig:
        scenario === 'restore'
          ? { agentCommand: 'claude', agentArgs: '--teammate-mode auto', agentEnv: env }
          : undefined
    })
    await assemblePtyIpcSpawnEnv(ctx)
    expect(ctx.stablePaneKey).toBe('tab-1:f68712b2-33e5-489d-9fc3-1cc11d0ff4a7')
    expect(prepare).not.toHaveBeenCalled()
    const preserved = scenario === 'restore' ? ctx.effectiveLaunchConfig?.agentEnv : ctx.baseEnv
    expect(preserved?.ORCA_AGENT_TEAMS_TEAM_ID).toBe(env.ORCA_AGENT_TEAMS_TEAM_ID)
    expect(preserved?.ORCA_AGENT_TEAMS_TOKEN).toBe(env.ORCA_AGENT_TEAMS_TOKEN)
    expect(ctx.agentTeamsEnvToDelete).toEqual(['TMUX', 'TMUX_PANE'])
  })

  it('registry 为空的恢复启动重新分配 it2 leader', async () => {
    const service = new ClaudeAgentTeamsService()
    const oldEnv = {
      ORCA_AGENT_TEAMS_TEAM_ID: 'old-team',
      ORCA_AGENT_TEAMS_TOKEN: 'old-token',
      ORCA_AGENT_TEAMS_PROTOCOL: 'it2'
    }
    const prepare = vi.fn(async () => ({
      env: service.createLaunchEnv({
        leaderHandle: 'new-handle',
        baseEnv: {},
        shimDir: '/shim',
        shimBin: '/bin/orca',
        mode: 'it2'
      }).env
    }))
    const deps = {
      runtime: {
        isLiveClaudeAgentTeam: (value: Record<string, string>) =>
          service.isLiveTeam(value, new Map(), new Map()),
        createPreAllocatedTerminalHandle: vi.fn(() => 'new-handle'),
        prepareClaudeAgentTeamsLeaderForHandle: prepare
      },
      getSettings: () => ({ claudeAgentTeamsMode: 'off' })
    } as unknown as PtySpawnIpcDeps
    const ctx = createPtyIpcSpawnState(deps, {
      cols: 80,
      rows: 24,
      tabId: 'tab-1',
      leafId: 'f68712b2-33e5-489d-9fc3-1cc11d0ff4a7',
      launchConfig: { agentCommand: 'claude', agentArgs: '--teammate-mode auto', agentEnv: oldEnv }
    })
    await assemblePtyIpcSpawnEnv(ctx)
    expect(prepare).toHaveBeenCalledWith(expect.objectContaining({ mode: 'it2' }))
    expect(ctx.effectiveLaunchConfig?.agentEnv.ORCA_AGENT_TEAMS_TEAM_ID).not.toBe('old-team')
    expect(ctx.effectiveLaunchConfig?.agentEnv.ORCA_AGENT_TEAMS_TOKEN).not.toBe('old-token')
    expect(ctx.agentTeamsEnvToDelete).toEqual(['TMUX', 'TMUX_PANE'])
  })
})
