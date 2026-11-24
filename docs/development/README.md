# Developing URLPulse

URLPulse has a Russian-language interface in both browser and Electron builds. See [Architecture and contracts](architecture.md) for the request paths, SQLite model, and desktop bridge. See [Contributing](../../CONTRIBUTING.md) for the contribution workflow.

## Set up and run

Install Git and Node.js **24.x** with npm. The [version file](../../.nvmrc) selects the Node major version. CI uses Node 24.22.3. Run these commands from the repository root.

```sh
npm ci
npm run dev
```

Open the access link printed by the server. Vite serves React at `http://127.0.0.1:5173` and proxies `/api` to Fastify on `127.0.0.1:8731`. The link exchanges its access key for a browser session. The key is a credential. Reopen the current link after a server restart.

```sh
npm run build
npm start         # Built web app at http://127.0.0.1:8731
npm run desktop   # Rebuilds and launches Electron
```

`npm run build` type-checks the project, runs the Vite production build into `dist/client`, and compiles the server, shared modules, and Electron entry points into `dist`. The web process serves the built UI and API on the same loopback origin. Electron serves the built UI from its internal protocol.

### Local configuration

The web scripts read `.env` when it exists. Copy [`.env.example`](../../.env.example) for optional settings. `URL_PULSE_DB` overrides the default `data/pulse.sqlite3`. `PULSE_WEB_ACCESS_KEY` accepts a random 32–128-character base64url value for a stable access key. Session credentials are still regenerated on restart. `SMTP_*` configures web email delivery, and `PULSE_REQUEST_SECRET_*` supplies HTTP profile secrets by name.

Electron stores `pulse.sqlite3` in its per-user profile. To use a separate desktop profile, set `PULSE_DESKTOP_DATA_DIR` in the launch environment. Configure desktop SMTP and background behavior in **Настройки приложения**. Use separate databases for concurrent web and Electron processes. Custom data directories should belong to the current user and have mode `0700` on POSIX or private ACLs on Windows. Keep local settings, credentials, and databases out of commits.

The standard TLS profile works with the runtime trust roots. For the optional `russian-ca` profile, obtain `Russian_Trusted_Root_CA.cer` separately. Use the checkout’s `cert/` folder for web, the profile’s `cert/` folder for Electron, or set `PULSE_RUSSIAN_CA_FILE` to an absolute path. Restart the process after changing the file. URLPulse validates the pinned fingerprint, CA status, self-signature, and validity dates before adding the CA to trust for that project’s HTTPS checks and remote sitemaps. [`tls-profile.ts`](../../src/server/tls-profile.ts)

### Debug and troubleshoot

| Symptom or task | Where to start |
| --- | --- |
| Debug React | Use browser DevTools with `npm run dev`. Use the Network panel to inspect local API responses. |
| Debug Fastify | Stop the existing API process, then run `node --inspect --env-file-if-exists=.env --import tsx src/server/main.ts --dev`. Start the Vite process separately with `npm run dev:web` if needed. |
| Port already in use | Stop the process on 5173 or 8731 for development, or 8732 for the Playwright fixture server. |
| Browser API returns 401 | Open the current terminal access link using its printed loopback origin. |
| SQLite already open | Stop the owner with Ctrl+C or the Electron **Выход** action. Closing the Electron window leaves it in the tray. Leave the `.owner-lock` file in place. |
| `ERR_TLS_PROFILE_CA` | Check the configured file path and pinned certificate. Use the default project TLS profile when the additional CA is unnecessary. |

Use `npm run typecheck` for automated static checking. The repository currently has no lint or formatter script. Match the surrounding TypeScript and CSS style and keep formatting changes scoped to the lines you edit. [`package.json`](../../package.json)

## Tests

| Command | Scope |
| --- | --- |
| `npm test` | Vitest tests under `tests/` for storage, API contracts, scheduling, checks, imports, exports, and desktop utilities. |
| `npx playwright install chromium` | Installs Chromium for the browser tests and coverage. |
| `npm run test:e2e` | Builds the app and runs Playwright specs under `e2e/` against a fixture server on port 8732. |
| `npm run test:desktop` | Builds and runs the Electron smoke scenario with a temporary profile. Run this from a desktop session. |
| `npm run test:coverage` | V8 coverage for server, desktop, and shared TypeScript. Reports go to `coverage/node/`. Full-run thresholds are 80% lines and 75% branches. |
| `npm run test:coverage:browser` | Playwright coverage for instrumented React code. Reports go to `coverage/browser/`. Full-run thresholds are 84% lines and 79% branches. |

