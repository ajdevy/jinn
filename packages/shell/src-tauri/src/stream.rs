use base64::{engine::general_purpose::STANDARD as BASE64, Engine as _};
use futures_util::{SinkExt, StreamExt};
use serde::{Deserialize, Serialize};
use std::{
    collections::HashMap,
    sync::{
        atomic::{AtomicU64, Ordering},
        Arc, Mutex,
    },
};
use tauri::{ipc::Channel, State, WebviewWindow};
use tokio::sync::mpsc;
use tokio_tungstenite::tungstenite::{client::IntoClientRequest, http::header, Message};

use crate::{
    commands::{trusted_document, NativeError, NativeState},
    origin::{CanonicalOrigin, GatewayTarget},
};

static NEXT_STREAM_ID: AtomicU64 = AtomicU64::new(1);

pub enum OutgoingFrame {
    Text(String),
    Binary(Vec<u8>),
    Close,
}

pub struct OpenStream {
    pub origin: CanonicalOrigin,
    pub sender: mpsc::UnboundedSender<OutgoingFrame>,
}

pub type StreamRegistry = Arc<Mutex<HashMap<String, OpenStream>>>;

#[derive(Deserialize)]
#[serde(tag = "action", rename_all = "camelCase")]
pub enum StreamInput {
    Open {
        target: GatewayTarget,
        path: String,
    },
    Send {
        stream_id: String,
        text: Option<String>,
        bytes_base64: Option<String>,
    },
    Close {
        stream_id: String,
    },
}

