use std::{
    fs,
    path::PathBuf,
    sync::{
        atomic::{AtomicBool, AtomicU64, Ordering},
        Mutex,
    },
    time::Duration,
};

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tauri::{
    image::Image,
    menu::{Menu, MenuItem, PredefinedMenuItem},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    AppHandle, Emitter, LogicalPosition, LogicalSize, Manager, State, Theme, WindowEvent,
};
use tauri_plugin_autostart::{MacosLauncher, ManagerExt as _};
use tauri_plugin_global_shortcut::{GlobalShortcutExt, ShortcutState};

const DEFAULT_SHORTCUT: &str = "Shift+1";

#[derive(Serialize, Deserialize, Clone, Copy)]
struct Bounds {
    x: f64,
    y: f64,
    width: f64,
    height: f64,
}

#[derive(Serialize, Deserialize, Clone)]
#[serde(default)]
struct Settings {
    shortcut: String,
    theme: String,
    bounds: Option<Bounds>,
}

impl Default for Settings {
    fn default() -> Self {
        Settings { shortcut: DEFAULT_SHORTCUT.into(), theme: "system".into(), bounds: None }
    }
}

struct AppState {
    settings: Mutex<Settings>,
    dir: PathBuf,
    fullscreen: AtomicBool,
    bounds_gen: AtomicU64,
}

impl AppState {
    fn state_file(&self) -> PathBuf {
        self.dir.join("notes-state.json")
    }
    fn settings_file(&self) -> PathBuf {
        self.dir.join("settings.json")
    }
    fn save_settings(&self) {
        let s = self.settings.lock().unwrap().clone();
        if let Ok(txt) = serde_json::to_string(&s) {
            let _ = fs::write(self.settings_file(), txt);
        }
    }
}

// The Electron build kept its files in ~/Library/Application Support/notNotes; pick them up once.
fn migrate_electron_files(dir: &PathBuf) {
    let Some(home) = std::env::var_os("HOME") else { return };
    let old = PathBuf::from(home).join("Library/Application Support/notNotes");
    for name in ["notes-state.json", "settings.json"] {
        let (from, to) = (old.join(name), dir.join(name));
        if !to.exists() && from.exists() {
            let _ = fs::copy(from, to);
        }
    }
}

fn read_json(path: &PathBuf) -> Option<Value> {
    serde_json::from_str(&fs::read_to_string(path).ok()?).ok()
}

// macOS: the window becomes a non-activating floating panel, the only kind of window that follows you
// across Spaces and sits over full-screen apps.
#[cfg(target_os = "macos")]
tauri_nspanel::tauri_panel! {
    panel!(NotPanel {
        config: {
            can_become_key_window: true,
            is_floating_panel: true
        }
    })
}

#[cfg(target_os = "macos")]
fn make_panel(w: &tauri::WebviewWindow) {
    use tauri_nspanel::{CollectionBehavior, PanelLevel, StyleMask, WebviewWindowExt};
    let panel = w.to_panel::<NotPanel>().expect("panel conversion");
    panel.set_level(PanelLevel::Floating.value());
    panel
        .add_style_mask(StyleMask::empty().nonactivating_panel().into())
        .expect("non-activating panel");
    panel.set_collection_behavior(
        CollectionBehavior::new().full_screen_auxiliary().can_join_all_spaces().into(),
    );
}

fn show(app: &AppHandle) {
    if let Some(w) = app.get_webview_window("main") {
        let _ = w.unminimize();
        #[cfg(target_os = "macos")]
        match tauri_nspanel::ManagerExt::get_webview_panel(app, "main") {
            Ok(p) => p.show_and_make_key(),
            Err(_) => { let _ = w.show(); let _ = w.set_focus(); }
        }
        #[cfg(not(target_os = "macos"))]
        {
            let _ = w.set_always_on_top(true);
            let _ = w.show();
            let _ = w.set_focus();
        }
        let _ = app.emit("shown", ());
    }
}

