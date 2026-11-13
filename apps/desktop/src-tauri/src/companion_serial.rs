//! Narrow USB serial bridge for pairing the Aelys board from the Mac app (WKWebView has no Web Serial).
//!
//! It only lists and opens Espressif USB-Serial/JTAG ports (one at a time) and only writes single,
//! checksum-valid Improv RPC frames, so a compromised webview cannot talk to other serial devices
//! or send arbitrary bytes. Frame bytes, Wi-Fi passwords and the pairing secret pass through as
//! opaque data and are never logged; errors are fixed codes without paths or bytes.

use serialport::{SerialPort, SerialPortType};
use std::io::{self, Read, Write};
use std::sync::{Arc, Mutex, MutexGuard};
use std::time::Duration;
use tauri::{State, WebviewWindow};

const BAUD: u32 = 115_200; // ignored by USB CDC, but the API needs one
const READ_TIMEOUT: Duration = Duration::from_millis(100);
const MAX_FRAME: usize = 10 + 255; // "IMPROV", version, type, length, 255 data bytes, checksum

type Port = Arc<Mutex<Box<dyn SerialPort>>>;
struct Open {
    reader: Port,
    writer: Port,
}
#[derive(Default)]
pub struct SerialState(Arc<Mutex<Option<Open>>>);

fn lock<T>(m: &Mutex<T>) -> MutexGuard<'_, T> {
    m.lock().unwrap_or_else(|e| e.into_inner())
}

/// Espressif USB-Serial/JTAG, the only device the board enumerates as.
fn is_companion_port(vid: u16, pid: u16) -> bool {
    (vid, pid) == (0x303A, 0x1001)
}

/// Exactly one complete Improv v1 RPC frame (type 0x03, <= 255 data bytes, byte-sum checksum).
fn valid_improv_rpc(frame: &[u8]) -> bool {
    frame.len() >= 10
        && frame.len() <= MAX_FRAME
        && frame.starts_with(b"IMPROV")
        && frame[6] == 1
        && frame[7] == 0x03
        && frame.len() == 10 + frame[8] as usize
        && frame[..frame.len() - 1]
            .iter()
            .fold(0u8, |a, b| a.wrapping_add(*b))
            == frame[frame.len() - 1]
}

/// Same local-origin rule as the other desktop commands: only the app's own main window.
fn window_allowed(label: &str, url: &tauri::Url, debug: bool) -> bool {
    let local =
        (url.scheme() == "tauri" && url.host_str() == Some("localhost") && url.port().is_none())
            || (debug
                && url.scheme() == "http"
                && url.host_str() == Some("127.0.0.1")
                && url.port() == Some(5173));
    label == "main" && local && url.username().is_empty() && url.password().is_none()
}

fn check_window(window: &WebviewWindow) -> Result<(), String> {
    let url = window.url().map_err(|_| "FORBIDDEN")?;
    if window_allowed(window.label(), &url, cfg!(debug_assertions)) {
        Ok(())
    } else {
        Err("FORBIDDEN".into())
    }
}

/// One read: bytes, empty on timeout, "DISCONNECTED" when the device is gone (EOF or a hard error).
fn read_chunk(port: &mut impl Read, max: usize) -> Result<Vec<u8>, String> {
    let mut buf = vec![0u8; max.clamp(1, 4096)];
    match port.read(&mut buf) {
        Ok(0) => Err("DISCONNECTED".into()),
        Ok(n) => {
            buf.truncate(n);
            Ok(buf)
        }
        Err(e)
            if matches!(
                e.kind(),
                io::ErrorKind::TimedOut | io::ErrorKind::Interrupted
            ) =>
        {
            Ok(Vec::new())
        }
        Err(_) => Err("DISCONNECTED".into()),
    }
}

fn list_ports() -> Vec<String> {
    serialport::available_ports()
        .unwrap_or_default()
        .into_iter()
        .filter(|p| matches!(&p.port_type, SerialPortType::UsbPort(u) if is_companion_port(u.vid, u.pid)))
        .map(|p| p.port_name)
        .collect()
}

async fn blocking<T: Send + 'static>(
    work: impl FnOnce() -> Result<T, String> + Send + 'static,
) -> Result<T, String> {
    tauri::async_runtime::spawn_blocking(work)
        .await
        .map_err(|_| "INTERNAL".to_string())?
}

#[tauri::command]
pub async fn companion_serial_ports(window: WebviewWindow) -> Result<Vec<String>, String> {
    check_window(&window)?;
    blocking(|| Ok(list_ports())).await
}

#[tauri::command]
pub async fn companion_serial_open(
    window: WebviewWindow,
    state: State<'_, SerialState>,
    path: String,
) -> Result<(), String> {
    check_window(&window)?;
    let slot = state.0.clone();
    blocking(move || {
        // Release any earlier port first: opening is exclusive.
        drop(lock(&slot).take());
        if !list_ports().contains(&path) {
            return Err("NOT_FOUND".into());
        }
        let reader = serialport::new(&path, BAUD)
            .timeout(READ_TIMEOUT)
            .open()
            .map_err(|_| "OPEN_FAILED".to_string())?;
        let writer = reader.try_clone().map_err(|_| "OPEN_FAILED".to_string())?;
        *lock(&slot) = Some(Open {
            reader: Arc::new(Mutex::new(reader)),
            writer: Arc::new(Mutex::new(writer)),
        });
        Ok(())
    })
    .await
}

