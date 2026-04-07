export const SOPHIA_THEME_STORAGE_KEY = 'sophia-theme';
export const COSMIC_THEME_ID = 'cosmic-sophia';
export const LIGHT_THEME_ID = 'light';

export const LEGACY_THEME_ALIASES: Record<string, string> = {
  'moonlit-embrace': COSMIC_THEME_ID,
  moonlit: COSMIC_THEME_ID,
  dark: COSMIC_THEME_ID,
};

export const DARK_THEMES = [
  COSMIC_THEME_ID,
  'accessible-indigo',
  'accessible-slate',
  'accessible-charcoal',
  'velvet-night',
  'dawns-promise',
] as const;

export function normalizeSophiaTheme(theme: string | null | undefined): string {
  if (!theme) {
    return COSMIC_THEME_ID;
  }

  return LEGACY_THEME_ALIASES[theme] ?? theme;
}

export function isDarkSophiaTheme(theme: string): boolean {
  const normalizedTheme = normalizeSophiaTheme(theme);
  return DARK_THEMES.includes(normalizedTheme as (typeof DARK_THEMES)[number]);
}

export function getThemeToggleTarget(theme: string): string {
  return normalizeSophiaTheme(theme) === LIGHT_THEME_ID ? COSMIC_THEME_ID : LIGHT_THEME_ID;
}