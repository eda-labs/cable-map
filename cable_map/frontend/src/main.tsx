import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './nokia-fonts.css'
import './index.css'
import { AuthGate } from './AuthGate.tsx'
import Routes from './app/routes.tsx'

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <AuthGate>
      <Routes />
    </AuthGate>
  </StrictMode>,
)
