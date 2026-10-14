import { describe, expect, it, vi } from 'vitest'
import { existsSync, mkdtempSync, readFileSync, rmdirSync, unlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
vi.mock('electron', () => ({ app: { isPackaged: false, getAppPath: () => process.cwd() } }))
import { runSubtitleCommand } from './SubtitleRuntime'

describe('subtitle subprocess lifecycle', () => {
  it('replies to worker JSONL requests on stdin and aborts the lifetime when it exits', async () => {
    const responses: unknown[] = []
    let lifetime: AbortSignal | undefined
    await runSubtitleCommand(
      process.execPath,
      [
        '-e',
        "console.log(JSON.stringify({request:true})); require('node:readline').createInterface({input:process.stdin}).on('line',line=>{console.log(line);process.exit(0)})",
      ],
      {
        onLine: (line, reply, signal) => {
          lifetime = signal
          const value = JSON.parse(line)
          if (value.request) reply({ text: '한국어 번역' })
          else responses.push(value)
        },
      },
    )
    expect(responses).toEqual([{ text: '한국어 번역' }])
    expect(lifetime?.aborted).toBe(true)
  })
  it('passes spaces and shell metacharacters as literal arguments', async () => {
    const lines: string[] = []
    const filename = "C:\\영상 폴더\\movie '& $();.wav"
    await runSubtitleCommand(process.execPath, ['-e', 'console.log(process.argv[1])', filename], {
      onLine: (line) => lines.push(line),
    })
    expect(lines).toEqual([filename])
  })

  it('uses stdin EOF for cooperative cancellation and waits for the process to finish', async () => {
    const controller = new AbortController()
    const lines: string[] = []
    const work = runSubtitleCommand(
      process.execPath,
      [
        '-e',
        "process.stdin.resume(); console.log('ready'); process.stdin.on('end',()=>setTimeout(()=>{process.stderr.write('cancelled'); process.exit(130)},30))",
      ],
      {
        signal: controller.signal,
        cooperative: true,
        onLine: (line) => {
          lines.push(line)
          controller.abort()
        },
      },
    )
    await expect(work).rejects.toMatchObject({ name: 'AbortError' })
    expect(lines).toEqual(['ready'])
  })

  it('ignores late translation replies during cancellation and after the worker exits', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'dvm-subtitle-late-reply-'))
    const auditFile = join(directory, 'stdin.json')
    const controller = new AbortController()
    let reply: ((value: unknown) => void) | undefined
    let lifetime: AbortSignal | undefined
    let markReady!: () => void
    const ready = new Promise<void>((resolve) => {
      markReady = resolve
    })
    const work = runSubtitleCommand(
      process.execPath,
      [
        '-e',
        "let input='';process.stdin.setEncoding('utf8');process.stdin.on('data',chunk=>{input+=chunk});process.stdin.on('end',()=>setTimeout(()=>{require('node:fs').writeFileSync(process.argv[1],JSON.stringify({input,ended:true}));process.exit(130)},60));console.log('ready')",
        auditFile,
      ],
      {
        signal: controller.signal,
        cooperative: true,
        onLine: (line, write, signal) => {
          if (line === 'ready') {
            reply = write
            lifetime = signal
            markReady()
          }
        },
      },
    )
    const rejected = expect(work).rejects.toMatchObject({ name: 'AbortError' })
    try {
      await Promise.race([ready, work])
      expect(reply).toBeTypeOf('function')
      controller.abort()
      expect(lifetime?.aborted).toBe(true)
      const response = { type: 'cloud_translation_response', id: 1, ok: true, text: '늦은 번역' }
      // Simulate the HTTP promise settling after cancellation but before the
      // cooperative worker has finished handling EOF.
      await Promise.resolve().then(() => {
        expect(() => reply!(response)).not.toThrow()
      })
      await rejected
      expect(() => reply!(response)).not.toThrow()
      // Parent line callbacks stop on cancellation, so audit actual child input
      // independently rather than relying on a suppressed stdout event.
      expect(JSON.parse(readFileSync(auditFile, 'utf8'))).toEqual({ input: '', ended: true })
    } finally {
      controller.abort()
      await work.catch(() => undefined)
      if (existsSync(auditFile)) unlinkSync(auditFile)
      rmdirSync(directory)
    }
  })

  it('reports process failures and handles cancellation before spawn', async () => {
    await expect(
      runSubtitleCommand(process.execPath, [
        '-e',
        "process.stderr.write('no audio track'); process.exit(1)",
      ]),
    ).rejects.toThrow('no audio track')
    const controller = new AbortController()
    controller.abort()
    expect(() => runSubtitleCommand('does-not-exist', [], { signal: controller.signal })).toThrow(
      '취소',
    )
  })
})