Use `npm test -- tests/http-contracts.test.ts` for a focused contract check or `npx playwright test e2e/run-workflow.spec.ts` after building the app. `PULSE_E2E_BROWSER_CHANNEL=chrome` uses an installed Chrome. `PULSE_SMOKE_EXECUTABLE` can point the desktop smoke to the installed application executable, and `PULSE_DESKTOP_SKIP_PROTOCOL_REGISTRATION=1` skips OS registration for isolated Windows test profiles. [Coverage audit](../audits/2026-11-23/TEST_COVERAGE.md)

For a regression test, exercise the closest caller that can reproduce the failure. Use `createApp()` with Fastify injection for HTTP contracts and temporary SQLite files for persistence and concurrency behavior. Follow the fixture server and desktop smoke patterns for controlled checks, sitemap responses, and test profiles. Use synthetic data, stub external responses, and close the stores, workers, and fixture servers before removing temporary files. [`e2e/server.ts`](../../e2e/server.ts) · [`e2e/desktop-smoke.mjs`](../../e2e/desktop-smoke.mjs)

## Desktop packaging

Build the arm64 or x64 DMG on macOS. Electron Forge uses the local `ditto` and `hdiutil` tools. Build the x64 Windows installer on Windows with NSIS installed, or cross-build it on macOS with `makensis` available. Set `PULSE_MAKENSIS` if the compiler uses a custom path. Run `npm ci` before packaging.

```sh
# macOS
npm run make:mac -- --arch=arm64
npm run make:mac -- --arch=x64

# Windows x64
npm run make:windows
```

The default outputs are `out/make/dmg/<arch>/Pulse URL-<version>-<arch>.dmg` and `out/installers/Pulse-URL-<version>-win-x64-Setup.exe`. Each installer has a sibling `SHA256SUMS.txt`. Set `PULSE_PACKAGE_OUT` to put the build in another directory. With the default environment, installers are local test builds without publisher signatures. [Forge configuration](../../forge.config.cjs) · [Packaging scripts](../../packaging/)

## Release preparation

For a source release, check that `package.json`, `package-lock.json`, and [CHANGELOG.md](../../CHANGELOG.md) agree. Review the exact source tree for generated files and local data, validate it with the tests above, and point the version tag (`vX.Y.Z`) at the approved release commit. Link the changes and validation limits in the release notes.

**1.5.0 was published as a source-only release.** The pinned CA is obtained separately. Local, unsigned packaging produced all three installer targets and the full Apple Silicon packaged smoke passed. Native Windows installer checks were explicitly waived for that release. The Intel package passed the targeted CA check under Rosetta. The full Intel smoke under Rosetta timed out at the PAC step twice.

On pull requests, pushes to `main`, and manual dispatch, [Tests and coverage](../../.github/workflows/tests.yml) builds the production web app, type-checks it, and measures test coverage. [Desktop checks](../../.github/workflows/desktop-build.yml) runs unit tests, builds installers, and smoke-tests the three desktop targets. Desktop runners limit Vitest to two workers and give each test up to 20 seconds. The Apple Silicon job uses `macos-26`. Desktop outputs are CI test artifacts.

To use [Source release](../../.github/workflows/source-release.yml), merge the version update into `main` through a pull request and wait for both CI workflows to pass on the resulting commit. Push an annotated `vX.Y.Z` tag that matches `package.json`. In GitHub Actions, run **Source release** from the default branch and enter the tag. The default `publish: false` validates the tag and CI status. Select `publish: true` to create the GitHub Release with generated notes and the source archives provided by GitHub. Publication confirms the tag still points to the verified commit.

For a future signed installer release, dispatch [Signed desktop release](../../.github/workflows/desktop-release.yml) from the protected default branch with the full SHA of its tagged commit. The workflow needs the protected `desktop-release` environment and the `pulse-signing` runner group with native macOS arm64, macOS x64, and Windows x64 runners. It sets `PULSE_PUBLIC_RELEASE=1`, uses a macOS signing identity and `notarytool` keychain profile, and uses Windows SignTool with a certificate thumbprint and timestamp URL. The workflow verifies signatures and smoke results, then uploads the installer, `SHA256SUMS.txt`, and `release.json` for maintainer review. Before distributing Windows binaries, validate installation, uninstall, signatures, report links, tray behavior, file dialogs, and backup restore in a clean native Windows environment.

Keep signing runners isolated from public pull requests. Before distributing a built web bundle or an installer, collect and verify the third-party notices for the components in that artifact. [GitHub Actions security guidance](https://docs.github.com/en/actions/reference/security/secure-use)
