import { parseAddress, query, UI } from './shared.js';
import { explorerNetwork, safeNetwork, scopeOf } from './networks.js';
import { addressLink, addressText, collect } from './detect.js';

// An adapter describes one website to the detection kernel:
//
//   id       shown in the toolbar and health reports
//   matches  claims a URL; the first match in `adapters` wins
//   probe    whether the page is ready, still loading, or no longer recognized
//   rules    where this site keeps address evidence (see detect.js)
//   styles   CSS the site's own elements need while this adapter is active
//   watch    extra attributes whose changes should trigger a rescan
//
// Everything below is data about a site. Add a website by adding an entry;
// no core file needs to know it exists.
const site = ({ rules, watch = [], ...adapter }) => ({
  ...adapter,
  watch: [...new Set([...(rules.attributes || []), ...(rules.identifies || []), ...watch])],
  scan: (root, { url }) => collect(root, url, rules),
});

const SEARCH_ROW = '.search-panel-container li[role="option"] > a[href]';

const etherscanAdapter = site({
  id: 'Etherscan',
  matches: url => Boolean(explorerNetwork(url.hostname)),
  watch: ['data-highlight-value'],
  // The heading of an address page is what the page is about. A name alone
  // would take away the one thing identifying everything below it.
  subject: '#mainaddress',
  // Address badges lose their decoration only while a custom tag is visible.
  styles: `.badge:is([data-0xtagger-tag], :has([data-0xtagger-tag])) {
      background: transparent !important;
      border: 0 !important;
      border-radius: 0 !important;
      box-shadow: none !important;
      padding: 0 !important;
    }`,
  probe({ document, url, embedded }) {
    if (document.querySelector('#challenge-running,#challenge-stage,[name="cf-turnstile-response"]') || /^(Just a moment|Attention Required)/i.test(document.title)) return { status: 'waiting' };
    if (document.readyState === 'loading') return { status: 'waiting' };
    const landmarks = document.querySelector('main') && document.querySelector('header,nav');
    // An explorer embeds its tables as documents of their own: a frame holding
    // rows and none of the outer page's landmarks. Which URL those frames load
    // from is the explorer's business and changes with its pages; that they are
    // framed tables does not. Their rows carry the same identities.
    if (embedded && !landmarks) {
      return document.querySelector('.table-responsive table tbody')
        ? { status: 'ready', network: scopeOf(explorerNetwork(url.hostname)) }
        : { status: 'stale', reason: 'transfer-table-missing' };
    }
    if (!landmarks) return { status: 'stale', reason: 'explorer-landmarks-missing' };
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
    denied: 'nav',
    // An owners or holders menu is content, not navigation: its rows name real
    // wallets, under whatever the explorer already calls them.
    keeps: '.dropdown-item',
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
// Safe's address widget sets the name in a box of its own, under a plain class
// rather than a hashed one, and sometimes puts a badge beside it saying which
// of Safe's books the name came from. The name's own box is the first child:
// wrapping it in a link is Safe's business, and a link inside a display would
// disqualify the display, so the box is what we match rather than its parent.
const SAFE_NAME = '.ethHashInfo-name';
const SAFE_NAME_BOX = `${SAFE_NAME} > :first-child`;
// The address lives beside the name in the same widget, and an explorer link
// beside it is what proves which wallet the pair is about.
const SAFE_ADDRESS_LINK = 'a[href*="/address/"]';
const safePair = element => element.closest(`${SAFE_NAME},[class*="addressContainer"]`)?.parentElement || null;

const safeAdapter = site({
  id: 'Safe',
  matches: url => url.hostname === 'app.safe.global',
  probe({ document, url }) {
    if (document.readyState === 'loading' || document.querySelector('[role="progressbar"]')) return { status: 'waiting' };
    if (!document.querySelector('main') && !(document.querySelector('header') && document.querySelector('[data-testid="sidebar-container"]'))) return { status: 'stale', reason: 'safe-landmarks-missing' };
    const network = safeNetwork(url.searchParams.get('safe')?.split(':')[0]);
    return { status: 'ready', ...(network ? { network: scopeOf(network) } : {}) };
  },
  // While a tag stands in for Safe's name, the badge beside it would still be
  // claiming the name came from one of Safe's own books. It goes for exactly as
  // long as the substitution lasts, and comes back with it, because the rule
  // rests on an attribute the controller already adds and removes.
  styles: `${SAFE_NAME} > [data-0xtagger-tag] ~ * { display: none !important; }`,
  rules: {
    targets: `a[href*="/address/"],[data-address],[title],[class*="addressContainer"] span,main span,${SAFE_NAME_BOX},${SAFE_SELECTOR}`,
    attributes: ['data-address', 'title', 'aria-label'],
    identifies: ['data-address'],
    // A name may stand in for the address only in the box Safe set it in.
    named: SAFE_NAME_BOX,
    skip: element => {
      if (element.matches(SAFE_NAME_BOX)) return false;
      if (element.children.length && !element.matches(`${SAFE_ADDRESS_LINK},${SAFE_SELECTOR}`)) return true;
      // One name to a widget. Where Safe shows a name above the address and the
      // widget proves which wallet it is, the name is the display a tag
      // replaces, and the address below is left to go on being an address.
      const pair = element.closest('[class*="addressContainer"]') && safePair(element);
      return Boolean(pair?.querySelector(SAFE_NAME) && pair.querySelector(SAFE_ADDRESS_LINK));
    },
    // Explorer links in a compact EthHashInfo widget can identify its display,
    // and the selected Safe is named by the URL and the header's explorer link.
    sources: (element, url) => {
      const widget = element.matches(SAFE_NAME_BOX) ? safePair(element) : element.closest(SAFE_WIDGET);
      const found = widget ? query(widget, SAFE_ADDRESS_LINK).map(link => addressLink(link, url)?.address) : [];
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
    // never trust a site attribute we have no adapter to vouch for. Which tag
    // shows the address is not our business; that it shows nothing else is.
    candidates: addressText,
    skip: element => element.matches('html,body,head') ||
      [...element.children].some(child => !child.matches(UI)),
  },
});

export const adapters = [etherscanAdapter, safeAdapter, genericAdapter];
