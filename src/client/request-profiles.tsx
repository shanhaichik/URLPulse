import { useRef, useState } from 'react';
import { Cable, Pencil, Play, Plus, Trash2 } from 'lucide-react';
import { translateDiagnostic } from '../shared/i18n/diagnostics.js';
import { requestProfilesMessages } from '../shared/i18n/locales/request-profiles.js';
import type {
  RequestAuthInput, RequestHeaderView, RequestProfileInput, RequestProfilesView, RequestProfileView,
} from '../shared/request-profiles.js';
import type { CheckResult } from '../shared/types.js';
import { api, requestOrigin, requestProfilesPath, useQuery, useTask, write } from './api.js';
import { ConfirmDeletion } from './forms.js';
import { createMessages, currentLocale } from './i18n.js';
import { ProjectPacSettings } from './pac-settings.js';
import { readSecret, SecretField, type SecretMode } from './request-secret-field.js';
import { ErrorMessage, formatNumber, Loading, Modal, Status } from './ui.js';

const useText = createMessages('request-profiles', requestProfilesMessages);

type ProfileDialog = { type: 'create' } | { type: 'edit' | 'test' | 'delete'; profile: RequestProfileView };
type HeaderRow = { id: number; name: string; secret: boolean; saved?: RequestHeaderView };

const authOptions = { none: 'authNone', basic: 'authBasic', bearer: 'authBearer', 'api-key': 'apiKey' } as const;

const routeLabels = { direct: 'direct', proxy: 'viaProxy' } as const;
const sourceLabels = { profile: 'profileSource', pac: 'pacSource' } as const;
const failureLabels = { configuration: 'configurationFailure', pac: 'pacFailure', proxy: 'proxyFailure', target: 'targetFailure' } as const;

export function RequestDetails({ result }: {
  result: Pick<CheckResult, 'requestProfile' | 'requestRoute' | 'requestProxy' | 'requestSource' | 'failureStage' | 'proxyHttpCode'>;
}) {
  const t = useText();
  return <>
    {result.requestProfile && <div><dt>{t('requestProfile')}</dt><dd>{result.requestProfile}</dd></div>}
    {result.requestRoute && <div><dt>{t('route')}</dt><dd>{t(routeLabels[result.requestRoute])}</dd></div>}
    {result.requestProxy && <div><dt>{t('proxyUrl')}</dt><dd>{result.requestProxy}</dd></div>}
    {result.requestSource && <div><dt>{t('routeSource')}</dt><dd>{t(sourceLabels[result.requestSource])}</dd></div>}
    {result.failureStage && <div><dt>{t('failureStage')}</dt><dd>{t(failureLabels[result.failureStage])}</dd></div>}
    {result.proxyHttpCode != null && <div><dt>{t('proxyHttp')}</dt><dd>{result.proxyHttpCode}</dd></div>}
  </>;
}

