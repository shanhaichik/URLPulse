import { requestProfilesMessages } from '../shared/i18n/locales/request-profiles.js';
import type { RequestProfilesView, RequestSecretInput, RequestSecretView } from '../shared/request-profiles.js';
import { createMessages } from './i18n.js';

const useText = createMessages('request-profiles', requestProfilesMessages);
export type SecretMode = RequestProfilesView['secretMode'];

export function readSecret(form: FormData, name: string, mode: SecretMode): RequestSecretInput | undefined {
  const value = String(form.get(name) ?? '');
  if (!value) return undefined;
  return mode === 'desktop' ? { value } : { environment: value.trim() };
}

export function SecretField({ name, label, environmentLabel, mode, saved }: {
  name: string; label: string; environmentLabel: string; mode: SecretMode; saved?: RequestSecretView;
}) {
  const t = useText();
  const configured = saved?.configured ?? false;
  return <div className="request-secret-field">
    <label>{mode === 'desktop' ? label : environmentLabel}
      <input name={name} required={!configured} type={mode === 'desktop' ? 'password' : 'text'}
        autoComplete={mode === 'desktop' ? 'new-password' : 'off'} spellCheck={false}
        placeholder={mode === 'environment' && !configured ? 'PULSE_REQUEST_SECRET_…' : undefined} />
    </label>
    {configured && <p className="field-note"><strong>{t('secretConfigured')}</strong>{saved?.environment && <> · {saved.environment}</>}<br />
      {t('retainSecret')}</p>}
  </div>;
}
