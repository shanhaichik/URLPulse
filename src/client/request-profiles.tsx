import { useRef, useState } from 'react';
import { Cable, Pencil, Play, Plus, Trash2 } from 'lucide-react';
import type {
  RequestAuthInput, RequestHeaderView, RequestProfileInput, RequestProfilesView, RequestProfileView, RequestSecretInput, RequestSecretView,
} from '../shared/request-profiles.js';
import type { CheckResult } from '../shared/types.js';
import { api, requestOrigin, requestProfilesPath, useQuery, useTask, write } from './api.js';
import { ConfirmDeletion } from './forms.js';
import { ProjectPacSettings } from './pac-settings.js';
import { ErrorMessage, Loading, Modal, Status } from './ui.js';

type ProfileDialog = { type: 'create' } | { type: 'edit' | 'test' | 'delete'; profile: RequestProfileView };
type SecretMode = RequestProfilesView['secretMode'];
type HeaderRow = { id: number; name: string; secret: boolean; saved?: RequestHeaderView };

const authOptions: Record<RequestAuthInput['kind'], string> = {
  none: 'Без авторизации', basic: 'Basic', bearer: 'Bearer', 'api-key': 'API-ключ',
};

const routeLabels = { direct: 'Напрямую', proxy: 'Через прокси' };
const inheritedRoute = 'Маршрут проекта';
const sourceLabels = { profile: 'HTTP-профиль', pac: 'PAC проекта' };
const failureLabels = { configuration: 'Настройка профиля', pac: 'Выбор маршрута PAC', proxy: 'Подключение к прокси', target: 'Запрос к сайту' };

export function RequestDetails({ result }: {
  result: Pick<CheckResult, 'requestProfile' | 'requestRoute' | 'requestProxy' | 'requestSource' | 'failureStage' | 'proxyHttpCode'>;
}) {
  return <>
    {result.requestProfile && <div><dt>Профиль HTTP</dt><dd>{result.requestProfile}</dd></div>}
    {result.requestRoute && <div><dt>Маршрут</dt><dd>{routeLabels[result.requestRoute]}</dd></div>}
    {result.requestProxy && <div><dt>Адрес прокси</dt><dd>{result.requestProxy}</dd></div>}
    {result.requestSource && <div><dt>Источник маршрута</dt><dd>{sourceLabels[result.requestSource]}</dd></div>}
    {result.failureStage && <div><dt>Этап сбоя</dt><dd>{failureLabels[result.failureStage]}</dd></div>}
    {result.proxyHttpCode != null && <div><dt>HTTP прокси</dt><dd>{result.proxyHttpCode}</dd></div>}
  </>;
}

function readSecret(form: FormData, name: string, mode: SecretMode): RequestSecretInput | undefined {
  const value = String(form.get(name) ?? '');
  if (!value) return undefined;
  return mode === 'desktop' ? { value } : { environment: value.trim() };
}

function SecretField({ name, label, environmentLabel, mode, saved }: {
  name: string; label: string; environmentLabel: string; mode: SecretMode; saved?: RequestSecretView;
}) {
  const configured = saved?.configured ?? false;
  return <div className="request-secret-field">
    <label>{mode === 'desktop' ? label : environmentLabel}
      <input name={name} required={!configured} type={mode === 'desktop' ? 'password' : 'text'}
        autoComplete={mode === 'desktop' ? 'new-password' : 'off'} spellCheck={false}
        placeholder={mode === 'environment' && !configured ? 'PULSE_REQUEST_SECRET_…' : undefined} />
    </label>
    {configured && <p className="field-note"><strong>Секрет настроен</strong>{saved?.environment && <> · {saved.environment}</>}<br />
      Оставьте поле пустым, чтобы сохранить текущий секрет.</p>}
  </div>;
}

