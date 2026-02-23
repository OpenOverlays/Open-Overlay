import React from 'react';
import Designer from './components/Designer';

import Titlebar from './components/Titlebar';

// Tauri app: the designer is always the main window.
// OBS browser source is served via the embedded HTTP server at localhost:7878/overlay/{id}
export default function App() {
  return (
    <div className="flex flex-col h-screen overflow-hidden bg-[#050505]">
      <Titlebar />
      <div className="flex-1 overflow-hidden relative">
        <Designer />
      </div>
    </div>
  );
}