#[derive(Clone, Serialize)]
#[serde(tag = "event", rename_all = "camelCase")]
pub enum StreamEvent {
    Opened {
        stream_id: String,
    },
    Message {
        stream_id: String,
        text: Option<String>,
        bytes_base64: Option<String>,
    },
    Closed {
        stream_id: String,
        code: Option<u16>,
        reason: String,
    },
    Failed {
        stream_id: String,
        code: &'static str,
        message: &'static str,
    },
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StreamReceipt {
    pub stream_id: String,
}

fn confine(window: &WebviewWindow) -> Result<(), NativeError> {
    let url = window.url().map_err(|_| NativeError::denied())?;
    trusted_document(window.label(), &url)
        .then_some(())
        .ok_or_else(NativeError::denied)
}

#[tauri::command]
pub async fn stream(
    window: WebviewWindow,
    state: State<'_, NativeState>,
    input: StreamInput,
    on_event: Channel<StreamEvent>,
) -> Result<StreamReceipt, NativeError> {
    confine(&window)?;
    match input {
        StreamInput::Open { target, path } => {
            let origin = CanonicalOrigin::parse(&target.origin)?;
            let credential = state
                .credentials
                .get(&origin)?
                .ok_or_else(NativeError::not_paired)?;
            let mut url = origin.request_url(&path)?;
            url.set_scheme(if url.scheme() == "https" { "wss" } else { "ws" })
                .map_err(|_| NativeError::invalid_origin())?;
            let mut request = url
                .as_str()
                .into_client_request()
                .map_err(|_| NativeError::invalid_path())?;
            request.headers_mut().insert(
                header::COOKIE,
                credential
                    .cookie_header
                    .parse()
                    .map_err(|_| NativeError::credential_store())?,
            );
            let id = format!("stream-{}", NEXT_STREAM_ID.fetch_add(1, Ordering::Relaxed));
            let (sender, receiver) = mpsc::unbounded_channel();
            state
                .streams
                .lock()
                .map_err(|_| NativeError::transport())?
                .insert(id.clone(), OpenStream { origin, sender });
            let registry = state.streams.clone();
            let task_id = id.clone();
            tauri::async_runtime::spawn(run_socket(task_id, request, receiver, on_event, registry));
            Ok(StreamReceipt { stream_id: id })
        }
        StreamInput::Send {
            stream_id,
            text,
            bytes_base64,
        } => {
            let frame = match (text, bytes_base64) {
                (Some(text), None) => OutgoingFrame::Text(text),
                (None, Some(bytes)) => OutgoingFrame::Binary(
                    BASE64
                        .decode(bytes)
                        .map_err(|_| NativeError::invalid_request())?,
                ),
                _ => return Err(NativeError::invalid_request()),
            };
            state
                .streams
                .lock()
                .map_err(|_| NativeError::transport())?
                .get(&stream_id)
                .ok_or_else(NativeError::unknown_stream)?
                .sender
                .send(frame)
                .map_err(|_| NativeError::unknown_stream())?;
            Ok(StreamReceipt { stream_id })
        }
        StreamInput::Close { stream_id } => {
            if let Some(open) = state
                .streams
                .lock()
                .map_err(|_| NativeError::transport())?
                .remove(&stream_id)
            {
                let _ = open.sender.send(OutgoingFrame::Close);
            }
            Ok(StreamReceipt { stream_id })
        }
    }
}

async fn run_socket(
    stream_id: String,
    request: http::Request<()>,
    mut receiver: mpsc::UnboundedReceiver<OutgoingFrame>,
    channel: Channel<StreamEvent>,
    registry: StreamRegistry,
) {
    let Ok((socket, _)) = tokio_tungstenite::connect_async(request).await else {
        let _ = channel.send(StreamEvent::Failed {
            stream_id: stream_id.clone(),
            code: "stream-failed",
            message: "The gateway stream could not connect",
        });
        registry
            .lock()
            .ok()
            .map(|mut streams| streams.remove(&stream_id));
        return;
    };
    if channel
        .send(StreamEvent::Opened {
            stream_id: stream_id.clone(),
        })
        .is_err()
    {
        registry
            .lock()
            .ok()
            .map(|mut streams| streams.remove(&stream_id));
        return;
    }
    let (mut writer, mut reader) = socket.split();
    loop {
        tokio::select! {
            outgoing = receiver.recv() => match outgoing {
                Some(OutgoingFrame::Text(text)) => if writer.send(Message::Text(text.into())).await.is_err() { break; },
                Some(OutgoingFrame::Binary(bytes)) => if writer.send(Message::Binary(bytes.into())).await.is_err() { break; },
                Some(OutgoingFrame::Close) | None => { let _ = writer.send(Message::Close(None)).await; break; }
            },
            incoming = reader.next() => match incoming {
                Some(Ok(Message::Text(text))) => if channel.send(StreamEvent::Message {
                    stream_id: stream_id.clone(), text: Some(text.to_string()), bytes_base64: None,
                }).is_err() { break; },
                Some(Ok(Message::Binary(bytes))) => if channel.send(StreamEvent::Message {
                    stream_id: stream_id.clone(), text: None, bytes_base64: Some(BASE64.encode(bytes)),
                }).is_err() { break; },
                Some(Ok(Message::Close(frame))) => {
                    let (code, reason) = frame.map(|frame| (Some(frame.code.into()), frame.reason.to_string()))
                        .unwrap_or((None, String::new()));
                    let _ = channel.send(StreamEvent::Closed { stream_id: stream_id.clone(), code, reason });
                    break;
                }
                Some(Ok(Message::Ping(bytes))) => if writer.send(Message::Pong(bytes)).await.is_err() { break; },
                Some(Ok(Message::Pong(_))) | Some(Ok(Message::Frame(_))) => {}
                Some(Err(_)) | None => break,
            }
        }
    }
    registry
        .lock()
        .ok()
        .map(|mut streams| streams.remove(&stream_id));
    let _ = channel.send(StreamEvent::Closed {
        stream_id,
        code: None,
        reason: String::new(),
    });
}

pub fn close_origin_streams(registry: &StreamRegistry, origin: &CanonicalOrigin) {
    if let Ok(mut streams) = registry.lock() {
        let ids = streams
            .iter()
            .filter_map(|(id, open)| (open.origin == *origin).then_some(id.clone()))
            .collect::<Vec<_>>();
        for id in ids {
            if let Some(open) = streams.remove(&id) {
                let _ = open.sender.send(OutgoingFrame::Close);
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::{close_origin_streams, OpenStream, OutgoingFrame, StreamRegistry};
    use crate::origin::CanonicalOrigin;
    use std::{
        collections::HashMap,
        sync::{Arc, Mutex},
    };
    use tokio::sync::mpsc;

    #[test]
    fn forgetting_one_origin_closes_only_its_streams() {
        let a = CanonicalOrigin::parse("http://127.0.0.1:7779").unwrap();
        let b = CanonicalOrigin::parse("http://127.0.0.1:7780").unwrap();
        let (a_tx, mut a_rx) = mpsc::unbounded_channel();
        let (b_tx, mut b_rx) = mpsc::unbounded_channel();
        let registry: StreamRegistry = Arc::new(Mutex::new(HashMap::from([
            (
                "a".into(),
                OpenStream {
                    origin: a.clone(),
                    sender: a_tx,
                },
            ),
            (
                "b".into(),
                OpenStream {
                    origin: b,
                    sender: b_tx,
                },
            ),
        ])));
        close_origin_streams(&registry, &a);
        assert!(matches!(a_rx.try_recv(), Ok(OutgoingFrame::Close)));
        assert!(b_rx.try_recv().is_err());
        assert!(registry.lock().unwrap().contains_key("b"));
    }
}
