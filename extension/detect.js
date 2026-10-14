import { parseAddress, query, UNSAFE_HOST } from './shared.js';
import { explorerNetwork, scopeOf } from './networks.js';

// Block explorers and wallet apps address a wallet the same way.
const ADDRESS_PATH = /^\/address\/([^/]+)\/?$/;
const FRAGMENT = /^(?:[a-z]+:)?(0x[0-9a-f]+)[.…]+([0-9a-f]+)$/;

// A link naming a full address. A known explorer host also names its chain.
export function addressLink(element, url) {
  const link = element.closest('a[href]');
  if (!link) return null;
  const href = new URL(link.getAttribute('href'), url);
  const address = parseAddress(href.pathname.match(ADDRESS_PATH)?.[1]);
  return address ? { address, network: scopeOf(explorerNetwork(href.hostname)) } : null;
}

// The site-neutral identity kernel. An adapter describes where a site keeps its
// evidence; these rules decide whether that evidence names exactly one wallet.
// Only complete sources establish identity. A fragment is used solely to check it.
//
//   attributes  hold a full address, read on the element and its parent
//   identifies  attributes that, on the element itself, prove it displays that wallet
//   anchors     selector for elements that likewise identify themselves
//   named       selector for displays allowed to show a name instead of an address
//   denied      selector that withholds a name display however good the evidence
//   sources     addresses the adapter resolved for this element by other means
export function identify(element, url, { attributes = [], identifies = [], anchors, named, denied, sources = [] } = {}) {
  if (element.closest(UNSAFE_HOST)) return null;
  const shown = element.textContent.trim().toLowerCase().replace(/\s/g, '');
  const fullShown = parseAddress(shown);
  const link = addressLink(element, url);
  const values = [fullShown, link?.address, ...sources];
  for (const host of [element, element.parentElement]) {
    if (!host) continue;
    for (const key of attributes) values.push(parseAddress(host.getAttribute(key)));
  }
  const found = [...new Set(values.filter(Boolean))];
  if (found.length > 1) throw new Error('contradictory-address-evidence');
  const address = found[0];
  if (!address) return null;
  const fragment = shown.match(FRAGMENT);
  if (fragment && (!address.startsWith(fragment[1]) || !address.endsWith(fragment[2]))) throw new Error('address-fragment-changed');
  const anchored = Boolean(anchors && element.matches(anchors)) ||
    identifies.some(key => parseAddress(element.getAttribute(key)));
  // A name may stand in for the address only where identity came from a
  // canonical source. Navigation cards are never labeled.
  const namedWidget = Boolean(named) && element.matches(named) && (link || sources.length || anchored) &&
    !(denied && element.closest(denied));
  if (!fullShown && !fragment && !namedWidget && !anchored) return null;
  return { address, network: link?.network };
}

// Identify every candidate an adapter's rules select within a changed branch.
export function collect(root, url, { targets, skip, sources = () => [], ...rules }) {
  return query(root, targets).flatMap(element => {
    if (skip?.(element)) return [];
    const identity = identify(element, url, { ...rules, sources: sources(element, url).filter(Boolean) });
    return identity ? [{ element, ...identity }] : [];
  });
}
