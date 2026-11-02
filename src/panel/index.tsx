import { createRoot } from 'react-dom/client';
import { App } from './App';
import { installHostResizeGuide } from './hostResize';
const container = document.getElementById('root');
if (!container) throw new Error('Missing panel root');
createRoot(container).render(<App />);
const removeResizeGuide = installHostResizeGuide();
window.addEventListener('pagehide', removeResizeGuide, { once: true });
