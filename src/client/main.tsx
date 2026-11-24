import { createRoot } from 'react-dom/client';
import App from './app.js';
import './style.css';

const root = createRoot(document.getElementById('root')!);

async function openApp() {
  const access = !window.pulseDesktop && new URLSearchParams(window.location.hash.slice(1)).get('access');
  if (access) {
    history.replaceState(history.state, '', window.location.pathname + window.location.search);
    try {
      const response = await fetch('/api/session', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ key: access }),
      });
      if (!response.ok) throw new Error();
    } catch {
      root.render(<main className="workspace"><p className="error-message" role="alert">
        Не удалось открыть сессию. Откройте актуальную ссылку из терминала Пульса URL.
      </p></main>);
      return;
    }
  }
  root.render(<App />);
}

void openApp();