function ProfileEditor({ path, profile, mode, close, saved }: {
  path: string; profile?: RequestProfileView; mode: SecretMode; close: () => void; saved: () => void;
}) {
  const t = useText();
  const task = useTask();
  const [origin, setOrigin] = useState(profile?.origin ?? '');
  const [authKind, setAuthKind] = useState<RequestAuthInput['kind']>(profile?.auth.kind ?? 'none');
  const [username, setUsername] = useState(profile?.auth.kind === 'basic' ? profile.auth.username : '');
  const [apiKeyHeader, setApiKeyHeader] = useState(profile?.auth.kind === 'api-key' ? profile.auth.header : '');
  const [proxy, setProxy] = useState(Boolean(profile?.proxy));
  const [proxyUrl, setProxyUrl] = useState(profile?.proxy?.url ?? '');
  const [proxyAuth, setProxyAuth] = useState(Boolean(profile?.proxy?.auth));
  const [proxyUsername, setProxyUsername] = useState(profile?.proxy?.auth?.username ?? '');
  const [headers, setHeaders] = useState<HeaderRow[]>(() => profile?.headers.map((header, id) => ({
    id, name: header.name, secret: header.secret, saved: header,
  })) ?? []);
  const nextHeaderId = useRef(headers.length);
  const pendingHeaderFocus = useRef<number | undefined>(undefined);
  const sameOrigin = profile != null && requestOrigin(origin) === profile.origin;
  const savedAuth = profile?.auth;
  const savedProxy = profile?.proxy;
  const canRetainAuth = sameOrigin && savedAuth?.kind === authKind
    && (savedAuth.kind !== 'basic' || savedAuth.username === username.trim())
    && (savedAuth.kind !== 'api-key' || savedAuth.header === apiKeyHeader.trim().toLowerCase());
  const secretAuth = canRetainAuth && savedAuth.kind !== 'none' ? savedAuth : undefined;
  const secretProxy = sameOrigin && savedProxy && savedProxy.url === requestOrigin(proxyUrl) && savedProxy.auth?.username === proxyUsername.trim()
    ? savedProxy.auth : undefined;
  const dismiss = () => { if (!task.busy) close(); };

  function editHeader(id: number, change: Partial<Pick<HeaderRow, 'name' | 'secret'>>) {
    setHeaders(current => current.map(row => row.id === id ? { ...row, ...change } : row));
  }

  return <Modal title={profile ? t('editProfile') : t('newProfile')} close={dismiss} closeDisabled={task.busy}>
    <form autoComplete="off" onSubmit={event => {
      event.preventDefault();
      if (task.busy) return;
      const form = new FormData(event.currentTarget);
      const authSecret = readSecret(form, 'authSecret', mode);
      const input: RequestProfileInput = {
        name: String(form.get('name')), origin, isDefault: form.has('isDefault'),
        headers: headers.map(row => row.secret
          ? { name: row.name, secret: true, ...readSecret(form, `header-${row.id}`, mode) }
          : { name: row.name, secret: false, value: String(form.get(`header-${row.id}`) ?? '') }),
        auth: authKind === 'none' ? { kind: 'none' }
          : authKind === 'basic' ? { kind: 'basic', username, secret: authSecret }
          : authKind === 'api-key' ? { kind: 'api-key', header: apiKeyHeader, secret: authSecret }
          : { kind: 'bearer', secret: authSecret },
        proxy: proxy ? { url: proxyUrl, ...(proxyAuth && {
          auth: { username: proxyUsername, secret: readSecret(form, 'proxySecret', mode) },
        }) } : null,
      };
      void task.run(async () => {
        await write(profile ? `${path}/${profile.id}` : path, profile ? 'PATCH' : 'POST', input);
        saved();
      });
    }}>
      <div className="modal-body form">
        <fieldset className="form request-fields" disabled={task.busy}>
          <label>{t('profileName')}<input name="name" defaultValue={profile?.name} maxLength={80} required data-initial-focus /></label>
          <label>{t('origin')}<input name="origin" type="url" maxLength={300} required value={origin} placeholder="https://example.com:8443"
            onChange={event => setOrigin(event.target.value)} /></label>
          <p className="field-note">{t('originHint')}</p>
          <label className="inline-check"><input name="isDefault" type="checkbox" defaultChecked={profile?.isDefault ?? false} />
            {t('defaultForOrigin')}</label>
        </fieldset>

        <fieldset className="form request-fields" disabled={task.busy}>
          <legend>{t('headers')}</legend>
          {headers.map((row, index) => {
            const savedHeader = sameOrigin && row.saved?.secret && row.saved.name.toLowerCase() === row.name.trim().toLowerCase() ? row.saved : undefined;
            const fieldName = `header-${row.id}`;
            return <fieldset key={row.id} className="form request-header">
              <legend>{t('numberedHeader', { number: formatNumber(index + 1) })}</legend>
              <div className="request-header-name">
                <label>{t('headerName')}<input value={row.name} onChange={event => editHeader(row.id, { name: event.target.value })} maxLength={128} required
                  placeholder="Accept-Language" ref={element => {
                    if (element && pendingHeaderFocus.current === row.id) {
                      pendingHeaderFocus.current = undefined;
                      element.focus();
                    }
                  }} /></label>
                <button type="button" className="button icon ghost danger-ghost" title={t('removeHeader')}
                  aria-label={t('removeNumberedHeader', { number: formatNumber(index + 1) })}
                  onClick={() => setHeaders(current => current.filter(header => header.id !== row.id))}>
                  <Trash2 size={16} />
                </button>
              </div>
              <label className="inline-check"><input type="checkbox" checked={row.secret} onChange={event => editHeader(row.id, { secret: event.target.checked })} /> {t('secret')}</label>
              {row.secret ? <SecretField key="secret" name={fieldName} label={t('headerValue')} environmentLabel={t('environmentVariable')}
                mode={mode} saved={savedHeader} />
                : <label key="value">{t('headerValue')}<input name={fieldName} defaultValue={row.saved?.secret === false ? row.saved.value : ''} /></label>}
            </fieldset>;
          })}
          <button type="button" className="button small secondary request-add-header" onClick={() => {
            const id = nextHeaderId.current++;
            pendingHeaderFocus.current = id;
            setHeaders(current => [...current, { id, name: '', secret: false }]);
          }}><Plus size={15} /> {t('addHeader')}</button>
        </fieldset>

        <fieldset className="form request-fields" disabled={task.busy}>
          <label>{t('siteAuthentication')}<select value={authKind} onChange={event => setAuthKind(event.target.value as RequestAuthInput['kind'])}>
            {Object.entries(authOptions).map(([value, label]) => <option value={value} key={value}>{t(label)}</option>)}
          </select></label>
          {authKind === 'basic' && <label>{t('siteUsername')}<input value={username} onChange={event => setUsername(event.target.value)} maxLength={200} required /></label>}
          {authKind === 'api-key' && <label>{t('apiKeyHeader')}<input name="apiKeyHeader" placeholder="X-API-Key"
            value={apiKeyHeader} onChange={event => setApiKeyHeader(event.target.value)} maxLength={128} required /></label>}
          {authKind !== 'none' && <SecretField key={authKind} name="authSecret" mode={mode} saved={secretAuth}
            label={authKind === 'basic' ? t('sitePassword') : authKind === 'bearer' ? t('token') : t('apiKey')}
            environmentLabel={authKind === 'basic' ? t('passwordEnvironmentVariable')
              : authKind === 'bearer' ? t('tokenEnvironmentVariable') : t('apiKeyEnvironmentVariable')} />}
        </fieldset>

        <fieldset className="form request-fields" disabled={task.busy}>
          <label>{t('connectionRoute')}<select value={proxy ? 'proxy' : 'direct'} onChange={event => setProxy(event.target.value === 'proxy')}>
            <option value="direct">{t('projectRoute')}</option><option value="proxy">{t('viaProxy')}</option>
          </select></label>
          {!proxy && <p className="field-note">{t('pacRouteHint')}</p>}
          {proxy && <>
            <label>{t('proxyUrl')}<input type="url" maxLength={300} required value={proxyUrl} onChange={event => setProxyUrl(event.target.value)}
              placeholder="https://proxy.example.com:8443" /></label>
            <p className="field-note">{t('proxyHint')}</p>
            <label className="inline-check"><input type="checkbox" checked={proxyAuth} onChange={event => setProxyAuth(event.target.checked)} />
              {t('proxyAuthentication')}</label>
            {proxyAuth && <>
              <label>{t('proxyUsername')}<input required value={proxyUsername} onChange={event => setProxyUsername(event.target.value)} maxLength={200} /></label>
              <SecretField name="proxySecret" label={t('proxyPassword')} environmentLabel={t('proxyPasswordEnvironmentVariable')} mode={mode} saved={secretProxy} />
            </>}
          </>}
        </fieldset>
        <ErrorMessage text={task.error} />
      </div>
      <div className="modal-footer">
        <button type="button" className="button secondary" disabled={task.busy} onClick={dismiss}>{t('cancel')}</button>
        <button type="submit" className="button primary" disabled={task.busy}>{task.busy ? t('savingProfile') : t('saveProfile')}</button>
      </div>
    </form>
  </Modal>;
}

