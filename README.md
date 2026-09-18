# Earthbound

Earthbound is a compact cross-chain bridge frontend built around the interaction model popularized by Stargate. It is designed as a fast, single-page execution surface rather than a marketing site, with live quoting, route selection, wallet execution, and transfer tracking in one place.

This repository contains the Next.js application and its thin server-side proxy layer for Stargate and LayerZero APIs. It does not implement a custom bridging backend.

## Highlights

- Stargate-aligned UX focused on fast route selection and execution
- Optional switch from Stargate-backed routing to the LayerZero Direct API
- User-managed custom OFT configs for direct LayerZero OFT transfers
- Automatic live quotes with periodic refresh
- Route comparison and selection in a single-page interface
- Execution tracking with transfer history and LayerZeroScan links
- Chain-aware address validation and per-chain wallet execution flows
- Support for EVM and multiple non-EVM wallet environments

## API Modes

Earthbound currently supports four practical operating modes:

### Default: direct OFT transfers

The main transfer form now defaults to direct Endpoint V2 OFT contract calls on the configured EVM networks and Solana ↔ EVM routes. Earthbound discovers the mesh from LayerZero metadata by token address, verifies both peers, underlying tokens, decimals, and enforced receive gas, then calls `quoteOFT`, `quoteSend`, and `send`. ERC20 approvals target the OFT contract directly. This path does not use Stargate quote transactions or its product-fee wrapper and needs no LayerZero Transfer API key.

For EVM pairs missing from the metadata directory, discovery probes the selected tokens for OFT peers in either direction. If neither token exposes the mesh, it requests a Stargate quote and decodes standard OFT `send` targets from supported transaction envelopes as candidate addresses. Every candidate must pass on-chain token and reciprocal-peer checks before the normal quote validation runs. API amounts, approvals, wrapper calls, and fees are never reused for execution. This discovery fallback currently applies to EVM ↔ EVM pairs only.

`LIVE_SIERRA_OFT=1 node scripts/test-direct-oft.mjs` checks SIERRA Ethereum ↔ Avalanche using mainnet reads and compares the Stargate API quote with direct receipts. It never signs or broadcasts a transaction.

Receive amounts reflect on-chain quotes, including local/shared decimal conversion and any OFT contract fee or reward. Direct integration removes the Stargate product fee; it does not promise 1:1 receipt for contracts that charge their own fee, or eliminate messaging and source transaction gas costs.

Unsupported meshes, native assets, other non-EVM networks, or failed validation stop with an error. There is no automatic fallback to a fee-bearing API route. Users can explicitly enable **Use API routes (may include Stargate product fees)** for the existing API flow below. Custom OFT discovery/import remains available for selecting a specific mesh.

Solana uses a lazily loaded official OFT SDK adapter. It validates the OFT Store PDA, program ownership, mint, peer, decimal conversion, and token program. EVM → Solana derives the recipient ATA and adds only missing account-creation rent beyond the enforced receive value. Solana → EVM builds an unsigned v0 transaction with the official LayerZero lookup table and simulates it before wallet signing. Wallet execution checks the payer and expiry and confirms against the transaction's original blockhash; failed on-chain transactions are reported as failures.

The Solana adapter supports the standard SDK account layout and SPL Token, plus Token-2022 mints with only metadata extensions. Custom OFT layouts, transfer hooks, transfer-fee extensions, and Endpoint V1 meshes are rejected explicitly. Solana source wallets need an existing associated token account and SOL for messaging and transaction fees. Configure a Solana RPC in RPC settings if the public endpoint is rate limited.

Run `node scripts/test-solana-direct-oft.mjs` and `node scripts/test-solana-oft-adapter.mjs` for offline coverage. `LIVE_SOLANA_OFT=1 node scripts/test-solana-direct-oft.mjs` checks mainnet EVM → Solana quotes. Also set `SOLANA_SIMULATION_OWNER` to a funded public APE holder address to check Solana → EVM quotes and signature-disabled send simulation; otherwise that reverse check is explicitly skipped. No private key is needed, and the live check never signs or broadcasts transactions.

