# URLPulse user guide

[Русский](README.md) · [Development and packaging](../development/README.md)

URLPulse has a Russian interface. The labels in these instructions match the controls in the app.

## Start URLPulse and run a check

To run URLPulse from source, install Node.js 24.x and start the app from a terminal.

```bash
git clone https://github.com/shanhaichik/URLPulse.git
cd URLPulse
npm ci
npm run build
npm start
```

Open the full URL printed in the terminal. The server listens on `127.0.0.1:8731`. The access key starts a local browser session and is removed from the address bar. Keep the key private and use the current terminal URL after a restart. Press `Ctrl+C` to stop the server.

To run Electron from source, run `npm run desktop` after `npm ci`. Closing the window leaves the app running. Choose **Открыть Пульс URL** to reopen the window or **Выход** to quit from the system tray or menu bar. For local unsigned installers, see [Development and packaging](../development/README.md).

To install a package you built locally, open the DMG on macOS and drag **Pulse URL** to Applications. On Windows x64, run the generated `Pulse-URL-<version>-win-x64-Setup.exe` and open **Pulse URL** from the Start menu.

1. Choose **Новый проект**, enter a name, and select **Создать проект**.
2. Select **Добавить URL → Список URL**. Paste `https://example.com/` and `https://example.org/`, one address per line. Choose **Добавить адреса**, then **Готово**.
3. Select **Проверить проект**. Open **Журнал запусков** and choose the run to see each result, including the HTTP status and response time when available.

## Check, compare, and export

- In **Адреса**, use the play icon next to a URL for a single check, or select several rows and choose **Проверить выбранные**. Click a URL to see its history. **Остановить проверку** stops a run and keeps the results already received.
- Use **Новая группа** and **Добавить в группу** to make a reusable subset. **Проверить группу целиком** checks every active URL in the group, including URLs hidden by filters. **Прогоны группы** opens its run history.
- Each check makes a GET request with a 10-second total timeout and up to five redirects. A final HTTP 2xx response counts as available. **Настройки → Проверки** lets you set 1–24 concurrent checks per run. The default is 6.
- In a report, search by URL or name, choose filters, and select **Найти**. To compare two completed or stopped runs with results, choose **Журнал запусков → Сравнить прогоны** and select **Было** (before) and **Стало** (after). Select **Новые сбои** to find new failures. Expand a row to see both results.
- **Экспорт по фильтрам** saves all comparison rows matching the applied filters. Use the download button in **Журнал запусков** to export a single run, or export from the open report to apply its filters. Formats include CSV, **CSV для Excel** (Russian headers, UTF-8 with BOM, semicolon delimiter), and JSON.

## Import sitemaps

For a quick import into **Адреса**, use **Добавить URL → Файл sitemap** for a file or **Ссылка на sitemap** for a link. XML, GZIP, and nested indexes are supported. One import can read up to 100 documents, 50,000 entries, and 32 MiB in total, with an 8 MiB decompressed limit per document.

Use **Каталог sitemap** for large sources or to review changes across versions. Paste a link and select **Импортировать**, or select **Загрузить файл** for XML/XML.GZ. Use **Изменения** to find URLs added, removed, or changed in `lastmod` since the previous version. Use **Домен** and **Начало пути** with **Найти** to narrow the list. Choose rows or enter a number in **Первые URL по фильтру** (up to 5,000), then choose **Проверить** for a one-off run or **В рабочий список** to include them in future project checks. **Добавить все в «Адреса»** transfers the current published version of every source in the project. It uses the entire catalog regardless of your filters.

## Schedule checks and receive alerts

In **Настройки → Расписание**, turn on **Включить расписание**, select days, time, and time zone, and choose **Сохранить настройки**. Check **Следующий запуск**. Scheduled checks use the project's active address list. Keep Electron or the local server running. Electron's global schedule switch is **Настройки приложения → Фоновая работа → Выполнять расписания**. Select **Сохранить фоновую работу** after changing it.

Under **Настройки → Уведомления**, pick **Все результаты** for every completed run, **Только при ошибках** for failures, or **Выключено** to turn off alerts. Open the feed with **Уведомления**. For email, set **Email получателя** in the project and configure SMTP in **Настройки приложения → SMTP** (Electron) or `.env` using `.env.example` (local web). Restart the server after changing `.env`. The feed shows email delivery status. If it says **Доставка не подтверждена**, check the recipient's mailbox. Report links in email open on the computer running URLPulse. Browser links require an active local session.

