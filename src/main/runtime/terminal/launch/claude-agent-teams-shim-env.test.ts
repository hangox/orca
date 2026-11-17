import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { buildRuntimeAgentTeamsLaunchPlan } from './agent-teams-launch-plan'

import {
  buildClaudeAgentTeamsLaunchPlan,
  ensureClaudeAgentTeamsShimDir
} from './claude-agent-teams-shim-env'

const roots: string[] = []

afterEach(async () => {
  vi.unstubAllEnvs()
  await Promise.all(roots.map((root) => rm(root, { recursive: true, force: true })))
  roots.length = 0
})

describe('claude agent teams shim env', () => {
  it.skipIf(process.platform === 'win32')(
    'never runs a cwd-resolved orca when the shim bin is unqualified',
    async () => {
      const root = await mkdtemp(join(tmpdir(), 'orca-agent-teams-shim-'))
      roots.push(root)
      await ensureClaudeAgentTeamsShimDir(root)
      const cwd = await mkdtemp(join(tmpdir(), 'orca-agent-teams-cwd-'))
      roots.push(cwd)
      const marker = join(cwd, 'hijacked')
      for (const name of ['orca', 'orca-ide']) {
        const decoy = join(cwd, name)
        await writeFile(decoy, `#!/usr/bin/env sh\ntouch ${JSON.stringify(marker)}\n`, 'utf8')
        await chmod(decoy, 0o755)
      }

      const hijack = spawnSync(join(root, 'tmux'), ['display-message', '-p', '#{pane_id}'], {
        cwd,
        env: { PATH: `.:${process.env.PATH ?? ''}` },
        encoding: 'utf8'
      })

      expect(hijack.status).toBe(127)
      expect(hijack.stderr).toContain('absolute path')
      expect(existsSync(marker)).toBe(false)

      const cli = join(cwd, 'fake-orca')
      await writeFile(cli, '#!/usr/bin/env sh\necho "ran $*"\n', 'utf8')
      await chmod(cli, 0o755)
      const qualified = spawnSync(join(root, 'tmux'), ['list-panes'], {
        cwd,
        env: { PATH: `.:${process.env.PATH ?? ''}`, ORCA_AGENT_TEAMS_SHIM_BIN: cli },
        encoding: 'utf8'
      })

      expect(qualified.status).toBe(0)
      expect(qualified.stdout.trim()).toBe('ran agent-teams-tmux list-panes')

      const it2 = spawnSync(join(root, 'it2'), ['session', 'list'], {
        cwd,
        env: { PATH: `.:${process.env.PATH ?? ''}`, ORCA_AGENT_TEAMS_SHIM_BIN: cli },
        encoding: 'utf8'
      })
      expect(it2.status).toBe(0)
      expect(it2.stdout.trim()).toBe('ran agent-teams-it2 session list')
    }
  )

  it.skipIf(process.platform === 'win32')('为普通命令注入 it2 环境但不改写命令', async () => {
    const root = await mkdtemp(join(tmpdir(), 'orca-agent-teams-home-'))
    roots.push(root)
    vi.stubEnv('HOME', root)
    const command = 'printf "普通启动命令\\n"'
    const plan = await buildClaudeAgentTeamsLaunchPlan({
      command,
      mode: 'it2',
      baseEnv: { ORCA_AGENT_TEAMS_SHIM_BIN: process.execPath },
      createTeamEnv: (_shimDir, _shimBin, mode) => ({ ORCA_AGENT_TEAMS_PROTOCOL: mode })
    })
    expect(plan?.command).toBe(command)
    expect(plan?.env.ORCA_AGENT_TEAMS_PROTOCOL).toBe('it2')
    expect(plan?.envToDelete).toEqual(['TMUX', 'TMUX_PANE'])
  })

  it('已有团队的 runtime 启动保留原身份', async () => {
    const createTeamEnv = vi.fn()
    const result = await buildRuntimeAgentTeamsLaunchPlan({
      launchConfig: undefined,
      command: 'claude --teammate-mode auto',
      claudeAgentTeamsMode: 'it2',
      baseEnv: { ORCA_AGENT_TEAMS_TEAM_ID: 'team-original' },
      adoptedBeforeLaunch: false,
      preserveExistingTeam: true,
      createTeamEnv
    })
    expect(result.plan).toBeUndefined()
    expect(createTeamEnv).not.toHaveBeenCalled()
  })

  it('fails explicitly when the selected it2 backend has no absolute shim', async () => {
    await expect(
      buildClaudeAgentTeamsLaunchPlan({
        command: 'claude',
        mode: 'it2',
        baseEnv: { PATH: '/path-that-does-not-exist' },
        createTeamEnv: vi.fn()
      })
    ).rejects.toThrow('claude_agent_teams_it2_shim_unavailable')
  })
})
