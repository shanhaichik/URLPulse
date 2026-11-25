import { useId, useRef, useState } from 'react';
import { Pencil, Play, Plus, Trash2, Upload } from 'lucide-react';
import { createTranslator } from '../shared/i18n/index.js';
import { pacSettingsMessages } from '../shared/i18n/locales/pac-settings.js';
import { MAX_PAC_BYTES, type PacPreview, type PacProxyInput, type PacProxyView, type PacSettings } from '../shared/pac.js';
import { api, base, requestOrigin, useQuery, useTask, write } from './api.js';
import { ConfirmDeletion } from './forms.js';
import { createMessages, LocalizedError } from './i18n.js';
import { readSecret, SecretField, type SecretMode } from './request-secret-field.js';
import { ErrorMessage, Loading, Modal } from './ui.js';

const useText = createMessages('pac-settings', pacSettingsMessages);
const pacUploadError = (key: 'fileSizeError' | 'fileEncodingError') =>
  new LocalizedError(locale => createTranslator(locale, 'pac-settings', pacSettingsMessages)(key));

type SettingsResponse = { pac: PacSettings | null };
type PacDialog = { type: 'upload' | 'preview' | 'disable' } | { type: 'proxy'; proxy?: PacProxyView }
  | { type: 'remove'; proxy: PacProxyView };

function proxyInput({ auth, ...proxy }: PacProxyView): PacProxyInput {
  return { ...proxy, ...(auth ? { auth: { username: auth.username } } : {}) };
}

function TrustedProxyEditor({ mode, proxy, close, save }: {
  mode: SecretMode; proxy?: PacProxyView; close: () => void; save: (next: PacProxyInput) => Promise<void>;
}) {
  const t = useText();
  const task = useTask();
  const [url, setUrl] = useState(proxy?.url ?? '');
  const [username, setUsername] = useState(proxy?.auth?.username ?? '');
  const [basic, setBasic] = useState(!!proxy?.auth);
  const https = /^https:\/\//i.test(url.trim());
  const retained = proxy && requestOrigin(url) === proxy.url && username.trim() === proxy.auth?.username ? proxy.auth : undefined;
  const dismiss = () => { if (!task.busy) close(); };
  return <Modal title={t(proxy ? 'editTrustedProxy' : 'addTrustedProxy')} close={dismiss} closeDisabled={task.busy}>
    <form onSubmit={event => {
      event.preventDefault();
      if (task.busy) return;
      const form = new FormData(event.currentTarget);
      const auth = https && basic ? { username, secret: readSecret(form, 'password', mode) } : undefined;
      void task.run(() => save({ url, auth, allowPrivate: form.has('allowPrivate'), connectByHostname: form.has('connectByHostname') }));
    }}>
      <div className="modal-body form">
        <fieldset className="form request-fields" disabled={task.busy}>
          <label>{t('proxyAddress')}
            <input type="url" value={url} onChange={event => setUrl(event.target.value)} data-initial-focus required maxLength={300}
              placeholder="https://proxy.example.com:8443" />
          </label>
          <label className="inline-check"><input type="checkbox" name="allowPrivate" defaultChecked={proxy?.allowPrivate} />
            {t('allowPrivateProxy')}</label>
          <label className="inline-check"><input type="checkbox" name="connectByHostname" defaultChecked={proxy?.connectByHostname} />
            {t('connectByHostname')}</label>
          <p className="field-note">{t('trustedConnectHint')}</p>
          <label className="inline-check"><input type="checkbox" checked={https && basic} disabled={!https}
            onChange={event => setBasic(event.target.checked)} />{t('proxyBasic')}</label>
          {!https && <p className="field-note">{t('basicNeedsHttps')}</p>}
          {https && basic && <>
            <label>{t('proxyUsername')}<input value={username} onChange={event => setUsername(event.target.value)} required maxLength={200} /></label>
            <SecretField name="password" label={t('proxyPassword')} environmentLabel={t('proxyPasswordEnvironment')} mode={mode} saved={retained} />
          </>}
        </fieldset>
        <ErrorMessage text={task.error} />
      </div>
      <div className="modal-footer">
        <button type="button" className="button secondary" onClick={dismiss} disabled={task.busy}>{t('cancel')}</button>
        <button type="submit" className="button primary" disabled={task.busy}>{task.busy ? t('savingPac') : t('saveProxy')}</button>
      </div>
    </form>
  </Modal>;
}

