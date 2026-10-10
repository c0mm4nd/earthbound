import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { Script } from 'node:vm';
import ts from 'typescript';
const require = createRequire(import.meta.url);
function load(file, dependencies, globals = {}) {
  const commonJsModule = { exports: {} };
  const { outputText } = ts.transpileModule(readFileSync(new URL(file, import.meta.url), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
  });
  new Script(outputText).runInNewContext({ module: commonJsModule, exports: commonJsModule.exports, require: (id) => dependencies[id] ?? require(id), ...globals });
  return commonJsModule.exports;
}
const calls = [];
const makeMove = (family) => {
  const wallets = ['First', 'Second'].map((name) => ({ name: `${family} ${name}`, accounts: [{ address: 'first-account' }, { address: 'selected-account' }] }));
  const state = { wallet: null, account: null, reject: false };
  return { state, wallets, hooks: {
    useWallets: () => wallets,
    useCurrentWallet: () => ({ currentWallet: state.wallet, isConnected: !!state.wallet }),
    useCurrentAccount: () => state.account,
    useConnectWallet: () => ({ mutateAsync: async ({ wallet }) => {
      calls.push(`${family}:connect:${wallet.name}`);
      if (state.reject) throw new Error('User rejected connection');
      state.wallet = wallet; state.account = wallet.accounts[1];
      return { accounts: wallet.accounts };
    } }),
    useDisconnectWallet: () => ({ mutateAsync: async () => { calls.push(`${family}:disconnect`); state.wallet = null; state.account = null; } }),
    useSignAndExecuteTransaction: () => ({ mutateAsync: async ({ account }) => { calls.push(`${family}:sign:${account.address}`); } }),
  } };
};
const sui = makeMove('sui'), iota = makeMove('iota');
let states = [], cursor = 0;
let tonWallet = null;
const { useBridgeWallets: runWalletHook } = load('../src/lib/bridge-wallet-hooks.ts', {
  react: { useMemo: (fn) => fn(), useEffect: () => {}, useState: (initial) => {
    const index = cursor++;
    if (!(index in states)) states[index] = initial;
    return [states[index], (value) => { states[index] = typeof value === 'function' ? value(states[index]) : value; }];
  } },
  '@mysten/dapp-kit': sui.hooks, '@iota/dapp-kit': iota.hooks,
  '@tonconnect/ui-react': { useTonConnectUI: () => [{ setConnectionNetwork: network => calls.push(`ton:network:${network}`), openModal: async () => calls.push('ton:select'), disconnect: async () => { calls.push('ton:disconnect'); tonWallet = null; } }], useTonWallet: () => tonWallet, useTonAddress: () => tonWallet?.account.address ?? '' },
  '@/lib/wallet-options': { walletIdentifier: (wallet) => wallet.id ?? wallet.name },
  './stellar-wallet': { watchStellarWallet: () => () => {} },
  '@/lib/bridge-wallets': {
    getExternalWalletOptions: () => [],
    connectExternalWallet: async (chain, walletId) => { calls.push(`${chain}:connect:${walletId}`); return { address: 'manual-account', label: walletId, walletId }; },
    disconnectExternalWallet: async (chain, walletId) => calls.push(`${chain}:disconnect:${walletId}`),
    executeAptosUserSteps: async (_steps, _account, walletId) => calls.push(`aptos:sign:${walletId}`),
    executeSuiUserSteps: async (_steps, sign) => sign({}), executeIotaMoveUserSteps: async (_steps, sign) => sign({}),
  },
});
const render = () => { cursor = 0; return runWalletHook(); };
for (const [network, family] of [['SUI', sui], ['IOTAMOVE', iota]]) {
  let hook = render();
  assert.equal(hook.getWalletOptions(network).length, 2);
  const before = calls.length;
  await assert.rejects(hook.connectWallet(network), /No .* wallet found/);
  assert.equal(calls.length, before, 'No implicit selection');
  await hook.connectWallet(network, family.wallets[1].name);
  hook = render();
  assert.equal(hook.walletSessionsByChainType[network].walletId, family.wallets[1].name);
  assert.equal(hook.walletSessionsByChainType[network].address, 'selected-account');
  await assert.rejects(hook.executeUserSteps(network, [], 'first-account'), /wallet changed/);
  await hook.executeUserSteps(network, [], 'selected-account');
  await hook.connectWallet(network, family.wallets[0].name);
  assert.ok(calls.at(-2).endsWith(':disconnect'));
  hook = render();
  assert.equal(hook.walletSessionsByChainType[network].label, family.wallets[0].name);
  await hook.disconnectWallet(network);
  assert.equal(render().walletSessionsByChainType[network], undefined);
  family.state.reject = true;
  await assert.rejects(render().connectWallet(network, family.wallets[1].name), /rejected/);
  assert.equal(render().walletSessionsByChainType[network], undefined);
}
await render().connectWallet('APTOS', 'petra');
await render().executeUserSteps('APTOS', [], 'manual-account');
assert.equal(calls.at(-1), 'aptos:sign:petra');
await render().disconnectWallet('APTOS');
assert.equal(calls.at(-1), 'APTOS:disconnect:petra');
await assert.rejects(render().executeUserSteps('APTOS', [], 'manual-account'), /wallet changed/);
await render().connectWallet('TON', 'tonconnect');
assert.equal(calls.at(-1), 'ton:select');
assert.equal(calls.at(-2), 'ton:network:-239');
tonWallet = { account: { chain: '-239', address: 'ton-mainnet-account' }, device: { appName: 'Test TON wallet' } };
assert.equal(render().walletSessionsByChainType.TON.address, 'ton-mainnet-account');
tonWallet = { ...tonWallet, account: { ...tonWallet.account, chain: '-3' } };
assert.equal(render().walletSessionsByChainType.TON, undefined, 'Testnet wallet cannot receive a mainnet quote');
await render().disconnectWallet('TON');
assert.equal(render().walletSessionsByChainType.TON, undefined);
await render().connectWallet('STELLAR', 'freighter');
assert.equal(render().walletSessionsByChainType.STELLAR.walletId, 'freighter');
await render().disconnectWallet('STELLAR');
assert.equal(render().walletSessionsByChainType.STELLAR, undefined);

