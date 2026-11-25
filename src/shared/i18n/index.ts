import { createInstance, type i18n } from 'i18next';

export const defaultLocale = 'ru-RU';
export const supportedLocales = [defaultLocale, 'en-US'] as const;
export type AppLocale = typeof supportedLocales[number];
export type MessageParams = Readonly<Record<string, string | number>>;
type Plural = Readonly<Partial<Record<Intl.LDMLPluralRule | 'zero', string>>> & { readonly other: string };
type Message = string | Plural;
export type Catalog = Readonly<Record<string, { readonly ru: Message; readonly en: Message }>>;

export function isLocale(value: unknown): value is AppLocale {
  return value === defaultLocale || value === 'en-US';
}

export function parseLocale(value: unknown): AppLocale {
  return isLocale(value) ? value : defaultLocale;
}

const languages = { 'ru-RU': 'ru', 'en-US': 'en' } as const;
const unavailable = { 'ru-RU': 'Сообщение недоступно.', 'en-US': 'Message unavailable.' } as const;

export function createLocalization(locale: AppLocale) {
  const instance = createInstance();
  void instance.init({
    lng: locale, fallbackLng: defaultLocale, supportedLngs: [...supportedLocales],
    load: 'currentOnly', resources: {}, initAsync: false, keySeparator: false,
    returnEmptyString: false, interpolation: { escapeValue: false },
  });
  return instance;
}

export function registerCatalog(instance: i18n, namespace: string, catalog: Catalog) {
  for (const locale of supportedLocales) {
    if (instance.hasResourceBundle(locale, namespace)) continue;
    const messages: Record<string, string> = {};
    for (const [key, pair] of Object.entries(catalog)) {
      const message = pair[languages[locale]];
      if (typeof message === 'string') messages[key] = message.trim() ? message : '';
      else if (message && typeof message === 'object') {
        for (const [form, value] of Object.entries(message)) {
          if (typeof value === 'string' && value.trim()) messages[`${key}_${form}`] = value;
        }
      }
    }
    instance.addResourceBundle(locale, namespace, messages);
  }
}

export function bindTranslator<K extends string>(instance: i18n, locale: AppLocale, namespace: string) {
  return (key: K, params: MessageParams = {}) => instance.t(key, {
    ns: namespace, lng: locale, defaultValue: unavailable[locale], replace: params,
    count: typeof params.count === 'number' ? params.count : undefined,
  });
}

const background = createLocalization(defaultLocale);
export function createTranslator<C extends Catalog>(locale: AppLocale, namespace: string, catalog: C) {
  registerCatalog(background, namespace, catalog);
  return bindTranslator<Extract<keyof C, string>>(background, locale, namespace);
}

function placeholders(value: string) {
  return [...new Set([...value.matchAll(/{{\s*([\w.]+)\s*(?:,[^}]+)?}}/g)].map(match => match[1]))].sort().join(',');
}

export function validateCatalog(namespace: string, catalog: Catalog): string[] {
  const issues: string[] = [];
  for (const [key, pair] of Object.entries(catalog)) {
    const path = `${namespace}.${key}`;
    const reference = typeof pair.ru === 'string' ? pair.ru : pair.ru?.other;
    for (const locale of supportedLocales) {
      const message = pair[languages[locale]];
      if (typeof message === 'string' && typeof pair.ru === 'string' && typeof pair.en === 'string') {
        if (!message.trim() || placeholders(message) !== placeholders(reference ?? '')) issues.push(`${path} (${locale})`);
        continue;
      }
      if (!message || typeof message !== 'object') {
        issues.push(`${path} (${locale})`);
        continue;
      }
      const { pluralCategories } = new Intl.PluralRules(locale).resolvedOptions();
      for (const form of pluralCategories) {
        const text = message[form];
        if (!text?.trim() || placeholders(text) !== placeholders(reference ?? '')) issues.push(`${path}_${form} (${locale})`);
      }
    }
  }
  return issues;
}

const numbers = new Map<AppLocale, Intl.NumberFormat>();
const dates = new Map<string, Intl.DateTimeFormat>();

export function formatLocaleNumber(locale: AppLocale, value: number) {
  let format = numbers.get(locale);
  if (!format) {
    format = new Intl.NumberFormat(locale);
    numbers.set(locale, format);
  }
  return format.format(value);
}

export function formatLocaleDate(locale: AppLocale, value?: string | null, timezone = 'Europe/Moscow') {
  if (!value) return '—';
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return '—';
  const key = `${locale}:${timezone}`;
  let format = dates.get(key);
  if (!format) {
    try {
      format = new Intl.DateTimeFormat(locale, {
        day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', year: 'numeric', timeZone: timezone,
      });
    } catch {
      return formatLocaleDate(locale, value);
    }
    dates.set(key, format);
  }
  return format.format(date);
}
