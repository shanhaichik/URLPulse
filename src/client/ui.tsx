import { useId, useLayoutEffect, useRef, useState, type ComponentProps, type ReactNode } from 'react';
import { AlertCircle, ArrowUpRight, Check, ChevronDown, Clock3, Download, LoaderCircle, Play, RotateCcw, Square, X } from 'lucide-react';
import { reportParams, type ReportFilters, type RunRestart, type StoppedRunResponse } from '../shared/reports.js';
import type { ExportFormat } from '../shared/desktop.js';
import { api, base, useTask, write } from './api.js';
import type { Result, Run } from '../shared/types.js';

const dateFormatter = new Intl.DateTimeFormat('ru-RU', {
  day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', year: 'numeric', timeZone: 'Europe/Moscow',
});

export function date(value?: string | null, timezone?: string) {
  if (!value) return '—';
  const formatter = timezone && timezone !== 'Europe/Moscow'
    ? new Intl.DateTimeFormat('ru-RU', {
      day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', year: 'numeric', timeZone: timezone,
    }) : dateFormatter;
  return formatter.format(new Date(value));
}

export function formatNumber(value: number) { return new Intl.NumberFormat('ru-RU').format(value); }

export function ErrorMessage({ text }: { text?: string }) {
  return text ? <p className="error-message" role="alert"><AlertCircle size={17} />{text}</p> : null;
}

export function FilterSelect(props: ComponentProps<'select'>) {
  return <span className="filter-select">
    <select {...props} className="status-filter" />
    <ChevronDown className="filter-select-arrow" size={14} aria-hidden="true" />
  </span>;
}

export function Loading() {
  return <div className="loading" role="status"><LoaderCircle className="spin" size={18} /> Загрузка…</div>;
}

export function Status({ result }: { result?: Pick<Result, 'status'> & Partial<Pick<Result, 'accessHint' | 'failureStage' | 'proxyHttpCode'>> | null }) {
  if (result?.failureStage === 'proxy' && result.proxyHttpCode === 407) {
    return <span className="status bad"><AlertCircle size={13} /> Ошибка авторизации прокси</span>;
  }
  if (result?.accessHint === 'curator-challenge') {
    return <span className="status waiting"><AlertCircle size={13} /> Проверка Curator</span>;
  }
  if (result?.status === 'ok') return <span className="status ok"><Check size={13} /> Доступен</span>;
  if (result?.status === 'error') return <span className="status bad"><AlertCircle size={13} /> Ошибка</span>;
  if (result?.status === 'pending') return <span className="status waiting"><Clock3 size={13} /> В очереди</span>;
  return <span className="status neutral"><span className="status-dot" /> Не проверен</span>;
}

export function RunStatus({ run }: { run: Run }) {
  if (run.status === 'done') return <span className="status ok"><Check size={13} /> Завершён</span>;
  if (run.status === 'cancelled') return <span className="status neutral"><Square size={13} /> Остановлена</span>;
  return <span className="status waiting"><Clock3 size={13} />{run.status === 'running' ? 'Выполняется' : 'В очереди'}</span>;
}

export function StopRunButton({ run, stopped }: { run: Run; stopped: (result: StoppedRunResponse) => void }) {
  const task = useTask();
  return <>
    <button type="button" className="button small secondary danger-ghost" disabled={task.busy}
      onClick={() => void task.run(async () => {
        const result = await api<StoppedRunResponse>(`${base(run.projectId)}/runs/${run.id}/stop`, { method: 'POST' });
        stopped(result);
      })}>
      <Square size={14} /> {task.busy ? 'Останавливаем…' : 'Остановить проверку'}
    </button>
    <ErrorMessage text={task.error} />
  </>;
}

export type RunAccepted = (projectId: number, runId: number) => void;

