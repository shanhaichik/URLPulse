import { useId, useRef, useState } from 'react';
import { Play, Upload } from 'lucide-react';
import { MAX_PAC_BYTES, type PacPreview, type PacSettings } from '../shared/pac.js';
import { api, base, useQuery, useTask, write } from './api.js';
import { ConfirmDeletion } from './forms.js';
import { ErrorMessage, Loading, Modal } from './ui.js';

type SettingsResponse = { pac: PacSettings | null };

function PacUpload({ path, title, filename, close, saved }: {
  path: string; title: string; filename?: string; close: () => void; saved: (value: SettingsResponse) => void;
}) {
  const task = useTask();
  const [file, setFile] = useState<File>();
  const dismiss = () => { if (!task.busy) close(); };
  return <Modal title={title} caption={filename ? `Текущий файл · ${filename}` : undefined} close={dismiss} closeDisabled={task.busy}>
    <form onSubmit={event => {
      event.preventDefault();
      if (!file || task.busy) return;
      void task.run(async () => {
        if (file.size > MAX_PAC_BYTES) throw new Error('Размер PAC-файла должен быть не больше 256 КиБ.');
        const contents = await file.arrayBuffer();
        let source: string;
        try { source = new TextDecoder('utf-8', { fatal: true }).decode(contents); }
        catch { throw new Error('Сохраните PAC-файл в кодировке UTF-8.'); }
        saved(await write<SettingsResponse>(path, 'PUT', { filename: file.name, source }));
      });
    }}>
      <div className="modal-body form">
        <label className="upload-field">
          <Upload size={24} /><strong>Файл .pac</strong><span>UTF-8, до 256 КиБ</span>
          <input type="file" aria-label="Файл .pac" accept=".pac" required disabled={task.busy} data-initial-focus
            onChange={event => { setFile(event.target.files?.[0]); task.clear(); }} />
        </label>
        <ErrorMessage text={task.error} />
      </div>
      <div className="modal-footer">
        <button type="button" className="button secondary" onClick={dismiss} disabled={task.busy}>Отмена</button>
        <button type="submit" className="button primary" disabled={!file || task.busy}>{task.busy ? 'Сохраняем…' : 'Сохранить PAC'}</button>
      </div>
    </form>
  </Modal>;
}

const sourceLabels = { pac: 'PAC проекта', profile: 'HTTP-профиль', direct: 'Прямое подключение' };

function PacRoutePreview({ path, filename, close }: { path: string; filename: string; close: () => void }) {
  const task = useTask();
  const [preview, setPreview] = useState<PacPreview>();
  const dismiss = () => { if (!task.busy) close(); };
  return <Modal title="Проверить маршрут PAC" caption={filename} close={dismiss} closeDisabled={task.busy}>
    <form onSubmit={event => {
      event.preventDefault();
      if (task.busy) return;
      const url = String(new FormData(event.currentTarget).get('url'));
      setPreview(undefined);
      void task.run(async () => setPreview(await write<PacPreview>(`${path}/test`, 'POST', { url })));
    }}>
      <div className="modal-body form">
        <label>URL для проверки<input name="url" type="url" maxLength={2_000} placeholder="https://example.com/" required
          data-initial-focus readOnly={task.busy} onChange={() => { setPreview(undefined); task.clear(); }} /></label>
        {task.busy && <p role="status" className="field-note">Определяем маршрут…</p>}
        <ErrorMessage text={task.error} />
        <div aria-live="polite">
          {preview && <div className="request-test-result pac-preview">
            {preview.source && <p className="field-note">Источник маршрута · {sourceLabels[preview.source]}</p>}
            <ol aria-label="Маршруты PAC">
              {preview.routes.map((route, index) => <li key={index}>
                <strong>{index ? 'Резервный маршрут' : 'Основной маршрут'}</strong>
                <span>{route.kind === 'direct' ? 'Напрямую' : route.url}</span>
              </li>)}
            </ol>
          </div>}
        </div>
      </div>
      <div className="modal-footer">
        <button type="button" className="button secondary" onClick={dismiss} disabled={task.busy}>Закрыть окно</button>
        <button type="submit" className="button primary" disabled={task.busy}><Play size={15} /> Проверить маршрут</button>
      </div>
    </form>
  </Modal>;
}

export function ProjectPacSettings({ projectId }: { projectId: number }) {
  const heading = useId();
  const uploadButton = useRef<HTMLButtonElement>(null);
  const path = `${base(projectId)}/proxy-pac`;
  const query = useQuery<SettingsResponse>(path);
  const [saved, setSaved] = useState<SettingsResponse>();
  const [dialog, setDialog] = useState<'upload' | 'preview' | 'disable'>();
  const data = saved ?? query.data;
  const pac = data?.pac;
  const uploadLabel = pac ? 'Заменить PAC-файл' : 'Загрузить PAC-файл';
  const close = () => setDialog(undefined);
  function update(value: SettingsResponse) { setSaved(value); close(); }
  return <section className="project-pac" aria-labelledby={heading}>
    <div className="project-pac-row">
      <div className="request-profile-summary">
        <h3 id={heading}>PAC-файл проекта</h3>
        {data && <span>{pac?.filename ?? 'PAC не настроен'}</span>}
      </div>
      {data && <div className="request-profile-actions">
        <button className="button small secondary" type="button" ref={uploadButton} onClick={() => setDialog('upload')}>
          <Upload size={15} /> {uploadLabel}
        </button>
        {pac && <>
          <button className="button small secondary" type="button" onClick={() => setDialog('preview')}>
            <Play size={15} /> Проверить маршрут
          </button>
          <button className="button small secondary danger-ghost" type="button" onClick={() => setDialog('disable')}>
            Отключить PAC
          </button>
        </>}
      </div>}
    </div>
    <p className="field-note">PAC выбирает прокси для проверок по правилам проекта. Прокси, указанный в HTTP-профиле, имеет приоритет.</p>
    <ErrorMessage text={query.error} />
    {query.error && <button className="button small secondary" type="button" onClick={query.refresh}>Повторить загрузку PAC</button>}
    {!data && !query.error && <Loading />}
    {dialog === 'upload' && <PacUpload path={path} title={uploadLabel} filename={pac?.filename} close={close} saved={update} />}
    {pac && dialog === 'preview' && <PacRoutePreview path={path} filename={pac.filename} close={close} />}
    {pac && dialog === 'disable' && <ConfirmDeletion title="Отключить PAC проекта?" label="Отключить PAC" close={close}
      fallbackFocus={() => uploadButton.current} confirm={async () => update(await api<SettingsResponse>(path, { method: 'DELETE' }))}>
      <p>Для новых проверок будут использоваться прокси из HTTP-профилей или прямое подключение.</p>
    </ConfirmDeletion>}
  </section>;
}
