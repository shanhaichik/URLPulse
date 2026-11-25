# Contributing to URLPulse

[Русский](#как-внести-вклад-в-пульс-url)

## Report issues and suggest changes

Check existing issues and use a form for bugs, feature requests, or documentation corrections. Describe the app version, OS and architecture, run mode, interface language, steps, and expected and actual results. Use synthetic examples and remove private URLs, credentials, access links, PAC files, and SMTP details from attachments. [Issue forms](https://github.com/shanhaichik/URLPulse/issues/new/choose) · [Security policy](SECURITY.md)

## Change code or documentation

1. Fork the repository and create a branch from `main`. Use Node.js 24.x and run `npm ci`.
2. Use `npm run dev` for browser development or `npm run desktop` for Electron.
3. Cover new behavior or a regression with an appropriate test and temporary fixtures. When UI text changes, update both catalog entries and check them in context. [Translation guide](docs/localization/TRANSLATION_GUIDE.en.md)
4. Update both README and user or developer guide versions where behavior, labels, commands, APIs, or settings change. Use synthetic screenshots for visible changes.
5. Open a pull request explaining the user workflow, what changed, and how you verified it. Link related issues. For SQLite schema changes, describe testing against a database from the previous version.

### Checks before a pull request

```bash
npm run typecheck
npm test
npm run build
npx playwright install chromium
npm run test:e2e
```

Run `npm run test:desktop` in a desktop session for Electron changes. Run `node e2e/desktop-locale-smoke.mjs` after the build for desktop localization changes. The development guide covers coverage commands and packaging. [Developer guide](docs/development/README.md)

Keep runtime databases, `.env`, logs, generated test reports, and installers out of Git. Contributions use the project's [MIT license](LICENSE).

## Как внести вклад в Пульс URL

[English](#contributing-to-urlpulse)

### Баги и предложения

Проверьте существующие задачи в [Issues](https://github.com/shanhaichik/URLPulse/issues) и выберите [форму](https://github.com/shanhaichik/URLPulse/issues/new/choose). Для бага укажите версию приложения, ОС и архитектуру, режим запуска (браузер или Electron), язык интерфейса, шаги воспроизведения, ожидаемый и фактический результаты. Для предложения опишите сценарий и какое действие в нём занимает лишнее время или требует обходного пути.

Публикуйте примеры на синтетических проектах. Перед отправкой скриншотов, выгрузок и логов уберите приватные URL, параметры авторизации, ключи доступа, PAC-файлы и почтовые настройки. Для сообщений об уязвимостях см. [политику безопасности](SECURITY.md#политика-безопасности).

### Изменения кода

1. Создайте форк и отдельную ветку от `main`. Установите Node.js 24.x и выполните `npm ci`.
2. Выполните `npm run dev` для работы с веб-интерфейсом или `npm run desktop` для проверки Electron.
3. Добавьте тест для исправленной регрессии или нового сценария. Используйте временную SQLite и локальные фикстуры. Для правок текста обновите оба словаря и проверьте подписи в интерфейсе. [Руководство по переводу](docs/localization/TRANSLATION_GUIDE.md)
4. Обновите обе версии README и соответствующих руководств, если изменились сценарии, подписи, команды, API или настройки. Приложите синтетический скриншот или короткую запись для заметного изменения интерфейса.
5. Откройте pull request с описанием сценария, команды проверки и результата. Если менялась схема SQLite, опишите проверку на базе предыдущей версии.

### Проверки перед pull request

```bash
npm run typecheck
npm test
npm run build
npx playwright install chromium
npm run test:e2e
```

Для изменений в Electron выполните `npm run test:desktop` в графическом сеансе. Для локализации Electron запустите `node e2e/desktop-locale-smoke.mjs` после сборки. Команды упаковки и проверки покрытия приведены в [руководстве разработчика](docs/development/README.ru.md).

Сохраняйте в Git исходники, тесты, фикстуры и документацию. Рабочие базы SQLite, `.env`, логи, отчёты тестов и установщики остаются локальными. При отправке кода действуют условия [MIT](LICENSE).