Direct transactions are re-quoted before execution and again after approvals. Worse receive amounts or higher messaging fees require a new quote. Source confirmation is tracked locally; destination settlement is linked to LayerZeroScan rather than queried with an API quote ID.

### 1. Stargate (API routes)

This is the default provider when users explicitly enable API routes.

- Quotes, user steps, and status requests are routed through `https://stargate.finance/api/vt/*`
- The interface is intentionally tuned to feel close to Stargate's production bridge flow

### 2. LayerZero Direct API

When API routes are enabled, users can switch to LayerZero mode from the UI.

- Requests are routed through `https://transfer.layerzero-api.com/v1/*`
- The app asks the user for a LayerZero API key before enabling direct mode
- The key is stored only in the current browser under `earthbound.layerzero_api_key`
- Requests are forwarded through this app's server routes using the `x-bridge-api-key` header

### 3. Stargate v2 Fallback

If the user switches to LayerZero mode but does not provide an API key, Earthbound falls back to:

- `https://stargate.finance/api/v2/*`

This keeps part of the routing surface available without requiring a direct LayerZero API key. When a route is unavailable in fallback mode, the upstream response makes that limitation explicit.

### 4. Custom OFT Mode

Users can save custom OFT meshes in the browser and execute them directly.

- Each saved config is one OFT asset mesh containing deployments across chains rather than one fixed source-to-destination pair
- At execution time, the user picks source and destination chains from the deployments stored in that mesh
- Each deployment stores its chain, OFT address, optional spend token address, local decimals, optional approval flag, and optional type
- The UI now splits custom OFT sourcing into two paths: discovery from LayerZero metadata and manual JSON entry
- Manual JSON uses the same shape as LayerZero `GET /list`, so discovery results, pasted JSON, exported JSON, and edited JSON all share one format
- Saved custom OFT configs can be exported and re-imported as LayerZero-style JSON, and older pair-style JSON is still migrated when loaded
- Discovery still uses `https://metadata.layerzero-api.com/v1/metadata/experiment/ofts/list`
- Execution no longer depends on the LayerZero OFT transfer API or a LayerZero API key
- The app now quotes `quoteOFT` and `quoteSend` on-chain, then builds approval and send calldata locally
- Current local execution scope for this mode is Endpoint V2 meshes across the app's supported EVM source and destination routes, with LayerZero V2 endpoint IDs resolved from the official LayerZero chain definitions

## How It Works

The project is split into three main layers:

- UI and state management: single-page bridge flow in [`src/components/bridge-app.tsx`](src/components/bridge-app.tsx)
- Server-side proxy routes: API forwarding and normalization in [`src/app/api/bridge`](src/app/api/bridge)
- Upstream integration and chain logic: request helpers, wallet adapters, and validation in [`src/lib`](src/lib)

Primary integration points:

- Chains: `/api/bridge/chains`
- Tokens: `/api/bridge/tokens`
- Token details: `/api/bridge/token-details`
- Quotes: `/api/bridge/quotes`
- Custom OFT discovery: `/api/bridge/oft-list`
- Build user steps: `/api/bridge/build-user-steps`
- Submit signature: `/api/bridge/submit-signature`
- Transfer status: `/api/bridge/status/[quoteId]`

## Tech Stack

- Next.js 16
- React 19
- TypeScript
- Tailwind CSS 4
- TanStack Query
- `wagmi` and `viem`
- TonConnect, Sui dapp kit, IOTA dapp kit, Solana Web3, and additional chain-specific wallet integrations

## Supported Wallet Execution

Wallet connection and execution logic are implemented per source chain type. The current codebase includes support for:

- EVM via `wagmi` and injected wallets
- Solana via `window.solana` / Phantom-compatible wallets
- Aptos via injected Aptos wallets
- Tron via TronLink
- Starknet via injected Starknet wallets
- TON via TonConnect
- Sui via `@mysten/dapp-kit`
- IOTA Move via `@iota/dapp-kit`

Support here means the frontend knows how to validate addresses, connect wallets, and execute supported user steps for that chain family. Whether a route is actually quotable still depends on upstream API availability.