function ProfileEditor({ path, profile, mode, close, saved }: {
  path: string; profile?: RequestProfileView; mode: SecretMode; close: () => void; saved: () => void;
}) {
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

  return <Modal title={profile ? 'Редактировать профиль HTTP' : 'Новый профиль HTTP'} close={dismiss} closeDisabled={task.busy}>
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
          <label>Название профиля<input name="name" defaultValue={profile?.name} maxLength={80} required data-initial-focus /></label>
          <label>Адрес сервера<input name="origin" type="url" maxLength={300} required value={origin} placeholder="https://example.com:8443"
            onChange={event => setOrigin(event.target.value)} /></label>
          <p className="field-note">Укажите схему, хост и при необходимости порт. Секреты требуют HTTPS.</p>
          <label className="inline-check"><input name="isDefault" type="checkbox" defaultChecked={profile?.isDefault ?? false} />
            Применять по умолчанию к URL этого сервера</label>
        </fieldset>

        <fieldset className="form request-fields" disabled={task.busy}>
          <legend>Заголовки</legend>
          {headers.map((row, index) => {
            const savedHeader = sameOrigin && row.saved?.secret && row.saved.name.toLowerCase() === row.name.trim().toLowerCase() ? row.saved : undefined;
            const fieldName = `header-${row.id}`;
            return <fieldset key={row.id} className="form request-header">
              <legend>Заголовок {index + 1}</legend>
              <div className="request-header-name">
                <label>Имя<input value={row.name} onChange={event => editHeader(row.id, { name: event.target.value })} maxLength={128} required
                  placeholder="Accept-Language" ref={element => {
                    if (element && pendingHeaderFocus.current === row.id) {
                      pendingHeaderFocus.current = undefined;
                      element.focus();
                    }
                  }} /></label>
                <button type="button" className="button icon ghost danger-ghost" title="Удалить заголовок"
                  aria-label={`Удалить заголовок ${index + 1}`} onClick={() => setHeaders(current => current.filter(header => header.id !== row.id))}>
                  <Trash2 size={16} />
                </button>
              </div>
              <label className="inline-check"><input type="checkbox" checked={row.secret} onChange={event => editHeader(row.id, { secret: event.target.checked })} /> Секрет</label>
              {row.secret ? <SecretField key="secret" name={fieldName} label="Значение" environmentLabel="Переменная окружения"
                mode={mode} saved={savedHeader} />
                : <label key="value">Значение<input name={fieldName} defaultValue={row.saved?.secret === false ? row.saved.value : ''} /></label>}
            </fieldset>;
          })}
          <button type="button" className="button small secondary request-add-header" onClick={() => {
            const id = nextHeaderId.current++;
            pendingHeaderFocus.current = id;
            setHeaders(current => [...current, { id, name: '', secret: false }]);
          }}><Plus size={15} /> Добавить заголовок</button>
        </fieldset>

        <fieldset className="form request-fields" disabled={task.busy}>
          <label>Авторизация сайта<select value={authKind} onChange={event => setAuthKind(event.target.value as RequestAuthInput['kind'])}>
            {Object.entries(authOptions).map(([value, label]) => <option value={value} key={value}>{label}</option>)}
          </select></label>
          {authKind === 'basic' && <label>Логин сайта<input value={username} onChange={event => setUsername(event.target.value)} maxLength={200} required /></label>}
          {authKind === 'api-key' && <label>Заголовок API-ключа<input name="apiKeyHeader" placeholder="X-API-Key"
            value={apiKeyHeader} onChange={event => setApiKeyHeader(event.target.value)} maxLength={128} required /></label>}
          {authKind !== 'none' && <SecretField key={authKind} name="authSecret" mode={mode} saved={secretAuth}
            label={authKind === 'basic' ? 'Пароль сайта' : authKind === 'bearer' ? 'Токен' : 'API-ключ'}
            environmentLabel={authKind === 'basic' ? 'Переменная окружения для пароля сайта'
              : authKind === 'bearer' ? 'Переменная окружения для токена' : 'Переменная окружения для API-ключа'} />}
        </fieldset>

        <fieldset className="form request-fields" disabled={task.busy}>
          <label>Маршрут подключения<select value={proxy ? 'proxy' : 'direct'} onChange={event => setProxy(event.target.value === 'proxy')}>
            <option value="direct">{inheritedRoute}</option><option value="proxy">{routeLabels.proxy}</option>
          </select></label>
          {!proxy && <p className="field-note">При активном PAC маршрут выбирается по файлу проекта.</p>}
          {proxy && <>
            <label>Адрес прокси<input type="url" maxLength={300} required value={proxyUrl} onChange={event => setProxyUrl(event.target.value)}
              placeholder="https://proxy.example.com:8443" /></label>
            <p className="field-note">Прокси используется для HTTPS-адресов сайта. Для авторизации прокси требуется HTTPS-соединение с ним.</p>
            <label className="inline-check"><input type="checkbox" checked={proxyAuth} onChange={event => setProxyAuth(event.target.checked)} />
              Авторизация прокси</label>
            {proxyAuth && <>
              <label>Логин прокси<input required value={proxyUsername} onChange={event => setProxyUsername(event.target.value)} maxLength={200} /></label>
              <SecretField name="proxySecret" label="Пароль прокси" environmentLabel="Переменная окружения для пароля прокси" mode={mode} saved={secretProxy} />
            </>}
          </>}
        </fieldset>
        <ErrorMessage text={task.error} />
      </div>
      <div className="modal-footer">
        <button type="button" className="button secondary" disabled={task.busy} onClick={dismiss}>Отмена</button>
        <button type="submit" className="button primary" disabled={task.busy}>{task.busy ? 'Сохраняем…' : 'Сохранить профиль'}</button>
      </div>
    </form>
  </Modal>;
}

