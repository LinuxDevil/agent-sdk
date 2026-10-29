import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import './fonts.css';
import './theme.css';
import { App } from './App';
import { applyStoredTheme } from './shell/theme';

applyStoredTheme();

const container = document.getElementById('root');
if (!container) throw new Error('main.tsx: #root element not found');

createRoot(container).render(
  <StrictMode>
    <App />
  </StrictMode>
);
