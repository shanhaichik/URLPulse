import { useCallback, useEffect, useRef, useState } from 'react';
import {
  Activity, ArrowRight, Bell, CalendarClock, Check, ChevronRight, CircleAlert,
  Clock3, Folder, FolderPlus, Globe2, History, Link2, ListTree, Pencil, Play, Plus, Settings2, Signal, Trash2,
} from 'lucide-react';
import type { RunRestart, StoppedRunResponse } from '../shared/reports.js';
import type { AddressRow, Project, Run } from '../shared/types.js';
import { AddressList } from './addresses.js';
import { api, base, type ProjectView, useQuery, useTask, type Workspace, write } from './api.js';
import { CatalogView } from './catalog.js';
import { DesktopSettings, useBackupPhase, useBackupProgress } from './desktop.js';
import { ConfirmDeletion, DeleteForm, EditForm, ImportForm, ProjectForm, SettingsForm } from './forms.js';
import { RequestProfileSettings } from './request-profiles.js';
import { readRoute, routeSearch, type Tab, type WorkspaceRoute } from './navigation.js';
import { RunComparison } from './run-comparison.js';
import { AddressReport, Notifications, RunList, RunReport } from './reports.js';
import { date, Empty, ErrorMessage, ExportMenu, formatNumber, LanguageSelect, Loading, StartRunButton, StopRunButton, type RunAccepted } from './ui.js';

import { workspaceMessages } from '../shared/i18n/locales/workspace.js';
import { createMessages } from './i18n.js';

const useText = createMessages('workspace', workspaceMessages);

type Dialog =
  | { type: 'project' | 'rename-project' | 'delete-project' | 'desktop' | 'import' }
  | { type: 'edit'; address: AddressRow }
  | { type: 'delete'; ids: number[]; filters: string };

const tabs = [
  { id: 'urls', icon: Link2 },
  { id: 'catalog', icon: ListTree },
  { id: 'runs', icon: History },
  { id: 'settings', icon: Settings2 },
] as const;

const statCards = [
  { key: 'total', icon: Globe2, color: 'violet' },
  { key: 'available', icon: Check, color: 'green' },
  { key: 'failures', icon: CircleAlert, color: 'orange' },
  { key: 'unchecked', icon: Clock3, color: 'blue' },
] as const;

function Sidebar({ projects, current, addProject, select }: {
  projects: Project[]; current?: number; addProject: () => void; select: (id: number) => void;
}) {
  const t = useText();
  return <aside className="sidebar">
    <div className="brand"><img className="brand-mark" src="/pulse-icon.png" alt="" width={39} height={39} />
      <div><strong>{t('brand')}</strong><small>{t('tagline')}</small></div></div>
    <div className="sidebar-body">
      <div className="sidebar-label">{t('projects')}</div>
      <button className="new-project" onClick={addProject}><Plus size={18} /> {t('newProject')}</button>
      <nav aria-label={t('projects')} className="project-nav">
        {projects.map(project => <button key={project.id} className={current === project.id ? 'current' : ''}
          aria-current={current === project.id ? 'page' : undefined} onClick={() => select(project.id)}>
          <Folder size={17} /><span title={project.name}>{project.name}</span><small>{formatNumber(project.urlCount)}</small>
        </button>)}
      </nav>
    </div>
    <div className="sidebar-footer">
      <span><span className="live-dot" /> {t('local')}</span>
      <small>{t('scheduleHint')}</small>
    </div>
  </aside>;
}

function Welcome({ open }: { open: () => void }) {
  const t = useText();
  return <div className="welcome">
    <div className="welcome-content">
      <span className="section-icon violet"><FolderPlus size={22} /></span>
      <h1>{t('welcomeTitle')}</h1>
      <p>{t('welcomeHelp')}</p>
      <button className="button primary" onClick={open}><Plus size={18} /> {t('newProject')} <ArrowRight size={16} /></button>
    </div>
    <div className="welcome-art" aria-hidden="true">
      <div className="radar radar-outer" /><div className="radar radar-middle" /><div className="radar radar-inner" />
      <div className="radar-mark"><Activity size={64} strokeWidth={1.6} /></div>
      <i className="radar-dot dot-a" /><i className="radar-dot dot-b" /><i className="radar-dot dot-c" />
    </div>
  </div>;
}

