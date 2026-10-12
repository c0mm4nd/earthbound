# Earthbound

Earthbound is an independently operated cross-chain bridge with live quoting, route selection, wallet execution, and transfer tracking in one compact interface.

This repository contains the Next.js application and its server-side adapters for Stargate, LayerZero, and Transporter / Chainlink CCIP APIs. It does not implement a custom bridging backend.

## Highlights

- Compact bridge workspace with consistent controls, opaque dialogs, and readable transfer statuses
- Direct OFT transfers by default, with optional Standard or Direct API routing
- User-managed custom OFT configs for direct LayerZero OFT transfers
- Automatic live quotes with periodic refresh
- Route comparison and selection in a single-page interface
- CCIP token catalog, API quotes, wallet execution and persistent transfer tracking
- Execution tracking with transfer history and LayerZeroScan links
- Chain-aware address validation and per-chain wallet execution flows
- Support for EVM and multiple non-EVM wallet environments

## API Modes

Earthbound supports direct transfers, optional API routes, custom OFT configs, and CCIP transfers.

### CCIP transfers

The token and chain selectors merge Transporter's live curated token configuration and the public [CCIP directory](https://docs.chain.link/ccip/directory/) with the existing catalog. Transporter includes assets that are not yet present in the public directory, so both sources are retained. Deployments are deduplicated by chain and address; destination availability follows each source's directed token routes, not symbol matching. Catalog requests are deduplicated and cached for five minutes. Each source can fall back independently and displays a notice when unavailable.

Transporter currently serializes its curated list into its server-rendered page. The adapter parses only JSON records from that response and never executes page scripts. Its network identifiers and native currencies are mapped in `src/lib/transporter-networks.ts`; live directory router addresses take precedence over that snapshot. A changed page format falls back to the public directory rather than silently returning an empty catalog.

For supported pairs, Earthbound requests CCIP quotes independently of the **Get quotes from third parties** toggle. EVM sources use Transporter's `getTotalFeesEstimate`; Solana → EVM uses `getFeeData` with chain-specific message encoding. Aptos → EVM calls the router's HTTP View API (`get_fee`) because the Transporter Aptos fee endpoint currently returns an upstream error. Latency comes from `getLaneLatency`. Quotes require no API key or OFT discovery. Amounts use integer arithmetic, account for token transfer deductions and destination decimals, and show the native CCIP fee separately from source transaction gas. Missing USD valuations are not treated as zero fees.

Supported EVM-source token routes to EVM, Solana and Aptos execute inside Earthbound. Transactions are encoded locally using the catalog router and chain selector. The wallet approves the exact token amount (resetting a nonzero insufficient allowance first), then calls `ccipSend` with native fee payment, no message data, and zero receiver callback gas. The displayed fee includes a 1% ceiling; the transaction sends only the current router fee. Quotes are refreshed before approval and before sending. Changes to the route, receiver, amount, router, fee ceiling or estimated receive amount stop execution for review. Every transaction is simulated before wallet submission. Hedera native payment applies the documented 8-to-18 decimal conversion.

Submitted bridge hashes are saved before receipt confirmation. The CCIP v2 messages API tracks destination delivery, with an in-app **Check status** action after reload or a tracking outage. An indexing delay remains pending; destination execution failures are flagged for recovery without inviting another source transfer. The CCIP Explorer link provides message and recovery details. A quoted receive amount is an estimate, not an on-chain minimum guarantee.

Solana-source sends use the official Chainlink SDK on the server to build a single atomic approval/send transaction, with mainnet, payer, validity and simulation checks before wallet submission. Aptos-source sends rebuild `router::ccip_send` entry-function arguments locally and verify the selected wallet's account and mainnet network. Non-EVM fee amounts include an estimate buffer; their routers charge the fee at execution, so the buffer is not an on-chain cap. Both families save source hashes before confirmation and support source-status recovery after reload.

