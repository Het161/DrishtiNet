import { describe, it, expect } from 'vitest';
import { STRINGS, LOCALES, t, translator, isLocale } from './i18n';

describe('i18n', () => {
  it('has both locales for every key', () => {
    const missing: string[] = [];
    for (const [key, value] of Object.entries(STRINGS)) {
      for (const locale of LOCALES) {
        if (!value[locale]?.trim()) missing.push(`${key}.${locale}`);
      }
    }
    expect(missing).toEqual([]);
  });

  it('never falls back to the key itself — a raw key on a projector is a visible failure', () => {
    for (const key of Object.keys(STRINGS) as (keyof typeof STRINGS)[]) {
      for (const locale of LOCALES) {
        expect(t(key, locale)).not.toBe(key);
      }
    }
  });

  it('renders Gujarati in Gujarati script, not transliterated English', () => {
    // Anything in the Gujarati Unicode block (U+0A80–U+0AFF).
    const gujaratiScript = /[઀-૿]/;
    const suspect = Object.entries(STRINGS)
      .filter(([, v]) => !gujaratiScript.test(v.gu))
      .map(([k]) => k);
    expect(suspect).toEqual([]);
  });

  it('binds a locale', () => {
    expect(translator('gu')('registry.title')).toBe(STRINGS['registry.title'].gu);
    expect(translator('en')('registry.title')).toBe(STRINGS['registry.title'].en);
  });

  it('validates locale codes', () => {
    expect(isLocale('en')).toBe(true);
    expect(isLocale('gu')).toBe(true);
    expect(isLocale('hi')).toBe(false);
    expect(isLocale(undefined)).toBe(false);
  });
});