const stellarAddress = load('../src/lib/stellar-address.ts', { viem: require('viem') });
const mainnet = 'Public Global Stellar Network ; September 2015';
const account = 'GASFUXQFGKJFVWUCRAHL4WOWE5344SUESN7U7RDLTTJEA5Q4OQWXOWPM';
let detected = true, networkPassphrase = mainnet, access = { address: account }, walletCallback, stopped = false;
const stellar = load('../src/lib/stellar-wallet.ts', {
  './stellar-address': stellarAddress,
  '@stellar/freighter-api': {
    isConnected: async () => ({ isConnected: detected }),
    requestAccess: async () => access,
    getNetworkDetails: async () => ({ networkPassphrase }),
    WatchWalletChanges: class { watch(callback) { walletCallback = callback; } stop() { stopped = true; } },
  },
});
await assert.rejects(stellar.connectStellarWallet(), /Select/);
assert.equal((await stellar.connectStellarWallet('freighter')).address, account);
detected = false;
await assert.rejects(stellar.connectStellarWallet('freighter'), /not detected/);
detected = true; networkPassphrase = 'testnet';
await assert.rejects(stellar.connectStellarWallet('freighter'), /mainnet/);
networkPassphrase = mainnet; access = { error: { message: 'Rejected by user' } };
await assert.rejects(stellar.connectStellarWallet('freighter'), /Rejected/);
const changes = [];
const stop = stellar.watchStellarWallet(address => changes.push(address));
await new Promise(resolve => setImmediate(resolve));
walletCallback({ address: account, networkPassphrase: mainnet });
walletCallback({ address: account, networkPassphrase: 'testnet' });
walletCallback({ address: 'bad-address', networkPassphrase: mainnet });
assert.deepEqual(changes, [account, null, null]);
stop();
assert.equal(stopped, true);
walletCallback({ address: account, networkPassphrase: mainnet });
assert.equal(changes.length, 3, 'Stopped watcher cannot restore a disconnected session');

const selectedCalls = [];
const selectedProvider = { request: async ({ method }) => { selectedCalls.push(method); return '0x2a'; } };
const evm = load('../src/lib/injected-evm.ts', { './execution-safety': { assertSuccessfulEvmReceipt: () => {} } }, {
  window: { ethereum: { request: () => { throw new Error('Wrong default provider used'); } } },
});
const provider = await evm.getConnectorEvmProvider({ getProvider: async () => selectedProvider });
assert.equal(await evm.fetchInjectedEvmBalance({ account: '0x0000000000000000000000000000000000000001', provider }), 42n);
await evm.switchInjectedEvmChain(1, 'Ethereum', provider);
assert.deepEqual(selectedCalls, ['eth_getBalance', 'wallet_switchEthereumChain']);
await assert.rejects(evm.getConnectorEvmProvider(), /Reconnect/);
console.log('Wallet selection: Sui/IOTA explicit choice, selected accounts, switching, rejection, disconnect; Aptos selected execution; TON picker; EVM provider isolation passed.');