function ProfileTest({ path, profile, close }: { path: string; profile: RequestProfileView; close: () => void }) {
  const t = useText();
  const task = useTask();
  const [result, setResult] = useState<CheckResult>();
  const dismiss = () => { if (!task.busy) close(); };
  return <Modal title={t('testProfile')} caption={`${profile.name} · ${profile.origin}`} close={dismiss} closeDisabled={task.busy}>
    <form onSubmit={event => {
      event.preventDefault();
      if (task.busy) return;
      const url = String(new FormData(event.currentTarget).get('url'));
      setResult(undefined);
      void task.run(async () => setResult(await write<CheckResult>(`${path}/${profile.id}/test`, 'POST', { url })));
    }}>
      <div className="modal-body form">
        <label>{t('testUrl')}<input type="url" name="url" maxLength={2000} defaultValue={`${profile.origin}/`} required data-initial-focus readOnly={task.busy} /></label>
        {task.busy && <p role="status" className="field-note">{t('testing')}</p>}
        <ErrorMessage text={task.error} />
        {result && <div className="request-test-result" role="status">
          <Status result={result} />
          {result.error && <p>{translateDiagnostic(result.error, currentLocale())}</p>}
          <dl>
            <div><dt>{t('siteHttp')}</dt><dd>{result.httpCode ?? '—'}</dd></div>
            <div><dt>{t('duration')}</dt><dd>{t('durationMs', { duration: formatNumber(result.durationMs) })}</dd></div>
            <RequestDetails result={result} />
          </dl>
        </div>}
      </div>
      <div className="modal-footer">
        <button type="button" className="button secondary" onClick={dismiss} disabled={task.busy}>{t('close')}</button>
        <button type="submit" className="button primary" disabled={task.busy}><Play size={15} /> {t('testProfile')}</button>
      </div>
    </form>
  </Modal>;
}

