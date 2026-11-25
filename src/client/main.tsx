import type { ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import { I18nextProvider, useTranslation } from 'react-i18next';
import { bindTranslator, parseLocale } from '../shared/i18n/index.js';
import { browserI18n, createMessages, currentLocale, initializeLanguage, LanguageContext } from './i18n.js';
import { workspaceMessages } from '../shared/i18n/locales/workspace.js';
import App from './app.js';
import './style.css';

const root = createRoot(document.getElementById('root')!);
const useText = createMessages('workspace', workspaceMessages);

function SessionError() {
  const t = useText();
  return <main className="workspace"><p className="error-message" role="alert">{t('sessionFailed')}</p></main>;
}

function LocalizedContent({ children }: { children: ReactNode }) {
  const { i18n } = useTranslation('workspace', { useSuspense: false });
  return <LanguageContext.Provider value={parseLocale(i18n.language)}>{children}</LanguageContext.Provider>;
}

function render(content: ReactNode) {
  root.render(<I18nextProvider i18n={browserI18n}><LocalizedContent>{content}</LocalizedContent></I18nextProvider>);
}

function updateDocumentLanguage() {
  const locale = currentLocale();
  document.documentElement.lang = locale;
  document.title = bindTranslator<keyof typeof workspaceMessages>(browserI18n, locale, 'workspace')('documentTitle');
}

async function openApp() {
  await initializeLanguage();
  updateDocumentLanguage();
  browserI18n.on('languageChanged', updateDocumentLanguage);
  const access = !window.pulseDesktop && new URLSearchParams(window.location.hash.slice(1)).get('access');
  if (access) {
    history.replaceState(history.state, '', window.location.pathname + window.location.search);
    try {
      const response = await fetch('/api/session', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ key: access }),
      });
      if (!response.ok) throw new Error();
    } catch {
      render(<SessionError />);
      return;
    }
  }
  render(<App />);
}

void openApp();
