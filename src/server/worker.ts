import { setTimeout as wait } from 'node:timers/promises';
import { databaseBusy, type DatabaseTasks } from './database-tasks.js';
import nodemailer from 'nodemailer';
import type { PacRouteResolver } from '../shared/pac.js';
import type { ResolvedRequestOptions } from '../shared/request-profiles.js';
import type { CheckResult, TlsProfile } from '../shared/types.js';
import { checkUrl } from './checker.js';
import { createPacRouteResolver } from './pac.js';
import { configurationFailure, profileReferences, releaseRequestSecrets, resolveRequestOptions,
  type SavedRequestProfile } from './request-profiles.js';
import { envRequestSecrets, type RequestSecrets } from './request-secrets.js';
import { ApiError, type EmailJob, type Store } from './store.js';
import { createTranslator, formatLocaleNumber, parseLocale, type AppLocale } from '../shared/i18n/index.js';
import { emailMessages } from '../shared/i18n/locales/email.js';

export type SendEmail = (job: EmailJob) => Promise<void>;
export type CheckUrl = (url: string, profile: TlsProfile, signal: AbortSignal, options?: ResolvedRequestOptions,
  pac?: PacRouteResolver) => Promise<CheckResult>;

export function smtpSender(env: NodeJS.ProcessEnv, origin: string, preferred: AppLocale | (() => AppLocale) =
  parseLocale(env.PULSE_EMAIL_LOCALE)): SendEmail | undefined {
  const host = env.SMTP_HOST;
  if (!host) return undefined;
  const mode = env.SMTP_TLS_MODE || 'starttls';
  const port = Number(env.SMTP_PORT || (mode === 'tls' ? 465 : 587));
  const from = env.SMTP_FROM?.trim();
  if (!['starttls', 'tls'].includes(mode) || !Number.isInteger(port) || port < 1 || port > 65535
    || !from || Boolean(env.SMTP_USER) !== Boolean(env.SMTP_PASSWORD)) {
    throw new Error('Проверьте настройки SMTP_TLS_MODE, SMTP_PORT, SMTP_FROM, SMTP_USER и SMTP_PASSWORD.');
  }

  const transport = nodemailer.createTransport({
    host, port, secure: mode === 'tls', requireTLS: mode === 'starttls',
    auth: env.SMTP_USER ? { user: env.SMTP_USER, pass: env.SMTP_PASSWORD } : undefined,
    connectionTimeout: 10_000, greetingTimeout: 10_000, socketTimeout: 15_000,
    disableFileAccess: true, disableUrlAccess: true,
  });
  return async job => {
    const locale = parseLocale(typeof preferred === 'function' ? preferred() : preferred);
    const t = createTranslator(locale, 'email', emailMessages);
    const report = `${origin}/?project=${job.projectId}&run=${job.runId}`;
    const count = (value: number) => formatLocaleNumber(locale, value);
    await transport.sendMail({
      from, to: job.email, messageId: job.messageId, subject: t('subject', { project: job.projectName }),
      text: t('body', { report, available: count(job.available), total: count(job.total), failures: count(job.failures) }),
    });
  };
}

export async function deliverPending(store: Store, send: SendEmail, tasks?: DatabaseTasks) {
  if (!store.hasPendingEmail()) return;
  const job = await (tasks?.run('claimEmail') ?? store.claimEmail());
  if (!job) return;
  const complete = (error: string | null, retry: boolean) =>
    writeResult(() => tasks?.run('finishEmail', job, error, retry) ?? store.finishEmail(job, error, retry));
  try {
    await send(job);
  } catch (error) {
    const { responseCode, code } = error as { responseCode?: number; code?: string };
    const retry = responseCode ? responseCode >= 400 && responseCode < 500
      : !['EAUTH', 'EENVELOPE', 'EMESSAGE', 'ETLS'].includes(code ?? '');
    const label = responseCode ? ` (SMTP ${responseCode})` : '';
    await complete(`Не удалось доставить письмо${label}.`, retry);
    return;
  }
  await complete(null, false);
}

async function writeResult(action: () => void | Promise<void>) {
  for (let attempt = 0; ; attempt++) {
    try { await action(); return; }
    catch (error) {
      if ((!databaseBusy(error) && !(error instanceof ApiError && error.statusCode === 503)) || attempt >= 60) throw error;
      await wait(80);
    }
  }
}

function runChecker(check: CheckUrl, profiles: SavedRequestProfile[], secrets: RequestSecrets, pac?: PacRouteResolver) {
  const byId = new Map(profiles.map(profile => [profile.id, profile]));
  const defaults = new Map(profiles.filter(profile => profile.isDefault).map(profile => [profile.origin, profile]));
  const resolved = new Map<number, Promise<ResolvedRequestOptions | undefined>>();
  return async (url: string, choice: number | null, tls: TlsProfile, signal: AbortSignal): Promise<CheckResult> => {
    if (choice === 0) {
      const result = await check(url, tls, signal);
      return pac ? { ...result, requestRoute: 'direct' } : result;
    }
    if (choice === null && defaults.size === 0) return check(url, tls, signal, undefined, pac);
    const origin = new URL(url).origin;
    const profile = choice === null ? defaults.get(origin) : byId.get(choice);
    if (choice !== null && (!profile || profile.origin !== origin)) {
      return configurationFailure(url, profile, 'Назначенный профиль запроса недоступен для этого сервера.');
    }
    if (!profile) return check(url, tls, signal, undefined, pac);
    if (!resolved.has(profile.id)) resolved.set(profile.id, resolveRequestOptions(profile, secrets, signal).catch(() => undefined));
    const options = await resolved.get(profile.id);
    if (!options) return configurationFailure(url, profile);
    if (signal.aborted) return configurationFailure(url, profile);
    return check(url, tls, signal, options, options.proxy ? undefined : pac);
  };
}

