import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { Phase0App } from './Phase0App';
import './styles.css';

const root = document.getElementById('root');
if (!root) throw new Error('#root missing');
createRoot(root).render(
  <StrictMode>
    <Phase0App />
  </StrictMode>,
);
