/** Standalone page entry for /workmate/ (IIFE, React inlined). */
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { ProposalPanel } from './App'

const container = document.getElementById('root')
if (container) {
  createRoot(container).render(
    <StrictMode>
      <ProposalPanel />
    </StrictMode>,
  )
}
