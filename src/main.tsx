import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';
import './styles.css';

function StartupError({ detail }: { detail: string }) {
  return (
    <div className="loading-screen startup-error" role="alert">
      <div className="brand-symbol"><span /><span /><span /></div>
      <strong>botLANd could not connect to its desktop process.</strong>
      <p>{detail}</p>
      <p>Close this window and reopen botLANd. If the problem continues, reinstall the app.</p>
    </div>
  );
}

function renderStartupError(detail: string) {
  const element = document.getElementById('root');
  if (!element) return;
  ReactDOM.createRoot(element).render(
    <React.StrictMode><StartupError detail={detail} /></React.StrictMode>,
  );
}

async function mount() {
  // Browser previews use simulated data. The desktop preload always takes precedence.
  if (!window.manager) {
    if (import.meta.env.DEV) {
      try {
        const { createDemoManager } = await import('./demo');
        window.manager = createDemoManager();
      } catch {
        renderStartupError('The browser preview could not be loaded.');
        return;
      }
    } else {
      renderStartupError('The secure bridge to the local server manager did not load.');
      return;
    }
  }
  ReactDOM.createRoot(document.getElementById('root')!).render(
    <React.StrictMode><App /></React.StrictMode>,
  );
}
void mount().catch(() => renderStartupError('The application could not start.'));
