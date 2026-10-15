'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { createHash } = require('node:crypto')
const { execFileSync } = require('node:child_process')

const script = path.join(__dirname, 'verify-release.ps1')
const windowsOnly = { skip: process.platform !== 'win32' }
const digest = (bytes) => createHash('sha256').update(bytes).digest('hex')

function fixture(t, name = 'DarkVideoManager portable.exe') {
  const parent = fs.realpathSync(os.tmpdir())
  const root = fs.mkdtempSync(path.join(parent, 'dvm-verify-release-'))
  t.after(() => {
    const resolved = fs.realpathSync(root)
    assert.equal(path.dirname(resolved), parent)
    assert.ok(path.basename(resolved).startsWith('dvm-verify-release-'))
    fs.rmSync(resolved, { recursive: true, force: true })
  })
  const file = path.join(root, name)
  const checksum = path.join(root, 'SHA256SUMS.txt')
  const bytes = 'This is a benign text fixture, never an executable.\n'
  fs.writeFileSync(file, bytes)
  const hash = digest(bytes)
  fs.writeFileSync(checksum, `${hash}  ${name}\n`)
  return { root, file, checksum, name, hash }
}

function verify(f) {
  // Argument arrays preserve literal Unicode, spaces and brackets without a shell.
  return execFileSync(
    'powershell.exe',
    [
      '-NoProfile',
      '-NonInteractive',
      '-ExecutionPolicy',
      'Bypass',
      '-File',
      script,
      '-FilePath',
      f.file,
      '-ChecksumFile',
      f.checksum,
      '-AsJson',
    ],
    {
      encoding: 'utf8',
      windowsHide: true,
      timeout: 30000,
      stdio: ['ignore', 'pipe', 'pipe'],
      // A parent PowerShell 7 module path would shadow Windows PowerShell's own modules.
      env: Object.fromEntries(
        Object.entries(process.env).filter(([key]) => key.toLowerCase() !== 'psmodulepath'),
      ),
    },
  )
}

function rejects(f, message) {
  assert.throws(
    () => verify(f),
    (error) => {
      assert.equal(error.status, 1)
      assert.match(error.stderr, message)
      return true
    },
  )
}

test(
  'verifies only the selected file with UTF-8 BOM, CRLF and literal Unicode paths',
  windowsOnly,
  (t) => {
    const f = fixture(t, '영상 [portable] sample.exe')
    fs.writeFileSync(
      f.checksum,
      `\ufeff${f.hash.toUpperCase()}  ${f.name}\r\n${'0'.repeat(64)}  not-downloaded.exe\r\n`,
    )
    const result = JSON.parse(verify(f))
    assert.equal(result.FileName, f.name)
    assert.equal(result.ExpectedSha256, f.hash)
    assert.equal(result.ActualSha256, f.hash)
    assert.equal(result.HashMatches, true)
    assert.equal(typeof result.SignatureStatus, 'string')
    assert.equal(result.SignerSubject, null)
  },
)

test('rejects modified file bytes and reports both hashes', windowsOnly, (t) => {
  const f = fixture(t)
  fs.appendFileSync(f.file, 'Changed after download.\n')
  assert.throws(
    () => verify(f),
    (error) => {
      assert.equal(error.status, 1)
      assert.match(error.stderr, /SHA-256 mismatch/)
      const result = JSON.parse(error.stdout)
      assert.equal(result.HashMatches, false)
      assert.equal(result.ExpectedSha256, f.hash)
      assert.notEqual(result.ActualSha256, f.hash)
      return true
    },
  )
})

test('rejects absent or renamed files and missing manifests', windowsOnly, (t) => {
  const f = fixture(t)
  fs.writeFileSync(f.checksum, `${f.hash}  another-release.exe\n`)
  rejects(f, /selected file name is absent/)
  fs.unlinkSync(f.checksum)
  rejects(f, /Checksum file not found or inaccessible/)
  fs.writeFileSync(f.checksum, `${f.hash}  ${f.name}\n`)
  fs.unlinkSync(f.file)
  rejects(f, /Downloaded file not found or inaccessible/)
})

test(
  'rejects duplicate names case-insensitively even for an unselected asset',
  windowsOnly,
  (t) => {
    const f = fixture(t)
    fs.appendFileSync(f.checksum, `${f.hash}  other.exe\n${f.hash}  OTHER.exe\n`)
    rejects(f, /Duplicate checksum file name/)
  },
)

test(
  'rejects malformed hashes and ambiguous or directory-based manifest names',
  windowsOnly,
  (t) => {
    const f = fixture(t)
    for (const invalid of [
      `${'g'.repeat(64)}  ${f.name}`,
      `${f.hash} ${f.name}`,
      `${f.hash}  ../escape.exe`,
      `${f.hash}  ..\\escape.exe`,
      `${f.hash}  C:\\escape.exe`,
      `${f.hash}  *portable.exe`,
      `${f.hash}  portable.exe `,
      `${f.hash}  portable.exe.`,
      `${f.hash}  bad\rname.exe`,
      '',
    ]) {
      fs.writeFileSync(f.checksum, invalid + '\n')
      rejects(f, /Malformed checksum entry|unambiguous file name|no file entries/)
    }
  },
)