function Metrics({ summary }: { summary: ProjectView['summary'] }) {
  const t = useText();
  return <section aria-label={t('summary')} className="project-metrics">
    <h2>{t('summary')}</h2>
    <div className="metrics">
    {statCards.map(({ key, icon: Icon, color }) => <article className="metric panel" key={key}>
      <div><p>{t(key)}</p><strong>{formatNumber(summary[key])}</strong></div>
      <span className={`section-icon ${color}`}><Icon size={20} /></span>
    </article>)}
    </div>
  </section>;
}

function Progress({ run, paused, open, stopped }: { run: Run; paused: boolean; open: () => void; stopped: (run: StoppedRunResponse) => void }) {
  const t = useText();
  return <div className="progress-bar">
    <div role="status"><span className="live-dot" />
      <strong>{t(run.status === 'running' ? 'running' : paused ? 'paused' : 'queued')}</strong>
      <span className="mono">{t('runNumber', { id: run.id })}</span>{run.group && <span>· {run.group.name}</span>}<span>{t('runProgress', { completed: formatNumber(run.completed), total: formatNumber(run.total) })}</span></div>
    <progress max={run.total || 1} value={run.completed} aria-label={t('checkProgress')} />
    <div>
      <StopRunButton key={run.id} run={run} stopped={stopped} />
      <button className="button small secondary" onClick={open}>{t('openReport')} <ChevronRight size={15} /></button>
    </div>
  </div>;
}

function RunQueue({ runs, schedulesPaused, open, stopped }: {
  runs: Run[]; schedulesPaused: boolean; open: (id: number) => void; stopped: (run: StoppedRunResponse) => void;
}) {
  const t = useText();
  if (!runs.length) return null;
  return <section className="panel run-queue" aria-label={t('queue')}>
    <h2>{t('queue')}</h2>
    <ul>
      {runs.map(run => <li key={run.id}>
        <div role="status"><strong>{t('runLabel', { id: run.id })}</strong> {run.group && `· ${run.group.name} `}· {formatNumber(run.total)} URL
          {schedulesPaused && run.source === 'schedule' && <> · {t('paused')}</>}</div>
        <div className="run-queue-actions">
          <StopRunButton run={run} stopped={stopped} />
          <button className="button small secondary" onClick={() => open(run.id)}>{t('openReport')} <ChevronRight size={15} /></button>
        </div>
      </li>)}
    </ul>
  </section>;
}

function StoppedRun({ projectId, restart, open, accepted }: {
  projectId: number; restart: RunRestart; open: () => void; accepted: RunAccepted;
}) {
  const t = useText();
  return <section className="queued stopped-run" aria-label={t('stoppedRun')}>
    <div>
      <strong role="status">{t('stopped', { id: restart.id })}</strong>
      <p>{t('checked', { completed: formatNumber(restart.completed), total: formatNumber(restart.total) })} {t(restart.canRestart ? 'restartHint' : 'restartUnavailable')}</p>
    </div>
    <div className="stopped-run-actions">
      <StartRunButton key={restart.id} projectId={projectId} restart={restart} accepted={accepted} />
      <button type="button" className="button small secondary" onClick={open}>{t('openReport')} <ChevronRight size={15} /></button>
    </div>
  </section>;
}

type HistoryEntry = { pulseIndex: number; closeWithBack?: boolean };
const historyEntry = (): HistoryEntry | null => window.history.state;
const projectPoll = (view?: ProjectView) => view?.activeRun ? 1000 : 4000;
const projectRevision = (view: ProjectView) => view.revision;