fn toggle(app: &AppHandle) {
    if let Some(w) = app.get_webview_window("main") {
        if w.is_visible().unwrap_or(false) && w.is_focused().unwrap_or(false) {
            let _ = w.hide();
        } else {
            show(app);
        }
    }
}

fn register(app: &AppHandle, acc: &str) -> bool {
    app.global_shortcut()
        .on_shortcut(acc, |app, _s, ev| {
            if ev.state() == ShortcutState::Pressed {
                toggle(app);
            }
        })
        .is_ok()
}

fn apply_theme(app: &AppHandle, t: &str) {
    app.set_theme(match t {
        "light" => Some(Theme::Light),
        "dark" => Some(Theme::Dark),
        _ => None,
    });
}

#[tauri::command]
fn load(app: AppHandle, state: State<AppState>) -> Value {
    let s = state.settings.lock().unwrap().clone();
    json!({
        "state": read_json(&state.state_file()),
        "shortcut": s.shortcut,
        "loginItem": app.autolaunch().is_enabled().unwrap_or(false),
        "theme": s.theme,
    })
}

#[tauri::command]
fn save(state: State<AppState>, data: Value) {
    let tmp = state.dir.join("notes-state.json.tmp");
    if fs::write(&tmp, data.to_string()).is_ok() {
        let _ = fs::rename(tmp, state.state_file());
    }
}

#[tauri::command]
fn set_shortcut(app: AppHandle, state: State<AppState>, acc: String) -> Value {
    let prev = state.settings.lock().unwrap().shortcut.clone();
    let _ = app.global_shortcut().unregister(prev.as_str());
    if register(&app, &acc) {
        state.settings.lock().unwrap().shortcut = acc;
        state.save_settings();
        json!({ "ok": true })
    } else {
        register(&app, &prev);
        json!({ "ok": false })
    }
}

#[tauri::command]
fn set_theme(app: AppHandle, state: State<AppState>, t: String) -> String {
    if !["light", "dark", "system"].contains(&t.as_str()) {
        return state.settings.lock().unwrap().theme.clone();
    }
    state.settings.lock().unwrap().theme = t.clone();
    state.save_settings();
    apply_theme(&app, &t);
    t
}

#[tauri::command]
fn set_login_item(app: AppHandle, on: bool) -> bool {
    let al = app.autolaunch();
    let _ = if on { al.enable() } else { al.disable() };
    al.is_enabled().unwrap_or(false)
}

#[tauri::command]
fn toggle_fullscreen(app: AppHandle) {
    if let Some(w) = app.get_webview_window("main") {
        let _ = w.set_fullscreen(!w.is_fullscreen().unwrap_or(false));
    }
}

#[tauri::command]
fn hide_window(app: AppHandle) {
    if let Some(w) = app.get_webview_window("main") {
        let _ = w.hide();
    }
}