async function processRun(store: Store, check: CheckUrl, secrets: RequestSecrets, stopped: () => boolean, track: (runId: number) => AbortSignal,
  schedulesEnabled: () => boolean, getSend: () => SendEmail | undefined, tasks?: DatabaseTasks) {
  const allowSchedule = schedulesEnabled();
  if (!store.hasQueued(allowSchedule)) return;
  const run = await (tasks?.run('claim', allowSchedule) ?? store.claim(allowSchedule));
  if (!run) return;
  const signal = track(run.id);
  const canCheck = () => !stopped() && !signal.aborted;
  const requeue = () => tasks?.run('requeue', run.id) ?? store.requeue(run.id);
  let profiles: SavedRequestProfile[] = [];
  try {
    if (run.source === 'schedule' && !schedulesEnabled()) {
      await writeResult(requeue);
      return;
    }
    profiles = store.requestSnapshot(run.id);
    const config = store.pacSnapshot(run.id);
    const checkItem = runChecker(check, profiles, secrets, config ? createPacRouteResolver(config.source) : undefined);
    let batch = run.items;
    while (canCheck() && batch.length) {
      const items = batch;
      let next = 0;
      const settled = await Promise.allSettled(Array.from({ length: Math.min(run.checkConcurrency, items.length) }, async () => {
        while (canCheck() && next < items.length) {
          const item = items[next++];
          let result: CheckResult;
          try {
            result = await checkItem(item.url, item.profileChoice, run.tlsProfile, signal);
          } catch {
            result = { status: 'error', httpCode: null, durationMs: 0, finalUrl: item.url,
              redirects: 0, contentType: null, contentLength: null, errorKind: 'connection',
              error: 'Не удалось выполнить проверку.' };
          }
          if (signal.aborted) return;
          await writeResult(() => tasks?.run('saveResult', item.id, result, run.id) ?? store.saveResult(item.id, result, run.id));
        }
      }));
      const failure = settled.find(outcome => outcome.status === 'rejected');
      if (failure?.status === 'rejected') throw failure.reason;
      if (canCheck()) batch = store.pendingResults(run.id);
    }
    if (signal.aborted) return;
    if (stopped()) await writeResult(requeue);
    else await writeResult(() => {
      const emailEnabled = !!getSend();
      return tasks?.run('finish', run.id, emailEnabled) ?? store.finish(run.id, emailEnabled);
    });
  } catch (error) {
    await writeResult(requeue);
    throw error;
  } finally {
    await releaseRequestSecrets(store, secrets, profiles.flatMap(profileReferences));
  }
}

export function startBackground(store: Store, {
  check = (url, tlsProfile, signal, requestOptions, pac) => checkUrl(url, { tlsProfile, signal, requestOptions, pac }),
  tasks, send, getSend = () => send, schedulesEnabled = () => true, reportError = console.error,
  requestSecrets = envRequestSecrets(),
}: {
  check?: CheckUrl; tasks?: DatabaseTasks; send?: SendEmail; getSend?: () => SendEmail | undefined;
  schedulesEnabled?: () => boolean; reportError?: (error: unknown) => void;
  requestSecrets?: RequestSecrets;
} = {}) {
  let stopped = false;
  let checking: Promise<void> | undefined;
  let sending: Promise<void> | undefined;
  let scheduling: Promise<void> | undefined;
  let active: { runId: number; controller: AbortController } | undefined;
  const track = (runId: number) => {
    active = { runId, controller: new AbortController() };
    return active.controller.signal;
  };
  const tick = () => {
    const send = getSend();
    if (!scheduling && schedulesEnabled() && store.hasDue()) {
      scheduling = (tasks?.run('schedule') ?? Promise.resolve().then(() => store.enqueueDue()))
        .catch(reportError).finally(() => { scheduling = undefined; });
    }
    checking ??= processRun(store, check, requestSecrets, () => stopped, track, schedulesEnabled, getSend, tasks)
      .catch(reportError).finally(() => { active = undefined; checking = undefined; });
    if (send) sending ??= deliverPending(store, send, tasks).catch(reportError).finally(() => { sending = undefined; });
  };
  const interval = setInterval(tick, 750);
  tick();
  const close = async () => {
    stopped = true;
    clearInterval(interval);
    await Promise.all([checking, sending, scheduling]);
  };
  return Object.assign(close, {
    cancelRun(runId: number) { if (active?.runId === runId) active.controller.abort(); },
  });
}
