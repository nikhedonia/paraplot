import { createRoot } from 'react-dom/client';
import { initAnalytics } from './analytics';
import { App } from './ui/App';
import './styles.css';

initAnalytics();

const root = document.getElementById('root');
if (!root) throw new Error('missing #root');
createRoot(root).render(<App />);
