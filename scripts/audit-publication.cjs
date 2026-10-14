#!/usr/bin/env node
'use strict'

// A publication preflight, not a guarantee that arbitrary secrets are absent.
// Never emit matching source text. Ignored working files are not publication candidates.
const fs = require('node:fs')
const path = require('node:path')
const { createHash } = require('node:crypto')
const { spawnSync } = require('node:child_process')
const MAX_BYTES = 5 * 1024 * 1024
const generatedPath = /^(?:node_modules|dist|dist-electron|out|release|test-results|playwright-report|coverage|\.git|resources\/native|resources\/subtitles\/native)(?:\/|$)/

// Individually reviewed synthetic fixtures, restricted to their exact path and
// digest. Changing a fixture requires review; tests are never excluded wholesale.
const reviewedFixtures = new Map([
  ['electron/preload/index.test.ts', ['62af8704764faf8ea82fc61ce9c4c3908b6cb97d463a634e9e587d7c885db0ef']],
  ['src/shared/contracts.test.ts', ['62af8704764faf8ea82fc61ce9c4c3908b6cb97d463a634e9e587d7c885db0ef']],
  ['electron/main/services/CloudTranslationService.test.ts', [
    '1389c325eb7963026b7a183f33656b5a2fedc26b8b7eda012aa6999571834057',
    'e248011e3bf51941c99325cef1553daef105f1db7c8a1f106cc769fd799785bb',
  ]],
  ['resources/subtitles/test_generate.py', ['0ca441a3f0de8a57b99475065b4b4a8a5113e88befd91be77feedc600d9f891a']],
])

const rules = [
  ['private-key', /-----BEGIN (?:RSA |EC |DSA |OPENSSH |ENCRYPTED )?PRIVATE KEY-----/g],
  ['aws-access-key', /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/g],
  ['github-token', /\b(?:gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{50,})\b/g],
  ['google-api-key', /\bAIza[0-9A-Za-z_-]{35}\b/g],
  ['api-token', /\b(?:sk-(?:proj-|svcacct-)?[A-Za-z0-9_-]{20,}|xox[baprs]-[A-Za-z0-9-]{20,}|sk_live_[A-Za-z0-9]{20,})\b/g],
  ['url-credentials', /https?:\/\/[^\s/:@]+:[^\s/@]+@/gi],
]

function inspectText(text, filePath) {
  const findings = []
  for (const [offset, line] of text.split(/\r?\n/).entries()) {
    for (const [rule, expression] of rules) {
      expression.lastIndex = 0
      if (expression.test(line)) findings.push({ rule, severity: 'error', line: offset + 1 })
    }
    const literals = /(?:api[_-]?key|secret|password|access[_-]?token|auth[_-]?token)\s*['"]?\s*[:=]\s*(['"])([^'"\r\n]{8,})\1/gi
    for (const match of line.matchAll(literals)) {
      const value = match[2]
      const digest = createHash('sha256').update(value).digest('hex')
      if (reviewedFixtures.get(filePath)?.includes(digest)) continue
      if (/^(?:<[^>]+>|\$\{[^}]+\}|YOUR_[A-Z_]+|REPLACE[_ -].*|CHANGE[_ -]ME)$/.test(value)) continue
      findings.push({ rule: 'credential-literal', severity: 'error', line: offset + 1 })
    }
    if (/(?:[A-Za-z]:[\\/]+Users[\\/]+(?!Public\b|Default\b)[^\\/\s'"<>]+|\/(?:home|Users)\/[a-zA-Z0-9_.-]+[\/])/.test(line)) {
      findings.push({ rule: 'personal-home-path', severity: 'warning', line: offset + 1 })
    }
    // Loopback servers are intentional in Vite, Playwright and Ollama.
    if (/https?:\/\/(?:(?:10)\.\d+\.\d+\.\d+|192\.168\.\d+\.\d+|172\.(?:1[6-9]|2\d|3[01])\.\d+\.\d+|[a-z0-9.-]+\.(?:internal|corp))(?::\d+)?\b/i.test(line)) {
      findings.push({ rule: 'private-network-address', severity: 'warning', line: offset + 1 })
    }
  }
  return findings
}

