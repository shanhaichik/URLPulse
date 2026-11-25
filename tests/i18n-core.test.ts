import { describe, expect, it } from 'vitest';
import { createTranslator, parseLocale, validateCatalog, type Catalog } from '../src/shared/i18n/index.js';

const example = {
  status: { ru: 'Сбой: {{name}}', en: 'Failure: {{name}}' },
  fallback: { ru: 'Русский текст', en: '' },
  items: {
    ru: { one: '{{count}} адрес', few: '{{count}} адреса', many: '{{count}} адресов', other: '{{count}} адреса' },
    en: { one: '{{count}} URL', other: '{{count}} URLs' },
  },
} satisfies Catalog;

describe('application messages', () => {
  it('validates stored locale and uses Russian by default', () => {
    for (const invalid of [undefined, null, {}, 'en-GB', '../en-US', 'fr-FR']) {
      expect(parseLocale(invalid)).toBe('ru-RU');
    }
    expect(parseLocale('en-US')).toBe('en-US');
  });

  it('uses bundled fallback and keeps text values separate from translation options', () => {
    const en = createTranslator('en-US', 'core-test', example);
    const ru = createTranslator('ru-RU', 'core-test', example);
    expect(en('fallback')).toBe('Русский текст');
    expect(en('status', { name: '<test>{{count}}</test>', lng: 'ru-RU' })).toBe('Failure: <test>{{count}}</test>');
    expect(ru('status', { name: 'URL' })).toBe('Сбой: URL');
    expect(en('missing' as 'status')).toBe('Message unavailable.');
  });

  it('uses Intl plural rules for zero, positive, negative and fractional counts', () => {
    const en = createTranslator('en-US', 'core-test', example);
    const ru = createTranslator('ru-RU', 'core-test', example);
    expect([0, 1, 2, 5, 21, -2, 1.5].map(count => ru('items', { count }))).toEqual([
      '0 адресов', '1 адрес', '2 адреса', '5 адресов', '21 адрес', '-2 адреса', '1.5 адреса',
    ]);
    expect([0, 1, 2, 1.5].map(count => en('items', { count }))).toEqual(['0 URLs', '1 URL', '2 URLs', '1.5 URLs']);
  });

  it('reports empty messages, missing forms, and mismatched placeholders', () => {
    expect(validateCatalog('example', {
      ...example, status: { ru: 'Сбой: {{name}}', en: 'Failure: {{url}}' },
      single: { ru: { other: '{{count}} адреса' }, en: { other: '{{count}} URLs' } },
    })).toEqual(expect.arrayContaining([
      expect.stringContaining('example.fallback'), expect.stringContaining('example.status'),
      expect.stringContaining('example.single'),
    ]));
  });
});
