// One row per supported chain. Adding a network is a single edit here:
// explorer adapters match on `explorer`, Safe matches on `safe` prefixes,
// and the book names a scope from `name`.
export const networks = [
  { chain: '1', name: 'Ethereum', explorer: 'etherscan.io', safe: ['eth'] },
  { chain: '11155111', name: 'Sepolia', explorer: 'sepolia.etherscan.io', safe: ['sep'] },
  { chain: '8453', name: 'Base', explorer: 'basescan.org', safe: ['base'] },
  { chain: '42161', name: 'Arbitrum', explorer: 'arbiscan.io', safe: ['arb1', 'arb'] },
  { chain: '10', name: 'Optimism', explorer: 'optimistic.etherscan.io', safe: ['oeth', 'op'] },
  { chain: '56', name: 'BNB Chain', explorer: 'bscscan.com', safe: ['bnb'] },
  { chain: '137', name: 'Polygon', explorer: 'polygonscan.com', safe: ['matic', 'polygon'] },
  { chain: '100', name: 'Gnosis', explorer: 'gnosisscan.io', safe: ['gno'] },
];

// Chain ids are kept as strings: eip155 permits values beyond Number precision.
const byChain = new Map(networks.map(entry => [entry.chain, entry]));
const byExplorer = new Map(networks.map(entry => [entry.explorer, entry]));
const bySafe = new Map(networks.flatMap(entry => entry.safe.map(prefix => [prefix, entry])));

export const explorerNetwork = hostname => byExplorer.get(hostname) || null;
export const safeNetwork = prefix => bySafe.get(prefix) || null;
export const scopeOf = network => (network ? `eip155:${network.chain}` : undefined);

export function scopeName(scope) {
  if (scope === 'global') return 'All networks';
  const chain = String(scope).slice(7);
  return byChain.get(chain)?.name || `Chain ${chain}`;
}
