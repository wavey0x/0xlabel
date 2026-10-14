# Local checksum primitive

`keccak.js` bundles only `keccak_256` from MIT-licensed **@noble/hashes 2.4.0**. Its license is in `LICENSE`. There is no runtime package installation, CDN, network lookup, or application build step.

Source: https://github.com/paulmillr/noble-hashes/tree/2.4.0

The npm tarball is `noble-hashes-2.4.0.tgz`, with SHA-512 integrity:

```
sha512-X5XaVWZIBCT7HHZGm5I7ZQXDwLG+bGXuSrMQAW+7Zvl87h1kmc1ZB1VSRJcpUfoUrGQp4Fkoxm5kZ+Ms+aW+eA==
```

To regenerate, extract `sha3.js`, `utils.js`, and `_u64.js` from that tarball into a temporary directory. Add `entry.js` containing:

```js
export { keccak_256 } from './sha3.js';
```

Run pinned esbuild 0.28.2 on that entry with `--bundle --format=esm --platform=browser --target=chrome120 --minify --legal-comments=inline` and the banner `/* @noble/hashes 2.4.0 · Keccak-256 only · MIT · see LICENSE and README.md */`. Write the result here as `keccak.js`. Check it with the official EIP-55 vectors in `tests/checksum.test.js`.
