import { useId, useRef, useState } from 'react';
import { Play, Upload } from 'lucide-react';
import { createTranslator } from '../shared/i18n/index.js';
import { pacSettingsMessages } from '../shared/i18n/locales/pac-settings.js';
import { MAX_PAC_BYTES, type PacPreview, type PacSettings } from '../shared/pac.js';
import { api, base, useQuery, useTask, write } from './api.js';
import { ConfirmDeletion } from './forms.js';
import { createMessages, LocalizedError } from './i18n.js';
import { ErrorMessage, Loading, Modal } from './ui.js';

const useText = createMessages('pac-settings', pacSettingsMessages);
const pacUploadError = (key: 'fileSizeError' | 'fileEncodingError') =>
  new LocalizedError(locale => createTranslator(locale, 'pac-settings', pacSettingsMessages)(key));

type SettingsResponse = { pac: PacSettings | null };

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

export function ProjectPacSettings({ projectId }: { projectId: number }) {
  const t = useText();
  const heading = useId();
  const uploadButton = useRef<HTMLButtonElement>(null);
  const path = `${base(projectId)}/proxy-pac`;
  const query = useQuery<SettingsResponse>(path);
  const [saved, setSaved] = useState<SettingsResponse>();
  const [dialog, setDialog] = useState<'upload' | 'preview' | 'disable'>();
  const data = saved ?? query.data;
  const pac = data?.pac;
  const uploadLabel = pac ? t('replacePac') : t('uploadPac');
  const close = () => setDialog(undefined);
  function update(value: SettingsResponse) { setSaved(value); close(); }
  return <section className="project-pac" aria-labelledby={heading}>
    <div className="project-pac-row">
      <div className="request-profile-summary">
        <h3 id={heading}>{t('projectPacFile')}</h3>
        {data && <span>{pac?.filename ?? t('pacUnconfigured')}</span>}
      </div>
      {data && <div className="request-profile-actions">
        <button className="button small secondary" type="button" ref={uploadButton} onClick={() => setDialog('upload')}>
          <Upload size={15} /> {uploadLabel}
        </button>
        {pac && <>
          <button className="button small secondary" type="button" onClick={() => setDialog('preview')}>
            <Play size={15} /> {t('testRoute')}
          </button>
          <button className="button small secondary danger-ghost" type="button" onClick={() => setDialog('disable')}>
            {t('disablePac')}
          </button>
        </>}
      </div>}
    </div>
    <p className="field-note">{t('pacHint')}</p>
    <ErrorMessage text={query.error} />
    {query.error && <button className="button small secondary" type="button" onClick={query.refresh}>{t('retryPac')}</button>}
    {!data && !query.error && <Loading />}
    {dialog === 'upload' && <PacUpload path={path} title={uploadLabel} filename={pac?.filename} close={close} saved={update} />}
    {pac && dialog === 'preview' && <PacRoutePreview path={path} filename={pac.filename} close={close} />}
    {pac && dialog === 'disable' && <ConfirmDeletion title={t('disableProjectPac')} label={t('disablePac')} close={close}
      fallbackFocus={() => uploadButton.current} confirm={async () => update(await api<SettingsResponse>(path, { method: 'DELETE' }))}>
      <p>{t('disablePacHint')}</p>
    </ConfirmDeletion>}
  </section>;
}