Canton assets are catalogued and the official Canton dApp SDK provides CIP-0103 wallet discovery and party selection. **Canton CCIP sending and receiving remain gated:** participant access, fee services and destination settlement are not complete. Other chain families without a current CCIP mainnet token deployment retain their existing OFT/API support. EVM execution requires a configured source RPC. Transporter endpoints are application APIs, so their schema or availability can change; failures are surfaced without discarding successful quotes from other providers.

Native conversions use exact deployed token addresses and directed CCIP lanes. Supported local wrapping assets are ETH on Ethereum / Optimism / Base / Arbitrum / Linea, 0G, ASTR, HSK, RON, PROS and TAO on their respective native networks. A token named WETH on another native network does not become that network's gas token. Native 0G → Solana, for example, uses the W0G lane and its 18-to-9 decimal conversion; it delivers W0G, not SOL. Native BNB, AVAX, POL, SOL and APT have no matching token lanes in the current CCIP catalog and are not invented from fee-currency support.

ETH transfers between Ethereum, Optimism, Base and Arbitrum retain atomic EtherSenderReceiver wrapping and destination unwrapping, with delivery to the source wallet's same address. Other native routes wrap locally, approve the exact wrapped amount, then send through CCIP. Mixed native/wrapped routes are supported. Selecting native output on a staged route delivers wrapped tokens first; the recipient selects **Unwrap** in Transfers and pays destination gas. Separate wrap/unwrap hashes survive refreshes. An interrupted source wrap is checked before continuing with the already wrapped tokens. Quotes verify runtime code and proxy implementations; paused CCIP sources are blocked before wrapping.

TAO uses ForeverMoney's root staking vault (`depositLiquid` / `withdrawLiquid`), with pinned vault code and a verified root-subnet position. It requires at least 0.002 TAO to wrap and 0.01 TAO to unwrap, at most nine decimal places, and exact minimum output. Staking rounding never silently reduces the minimum; a failed conversion reverts. Wrapped TAO crosses the existing CCIP token lane, with manual destination conversion in the receiving wallet.

Validation:

- `node scripts/test-ccip.mjs` — catalog, direction, precision, cache and provider isolation.
- `node scripts/test-ccip-execution.mjs` — approvals, calldata, fee and context guards, submission persistence and CCIP status mapping.
- `npm run test:ccip:native` — native catalog lanes, atomic and staged execution, exact conversions, sender/recipient and deployment binding, fee limits and submission recovery.
- `node scripts/test-ccip-wrapped-native-live.mjs` — read-only mainnet-state wrapping/unwrapping and wrap/approve/CCIP source-send probes; requires Forge and the local app on port 3000. Select networks with `CCIP_NATIVE_CHAINS=16661,964`. Public RPCs receive only reads and `eth_call`; no mainnet transaction is signed or broadcast. These checks do not prove destination settlement.
- `node scripts/test-ccip-native-fork.mjs` — local fork tests for atomic wrap/send, destination unwrap, router-only delivery and WETH fallback. Set `CCIP_NATIVE_FORK_CHAIN` to `1`, `10`, `42161` or `8453`; use the dedicated localhost fork ports documented in the script. Snapshots are restored. No public transaction is signed or broadcast, and these tests do not prove CCIP end-to-end delivery.
- `node scripts/test-ccip-solana.mjs` — independent Solana codec, real unsigned instruction fixture, wallet/network/expiry guards and persistence tests.
- `node scripts/test-ccip-aptos.mjs` — independent Aptos BCS, precision, wallet mainnet/account guards and source confirmation tests.
- `node scripts/test-ccip-canton.mjs` — independent Canton party, official codec, primary account, command-party binding and both-direction development-gate tests; these do not assert complete Canton execution.
- `node scripts/test-execution-history.mjs` — durable records and interrupted-transfer recovery.
- `node scripts/test-ccip-fork.mjs` — LINK Ethereum → Base approval and source send on a **local Anvil fork**; set `CCIP_FORK_DEST=solana` or `CCIP_FORK_DEST=aptos` for non-EVM destinations. Start the local app on port 3000 and an Ethereum Anvil fork on port 18545 first (commands are in the script). It funds only fork state, sends only to localhost, and restores the snapshot afterward. It does not test real destination delivery or broadcast mainnet transactions.

