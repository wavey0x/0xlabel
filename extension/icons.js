import { COLORS, THEMES } from './colors.js';

// Shared brand source: a tag with the name punched clean through, so one path
// carries the mark on any ground. `npm run assets` exports both SVGs and
// Chrome's PNG sizes.
//
// The mark is drawn twice. A point alone reads as a banner or a back arrow; the
// eyelet is what makes it a tag, and it sits in the wedge, where no letter goes,
// so it costs nothing. But its hole is 3.1 of 32 units across, so below
// MARK_EYELET_MIN it renders as under two pixels of smudge that only blunts the
// point. Small renders drop it, and the letters take back the clearance it held
// — 12% larger at the sizes that need it most.
export const MARK_EYELET_MIN = 20;

const SLAB = 'M1 16L7 2H29a3 3 0 0 1 3 3V27a3 3 0 0 1-3 3H7Z';
const EYELET = 'M5.3 14.45a1.55 1.55 0 1 0 0 3.1 1.55 1.55 0 1 0 0-3.1Z';
// Knocked out at 74% beside the eyelet, and at 82% once it is gone.
const GLYPHS_EYELET = 'M13.31 7.11a4.82 4.82 0 0 1 4.82 4.82v8.14a4.82 4.82 0 0 1-9.64 0v-8.14a4.82 4.82 0 0 1 4.82-4.82Z'
  + 'M13.31 10.07a1.67 1.67 0 0 0-1.67 1.67v8.52a1.67 1.67 0 0 0 3.34 0v-8.52a1.67 1.67 0 0 0-1.67-1.67Z'
  + 'M20.35 13.04H24.2l.97 1.97.96-1.97h3.85l-2.89 5.92 2.89 5.93h-3.85l-.96-1.97-.97 1.97h-3.85l2.89-5.93Z';
const GLYPHS_PLAIN = 'M11.93 6.16a5.33 5.33 0 0 1 5.33 5.33v9.02a5.33 5.33 0 0 1-10.66 0v-9.02a5.33 5.33 0 0 1 5.33-5.33Z'
  + 'M11.93 9.44a1.85 1.85 0 0 0-1.85 1.85v9.42a1.85 1.85 0 0 0 3.7 0v-9.42a1.85 1.85 0 0 0-1.85-1.85Z'
  + 'M19.72 12.72H23.98l1.07 2.19 1.07-2.19h4.26l-3.2 6.56 3.2 6.56h-4.26l-1.07-2.19-1.07 2.19h-4.26l3.2-6.56Z';

// Even-odd stacks the three rings in one path: tag, letters, the zero's counter.
// Punching the letters through rather than painting them is what lets one fill
// work on either ground: the letters are always the colour behind the mark.
const mark = (color, shape) => `<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32" viewBox="0 0 32 32" aria-hidden="true">
  <path fill="${color}" fill-rule="evenodd" d="${shape}"/>
</svg>`;
export const brandMark = (color = COLORS.accent) => mark(color, SLAB + EYELET + GLYPHS_EYELET);
export const brandMarkPlain = (color = COLORS.accent) => mark(color, SLAB + GLYPHS_PLAIN);

// The popup and the book show the mark through <img>, which cannot reach the
// custom properties on the surface around it, so the file carries the switch.
const themed = shape => `<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32" viewBox="0 0 32 32" aria-hidden="true">
  <style>path { fill: ${COLORS.accent} } @media (prefers-color-scheme: dark) { path { fill: ${THEMES.dark.accent} } }</style>
  <path fill-rule="evenodd" d="${shape}"/>
</svg>`;
export const THEMED_MARK = themed(SLAB + EYELET + GLYPHS_EYELET);
export const THEMED_MARK_PLAIN = themed(SLAB + GLYPHS_PLAIN);

// The editor paints onto websites, where the surface is settled at run time and
// may be overridden, so its mark follows the property rather than a fixed hex.
export const EDITOR_MARK = brandMarkPlain('var(--0xlabel-accent)');

// Small outline glyphs shared by 0xlabel's UI.
export const LABEL_ICON = '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M2 2h5l7 7-5 5-7-7Z"/><circle cx="5" cy="5" r=".8"/></svg>';
export const COPY_ICON = '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="6" y="2" width="8" height="10" rx="1.5"/><path d="M10 12v1a1 1 0 0 1-1 1H3a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1h3"/></svg>';
// Where a book is kept, at a glance: a screen for this device, stacked platters
// for a server.
export const DEVICE_ICON = '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="1.8" y="3" width="12.4" height="8" rx="1.3"/><path d="M5.5 13.5h5"/></svg>';
export const SERVER_ICON = '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><ellipse cx="8" cy="3.6" rx="5.2" ry="2.1"/><path d="M2.8 3.6v8.8c0 1.16 2.33 2.1 5.2 2.1s5.2-.94 5.2-2.1V3.6"/><path d="M2.8 8c0 1.16 2.33 2.1 5.2 2.1s5.2-.94 5.2-2.1"/></svg>';

export const PENCIL_ICON = '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M11.3 2.7a1.6 1.6 0 0 1 2.3 2.3L6 12.6l-3 .7.7-3Z"/></svg>';
export const TRASH_ICON = '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M2.6 4.3h10.8M6.4 4.3V3a1 1 0 0 1 1-1h1.2a1 1 0 0 1 1 1v1.3"/><path d="M4.1 4.3l.6 8.2a1.1 1.1 0 0 0 1.1 1h4.4a1.1 1.1 0 0 0 1.1-1l.6-8.2"/></svg>';

const COPIED_CHECK_MS = 1500;

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
