# Project-owned lazy value adapter

The root `.npmrc` sets `install-links=true` so npm installs this module as ordinary package files. Packaged apps do not depend on a source checkout or a dependency-directory junction.

This module implements the `Lazy` interface consumed by electron-updater and electron-builder: an initializer, a read-only `hasValue` flag, and a memoized, assignable `value`. Its WeakMap implementation and tests belong to DarkVideoManager and use the adjacent copy of this project's MIT license.

The npm `lazy-val@1.0.5` archive and its source at `b69ad4119f1b19bdab13c61ee2fcc88d46b89071` declare MIT in package.json but omit the original license text and copyright notice. That omission is also recorded in [the upstream issue](https://github.com/develar/lazy-val/issues/7). This project resolves that dependency to this local implementation through a pinned file dependency and npm override. No upstream grant or copyright notice is fabricated, and release notice validation remains mandatory.

The lockfile records the local resolution. `scripts/lazy-value-compat.test.cjs` covers initialization, shared pending/rejected promises, retry after a synchronous throw, replacement values and receiver binding. Real updater and package checks exercise the consumers.
