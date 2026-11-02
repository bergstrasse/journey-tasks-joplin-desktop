import chinese from './locales/zh-CN.json';
import english from './locales/en.json';
import { registry } from './registry';
export { registry } from './registry';
export type LocaleId = keyof typeof registry;
export type LanguagePreference = 'auto' | LocaleId;
export type TranslationParams = Record<string, string | number>;
export type Translator = (key: string, params?: TranslationParams) => string;

export function isLanguagePreference(value: unknown): value is LanguagePreference {
  return value === 'auto' || (typeof value === 'string' && Object.prototype.hasOwnProperty.call(registry, value));
}

export function languageDirection(locale: LocaleId): 'ltr' | 'rtl' {
  return locale === 'fa' ? 'rtl' : 'ltr';
}

export function systemLocales(): readonly string[] {
  if (typeof navigator !== 'undefined') {
    if (navigator.languages?.length) return navigator.languages;
    if (navigator.language) return [navigator.language];
  }
  try { return [Intl.DateTimeFormat().resolvedOptions().locale]; } catch { return ['en-US']; }
}

export function resolveLanguage(preference: unknown = 'auto', locales: string | readonly string[] = systemLocales()): LocaleId {
  if (typeof preference === 'string' && Object.prototype.hasOwnProperty.call(registry, preference)) return preference as LocaleId;
  for (const locale of typeof locales === 'string' ? [locales] : locales) {
    const normalized = locale.replace(/_/g, '-').toLowerCase();
    const exact = Object.keys(registry).find(id => id.toLowerCase() === normalized);
    if (exact) return exact as LocaleId;
    // Script subtags take precedence over the region for Chinese.
    if (normalized.split('-')[0] === 'zh') {
      const parts = normalized.split('-');
      return parts.includes('hant') || (!parts.includes('hans') && parts.some(part => ['tw', 'hk', 'mo'].includes(part))) ? 'zh-TW' : 'zh-CN';
    }
    const base = normalized.split('-')[0];
    if (base === 'ro') return 'ro-RO';
    const family = Object.keys(registry).find(id => id.toLowerCase().split('-')[0] === base);
    if (family) return family as LocaleId;
  }
  return 'en-US';
}

/** Missing parameters remain visible, while replacement values are never translated or re-expanded. */
export function createTranslator(locale: LocaleId | string): Translator {
  const dictionary: Record<string, string> = registry[locale as LocaleId]?.dictionary ?? registry['en-US'].dictionary;
  const fallback: Record<string, string> = chinese;
  return (key, params = {}) => {
    const value = Object.prototype.hasOwnProperty.call(dictionary, key) ? dictionary[key]! :
      Object.prototype.hasOwnProperty.call(fallback, key) ? fallback[key]! : key;
    return value.replace(/\{(\w+)\}/g, (placeholder, name: string) =>
      Object.prototype.hasOwnProperty.call(params, name) ? String(params[name]) : placeholder);
  };
}

/** Called only for error/diagnostic channels. Never call this on a title, body or notebook name. */
export function translateMessage(message: string, locale: LocaleId = 'zh-CN', code?: string, params?: TranslationParams): string {
  const t = createTranslator(locale);
  for (const key of code ? [code, `backend.${code}`, `diagnostic.${code}`] : []) {
    if (Object.prototype.hasOwnProperty.call(chinese, key)) return t(key, params);
  }
  if (/^(error|backend|diagnostic)\./.test(message) && Object.prototype.hasOwnProperty.call(chinese, message)) return t(message);
  const entries = Object.entries(chinese).filter(([key]) => key.startsWith('error.') || key.startsWith('backend.') || key.startsWith('diagnostic.'));
  const known = entries.find(([, text]) => text === message);
  if (known) return t(known[0]);
  // Domain diagnostics are written in English. Translate exact known messages only.
  const englishKnown = Object.entries(english).find(([key, text]) =>
    text === message && (key.startsWith('error.') || key.startsWith('backend.') || key.startsWith('diagnostic.')));
  if (englishKnown) return t(englishKnown[0]);
  return message;
}
