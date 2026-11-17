import type { AgentTeamsTerminalApi, AgentTeam, TeamPane } from './claude-agent-teams-types'
import {
  discardStagedStartupCommand,
  stageStartupCommand
} from '../../../../shared/shell/launch/startup-command-staging'
import { describeUnconfirmedAgentStop } from '../../../../shared/terminal/pty/lifecycle/pty-liveness-verdict'

export class ClaudeAgentTeamsIt2Dispatcher {
  async dispatch(
    team: AgentTeam,
    argv: string[],
    envPane: string,
    api: AgentTeamsTerminalApi
  ): Promise<string> {
    if (argv[0] !== 'session') {
      throw new Error('usage: it2 session <list|split|run|close|focus>')
    }
    const command = argv[1]
    const args = argv.slice(2)
    switch (command) {
      case 'list':
        this.expectNoArgs(args, 'list')
        return `${team.paneOrder.join('\n')}\n`
      case 'split':
        return await this.split(team, args, envPane, api)
      case 'run':
        return await this.run(team, args, envPane, api)
      case 'close':
        return await this.close(team, args, envPane, api)
      case 'focus':
        return await this.focus(team, args, envPane, api)
      default:
        throw new Error(`unsupported command: ${command ?? ''}`)
    }
  }

  private async split(
    team: AgentTeam,
    args: string[],
    envPane: string,
    api: AgentTeamsTerminalApi
  ): Promise<string> {
    const parsed = parseOptions(args, new Set(['-s', '--session', '--cwd']), new Set(['-v']))
    const source = this.resolvePane(
      team,
      parsed.values.get('-s') ?? parsed.values.get('--session') ?? envPane
    )
    const fakePaneId = `%${team.nextPaneNumber}`
    team.nextPaneNumber += 1
    try {
      const split = await api.splitTerminal(source.handle, {
        direction: parsed.flags.has('-v') ? 'vertical' : 'horizontal',
        cwd: parsed.values.get('--cwd'),
        env: {
          ...team.baseEnv,
          ...(team.protocol === 'it2'
            ? { ITERM_SESSION_ID: `w0t0p0:${fakePaneId}` }
            : { TMUX_PANE: fakePaneId })
        },
        envToDelete: team.protocol === 'it2' ? ['TMUX', 'TMUX_PANE'] : ['TERM_PROGRAM'],
        activate: false
      })
      team.panes.set(fakePaneId, {
        fakePaneId,
        handle: split.handle,
        index: team.paneOrder.length,
        state: 'starting',
        pendingCommands: [],
        splitFromPane: source.fakePaneId,
        splitDirection: parsed.flags.has('-v') ? 'vertical' : 'horizontal'
      })
      team.handleToPane.set(split.handle, fakePaneId)
      team.paneOrder.push(fakePaneId)
      void this.waitForReady(team, fakePaneId, api)
      return `Created new pane: ${fakePaneId}\n`
    } catch (error) {
      team.nextPaneNumber -= 1
      throw error
    }
  }

  private async run(
    team: AgentTeam,
    args: string[],
    envPane: string,
    api: AgentTeamsTerminalApi
  ): Promise<string> {
    const parsed = parseOptions(args, new Set(['-s', '--session']), new Set())
    const command = parsed.positional.join(' ')
    if (!command) {
      throw new Error('usage: it2 session run [-s <session>] <command>')
    }
    const target = this.resolvePane(
      team,
      parsed.values.get('-s') ?? parsed.values.get('--session') ?? envPane
    )
    if (target.state === 'starting') {
      target.pendingCommands.push(command)
      return 'OK (queued, waiting for ready)\n'
    }
    if (target.state === 'closed') {
      throw new Error(`session closed: ${target.fakePaneId}`)
    }
    await this.sendCommand(target, command, api)
    return ''
  }

  private async close(
    team: AgentTeam,
    args: string[],
    envPane: string,
    api: AgentTeamsTerminalApi
  ): Promise<string> {
    const parsed = parseOptions(args, new Set(['-s', '--session']), new Set(['-f', '--force']))
    const targetId = parsed.values.get('-s') ?? parsed.values.get('--session') ?? envPane
    const target = team.panes.get(targetId)
    if (!target) {
      return 'OK\n'
    }
    if (target.fakePaneId === team.leaderPane) {
      throw new Error('refusing to close leader session')
    }
    const result = await api.closeTerminal(target.handle)
    if (!result.ptyKilled) {
      throw new Error(describeUnconfirmedAgentStop(result))
    }
    this.removePane(team, target)
    return 'OK\n'
  }

