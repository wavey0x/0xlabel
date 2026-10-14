import { parseAddress, query } from './shared.js';
import { explorerNetwork, safeNetwork, scopeOf } from './networks.js';

const ignored = 'input,textarea,select,script,style,[contenteditable]:not([contenteditable="false"]),[data-0xlabel-ui],button[type="submit"]';

function addressLink(element, url) {
  const link = element.closest('a[href]');
  if (!link) return null;
  const href = new URL(link.getAttribute('href'), url);
  const address = parseAddress(href.pathname.match(/^\/address\/([^/]+)\/?$/)?.[1]);
  return address ? { address, network: scopeOf(explorerNetwork(href.hostname)) } : null;
}

// Only complete sources establish identity. A fragment is used solely to check it.
function evidence(element, url, extra = [], allowNames = false) {
  const shown = element.textContent.trim().toLowerCase().replace(/\s/g, '');
  const fullShown = parseAddress(shown);
  const link = addressLink(element, url);
  const searchRow = allowNames && element.matches('.search-panel-container li[role="option"] > a[href]');
  const values = [fullShown, link?.address, ...extra];
  // ENS search links use the domain in their URL. The resolved address is
  // supplied separately in the row; accept only complete, consistent values.
  if (searchRow) values.push(...query(element.parentElement, 'span').map(node => parseAddress(node.textContent.trim())));
  for (const host of [element, element.parentElement]) {
    if (!host) continue;
    for (const key of ['data-full-address', 'data-highlight-target', 'data-address', 'title', 'aria-label']) {
      values.push(parseAddress(host.getAttribute(key)));
    }
  }
  const sources = [...new Set(values.filter(Boolean))];
  if (sources.length > 1) throw new Error('contradictory-address-evidence');
  const address = sources[0];
  if (!address) return null;
  const fragment = shown.match(/^(?:[a-z]+:)?(0x[0-9a-f]+)[.\u2026]+([0-9a-f]+)$/);
  if (fragment && (!address.startsWith(fragment[1]) || !address.endsWith(fragment[2]))) throw new Error('address-fragment-changed');
  // Do not label navigation cards merely because their link leads to an address.
  const namedWidget = allowNames && (searchRow || element.matches('.hash-tag,[data-highlight-value]') &&
    (link || parseAddress(element.getAttribute('data-full-address')))) && !element.closest('.dropdown-item,nav');
  if (!fullShown && !fragment && !namedWidget && !element.matches('[data-highlight-target],#mainaddress') && !parseAddress(element.getAttribute('data-address'))) return null;
  return { address, network: link?.network };
}

function target(element, url, extra, allowNames) {
  if (element.closest(ignored)) return null;
  const identity = evidence(element, url, extra, allowNames);
  if (!identity) return null;
  return { element, ...identity };
}

const etherscanAdapter = {
  id: 'Etherscan',
  matches: url => Boolean(explorerNetwork(url.hostname)),
  probe({ document, url }) {
    if (document.querySelector('#challenge-running,#challenge-stage,[name="cf-turnstile-response"]') || /^(Just a moment|Attention Required)/i.test(document.title)) return { status: 'waiting' };
    if (document.readyState === 'loading') return { status: 'waiting' };
    if (!document.querySelector('main') || !document.querySelector('header,nav')) return { status: 'stale', reason: 'explorer-landmarks-missing' };
    if (/^\/address\//.test(url.pathname) && !document.querySelector('#mainaddress')) return { status: 'stale', reason: 'main-address-missing' };
    return { status: 'ready', network: scopeOf(explorerNetwork(url.hostname)) };
  },
  scan(root, { url }) {
    return query(root, '#mainaddress,[data-highlight-target],a[href*="/address/"],a[href*="/address/"] .hash-tag,[data-full-address]').flatMap(element => {
      // The innermost verified address widget owns the annotation.
      if (!element.matches('#mainaddress,[data-highlight-target]') && element.querySelector('[data-highlight-target],.hash-tag')) return [];
      // Includes homepage fee-recipient links, which have no .hash-tag child.
      // Named widgets use a canonical link or an explicit full-address attribute.
      const item = target(element, url, [], true);
      return item ? [item] : [];
    });
  },
};

const safeAdapter = {
  id: 'Safe',
  matches: url => url.hostname === 'app.safe.global',
  probe({ document, url }) {
    if (document.readyState === 'loading' || document.querySelector('[role="progressbar"]')) return { status: 'waiting' };
    if (!document.querySelector('main') && !(document.querySelector('header') && document.querySelector('[data-testid="sidebar-container"]'))) return { status: 'stale', reason: 'safe-landmarks-missing' };
    const network = safeNetwork(url.searchParams.get('safe')?.split(':')[0]);
    return { status: 'ready', ...(network ? { network: scopeOf(network) } : {}) };
  },
  scan(root, { url }) {
    const candidates = query(root, 'a[href*="/address/"],[data-address],[title],[class*="addressContainer"] span,main span,[data-testid="safe-selector-trigger-name"],[data-testid="safe-selector-trigger-address"]');
    return candidates.flatMap(element => {
      const selector = element.matches('[data-testid="safe-selector-trigger-name"],[data-testid="safe-selector-trigger-address"]');
      if (element.children.length && !element.matches('a[href*="/address/"]') && !selector) return [];
      // Explorer links in a compact EthHashInfo widget can identify its display.
      const widget = element.closest('[class*="addressContainer"],[class*="EthHashInfo_container"],[class*="SrcEthHashInfo_container"]');
      const sources = widget ? query(widget, 'a[href*="/address/"]').map(link => addressLink(link, url)?.address) : [];
      if (selector) {
        sources.push(parseAddress(url.searchParams.get('safe')?.split(':')[1]));
        const header = element.closest('header');
        if (header) sources.push(...query(header, '[data-testid="safe-item-explorer-link"]').map(link => addressLink(link, url)?.address));
      }
      const item = target(element, url, sources);
      return item ? [item] : [];
    });
  },
};

const genericAdapter = {
  id: 'This site', matches: () => true,
  probe: () => ({ status: 'ready' }),
  scan(root) {
    // Whole, leaf display values only: never guess from an abbreviation.
    return query(root, 'a,span,code,p,td,div').flatMap(element => {
      if ([...element.children].some(child => !child.matches('[data-0xlabel-ui]')) || element.closest(ignored) || element.closest('button')) return [];
      const address = parseAddress(element.textContent.trim());
      return address ? [{ element, address }] : [];
    });
  },
};

export const adapters = [etherscanAdapter, safeAdapter, genericAdapter];
