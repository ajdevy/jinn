//! The Jinn desktop shell.
//!
//! One window, pointed at the operator's own running gateway. The URL is not in
//! this crate: `tauri.config.ts` reads it from the environment at sync time and
//! writes `tauri.conf.gen.json`, which the Tauri CLI merges over
//! `tauri.conf.json`. See README.md for why the shell loads the gateway rather
//! than bundling the web build.

// Without this, a release build opens a console window behind the app on
// Windows. The spike is macOS-only, but the attribute costs nothing and its
// absence is the kind of thing nobody remembers to add later.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod deep_link;
mod display;
mod menu;
mod probe;

use tauri::webview::PageLoadEvent;
use tauri::Manager;

/// The label `buildConfigOverlay` gives the one window the shell opens.
const MAIN_WINDOW: &str = "main";

const NO_WINDOW: &str = "no \"main\" window in the merged config. The window is generated, not \
committed: run `JINN_SHELL_SERVER_URL=<gateway> pnpm --filter @jinn/shell-desktop desktop:dev`, \
which syncs tauri.conf.gen.json before starting Tauri.";

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_window_state::Builder::default().build())
        .plugin(tauri_plugin_deep_link::init())
        .invoke_handler(tauri::generate_handler![probe::report])
        .on_page_load(|window, payload| match payload.event() {
            // Every navigation replaces the document, and with it the global the
            // probe reads, so it is published per page rather than once at startup.
            PageLoadEvent::Started => display::announce_refresh_rate(&window),
            // The probe appends to `document.body`, which an init script would
            // run too early to see.
            PageLoadEvent::Finished if window.label() == probe::LABEL => probe::run(&window),
            PageLoadEvent::Finished => {}
        })
        .setup(|app| {
            let window = app.get_webview_window(MAIN_WINDOW).ok_or(NO_WINDOW)?;
            menu::install(app.handle(), &window)?;
            deep_link::route_into(app.handle(), window);
            if probe::requested() {
                probe::open(app.handle())?;
            }
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("the Jinn desktop shell failed to start");
}
