# Translating URLPulse

[Русский](TRANSLATION_GUIDE.md) · [Developer guide](../development/README.md)

Russian (`ru-RU`) is the first-launch language and fallback. Use American English for `en-US` and match the product terms in the [bilingual glossary](GLOSSARY.md).

## Add or edit a message

1. Find the appropriate catalog in `src/shared/i18n/locales/`. For a new message, choose a stable key that describes the action or state, such as `deleteGroupWarning`.
2. Add `ru` and `en` entries under the same key. When editing existing copy, keep the key and match the named placeholders in both entries.
3. For React, call `createMessages('groups', groupsMessages)` at module scope to define the hook. Call the hook in the component and use `t('deleteGroupWarning', { name })`. In Node.js and Electron, use `createTranslator(locale, namespace, catalog)`.
4. Update the matching user guide and any scenario that relies on the changed label.

Keep complete sentences in the catalog so each language can position parameters such as `{{name}}`. Pass user values as text. Add new user-facing API messages to the diagnostics catalog with a key and parameter validation, so the renderer can translate them again after a language switch.

## Plurals and formatting

Pass a numeric `count` to select a plural form. The Russian catalog needs `one`, `few`, `many`, and `other`. English uses `one` and `other`. For a localized display number, pass both `count` and `value: formatLocaleNumber(locale, count)`, then insert `{{value}}` in the message.

```ts
checkedUrls: {
  ru: { one: 'Проверен {{count}} адрес', few: 'Проверено {{count}} адреса',
    many: 'Проверено {{count}} адресов', other: 'Проверено {{count}} адреса' },
  en: { one: '{{count}} URL checked', other: '{{count}} URLs checked' },
},
```

Use `formatLocaleNumber` and `formatLocaleDate` for UI values. Keep identifiers, field names, error codes, URLs, filter values, ISO 8601 dates, and user content in their original form. Excel copy is translated when the export starts.

## Add a language

1. Add the IETF tag to `supportedLocales`, the catalog code to `languages`, and the generic fallback message to `unavailable` in `src/shared/i18n/index.ts`. Update `Catalog`, `isLocale`, and locale validation.
2. Add every translation. Use `new Intl.PluralRules(locale).resolvedOptions().pluralCategories` to find the required plural forms.
3. Add the language's self-name to the React selectors and native menu. Update Excel output, `PULSE_EMAIL_LOCALE`, SMTP preferences, and locale fixtures. Configure the Windows installer language separately in NSIS.
4. Check switching, persistence, Excel exports, email, and layout in each language. Add the language to the user guides.

## Run the checks

```bash
npm run typecheck
npm test -- tests/i18n-catalogs.test.ts tests/i18n-core.test.ts tests/i18n-diagnostics.test.ts tests/i18n-output.test.ts
npm run test:coverage:browser
npm run test:desktop
node e2e/desktop-locale-smoke.mjs
```

CI runs the Vitest catalog checks for missing or empty translations, plural forms, parameter mismatches, visible React literals, and key references. Dynamic key families are checked by pattern, and diagnostic keys are checked through their registry and recognition tests. Review dynamic messages in the running app in both languages.
