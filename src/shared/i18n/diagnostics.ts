import { createTranslator, formatLocaleNumber, type AppLocale, type MessageParams } from './index.js';
import { diagnosticMessages } from './locales/diagnostics.js';

type DiagnosticKey = keyof typeof diagnosticMessages;

export interface DiagnosticReference {
  messageKey: DiagnosticKey;
  messageParams?: MessageParams;
}

const entries = Object.entries(diagnosticMessages) as [DiagnosticKey, { ru: string; en: string }][];
const exact = new Map<string, DiagnosticKey>();
const parameters = new Map<DiagnosticKey, string[]>();
for (const [key, message] of entries) {
  const names = Array.from(message.ru.matchAll(/{{(\w+)}}/g), match => match[1]);
  if (names.length) parameters.set(key, names);
  else exact.set(message.ru, key);
}

const fields: Readonly<Record<string, string>> = {
  'Название': 'Name',
  'Описание': 'Description',
  'Название группы': 'Work group name',
  'Поиск по адресам': 'Search URLs',
  'Название адреса': 'URL name',
  'Ссылка на sitemap': 'Sitemap URL',
  'Название профиля': 'Profile name',
  'Адрес сайта': 'Site URL',
  'Имя заголовка': 'Header name',
  'Логин сайта': 'Site username',
  'Адрес прокси': 'Proxy URL',
  'Логин прокси': 'Proxy username',
  'URL': 'URL',
  'Email': 'Email',
};

const tlsMessages = new Set<DiagnosticKey>([
  'certificateExpired', 'certificateNotYetValid', 'certificateRevoked', 'certificateHostnameMismatch', 'certificateChainUntrusted',
  'certificateSelfSigned', 'certificateChainUnverified', 'certificateIssuerMissing', 'tlsVerificationFailed',
  'russianCaMissing', 'russianCaInvalid', 'russianCaOutsideValidity',
]);

// Legacy API responses, worker messages, and stored check results carry human-readable diagnostics.
// Exact matches and anchored templates preserve unrelated text supplied by external systems.
const templates: readonly [DiagnosticKey, RegExp][] = [
  ['duplicateHeader', /^Заголовок «(?<name>[!#$%&'*+.^_`|~0-9a-zA-Z-]{1,128})» уже добавлен\.$/u],
  ['reservedHeader', /^Заголовок «(?<name>[!#$%&'*+.^_`|~0-9a-zA-Z-]{1,128})» зарезервирован\.$/u],
  ['invalidHeaderValue', /^Проверьте значение заголовка «(?<name>[!#$%&'*+.^_`|~0-9a-zA-Z-]{1,128})»\.$/u],
  ['checkField', /^Проверьте поле «(?<field>[^»\r\n]{1,40})»\.$/u],
  ['checkFieldLength', /^Проверьте поле «(?<field>[^»\r\n]{1,40})» \(до (?<limit>\d{1,3}(?:[ \u00a0\u202f]\d{3})*) символов\)\.$/u],
  ['originField', /^Укажите схему, хост и порт в поле «(?<field>[^»\r\n]{1,40})»\.$/u],
  ['concurrencyInteger', /^Укажите целое число одновременных проверок от (?<min>\d{1,4}) до (?<max>\d{1,4})\.$/u],
  ['profileHeaderLimit', /^Укажите до (?<limit>\d{1,4}) заголовков и правило назначения профиля\.$/u],
  ['projectProfileLimit', /^Можно сохранить до (?<limit>\d{1,4}) профилей на проект\.$/u],
  ['pacTextFileLimit', /^PAC-файл должен содержать текст UTF-8 и занимать до (?<limit>\d{1,4}) КиБ\.$/u],
  ['sitemapHttpStatus', /^Sitemap вернул HTTP (?<code>[1-9]\d{2})\.$/u],
  ['networkErrorWithCode', /^Ошибка сетевого соединения \((?<code>[A-Z][A-Z0-9_]{1,79})\)\.$/u],
  ['deliveryFailedWithCode', /^Не удалось доставить письмо \(SMTP (?<code>[1-5]\d{2})\)\.$/u],
  ['tlsDiagnosticWithCode', /^(?<message>[^\r\n]{1,400}) \((?<code>(?:ERR_TLS|ERR_SSL|CERT|UNABLE_TO|SELF_SIGNED|DEPTH_ZERO)[A-Z0-9_]{1,79})\)$/u],
];

export function diagnosticReference(value: string): DiagnosticReference | undefined {
  const key = exact.get(value);
  if (key) return { messageKey: key };
  for (const [messageKey, pattern] of templates) {
    const match = pattern.exec(value);
    if (match?.[0] !== value || !match.groups) continue;
    if (match.groups.field && !Object.hasOwn(fields, match.groups.field)) continue;
    if (match.groups.message) {
      const messageKey = exact.get(match.groups.message);
      if (!messageKey || !tlsMessages.has(messageKey)) continue;
    }
    return { messageKey, messageParams: { ...match.groups } };
  }
  return undefined;
}

export function isDiagnosticReference(value: unknown): value is DiagnosticReference {
  if (!value || typeof value !== 'object' || !('messageKey' in value) || typeof value.messageKey !== 'string' ||
      !Object.hasOwn(diagnosticMessages, value.messageKey)) return false;
  const key = value.messageKey as DiagnosticKey;
  const names = parameters.get(key) ?? [];
  const params = 'messageParams' in value ? value.messageParams : undefined;
  if (params === undefined) return names.length === 0;
  if (!params || typeof params !== 'object' || Array.isArray(params)) return false;
  const record = params as Record<string, unknown>;
  if (Object.keys(record).length !== names.length || !names.every(name => {
    const item = record[name];
    return Object.hasOwn(record, name) && typeof item === 'string' && item.length <= 400;
  })) return false;
  if (!names.length) return true;
  // Validate structured parameters with the same grammar as the original diagnostics.
  const message = diagnosticMessages[key].ru.replace(/{{(\w+)}}/g, (_token, name: string) => String(record[name]));
  const parsed = diagnosticReference(message);
  return parsed?.messageKey === key && names.every(name => parsed.messageParams?.[name] === record[name]);
}

export function translateReference(locale: AppLocale, reference: DiagnosticReference): string {
  const { messageKey, messageParams } = reference;
  const t = createTranslator(locale, 'diagnostics', diagnosticMessages);
  if (locale === 'ru-RU' || !messageParams) return t(messageKey, messageParams);
  const params = { ...messageParams };
  if (messageKey === 'tlsDiagnosticWithCode' && typeof params.message === 'string') {
    const originalKey = exact.get(params.message);
    if (originalKey && tlsMessages.has(originalKey)) params.message = t(originalKey);
  }
  if (typeof params.field === 'string' && Object.hasOwn(fields, params.field)) params.field = fields[params.field];
  if (typeof params.limit === 'string' && /^\d{1,4}(?:[ \u00a0\u202f]\d{3}){0,3}$/u.test(params.limit)) {
    params.limit = formatLocaleNumber(locale, Number(params.limit.replace(/[ \u00a0\u202f]/gu, '')));
  }
  return t(messageKey, params);
}

export function translateDiagnostic(value: string, locale: AppLocale): string {
  if (locale === 'ru-RU') return value;
  const reference = diagnosticReference(value);
  return reference ? translateReference(locale, reference) : value;
}