#[tauri::command]
pub async fn companion_serial_write(
    window: WebviewWindow,
    state: State<'_, SerialState>,
    bytes: Vec<u8>,
) -> Result<(), String> {
    check_window(&window)?;
    if !valid_improv_rpc(&bytes) {
        return Err("BAD_FRAME".into());
    }
    let writer = lock(&state.0).as_ref().map(|o| o.writer.clone());
    blocking(move || {
        let writer = writer.ok_or("NOT_OPEN")?;
        let mut port = lock(&writer);
        port.write_all(&bytes)
            .and_then(|()| port.flush())
            .map_err(|_| "WRITE_FAILED".to_string())
    })
    .await
}

#[tauri::command]
pub async fn companion_serial_read(
    window: WebviewWindow,
    state: State<'_, SerialState>,
    max: u32,
) -> Result<Vec<u8>, String> {
    check_window(&window)?;
    let slot = state.0.clone();
    let reader = lock(&slot).as_ref().map(|o| o.reader.clone());
    blocking(move || {
        let reader = reader.ok_or("NOT_OPEN")?;
        let result = read_chunk(&mut *lock(&reader), max as usize);
        if result.is_err() {
            // The device is gone: release the handle now so the page can re-open after a replug.
            let mut open = lock(&slot);
            if open
                .as_ref()
                .is_some_and(|o| Arc::ptr_eq(&o.reader, &reader))
            {
                *open = None;
            }
        }
        result
    })
    .await
}

#[tauri::command]
pub async fn companion_serial_close(
    window: WebviewWindow,
    state: State<'_, SerialState>,
) -> Result<(), String> {
    check_window(&window)?;
    drop(lock(&state.0).take());
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io;

    fn frame(type_: u8, data: &[u8]) -> Vec<u8> {
        let mut f = b"IMPROV".to_vec();
        f.extend([1, type_, data.len() as u8]);
        f.extend(data);
        f.push(f.iter().fold(0u8, |a, b| a.wrapping_add(*b)));
        f
    }

    #[test]
    fn accepts_only_espressif_jtag() {
        assert!(is_companion_port(0x303A, 0x1001));
        assert!(!is_companion_port(0x303A, 0x1002));
        assert!(!is_companion_port(0x10C4, 0xEA60)); // CP210x
        assert!(!is_companion_port(0x0403, 0x6001)); // FTDI
    }

    #[test]
    fn rejects_non_rpc_or_bad_checksum_frames() {
        let rpc = frame(0x03, &[0x03, 0x00]); // INFO
        assert!(valid_improv_rpc(&rpc));
        assert!(valid_improv_rpc(&frame(0x03, &[0xA0; 255])));
        assert!(!valid_improv_rpc(&frame(0x01, &[0x04]))); // STATE
        assert!(!valid_improv_rpc(&frame(0x04, &[0x03, 0x00]))); // RESULT
        assert!(!valid_improv_rpc(&rpc[..rpc.len() - 1])); // truncated
        assert!(!valid_improv_rpc(&rpc[..5]));
        assert!(!valid_improv_rpc(&[]));
        let mut bad = rpc.clone();
        *bad.last_mut().unwrap() ^= 1;
        assert!(!valid_improv_rpc(&bad));
        let mut version = rpc.clone();
        version[6] = 2;
        assert!(!valid_improv_rpc(&version));
        let mut two = rpc.clone(); // two frames back to back
        two.extend(&rpc);
        assert!(!valid_improv_rpc(&two));
        let mut long = frame(0x03, &[0xA0; 255]);
        long.push(0);
        assert!(long.len() > 265 && !valid_improv_rpc(&long));
        let mut garbage = vec![0u8; 9];
        garbage.extend(b"IMPROV");
        assert!(!valid_improv_rpc(&garbage));
    }

    struct Fake(Vec<io::Result<usize>>);
    impl io::Read for Fake {
        fn read(&mut self, buf: &mut [u8]) -> io::Result<usize> {
            let r = self.0.remove(0)?;
            buf[..r].fill(7);
            Ok(r)
        }
    }

    #[test]
    fn read_chunk_maps_timeout_data_and_unplug() {
        let mut r = Fake(vec![Ok(3)]);
        assert_eq!(read_chunk(&mut r, 16).unwrap(), vec![7, 7, 7]);
        let mut r = Fake(vec![Err(io::ErrorKind::TimedOut.into())]);
        assert!(read_chunk(&mut r, 16).unwrap().is_empty());
        let mut r = Fake(vec![Err(io::ErrorKind::Interrupted.into())]);
        assert!(read_chunk(&mut r, 16).unwrap().is_empty());
        let mut r = Fake(vec![Ok(0)]);
        assert_eq!(read_chunk(&mut r, 16).unwrap_err(), "DISCONNECTED");
        let mut r = Fake(vec![Err(io::ErrorKind::BrokenPipe.into())]);
        assert_eq!(read_chunk(&mut r, 16).unwrap_err(), "DISCONNECTED");
    }

    #[test]
    fn only_the_main_local_window_may_use_the_bridge() {
        let ok = |l: &str, u: &str, d: bool| window_allowed(l, &u.parse().unwrap(), d);
        assert!(ok("main", "tauri://localhost/", false));
        assert!(ok("main", "http://127.0.0.1:5173/", true));
        assert!(!ok("main", "http://127.0.0.1:5173/", false));
        assert!(!ok("other", "tauri://localhost/", false));
        assert!(!ok("main", "https://evil.example/", false));
        assert!(!ok("main", "tauri://u:p@localhost/", false));
    }
}
