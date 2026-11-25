import { describe, expect, it } from 'vitest';
import { diagnosticReference, isDiagnosticReference, translateDiagnostic, translateReference } from '../src/shared/i18n/diagnostics.js';

describe('diagnostic localization', () => {
  it('localizes known desktop and web diagnostics while preserving Russian compatibility', () => {
    const message = 'Проект не найден.';
    expect(translateDiagnostic(message, 'en-US')).toBe('Project not found.');
    expect(translateDiagnostic(message, 'ru-RU')).toBe(message);
    expect(translateDiagnostic('Прокси отклонил запрос.', 'en-US')).toBe('The proxy rejected the request.');
  });

  it('round trips a structured key with a user-supplied header name', () => {
    const message = 'Заголовок «x-api-token» уже добавлен.';
    const stored = diagnosticReference(message);
    expect(stored).toEqual({ messageKey: 'duplicateHeader', messageParams: { name: 'x-api-token' } });
    expect(isDiagnosticReference(stored)).toBe(true);
    expect(translateReference('en-US', stored!)).toBe('The “x-api-token” header has already been added.');
    expect(translateReference('ru-RU', stored!)).toBe(message);
  });

  it('preserves external text and rejects unknown or malformed keys', () => {
    const unrecognized = 'Upstream: Проект не найден.';
    expect(translateDiagnostic(unrecognized, 'en-US')).toBe(unrecognized);
    expect(translateDiagnostic('Заголовок «authorization» уже добавлен.\n', 'en-US')).toBe('Заголовок «authorization» уже добавлен.\n');
    expect(translateDiagnostic('Проверьте поле «Имя нестандартного поля».', 'en-US')).toBe('Проверьте поле «Имя нестандартного поля».');
    expect(isDiagnosticReference({ messageKey: '__proto__' })).toBe(false);
    expect(isDiagnosticReference({ messageKey: 'duplicateHeader' })).toBe(false);
    expect(isDiagnosticReference({ messageKey: 'duplicateHeader', messageParams: { name: [] } })).toBe(false);
    expect(isDiagnosticReference({ messageKey: 'duplicateHeader', messageParams: { name: '<h1>' } })).toBe(false);
    expect(isDiagnosticReference({ messageKey: 'checkFieldLength', messageParams: { field: 'Unknown', limit: '10' } })).toBe(false);
    expect(isDiagnosticReference({ messageKey: 'checkFieldLength', messageParams: { field: 'Описание', limit: '-1' } })).toBe(false);
  });

  it('translates known field labels and preserves technical codes', () => {
    expect(translateDiagnostic('Проверьте поле «Поиск по адресам» (до 2\u00a0000 символов).', 'en-US'))
      .toBe('Enter up to 2,000 characters in the “Search URLs” field.');
    expect(translateDiagnostic('Срок действия сертификата истёк. (CERT_HAS_EXPIRED)', 'en-US'))
      .toBe('The certificate has expired. (CERT_HAS_EXPIRED)');
  });
});