## Getting Started

### Prerequisites

- Node.js 20+ recommended
- npm

### Install

```bash
npm install
```

### Run in Development

```bash
npm run dev
```

The app will be available at:

```text
http://localhost:3000
```

### Useful Commands

```bash
npm run lint
npm run build
npm run start
```

## Environment Variables

Both variables below are optional:

```bash
NEXT_PUBLIC_APP_URL=https://your-domain.com
LAYERZERO_API_KEY=lz_...
```

### `NEXT_PUBLIC_APP_URL`

- Recommended for production deployments
- Used to derive the public app origin
- Important for generating the TON Connect manifest URL correctly
- Especially useful if your reverse proxy does not forward `x-forwarded-host` or `x-forwarded-proto` reliably

### `LAYERZERO_API_KEY`

- Optional server-side default for LayerZero Direct API access
- If omitted, users can still provide their own key in the browser
- If no key is available at all, the app falls back to Stargate v2 where possible

## Deployment Notes

The Railway deployment target is the `earthbound` service in the `web3research` project's `production` environment. Its generated public domain is `earthbound-production.up.railway.app`. The multi-stage Dockerfile builds Next.js standalone output and serves it as a non-root user on Railway's `PORT` (default 3000).

`railway.json` enables Serverless auto-sleep (`sleepApplication: true`), uses one replica, and checks `/api/health` during deployment. Next.js telemetry is disabled in the build and runtime images. There are no server-side keepalive jobs; active browser quote requests still count as traffic and can keep the service awake. Railway controls the idle threshold, and the first visit after sleeping can incur a cold start.

Deploy the current working tree with the Railway CLI after linking the target service:

```bash
railway link --project web3research --service earthbound --environment production
railway up --service earthbound
```

The default direct OFT path needs no API key. `LAYERZERO_API_KEY` remains optional for LayerZero API routes. Set secrets as Railway service variables; `.env` files are excluded from Docker build context. Request forwarding headers and `RAILWAY_PUBLIC_DOMAIN` supply the public origin; `NEXT_PUBLIC_APP_URL` is an optional override.

TON Connect requires a publicly reachable manifest. This project exposes one at:

- [`src/app/tonconnect-manifest.json/route.ts`](src/app/tonconnect-manifest.json/route.ts)

At runtime, the origin is derived from request headers or `NEXT_PUBLIC_APP_URL` and then consumed by:

- [`src/components/providers.tsx`](src/components/providers.tsx)
- [`src/app/layout.tsx`](src/app/layout.tsx)

If the derived origin is incorrect, TON wallet initialization will fail.

## Repository Layout

```text
src/
  app/
    api/bridge/                Server-side proxy routes
    tonconnect-manifest.json/  TON Connect manifest endpoint
  components/
    bridge-app.tsx             Main bridge UI
    providers.tsx              Multi-wallet provider composition
  lib/
    bridge-chain-utils.ts      Chain-type helpers and address validation
    bridge-types.ts            Shared type definitions
    bridge-wallet-hooks.ts     Wallet state and execution orchestration
    bridge-wallets.ts          Chain-specific execution implementations
    layerzero.ts               Upstream API wrappers
    wagmi.ts                   EVM chain configuration
```

## Notes

- Earthbound is an independent frontend and is not an official Stargate or LayerZero product
- The app is intentionally thin: most route availability and transfer behavior are determined by upstream APIs
- If execution fails on a specific chain, the first places to inspect are [`src/lib/bridge-wallets.ts`](src/lib/bridge-wallets.ts) and [`src/lib/bridge-chain-utils.ts`](src/lib/bridge-chain-utils.ts)
- If quoting or provider behavior looks wrong, start with [`src/lib/layerzero.ts`](src/lib/layerzero.ts) and [`src/app/api/bridge`](src/app/api/bridge)

## Contributing

Issues and pull requests are welcome. If you plan to change bridge behavior, it is usually best to verify both the API proxy routes and the chain-specific execution logic together, since they are tightly coupled.
