import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';
import './styles.css';

async function mount() {
  // Browser previews use simulated data. The desktop preload always takes precedence.
  if (import.meta.env.DEV && !window.manager) {
    const { createDemoManager } = await import('./demo');
    window.manager = createDemoManager();
  }
  ReactDOM.createRoot(document.getElementById('root')!).render(
    <React.StrictMode><App /></React.StrictMode>,
  );
}
void mount();
