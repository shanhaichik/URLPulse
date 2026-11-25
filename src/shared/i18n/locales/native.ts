import { createTranslator, type AppLocale, type Catalog } from '../index.js';
import { BACKUP_RUN_INTEGRITY_PREFIX, BACKUP_RUN_INTEGRITY_PREFIX_EN, DESKTOP_SHUTDOWN } from '../../desktop.js';

export const native = {
  title: { ru: 'Пульс URL', en: 'Pulse URL' },
  startFailed: { ru: 'Не удалось запустить приложение. {{detail}}', en: 'Could not start the application. {{detail}}' },
  mainWindowRequired: { ru: 'Операция доступна из главного окна приложения.', en: 'This action is available from the main application window.' },
  shuttingDown: { ru: DESKTOP_SHUTDOWN.data.error, en: 'The application is shutting down.' },
  fileBusy: { ru: 'Дождитесь завершения текущей операции с файлом.', en: 'Wait for the current file operation to finish.' },
  saveLog: { ru: 'Не удалось записать файл выгрузки', en: 'Could not write the export file' },
  writeDenied: { ru: 'Нет прав на запись. Выберите другое место для сохранения.', en: 'You do not have write permission. Choose another location.' },
  diskFull: { ru: 'Не хватает места. Выберите другой диск или освободите место.', en: 'There is not enough space. Choose another drive or free up space.' },
  writeFailed: {
    ru: 'Не удалось сохранить файл по выбранному пути. Выберите другой файл или папку.',
    en: 'Could not save to the selected path. Choose another file or folder.',
  },
  excelCsv: { ru: 'CSV для Excel', en: 'CSV for Excel' },
  exportBackup: { ru: 'Экспорт резервной копии', en: 'Export backup' },
  restoreBackup: { ru: 'Восстановление резервной копии', en: 'Restore backup' },
  exportBackupMenu: { ru: 'Экспорт резервной копии…', en: 'Export Backup…' },
  restoreBackupMenu: { ru: 'Восстановить резервную копию…', en: 'Restore Backup…' },
  sqliteFile: { ru: 'База SQLite', en: 'SQLite database' },
  replaceDatabase: { ru: 'Заменить текущую базу?', en: 'Replace the current database?' },
  replaceDatabaseDetail: {
    ru: 'Текущая база будет сохранена в резервную копию. После перезапуска расписания будут приостановлены. Незавершённые проверки из копии не продолжатся. Уже полученные результаты сохранятся.',
    en: 'The current database will be backed up. Scheduled checks will be paused after restart. Unfinished checks from the backup will stop, and their existing results will be preserved.',
  },
  cancel: { ru: 'Отмена', en: 'Cancel' },
  restore: { ru: 'Восстановить', en: 'Restore' },
  restoreFailed: { ru: 'Не удалось восстановить резервную копию', en: 'Could not restore the backup' },
  databaseAction: { ru: 'Операция с базой Пульса URL', en: 'Pulse URL database operation' },
  invalidAddress: { ru: 'Недопустимый адрес.', en: 'Invalid address.' },
  exportReport: { ru: 'Экспорт отчёта', en: 'Export report' },
  exportComparison: { ru: 'Экспорт сравнения', en: 'Export comparison' },
  importSitemap: { ru: 'Импорт sitemap', en: 'Import sitemap' },
  sitemapFiles: { ru: 'Sitemap XML или GZIP', en: 'Sitemap XML or GZIP' },
  exportSitemap: { ru: 'Экспорт каталога sitemap', en: 'Export sitemap catalog' },
  preferencesBusy: { ru: 'Сохранение настроек уже выполняется.', en: 'Preferences are already being saved.' },
  open: { ru: 'Открыть Пульс URL', en: 'Open Pulse URL' },
  quit: { ru: 'Выход', en: 'Quit' },
  language: { ru: 'Язык', en: 'Language' },
  russian: { ru: 'Русский', en: 'Русский' },
  english: { ru: 'English', en: 'English' },
  chooseLocale: { ru: 'Выберите русский или английский язык.', en: 'Choose Russian or English.' },
  localeSaveFailed: { ru: 'Не удалось сохранить язык приложения.', en: 'Could not save the application language.' },
  edit: { ru: 'Правка', en: 'Edit' },
  undo: { ru: 'Отменить', en: 'Undo' },
  redo: { ru: 'Повторить', en: 'Redo' },
  cut: { ru: 'Вырезать', en: 'Cut' },
  copy: { ru: 'Копировать', en: 'Copy' },
  paste: { ru: 'Вставить', en: 'Paste' },
  pasteAndMatchStyle: { ru: 'Вставить и согласовать стиль', en: 'Paste and Match Style' },
  delete: { ru: 'Удалить', en: 'Delete' },
  selectAll: { ru: 'Выбрать всё', en: 'Select All' },
  speech: { ru: 'Речь', en: 'Speech' },
  startSpeaking: { ru: 'Начать произнесение', en: 'Start Speaking' },
  stopSpeaking: { ru: 'Остановить произнесение', en: 'Stop Speaking' },
  invalidSmtpAddress: {
    ru: 'Укажите действительные SMTP-хост и адрес отправителя.',
    en: 'Enter a valid SMTP host and sender address.',
  },
  invalidSmtpFields: { ru: 'Проверьте параметры SMTP.', en: 'Check the SMTP settings.' },
  invalidSmtpConfiguration: {
    ru: 'Проверьте настройки SMTP_TLS_MODE, SMTP_PORT, SMTP_FROM, SMTP_USER и SMTP_PASSWORD.',
    en: 'Check the SMTP_TLS_MODE, SMTP_PORT, SMTP_FROM, SMTP_USER, and SMTP_PASSWORD settings.',
  },
  readPreferencesFailed: { ru: 'Не удалось прочитать настройки desktop.', en: 'Could not read desktop preferences.' },
  invalidBackgroundSettings: { ru: 'Проверьте параметры фоновой работы.', en: 'Check the background settings.' },
  loginItemFailed: {
    ru: 'Не удалось изменить автозапуск. Проверьте параметры автозапуска системы и повторите попытку.',
    en: 'Could not change startup behavior. Check your system login settings and try again.',
  },
  invalidPreferences: { ru: 'Проверьте параметры приложения.', en: 'Check the application preferences.' },
  unavailableSmtpSettings: {
    ru: 'Сохранённые параметры SMTP недоступны. Запустите приложение заново, чтобы повторить чтение.',
    en: 'The saved SMTP settings are unavailable. Restart the application to try again.',
  },
  unavailableSecretStore: {
    ru: 'Хранилище секретов операционной системы недоступно.',
    en: 'The operating system credential store is unavailable.',
  },
  enterSecret: {
    ru: 'Введите значение секрета для настольного приложения.',
    en: 'Enter a secret value for the desktop application.',
  },
  removeSecretFailed: {
    ru: 'Не удалось удалить секрет из хранилища.',
    en: 'Could not remove the secret from the credential store.',
  },
  invalidDesktopOperation: { ru: 'Недопустимая операция приложения.', en: 'Invalid application operation.' },
  invalidReportAddress: { ru: 'Недопустимый адрес отчёта.', en: 'Invalid report address.' },
  selectSeparateDatabase: {
    ru: 'Выберите файл, отличный от активной базы.',
    en: 'Choose a different file from the active database.',
  },
  backupRunIntegrity: {
    ru: `${BACKUP_RUN_INTEGRITY_PREFIX}{{runId}}.`,
    en: `${BACKUP_RUN_INTEGRITY_PREFIX_EN}{{runId}}.`,
  },
  backupImportFailed: {
    ru: 'Не удалось восстановить базу Пульса URL из выбранного файла.',
    en: 'Could not restore the Pulse URL database from the selected file.',
  },
} satisfies Catalog;

const russian = createTranslator('ru-RU', 'native', native);
const english = createTranslator('en-US', 'native', native);

export function nativeTranslator(locale: AppLocale) {
  return locale === 'en-US' ? english : russian;
}
