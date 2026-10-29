Dependency security patches (2026-10-29)

npm ci / npm install runs patch-package --error-on-fail. Do not use
--ignore-scripts for a deployable installation. Docker copies these patches
before npm ci and runs test:security before building the application.

deepmerge 4.3.1 — GHSA-gcqx-w48m-w2h4 / CVE-2026-93753
  Filter __proto__, constructor and prototype before BOTH target and source
  property-copy loops, including nested merges. Patch the source, CommonJS
  bundle and browser UMD bundle. Upstream has no patched release.
  https://github.com/TehShrike/deepmerge/issues/273

elliptic 6.6.1 — GHSA-848j-6mx2-7j84 / CVE-2025-14505
  Preserve the DRBG byte array until _truncateToN calculates its original
  length. Converting to BN first discards leading zeros. This is the minimal
  change proposed in upstream PR 345 (not yet merged/released).
  https://github.com/indutny/elliptic/pull/345
  Regression coverage includes a P-521 deterministic signature that fails
  without the patch and matches an independently computed Noble signature.

The original package versions deliberately remain intact. npm audit and
Dependabot cannot recognize local patches and still report these two low
severity advisories and their dependent packages. Do not dismiss the alerts
or claim an unqualified zero-vulnerability audit. Replace the patches with
upstream releases once available, then rerun npm run test:security.

Other dependency changes
  Next.js and eslint-config-next: 16.4.3.
  Compatible dependency updates plus explicit overrides remove the remaining
  published critical/high/moderate advisories as of the date above.
  bigint-buffer uses the pinned @exodus/bigint-buffer JavaScript-only fork;
  its published Node and browser bundles contain no native binding loader,
  avoiding the vulnerable native conversion in CVE-2025-3194.
  https://github.com/ExodusMovement/bigint-buffer
  Jayson 5 removes stream-json and uuid; Solana's JSON-RPC browser client API
  is covered with a mocked getBalance request. Node 24 is used in Docker.
  Zod 4.6.7 supports the TON record schema calls used by both installed TON
  SDK versions; tests exercise valid and invalid RPC transaction options.
  TOML 5.0.1 retains Anchor's parse API and uses null-prototype maps.

Validation
  npm ci
  npm run test:security
  npm run test:cctp
  npm run test:ccip
  npm run test:chains
  npm run test:stargate
  npm run build
  npm audit --audit-level=moderate

Security tests use public test values and mocked RPC responses. They do not
connect a wallet, sign a real transaction, or submit transactions to a chain.
