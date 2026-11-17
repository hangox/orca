import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { getBashShellReadyRcfileContent } from '../../providers/local-pty/local-pty-shell-ready-bash-rcfile'
import { getDaemonBashShellReadyRcfileContent } from '../../daemon/shell-readiness/daemon-bash-shell-ready-rcfile'
import {
  buildLocalShellReadyWrapperFiles,
  getLocalZshWrapperSpec
} from '../../providers/local-pty/local-pty-shell-ready-wrapper-fileset'
import { buildDaemonShellReadyWrapperFiles } from '../../daemon/shell-readiness/daemon-shell-ready-wrapper-fileset'
import { getDaemonZshWrapperSpec } from '../../daemon/shell-readiness/daemon-zsh-shell-ready-wrapper-spec'
import { buildZshStartupHook } from './zsh-startup-wrapper-builder'
import { getFishShellReadyInitCommand } from './shell-templates'
import { getPowerShellOsc133Bootstrap } from './powershell-osc133-bootstrap'

const hasShell = (shell: string) => spawnSync(shell, ['--version']).status === 0
const folderReport = '\x1b]7;file://localhost/HOME/sub%20%C3%A9%2541%23%3F\x07'
const promptMark = '\x1b]133;A\x07'

describe('prompt cwd reports', () => {
  let home: string
  beforeEach(() => {
    home = realpathSync(mkdtempSync(join(tmpdir(), 'orca-prompt-cwd-')))
    mkdirSync(join(home, process.platform === 'win32' ? 'sub é%41#' : 'sub é%41#?'))
  })
  afterEach(() => rmSync(home, { recursive: true, force: true }))

  for (const [name, shell, wrapper] of [
    ['local bash', 'bash', getBashShellReadyRcfileContent],
    ['relay bash', 'bash', getDaemonBashShellReadyRcfileContent],
    ['local zsh', 'zsh', () => buildZshStartupHook(getLocalZshWrapperSpec())],
    ['relay zsh', 'zsh', () => buildZshStartupHook(getDaemonZshWrapperSpec())]
  ] as const) {
    it.skipIf(process.platform === 'win32' || !hasShell(shell))(
      `${name} reports cd before the next prompt and corrects a child's report`,
      () => {
        const wrapperPath = join(home, shell === 'zsh' ? 'zsh/.zshenv' : 'rcfile')
        mkdirSync(join(home, 'zsh'))
        writeFileSync(wrapperPath, wrapper())
        const profile = 'set -u\nexport LC_ALL=C.UTF-8\nPS1="USER> "\n'
        writeFileSync(join(home, '.bash_profile'), profile)
        writeFileSync(join(home, '.zshrc'), profile)
        const result = spawnSync(
          shell,
          shell === 'bash' ? ['--noprofile', '--rcfile', wrapperPath, '-i'] : ['-i'],
          {
            cwd: home,
            // An ASCII command creates the same UTF-8 path even under a minimal system locale.
            input: "cd sub*\nfalse\nprintf '\\033]7;file:///foreign\\007'\nexit 0\n",
            encoding: 'utf8',
            env: {
              PATH: process.env.PATH ?? '/usr/bin:/bin',
              HOME: home,
              USER: 'orca-test',
              ZDOTDIR: join(home, 'zsh'),
              ORCA_ORIG_ZDOTDIR: home,
              ORCA_SHELL_FEATURES: 'markers,ready',
              TERM: 'xterm'
            },
            timeout: 10_000
          }
        )
        expect(result.status).toBe(0)
        const output = `${result.stdout}${result.stderr}`.replaceAll(home, '/HOME')
        expect(output).toContain(`${folderReport}\x1b]133;D;0\x07${promptMark}`)
        expect(output).toContain(`${folderReport}\x1b]133;D;1\x07${promptMark}`)
        expect(output).toContain(
          `\x1b]7;file:///foreign\x07${folderReport}\x1b]133;D;0\x07${promptMark}`
        )
        expect(result.stderr).not.toContain('unbound variable')
        expect(output).toContain('USER> ')
      }
    )
  }

  it.skipIf(process.platform === 'win32' || !hasShell('zsh')).each([
    ['local', buildLocalShellReadyWrapperFiles, false, 'it2'],
    ['daemon', buildDaemonShellReadyWrapperFiles, true, 'it2'],
    ['off', buildLocalShellReadyWrapperFiles, true, 'off'],
    ['tmux', buildLocalShellReadyWrapperFiles, true, 'tmux']
  ] as const)('%s zsh login shell 保留用户配置与 it2 PATH', (_name, build, custom, mode) => {
    const root = join(home, 'wrappers')
    const user = custom ? join(home, 'user') : home
    const shim = join(home, 'shim')
    const decoy = join(home, 'decoy')
    for (const dir of [user, shim, decoy]) {
      mkdirSync(dir, { recursive: true })
    }
    for (const [file, content] of build(root)) {
      mkdirSync(join(file, '..'), { recursive: true })
      writeFileSync(file, content)
    }
    for (const dir of [shim, decoy]) {
      writeFileSync(join(dir, 'it2'), '#!/bin/sh\n', { mode: 0o755 })
    }
    writeFileSync(join(user, '.zshenv'), 'export ORCA_TEST_TRACE="${ORCA_TEST_TRACE}E"\n')
    writeFileSync(
      join(user, '.zprofile'),
      `export ORCA_TEST_TRACE="\${ORCA_TEST_TRACE}P"\nexport PATH="${decoy}:$PATH"\n`
    )
    writeFileSync(join(user, '.zshrc'), 'export ORCA_TEST_TRACE="${ORCA_TEST_TRACE}R"\n')
    writeFileSync(join(user, '.zlogin'), 'export ORCA_TEST_TRACE="${ORCA_TEST_TRACE}L"\n')
    const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`
    const nested = 'printf "RESULT:%s:%s:%s\\n" "$ORCA_TEST_TRACE" "$(command -v it2)" "$PATH"'
    const child = `/bin/zsh -lc ${quote(nested)}`
    const result = spawnSync(
      '/bin/zsh',
      ['-lic', `__orca_deferred_init; /bin/zsh -lc ${quote(child)}`],
      {
        cwd: home,
        encoding: 'utf8',
        env: {
          HOME: home,
          PATH: `${shim}:/usr/bin:/bin`,
          ZDOTDIR: join(root, 'zsh'),
          ...(custom ? { ORCA_ORIG_ZDOTDIR: user } : {}),
          ORCA_SHELL_FEATURES: 'overlay',
          ORCA_AGENT_TEAMS_PROTOCOL: mode,
          ORCA_AGENT_TEAMS_SHIM_DIR: shim
        },
        timeout: 10_000
      }
    )
    expect(result.status, result.stderr).toBe(0)
    const line = result.stdout.split('\n').find((value) => value.includes('RESULT:')) ?? ''
    expect(line).toContain(`RESULT:EPRLEPLEPL:${mode === 'it2' ? shim : decoy}/it2:`)
    expect(line.split(':').filter((part) => part === shim)).toHaveLength(1)
  })

  it.skipIf(process.platform === 'win32' || !hasShell('fish'))(
    'fish reports cd before readiness without replacing the user prompt or its own OSC 7',
    () => {
      const result = spawnSync(
        'fish',
        [
          '--no-config',
          '-c',
          `
function fish_prompt
  printf 'USER> '
end
${getFishShellReadyInitCommand('\\033]777;orca-shell-ready\\007')}
cd sub*
emit fish_prompt
fish_prompt
printf '\\033]7;file:///foreign\\007'
emit fish_prompt
fish_prompt
`
        ],
        {
          cwd: home,
          encoding: 'utf8',
          env: { PATH: process.env.PATH, HOME: home },
          timeout: 10_000
        }
      )
      expect(result.status).toBe(0)
      const output = `${result.stdout}${result.stderr}`.replaceAll(home, '/HOME')
      expect(output).toContain(`${folderReport}\x1b]777;orca-shell-ready\x07USER> `)
      expect(output).toContain(`\x1b]7;file:///foreign\x07${folderReport}USER> `)
    }
  )

  it.skipIf(process.platform !== 'win32').each(['', '\\\\?\\', '\\\\.\\'])(
    'PowerShell reports the filesystem folder before the next prompt with prefix %s',
    (prefix) => {
      const sub = prefix + join(home, 'sub é%41#')
      const result = spawnSync(
        'powershell.exe',
        [
          '-NoProfile',
          '-Command',
          `
function prompt { 'USER> ' }
${getPowerShellOsc133Bootstrap()}
Set-Location -LiteralPath '${sub.replaceAll("'", "''")}'
prompt
`
        ],
        { encoding: 'utf8', timeout: 20_000 }
      )
      expect(result.status).toBe(0)
      const encodedHome = home.replaceAll('\\', '/').split('/').map(encodeURIComponent).join('/')
      const output = result.stdout.replaceAll(
        `file://localhost/${encodedHome}`,
        'file://localhost/HOME'
      )
      expect(output).toContain(
        `\x1b]7;file://localhost/HOME/sub%20%C3%A9%2541%23\x07${promptMark}USER> `
      )
    }
  )
})
