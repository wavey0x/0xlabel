import { editorStyles } from './editor.js';
import { UI_ATTRIBUTE } from './shared.js';

// Everything 0xtagger draws on a website, and where it sits. One UI root outside
// website-owned component trees; shadow DOM isolates our styles from the site's.
export async function createOverlay(doc, win) {
  const host = doc.createElement('div');
  host.setAttribute(UI_ATTRIBUTE, '');
  host.style.cssText = 'position:absolute;left:0;top:0;z-index:2147483647;pointer-events:none;';
  const shadow = host.attachShadow({ mode: 'open' });
  await editorStyles(shadow);
  const box = doc.createElement('div');
  box.style.cssText = 'position:fixed;pointer-events:auto;display:none;';
  shadow.append(box);
  doc.documentElement.append(host);
  // Rules an adapter needs applied to the website's own elements, which the
  // shadow root cannot reach. Only the active adapter's styles are present.
  const siteStyles = doc.createElement('style');
  siteStyles.setAttribute(UI_ATTRIBUTE, '');
  (doc.head || doc.documentElement).append(siteStyles);
  let anchor = null;

  return {
    box, shadow,
    applyStyles(css) { siteStyles.textContent = css || ''; },
    // Read the website's own surface: annotations sit on its pages, so they
    // follow its background rather than the operating system. A page paints its
    // background on either element and often leaves the other transparent, so
    // compose body over html over the canvas the browser would otherwise show.
    theme() {
      const scheme = win.getComputedStyle(doc.documentElement).colorScheme;
      // `light dark` says a page supports both, not that it is dark. A page that
      // says nothing keeps a light canvas however the system is set.
      const canvasDark = scheme.includes('dark') &&
        (scheme.includes('only') || win.matchMedia('(prefers-color-scheme: dark)').matches);
      const layer = element => {
        const parts = win.getComputedStyle(element).backgroundColor.match(/[\d.]+/g)?.map(Number);
        return parts ? { r: parts[0], g: parts[1], b: parts[2], a: parts[3] ?? 1 } : null;
      };
      const over = (top, bottom) => !top || !top.a ? bottom : top.a >= 1 ? top : {
        r: top.r * top.a + bottom.r * (1 - top.a),
        g: top.g * top.a + bottom.g * (1 - top.a),
        b: top.b * top.a + bottom.b * (1 - top.a), a: 1,
      };
      const canvas = canvasDark ? { r: 18, g: 18, b: 18, a: 1 } : { r: 255, g: 255, b: 255, a: 1 };
      const backdrop = over(layer(doc.body), over(layer(doc.documentElement), canvas));
      const dark = backdrop.r * .2126 + backdrop.g * .7152 + backdrop.b * .0722 < 110;
      doc.documentElement.setAttribute('data-0xtagger-surface', dark ? 'dark' : 'light');
      host.toggleAttribute('data-dark', dark);
      return dark ? 'dark' : 'light';
    },
    show() {
      box.style.position = 'fixed';
      box.style.display = 'block';
      box.style.left = '10px';
      box.style.top = '10px';
      anchor = null;
    },
    hide() {
      box.replaceChildren();
      box.style.display = 'none';
    },
    // Keep the editor beside `element`, or merely on screen once its row is gone.
    position(element, fit = false) {
      const size = box.getBoundingClientRect();
      if (!element?.isConnected) {
        box.style.position = 'fixed';
        box.style.left = `${Math.max(10, Math.min(win.innerWidth - size.width - 10, size.left))}px`;
        box.style.top = `${Math.max(10, Math.min(win.innerHeight - size.height - 10, size.top))}px`;
        anchor = null;
        return;
      }
      const rect = element.getBoundingClientRect();
      const next = { left: rect.left + win.scrollX, bottom: rect.bottom + win.scrollY, width: size.width, height: size.height };
      box.style.position = 'absolute';
      if (fit || !anchor || size.width !== anchor.width || size.height !== anchor.height) {
        box.style.left = `${win.scrollX + Math.max(10, Math.min(win.innerWidth - size.width - 10, rect.left))}px`;
        const below = rect.bottom + 8;
        box.style.top = `${win.scrollY + Math.max(10, Math.min(win.innerHeight - size.height - 10, below + size.height < win.innerHeight ? below : rect.top - size.height - 8))}px`;
      } else {
        // Follow layout shifts and inner scrollers without changing the chosen gap
        // or side. Ordinary page scrolling is handled entirely by the browser.
        box.style.left = `${parseFloat(box.style.left) + next.left - anchor.left}px`;
        box.style.top = `${parseFloat(box.style.top) + next.bottom - anchor.bottom}px`;
      }
      anchor = next;
    },
    destroy() {
      host.remove();
      siteStyles.remove();
      doc.documentElement.removeAttribute('data-0xtagger-surface');
    },
  };
}
