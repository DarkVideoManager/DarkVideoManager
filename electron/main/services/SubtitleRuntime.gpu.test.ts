import { EventEmitter } from 'node:events'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough } from 'node:stream'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const calls = vi.hoisted(() => ({
  commands: [] as { command: string; args: string[] }[],
  pathCommands: [] as string[][],
  failNative: false,
  userData: '',
}))
vi.mock('electron', () => ({
  app: { isPackaged: false, getAppPath: () => process.cwd(), getPath: () => calls.userData },
}))
vi.mock('node:child_process', () => ({
  execFile: (
    _command: string,
    args: string[],
    _options: unknown,
    callback: (error: Error | null, stdout: string) => void,
  ) => {
    calls.pathCommands.push(args)
    callback(null, `/mnt/c/${args.at(-1)!.replaceAll('\\', '/')}`)
  },
  spawn: (command: string, args: string[]) => {
    calls.commands.push({ command, args })
    const child = Object.assign(new EventEmitter(), {
      stdin: new PassThrough(),
      stdout: new PassThrough(),
      stderr: new PassThrough(),
      kill: vi.fn(),
    })
    setImmediate(() => {
      const native = command.endsWith('python.exe')
      if (native && calls.failNative) {
        child.stderr.end('Vulkan GPU 초기화에 실패했습니다.')
        child.stdout.end()
        child.emit('close', 1)
        return
      }
      child.stdout.end(
        JSON.stringify({
          phase: 'completed',
          language: 'ja',
          cueCount: 2,
          original: 'original.srt',
          ...(!native && args.includes('--translate-ko') ? { translated: 'ko.srt' } : {}),
        }) + '\n',
      )
      child.emit('close', 0)
    })
    return child
  },
}))
import { subtitleCheckpointEngine, transcribeSubtitleAudio } from './SubtitleRuntime'

describe('subtitle GPU routing and legacy resumes', () => {
  let output: string
  const options = { model: 'base', language: 'ja', translateToKorean: true } as const
  beforeEach(() => {
    output = mkdtempSync(join(tmpdir(), 'dvm-gpu-routing-'))
    calls.userData = output
    calls.commands.length = 0
    calls.pathCommands.length = 0
    calls.failNative = false
  })
  afterEach(() => rmSync(output, { recursive: true, force: true }))
  function checkpoint(backend?: string, complete = false) {
    writeFileSync(
      join(output, 'checkpoint.json'),
      JSON.stringify({
        version: 1,
        identity: backend ? { backend } : {},
        transcription_complete: complete,
      }),
    )
  }
  async function run(translateToKorean = true) {
    return transcribeSubtitleAudio(
      join(output, "영상 '& $.wav"),
      output,
      { ...options, translateToKorean },
      new AbortController().signal,
      vi.fn(),
      true,
    )
  }

  it('starts new jobs on native Vulkan and hands the finished transcript to WSL for Korean', async () => {
    expect(subtitleCheckpointEngine(output).backend).toBe('vulkan')
    expect(await run()).toEqual({ language: 'ja', cueCount: 2, translated: true })
    expect(calls.commands).toHaveLength(2)
    const [native, translation] = calls.commands
    expect(native.command).toMatch(/native[\\/]python[\\/]python.exe$/)
    expect(native.args).toContain('--transcribe-only')
    expect(native.args).toContain('--checkpoint-audio')
    expect(native.args).toContain(join(output, "영상 '& $.wav"))
    expect(translation.command).toBe('wsl.exe')
    expect(translation.args).toContain('--resume')
    expect(translation.args).toContain('vulkan')
  })
  it('finishes original-only GPU jobs without starting a WSL worker', async () => {
    expect((await run(false)).translated).toBe(false)
    expect(calls.commands).toHaveLength(1)
    expect(calls.commands[0].command).toMatch(/python.exe$/)
  })
  it('uses the persisted Linux account for path conversion and translation after Ubuntu changes its default', async () => {
    writeFileSync(
      join(output, 'subtitle-environment.json'),
      JSON.stringify({
        version: 1,
        managedDistributions: [process.env.DVM_WSL_DISTRO || 'Ubuntu-24.04'],
      }),
    )
    expect((await run()).translated).toBe(true)
    const argumentsToWsl = [
      ...calls.pathCommands,
      ...calls.commands.filter((call) => call.command === 'wsl.exe').map((call) => call.args),
    ]
    expect(argumentsToWsl).toHaveLength(4)
    for (const args of argumentsToWsl)
      expect(args.slice(2, 5)).toEqual(['--user', 'dvm-subtitles', '--exec'])
  })
  it('keeps existing CPU checkpoints on their original engine', async () => {
    checkpoint()
    await run()
    expect(calls.commands).toHaveLength(1)
    expect(calls.commands[0].command).toBe('wsl.exe')
    expect(calls.commands[0].args).not.toContain('vulkan')
  })
  it('does not transcribe again when a GPU job only needs translation resumed', async () => {
    checkpoint('vulkan', true)
    await run()
    expect(calls.commands).toHaveLength(1)
    expect(calls.commands[0].command).toBe('wsl.exe')
    expect(calls.commands[0].args).toContain('vulkan')
  })
  it('reports native GPU failure without CPU fallback or translation', async () => {
    calls.failNative = true
    await expect(run()).rejects.toThrow('Vulkan GPU')
    expect(calls.commands).toHaveLength(1)
  })
  it('rejects corrupted or unknown checkpoints instead of changing engines', () => {
    checkpoint('unknown')
    expect(() => subtitleCheckpointEngine(output)).toThrow('진행 내용')
    writeFileSync(join(output, 'checkpoint.json'), '{')
    expect(() => subtitleCheckpointEngine(output)).toThrow('진행 내용')
  })
})