function PacUpload({ path, title, filename, close, saved }: {
  path: string; title: string; filename?: string; close: () => void; saved: (value: SettingsResponse) => void;
}) {
  const t = useText();
  const task = useTask();
  const [file, setFile] = useState<File>();
  const dismiss = () => { if (!task.busy) close(); };
  return <Modal title={title} caption={filename ? t('currentFile', { filename }) : undefined} close={dismiss} closeDisabled={task.busy}>
    <form onSubmit={event => {
      event.preventDefault();
      if (!file || task.busy) return;
      void task.run(async () => {
        if (file.size > MAX_PAC_BYTES) throw pacUploadError('fileSizeError');
        const contents = await file.arrayBuffer();
        let source: string;
        try { source = new TextDecoder('utf-8', { fatal: true }).decode(contents); }
        catch { throw pacUploadError('fileEncodingError'); }
        saved(await write<SettingsResponse>(path, 'PUT', { filename: file.name, source }));
      });
    }}>
      <div className="modal-body form">
        <label className="upload-field">
          <Upload size={24} /><strong>{t('pacFile')}</strong><span>{t('pacFileHint')}</span>
          <input type="file" aria-label={t('pacFile')} accept=".pac" required disabled={task.busy} data-initial-focus
            onChange={event => { setFile(event.target.files?.[0]); task.clear(); }} />
        </label>
        <ErrorMessage text={task.error} />
      </div>
      <div className="modal-footer">
        <button type="button" className="button secondary" onClick={dismiss} disabled={task.busy}>{t('cancel')}</button>
        <button type="submit" className="button primary" disabled={!file || task.busy}>{task.busy ? t('savingPac') : t('savePac')}</button>
      </div>
    </form>
  </Modal>;
}

const sourceLabels = { pac: 'pacSource', profile: 'profileSource', direct: 'directSource' } as const;

function PacRoutePreview({ path, filename, close }: { path: string; filename: string; close: () => void }) {
  const t = useText();
  const task = useTask();
  const [preview, setPreview] = useState<PacPreview>();
  const dismiss = () => { if (!task.busy) close(); };
  return <Modal title={t('testPacRoute')} caption={filename} close={dismiss} closeDisabled={task.busy}>
    <form onSubmit={event => {
      event.preventDefault();
      if (task.busy) return;
      const url = String(new FormData(event.currentTarget).get('url'));
      setPreview(undefined);
      void task.run(async () => setPreview(await write<PacPreview>(`${path}/test`, 'POST', { url })));
    }}>
      <div className="modal-body form">
        <label>{t('testUrl')}<input name="url" type="url" maxLength={2_000} placeholder="https://example.com/" required
          data-initial-focus readOnly={task.busy} onChange={() => { setPreview(undefined); task.clear(); }} /></label>
        {task.busy && <p role="status" className="field-note">{t('resolvingRoute')}</p>}
        <ErrorMessage text={task.error} />
        <div aria-live="polite">
          {preview && <div className="request-test-result pac-preview">
            {preview.source && <p className="field-note">{t('routeSource', { source: t(sourceLabels[preview.source]) })}</p>}
            <ol aria-label={t('pacRoutes')}>
              {preview.routes.map((route, index) => <li key={index}>
                <strong>{index ? t('fallbackRoute') : t('primaryRoute')}</strong>
                <span>{route.kind === 'direct' ? t('direct') : route.url}</span>
              </li>)}
            </ol>
          </div>}
        </div>
      </div>
      <div className="modal-footer">
        <button type="button" className="button secondary" onClick={dismiss} disabled={task.busy}>{t('close')}</button>
        <button type="submit" className="button primary" disabled={task.busy}><Play size={15} /> {t('testRoute')}</button>
      </div>
    </form>
  </Modal>;
}

