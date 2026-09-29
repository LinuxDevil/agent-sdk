import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import './theme.css';
import { App } from './App';

const container = document.getElementById('root');
if (!container) throw new Error('main.tsx: #root element not found');

createRoot(container).render(
  <StrictMode>
    <App />
  </StrictMode>
);
