import React, { createContext, useContext, useMemo } from 'react';
import { createTranslator, translateMessage, type LocaleId, type Translator } from './index';

interface TranslationContext { locale: LocaleId; t: Translator; formatTime(value: number | Date): string; message(message: string, code?: string): string }
const I18nContext = createContext<TranslationContext>({ locale: 'zh-CN', t: createTranslator('zh-CN'), formatTime: value => new Intl.DateTimeFormat('zh-CN', { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(value),
  message: (message, code) => translateMessage(message, 'zh-CN', code) });

export function TranslationProvider({ locale, timeFormat = '24h', children }: { locale: LocaleId; timeFormat?: '24h' | '12h'; children: React.ReactNode }) {
  const value = useMemo<TranslationContext>(() => ({ locale, t: createTranslator(locale),
    formatTime: value => new Intl.DateTimeFormat(locale, { hour: '2-digit', minute: '2-digit', hourCycle: timeFormat === '12h' ? 'h12' : 'h23' }).format(value),
    message: (message, code) => translateMessage(message, locale, code) }), [locale, timeFormat]);
  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>;
}
/** Standalone components retain Chinese as a stable fallback; App chooses the saved/system locale. */
export function useTranslation(): TranslationContext { return useContext(I18nContext); }