function inspectPath(filePath) {
  if (generatedPath.test(filePath)) return [{ rule: 'generated-file-in-source', severity: 'error' }]
  const base = path.posix.basename(filePath)
  if ((/^\.env(?:\.|$)/i.test(base) && base !== '.env.example') ||
    /\.(?:db|sqlite3?)(?:-(?:wal|shm|journal))?$|\.(?:pem|key|p12|pfx)$/i.test(base) ||
    /^(?:id_(?:rsa|dsa|ecdsa|ed25519)|credentials\.json|service-account.*\.json)$/i.test(base)) {
    return [{ rule: 'private-data-file', severity: 'error' }]
  }
  if (/\.(?:mp4|mkv|avi|mov|wmv|srt|vtt|smi)$/i.test(base)) {
    return [{ rule: 'media-or-subtitle-review-required', severity: 'warning' }]
  }
  return []
}

function git(root, args, options = {}) {
  const result = spawnSync('git', args, { cwd: root, maxBuffer: 64 * 1024 * 1024, ...options })
  if (result.error || result.status !== 0) throw new Error(`Git operation failed: ${args[0]}`)
  return result.stdout
}

function auditRepository(root, { history = false } = {}) {
  // Native resolution expands Windows 8.3 aliases as well as junctions. Git may
  // return the long path even when the caller uses a short TEMP directory name.
  root = fs.realpathSync.native(root)
  const repositoryRoot = fs.realpathSync.native(
    git(root, ['rev-parse', '--show-toplevel'], { encoding: 'utf8' }).trim(),
  )
  const sameRoot = process.platform === 'win32'
    ? repositoryRoot.toLowerCase() === root.toLowerCase()
    : repositoryRoot === root
  if (!sameRoot) {
    throw new Error('Run from the repository root or pass --root <repository>.')
  }
  const result = {
    scope: { history, maxTextBytes: MAX_BYTES, working: 'tracked and nonignored untracked source files', historyReachability: history ? 'all refs; excludes dangling objects and reflogs' : null },
    counts: { workingFiles: 0, historyBlobs: 0, historyCommits: 0, binaryFiles: 0, oversizedFiles: 0 },
    findings: [], historyIdentity: null,
  }
  function add(scope, file, object, findings) {
    result.findings.push(...findings.map(f => ({ scope, path: file, ...(object ? { object } : {}), ...f })))
  }
  function scan(scope, file, object, content) {
    if (content.includes(0)) { result.counts.binaryFiles++; return }
    add(scope, file, object, inspectText(content.toString('utf8'), file))
  }
  const files = new Set(git(root, ['ls-files', '--cached', '--others', '--exclude-standard', '-z'], { encoding: 'utf8' }).split('\0').filter(Boolean))
  for (const file of [...files].sort()) {
    const absolute = path.resolve(root, file)
    const relative = path.relative(root, absolute)
    if (relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) throw new Error('Path escaped repository root')
    if (!fs.existsSync(absolute)) continue // Tracked deletion absent from proposed publication.
    const stat = fs.lstatSync(absolute)
    result.counts.workingFiles++
    add('working', file, null, inspectPath(file))
    if (stat.isSymbolicLink()) {
      add('working', file, null, [{ rule: 'symlink-review-required', severity: 'warning' }])
      continue // Never follow a link to a private file outside the repository.
    }
    if (!stat.isFile()) continue
    if (stat.size > MAX_BYTES) {
      result.counts.oversizedFiles++
      add('working', file, null, [{ rule: 'oversized-file-not-scanned', severity: 'warning' }])
      continue
    }
    scan('working', file, null, fs.readFileSync(absolute))
  }
  if (history) {
    const objects = git(root, ['rev-list', '--objects', '--all'], { encoding: 'utf8' }).trim().split('\n').filter(Boolean).map(line => {
      const split = line.indexOf(' ')
      return { id: split < 0 ? line : line.slice(0, split), file: split < 0 ? '(commit message)' : line.slice(split + 1) }
    })
    if (objects.length) {
      const info = git(root, ['cat-file', '--batch-check=%(objectname) %(objecttype) %(objectsize)'], {
        input: objects.map(o => o.id).join('\n') + '\n', encoding: 'utf8',
      }).trim().split('\n')
      const nonNoreplyIdentities = new Set()
      let commitsWithNonNoreplyEmail = 0
      for (const [index, entry] of info.entries()) {
        const [id, kind, bytes] = entry.split(' ')
        if (kind !== 'blob' && kind !== 'commit') continue
        const file = objects[index].file
        if (kind === 'blob') {
          result.counts.historyBlobs++
          // Old generated artifacts need release-history review, but their
          // presence alone is not a secret. Credential contents still fail.
          add('history', file, id, inspectPath(file).map(f => f.rule === 'generated-file-in-source'
            ? { rule: 'historical-generated-file', severity: 'warning' } : f))
        }
        else result.counts.historyCommits++
        if (Number(bytes) > MAX_BYTES) {
          result.counts.oversizedFiles++
          add('history', file, id, [{ rule: 'oversized-file-not-scanned', severity: 'warning' }])
          continue
        }
        const content = git(root, ['cat-file', kind, id])
        if (kind === 'commit') {
          const text = content.toString('utf8')
          const boundary = text.indexOf('\n\n')
          const emails = [...text.slice(0, boundary).matchAll(/^(?:author|committer) .* <([^>]+)>/gm)].map(m => m[1])
          const personal = emails.filter(email => !/@(?:users\.noreply\.github\.com|example\.(?:com|org)|localhost|local)$/.test(email))
          if (personal.length) commitsWithNonNoreplyEmail++
          personal.forEach(email => nonNoreplyIdentities.add(createHash('sha256').update(email).digest('hex')))
          scan('history', '(commit message)', id, Buffer.from(text.slice(boundary + 2)))
        } else scan('history', file, id, content)
      }
      result.historyIdentity = { commitsWithNonNoreplyEmail, uniqueNonNoreplyEmails: nonNoreplyIdentities.size, values: 'redacted' }
    }
  }
  result.errors = result.findings.filter(f => f.severity === 'error').length
  result.warnings = result.findings.filter(f => f.severity === 'warning').length
  return result
}

