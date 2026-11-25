# Source release checklist

[Русский](#публикация-исходников) · [Developer guide](README.md)

Use the exact commit intended for release. Public releases provide GitHub's source archives. Local installers and CI packages are test artifacts. Keep the optional local CA out of the source archives.

## Documentation and source tree

- [ ] Match the two README files, user and developer guides, and changelogs to the UI and commands in the candidate. Use matching screenshots and synthetic data.
- [ ] Render both README files, check links and image paths with case-sensitive file names, and review narrow and wide layouts in light and dark themes.
- [ ] Confirm the MIT license, app icon provenance, and the expected source tree. Keep local `.env`, credentials, SQLite data, CA certificates, logs, and generated results and installers out of Git.
- [ ] Agree the next version. Set `package.json` and `package-lock.json` to that version and move the pending entries in both changelogs under its heading. Use the two entries as English and Russian highlights in the release notes, alongside verification limits and the generated PR list. [English changelog](../../CHANGELOG.en.md) · [Russian changelog](../../CHANGELOG.md)

## GitHub verification

- [ ] Open a pull request to protected `main`. Check **Tests and coverage** on Linux and **Desktop checks** on Apple Silicon, Intel, and Windows x64. Review the results on the PR tip and the resulting `main` commit.
- [ ] Review native Intel PAC checks and the Windows installer smoke for the current changes. Older workflow runs document earlier releases.
- [ ] Point a new annotated `vX.Y.Z` tag at the approved `main` commit. Check that it matches the version in that commit.
- [ ] Run **Source release** from the default branch with the tag and `publish: false`. Verify that it checks both successful workflows on the tagged commit.
- [ ] After release approval, run **Source release** again with `publish: true`. Check the public release page, tag and commit, release notes, and ZIP and TAR.GZ source downloads.
- [ ] Open both published README files from the repository. Review About and Topics and check that Social Preview uses the repository artwork. [GitHub Releases](https://github.com/shanhaichik/URLPulse/releases) · [Source release workflow](../../.github/workflows/source-release.yml) · [Social Preview artwork](../media/branding/social-preview.png)

## Публикация исходников

[English](#source-release-checklist) · [Руководство разработчика](README.ru.md)

Проверяйте точный коммит выпуска. Публичные релизы содержат архивы исходников, которые формирует GitHub. Локальные установщики и сборки CI используются для тестирования. Дополнительный CA скачивается отдельно.

### Документация и состав исходников

- [ ] Сверить оба README, руководства пользователя и разработчика, а также журналы изменений с интерфейсом и командами кандидата. Использовать соответствующие языку снимки и синтетические данные.
- [ ] Отрисовать оба README, проверить ссылки и регистр путей к изображениям. Проверить узкую и широкую вёрстку в светлой и тёмной схемах.
- [ ] Проверить лицензию MIT, происхождение значка и состав исходников. Оставить локальные `.env`, секреты, базы SQLite, CA, логи, результаты тестов и сборки вне Git.
- [ ] Согласовать следующую версию. Обновить `package.json` и `package-lock.json` и перенести записи о предстоящем выпуске под номер версии в обоих журналах. Добавить их в заметки на русском и английском вместе с границами проверки и автоматически собранным списком PR. [Русский журнал](../../CHANGELOG.md) · [Английский журнал](../../CHANGELOG.en.md)

### Проверки на GitHub

- [ ] Открыть pull request в защищённую `main`. Проверить **Tests and coverage** на Linux и **Desktop checks** на Apple Silicon, Intel и Windows x64. Сверить прогоны на коммите PR и на коммите `main` после слияния.
- [ ] Проверить нативный сценарий PAC на Intel и smoke установщика Windows для текущих изменений. Прежние прогоны относятся к предыдущим выпускам.
- [ ] Поставить новый аннотированный тег `vX.Y.Z` на согласованный коммит `main`. Сверить тег с версией в этом коммите.
- [ ] Запустить **Source release** из основной ветки с тегом и `publish: false`. Убедиться, что workflow проверил оба успешных прогона на коммите тега.
- [ ] После приёмки запустить **Source release** с `publish: true`. Сверить публичную страницу, тег и коммит, заметки и скачивание ZIP и TAR.GZ с исходниками.
- [ ] Открыть обе опубликованные версии README. Сверить About и Topics, проверить изображение в Social Preview. [Релизы GitHub](https://github.com/shanhaichik/URLPulse/releases) · [Workflow публикации](../../.github/workflows/source-release.yml) · [Изображение Social Preview](../media/branding/social-preview.png)
