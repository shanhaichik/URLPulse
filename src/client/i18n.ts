import { createContext, useContext } from 'react';
import {
  bindTranslator, createLocalization, defaultLocale, isLocale, parseLocale, registerCatalog, supportedLocales,
  type AppLocale, type Catalog,
} from '../shared/i18n/index.js';

export const localeStorageKey = 'urlpulse.locale';

function storedLocale() {
  try { return parseLocale(window.localStorage.getItem(localeStorageKey)); }
  catch { return defaultLocale; }
}

export const browserI18n = createLocalization(storedLocale());
export const currentLocale = () => parseLocale(browserI18n.language);
export const LanguageContext = createContext<AppLocale>(defaultLocale);

export function useLanguage() {
  return useContext(LanguageContext);
}

export function createMessages<C extends Catalog>(namespace: string, catalog: C) {
  registerCatalog(browserI18n, namespace, catalog);
  const translators = new Map(supportedLocales.map(locale =>
    [locale, bindTranslator<Extract<keyof C, string>>(browserI18n, locale, namespace)] as const));
  return function useMessages() {
    return translators.get(useLanguage())!;
  };
}

export class LocalizedError extends Error {
  constructor(readonly translate: (locale: AppLocale) => string) {
    super(translate(currentLocale()));
  }
}

let selection: Promise<void> = Promise.resolve();
export function setLanguage(locale: AppLocale) {
  if (!isLocale(locale)) return Promise.resolve();
  const change = selection.then(async () => {
    const bridge = window.pulseDesktop;
    if (bridge?.setLocale) {
      await browserI18n.changeLanguage(parseLocale(await bridge.setLocale(locale)));
    } else {
      try { window.localStorage.setItem(localeStorageKey, locale); }
      catch { /* The locale still applies to this window. */ }
      await browserI18n.changeLanguage(locale);
    }
  });
  selection = change.catch(() => {});
  return change;
}

export async function initializeLanguage() {
  const bridge = window.pulseDesktop;
  if (bridge?.getLocale) {
    let updated = false;
    bridge.onLocaleChanged?.(locale => {
      updated = true;
      void browserI18n.changeLanguage(parseLocale(locale));
    });
    try {
      const locale = parseLocale(await bridge.getLocale());
      if (!updated) await browserI18n.changeLanguage(locale);
    } catch { /* Keep the fallback locale when preferences are unavailable. */ }
  } else {
    window.addEventListener('storage', event => {
      if (event.key === localeStorageKey || event.key === null) {
        void browserI18n.changeLanguage(storedLocale());
      }
    });
  }
}