export function StartRunButton({ projectId, addressId, restart, accepted, openReport }: {
  projectId: number; addressId?: number; restart?: RunRestart; accepted: RunAccepted; openReport?: (id: number) => void;
}) {
  const task = useTask();
  const [newRun, setNewRun] = useState<number>();
  if (openReport && newRun !== undefined) return <button type="button" className="button small primary" onClick={() => openReport(newRun)}>
    Открыть новый отчёт <ArrowUpRight size={15} />
  </button>;
  const path = base(projectId) + '/runs';
  const label = restart ? restart.canRestart ? 'Запустить заново' : 'Проверить весь проект заново' : 'Проверить этот URL';
  return <>
    <button type="button" className="button small primary" disabled={task.busy} onClick={() => void task.run(async () => {
      const run = restart?.canRestart ? await api<{ id: number }>(`${path}/${restart.id}/restart`, { method: 'POST' })
        : await write<{ id: number }>(path, 'POST', addressId === undefined ? {} : { ids: [addressId] });
      setNewRun(run.id);
      accepted(projectId, run.id);
    })}>
      {restart ? <RotateCcw size={15} /> : <Play size={15} />}{task.busy ? 'Запускаем…' : label}
    </button>
    <ErrorMessage text={task.error} />
  </>;
}

export const exportOptions = [
  { format: 'csv', label: 'CSV' }, { format: 'excel', label: 'CSV для Excel' }, { format: 'json', label: 'JSON' },
] as const;

function ExportButton({ path, format, label, className, close, filters }: {
  path: string; format: ExportFormat; label: string; className?: string; close?: () => void; filters?: ReportFilters;
}) {
  const bridge = window.pulseDesktop;
  const task = useTask();
  if (!bridge) {
    const params = reportParams(filters);
    params.set('format', format);
    return <a className={className} href={path + '/export?' + params} onClick={close}>{label}</a>;
  }
  return <>
    <button type="button" className={className} disabled={task.busy} onClick={() => {
      void task.run(async () => {
        const result = await bridge.exportReport(path, format, filters);
        if (result.saved) close?.();
        else if (result.error) throw new Error(result.error);
      });
    }}>{label}</button>
    <ErrorMessage text={task.error} />
  </>;
}

export function ExportLinks({ path, filters }: { path: string; filters?: ReportFilters }) {
  return <div className="export-links" aria-label="Форматы экспорта">
    {exportOptions.map(({ format, label }) => <ExportButton key={format} className="button small secondary"
      path={path} format={format} label={label} filters={filters} />)}
  </div>;
}

export function ExportMenu({ path, label = 'Экспорт' }: { path: string; label?: string }) {
  const menu = useRef<HTMLDetailsElement>(null);
  return <details className="export-menu" ref={menu}>
    <summary className="button secondary"><Download size={16} /> {label} <ChevronDown size={14} /></summary>
    <div className="menu-items">
      {exportOptions.map(({ format, label }) => <ExportButton key={format} path={path} format={format}
        label={`Скачать ${label}`} close={() => { if (menu.current) menu.current.open = false; }} />)}
    </div>
  </details>;
}

export function Modal({ title, caption, close, children, wide = false, fallbackFocus, headerAction, closeDisabled }: {
  title: string; caption?: string; close: () => void; children: ReactNode; wide?: boolean; fallbackFocus?: () => HTMLElement | null;
  headerAction?: ReactNode; closeDisabled?: boolean;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const heading = useId();
  useLayoutEffect(() => {
    const origin = document.activeElement;
    const dialog = ref.current;
    dialog?.showModal();
    dialog?.querySelector<HTMLElement>('[data-initial-focus]')?.focus();
    return () => {
      dialog?.close();
      const target = origin instanceof HTMLElement && origin !== document.body && origin.isConnected ? origin : fallbackFocus?.();
      target?.focus({ preventScroll: true });
    };
  }, []);
  return <dialog ref={ref} className={wide ? 'modal wide' : 'modal'} aria-labelledby={heading}
    onCancel={event => { event.preventDefault(); close(); }}>
    <div className={headerAction ? 'modal-header modal-header-sticky' : 'modal-header'}>
      <div className="modal-header-main">
        <div><h2 id={heading}>{title}</h2>{caption && <p>{caption}</p>}</div>
        {headerAction && <div>{headerAction}</div>}
      </div>
      <button className="button icon ghost" aria-label="Закрыть" onClick={close} disabled={closeDisabled}><X size={20} /></button>
    </div>
    {children}
  </dialog>;
}

export function Empty({ icon, title, text, action }: { icon: ReactNode; title: string; text: string; action?: ReactNode }) {
  return <div className="empty">
    <div className="empty-icon">{icon}</div>
    <h3>{title}</h3>
    <p>{text}</p>
    {action}
  </div>;
}
