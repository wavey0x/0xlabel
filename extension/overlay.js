import { editorStyles } from './editor.js';

// Everything 0xlabel draws on a website, and where it sits. One UI root outside
// website-owned component trees; shadow DOM isolates our styles from the site's.
export async function createOverlay(doc, win) {
  const host = doc.createElement('div');
  host.setAttribute('data-0xlabel-ui', '');
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
  siteStyles.setAttribute('data-0xlabel-ui', '');
  (doc.head || doc.documentElement).append(siteStyles);
  let anchor = null;

  return {
    box, shadow,
    applyStyles(css) { siteStyles.textContent = css || ''; },
    // Match the website's own light or dark surface.
    theme() {
      const style = win.getComputedStyle(doc.body);
      const rgb = style.backgroundColor.match(/[\d.]+/g)?.map(Number);
      const dark = style.colorScheme.includes('dark') || rgb && rgb[3] !== 0 && (rgb[0] * .2126 + rgb[1] * .7152 + rgb[2] * .0722 < 110);
      host.toggleAttribute('data-dark', Boolean(dark));
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
    },
  };
}
