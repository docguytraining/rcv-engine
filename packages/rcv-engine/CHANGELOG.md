# Changelog

All notable changes to `rcv-engine` are documented here.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/)
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

---

## [1.0.3] — 2026-04-09

### Fixed

Three packaging bugs that made versions 1.0.0–1.0.2 unusable for any
TypeScript consumer, and unusable for any CommonJS consumer regardless of
language. **If you are on 1.0.0, 1.0.1, or 1.0.2, upgrade to 1.0.3.**

- **Type declarations are now shipped.** Previous versions advertised
  `"types": "./dist/types/index.d.ts"` in `package.json` but never built
  that file — both `tsconfig.esm.json` and `tsconfig.cjs.json` had
  `"declaration": false`. TypeScript consumers got
  `Cannot find module 'rcv-engine' or its corresponding type declarations`
  on import. A dedicated `tsconfig.types.json` now emits declaration files
  (with declaration maps) into `dist/types/` as part of `npm run build`.

- **CommonJS output is now actually loadable.** The package sets
  `"type": "module"` at the root, which makes Node interpret every `.js`
  file in the tarball as ESM by default. The CJS build emits real
  CommonJS code to `dist/cjs/*.js`, but without a marker Node would try
  to run it as ESM and crash. Build now drops a minimal
  `dist/cjs/package.json` containing `{"type": "commonjs"}` via
  `scripts/fix-cjs.mjs`, so Node's nearest-package.json lookup flips the
  whole cjs directory to CJS semantics.

- **`exports` map now points at files that exist.** Previously
  `require` resolved to `./dist/cjs/index.cjs`, a path the build never
  produced. It now resolves to `./dist/cjs/index.js`, which the build
  actually emits. The `types` condition is also placed first in the
  condition order, which is required for `moduleResolution: "node16"`
  and `"bundler"` to find type declarations reliably.

### Added

- **Packaging smoke test** (`scripts/test-pack.mjs`, exposed as
  `npm run test:pack`). Builds the package, runs `npm pack`, installs
  the resulting tarball into a throwaway directory, then typechecks and
  runs four consumers against it: TypeScript ESM, TypeScript CJS,
  JavaScript ESM, and JavaScript CJS. Each consumer runs a real IRV
  tabulation and verifies the winner. The existing vitest suite only
  touches `src/`, so it cannot detect packaging bugs — this script
  closes that gap and is wired into `prepublishOnly`, so a broken build
  can no longer reach npm.

- **`CHANGELOG.md`** (this file).

### Changed

- `prepublishOnly` now runs `clean → typecheck → build → test → test:pack`
  in sequence. Any failure in the pack smoke test blocks publication.

### Notes on 1.0.0–1.0.2

Those three versions remain on the npm registry for historical reasons
but should be considered non-functional. They pass their own unit tests
(which import from `src/` directly) but cannot be imported by any
downstream consumer. If you published something depending on them,
please update your pin to `^1.0.3`.

---

## [1.0.2] — 2026-04-07

### Fixed

- CI/publish workflow configuration for npm OIDC Trusted Publishers.

### Known issues (retrospective)

- Package does not ship type declarations.
- CommonJS output is not loadable by Node.

See 1.0.3 for the fix.

---

## [1.0.1] — 2026-04-06

### Fixed

- Repository URLs corrected in `package.json`.

### Known issues (retrospective)

- Same packaging bugs as 1.0.0; see 1.0.3.

---

## [1.0.0] — 2026-04-06

### Added

- Initial public release.
- Instant Runoff Voting (IRV) tabulation, single-winner.
- Scottish Single Transferable Vote (STV) per the 2007 Order, including
  Weighted Inclusive Gregory surplus transfers.
- Three tie-break strategies: seeded random, previous round, and
  caller-provided order.
- Write-in support with admin-supplied alias grouping.
- Strict input validation with typed error codes.
- `formatAuditLog()` for plain-language round-by-round narratives.
- Deterministic input hashing via `hashInput()` for independent
  re-verification.
- 141 unit, golden, and property-based tests.
- Algorithm and auditing documentation (`docs/algorithm.md`,
  `docs/auditing.md`).

### Known issues (retrospective)

- Package does not ship type declarations.
- CommonJS output is not loadable by Node.

See 1.0.3 for the fix.
