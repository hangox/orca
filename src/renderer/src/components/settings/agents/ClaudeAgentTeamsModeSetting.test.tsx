// @vitest-environment happy-dom
import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { getDefaultSettings } from '../../../../../shared/constants'
import { useAppStore } from '@/store/index'
import { ClaudeAgentTeamsModeSetting } from './ClaudeAgentTeamsModeSetting'
import '../__fixtures__/settings-persistence-test-fixture'

vi.mock('@/app-shell/platform/user-agent-platform', () => ({
  isMacUserAgent: () => true
}))

describe('Claude Agent Teams backend setting', () => {
  it('writes the selected it2 backend', () => {
    useAppStore.setState({ settingsSearchQuery: '' })
    const updateSettings = vi.fn()
    render(
      <ClaudeAgentTeamsModeSetting
        settings={getDefaultSettings('/tmp')}
        updateSettings={updateSettings}
      />
    )

    fireEvent.click(screen.getByRole('radio', { name: 'iTerm2' }))
    expect(updateSettings).toHaveBeenCalledWith({ claudeAgentTeamsMode: 'it2' })
  })
})
