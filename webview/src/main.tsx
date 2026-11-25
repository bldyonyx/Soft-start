import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.tsx'
import watermark from './watermark.svg'

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <img className="dashboard-watermark" src={watermark} alt="" aria-hidden="true" />
    <App />
  </StrictMode>,
)
