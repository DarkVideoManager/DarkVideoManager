// Project-owned memoized value implementation. State stays private to each instance.
const records = new WeakMap()

class Lazy {
  constructor(initialize) {
    records.set(this, { initialize, computed: false, result: undefined })
  }

  get hasValue() {
    return records.get(this).computed
  }

  get value() {
    const record = records.get(this)
    if (!record.computed) {
      // Store only after a successful call. A thrown initializer can be retried;
      // a returned promise, including a rejected promise, is memoized immediately.
      const next = record.initialize.call(this)
      this.value = next
    }
    return record.result
  }

  set value(next) {
    const record = records.get(this)
    record.result = next
    record.computed = true
    record.initialize = undefined
  }
}

exports.Lazy = Lazy
