// The palette's single source. Run `npm run assets` after changing colors.
// Stylesheets and exported icons are checked in, so using the extension needs no build.
const white = '#ffffff';
const black = '#000000';
const tint = (color, percent) => `color-mix(in srgb, ${color} ${percent}%, transparent)`;
const accent = '#4169e1';

export const COLORS = Object.freeze({
  accent,
  onAccent: white,
  iconIdle: '#7e8794',
  warning: '#b5760d',
  warningBadge: '#c88315',
  switchOff: '#777777',
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
    canvas: '#f6f7fa', panel: white, ink: '#111111', muted: '#666666',
    glass: tint(white, 72), soft: tint(black, 2.75), line: tint(black, 6.25),
    shadow: `0 10px 28px ${tint(black, 12.5)}, 0 2px 8px ${tint(black, 4.7)}`,
  },
  dark: {
    canvas: '#101113', panel: '#18191c', ink: '#fafafa', muted: '#aaaaaa',
    glass: tint('#16171a', 60), soft: tint(white, 3.1), line: tint(white, 7.8),
    shadow: `0 10px 28px ${tint(black, 31.4)}, 0 2px 8px ${tint(black, 12.5)}`,
  },
});