pub fn run() {
    let app = tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| show(app)))
        .plugin(tauri_nspanel::init())
        .plugin(tauri_plugin_global_shortcut::Builder::new().build())
        .plugin(tauri_plugin_autostart::init(MacosLauncher::LaunchAgent, None))
        .invoke_handler(tauri::generate_handler![
            load, save, set_shortcut, set_theme, set_login_item, toggle_fullscreen, hide_window
        ])
        .setup(|app| {
            #[cfg(target_os = "macos")]
            app.set_activation_policy(tauri::ActivationPolicy::Accessory);

            let dir = app.path().app_data_dir()?;
            fs::create_dir_all(&dir)?;
            migrate_electron_files(&dir);
            let st = AppState {
                settings: Mutex::new(Settings::default()),
                dir,
                fullscreen: AtomicBool::new(false),
                bounds_gen: AtomicU64::new(0),
            };
            if let Some(v) = read_json(&st.settings_file()) {
                if let Ok(s) = serde_json::from_value::<Settings>(v) {
                    *st.settings.lock().unwrap() = s;
                }
            }
            let settings = st.settings.lock().unwrap().clone();
            app.manage(st);
            let handle = app.handle().clone();
            apply_theme(&handle, &settings.theme);

            let win = app.get_webview_window("main").expect("main window");
            if let Some(b) = settings.bounds {
                // Only restore a position that is still on some screen.
                let on_screen = win.available_monitors().map(|ms| {
                    ms.iter().any(|m| {
                        let sf = m.scale_factor();
                        let (p, s) = (m.position().to_logical::<f64>(sf), m.size().to_logical::<f64>(sf));
                        b.x >= p.x - 50.0 && b.y >= p.y - 50.0 && b.x < p.x + s.width - 50.0 && b.y < p.y + s.height - 50.0
                    })
                });
                if on_screen.unwrap_or(false) {
                    let _ = win.set_size(LogicalSize::new(b.width, b.height));
                    let _ = win.set_position(LogicalPosition::new(b.x, b.y));
                }
            }

            #[cfg(target_os = "macos")]
            make_panel(&win);
            let w = win.clone();
            let h = handle.clone();
            win.on_window_event(move |ev| match ev {
                WindowEvent::CloseRequested { api, .. } => {
                    // Closing hides so the app stays ready for the shortcut.
                    api.prevent_close();
                    let _ = w.hide();
                }
                WindowEvent::Moved(_) | WindowEvent::Resized(_) => {
                    let st = h.state::<AppState>();
                    let fs_now = w.is_fullscreen().unwrap_or(false);
                    if st.fullscreen.swap(fs_now, Ordering::SeqCst) != fs_now {
                        let _ = h.emit("fullscreen", fs_now);
                    }
                    if fs_now {
                        return;
                    }
                    let gen = st.bounds_gen.fetch_add(1, Ordering::SeqCst) + 1;
                    let (w2, h2) = (w.clone(), h.clone());
                    std::thread::spawn(move || {
                        std::thread::sleep(Duration::from_millis(400));
                        let st = h2.state::<AppState>();
                        if st.bounds_gen.load(Ordering::SeqCst) != gen {
                            return;
                        }
                        let sf = w2.scale_factor().unwrap_or(1.0);
                        if let (Ok(p), Ok(s)) = (w2.outer_position(), w2.inner_size()) {
                            let (p, s) = (p.to_logical::<f64>(sf), s.to_logical::<f64>(sf));
                            st.settings.lock().unwrap().bounds =
                                Some(Bounds { x: p.x, y: p.y, width: s.width, height: s.height });
                            st.save_settings();
                        }
                    });
                }
                _ => {}
            });

            let toggle_i = MenuItem::with_id(app, "toggle", "Show / Hide", true, None::<&str>)?;
            let sc_i = MenuItem::with_id(app, "sc", format!("Shortcut: {}", settings.shortcut), false, None::<&str>)?;
            let quit_i = MenuItem::with_id(app, "quit", "Quit jotz", true, None::<&str>)?;
            let menu = Menu::with_items(app, &[&toggle_i, &sc_i, &PredefinedMenuItem::separator(app)?, &quit_i])?;
            TrayIconBuilder::new()
                .icon(Image::from_bytes(include_bytes!("../../src/assets/tray.png"))?)
                .tooltip("jotz")
                .menu(&menu)
                .show_menu_on_left_click(false)
                .on_menu_event(|app, ev| match ev.id().as_ref() {
                    "toggle" => toggle(app),
                    "quit" => app.exit(0),
                    _ => {}
                })
                .on_tray_icon_event(|tray, ev| {
                    if let TrayIconEvent::Click { button: MouseButton::Left, button_state: MouseButtonState::Up, .. } = ev {
                        toggle(tray.app_handle());
                    }
                })
                .build(app)?;

            if !register(&handle, &settings.shortcut) {
                eprintln!("Could not register shortcut {}", settings.shortcut);
            }
            show(&handle);
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("error while building jotz");

    app.run(|app, ev| match ev {
        // The window is only reliably on screen once the event loop is up (setup runs too early).
        tauri::RunEvent::Ready => show(app),
        #[cfg(target_os = "macos")]
        tauri::RunEvent::Reopen { .. } => show(app),
        _ => {}
    });
}
