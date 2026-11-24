# Contributing to URLPulse

Use the [issue forms](https://github.com/shanhaichik/URLPulse/issues/new/choose) for bugs, feature requests, and documentation corrections. See the [security policy](SECURITY.md) for vulnerability reports.

Use Node.js 24.x and run `npm ci`. Start the browser development setup with `npm run dev` or the Electron app with `npm run desktop`. See the [development guide](docs/development/README.md) for tests and packaging. In your pull request, link related issues and describe what changed, why, and how you checked it. Use synthetic data in screenshots and examples. Update the README and related docs when behavior, commands, APIs, or settings change.

## Как внести вклад в Пульс URL

### Баги и предложения

Проверьте существующие задачи в [Issues](https://github.com/shanhaichik/URLPulse/issues) и выберите [форму](https://github.com/shanhaichik/URLPulse/issues/new/choose). Для бага укажите версию приложения, ОС и архитектуру, режим запуска (браузер или Electron), шаги воспроизведения, ожидаемый и фактический результаты. Для предложения опишите сценарий и какое действие в нём занимает лишнее время или требует обходного пути.

Публикуйте примеры на синтетических проектах. Перед отправкой скриншотов, выгрузок и логов уберите приватные URL, параметры авторизации, ключи доступа, PAC-файлы и почтовые настройки. Для сообщений об уязвимостях см. [политику безопасности](SECURITY.md).

### Изменения кода

1. Создайте форк и отдельную ветку от `main`. Установите Node.js 24.x и выполните `npm ci`.
2. Выполните `npm run dev` для работы с веб-интерфейсом или `npm run desktop` для проверки Electron.
3. Добавьте тест для исправленной регрессии или нового сценария. Используйте временную SQLite и локальные фикстуры. Для изменений в интерфейсе проверьте клавиатуру, узкое окно и состояния загрузки и ошибок.
4. Обновите README и связанные документы, если изменились сценарии работы, команды, API или настройки. Приложите синтетический скриншот или короткую запись для заметного изменения интерфейса.
5. Откройте pull request с описанием сценария, команды проверки и результата. Если менялась схема SQLite, опишите проверку на базе предыдущей версии.

### Проверки перед pull request

```bash
npm run typecheck
npm test
npm run build
npx playwright install chromium
npm run test:e2e
```

Для изменений в Electron выполните `npm run test:desktop` в среде с доступным графическим сеансом. Команды локальной упаковки описаны в [руководстве по разработке](docs/development/README.md#desktop-packaging). Для проверки покрытия запустите `npm run test:coverage` и `npm run test:coverage:browser`.

Сохраняйте в Git исходники, тесты, фикстуры и документацию. Рабочие базы SQLite, `.env`, логи, отчёты тестов и установщики остаются локальными. При отправке кода действуют условия [MIT](LICENSE).
