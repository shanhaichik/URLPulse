# URLPulse localization verification

[Русский](TEST_REPORT.md) · [Localization report](FINAL_REPORT.en.md)

Local verification of the 1.6.0 candidate ran on November 25, 2026, on macOS 26.5.2 arm64 with Node.js 24.22.3. Tests used temporary databases and profiles with synthetic fixtures. The base was source release 1.5.1 (`78c6d33`).

| Check | Result |
| --- | --- |
| `npm run build` | TypeScript and Vite passed. Main JS is 538.21 kB or 161.01 kB gzip, up from 380.87 kB or 113.23 kB gzip in 1.5.1. Vite reports the 500 kB chunk warning. |
| `npm run test:coverage` | 246 tests in 38 files passed. 92.29% line coverage and 83.50% branch coverage. |
| `PULSE_E2E_BROWSER_CHANNEL=chrome npm run test:coverage:browser` | 77 scenarios passed. React coverage is 91.90% for lines and 84.56% for branches. |
| `node e2e/desktop-smoke.mjs`, `node e2e/desktop-locale-smoke.mjs`, `node e2e/desktop-settings-smoke.mjs` after build | Electron verification passed on Apple Silicon, including the native menu, locale persistence, and IPC restrictions. |
| Database and export compatibility | An actual 1.5.1 fixture backup restored into the localized build. The stopped run and stored DNS error were preserved, and English Excel used the localized diagnostic. 1.5.1 also read a new backup. CSV and JSON retained their fields. |
| Switching and email | Switching in a 320 px dialog kept its draft and route. Existing feedback updated, tabs synchronized, and invalid preferences fell back to Russian. With browser storage denied, switching still worked for the current window. SMTP language saved separately with unavailable credentials. |

The screenshots use four synthetic URLs and two runs, including a `200 → 503` regression. The audit checked both languages at 1280 and 320 CSS pixels, English at 400 CSS pixels, system high-contrast colors, and a separate extended pseudo-locale. A 200% Electron test at 800 window pixels fit the settings dialog. At the minimum 400-pixel window size with 200% zoom, the 200 CSS pixel viewport produced horizontal overflow.

| Screen | English | Русский |
| --- | --- | --- |
| Project and worklist | [Project URLs](screenshots/en-urls.png) | [Адреса проекта](screenshots/ru-urls.png) |
| Sitemap catalog | [Catalog](screenshots/en-catalog.png) | [Каталог](screenshots/ru-catalog.png) |
| Run report and comparison | [Report](screenshots/en-report.png) · [Comparison](screenshots/en-comparison.png) | [Отчёт](screenshots/ru-report.png) · [Сравнение](screenshots/ru-comparison.png) |
| Settings and notifications | [Settings](screenshots/en-settings.png) · [Notifications](screenshots/en-notifications.png) | [Настройки](screenshots/ru-settings.png) · [Уведомления](screenshots/ru-notifications.png) |
| Desktop settings | [Application settings](screenshots/desktop-en-US.png) | [Настройки приложения](screenshots/desktop-ru-RU.png) |

In local Chrome, 20 alternating cold contexts per version loaded the same 10,000-URL fixture. Median time to the first row was 70.7 ms on 1.5.1 and 81.9 ms on 1.6.0. The 95th percentiles were 72.8 ms and 86.7 ms. Language switching took a median of 32.6 ms and a 95th percentile of 33.2 ms over 20 switches. The switch timing includes two frames after the HTML language attribute updates. These measurements describe this host and fixture.

## Rebuilt test installers

Before setting the 1.6.0 version, the Apple Silicon and Intel DMGs and the Windows x64 installer were rebuilt from the same localization compilation. All three SHA-256 checks passed, and each package contained the same 72 compiled files.

- Apple Silicon passed the packaged desktop and locale smoke tests.
- The Intel DMG was mounted and the locale smoke passed under Rosetta. The broader smoke hit a PAC execution timeout twice. Native Intel PAC verification remains open.
- The Windows package contained an x86-64 executable. Interactive installation, reinstallation, and removal still require a Windows run for the current changes.

These are local test installers without publisher signatures. The [source release checklist](../development/release-checklist.md) tracks the GitHub release steps.

## Publication documentation checks

Relative links, heading anchors, image paths, and the bilingual GitHub form YAML were checked. A local GFM-compatible Chrome preview verified the English and Russian README files at 375 and 1280 pixels in both color schemes, including navigation between the two versions. The demo kept a selected URL during the language switch and opened a comparison with synthetic data. [Demo](../media/language-switch.gif)

The sample Excel headers and statuses followed the requested language. Its CSV and JSON exports matched byte for byte across locales. The [release checklist](../development/release-checklist.md) records the GitHub verification steps for the next tag.