function main(args) {
  let root = process.cwd(), history = false, json = false
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--history') history = true
    else if (args[i] === '--json') json = true
    else if (args[i] === '--root' && args[i + 1]) root = args[++i]
    else if (args[i] === '--help') {
      console.log('Usage: node scripts/audit-publication.cjs [--history] [--json] [--root <repository>]')
      console.log('Errors fail CI. Warnings need review. Ignored files, large/binary contents and unreachable Git objects are not secret-scanned.')
      return
    } else throw new Error('Unknown or incomplete option; use --help')
  }
  const report = auditRepository(root, { history })
  if (json) console.log(JSON.stringify(report, null, 2))
  else {
    console.log(`Publication audit: ${report.counts.workingFiles} working files, ${report.counts.historyBlobs} historical blobs, ${report.counts.historyCommits} commits.`)
    console.log(`Findings: ${report.errors} errors, ${report.warnings} warnings. Matching values are always redacted.`)
    for (const f of report.findings) console.log(`${f.severity.toUpperCase()} ${f.scope} ${f.path}${f.line ? `:${f.line}` : ''} ${f.rule}${f.object ? ` [${f.object.slice(0, 12)}]` : ''}`)
    if (report.historyIdentity?.commitsWithNonNoreplyEmail) console.log(`History identity review: ${report.historyIdentity.commitsWithNonNoreplyEmail} commits include non-noreply email addresses (values redacted).`)
    console.log('Scope excludes ignored working files and unreachable Git objects. Binary contents and text over 5 MiB need separate review. A pattern scan does not prove all secrets are absent.')
  }
  if (report.errors) process.exitCode = 1
}

module.exports = { auditRepository, inspectText, inspectPath }
if (require.main === module) {
  try { main(process.argv.slice(2)) } catch (error) {
    console.error(`Publication audit failed: ${error.message}`)
    process.exitCode = 1
  }
}