function ProfileTest({ path, profile, close }: { path: string; profile: RequestProfileView; close: () => void }) {
  const task = useTask();
  const [result, setResult] = useState<CheckResult>();
  const dismiss = () => { if (!task.busy) close(); };
  return <Modal title="Проверить профиль" caption={`${profile.name} · ${profile.origin}`} close={dismiss} closeDisabled={task.busy}>
    <form onSubmit={event => {
      event.preventDefault();
      if (task.busy) return;
      const url = String(new FormData(event.currentTarget).get('url'));
      setResult(undefined);
      void task.run(async () => setResult(await write<CheckResult>(`${path}/${profile.id}/test`, 'POST', { url })));
    }}>
      <div className="modal-body form">
        <label>URL для проверки<input type="url" name="url" maxLength={2000} defaultValue={`${profile.origin}/`} required data-initial-focus readOnly={task.busy} /></label>
        {task.busy && <p role="status" className="field-note">Проверяем…</p>}
        <ErrorMessage text={task.error} />
        {result && <div className="request-test-result" role="status">
          <Status result={result} />
          {result.error && <p>{result.error}</p>}
          <dl>
            <div><dt>HTTP сайта</dt><dd>{result.httpCode ?? '—'}</dd></div>
            <div><dt>Длительность</dt><dd>{result.durationMs} мс</dd></div>
            <RequestDetails result={result} />
          </dl>
        </div>}
      </div>
      <div className="modal-footer">
        <button type="button" className="button secondary" onClick={dismiss} disabled={task.busy}>Закрыть окно</button>
        <button type="submit" className="button primary" disabled={task.busy}><Play size={15} /> Проверить профиль</button>
      </div>
    </form>
  </Modal>;
}

export function RequestProfileSettings({ projectId }: { projectId: number }) {
  const path = requestProfilesPath(projectId);
  const { data, error, refresh } = useQuery<RequestProfilesView>(path);
  const [dialog, setDialog] = useState<ProfileDialog>();
  const close = () => setDialog(undefined);
  const saved = () => { close(); refresh(); };
  return <section className="panel settings-card request-profiles">
    <div className="section-heading">
      <span className="section-icon violet"><Cable size={19} /></span>
      <div><h2>HTTP-запросы</h2><p>Заголовки, авторизация и прокси для проверок URL.</p></div>
      <button type="button" className="button secondary" disabled={!data} onClick={() => setDialog({ type: 'create' })}>
        <Plus size={16} /> Добавить профиль
      </button>
    </div>
    <ErrorMessage text={error} />
    {error && <button type="button" className="button small secondary" onClick={refresh}>Повторить загрузку</button>}
    {!data && !error && <Loading />}
    {data && (data.profiles.length ? <ul className="request-profile-list" aria-label="Профили запросов">
      {data.profiles.map(profile => <li key={profile.id}>
        <div className="request-profile-summary">
          <strong>{profile.name}</strong>
          <span>{profile.origin} · {profile.proxy ? routeLabels.proxy : inheritedRoute}{profile.isDefault && ' · По умолчанию'}</span>
        </div>
        <div className="request-profile-actions">
          <button type="button" className="button small secondary" onClick={() => setDialog({ type: 'test', profile })}><Play size={15} /> Проверить профиль</button>
          <button type="button" className="button small secondary" onClick={() => setDialog({ type: 'edit', profile })}><Pencil size={15} /> Редактировать</button>
          <button type="button" className="button small secondary danger-ghost" onClick={() => setDialog({ type: 'delete', profile })}><Trash2 size={15} /> Удалить</button>
        </div>
      </li>)}
    </ul> : <p className="field-note">Профилей пока нет.</p>)}
    <ProjectPacSettings projectId={projectId} />
    {data && (dialog?.type === 'create' || dialog?.type === 'edit') && <ProfileEditor path={path}
      profile={dialog.type === 'edit' ? dialog.profile : undefined} mode={data.secretMode} close={close} saved={saved} />}
    {dialog?.type === 'test' && <ProfileTest path={path} profile={dialog.profile} close={close} />}
    {dialog?.type === 'delete' && <ConfirmDeletion title="Удалить профиль HTTP?" label="Удалить" close={close} confirm={async () => {
      await api(`${path}/${dialog.profile.id}`, { method: 'DELETE' });
      saved();
    }}>
      <p>Профиль «{dialog.profile.name}» будет удалён. Адреса с явным назначением будут проверяться без профиля.</p>
    </ConfirmDeletion>}
  </section>;
}
