import { describe, expect, it, vi } from 'vitest'
import { ClaudeAgentTeamsService } from './claude-agent-teams-service'
import type { AgentTeamsTerminalApi } from './claude-agent-teams-types'

function createServiceWithLeader(mode: 'native-panes-shim' | 'it2' = 'native-panes-shim'): {
  service: ClaudeAgentTeamsService
  teamId: string
  token: string
  leaderPane: string
  api: AgentTeamsTerminalApi
  splitCalls: {
    handle: string
    direction?: string
    command?: string
    cwd?: string
    envToDelete?: string[]
    envPane?: string
  }[]
} {
  const service = new ClaudeAgentTeamsService()
  const launch = service.createLaunchEnv({
    leaderHandle: 'leader-handle',
    baseEnv: { PATH: '/usr/bin' },
    shimDir: '/tmp/orca-shim',
    mode,
    shimBin: '/usr/bin/orca'
  })
  expect(launch.env.ORCA_AGENT_TEAMS_SHIM_DIR).toBe('/tmp/orca-shim')
  const splitCalls: {
    handle: string
    direction?: string
    command?: string
    cwd?: string
    envToDelete?: string[]
    envPane?: string
  }[] = []
  let splitCount = 0
  const api: AgentTeamsTerminalApi = {
    splitTerminal: vi.fn(async (handle, opts) => {
      splitCount += 1
      splitCalls.push({
        handle,
        direction: opts.direction,
        command: opts.command,
        cwd: opts.cwd,
        envToDelete: opts.envToDelete,
        envPane: opts.env?.TMUX_PANE
      })
      return { handle: `teammate-${splitCount}`, tabId: 'tab-1', paneRuntimeId: -1 }
    }),
    readTerminal: vi.fn(async (handle) => ({
      handle,
      status: 'running' as const,
      tail: ['line one', 'line two'],
      truncated: false,
      nextCursor: null
    })),
    sendTerminal: vi.fn(async (handle, action) => ({
      handle,
      accepted: Boolean(action.text),
      bytesWritten: action.text?.length ?? 0
    })),
    focusTerminal: vi.fn(async (handle) => ({ handle, tabId: 'tab-1', worktreeId: 'wt-1' })),
    closeTerminal: vi.fn(async (handle) => ({ handle, tabId: 'tab-1', ptyKilled: true })),
    showTerminal: vi.fn(async (handle) => ({
      handle,
      worktreeId: 'wt-1',
      worktreePath: '/tmp/wt',
      branch: 'main',
      tabId: 'tab-1',
      leafId: 'leaf-1',
      title: null,
      connected: true,
      writable: true,
      lastOutputAt: null,
      preview: '',
      paneRuntimeId: -1,
      ptyId: 'pty-1',
      rendererGraphEpoch: 1
    }))
  }
  return {
    service,
    teamId: launch.teamId,
    token: launch.token,
    leaderPane: launch.leaderPane,
    api,
    splitCalls
  }
}

