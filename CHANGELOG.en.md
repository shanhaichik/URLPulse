# URLPulse changelog

[Русский](CHANGELOG.md)

## 1.6.0

- English and Russian interfaces in the browser and Electron. Switch languages immediately and keep the selection across launches. Electron menus, the tray, and app-provided dialog captions follow the selection.
- CSV for Excel follows the interface language for headings, comparison labels, and known diagnostics. CSV and JSON retain their existing structure.
- Set one email language for all projects in Electron settings or through `PULSE_EMAIL_LOCALE` in the web server. Russian is the default.
- Updated guides, screenshots, and the demo for both languages. Added translation instructions and catalog checks.
- Project PAC now applies to sitemap imports in URLs and Catalog. Project-specific trusted proxies support corporate IP addresses, hostname CONNECT, and Basic over HTTPS. Catalog jobs capture the PAC revision when queued.

See the [user guide](docs/user/README.en.md) and [localization report](docs/localization/FINAL_REPORT.en.md).

## 1.5.1

- Fixed the paths used to package the Windows x64 installer.
- Stabilized the export, sitemap import, and notification feed tests.
- CI checks the web build, test coverage, and installers for macOS Apple Silicon, macOS Intel, and Windows x64. Source publication validates the tag version and successful CI on its commit.

## 1.5.0

First source release under the MIT license. The web app runs locally on Node.js 24.x. Build instructions cover macOS Apple Silicon, macOS Intel, and Windows x64. [README](README.md).

- Project URL lists, work groups, bulk actions, and URL version history.
- Background XML and XML.GZ sitemap import, change tracking, and transfer to the worklist. Catalogs support up to one million unique URLs per project.
- Manual and scheduled runs. Stop a run to preserve partial results and restart it.
- Compare runs by status, HTTP code, response time, and diagnostics. Export reports and comparisons as CSV, CSV for Excel, or JSON.
- Project HTTPS profiles, request headers, site authentication, proxy, and PAC. The optional Russian root CA is downloaded separately.
- In-app notifications, SMTP email delivery, and SQLite backup in Electron.
- Local web session protection, database validation before restore, and recovery after interruption.
