import React from 'react';
import ReactDOM from 'react-dom/client';
import { BrowserRouter, Routes, Route } from 'react-router-dom';

import Login from './pages/login/login.jsx';
import Dashboard from './pages/dashboard/Dashboard.jsx';
import ModuleHub from './pages/modulehub/ModuleHub.jsx';
import './pages/dashboard/Dashboard.css';

import IMSettings from './pages/im/IMSettings.jsx';
import IMWorkspace from './pages/im/IMWorkspace.jsx';

import FSAWorkspace from './pages/fsa/FSAWorkspace.jsx';
import FSASettings from './pages/fsa/FSASettings.jsx';

ReactDOM.createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <BrowserRouter>
      <Routes>
        <Route path="/login" element={<Login />} />
        <Route path="/" element={<Dashboard />} />
        <Route path="/module-hub" element={<ModuleHub />} />

        <Route path="/im-settings" element={<IMSettings />} />
        <Route path="/im" element={<IMWorkspace />} />

        <Route path="/fsa" element={<FSAWorkspace />} />
        <Route path="/fsa-settings" element={<FSASettings />} />
      </Routes>
    </BrowserRouter>
  </React.StrictMode>
);