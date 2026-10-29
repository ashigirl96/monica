import { MobileWorkbench } from '@monica/workbench/mobile'
import { createRoot } from 'react-dom/client'

const root = document.getElementById('root')
if (root) createRoot(root).render(<MobileWorkbench />)