export function ProjectPacSettings({ projectId, secretMode }: { projectId: number; secretMode?: SecretMode }) {
  const t = useText();
  const heading = useId();
  const uploadButton = useRef<HTMLButtonElement>(null);
  const addProxyButton = useRef<HTMLButtonElement>(null);
  const path = `${base(projectId)}/proxy-pac`;
  const query = useQuery<SettingsResponse>(path);
  const [saved, setSaved] = useState<SettingsResponse>();
  const [dialog, setDialog] = useState<PacDialog>();
  const data = saved ?? query.data;
  const pac = data?.pac;
  const uploadLabel = pac ? t('replacePac') : t('uploadPac');
  const close = () => setDialog(undefined);
  function update(value: SettingsResponse) { setSaved(value); close(); }
  async function replaceProxies(proxies: PacProxyInput[]) {
    update(await write<SettingsResponse>(path, 'PATCH', { revision: pac?.revision, proxies }));
  }
  return <section className="project-pac" aria-labelledby={heading}>
    <div className="project-pac-row">
      <div className="request-profile-summary">
        <h3 id={heading}>{t('projectPacFile')}</h3>
        {data && <span>{pac?.filename ?? t('pacUnconfigured')}</span>}
      </div>
      {data && <div className="request-profile-actions">
        <button className="button small secondary" type="button" ref={uploadButton} onClick={() => setDialog({ type: 'upload' })}>
          <Upload size={15} /> {uploadLabel}
        </button>
        {pac && <>
          <button className="button small secondary" type="button" onClick={() => setDialog({ type: 'preview' })}>
            <Play size={15} /> {t('testRoute')}
          </button>
          <button className="button small secondary danger-ghost" type="button" onClick={() => setDialog({ type: 'disable' })}>
            {t('disablePac')}
          </button>
        </>}
      </div>}
    </div>
    <p className="field-note">{t('pacHint')}</p>
    {pac?.proxies?.length ? <ul className="request-profile-list" aria-label={t('trustedProxies')}>
      {pac.proxies.map(proxy => <li key={proxy.url}>
        <div className="request-profile-summary">
          <strong>{proxy.url}</strong>
          {proxy.allowPrivate && <span>{t('allowPrivateProxy')}</span>}
          {proxy.connectByHostname && <span>{t('connectByHostname')}</span>}
          {proxy.auth && <span>{t('basicConfigured')}</span>}
        </div>
        <div className="request-profile-actions">
          <button type="button" className="button small secondary" disabled={!secretMode} onClick={() => setDialog({ type: 'proxy', proxy })}>
            <Pencil size={15} />{t('editProxy')}</button>
          <button type="button" className="button small secondary danger-ghost" onClick={() => setDialog({ type: 'remove', proxy })}>
            <Trash2 size={15} />{t('removeProxy')}</button>
        </div>
      </li>)}
    </ul> : null}
    {pac && <button type="button" className="button small secondary" ref={addProxyButton} disabled={!secretMode}
      onClick={() => setDialog({ type: 'proxy' })}><Plus size={15} />{t('addTrustedProxy')}</button>}
    <ErrorMessage text={query.error} />
    {query.error && <button className="button small secondary" type="button" onClick={query.refresh}>{t('retryPac')}</button>}
    {!data && !query.error && <Loading />}
    {dialog?.type === 'upload' && <PacUpload path={path} title={uploadLabel} filename={pac?.filename} close={close} saved={update} />}
    {pac && dialog?.type === 'preview' && <PacRoutePreview path={path} filename={pac.filename} close={close} />}
    {pac && dialog?.type === 'proxy' && secretMode && <TrustedProxyEditor mode={secretMode} proxy={dialog.proxy} close={close}
      save={async next => {
        const proxies = (pac.proxies ?? []).map(proxy => proxy === dialog.proxy ? next : proxyInput(proxy));
        if (!dialog.proxy) proxies.push(next);
        await replaceProxies(proxies);
      }} />}
    {pac && dialog?.type === 'remove' && <ConfirmDeletion title={t('removeTrustedProxy')} label={t('removeProxy')} close={close}
      fallbackFocus={() => addProxyButton.current}
      confirm={() => replaceProxies((pac.proxies ?? []).filter(proxy => proxy.url !== dialog.proxy.url).map(proxyInput))}>
      <p>{dialog.proxy.url}</p>
    </ConfirmDeletion>}
    {pac && dialog?.type === 'disable' && <ConfirmDeletion title={t('disableProjectPac')} label={t('disablePac')} close={close}
      fallbackFocus={() => uploadButton.current} confirm={async () => update(await api<SettingsResponse>(path, { method: 'DELETE' }))}>
      <p>{t('disablePacHint')}</p>
    </ConfirmDeletion>}
  </section>;
}
