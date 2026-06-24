import React from 'react'
import ReactDOM from 'react-dom/client'
import BCCApp from '../BCCApp.jsx'
import AuthGate from './components/AuthGate.jsx'

ReactDOM.createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <AuthGate>
      <BCCApp />
    </AuthGate>
  </React.StrictMode>,
)