  private async focus(
    team: AgentTeam,
    args: string[],
    envPane: string,
    api: AgentTeamsTerminalApi
  ): Promise<string> {
    const parsed = parseOptions(args, new Set(['-s', '--session']), new Set())
    const targetId =
      parsed.values.get('-s') ?? parsed.values.get('--session') ?? parsed.positional[0] ?? envPane
    if (parsed.positional.length > (parsed.values.size ? 0 : 1)) {
      throw new Error('usage: it2 session focus [-s <session>]')
    }
    const target = team.panes.get(targetId)
    if (!target) {
      return ''
    }
    await api.focusTerminal(target.handle)
    return ''
  }

  private async waitForReady(
    team: AgentTeam,
    paneId: string,
    api: AgentTeamsTerminalApi
  ): Promise<void> {
    const deadline = Date.now() + 30_000
    while (Date.now() < deadline) {
      const pane = team.panes.get(paneId)
      if (!pane || pane.state === 'closed') {
        return
      }
      try {
        const shown = await api.showTerminal(pane.handle)
        if (shown.connected && shown.writable) {
          pane.state = 'ready'
          const pending = pane.pendingCommands.splice(0)
          for (const command of pending) {
            try {
              await this.sendCommand(pane, command, api)
            } catch {
              pane.state = 'closed'
              pane.pendingCommands.length = 0
              await this.retirePane(team, pane, api)
              return
            }
          }
          return
        }
      } catch {
        // 在就绪截止时间前继续轮询。
      }
      await new Promise<void>((resolve) => setTimeout(resolve, 50))
    }
    const pane = team.panes.get(paneId)
    if (!pane) {
      return
    }
    pane.state = 'closed'
    pane.pendingCommands.length = 0
    await this.retirePane(team, pane, api)
  }

  private async retirePane(
    team: AgentTeam,
    pane: TeamPane,
    api: AgentTeamsTerminalApi
  ): Promise<boolean> {
    try {
      const result = await api.closeTerminal(pane.handle)
      if (!result.ptyKilled) {
        pane.respawnBlockedReason = describeUnconfirmedAgentStop(result)
        return false
      }
    } catch (error) {
      pane.respawnBlockedReason = error instanceof Error ? error.message : String(error)
      return false
    }
    this.removePane(team, pane)
    return true
  }

  private removePane(team: AgentTeam, pane: TeamPane): void {
    team.panes.delete(pane.fakePaneId)
    team.handleToPane.delete(pane.handle)
    team.paneOrder = team.paneOrder.filter((id) => id !== pane.fakePaneId)
  }

  private async sendCommand(
    pane: TeamPane,
    command: string,
    api: AgentTeamsTerminalApi
  ): Promise<void> {
    const staging = stageStartupCommand({ command, shellPath: 'sh' })
    if (staging.failure) {
      throw new Error(`无法暂存 teammate 启动命令: ${staging.failure}`)
    }
    try {
      if (staging.scriptPath) {
        const terminal = await api.showTerminal(pane.handle)
        if (terminal.executionHostId !== 'local') {
          throw new Error('无法确认目标终端可访问本机暂存命令')
        }
      }
      const result = await api.sendTerminal(
        pane.handle,
        { text: staging.command, enter: true },
        { inputKind: 'orchestration' }
      )
      if (!result.accepted) {
        throw new Error('teammate 启动命令未被终端接受')
      }
    } catch (error) {
      discardStagedStartupCommand(staging)
      throw error
    }
  }

  private resolvePane(team: AgentTeam, paneId: string): TeamPane {
    const pane = team.panes.get(paneId)
    if (!pane) {
      throw new Error(`unknown session: ${paneId}`)
    }
    return pane
  }

  private expectNoArgs(args: string[], command: string): void {
    if (args.length > 0) {
      throw new Error(`usage: it2 session ${command}`)
    }
  }
}

type ParsedOptions = {
  flags: Set<string>
  values: Map<string, string>
  positional: string[]
}

function parseOptions(
  args: string[],
  valueFlags: Set<string>,
  boolFlags: Set<string>
): ParsedOptions {
  const flags = new Set<string>()
  const values = new Map<string, string>()
  const positional: string[] = []
  let options = true
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i] ?? ''
    if (options && arg === '--') {
      options = false
      continue
    }
    if (options && boolFlags.has(arg)) {
      flags.add(arg)
      continue
    }
    if (options && valueFlags.has(arg)) {
      const value = args[++i]
      if (!value || value.startsWith('-')) {
        throw new Error(`missing value for ${arg}`)
      }
      values.set(arg, value)
      continue
    }
    if (options && arg.startsWith('-')) {
      throw new Error(`unsupported option: ${arg}`)
    }
    positional.push(arg)
  }
  return { flags, values, positional }
}
