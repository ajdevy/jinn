//! The Jinn desktop shell.
//!
//! One window backed by the bundled web build. Gateway traffic crosses the
//! narrow native bridge; credentials never enter JavaScript.

// Without this, a release build opens a console window behind the app on
// Windows. The spike is macOS-only, but the attribute costs nothing and its
// absence is the kind of thing nobody remembers to add later.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod commands;
mod credentials;
mod deep_link;
mod display;
mod menu;
mod navigation;
mod origin;
mod probe;
mod stream;

use tauri::{
    utils::config::WebviewUrl,
    webview::{NewWindowResponse, PageLoadEvent, WebviewWindowBuilder},
};
use tauri_plugin_opener::OpenerExt;

const MAIN_WINDOW: &str = "main";

const BRIDGE_SCRIPT: &str = r#"
(() => {
  const internals = window.__TAURI_INTERNALS__;
  if (!internals || window.__JINN_NATIVE__) return;
  class Channel {
    constructor(onmessage) {
      this.id = internals.transformCallback((event) => {
        if (Object.prototype.hasOwnProperty.call(event, 'message')) onmessage(event.message);
        if (Object.prototype.hasOwnProperty.call(event, 'end')) internals.unregisterCallback(this.id);
      });
    }
    toJSON() { return `__CHANNEL__:${this.id}`; }
  }
  const invoke = (command, input) => internals.invoke(command, { input });
  Object.defineProperty(window, '__JINN_NATIVE__', {
    configurable: false,
    enumerable: false,
    writable: false,
    value: Object.freeze({
      runtime: 'tauri',
      pair: (input) => invoke('pair', input),
      request: (input) => invoke('request', input),
      stream: (input, onEvent) => {
        const on_event = new Channel(onEvent);
        return internals.invoke('stream', { input, onEvent: on_event });
      },
      forget: (input) => invoke('forget', input),
    }),
  });
})();
"#;

fn main() {
    let native_state =
        commands::NativeState::new().expect("the native gateway client could not be initialized");
    tauri::Builder::default()
        .manage(native_state)
        .plugin(tauri_plugin_window_state::Builder::default().build())
        .plugin(tauri_plugin_deep_link::init())
        .plugin(tauri_plugin_opener::init())
        .invoke_handler(tauri::generate_handler![
            commands::pair,
            commands::request,
            stream::stream,
            commands::forget,
            probe::report
        ])
        .on_page_load(|window, payload| match payload.event() {
            // Every navigation replaces the document, and with it the global the
            // probe reads, so it is published per page rather than once at startup.
            PageLoadEvent::Started => display::announce_refresh_rate(window),
            // The probe appends to `document.body`, which an init script would
            // run too early to see.
            PageLoadEvent::Finished if window.label() == probe::LABEL => probe::run(window),
            PageLoadEvent::Finished => {}
        })
        .setup(|app| {
            let navigation_handle = app.handle().clone();
            let popup_handle = app.handle().clone();
            let window =
                WebviewWindowBuilder::new(app, MAIN_WINDOW, WebviewUrl::App("index.html".into()))
                    .title("Jinn")
                    .inner_size(1280.0, 860.0)
                    .min_inner_size(390.0, 480.0)
                    .initialization_script(BRIDGE_SCRIPT)
                    .on_navigation(move |url| match navigation::decide(url) {
                        navigation::NavigationDecision::Local => true,
                        navigation::NavigationDecision::External => {
                            let _ = navigation_handle
                                .opener()
                                .open_url(url.as_str(), None::<&str>);
                            false
                        }
                        navigation::NavigationDecision::Deny => false,
                    })
                    .on_new_window(move |url, _| {
                        if navigation::decide(&url) == navigation::NavigationDecision::External {
                            let _ = popup_handle.opener().open_url(url.as_str(), None::<&str>);
                        }
                        NewWindowResponse::Deny
                    })
                    .build()?;
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
