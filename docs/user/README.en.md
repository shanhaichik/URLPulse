# URLPulse user guide

[Русский](README.md) · [Development and packaging](../development/README.md)

- [Start URLPulse](#start-urlpulse-and-run-a-check)
- [Interface, email, and export languages](#interface-email-and-export-languages)
- [URLs, runs, and work groups](#urls-runs-and-work-groups)
- [Reports, comparisons, and exports](#reports-comparisons-and-exports)
- [Import sitemaps](#import-sitemaps)
- [Schedules and notifications](#schedule-checks-and-receive-alerts)
- [HTTPS, authentication, and proxies](#configure-https-authentication-and-proxies)
- [Data, backup, and privacy](#data-backup-and-privacy)
- [Troubleshooting](#troubleshooting)

## Start URLPulse and run a check

To run URLPulse from source, install Node.js 24.x and start the app from a terminal.

```bash
git clone https://github.com/shanhaichik/URLPulse.git
cd URLPulse
npm ci
npm run build
npm start
```

Open the full URL printed in the terminal. The server listens on `127.0.0.1:8731`. The access key starts a local browser session and is removed from the address bar. Keep the key private and use the current terminal URL after a restart. For a fixed access key, set `PULSE_WEB_ACCESS_KEY` to a random 32–128-character base64url value in `.env`. Press `Ctrl+C` to stop the server.

To run Electron from source, run `npm run desktop` after `npm ci`. Closing the window leaves the app running. Choose **Open URLPulse** to reopen the window or **Quit** to exit from the system tray or menu bar. Use **Quit** before replacing or uninstalling a desktop build. [Desktop packaging](../development/README.md#desktop-packaging)

To install a package you built locally, open the DMG on macOS and drag **Pulse URL** to Applications. On Windows x64, run the generated `Pulse-URL-<version>-win-x64-Setup.exe` and open **Pulse URL** from the Start menu.

### Run your first check

1. Choose **English** in the top bar, then choose **New project**. Enter a name and select **Create project**.
2. Select **Add URL → URL list**. Paste `https://example.com/` and `https://example.org/`, one URL per line. Choose **Add URLs**, then **Done**.
3. Select **Check project**. Open **Run history** and choose the run to see each result, including the HTTP status and response time when available.

## Interface, email, and export languages

The first launch uses Russian. Choose **English** from the **Language** selector in the top bar or an open dialog. Electron also offers **Language** in the app menu and tray or menu bar. The interface updates immediately and preserves the current project, screen, selected URLs, and drafts.

The browser stores the selection in your profile and synchronizes tabs on the same origin. Electron stores it in local app settings. Standard operating-system controls follow the system language.

**CSV for Excel** uses the interface language when the export starts. Report CSV and JSON retain their existing fields, and report dates use ISO 8601. Set the language of scheduled and manual run emails separately for the installation. [Email settings](#schedule-checks-and-receive-alerts)

## URLs, runs, and work groups

**URLs** shows the project's worklist. Paste up to 1,000 URLs at a time. Search by URL or name, filter by status, or sort by a column heading. Use the play button in a row to check one URL, or select rows and choose **Check selected**. **Check project** uses all active URLs.

Click a URL to see its version and check history. Editing an address creates a new version and preserves results for the earlier versions. **Open in browser** opens the saved address in your default browser.

**Stop run** is available in the progress panel, queue, and active report. A stopped run keeps its completed checks. Where **Restart run** is available, it checks the original set of URLs using the current request profiles.

In **Settings → Checks**, set the concurrency from 1 to 24 and select **Save settings**. The default is 6. A run uses the limit when it starts, including runs already queued.

### Work groups

Create a group with **New group**, select rows in **All URLs**, and choose **Add to group**. The same URL can belong to multiple groups.

**Check entire group** checks every active group URL, including URLs hidden by filters. The run captures group membership when queued. **Remove from group** removes selected rows from that group. **Group runs** opens the group's history, and **Export group** exports results for its runs and restarts.

## Reports, comparisons, and exports

Each check makes a GET request with a 10-second total timeout and up to five redirects. A final HTTP 2xx response counts as available. Result details include time to response headers, the final URL, redirect count, `Content-Type`, `Content-Length`, and failure diagnostics when available.

In a report, choose **Status**, **HTTP status**, or **Change** filters, then select **Search** to apply them. Change flags compare the result with the preceding check of the same URL version from a completed run.

### Compare two runs

1. Choose **Run history → Compare runs** and select **Baseline** and **Comparison**. You can start from an open report with **Compare with another run**. The current run appears on the right, with the most recent preceding completed run on the left when available. Completed and stopped runs with results can be compared.
2. Select **New failures** or another count to filter the rows. Counts describe the entire pair and a URL may appear in multiple categories. Expand a row to inspect the HTTP codes, timings, and diagnostics from both runs. A successful check for the same URL version is flagged as slower when its duration increased by at least 200 ms and 30%.
3. Use the export options at the bottom of the comparison to save all matching rows from both runs. Formats include CSV, **CSV for Excel**, and JSON.

The download button in **Run history** exports one run. Exporting from an open report applies the current filters across all result pages. **CSV for Excel** uses UTF-8 with BOM and a semicolon delimiter. You can specify these settings in the Excel import wizard.

## Import sitemaps

For a quick import into **URLs**, use **Add URL → Sitemap file** for a file or **Sitemap URL** for a link. XML, GZIP, and nested indexes are supported. One import can read up to 100 documents, 50,000 entries, and 32 MiB in total, with an 8 MiB decompressed limit per document. A failed nested document stops the quick import before it adds URLs.

### Catalog large sitemaps

1. In **Sitemap catalog**, paste a link and select **Import** or select **Upload file** for XML or XML.GZ. The catalog supports up to 1,000 documents, 256 MiB per document, 2 GiB of decompressed data per import, and one million unique URLs per project. You can pause, resume, or cancel an import. Leave the app running for import to continue in the background.
2. Use **Refresh** or **Upload new version** to update the source. The catalog keeps its current and previous published versions. Use **Changes** to find added, removed, or updated `lastmod` values. Enter **Domain** or **Path prefix** and select **Search** to apply text filters.
3. Select rows or enter a number in **First matching URLs** (up to 5,000). Choose **Check** for a one-off run or **Add to URLs** to include them in future project checks. The catalog can export the entire filtered set or the selected rows as CSV.

**Add all to URLs** transfers unique URLs from the current published version of every source in the project, regardless of source selection and filters. **Stop transfer** keeps URLs already added. If the app restarts during a transfer, it resumes from the last saved position. Use **Import history** to review jobs.

## Schedule checks and receive alerts

In **Settings → Schedule**, turn on **Enable schedule**, select days, time, and time zone, and choose **Save settings**. The default time zone is `Europe/Moscow`. Check the time shown under **Next run**. Scheduled checks use the project's active URLs. Missed runs are combined into one when the app resumes.

Keep Electron or the local server running. Electron's global switch is **Application settings → Background operation → Run scheduled checks**. Choose **Save background settings** after changing it. Pausing lets active runs finish, keeps manual runs available, and holds queued scheduled runs.

In **Settings → Notifications**, pick **All results**, **Only on failures**, or **Off**. Open the feed with **Notifications**. Opening a report marks its notification as read. **Clear notifications** clears the feed while preserving run history and email delivery.

For email, enter the **Recipient email** in the project and configure SMTP.

- In Electron, open **Application settings → SMTP** and choose **Save SMTP settings** after entering the server details. Set **Email language** in the same section and select **Save email language** independently.
- For local web, copy `.env.example` to `.env` and set `SMTP_HOST`, `SMTP_PORT`, `SMTP_TLS_MODE`, and `SMTP_FROM`. Set `SMTP_USER` and `SMTP_PASSWORD` if your SMTP server requires authentication. Common settings are `starttls` on port 587 and `tls` on port 465. Set `PULSE_EMAIL_LOCALE=en-US` for English email and restart the server.

Email language applies to all projects in the installation and defaults to Russian. The feed shows delivery state and attempt counts. Temporary failures are retried after 1, 2, and 4 minutes. If it shows **Delivery unconfirmed** after an interruption, check the mailbox. Report links open on the computer running URLPulse. Browser links require an active local session.

## Configure HTTPS, authentication, and proxies

### Optional Russian root CA

The **Default certificates + Russian CA** profile under **Settings → HTTPS** extends trust for HTTPS checks and remote sitemaps in the selected project.

1. Download **Russian Trusted Root CA** in PEM or DER and save it as `Russian_Trusted_Root_CA.cer`. [Official download portal](https://www.gosuslugi.ru/crt)
2. Put it in `cert/` in the source directory for web, or in `cert/` inside Electron's data directory. You can also set the absolute path with `PULSE_RUSSIAN_CA_FILE` in the web server's `.env` or Electron's launch environment.
3. Fully restart the app. In Electron, choose **Quit** first. Select the profile under **Settings → HTTPS** and choose **Save settings**.

The app checks the SHA-256 fingerprint, certificate authority status, self-signature, and validity dates. For `ERR_TLS_PROFILE_CA`, verify the name, location, and source of the file.

### Request profiles

In **Settings → HTTP requests → Add profile**, enter a name and server URL such as `https://api.example.org:8443`. Profiles match scheme, host, and port. Add headers or Basic, Bearer, or API key authentication. Mark token headers **Secret**. Site authentication and secret headers require HTTPS.

For HTTPS targets, a profile can use an HTTP or HTTPS proxy through CONNECT. Use an HTTPS proxy URL for Basic proxy authentication. Assign the profile to matching URLs or choose it for an individual URL. Choose **Save profile**, then **Test profile** to try it on one URL. Select **No profile** for a direct connection.

A redirect to a different origin uses default request headers. An explicitly configured proxy remains active. Reports distinguish a proxy `407` from the site's HTTP status.

Electron encrypts secrets through the operating system. Leaving a saved secret field blank keeps the current value. Re-enter a secret when changing the server, secret header name, or username. For local web, define a variable such as `PULSE_REQUEST_SECRET_API_TOKEN` in `.env`, restart the server, and enter the variable name in the secret field.

### Project PAC file

Use **Upload PAC file** under **Settings → HTTP requests** to load a UTF-8 `.pac` file up to 256 KiB. **Test route** shows the route source and order for a URL. Each project uses one active PAC, which can be replaced or disabled.

For HTTPS, the supported routes are `DIRECT` and public `PROXY` and `HTTPS` proxies. HTTP URLs use a direct route. The next PAC route can be tried after a connection failure. A TLS error or proxy `407` stops the check. PAC's `dnsResolve()` uses IPv4 DNS queries, so routes can differ from browser results that depend on the hosts file or browser DNS settings.

A manual profile proxy takes precedence. Profiles with site headers and credentials can still use the project PAC. The app reevaluates PAC on redirects and captures the PAC revision when a run is queued. The active revision and revisions referenced by runs are included in a database backup.

## Data, backup, and privacy

| Runtime | Default database path |
| --- | --- |
| Local web | `data/pulse.sqlite3` under the source directory |
| Electron on macOS | `~/Library/Application Support/Pulse URL/pulse.sqlite3` |
| Electron on Windows | `%APPDATA%\Pulse URL\pulse.sqlite3` |

The modes use separate databases by default. Override the web database path with `URL_PULSE_DB` in `.env`, or set `PULSE_DESKTOP_DATA_DIR` for the Electron profile. Only one process can own a database. Keep its `*.owner-lock` file next to it.

SQLite stores projects, address versions, groups, catalog data, schedules, run results, notifications, and HTTP profile metadata. Check results store metadata such as HTTP codes and timings. URL checks and remote sitemap downloads make network requests. A configured proxy receives routed requests, and a configured SMTP server receives the recipient and summary when email is sent.

### Back up and restore

In Electron, use **Application settings → Export database** to save a backup. Choose **Restore database**, select the file, and confirm replacement to restore it. The app validates the copy, saves the prior database as `pulse-before-import-….sqlite3`, and restarts with schedules paused. Partial results are preserved from the backup. Use **Run scheduled checks** to resume schedules when ready.

For local web, stop the server before copying or replacing its SQLite file. When moving to a different computer, configure SMTP and HTTP secrets again. Profile preferences, including language settings and secret values, are stored separately from the database.

### Delete data

- Removing a URL from **URLs** keeps its history. Use **Restore URL** from its history or add it again to bring it back. To remove the active worklist, choose **All URLs**, clear filters, and select **Actions → Delete all project URLs**. The confirmation shows which runs will stop.
- **Clear catalog** removes sources, versions, and import history. URLs already transferred and existing reports remain.
- **Delete report** removes a run's results and linked notification. **Settings → Project → Delete project** removes the project and its records after confirmation.
- To remove the entire profile, quit URLPulse and remove its data directory, or the web database and its sidecar files. Review `.env`, backups, and exported reports separately.

## Troubleshooting

| Symptom | What to check |
| --- | --- |
| The browser cannot connect or has lost its session. | Check that `npm start` is running. Open the current full terminal URL in your browser profile. |
| The database is already open. | Quit the other instance before trying again. Keep its `*.owner-lock` file beside the active database. |
| A site opens in the browser but fails a check. | Read the report's HTTP status, final URL, and failure stage. The check uses its own GET request and credentials, and rejects private and reserved IP addresses. `ERR_TLS_PROFILE_CA` indicates a missing or invalid optional CA file. |
| A check returns `401`, `403`, or `407`. | For `401` or `403`, check the site's authentication and profile assignment. For `407`, check the proxy credentials. |
| Sitemap actions are disabled after editing a filter. | Select **Search** and wait for the new results. See **Imports** for import failures and progress. |
| No scheduled checks or emails arrive. | Check that the app is running, the project schedule and time zone are correct, and Electron schedules are enabled. For email, check the project recipient, notification mode, SMTP, and feed status. |

Read the run report for check diagnostics and the terminal output for local server warnings and errors. For Electron started with `npm run desktop`, use its terminal output or startup error dialog. When reporting a bug, include your URLPulse version, operating system, launch mode, interface language, steps, and the error text. Remove access keys, credentials, recipient addresses, and private URLs from the example. [Report a bug](https://github.com/shanhaichik/URLPulse/issues) · [Report a vulnerability](../../SECURITY.md)
