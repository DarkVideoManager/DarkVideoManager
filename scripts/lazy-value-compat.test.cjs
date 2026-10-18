const { test } = require('node:test')
const assert = require('node:assert/strict')
const { Lazy } = require('../vendor/lazy-value-compat/index.cjs')

test('does not initialize until read and shares the same pending promise', async () => {
  let calls = 0
  let resolve
  const pending = new Promise((done) => {
    resolve = done
  })
  const value = new Lazy(() => {
    calls++
    return pending
  })
  assert.equal(value.hasValue, false)
  assert.equal(calls, 0)
  assert.equal(value.value, pending)
  assert.equal(value.value, pending)
  assert.equal(value.hasValue, true)
  assert.equal(calls, 1)
  resolve('ready')
  assert.equal(await value.value, 'ready')
})
test('memoizes a rejected promise without retrying the initializer', async () => {
  let calls = 0
  const error = new Error('expected fixture rejection')
  const value = new Lazy(() => {
    calls++
    return Promise.reject(error)
  })
  const first = value.value
  await assert.rejects(first, error)
  assert.equal(value.value, first)
  assert.equal(calls, 1)
})
test('retries a synchronous throw and invokes the initializer with its owning instance', () => {
  let calls = 0
  const value = new Lazy(function () {
    assert.equal(this, value)
    if (++calls === 1) throw new Error('try again')
    return 42
  })
  assert.throws(() => value.value, /try again/)
  assert.equal(value.hasValue, false)
  assert.equal(value.value, 42)
  assert.equal(calls, 2)
})
test('accepts replacement before or after initialization and isolates other instances', () => {
  const value = new Lazy(() => {
    throw new Error('replaced initializer must not run')
  })
  const other = new Lazy(() => 'other')
  value.value = undefined
  assert.equal(value.hasValue, true)
  assert.equal(value.value, undefined)
  value.value = Promise.resolve('replacement')
  assert.ok(value.value instanceof Promise)
  assert.equal(other.hasValue, false)
  assert.equal(other.value, 'other')
})
