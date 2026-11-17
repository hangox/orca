import { randomBytes, randomUUID } from 'node:crypto'
import {
  CLAUDE_AGENT_TEAMS_TMUX_DIR,
  splitTmuxCommand
} from '../../../../shared/agent-launch/startup/claude-agent-teams-tmux-compat'
import { ClaudeAgentTeamsTmuxDispatcher } from './claude-agent-teams-tmux-dispatcher'
import { ClaudeAgentTeamsIt2Dispatcher } from './claude-agent-teams-it2-dispatcher'
import { resolvePathEnvKey } from '../../../pty/environment/windows-path-segment-merge'
import type {
  AgentTeam,
  AgentTeamsLaunchEnv,
  AgentTeamsTerminalApi,
  AgentTeamsTmuxCompatRequest,
  AgentTeamsTmuxCompatResponse,
  TeamPane
} from './claude-agent-teams-types'

export class ClaudeAgentTeamsService {
  private readonly teams = new Map<string, AgentTeam>()
  private readonly tmuxDispatcher = new ClaudeAgentTeamsTmuxDispatcher()
  private readonly it2Dispatcher = new ClaudeAgentTeamsIt2Dispatcher()

  createLaunchEnv(args: {
    leaderHandle: string
    baseEnv: Record<string, string | undefined>
    shimDir: string
    mode?: 'native-panes-shim' | 'it2'
    /** Absolute path only; null leaves the var unset so the shim refuses to guess a cwd-relative CLI. */
    shimBin: string | null
  }): AgentTeamsLaunchEnv {
    const teamId = `team-${randomUUID()}`
    const token = randomBytes(32).toString('base64url')
    const leaderPane = '%1'
    // Preserve Windows Path casing or the shim would replace the launch PATH.
    const pathKey = resolvePathEnvKey(args.baseEnv, process.platform)
    const pathValue = [args.shimDir, args.baseEnv[pathKey]]
      .filter(Boolean)
      .join(process.platform === 'win32' ? ';' : ':')
    const tmuxValue = `${CLAUDE_AGENT_TEAMS_TMUX_DIR}${teamId},0,1`
    const useIt2 = args.mode === 'it2'
    const env: Record<string, string> = {
      CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS: '1',
      [pathKey]: pathValue,
      ...(useIt2
        ? { TERM_PROGRAM: 'iTerm.app', ITERM_SESSION_ID: `w0t0p0:${leaderPane}` }
        : { TMUX: tmuxValue, TMUX_PANE: leaderPane }),
      TERM: 'screen-256color',
      COLORTERM: args.baseEnv.COLORTERM || 'truecolor',
      ORCA_AGENT_TEAMS_TEAM_ID: teamId,
      ORCA_AGENT_TEAMS_TOKEN: token,
      ORCA_AGENT_TEAMS_PROTOCOL: useIt2 ? 'it2' : 'tmux',
      ORCA_AGENT_TEAMS_LEADER_PANE: leaderPane,
      ORCA_AGENT_TEAMS_SHIM_DIR: args.shimDir
    }
    if (args.shimBin) {
      env.ORCA_AGENT_TEAMS_SHIM_BIN = args.shimBin
    }
    if (args.baseEnv.ORCA_PAIRING_CODE) {
      env.ORCA_PAIRING_CODE = args.baseEnv.ORCA_PAIRING_CODE
    }
    if (args.baseEnv.ORCA_ENVIRONMENT) {
      env.ORCA_ENVIRONMENT = args.baseEnv.ORCA_ENVIRONMENT
    }

    const leader: TeamPane = {
      fakePaneId: leaderPane,
      handle: args.leaderHandle,
      index: 0,
      state: 'ready',
      pendingCommands: []
    }
    this.teams.set(teamId, {
      teamId,
      protocol: useIt2 ? 'it2' : 'tmux',
      token,
      leaderPane,
      leaderHandle: args.leaderHandle,
      sessionName: 'orca',
      windowIndex: '0',
      tmuxValue,
      baseEnv: env,
      panes: new Map([[leaderPane, leader]]),
      handleToPane: new Map([[leader.handle, leaderPane]]),
      paneOrder: [leaderPane],
      nextPaneNumber: 2,
      mainVertical: null,
      previouslyFocusedPane: null
    })
    return { teamId, token, leaderPane, env }
  }

  isLiveTeam(
    env: Record<string, string | undefined>,
    handles: ReadonlyMap<string, string>,
    ptys: ReadonlyMap<string, unknown>
  ): boolean {
    const team = env.ORCA_AGENT_TEAMS_TEAM_ID && this.teams.get(env.ORCA_AGENT_TEAMS_TEAM_ID)
    return Boolean(
      team &&
      env.ORCA_AGENT_TEAMS_TOKEN === team.token &&
      team.panes.get(team.leaderPane)?.handle === team.leaderHandle &&
      [...handles].some(([ptyId, handle]) => handle === team.leaderHandle && ptys.has(ptyId))
    )
  }

  releaseTeam(teamId: string): void {
    this.teams.delete(teamId)
  }

  removeTeamForLeaderHandle(handle: string): void {
    for (const [teamId, team] of this.teams) {
      if (team.leaderHandle === handle) {
        this.teams.delete(teamId)
      }
    }
  }

  getActiveTeamCount(): number {
    return this.teams.size
  }

  async handleTmuxCompat(
    request: AgentTeamsTmuxCompatRequest,
    api: AgentTeamsTerminalApi
  ): Promise<AgentTeamsTmuxCompatResponse> {
    try {
      const team = this.resolveTeam(request)
      const protocol = request.protocol ?? 'tmux'
      if (protocol !== team.protocol) {
        throw new Error('agent team protocol mismatch')
      }
      const envPane = normalizeAgentTeamsPaneId(request.envPane)
      if (protocol === 'it2') {
        const stdout = await this.it2Dispatcher.dispatch(team, request.argv, envPane, api)
        return { ok: true, stdout, stderr: '', exitCode: 0 }
      }
      const { command, args } = splitTmuxCommand(request.argv)
      const stdout = await this.tmuxDispatcher.dispatch(team, command, args, envPane, api)
      return { ok: true, stdout, stderr: '', exitCode: 0 }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      const protocol = request.protocol ?? 'tmux'
      const isUsageError = /^(usage:|unsupported |missing value)/.test(message)
      const exitCode = protocol === 'it2' && isUsageError ? 2 : 1
      const stderr = protocol === 'it2' ? `ERROR: ${message}\n` : `tmux: ${message}\n`
      return { ok: false, stdout: '', stderr, exitCode }
    }
  }

  private resolveTeam(request: AgentTeamsTmuxCompatRequest): AgentTeam {
    const team = this.teams.get(request.teamId)
    if (!team || team.token !== request.token) {
      throw new Error('stale or unauthorized agent team')
    }
    const envPane = normalizeAgentTeamsPaneId(request.envPane)
    if (!team.panes.has(envPane)) {
      throw new Error(`unknown pane: ${envPane}`)
    }
    return team
  }
}

function normalizeAgentTeamsPaneId(value: string): string {
  const separator = value.indexOf(':')
  return separator !== -1 ? value.slice(separator + 1) : value
}
