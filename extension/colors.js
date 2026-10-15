// The palette's single source. Run `npm run assets` after changing colors.
// Stylesheets and exported icons are checked in, so using the extension needs no build.
const white = '#ffffff';
const black = '#000000';
const tint = (color, percent) => `color-mix(in srgb, ${color} ${percent}%, transparent)`;
const accent = '#5b21b6';
// Deep purple reads at 2.1:1 on a dark surface, far short of the 4.5:1 a
// tag needs. Lightened for dark websites only; the tints stay as they are.
const accentOnDark = '#a78bfa';
// The accent does two jobs. As a text colour on a dark website it has to be
// light to be read at all, which is what accentOnDark is for. As a fill with
// words on top it has to be dark enough for them: white on the lightened
// purple is 2.72:1, so a filled control in the dark theme keeps a deeper
// purple of its own, where white reads at 7.1:1. Both themes then put the
// same white on the same kind of surface, which is what a filled button and a
// switch look like they should do.
const accentFillDark = '#6d28d9';
// Chrome never tells an extension whether its toolbar is light or dark, so the
// active icon cannot switch the way a surface does: one purple has to clear 3:1
// both ways. The deep accent is 1.55:1 on a dark toolbar, the lightened one
// 2.41:1 on a light toolbar; this sits between them at 3.29:1 and 3.76:1, the
// same compromise iconIdle already makes.
const iconAccent = '#8b5cf6';

export const COLORS = Object.freeze({
  accent,
  accentFill: accent,
  onAccent: white,
  iconAccent,
  iconIdle: '#7e8794',
  error: '#b91c1c',
  warning: '#b5760d',
  warningBadge: '#c88315',
  switchOff: '#777777',
  // The tick confirming a write, drawn on the filled accent rather than on a
  // panel: 5.2:1 on the deep purple and 4.1:1 on the lighter fill the dark
  // theme uses, both clear of the 3:1 an icon needs.
  success: '#4ade80',
  accentSoft: tint(accent, 8),
  accentHover: tint(accent, 6),
  accentWash: tint(accent, 7),
  accentCanvas: tint(accent, 4),
  accentGlow: tint(accent, 50),
  accentPulse: tint(accent, 20),
  sheen: tint(white, 6),
  inset: tint(white, 12.5),
  backdrop: tint(black, 19),
});

export const THEMES = Object.freeze({
  light: {
    accent,
    accentFill: accent,
    onAccent: white,
    canvas: '#f6f7fa', panel: white, ink: '#111111', muted: '#666666',
    glass: tint(white, 72), soft: tint(black, 2.75), line: tint(black, 6.25),
    shadow: `0 10px 28px ${tint(black, 12.5)}, 0 2px 8px ${tint(black, 4.7)}`,
  },
  dark: {
    accent: accentOnDark,
    accentFill: accentFillDark,
    onAccent: white,
    error: '#f87171',
    canvas: '#101113', panel: '#18191c', ink: '#fafafa', muted: '#aaaaaa',
    glass: tint('#16171a', 60), soft: tint(white, 3.1), line: tint(white, 7.8),
    shadow: `0 10px 28px ${tint(black, 31.4)}, 0 2px 8px ${tint(black, 12.5)}`,
  },
});