export function RequestProfileSettings({ projectId }: { projectId: number }) {
  const t = useText();
  const path = requestProfilesPath(projectId);
  const { data, error, refresh } = useQuery<RequestProfilesView>(path);
  const [dialog, setDialog] = useState<ProfileDialog>();
  const close = () => setDialog(undefined);
  const saved = () => { close(); refresh(); };
  return <section className="panel settings-card request-profiles">
    <div className="section-heading">
      <span className="section-icon violet"><Cable size={19} /></span>
      <div><h2>{t('httpRequests')}</h2><p>{t('profileHint')}</p></div>
      <button type="button" className="button secondary" disabled={!data} onClick={() => setDialog({ type: 'create' })}>
        <Plus size={16} /> {t('addProfile')}
      </button>
    </div>
    <ErrorMessage text={error} />
    {error && <button type="button" className="button small secondary" onClick={refresh}>{t('retry')}</button>}
    {!data && !error && <Loading />}
    {data && (data.profiles.length ? <ul className="request-profile-list" aria-label={t('requestProfiles')}>
      {data.profiles.map(profile => <li key={profile.id}>
        <div className="request-profile-summary">
          <strong>{profile.name}</strong>
          <span>{profile.origin} · {t(profile.proxy ? 'viaProxy' : 'projectRoute')}{profile.isDefault && <> · {t('defaultProfile')}</>}</span>
        </div>
        <div className="request-profile-actions">
          <button type="button" className="button small secondary" onClick={() => setDialog({ type: 'test', profile })}><Play size={15} /> {t('testProfile')}</button>
          <button type="button" className="button small secondary" onClick={() => setDialog({ type: 'edit', profile })}><Pencil size={15} /> {t('edit')}</button>
          <button type="button" className="button small secondary danger-ghost" onClick={() => setDialog({ type: 'delete', profile })}><Trash2 size={15} /> {t('delete')}</button>
        </div>
      </li>)}
    </ul> : <p className="field-note">{t('noProfiles')}</p>)}
    <ProjectPacSettings projectId={projectId} secretMode={data?.secretMode} />
    {data && (dialog?.type === 'create' || dialog?.type === 'edit') && <ProfileEditor path={path}
      profile={dialog.type === 'edit' ? dialog.profile : undefined} mode={data.secretMode} close={close} saved={saved} />}
    {dialog?.type === 'test' && <ProfileTest path={path} profile={dialog.profile} close={close} />}
    {dialog?.type === 'delete' && <ConfirmDeletion title={t('deleteProfile')} label={t('delete')} close={close} confirm={async () => {
      await api(`${path}/${dialog.profile.id}`, { method: 'DELETE' });
      saved();
    }}>
      <p>{t('deleteProfileHint', { name: dialog.profile.name })}</p>
    </ConfirmDeletion>}
  </section>;
}
