import React from 'react';
import ReactDOM from 'react-dom/client';
import { BrowserRouter, Routes, Route } from 'react-router-dom';
import { ItemListPage } from './pages/ItemListPage';
import { ItemDetailPage } from './pages/ItemDetailPage';
import { RolesEditorPage } from './pages/RolesEditorPage';
import { RepositoriesPage } from './pages/RepositoriesPage';
import { Layout } from './components/Layout';
import './index.css';

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <BrowserRouter>
      <Routes>
        <Route path="/" element={<Layout />}>
          <Route index element={<ItemListPage />} />
          <Route path="items/:id" element={<ItemDetailPage />} />
          <Route path="settings/roles" element={<RolesEditorPage />} />
          <Route path="settings/repositories" element={<RepositoriesPage />} />
        </Route>
      </Routes>
    </BrowserRouter>
  </React.StrictMode>
);
