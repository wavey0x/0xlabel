import { parseAddress } from './shared.js';
import { keccak_256 } from './vendor/keccak.js';

// EIP-55 is a display format. Keys and API records remain lowercase.
export function checksumAddress(value) {
  const address = parseAddress(value);
  if (!address) throw new Error('Use a full hexadecimal Ethereum address.');
  const hex = address.slice(2);
  const hash = keccak_256(new TextEncoder().encode(hex));
  return '0x' + [...hex].map((letter, index) => {
    const nibble = index % 2 ? hash[index >> 1] & 15 : hash[index >> 1] >> 4;
    return nibble >= 8 ? letter.toUpperCase() : letter;
  }).join('');
}
