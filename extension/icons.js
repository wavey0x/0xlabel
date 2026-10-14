import { COLORS } from './colors.js';

// Shared brand source. `npm run assets` exports its SVG and Chrome's PNG sizes.
export const brandMark = (color = COLORS.accent) => `<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32" viewBox="0 0 32 32" aria-hidden="true">
  <path fill="${color}" d="M6 2h16l8 8v16a4 4 0 0 1-4 4H6a4 4 0 0 1-4-4V6a4 4 0 0 1 4-4Z"/>
  <g fill="none" stroke="${COLORS.onAccent}" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
    <rect x="7.5" y="10.5" width="7" height="11" rx="3.5"/>
    <path d="m19 12 5.5 8m0-8-5.5 8"/>
  </g>
</svg>`;
export const BRAND_MARK = brandMark();

// Small outline glyphs shared by 0xlabel's UI.
export const LABEL_ICON = '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M2 2h5l7 7-5 5-7-7Z"/><circle cx="5" cy="5" r=".8"/></svg>';
export const COPY_ICON = '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="6" y="2" width="8" height="10" rx="1.5"/><path d="M10 12v1a1 1 0 0 1-1 1H3a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1h3"/></svg>';
export const COPIED_CHECK_MS = 1500;

export const COPIED_ICON = '<svg viewBox="0 0 16 16" fill="none" stroke="var(--0xlabel-accent)" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m3 8 3 3 7-7"/></svg>';

// Confirm a copy on the button that did it, then put the button back. The
// first call remembers the resting state, so repeated copies keep showing the
// check for the full interval rather than restoring an already-swapped icon.
const resting = new WeakMap();
export function confirmCopied(button, label = 'Copied') {
  if (!resting.has(button)) {
    resting.set(button, { icon: button.innerHTML, label: button.getAttribute('aria-label'), title: button.title });
  }
  const state = resting.get(button);
  clearTimeout(state.timer);
  button.innerHTML = COPIED_ICON;
  button.setAttribute('aria-label', label);
  button.title = label;
  state.timer = setTimeout(() => {
    button.innerHTML = state.icon;
    if (state.label === null) button.removeAttribute('aria-label');
    else button.setAttribute('aria-label', state.label);
    button.title = state.title;
  }, COPIED_CHECK_MS);
}
