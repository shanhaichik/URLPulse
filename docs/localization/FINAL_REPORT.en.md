# URLPulse localization report

[Русский](FINAL_REPORT.md) · [Test results](TEST_REPORT.en.md)

The web and Electron apps support Russian (`ru-RU`) and American English (`en-US`). The language selector in the top bar and open dialogs updates the UI immediately and preserves the choice and form entries. Electron also exposes it in its menu and tray. Russian is the first-launch language. Installation-wide email language is configured separately.

## What changed

- React screens, accessible names, dialogs, status messages, and known diagnostics use shared i18next catalogs. Dates and numbers use `Intl` in the active locale. The catalogs are bundled for offline use.
- Electron localizes the window title, app menus, tray, and app-provided dialog text. The Windows installer contains English and Russian text. Operating-system controls follow the system language.
- CSV for Excel captures the current locale and uses it for headings, comparison labels, and known diagnostics. CSV and JSON keep their existing fields. SQLite preserves original history.
- The email worker uses its installation's mail setting even when the interface is closed. On web use `PULSE_EMAIL_LOCALE`. On Electron use **Application settings → SMTP → Email language**.

The catalog checks cover 1,108 keys in 15 modules and 2,224 translated values including plural forms. Static checks cover visible text and attributes in 12 React TSX files and recognize 218 static Russian diagnostics in the audited server error classes. Technical codes, sample URLs, language self-names, user content, and arbitrary upstream messages retain their original forms. The independent review added checks for language switching inside a modal, focus restoration, live feedback, compatibility with the 1.5.1 API and exports, and structured diagnostic parameter validation. Tested states are listed in the [test report](TEST_REPORT.en.md).

## Verification and open checks

The production build, 246 Vitest tests, 77 Playwright scenarios, and three Electron smoke tests passed locally on macOS Apple Silicon. A database backup from 1.5.1 restored successfully, and 1.5.1 read a new backup. In a 10,000-URL project, median language switching took 32.6 ms. Median cold opening of the URL list changed from 70.7 ms to 81.9 ms, and gzip JavaScript grew from 113.23 kB to 161.01 kB.

The macOS arm64 and x64 DMGs and Windows x64 installer were rebuilt for local testing before the version bump. The Intel language smoke passed under Rosetta, while the broader smoke reached the PAC execution limit twice. The Windows installer language picker requires a manual interactive check. [Verification details and screenshots](TEST_REPORT.en.md)

To edit catalogs or add a language, follow the [translation guide](TRANSLATION_GUIDE.en.md). To review the new HTTP and IPC locale fields, see [Architecture and contracts](../development/architecture.md#language-settings).
