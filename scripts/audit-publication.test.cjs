'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { spawnSync } = require('node:child_process')
const { auditRepository, inspectText, inspectPath } = require('./audit-publication.cjs')

const scanner = path.resolve(__dirname, 'audit-publication.cjs')
const fakeToken = () => ['gh', 'p_', 'X'.repeat(36)].join('')
const credentialLine = value => `${['api', 'Key'].join('')}: ${JSON.stringify(value)}`

function git(root, ...args) {
  const result = spawnSync('git', ['-c', 'commit.gpgsign=false', '-c', 'core.hooksPath=', ...args], { cwd: root, encoding: 'utf8' })
  assert.equal(result.status, 0, `Fixture Git operation failed: ${args[0]}`)
  return result.stdout.trim()
}

function temporaryRepository(t) {
  const tempParent = fs.realpathSync(os.tmpdir())
  const root = fs.mkdtempSync(path.join(tempParent, 'dvm-publication-audit-'))
  t.after(() => {
    const resolved = fs.realpathSync(root)
    assert.equal(path.dirname(resolved), tempParent)
    assert.ok(path.basename(resolved).startsWith('dvm-publication-audit-'))
    fs.rmSync(resolved, { recursive: true, force: true })
  })
  git(root, 'init', '--quiet')
  git(root, 'config', 'user.name', 'Publication scanner fixture')
  git(root, 'config', 'user.email', 'scanner@example.com')
  return root
}

test('recognizes credential families without returning their values', () => {
  const values = [
    fakeToken(),
    ['A', 'KIA', 'A'.repeat(16)].join(''),
    ['AI', 'za', 'a'.repeat(35)].join(''),
    ['sk', '-', 'z'.repeat(24)].join(''),
    ['-----BEGIN ', 'PRIVATE KEY-----'].join(''),
    ['https:', '//account:', 'value-for-fixture@host.example'].join(''),
  ]
  for (const value of values) {
    const findings = inspectText(value, 'source.js')
    assert.ok(findings.some(f => f.severity === 'error'))
    assert.ok(!JSON.stringify(findings).includes(value))
  }
})

test('detects generic credential literals even in a test file', () => {
  const findings = inspectText(credentialLine('arbitrary-fixture-value'), 'src/app.test.ts')
  assert.deepEqual(findings, [{ rule: 'credential-literal', severity: 'error', line: 1 }])
  assert.deepEqual(inspectText(credentialLine('YOUR_API_KEY'), '.env.example'), [])
})

test('reports personal paths but allows loopback development endpoints', () => {
  const homePath = ['C:', 'Users', 'private-person', 'project'].join('\\')
  assert.equal(inspectText(homePath, 'README.md')[0]?.rule, 'personal-home-path')
  assert.deepEqual(inspectText(['http:', '//127.0.0.1:5173'].join(''), 'config.ts'), [])
})

test('rejects private data and generated publication files', () => {
  for (const file of ['.env.production', 'library.db', 'library.db-wal', 'credentials.json', 'private.pem', 'resources/native/binding.node']) {
    assert.ok(inspectPath(file).some(f => f.severity === 'error'))
  }
  assert.deepEqual(inspectPath('.env.example'), [])
  assert.deepEqual(inspectPath('resources/icon.ico'), [])
})

test('scans untracked source, honors ignores, and fails CLI without leaking values', t => {
  const root = temporaryRepository(t)
  const value = fakeToken()
  fs.writeFileSync(path.join(root, '.gitignore'), '.env.private\nnode_modules/\n')
  fs.writeFileSync(path.join(root, '.env.private'), value)
  fs.mkdirSync(path.join(root, 'node_modules'))
  fs.writeFileSync(path.join(root, 'node_modules', 'ignored.js'), value)
  fs.writeFileSync(path.join(root, 'untracked.js'), value)
  const result = auditRepository(root)
  assert.equal(result.counts.workingFiles, 2)
  assert.equal(result.errors, 1)
  assert.equal(result.findings[0].path, 'untracked.js')
  const cli = spawnSync(process.execPath, [scanner, '--root', root, '--json'], { encoding: 'utf8' })
  assert.equal(cli.status, 1)
  assert.ok(!cli.stdout.includes(value))
  assert.ok(!cli.stderr.includes(value))
})

test('still inspects force-tracked ignored files and skips tracked deletions', t => {
  const root = temporaryRepository(t)
  fs.writeFileSync(path.join(root, '.gitignore'), '.env.production\n')
  fs.writeFileSync(path.join(root, '.env.production'), fakeToken())
  git(root, 'add', '-f', '.env.production')
  assert.ok(auditRepository(root).errors >= 2)
  fs.unlinkSync(path.join(root, '.env.production'))
  assert.equal(auditRepository(root).errors, 0)
})

test('history scan includes all refs and commit messages, without changing Git', t => {
  const root = temporaryRepository(t)
  fs.writeFileSync(path.join(root, 'source.txt'), 'safe source\n')
  git(root, 'add', 'source.txt')
  git(root, 'commit', '--quiet', '-m', 'Initial fixture')
  const clean = git(root, 'rev-parse', 'HEAD')
  git(root, 'checkout', '--quiet', '-b', 'historical-only')
  fs.writeFileSync(path.join(root, 'source.txt'), fakeToken())
  git(root, 'add', 'source.txt')
  git(root, 'commit', '--quiet', '-m', ['Commit fixture ', fakeToken()].join(''))
  git(root, 'checkout', '--quiet', '--detach', clean)
  const before = git(root, 'status', '--porcelain')
  assert.equal(auditRepository(root).errors, 0)
  const report = auditRepository(root, { history: true })
  assert.equal(report.counts.historyCommits, 2)
  assert.equal(report.errors, 2)
  assert.ok(report.findings.some(f => f.path === '(commit message)'))
  assert.ok(report.findings.some(f => f.path === 'source.txt'))
  assert.ok(!JSON.stringify(report).includes(fakeToken()))
  assert.equal(git(root, 'status', '--porcelain'), before)
  assert.equal(git(root, 'rev-parse', 'HEAD'), clean)
})

test('makes oversized and binary scan limits visible', t => {
  const root = temporaryRepository(t)
  fs.writeFileSync(path.join(root, 'large.txt'), Buffer.alloc(5 * 1024 * 1024 + 1, 65))
  fs.writeFileSync(path.join(root, 'image.bin'), Buffer.from([0, 1, 2]))
  const report = auditRepository(root)
  assert.equal(report.counts.binaryFiles, 1)
  assert.equal(report.counts.oversizedFiles, 1)
  assert.equal(report.findings[0].rule, 'oversized-file-not-scanned')
})

test('historical generated artifacts are warnings while current copies fail', t => {
  const root = temporaryRepository(t)
  fs.mkdirSync(path.join(root, 'resources', 'native'), { recursive: true })
  const binary = path.join(root, 'resources', 'native', 'binding.node')
  fs.writeFileSync(binary, Buffer.from([0, 1, 2]))
  git(root, 'add', '.')
  git(root, 'commit', '--quiet', '-m', 'Fixture native artifact')
  assert.equal(auditRepository(root).errors, 1)
  fs.unlinkSync(binary)
  const report = auditRepository(root, { history: true })
  assert.equal(report.errors, 0)
  assert.equal(report.findings[0].rule, 'historical-generated-file')
})
