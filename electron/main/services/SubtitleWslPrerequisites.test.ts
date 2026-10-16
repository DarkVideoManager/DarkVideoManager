import { describe, expect, it, vi } from 'vitest'
import { execFileSync } from 'node:child_process'
import {
  preflightSubtitleWsl,
  probeWslPrerequisites,
  requireWslVirtualization,
  type WslPrerequisites,
} from './SubtitleWslPrerequisites'
import type { WslCapture } from './SubtitleWslEnvironment'

const state = (overrides: Partial<WslPrerequisites> = {}): WslPrerequisites => ({
  platform: 'unknown',
  hypervisorPresent: null,
  firmwareVirtualization: null,
  slat: null,
  hypervisorLaunch: 'unknown',
  ...overrides,
})
const output = (value: unknown) => ({
  code: 0,
  output: `DVM_WSL_PREREQUISITES=${JSON.stringify(value)}`,
})

describe('read-only WSL virtualization preflight', () => {
  it.each([
    [state({ hypervisorLaunch: 'off' }), '부팅 시작 설정'],
    [state({ hypervisorPresent: false, firmwareVirtualization: false }), 'BIOS/UEFI'],
    [state({ hypervisorPresent: false, slat: false }), 'SLAT'],
  ] as const)(
    'explains a confirmed blocker without launching any installer: %j',
    (value, message) => {
      expect(() => requireWslVirtualization(value)).toThrow(message)
    },
  )

  it('does not reject hidden CPU capabilities when the hypervisor is already running', () => {
    expect(() =>
      requireWslVirtualization(
        state({
          hypervisorPresent: true,
          firmwareVirtualization: false,
          slat: false,
          hypervisorLaunch: 'off',
        }),
      ),
    ).not.toThrow()
  })

  it('does not mistake unavailable permissions or firmware properties for disabled virtualization', () => {
    expect(() => requireWslVirtualization(state())).not.toThrow()
    expect(() => requireWslVirtualization(state({ firmwareVirtualization: false }))).not.toThrow()
  })

  it('returns unknown for malformed, failed, or unavailable probes without exposing raw output', async () => {
    for (const result of [
      { code: 1, output: 'access denied' },
      { code: 0, output: 'not JSON' },
      { code: 0, output: 'DVM_WSL_PREREQUISITES={' },
    ]) {
      expect(await probeWslPrerequisites(vi.fn<WslCapture>().mockResolvedValue(result))).toEqual(
        state(),
      )
    }
    expect(
      await probeWslPrerequisites(vi.fn<WslCapture>().mockRejectedValue(new Error('timeout'))),
    ).toEqual(state())
  })

  it('keeps valid feature and boolean states but rejects truthy strings', async () => {
    const capture = vi
      .fn<WslCapture>()
      .mockResolvedValue(
        output({
          platform: 'disabled',
          hypervisorPresent: 'false',
          firmwareVirtualization: false,
          slat: true,
          hypervisorLaunch: 'off',
        }),
      )
    expect(await probeWslPrerequisites(capture)).toEqual(
      state({
        platform: 'disabled',
        firmwareVirtualization: false,
        slat: true,
        hypervisorLaunch: 'off',
      }),
    )
    const [command, args, , timeout] = capture.mock.calls[0]
    expect(command).toBe('powershell.exe')
    const script = Buffer.from(args.at(-1)!, 'base64').toString('utf16le')
    expect(script).not.toMatch(/-Verb RunAs|Enable-Windows|Set-VM|\/set |--install/)
    expect(timeout).toBe(15_000)
  })

  it('propagates cancellation instead of silently treating it as unknown', async () => {
    const controller = new AbortController()
    const capture = vi.fn<WslCapture>(async () => {
      controller.abort(new Error('stopped'))
      throw new Error('child aborted')
    })
    await expect(probeWslPrerequisites(capture, controller.signal)).rejects.toThrow('stopped')
  })

  it('blocks preflight using only the fixed read-only probe', async () => {
    const capture = vi
      .fn<WslCapture>()
      .mockResolvedValue(output(state({ hypervisorLaunch: 'off' })))
    await expect(preflightSubtitleWsl(capture, new AbortController().signal)).rejects.toThrow(
      '부팅 시작 설정',
    )
    expect(capture).toHaveBeenCalledOnce()
  })

  it.runIf(process.platform === 'win32')(
    'runs the actual probe script safely with denied/unavailable Windows providers',
    async () => {
      const capture = vi.fn<WslCapture>(async (command, args) => {
        let script = Buffer.from(args.at(-1)!, 'base64').toString('utf16le')
        // No host settings or services are touched; replace only read-only providers.
        script = `function Get-CimInstance { throw 'simulated denied provider' }\n` + script
        return {
          code: 0,
          output: execFileSync(
            command,
            [...args.slice(0, -1), Buffer.from(script, 'utf16le').toString('base64')],
            { encoding: 'utf8', windowsHide: true, timeout: 20_000 },
          ),
        }
      })
      const result = await probeWslPrerequisites(capture)
      expect(result.platform).toBe('unknown')
      expect(result.hypervisorPresent).toBeNull()
      expect(result.firmwareVirtualization).toBeNull()
      expect(result.slat).toBeNull()
    },
  )
})
