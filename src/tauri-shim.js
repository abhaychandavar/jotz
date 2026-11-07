// Exposes window.api (load, save, theme, shortcut, …) on top of the Tauri commands in src-tauri/src/lib.rs.
if (!window.api && window.__TAURI__) {
  const { invoke } = window.__TAURI__.core;
  const { listen } = window.__TAURI__.event;
  const save = (data) => { invoke('save', { data }); };
  window.api = {
    load: () => invoke('load'),
    save,
    saveSync: save,
    setShortcut: (acc) => invoke('set_shortcut', { acc }),
    setTheme: (t) => invoke('set_theme', { t }),
    setLoginItem: (on) => invoke('set_login_item', { on }),
    toggleFullscreen: () => invoke('toggle_fullscreen'),
    hide: () => invoke('hide_window'),
    onFullscreen: (cb) => { listen('fullscreen', (e) => cb(e.payload)); },
    onShown: (cb) => { listen('shown', () => cb()); },
  };
}
