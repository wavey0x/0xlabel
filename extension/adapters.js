import { parseAddress, query } from './shared.js';
import { explorerNetwork, safeNetwork, scopeOf } from './networks.js';
import { addressLink, collect } from './detect.js';

// An adapter describes one website to the detection kernel:
//
//   id       shown in the toolbar and health reports
//   matches  claims a URL; the first match in `adapters` wins
//   probe    whether the page is ready, still loading, or no longer recognized
//   rules    where this site keeps address evidence (see detect.js)
//
// Everything below is data about a site. Add a website by adding an entry;
// no core file needs to know it exists.
const site = ({ rules, ...adapter }) => ({ ...adapter, scan: (root, { url }) => collect(root, url, rules) });

const SEARCH_ROW = '.search-panel-container li[role="option"] > a[href]';

const etherscanAdapter = site({
  id: 'Etherscan',
  matches: url => Boolean(explorerNetwork(url.hostname)),
  probe({ document, url }) {
    if (document.querySelector('#challenge-running,#challenge-stage,[name="cf-turnstile-response"]') || /^(Just a moment|Attention Required)/i.test(document.title)) return { status: 'waiting' };
    if (document.readyState === 'loading') return { status: 'waiting' };
    if (!document.querySelector('main') || !document.querySelector('header,nav')) return { status: 'stale', reason: 'explorer-landmarks-missing' };
    if (/^\/address\//.test(url.pathname) && !document.querySelector('#mainaddress')) return { status: 'stale', reason: 'main-address-missing' };
    return { status: 'ready', network: scopeOf(explorerNetwork(url.hostname)) };
  },
  rules: {
    // Includes homepage fee-recipient links, which have no .hash-tag child.
    targets: '#mainaddress,[data-highlight-target],a[href*="/address/"],a[href*="/address/"] .hash-tag,[data-full-address]',
    attributes: ['data-full-address', 'data-highlight-target', 'data-address', 'title', 'aria-label'],
    identifies: ['data-full-address'],
    anchors: '#mainaddress,[data-highlight-target]',
    named: `.hash-tag,[data-highlight-value],${SEARCH_ROW}`,
    denied: '.dropdown-item,nav',
    // The innermost verified address widget owns the annotation.
    skip: element => !element.matches('#mainaddress,[data-highlight-target]') &&
      element.querySelector('[data-highlight-target],.hash-tag'),
    // ENS search links name the domain in their URL. The row supplies the
    // resolved address separately; accept only complete, consistent values.
    sources: element => element.matches(SEARCH_ROW)
      ? query(element.parentElement, 'span').map(node => parseAddress(node.textContent.trim()))
      : [],
  },
});

const SAFE_SELECTOR = '[data-testid="safe-selector-trigger-name"],[data-testid="safe-selector-trigger-address"]';
const SAFE_WIDGET = '[class*="addressContainer"],[class*="EthHashInfo_container"],[class*="SrcEthHashInfo_container"]';

const safeAdapter = site({
  id: 'Safe',
  matches: url => url.hostname === 'app.safe.global',
  probe({ document, url }) {
    if (document.readyState === 'loading' || document.querySelector('[role="progressbar"]')) return { status: 'waiting' };
    if (!document.querySelector('main') && !(document.querySelector('header') && document.querySelector('[data-testid="sidebar-container"]'))) return { status: 'stale', reason: 'safe-landmarks-missing' };
    const network = safeNetwork(url.searchParams.get('safe')?.split(':')[0]);
    return { status: 'ready', ...(network ? { network: scopeOf(network) } : {}) };
  },
  rules: {
    targets: `a[href*="/address/"],[data-address],[title],[class*="addressContainer"] span,main span,${SAFE_SELECTOR}`,
    attributes: ['data-address', 'title', 'aria-label'],
    identifies: ['data-address'],
    skip: element => element.children.length && !element.matches(`a[href*="/address/"],${SAFE_SELECTOR}`),
    // Explorer links in a compact EthHashInfo widget can identify its display,
    // and the selected Safe is named by the URL and the header's explorer link.
    sources: (element, url) => {
      const widget = element.closest(SAFE_WIDGET);
      const found = widget ? query(widget, 'a[href*="/address/"]').map(link => addressLink(link, url)?.address) : [];
      if (!element.matches(SAFE_SELECTOR)) return found;
      found.push(parseAddress(url.searchParams.get('safe')?.split(':')[1]));
      const header = element.closest('header');
      if (header) found.push(...query(header, '[data-testid="safe-item-explorer-link"]').map(link => addressLink(link, url)?.address));
      return found;
    },
  },
});

const genericAdapter = site({
  id: 'This site',
  matches: () => true,
  probe: () => ({ status: 'ready' }),
  rules: {
    // Whole, leaf display values only: never guess from an abbreviation, and
    // never trust a site attribute we have no adapter to vouch for.
    targets: 'a,span,code,p,td,div',
    skip: element => [...element.children].some(child => !child.matches('[data-0xlabel-ui]')),
  },
});

export const adapters = [etherscanAdapter, safeAdapter, genericAdapter];
