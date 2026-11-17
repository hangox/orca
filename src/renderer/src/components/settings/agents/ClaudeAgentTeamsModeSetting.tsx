import type { GlobalSettings } from '../../../../../shared/global-settings-types'
import type { ClaudeAgentTeamsMode } from '../../../../../shared/agent-launch/startup/claude-agent-teams-tmux-compat'
import { isMacUserAgent } from '@/app-shell/platform/user-agent-platform'
import { useTranslate } from '@/i18n/use-translate'
import { SearchableSetting } from '../section-layout/SearchableSetting'
import { SettingsRow, SettingsSegmentedControl } from '../form-controls/SettingsFormControls'

type ClaudeAgentTeamsModeSettingProps = {
  settings: GlobalSettings
  updateSettings: (updates: Partial<GlobalSettings>) => void | Promise<void>
}

export function ClaudeAgentTeamsModeSetting({
  settings,
  updateSettings
}: ClaudeAgentTeamsModeSettingProps): React.JSX.Element {
  const t = useTranslate()
  const isMac = isMacUserAgent()
  const mode = settings.claudeAgentTeamsMode ?? 'off'
  const title = t('components.settings.agents.agentTeams.title', 'Claude Agent Teams')
  const description = t(
    'components.settings.agents.agentTeams.description',
    'Choose how Claude Agent Teams creates teammate terminals. The iTerm2 backend is available on macOS when the Orca it2 shim is installed.'
  )
  return (
    <SearchableSetting
      title={title}
      description={description}
      keywords={['claude', 'agent', 'teams', 'teammate', 'tmux', 'iterm2', 'iTerm2']}
      id="agent-teams-mode"
    >
      <SettingsRow
        label={t('components.settings.agents.agentTeams.modeLabel', 'Backend')}
        description={t(
          'components.settings.agents.agentTeams.modeDescription',
          'Native panes use Orca terminals; iTerm2 uses the Claude Code it2 protocol.'
        )}
        control={
          <SettingsSegmentedControl<ClaudeAgentTeamsMode>
            size="sm"
            value={mode}
            ariaLabel={t('components.settings.agents.agentTeams.modeLabel', 'Backend')}
            onChange={(nextMode) => updateSettings({ claudeAgentTeamsMode: nextMode })}
            options={[
              { value: 'off', label: t('components.settings.agents.agentTeams.off', 'Off') },
              {
                value: 'in-process',
                label: t('components.settings.agents.agentTeams.inProcess', 'In-process')
              },
              {
                value: 'native-panes-shim',
                label: t('components.settings.agents.agentTeams.nativePanes', 'Native panes')
              },
              {
                value: 'it2',
                label: 'iTerm2',
                disabled: !isMac,
                tooltip: !isMac
                  ? t(
                      'components.settings.agents.agentTeams.it2MacOnly',
                      'The iTerm2 backend is available on macOS only.'
                    )
                  : undefined
              }
            ]}
          />
        }
      />
    </SearchableSetting>
  )
}