### Circle CCTP

Native USDC on supported EVM, Solana, Aptos, Sui, Starknet and Stellar pairs quotes Circle CCTP Standard and Fast alongside OFT and CCIP, independently of the third-party quote toggle. The local CCTP flow approves the exact USDC amount, verifies both deployments and the burn limit, refreshes fees, and constructs the burn transaction locally. Gas on both networks is paid separately from the displayed protocol fee.

Transfers stores the burn intent and transaction hash before confirmation. It polls the source receipt and Circle's proof service, validates the raw burn message against the original receipt and destination attesters, then exposes **Claim USDC**. A connected wallet for the destination network pays its gas; the minted USDC always goes to the original recipient. Circle's `complete` attestation status is not displayed as delivered: the destination must have consumed the verified message nonce. Refreshing the page preserves recovery; **Recover transaction** accepts a replacement hash from wallet activity, and **Refresh proof** requests re-attestation for an expired Fast proof. Pending CCTP burns are retained beyond the recent-history limit.

The transfer form includes both directions for Solana, Aptos, Sui, Starknet and Stellar, including pairs between different non-EVM families. `/api/bridge/cctp/native` builds unsigned transactions and verifies source receipts, Circle proofs, destination attesters and consumed nonces. Signing remains in the connected wallet: Solana wallets, compatible Aptos script wallets, Sui wallets, Starknet wallets and Stellar Freighter. Uncertain submissions remain pending for recovery instead of triggering another burn.

Non-EVM validation includes independent encoding and wallet tests, read-only mainnet checks, and application lifecycle tests. These checks are not funded end-to-end transfers through Circle's live attestation service. USYC and legacy Noble remain outside this integration.

Solana burn transactions carry a partially signed message account. A two-attester claim fits the packet limit by confirming idempotent recipient-ATA creation separately before receiving. Aptos executes complete scripts so Move receipts cannot be left unconsumed. Sui merges/splits USDC coin objects and uses an address-balance withdrawal for any remainder, then completes the burn/mint tickets atomically; inbound USDC is delivered as a Coin. Stellar amounts and fees are converted from six-decimal wire units to seven-decimal local units, while the forwarder hook retains the entire G/C/M recipient. The transfer form rejects a nonzero seventh Stellar decimal rather than silently changing the amount. The third-party bytecode and reduced IDL fixtures are attributed in `licenses/Circle-CCTP-NOTICE.txt`.

Validation: `npm run test:cctp` covers fee binding, exact approvals, durable submission, proof tampering, pending/reverted claims, replay protection, provider isolation and the five independent non-EVM suites. `node scripts/test-cctp-fork.mjs` exercises deployed Ethereum and Base contracts on localhost forks, including actual source burn and destination mint. Start Anvil on ports 19545/19546 as documented in the script. The test enables a deterministic test attester only in the destination fork and restores both snapshots; it does not broadcast public transactions or prove Circle's live attestation service. Production deployment remains separate from this local work.

#### Catalog and fee preview API

`GET /api/bridge/cctp` returns the verified Circle native-USDC catalog for 30 mainnet domains, including Solana, Aptos, Sui, Starknet and Stellar. Domain IDs are separate from EVM chain IDs. BNB (USYC only) and legacy Noble are excluded from this USDC V2 preview.

`POST /api/bridge/cctp` estimates Standard and supported Fast protocol fees from Circle's public Iris API. Pass `sourceDomain`, `destinationDomain`, `sourceToken`, `destinationToken`, and a decimal string `amount`; an optional `recipient` is validated for the destination family. Both tokens must match Circle's native USDC addresses. For example:

```json
{
  "sourceDomain": 0,
  "destinationDomain": 6,
  "sourceToken": "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48",
  "destinationToken": "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
  "amount": "100"
}
```

