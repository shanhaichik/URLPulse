export const emailMessages = {
  subject: { ru: 'Пульс URL · {{project}}', en: 'URLPulse · {{project}}' },
  body: {
    ru: 'Проверка завершена.\nДоступно: {{available}} из {{total}}.\nС ошибками: {{failures}}.\n\nОтчёт на компьютере с запущенным Пульсом URL: {{report}}',
    en: 'Run completed.\nAvailable: {{available}} of {{total}}.\nFailed: {{failures}}.\n\nOpen the report on the computer running URLPulse: {{report}}',
  },
} as const;