export default function App() {
  const t = useText();
  const workspace = useQuery<Workspace>('/api/projects', 3000);
  const backupPhase = useBackupPhase();
  const backupProgress = useBackupProgress(backupPhase);
  const [route, setRoute] = useState(() => readRoute(window.location.search));
  const routeRef = useRef(route);
  const [dialog, updateDialog] = useState<Dialog | null>(null);
  const dialogRef = useRef(dialog);
  const index = useRef(historyEntry()?.pulseIndex ?? 0);
  const restoringHistory = useRef(false);
  const desktopLeaveGuard = useRef<() => boolean>(undefined);
  const projectLeaveGuard = useRef<() => boolean>(undefined);
  const registerDesktopLeaveGuard = useCallback((guard: (() => boolean) | undefined) => { desktopLeaveGuard.current = guard; }, []);
  const registerProjectLeaveGuard = useCallback((guard: (() => boolean) | undefined) => { projectLeaveGuard.current = guard; }, []);
  const [createdProject, setCreatedProject] = useState<Project>();
  const [acknowledgement, setAcknowledgement] = useState<{
    projectId: number; runId: number; kind: 'accepted' | 'stop'; stopped?: boolean; restart?: RunRestart;
  }>();
  const [deletedAddresses, setDeletedAddresses] = useState<{ projectId: number; ids: number[] }>();
  const [journalRevision, setJournalRevision] = useState(0);
  const { project: projectId, tab } = route;
  const projects = workspace.data?.projects ?? [];
  const selected = projectId === undefined ? projects[0] : projects.find(project => project.id === projectId)
    ?? (createdProject?.id === projectId ? createdProject : undefined);
  const missingProject = workspace.data && projectId !== undefined && !selected;
  const detail = useQuery<ProjectView>(selected ? base(selected.id) + '?view=summary' : null, projectPoll, projectRevision);
  const activeRun = detail.data?.activeRun;
  const queue = useQuery<Run[]>(activeRun ? base(activeRun.projectId) + '/runs?view=queue' : null, 2400);
  const project = detail.data?.project ?? selected;
  const schedulesPaused = !!workspace.data?.schedulesPaused;
  const task = useTask();

  const setDialog = useCallback((next: Dialog | null) => {
    dialogRef.current = next;
    updateDialog(next);
  }, []);
  const canLeave = useCallback((next: WorkspaceRoute) => {
    if (desktopLeaveGuard.current?.() === false) return false;
    const current = routeRef.current;
    return (current.project === next.project && current.tab === next.tab) || (projectLeaveGuard.current?.() ?? true);
  }, []);
  const commitRoute = useCallback((next: WorkspaceRoute) => {
    routeRef.current = next;
    setDialog(null);
    setRoute(next);
  }, [setDialog]);
  const navigate = useCallback((next: WorkspaceRoute, mode: 'push' | 'replace' | 'overlay' = 'push', guard = true) => {
    const search = routeSearch(next);
    if (search === window.location.search || (guard && !canLeave(next))) return;
    const entry: HistoryEntry = mode === 'replace' ? { ...historyEntry(), pulseIndex: index.current }
      : { pulseIndex: ++index.current, closeWithBack: mode === 'overlay' };
    const method = mode === 'replace' ? 'replaceState' : 'pushState';
    window.history[method](entry, '', search || window.location.pathname);
    commitRoute(next);
  }, [canLeave, commitRoute]);

  useEffect(() => {
    window.history.replaceState({ ...historyEntry(), pulseIndex: index.current }, '');
    function onPop(event: PopStateEvent) {
      const nextIndex = (event.state as HistoryEntry | null)?.pulseIndex ?? 0;
      const next = readRoute(window.location.search);
      if (!restoringHistory.current && !canLeave(next)) {
        if (index.current !== nextIndex) {
          restoringHistory.current = true;
          window.history.go(index.current - nextIndex);
        }
        return;
      }
      restoringHistory.current = false;
      index.current = nextIndex;
      commitRoute(next);
    }
    window.addEventListener('popstate', onPop);
    const unsubscribe = window.pulseDesktop?.onNavigate?.(path => {
      const { search } = new URL(path, window.location.href);
      navigate(readRoute(search));
    });
    return () => { window.removeEventListener('popstate', onPop); unsubscribe?.(); };
  }, [canLeave, commitRoute, navigate]);

  useEffect(() => {
    if (createdProject && projects.some(entry => entry.id === createdProject.id)) setCreatedProject(undefined);
  }, [createdProject, projects]);

  function change() { workspace.refresh(); detail.refresh(); queue.refresh(); }

  function select(id?: number) {
    navigate({ project: id, tab: 'urls' });
    setAcknowledgement(undefined);
    task.clear();
  }

  function setTab(next: Tab) { navigate({ project: project?.id ?? projectId, tab: next }); }

  function openRun(id: number) {
    if (project) navigate({ ...route, project: project.id, run: id, filters: undefined }, route.run ? 'replace' : 'overlay');
  }

  function openComparison(baseline?: number, target?: number) {
    if (project) navigate({ ...route, project: project.id, comparison: { baseline, target } }, 'overlay');
  }

  function closeOverlay() {
    if (historyEntry()?.closeWithBack) window.history.back();
    else if (route.comparison) navigate({ ...route, comparison: undefined }, 'replace', false);
    else navigate(route.run ? { ...route, run: undefined, filters: undefined, notification: undefined }
      : { ...route, address: undefined }, 'replace', false);
  }
  function closeDialog() { setDialog(null); }

  function runAccepted(projectId: number, runId: number) {
    setAcknowledgement({ projectId, runId, kind: 'accepted' });
    setJournalRevision(revision => revision + 1);
    change();
  }

  function start(ids?: number[], groupId?: number) {
    if (!project) return;
    void task.run(async () => {
      const path = base(project.id) + (groupId === undefined ? '/runs' : `/groups/${groupId}/runs`);
      const run = await write<{ id: number }>(path, 'POST', ids ? { ids } : {});
      runAccepted(project.id, run.id);
    });
  }

  function runStopped(run: StoppedRunResponse) {
    setAcknowledgement(previous => previous && previous.projectId !== run.projectId
      ? previous : { projectId: run.projectId, runId: run.id, stopped: run.status === 'cancelled', kind: 'stop', restart: run.restart ?? undefined });
    setJournalRevision(revision => revision + 1);
    change();
  }

  const addProject = () => { if (canLeave({ tab: 'urls' })) setDialog({ type: 'project' }); };
  const importUrls = () => setDialog({ type: 'import' });
  const inspect = (id: number) => navigate({ ...route, project: project?.id, address: id }, 'overlay');
  const waiting = queue.data?.filter(run => run.id !== activeRun?.id) ?? [];
  const feedback = acknowledgement && acknowledgement.projectId === project?.id
    && (acknowledgement.kind === 'stop' || (activeRun?.id !== acknowledgement.runId
      && !waiting.some(run => run.id === acknowledgement.runId))) ? acknowledgement : undefined;
  const restart = tab === 'urls' && (feedback?.restart ?? (!feedback && !activeRun && project?.urlCount ? detail.data?.lastStoppedRun : undefined));

  return <div className="app-shell">
    <Sidebar projects={projects} current={project?.id} addProject={addProject} select={select} />
    <div className="workspace">
      <header className="topbar">
        <div className="breadcrumb"><span>{t('projects')}</span>
          {project && <><ChevronRight size={15} /><strong>{project.name}</strong></>}
        </div>
        <div className="topbar-actions">
        <LanguageSelect />
        {window.pulseDesktop && <button className="button icon secondary" title={t('desktopSettings')} aria-label={t('desktopSettings')}
          onClick={() => setDialog({ type: 'desktop' })}><Settings2 size={17} /></button>}
        <button className={`button secondary notifications-toggle ${tab === 'notifications' ? 'active' : ''}`}
          aria-label={t('notifications')} aria-pressed={tab === 'notifications'}
          onClick={() => setTab(tab === 'notifications' ? 'urls' : 'notifications')}>
          <Bell size={17} /> <span>{t('notifications')}</span>
          {!!workspace.data?.unread && <span className="notification-count">{workspace.data.unread > 99 ? '99+' : workspace.data.unread}</span>}
        </button>
        </div>
      </header>
      <main className="main">
        <ErrorMessage text={workspace.error} />
        {backupPhase && dialog?.type !== 'desktop' && <p className="queued" role="status">{backupProgress}</p>}
        {schedulesPaused && <div className="queued"><Clock3 size={16} /> {t('schedulesPaused')}
          <button className="text-button" onClick={() => setDialog({ type: 'desktop' })}>{t('desktopSettings')}</button></div>}
        {tab === 'notifications' ? <>
          <div className="page-heading"><div><h1>{t('notifications')}</h1></div></div>
          <Notifications smtpConfigured={workspace.data?.smtpConfigured} unread={workspace.data?.unread ?? 0}
            cursors={route.cursors ?? []} updateCursors={(cursors, replace) => navigate({ ...route, cursors }, replace ? 'replace' : 'push')}
            changed={workspace.refresh} open={(id, run, notification) => navigate({ ...route, project: id, run, notification }, 'overlay')} />
        </> : missingProject ? <section className="panel"><Empty icon={<Folder size={24} />} title={t('missing')}
            text={t('missingHelp')}
            action={<button className="button secondary" onClick={() => select()}>{t('backProjects')}</button>} /></section>
          : workspace.data && !project ? <Welcome open={addProject} />
          : !project ? !workspace.error && <Loading /> : <>
            <div className="page-heading">
              <div className="project-heading">
                <span className="project-mark"><Folder size={23} /></span>
                <div><h1>{project.name}</h1>
                  {project.description && <p>{project.description}</p>}
                </div>
              </div>
              <div className="page-actions">
                <ExportMenu path={base(project.id)} />
                <button className="button primary" onClick={() => start()} disabled={!project.urlCount || task.busy || detail.data?.transferActive}
                  title={detail.data?.transferActive ? t('transfer') : undefined}>
                  <Play size={16} fill="currentColor" /> {t('checkProject')}
                </button>
              </div>
            </div>
            <ErrorMessage text={detail.error || task.error || queue.error} />
            <nav className="tabs" aria-label={t('sections')}>
              {tabs.map(({ id, icon: Icon }) => <button key={id} className={tab === id ? 'active' : ''}
                aria-current={tab === id ? 'page' : undefined} onClick={() => setTab(id)}><Icon size={17} />{t(id)}</button>)}
              {project.schedule && schedulesPaused
                ? <span className="schedule-badge"><Clock3 size={15} /> {t('paused')}</span>
                : project.nextAt && <span className="schedule-badge"><CalendarClock size={15} /> {date(project.nextAt, project.schedule?.timezone)}</span>}
            </nav>
            {activeRun && <Progress run={activeRun} paused={schedulesPaused && activeRun.source === 'schedule'}
              open={() => openRun(activeRun.id)} stopped={runStopped} />}
            <RunQueue runs={waiting} schedulesPaused={schedulesPaused} open={openRun} stopped={runStopped} />
            {restart && <StoppedRun projectId={project.id} restart={restart} open={() => openRun(restart.id)} accepted={runAccepted} />}
            {feedback && !restart && <div className="queued"><Signal size={16} /><span role="status">{t(feedback.kind === 'accepted' ? 'accepted' : feedback.stopped ? 'stopped' : 'finished', { id: feedback.runId })}</span>
              <button className="text-button" onClick={() => openRun(feedback.runId)}>{t('openReport')}</button></div>}
            {tab === 'urls' && (detail.data ? <>
              <Metrics summary={detail.data.summary} />
              <AddressList key={project.id} projectId={project.id} revision={detail.data.revision} total={detail.data.summary.total}
                groupId={route.group} showRuns={!!route.groupRuns}
                changeGroup={(group, groupRuns) => navigate({ ...route, project: project.id, group, groupRuns })}
                deletedIds={deletedAddresses?.projectId === project.id ? deletedAddresses.ids : undefined} importUrls={importUrls} start={start} busy={task.busy}
                startGroup={id => start(undefined, id)} journalRevision={journalRevision} openRun={openRun} openComparison={openComparison}
                addressesCleared={() => {
                  setAcknowledgement(previous => previous?.projectId === project.id ? undefined : previous);
                  setJournalRevision(revision => revision + 1);
                  change();
                }}
                edit={address => setDialog({ type: 'edit', address })} remove={(ids, filters) => setDialog({ type: 'delete', ids, filters })} inspect={inspect} />
            </> : !detail.error && <Loading />)}
            {tab === 'catalog' && <CatalogView key={project.id} projectId={project.id} changed={change} openRun={openRun} openWorklist={() => setTab('urls')} />}
            {tab === 'runs' && <RunList key={project.id} projectId={project.id} revision={journalRevision}
              open={openRun} openComparison={openComparison} />}
            {tab === 'settings' && <>
              <section className="panel settings-card project-management">
                <div className="section-heading"><span className="section-icon violet"><Folder size={19} /></span><h2>{t('project')}</h2></div>
                <div className="project-management-actions">
                  <button className="button secondary" onClick={() => setDialog({ type: 'rename-project' })}>
                    <Pencil size={15} /> {t('editProject')}
                  </button>
                  <button className="button secondary danger-ghost" onClick={() => setDialog({ type: 'delete-project' })}>
                    <Trash2 size={15} /> {t('deleteProject')}
                  </button>
                </div>
              </section>
              <SettingsForm key={project.id} project={project} schedulesPaused={schedulesPaused}
                smtpConfigured={!!workspace.data?.smtpConfigured} saved={change} registerLeaveGuard={registerProjectLeaveGuard} />
              <RequestProfileSettings key={`request-profiles:${project.id}`} projectId={project.id} />
            </>}
          </>}
      </main>
    </div>
    {dialog?.type === 'desktop' && <DesktopSettings close={closeDialog} changed={change} phase={backupPhase}
      registerLeaveGuard={registerDesktopLeaveGuard} />}
    {dialog?.type === 'project' && <ProjectForm close={closeDialog} saved={entry => {
      if (dialogRef.current === dialog) {
        setCreatedProject(entry);
        navigate({ project: entry.id, tab: 'urls' }, 'push', false);
      }
      change();
    }} />}
    {project && dialog?.type === 'rename-project' &&
      <ProjectForm project={project} close={closeDialog} saved={() => { if (dialogRef.current === dialog) closeDialog(); change(); }} />}
    {project && dialog?.type === 'delete-project' && <ConfirmDeletion title={t('deleteProjectTitle')} label={t('deleteProject')}
      close={closeDialog} confirm={async () => {
        await api(base(project.id), { method: 'DELETE' });
        if (dialogRef.current === dialog) navigate({ project: projects.find(entry => entry.id !== project.id)?.id, tab: 'urls' }, 'push', false);
        workspace.refresh();
      }}>
      <p>{t('deleteProjectWarning', { name: project.name })}</p>
    </ConfirmDeletion>}
    {project && dialog?.type === 'import' && <ImportForm projectId={project.id} close={closeDialog} changed={change}
      openCatalog={() => { closeDialog(); setTab('catalog'); }} />}
    {project && dialog?.type === 'edit' && <EditForm projectId={project.id} address={dialog.address} close={closeDialog} changed={change} />}
    {project && dialog?.type === 'delete' && <DeleteForm projectId={project.id} ids={dialog.ids} filters={dialog.filters} close={closeDialog} changed={() => {
      setDeletedAddresses({ projectId: project.id, ids: dialog.ids });
      change();
    }} />}
    {project && route.address && <AddressReport key={`${project.id}:${route.address}`} projectId={project.id} urlId={route.address}
      close={closeOverlay} changed={change} revision={detail.data?.revision} check={{ accepted: runAccepted, openReport: openRun }} />}
    {missingProject && tab === 'notifications' && route.run && <section className="panel"><Empty icon={<Folder size={24} />} title={t('missing')}
      text={t('missingHelp')}
      action={<button className="button secondary" onClick={closeOverlay}>{t('backNotifications')}</button>} /></section>}
    {project && project.id === projectId && route.run &&
      <RunReport key={`${project.id}:${route.run}`} projectId={project.id} runId={route.run} close={closeOverlay} stopped={runStopped} changed={change}
        filters={route.filters} applyFilters={filters => navigate({ ...route, filters }, 'replace', false)}
        goToJournal={() => navigate({ project: project.id, tab: 'runs' }, 'replace', false)}
        fallbackFocus={route.notification ? () => document.getElementById(`notification-report-${route.notification}`) : undefined}
        accepted={runAccepted} openReport={openRun} openComparison={openComparison}
        deleted={() => {
          setAcknowledgement(previous => previous?.runId === route.run ? undefined : previous);
          setJournalRevision(revision => revision + 1);
          closeOverlay();
          change();
        }} />}
    {project && route.comparison && <RunComparison key={project.id} projectId={project.id} selection={route.comparison}
      change={comparison => navigate({ ...route, comparison }, 'replace', false)} close={closeOverlay}
      fallbackFocus={() => document.getElementById(route.run ? 'open-report-comparison' : 'open-runs-comparison')} />}
  </div>;
}
