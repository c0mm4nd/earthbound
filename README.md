# Earthbound

Earthbound is a compact cross-chain bridge frontend built around the interaction model popularized by Stargate. It is designed as a fast, single-page execution surface rather than a marketing site, with live quoting, route selection, wallet execution, and transfer tracking in one place.

This repository contains the Next.js application and its thin server-side proxy layer for Stargate and LayerZero APIs. It does not implement a custom bridging backend.

## Highlights

- Stargate-aligned UX focused on fast route selection and execution
- Optional switch from Stargate-backed routing to the LayerZero Direct API
- Automatic live quotes with periodic refresh
- Route comparison and selection in a single-page interface
- Execution tracking with transfer history and LayerZeroScan links
- Chain-aware address validation and per-chain wallet execution flows
- Support for EVM and multiple non-EVM wallet environments

## API Modes

Earthbound currently supports three practical operating modes:

### 1. Stargate

This is the default mode.

- Quotes, user steps, and status requests are routed through `https://stargate.finance/api/vt/*`
- The interface is intentionally tuned to feel close to Stargate's production bridge flow

### 2. LayerZero Direct API

Users can switch to LayerZero mode from the UI.

- Requests are routed through `https://transfer.layerzero-api.com/v1/*`
- The app asks the user for a LayerZero API key before enabling direct mode
- The key is stored only in the current browser under `earthbound.layerzero_api_key`
- Requests are forwarded through this app's server routes using the `x-bridge-api-key` header

### 3. Stargate v2 Fallback

If the user switches to LayerZero mode but does not provide an API key, Earthbound falls back to:

- `https://stargate.finance/api/v2/*`

This keeps part of the routing surface available without requiring a direct LayerZero API key. When a route is unavailable in fallback mode, the upstream response makes that limitation explicit.

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