describe('ClaudeAgentTeamsService', () => {
  it('仅保留 token 正确且 leader PTY 存活的 team', () => {
    const { service, teamId, token } = createServiceWithLeader('it2')
    const env = { ORCA_AGENT_TEAMS_TEAM_ID: teamId, ORCA_AGENT_TEAMS_TOKEN: token }
    const handles = new Map([['pty', 'leader-handle']])
    const ptys = new Map([['pty', {}]])
    expect(service.isLiveTeam(env, handles, ptys)).toBe(true)
    expect(service.isLiveTeam({ ...env, ORCA_AGENT_TEAMS_TOKEN: 'stale' }, handles, ptys)).toBe(
      false
    )
    expect(service.isLiveTeam(env, handles, new Map())).toBe(false)
    service.removeTeamForLeaderHandle('leader-handle')
    expect(service.isLiveTeam(env, handles, ptys)).toBe(false)
  })
  it('creates an it2-compatible leader identity without tmux variables', () => {
    const service = new ClaudeAgentTeamsService()
    const launch = service.createLaunchEnv({
      leaderHandle: 'leader-handle',
      baseEnv: { PATH: '/usr/bin' },
      shimDir: '/tmp/orca-shim',
      shimBin: '/usr/bin/orca',
      mode: 'it2'
    })

    expect(launch.env.TERM_PROGRAM).toBe('iTerm.app')
    expect(launch.env.ITERM_SESSION_ID).toBe(`w0t0p0:${launch.leaderPane}`)
    expect(launch.env.TMUX).toBeUndefined()
    expect(launch.env.TMUX_PANE).toBeUndefined()
  })

  it('removes the pane when replacement split fails after a confirmed placeholder stop', async () => {
    const { service, teamId, token, leaderPane, api } = createServiceWithLeader()
    const request = (argv: string[], envPane = leaderPane) =>
      service.handleTmuxCompat({ teamId, token, envPane, argv }, api)

    await request([
      'split-window',
      '-d',
      '-t',
      leaderPane,
      '-h',
      '-P',
      '-F',
      '#{pane_id}',
      '--',
      'cat'
    ])

    vi.mocked(api.splitTerminal).mockRejectedValueOnce(new Error('no space for new pane'))
    await expect(
      request(['respawn-pane', '-k', '-t', '%2', '--', 'claude --agent-id a'])
    ).resolves.toMatchObject({ ok: false, exitCode: 1 })

    expect(api.closeTerminal).toHaveBeenCalledWith('teammate-1')
    await expect(
      request(['list-panes', '-t', 'orca:0', '-F', '#{pane_id}'])
    ).resolves.toMatchObject({ stdout: '%1\n' })
  })

  it('keeps a pane registered when its process stop is unconfirmed', async () => {
    const { service, teamId, token, leaderPane, api } = createServiceWithLeader()
    const request = (argv: string[], envPane = leaderPane) =>
      service.handleTmuxCompat({ teamId, token, envPane, argv }, api)

    await request(['split-window', '-t', leaderPane, '-h', '-P', '-F', '#{pane_id}'])
    vi.mocked(api.closeTerminal).mockResolvedValueOnce({
      handle: 'teammate-1',
      tabId: 'tab-1',
      ptyKilled: false
    })

    await expect(request(['kill-pane', '-t', '%2'])).resolves.toMatchObject({
      ok: false,
      exitCode: 1
    })
    await expect(
      request(['list-panes', '-t', 'orca:0', '-F', '#{pane_id}'])
    ).resolves.toMatchObject({ stdout: '%1\n%2\n' })
  })

  it('does not launch a replacement when the placeholder stop is unconfirmed', async () => {
    const { service, teamId, token, leaderPane, api, splitCalls } = createServiceWithLeader()
    const request = (argv: string[], envPane = leaderPane) =>
      service.handleTmuxCompat({ teamId, token, envPane, argv }, api)

    await request(['split-window', '-t', leaderPane, '-h', '-P', '-F', '#{pane_id}', 'cat'])
    vi.mocked(api.closeTerminal).mockResolvedValueOnce({
      handle: 'teammate-1',
      tabId: 'tab-1',
      ptyKilled: false,
      ptyStopVerdict: 'live'
    })

    await expect(
      request(['respawn-pane', '-k', '-t', '%2', '--', 'claude --agent-id a'])
    ).resolves.toMatchObject({ ok: false, exitCode: 1 })
    expect(api.closeTerminal).toHaveBeenNthCalledWith(1, 'teammate-1')
    expect(splitCalls).toHaveLength(1)

    await expect(
      request(['respawn-pane', '-k', '-t', '%2', '--', 'claude --agent-id a'])
    ).resolves.toMatchObject({ ok: false, exitCode: 1 })
    expect(splitCalls).toHaveLength(1)

    await request(['kill-pane', '-t', '%2'])
    expect(api.closeTerminal).toHaveBeenLastCalledWith('teammate-1')
  })

  it('retains an it2 pane when queued command cleanup cannot confirm stop', async () => {
    const { service, teamId, token, leaderPane, api } = createServiceWithLeader('it2')
    const request = (argv: string[], envPane = leaderPane) =>
      service.handleTmuxCompat({ teamId, token, envPane, argv, protocol: 'it2' }, api)

    vi.mocked(api.showTerminal).mockResolvedValueOnce({
      handle: 'teammate-1',
      worktreeId: 'wt-1',
      worktreePath: '/tmp/wt',
      branch: 'main',
      tabId: 'tab-1',
      leafId: 'leaf-1',
      title: null,
      connected: false,
      writable: false,
      lastOutputAt: null,
      preview: '',
      paneRuntimeId: -1,
      ptyId: 'pty-1',
      rendererGraphEpoch: 1
    })
    await request(['session', 'split', '-s', leaderPane])
    vi.mocked(api.sendTerminal).mockRejectedValueOnce(new Error('write failed'))
    vi.mocked(api.closeTerminal).mockResolvedValueOnce({
      handle: 'teammate-1',
      tabId: 'tab-1',
      ptyKilled: false,
      ptyStopVerdict: 'live'
    })
    await expect(request(['session', 'run', '-s', '%2', 'echo queued'])).resolves.toMatchObject({
      ok: false,
      stderr: expect.stringContaining('write failed')
    })
    await vi.waitFor(() => expect(api.closeTerminal).toHaveBeenCalledWith('teammate-1'))
    await expect(request(['session', 'list'])).resolves.toMatchObject({ stdout: '%1\n%2\n' })
  })

  it('starting pane 的 run 等待实际终端写入后才成功', async () => {
    const { service, teamId, token, leaderPane, api } = createServiceWithLeader('it2')
    const request = (argv: string[]) =>
      service.handleTmuxCompat({ teamId, token, envPane: leaderPane, argv, protocol: 'it2' }, api)
    const original = await api.showTerminal('teammate-1')
    let releaseReady!: () => void
    const ready = new Promise<void>((resolve) => {
      releaseReady = resolve
    })
    vi.mocked(api.showTerminal).mockImplementation(async () => {
      await ready
      return { ...original, executionHostId: 'local' }
    })
    let releaseWrite!: () => void
    const written = new Promise<void>((resolve) => {
      releaseWrite = resolve
    })
    vi.mocked(api.sendTerminal).mockImplementation(async (handle) => {
      await written
      return { handle, accepted: true, bytesWritten: 3 }
    })
    await request(['session', 'split', '-s', leaderPane])
    let settled = false
    const result = request(['session', 'run', '-s', '%2', 'echo test'])
    void result.then(() => {
      settled = true
    })
    releaseReady()
    await vi.waitFor(() => expect(api.sendTerminal).toHaveBeenCalled())
    expect(settled).toBe(false)
    releaseWrite()
    await expect(result).resolves.toMatchObject({ ok: true, exitCode: 0 })
  })

  it('starting pane 在等待期间关闭时拒绝已排队的 run', async () => {
    const { service, teamId, token, leaderPane, api } = createServiceWithLeader('it2')
    const request = (argv: string[]) =>
      service.handleTmuxCompat({ teamId, token, envPane: leaderPane, argv, protocol: 'it2' }, api)
    const original = await api.showTerminal('teammate-1')
    let release!: () => void
    const ready = new Promise<void>((resolve) => {
      release = resolve
    })
    vi.mocked(api.showTerminal).mockImplementation(async () => {
      await ready
      return original
    })
    await request(['session', 'split', '-s', leaderPane])
    const run = request(['session', 'run', '-s', '%2', 'echo test'])
    await expect(request(['session', 'close', '-s', '%2'])).resolves.toMatchObject({ ok: true })
    await expect(run).resolves.toMatchObject({
      ok: false,
      stderr: expect.stringContaining('session closed')
    })
    release()
    expect(api.sendTerminal).not.toHaveBeenCalled()
  })

  it.each(['ssh:remote', undefined] as const)(
    'starting pane 的长命令遇到 %s 主机时返回真实错误',
    async (executionHostId) => {
      const { service, teamId, token, leaderPane, api } = createServiceWithLeader('it2')
      const request = (argv: string[]) =>
        service.handleTmuxCompat({ teamId, token, envPane: leaderPane, argv, protocol: 'it2' }, api)
      const original = await api.showTerminal('teammate-1')
      let release!: () => void
      const ready = new Promise<void>((resolve) => {
        release = resolve
      })
      vi.mocked(api.showTerminal).mockImplementation(async () => {
        await ready
        return { ...original, executionHostId }
      })
      await request(['session', 'split', '-s', leaderPane])
      let settled = false
      const result = request(['session', 'run', '-s', '%2', `printf '%s' '${'x'.repeat(2000)}'`])
      void result.then(() => {
        settled = true
      })
      await Promise.resolve()
      expect(settled).toBe(false)
      release()
      await expect(result).resolves.toMatchObject({
        ok: false,
        exitCode: 1,
        stderr: expect.stringContaining('无法确认目标终端可访问本机暂存命令')
      })
      expect(api.sendTerminal).not.toHaveBeenCalled()
    }
  )

  it('拒绝向不可确认本地主机的 pane 发送暂存长命令', async () => {
    const { service, teamId, token, leaderPane, api } = createServiceWithLeader('it2')
    const result = await service.handleTmuxCompat(
      {
        teamId,
        token,
        envPane: leaderPane,
        protocol: 'it2',
        argv: ['session', 'run', `printf '%s' '${'x'.repeat(2000)}'`]
      },
      api
    )
    expect(result.ok).toBe(false)
    expect(result.stderr).toContain('无法确认目标终端可访问本机暂存命令')
    expect(api.sendTerminal).not.toHaveBeenCalled()
  })

  it('routes the it2 session contract through the same team-scoped pane registry', async () => {
    const { service, teamId, token, leaderPane, api, splitCalls } = createServiceWithLeader('it2')
    const request = (argv: string[], envPane = leaderPane, requestToken = token) =>
      service.handleTmuxCompat({ teamId, token: requestToken, envPane, argv, protocol: 'it2' }, api)

    await expect(request(['session', 'list'])).resolves.toMatchObject({ stdout: '%1\n' })
    await expect(
      request(['session', 'split', '-v', '-s', '%1', '--cwd', '/tmp/team-cwd'])
    ).resolves.toMatchObject({
      stdout: 'Created new pane: %2\n'
    })
    expect(splitCalls).toContainEqual(
      expect.objectContaining({
        handle: 'leader-handle',
        direction: 'vertical',
        cwd: '/tmp/team-cwd',
        envToDelete: ['TMUX', 'TMUX_PANE']
      })
    )
    await expect(
      request(['session', 'run', '-s', '%2', 'claude --agent-id a'], '%1')
    ).resolves.toMatchObject({
      ok: true,
      exitCode: 0
    })
    await expect(request(['session', 'run', 'echo local'], '%2')).resolves.toMatchObject({
      ok: true,
      exitCode: 0
    })
    await vi.waitFor(() => {
      expect(api.sendTerminal).toHaveBeenNthCalledWith(
        1,
        'teammate-1',
        { text: 'claude --agent-id a', enter: true },
        { inputKind: 'orchestration' }
      )
    })
    await vi.waitFor(() => {
      expect(api.sendTerminal).toHaveBeenNthCalledWith(
        2,
        'teammate-1',
        { text: 'echo local', enter: true },
        { inputKind: 'orchestration' }
      )
    })
    await expect(request(['session', 'focus', '-s', '%2'])).resolves.toMatchObject({
      ok: true,
      exitCode: 0
    })
    expect(api.focusTerminal).toHaveBeenCalledWith('teammate-1')
    await expect(request(['session', 'close', '-f', '-s', '%2'])).resolves.toMatchObject({
      ok: true,
      exitCode: 0
    })
    await expect(request(['session', 'close', '-f', '-s', '%2'])).resolves.toMatchObject({
      ok: true,
      exitCode: 0
    })
    await expect(request(['session', 'focus', '-s', '%2'])).resolves.toMatchObject({
      ok: true,
      exitCode: 0
    })
    await expect(request(['session', 'list'])).resolves.toMatchObject({ stdout: '%1\n' })
    await expect(request(['session', 'unknown'])).resolves.toMatchObject({
      ok: false,
      exitCode: 2,
      stderr: 'ERROR: unsupported command: unknown\n'
    })
    await expect(request(['session', 'list'], '%1', 'wrong-token')).resolves.toMatchObject({
      ok: false,
      exitCode: 1
    })
    await expect(
      service.handleTmuxCompat(
        { teamId, token, envPane: leaderPane, argv: ['session', 'list'] },
        api
      )
    ).resolves.toMatchObject({
      ok: false,
      exitCode: 1,
      stderr: 'tmux: agent team protocol mismatch\n'
    })
  })
})