## Configure HTTPS, authentication, and proxies

**Настройки → HTTP-запросы** lets you add headers and configure Basic, Bearer, or API key authentication for a matching scheme, host, and port. Mark custom token headers **Секрет**. Site authentication and secret headers require HTTPS. Electron uses OS-backed encryption for secrets. For the web server, add a `PULSE_REQUEST_SECRET_…` variable in `.env` and enter its name in the secret field. Restart the server after editing `.env`. Save the profile and use **Проверить профиль** to try it on one URL.

The same panel can load a UTF-8 `.pac` file up to 256 KiB. Use **Проверить маршрут** to see the route for a URL. A manually configured profile proxy takes precedence, and **Без профиля** selects a direct connection. The report separates a proxy `407` from a target server's HTTP status.

The optional **Настройки → HTTPS → Штатные сертификаты + Российский CA** profile requires a separately downloaded Russian Trusted Root CA certificate. Save it as `Russian_Trusted_Root_CA.cer` in the source `cert/` directory for local web use, or in `cert/` inside Electron's data directory. Restart URLPulse, select the HTTPS profile, and save the project settings. The app validates the file before applying it to the project. [Russian CA instructions](README.md#российский-корневой-ca) · [Official download portal](https://www.gosuslugi.ru/crt)

## Data, backup, and privacy

| Runtime | Default database path |
| --- | --- |
| Local web | `data/pulse.sqlite3` under the source directory |
| Electron on macOS | `~/Library/Application Support/Pulse URL/pulse.sqlite3` |
| Electron on Windows | `%APPDATA%\Pulse URL\pulse.sqlite3` |

The web and Electron modes have separate databases by default. SQLite stores projects, addresses and versions, groups, sitemap catalog data, schedules, run results, notifications, and HTTP profile metadata. URL checks do not store response bodies. URL checks and remote sitemap downloads make network requests, a configured proxy receives routed traffic, and a configured SMTP server receives the recipient address and summary when email is sent.

In Electron, use **Настройки приложения → Экспорт базы** to save a backup. To restore, select **Восстановить базу**, choose the file, and confirm replacement. The app validates the copy, saves the previous database next to the active one, and restarts with schedules paused. In local web mode, stop the server before copying or replacing its SQLite file. On a different computer, set up SMTP and HTTP secrets again. SMTP settings and secret values are stored separately from the database.

Removing a URL from **Адреса** keeps its run history. **Удалить отчёт** removes a run's results and linked notification. **Настройки → Проект → Удалить проект** removes the project and its records after confirmation. To remove the full local profile, quit URLPulse and remove its data directory, or the web database and its sidecar files. Manage `.env`, backup copies, and exported reports separately. [Detailed data and deletion instructions in Russian](README.md#данные-и-резервное-копирование)

## Troubleshooting

| Symptom | What to check |
| --- | --- |
| The browser cannot connect or has lost its session. | Check that `npm start` is running. Open the current full terminal URL in your browser profile. |
| The database is already open. | Quit the other instance before trying again. Keep its `*.owner-lock` file beside the active database. |
| A site opens in the browser but fails a check. | Read the report's HTTP status, final URL, and failure stage. The check uses its own GET request and credentials, and rejects private and reserved IP addresses. `ERR_TLS_PROFILE_CA` indicates a missing or invalid optional CA file. |
| Sitemap actions are disabled after editing a filter. | Select **Найти** and wait for the new results. See **Импорты** for import failures and progress. |
| No scheduled checks or emails arrive. | Check that the app is running, the project schedule and time zone are correct, and Electron schedules are enabled. For email, check the project recipient, notification mode, SMTP, and feed status. |

Read the run report for check diagnostics and the terminal output for local server warnings and errors. For Electron started with `npm run desktop`, use its terminal output or startup error dialog. When reporting a bug, include your URLPulse version, operating system, launch mode, steps, and the error text. Remove access keys, credentials, recipient addresses, and private URLs from the example. [Report a bug](https://github.com/shanhaichik/URLPulse/issues) · [Report a vulnerability](../../SECURITY.md)
