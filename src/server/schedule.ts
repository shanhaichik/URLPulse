import { Temporal } from '@js-temporal/polyfill';
import type { Schedule } from '../shared/types.js';

export function nextOccurrence(schedule: Schedule, after: number): number {
  const local = Temporal.Instant.fromEpochMilliseconds(after).toZonedDateTimeISO(schedule.timezone);
  const time = Temporal.PlainTime.from(schedule.time);
  for (let offset = 0; offset <= 7; offset++) {
    const date = local.toPlainDate().add({ days: offset });
    if (!schedule.weekdays.includes(date.dayOfWeek)) continue;
    const instant = date.toPlainDateTime(time).toZonedDateTime(schedule.timezone).epochMilliseconds;
    if (instant > after) return instant;
  }
  throw new Error('Укажите хотя бы один действительный день недели.');
}
