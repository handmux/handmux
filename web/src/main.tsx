import { createRoot } from 'react-dom/client';
import App from './App.jsx';
import { registerServiceWorker } from './sw-register.js';
import './styles.css';

declare global {
  interface Window {
    __hideBootSplash?: () => void;
  }
}

const root = document.getElementById('root');
if (!root) throw new Error('Missing application root');
createRoot(root).render(<App />);
registerServiceWorker();

// Fade out the inline boot splash once React has painted AND the app CSS is ready.
// asyncAppCss (vite.config.js) loads the stylesheet with media="print" so it doesn't block the
// splash's first paint. The tradeoff: if CSS hasn't arrived by the time React mounts, hiding the
// splash immediately reveals an unstyled page. We wait for the link's load event to be safe.
if (typeof window !== 'undefined' && window.__hideBootSplash) {
  const cssLinks = [...document.querySelectorAll<HTMLLinkElement>('link[rel="stylesheet"]')]
    .filter((link) => link.media === 'print');
  const waitCss = cssLinks.length
    ? new Promise<void>((resolve) => {
      let remaining = cssLinks.length;
      cssLinks.forEach((link) => link.addEventListener('load', () => {
        remaining -= 1;
        if (remaining === 0) resolve();
      }, { once: true }));
    })
    : Promise.resolve();
  requestAnimationFrame(() => requestAnimationFrame(() => {
    void waitCss.then(() => window.__hideBootSplash?.());
  }));
}