This endpoint remains a **fee preview, not an executable route**: `executionReady` is always false. Executable quotes use `/api/bridge/quotes` with `provider: "cctp"` and include a Fast allowance check. The preview excludes gas, forwarding, Fast allowance and onchain limits. Fees use integer arithmetic with upward rounding; Standard fees are read from the API, never assumed to be zero. Stellar source dust is explicit, destination amounts use seven decimals, and inbound routes flag the required `CctpForwarder`.

Run `npm run test:cctp` for core/API tests and independent tests for each non-EVM family. These tests do not send transactions or claim destination settlement. Protocol references: [Circle domains](https://developers.circle.com/cctp/concepts/supported-chains-and-domains), [native USDC addresses](https://developers.circle.com/stablecoins/usdc-contract-addresses), [fee API](https://developers.circle.com/api-reference/cctp/all/get-burn-usdc-fees), and [Stellar behavior](https://developers.circle.com/cctp/references/stellar).

### Default: direct OFT transfers

The main transfer form now defaults to direct Endpoint V2 OFT contract calls on the configured EVM networks, Solana ↔ EVM and verified TON ↔ EVM routes, and EVM → Aptos / Starknet / Tron / Sui / Stellar routes. Earthbound discovers the mesh from LayerZero metadata by token address, verifies both peers, underlying tokens, decimals, and enforced receive gas, then calls `quoteOFT`, `quoteSend`, and `send`. ERC20 approvals target the OFT contract directly. This path does not use Stargate quote transactions or its product-fee wrapper and needs no LayerZero Transfer API key.

For EVM pairs missing from the metadata directory, discovery probes the selected tokens for OFT peers in either direction. If neither token exposes the mesh, it requests a Stargate quote and decodes standard OFT `send` targets from supported transaction envelopes as candidate addresses. Every candidate must pass on-chain token and reciprocal-peer checks before the normal quote validation runs. API amounts, approvals, wrapper calls, and fees are never reused for execution. This discovery fallback also supports EVM → Solana, validating the destination store and its reverse peer with the Solana adapter.

Solana adapters are selected automatically from on-chain program identity. USD.AI's Console OFT has a bidirectional adapter for Solana ↔ EVM: its store layout, initializer PDA, peer, token program, mint authority, escrow, lookup tables, token pause state, ATA rent, and destination rate limits are validated. sUSDai Arbitrum → Solana therefore quotes and builds a direct OFT send without a Stargate product-fee wrapper or a manual API switch. Active transfer hooks remain unsupported; sUSDai's hook is currently disabled. Console OFT sources discover stores through the mint authority (including Token-2022 multisigs), verify reciprocal EVM peers and token identity, simulate the deployed quote instructions, and build native Console send instructions using the issuer's lookup tables and LayerZero endpoint accounts. This does not require API hints or indexed Solana RPC queries. Unknown layouts never silently fall back to an API route.

As checked on October 8, 2026, USDai and sUSDai Solana → Arbitrum both pass direct quotes and unsigned send simulations. Their Solana peers for Ethereum, Base, and Plasma are absent; sUSDai Ethereum → Solana also has no API quote; automatic adapter selection cannot create a missing on-chain path. Ethereum ↔ Arbitrum peers are configured. Run `node scripts/test-console-oft.mjs` for dispatch, discovery, send serialization, quote decoding and receive-policy regressions. `LIVE_CONSOLE_OFT=1 NODE_USE_ENV_PROXY=1 node scripts/test-console-oft-send-live.mjs` runs both Solana → Arbitrum routes with empty metadata, no API hints and unsigned send simulation (public test holders need sufficient token/SOL balances). `LIVE_SUSDAI_OFT=1 node scripts/test-susdai-direct-oft.mjs` compares direct and API Arbitrum quotes, validates calldata, and runs the deployed receive-account planner plus ATA creation in an unsigned simulation. It never signs or broadcasts and does not simulate end-to-end message delivery.

Solana store discovery now also reads mint authorities, multisig signers and metadata escrow PDAs for standard and legacy deployments. The legacy LayerZero `OftConfig` adapter (including USDe, sUSDe and ENA) verifies the case-sensitive `Oft` PDA, token authority, peers, endpoint, send library, ATA state and custody liquidity, and builds its `quote`/`send` instructions directly. The live regression checks both Ethereum directions for all three tokens and simulates their unsigned Solana sends.

Native EVM OFT adapters recognize the catalog's Eeee sentinel and on-chain zero token address, skip ERC-20 approvals, and send the dustless principal plus messaging fee as `msg.value`. Destination native liquidity is checked. The old Sonic and Sei native deployments have a broken `quoteOFT`; their reviewed dust-only receipt calculation is enabled only when chain, address and complete runtime bytecode hash match. Fees still come from the deployed `quoteSend`. Changed or unknown implementations retain normal on-chain quoting and fail closed. APE, CHZ, XDC, S and SEI → Solana pass unsigned EVM send simulations; those simulations override only a dummy sender's balance.

Run `node scripts/test-legacy-solana-oft.mjs` and `node scripts/test-direct-oft.mjs` for the offline adapter and native-asset regressions. `LIVE_OFT_PEERS=1 NODE_USE_ENV_PROXY=1 node scripts/test-oft-peer-live.mjs` runs the live checks above; `SOLANA_RPC_URL` optionally selects a read-capable RPC. These checks do not sign, broadcast or prove eventual cross-chain delivery. A configured peer alone is insufficient: reciprocal peers, compatible accounting, active contracts, message libraries, issuer options and destination liquidity must also pass.

ORDER uses its own 64-byte recipient/uint256 message, with 18 decimal places on EVM and 10 on Solana. The direct adapter pins the eight reviewed EVM proxy implementations and Solana program deployment, verifies caller restrictions, reciprocal peers, mint authority, integer bounds, rate limits and destination escrow capacity, and preserves sub-Solana dust in the EVM sender's wallet. Ethereum, Base, Arbitrum, BSC, Optimism, Polygon, Abstract and Avalanche have live bidirectional quote coverage; all eight Solana outbound sends were simulated and their emitted uint256 packets checked. An Arbitrum outbound send was also simulated using a public holder (native gas balance override only).

PEAQ's native asset on chain 3338 is exposed through the ERC-20 balances precompile at `0x0000000000000000000000000000000000000809`. Its OFT adapter requires approval to that precompile and fee-only `msg.value`; the native principal is transferred through `transferFrom`. Destination escrow capacity is checked through `balanceOf`. PEAQ/Solana quotes and unsigned source sends pass in both directions; the PEAQ simulation uses a public holder with real balance and allowance, without state overrides. S, APE, CHZ, SEI, XDC, INJ and RBNT also have bidirectional Solana quotes and source-send simulations (EVM simulations override only dummy-sender native balances).

Run `node scripts/test-orderly-oft.mjs` for codec, implementation, amount and caller guards. `LIVE_ORDERLY_OFT=1 NODE_USE_ENV_PROXY=1 node scripts/test-orderly-oft-live.mjs` repeats the ORDER mainnet checks. The peer live suite also covers PEAQ, INJ and RBNT; `LIVE_OFT_SYMBOLS=PEAQ,INJ,RBNT` optionally selects those cases. Live checks use public holder fixtures and never sign or broadcast. The follow-up results are in `reports/oft-adapter-followup-2026-10-08.json`.

Single-hop API discovery also supports EVM → Aptos, Starknet, Tron, Sui, Stellar, and verified TON implementations. Composed sends, nonempty OFT commands, intermediate endpoint IDs, multi-step API routes, and single-step routes marked MULTIHOP are excluded from candidate discovery. A same-origin read-only endpoint validates destination state using fixed public RPC hosts (Sui GraphQL, Aptos REST/views, Starknet RPC, Tron constant-contract calls, Stellar Soroban simulations, TON account cells). Destination wallet selection or the explicit third-party recipient override is still required. Aptos, Starknet, Tron, Sui and Stellar currently support receiving from EVM. The reviewed TON implementations also support sending to EVM.

Destination checks include reverse peers, token identity, local/shared decimals, recipient encoding, and receive capacity. Aptos supports standard mint/burn and escrow FA implementations, verifies legacy Coin → FA pairing, rejects blocked recipients and frozen escrows, and caps receipts by escrow liquidity. Starknet checks pause status and enabled inbound rate limits. Sui validates package capabilities, shared objects, coin metadata, pause status, and inbound capacity; unknown escrow treasury layouts remain unsupported. Tron reads the standard OFT ABI, validates Base58Check addresses, and paces public RPC requests.

As checked on October 8, 2026, 11 additional routes have passed mainnet read-only quote and calldata comparisons: Ethereum → Aptos (USDe, sUSDe, WBTC), Base → Aptos (KGEN), BNB → Aptos (ELON), Ethereum → Starknet (WBTC, SolvBTC), Ethereum → Tron (USDe, sUSDe, HARD), and Ethereum → Sui (WBTC). Run `node scripts/test-non-evm-direct-oft.mjs` for offline guards, or `LIVE_NON_EVM_OFT=1 node scripts/test-non-evm-direct-oft.mjs` for live comparisons. Tests never sign or broadcast; quote success does not prove end-to-end delivery. Hypercore and IOTA direct destinations remain unsupported. No fee-bearing API fallback is automatic.

Stellar additionally passed mainnet read-only comparisons for Ethereum → Stellar USDe, ENA, sUSDe, USDT, and PYUSD. Its adapter validates StrKey checksums, G/C recipient resolution, reverse peers, mint/burn or escrow credit types, pause state, rate limits, and escrow liquidity. Unsigned credit simulations check the exact received amount and reject missing trustlines before quoting. Run `node scripts/test-stellar-direct-oft.mjs` for offline guards, or `LIVE_STELLAR_OFT=1 node scripts/test-stellar-direct-oft.mjs` for mainnet quote comparisons. No transaction is signed or broadcast.

TON receiving supports the verified EthenaOFT and XAUt0 OFT implementations. Mainnet read-only API/direct comparisons cover Ethereum → TON (USDe, ENA, XAUT → XAUt0) and Arbitrum / Polygon / Avalanche → TON (XAUt0). The adapter hashes deployed OFT, Jetton minter, and Jetton wallet code against reviewed versions, verifies reciprocal token/mint authority links, mainnet initialization, reverse peers, six-decimal accounting, receive gas configuration, and the derived recipient Jetton wallet. New Jetton wallets are supported; frozen accounts, incoming-transfer locks, changed implementations, and RPC failures block the quote. These contracts enforce pause and rate limits on outbound sends; inbound minting replenishes outbound capacity. The adapter preserves issuer-enforced executor options rather than equating those options with the TON contract's internal gas assertion. TON source execution is implemented for these reviewed OFT/minter/wallet code versions. It checks outbound pause/rate limits, chain time, source wallet locks and execution-time token/native balances; resolves the actual channel/message library; calls its on-chain ULN quote; preserves issuer options; and calculates source gas from current config 21. The browser reconstructs and checks the exact payload locally. Tokens are transferred to the minter for burning and forwarding to OFT, with refunds addressed to the sender. Unsigned mainnet-state TVM simulations verify PACKET_SENT and OFTSentSucceed for USDe/ENA → Ethereum and XAUt0 → Ethereum/Arbitrum/Polygon/Avalanche, including the recipient and amount in the 153-byte packet. This does not prove eventual destination delivery.

The TON layouts and credit policy were checked against deployed verified source bundles returned by TONAPI `/v2/blockchain/accounts/{address}/inspect`; the source URLs and account-cell fixtures are recorded in `scripts/fixtures/ton-oft.json`. Production uses read-only Toncenter account lookups. Run `node scripts/test-ton-direct-oft.mjs` for offline guards and `LIVE_TON_OFT=1 node scripts/test-ton-direct-oft.mjs` for fresh API/direct mainnet comparisons. TON USDT's liquidity-backed `usdtOFT` implementation is not yet covered: the deployed code is not verified by TONAPI, and its current storage differs from the retrievable SDK/audit layouts; UDS has an unverified OFT code version and remains unsupported. A matching token symbol or an API quote never bypasses implementation checks. Run `node scripts/test-ton-send.mjs` for source guards and official-codec comparisons. `LIVE_TON_SEND=1 NODE_USE_ENV_PROXY=1 node scripts/test-ton-send-live.mjs` runs both-direction quotes and local TON source simulations against mainnet state; it never signs or broadcasts. `TON_SEND_CASE=USDe:ethereum` optionally selects a single case. TON SDK/quote logic stays server-side; only DTO checks and the compact transfer serializer enter the browser.

`LIVE_SIERRA_OFT=1 node scripts/test-direct-oft.mjs` checks SIERRA Ethereum ↔ Avalanche using mainnet reads and compares the Stargate API quote with direct receipts. It never signs or broadcasts a transaction.

Receive amounts reflect on-chain quotes, including local/shared decimal conversion and any OFT contract fee or reward. Direct integration removes the Stargate product fee; it does not promise 1:1 receipt for contracts that charge their own fee, or eliminate messaging and source transaction gas costs.

Unsupported meshes, native assets, unsupported source/destination families, or failed validation stop with an error. There is no automatic fallback to a fee-bearing API route. Users can explicitly enable **Get quotes from third parties** (provider fees may apply) for the existing API flow below. Custom OFT discovery/import remains available for selecting a specific mesh.

Solana uses a lazily loaded official OFT SDK adapter. It validates the OFT Store PDA, program ownership, mint, peer, decimal conversion, and token program. EVM → Solana derives the recipient ATA and adds only missing account-creation rent beyond the enforced receive value. Solana → EVM builds an unsigned v0 transaction with the official LayerZero lookup table and simulates it before wallet signing. Wallet execution checks the payer and validity before signing, then confirms the returned signature via HTTP status polling. Wallet-broadcast transactions are not expired using the pre-wallet blockhash because the wallet may rebuild the message. When the app broadcasts a known signed message itself, expiration requires finalized block height plus a historical signature lookup. RPC errors remain pending; on-chain execution errors are reported as failures.

The standard Solana adapter supports the SDK account layout and SPL Token, plus ordinary public-balance transfers for Token-2022 mints with metadata, mint-close authority, permanent delegate, and opt-in confidential extensions. Transfer-fee configurations are supported only when both current and scheduled fees are zero; transfer hooks must be disabled. Pausable mints are supported while unpaused. This includes USDG's current configuration. New destination ATA rent includes the required fee/hook/pausable account state. Active hooks, nonzero transfer fees, other unsupported extensions, unrecognized OFT layouts, and Endpoint V1 meshes are rejected explicitly. Solana source wallets need an existing associated token account and SOL for messaging and transaction fees. The default Solana RPC is PublicNode because the official public endpoint rejects browser-origin requests with 403. Configure a custom Solana RPC in RPC settings if the public endpoint is rate limited.

Run `node scripts/test-solana-direct-oft.mjs` and `node scripts/test-solana-oft-adapter.mjs` for offline coverage. `LIVE_SOLANA_OFT=1 node scripts/test-solana-direct-oft.mjs` checks mainnet EVM → Solana quotes. Also set `SOLANA_SIMULATION_OWNER` to a funded public APE holder address to check Solana → EVM quotes and signature-disabled send simulation; otherwise that reverse check is explicitly skipped. No private key is needed, and the live check never signs or broadcasts transactions.

Run `node scripts/test-solana-token-extensions.mjs` for USDG extension-policy and rent regressions. `LIVE_USDG_OFT=1 SOLANA_SIMULATION_OWNER=<funded-public-USDG-holder> node scripts/test-usdg-direct-oft.mjs` checks USDG quotes in both directions, an unsigned Solana send simulation, and actual ATA size/rent through simulation. The SDK and app share a pinned `@solana/web3.js` version because LayerZero checks `Connection` class identity during quotes.

When a Solana RPC rejects indexed owner-balance queries, the balance display falls back to the associated token account used by direct OFT. Other token accounts are not included in that fallback balance.

Direct transactions are re-quoted before execution and again after approvals. Worse receive amounts or higher messaging fees require a new quote. Source confirmation is tracked locally; destination settlement is linked to LayerZeroScan rather than queried with an API quote ID.

### 1. Standard API routes

This is the default provider when users explicitly enable **Get quotes from third parties**.

- Quotes, user steps, and status requests are routed through `https://stargate.finance/api/vt/*`
- The interface labels this provider **Standard**

### 2. LayerZero Direct API

When **Get quotes from third parties** is enabled, users can select **Direct API** from the UI.

- Requests are routed through `https://transfer.layerzero-api.com/v1/*`
- The app asks the user for a LayerZero API key before enabling direct mode
- The key is stored only in the current browser under `earthbound.layerzero_api_key`
- Requests are forwarded through this app's server routes using the `x-bridge-api-key` header

### 3. Default API fallback

If the user selects Direct API but does not provide an API key, Earthbound falls back to:

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

The header **Wallets** panel lets users select a detected wallet, view/copy the connected address, switch wallets, and disconnect for every supported chain family, independently of the selected bridge route. Sui/IOTA use the wallet’s selected account; EVM chain switching and fallback balance reads use the selected connector. TON opens its native wallet selector. Disconnect clears the app session; extension-level site permissions remain under the wallet’s control.

The destination defaults to the connected wallet for the destination chain family and is read-only. Cross-family transfers require that destination wallet to be connected, unless the user explicitly enables **Send to a third-party address** and enters a valid recipient. Third-party overrides are scoped to the selected destination chain. Disconnecting the destination wallet immediately clears the default recipient and invalidates its quote; a compatible address format alone never substitutes a source wallet for another chain family.

- EVM via `wagmi`, EIP-6963 wallet discovery, and a legacy injected-wallet fallback
- Solana via explicit Backpack / Phantom selection, plus compatible `window.solana` wallets. Connection, signing, and disconnect use the selected provider; account changes invalidate quotes and update balances.
- Aptos via compatible injected Aptos / Petra providers
- Tron via TronLink
- Starknet via explicit Argent X / Braavos / compatible injected wallet selection
- Stellar via Freighter for destination accounts, with mainnet validation, account/network change tracking, copy, and app-session disconnect. Stellar source execution is not implemented.
- TON via TonConnect, restricted to mainnet; testnet sessions do not supply destination addresses. Raw basechain and checksummed mainnet friendly addresses are accepted.
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

The layout fills desktop viewports without a fixed maximum width. The compact header places the operator attribution beside Earthbound. Toggle controls support keyboard operation; dialogs and floating notifications use opaque backgrounds. Transfer statuses are formatted for display instead of exposing internal status codes. Transfer history uses compact summaries with expandable details and independent scrolling. The most recent 30 records are written immediately to versioned localStorage and survive refresh, closing tabs, and browser restarts on the same site. Existing sessionStorage history is migrated automatically. Open tabs receive history updates through storage events; storage failures are shown in the Transfers panel. Solana submissions expose the signature immediately, offer a read-only **Check status** action, and block the same transfer while confirmation remains unresolved. Notifications are deduplicated and limited to two.

Run `node scripts/test-solana-confirmation.mjs` for confirmation/expiration regressions, and `node scripts/test-bridge-wallet-payload-guards.mjs` for selected-wallet submission and transaction safety checks.

Run `node scripts/test-execution-history.mjs` for durable history, session migration, interrupted submissions, merging, and storage-failure regressions.
