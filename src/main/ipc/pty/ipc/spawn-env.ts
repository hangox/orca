import {
  isTerminalLeafId,
  makePaneKey,
  parseLegacyNumericPaneKey
} from '../../../../shared/workspace-layout/stable-pane-id'
import { isOpaqueRemintedPaneKey } from '../../../../shared/workspace-layout/pane-key-alias'
import { isValidTerminalTabId } from '../../../../shared/workspace-layout/terminal-surfaces/terminal-tab-id'
import { LocalPtyProvider } from '../../../providers/local-pty/local-pty-provider'
import { resolvePathEnvKey } from '../../../pty/environment/windows-path-segment-merge'
import { routesFreshSpawnsToLocalProvider } from '../host-env/fresh-spawn-routing'
import { parseValidPaneKey } from '../pane/key-state'
import { shouldRefreshNativeClaudeAgentTeamsEnv } from '../pane/launch-authority'
import { selectWindowJcodeRuntimeDir, stampPtySpawnPaneEnv } from '../host-env/spawn-pane-env'
import type { PtyIpcSpawnState } from './spawn-state'
import { assemblePtyIpcSpawnCodexEnv } from './spawn-env-codex'
import { prepareAntigravityAccountForLaunch } from '../../../antigravity/native-account-launch'

export async function assemblePtyIpcSpawnEnv(ctx: PtyIpcSpawnState): Promise<void> {
  const args = ctx.args
  // Daemon providers bypass LocalPtyProvider environment assembly; inject the same host-local state here.
  const baseEnvWithAuth = ctx.claudeAuth ? { ...args.env, ...ctx.claudeAuth.envPatch } : args.env
  const spawnPaneKey = baseEnvWithAuth?.ORCA_PANE_KEY
  const parsedSpawnPaneKey = parseValidPaneKey(spawnPaneKey)
  const verifiedPaneKey =
    parsedSpawnPaneKey &&
    typeof args.tabId === 'string' &&
    args.tabId === parsedSpawnPaneKey.tabId &&
    args.leafId === parsedSpawnPaneKey.leafId
      ? makePaneKey(parsedSpawnPaneKey.tabId, parsedSpawnPaneKey.leafId)
      : null
  ctx.verifiedLeafId = verifiedPaneKey && parsedSpawnPaneKey ? parsedSpawnPaneKey.leafId : null
  ctx.metadataLeafId =
    typeof args.leafId === 'string' && isTerminalLeafId(args.leafId) ? args.leafId : null
  ctx.metadataPaneKey =
    typeof args.tabId === 'string' &&
    isValidTerminalTabId(args.tabId) &&
    args.tabId.length <= 512 &&
    ctx.metadataLeafId
      ? makePaneKey(args.tabId, ctx.metadataLeafId)
      : null
  ctx.legacySpawnPaneKey = verifiedPaneKey ? null : parseLegacyNumericPaneKey(spawnPaneKey)
  const normalizedSpawnPaneKey = spawnPaneKey?.trim() ?? ''
  ctx.opaqueRemintedSpawnPaneKey =
    verifiedPaneKey || !isOpaqueRemintedPaneKey(normalizedSpawnPaneKey)
      ? null
      : normalizedSpawnPaneKey
  ctx.migrationUnsupportedPaneKey =
    ctx.legacySpawnPaneKey &&
    typeof args.tabId === 'string' &&
    args.tabId === ctx.legacySpawnPaneKey.tabId &&
    typeof args.leafId === 'string' &&
    isTerminalLeafId(args.leafId)
      ? makePaneKey(args.tabId, args.leafId)
      : null
  ctx.stablePaneKey = verifiedPaneKey ?? ctx.migrationUnsupportedPaneKey ?? ctx.metadataPaneKey
  ctx.baseEnv = baseEnvWithAuth ? { ...baseEnvWithAuth } : undefined
  let agentTeamsProtocol =
    (baseEnvWithAuth?.ORCA_AGENT_TEAMS_PROTOCOL ??
      args.launchConfig?.agentEnv.ORCA_AGENT_TEAMS_PROTOCOL) === 'it2'
      ? 'it2'
      : 'tmux'
  const teamEnv = { ...args.launchConfig?.agentEnv, ...baseEnvWithAuth }
  const hasAgentTeam = Boolean(teamEnv.ORCA_AGENT_TEAMS_TEAM_ID)
  const liveAgentTeam = hasAgentTeam && Boolean(ctx.deps.runtime?.isLiveClaudeAgentTeam(teamEnv))
  const staleIt2 = hasAgentTeam && !liveAgentTeam && agentTeamsProtocol === 'it2'
  const autoIt2 =
    process.platform === 'darwin' &&
    !args.connectionId &&
    (ctx.deps.getSettings?.() ?? ctx.deps.store?.getSettings())?.claudeAgentTeamsMode === 'it2'
  const shouldRefreshAgentTeamsEnv =
    !ctx.preAdoptedStablePane &&
    !liveAgentTeam &&
    ctx.deps.runtime !== undefined &&
    ctx.stablePaneKey !== null &&
    (autoIt2 ||
      staleIt2 ||
      shouldRefreshNativeClaudeAgentTeamsEnv({
        command: args.command,
        launchConfig: args.launchConfig
      }))
  ctx.effectiveLaunchConfig = args.launchConfig
  const shouldPreAllocateTerminalHandle =
    ctx.deps.runtime !== undefined &&
    ((!(ctx.provider instanceof LocalPtyProvider) &&
      !routesFreshSpawnsToLocalProvider(ctx.provider)) ||
      shouldRefreshAgentTeamsEnv)
  const runtime = ctx.deps.runtime
  ctx.preAllocatedHandle = shouldPreAllocateTerminalHandle
    ? (ctx.preAdoptedStablePane?.owner.handle ??
      runtime?.createPreAllocatedTerminalHandle() ??
      null)
    : null
  if (shouldRefreshAgentTeamsEnv && ctx.preAllocatedHandle && runtime) {
    // Agent Teams tokens are process-local; regenerate them for the new leader PTY.
    const prepared = await runtime.prepareClaudeAgentTeamsLeaderForHandle({
      handle: ctx.preAllocatedHandle,
      baseEnv: ctx.baseEnv ?? {},
      ...(autoIt2 || staleIt2 ? { mode: 'it2' as const } : {})
    })
    agentTeamsProtocol = prepared.env.ORCA_AGENT_TEAMS_PROTOCOL === 'it2' ? 'it2' : 'tmux'
    ctx.agentTeamsLeaderHandle = ctx.preAllocatedHandle
    ctx.baseEnv = {
      ...ctx.baseEnv,
      ...prepared.env
    }
    if (args.launchConfig) {
      ctx.effectiveLaunchConfig = {
        ...args.launchConfig,
        agentEnv: {
          ...args.launchConfig.agentEnv,
          ...prepared.env
        }
      }
    }
  }
  ctx.requestedAgentTeamsPath = ctx.baseEnv?.ORCA_AGENT_TEAMS_TEAM_ID
    ? ctx.baseEnv[resolvePathEnvKey(ctx.baseEnv, process.platform)]
    : undefined
  ctx.agentTeamsEnvToDelete =
    shouldRefreshAgentTeamsEnv || (hasAgentTeam && agentTeamsProtocol === 'it2')
      ? agentTeamsProtocol === 'it2'
        ? ['TMUX', 'TMUX_PANE']
        : ['TERM_PROGRAM']
      : undefined
  stampPtySpawnPaneEnv(ctx.baseEnv, {
    // Renderer keys select bookkeeping, while environment identity must name this spawn's actual pane.
    pane: ctx.stablePaneKey
      ? {
          paneKey: ctx.stablePaneKey,
          tabId: typeof args.tabId === 'string' ? args.tabId : undefined,
          worktreeId: typeof args.worktreeId === 'string' ? args.worktreeId : undefined
        }
      : null,
    jcodeRuntimeDir:
      ctx.baseEnv && ctx.stablePaneKey
        ? selectWindowJcodeRuntimeDir(ctx.stablePaneKey, ctx.isDaemonHostSpawn)
        : undefined
  })
  ctx.validatedPaneKey = ctx.stablePaneKey
  // Tab/leaf metadata still identifies the pane when its supplied ORCA_PANE_KEY was unproved.
  ctx.reservationPaneKey = ctx.metadataPaneKey ?? ctx.validatedPaneKey
  ctx.validatedLeafId = ctx.verifiedLeafId ?? ctx.metadataLeafId
  ctx.spawnTiming.mark('pane_env')
  await assemblePtyIpcSpawnCodexEnv(ctx)
  await prepareAntigravityAccountForLaunch({
    launchAgent: args.launchAgent,
    command: args.command ?? args.launchConfig?.agentCommand,
    connectionId: args.connectionId,
    isWsl: ctx.codexSelectionTarget.runtime === 'wsl',
    env: ctx.spawnEnv ?? ctx.baseEnv,
    envToDelete: args.envToDelete
  })
}
