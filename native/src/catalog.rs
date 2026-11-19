use std::collections::HashMap;
use std::env;
use std::io::{self, BufRead, BufReader, BufWriter, Read, Write};
use std::path::PathBuf;
use std::process::{Child, Command, Stdio};
use std::sync::{mpsc, Arc, Mutex, MutexGuard};
use std::sync::atomic::{AtomicU64, Ordering};
use std::thread::{self, JoinHandle};
use std::time::Duration;

use serde::{Deserialize, Serialize};
use tempfile::TempDir;

#[derive(Clone, Debug)]
pub struct Track {
    pub id: String,
    pub title: String,
    pub artist: String,
    pub artwork: Option<String>,
    pub local: Option<PathBuf>,
    direct: Option<DirectAudio>,
}

#[derive(Clone)]
struct DirectAudio(String);

impl std::fmt::Debug for DirectAudio {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("DirectAudio(<private URL>)")
    }
}

impl Track {
    pub fn local_path(path: PathBuf) -> Self {
        Self {
            id: format!("local:{}", path.to_string_lossy()),
            title: path.file_stem().unwrap_or(path.as_os_str()).to_string_lossy().into_owned(),
            artist: "Local audio".into(), artwork: None, local: Some(path), direct: None,
        }
    }

    pub fn from_https_audio(input: &str) -> Result<Self, String> {
        const INVALID: &str = "Enter an absolute HTTPS audio URL without credentials";
        let input = input.trim();
        let (scheme, rest) = input.split_once("://").ok_or(INVALID)?;
        let authority = rest.split(['/', '?', '#']).next().unwrap_or_default();
        if !scheme.eq_ignore_ascii_case("https") || authority.is_empty() || authority.contains('@')
            || input.contains('\\') || input.chars().any(|ch| ch.is_control() || ch.is_whitespace()) {
            return Err(INVALID.into());
        }
        let mut url = url::Url::parse(input).map_err(|_| INVALID)?;
        if !url.username().is_empty() || url.password().is_some() { return Err(INVALID.into()); }
        let artist = url.host_str().ok_or(INVALID)?.to_owned();
        let leaf = url.path_segments().and_then(|mut p| p.next_back()).unwrap_or_default();
        let decoded = percent_encoding::percent_decode_str(leaf).decode_utf8_lossy();
        let mut title = String::new();
        for ch in decoded.chars().take(80) {
            if ch.is_alphanumeric() || "._-()[]".contains(ch) {
                title.push(ch);
            } else if !title.is_empty() && !title.ends_with(' ') {
                title.push(' ');
            }
        }
        if title.ends_with(' ') { title.pop(); }
        if title.is_empty() { title.push_str("Audio stream"); }
        url.set_fragment(None);
        static NEXT_DIRECT: AtomicU64 = AtomicU64::new(1);
        Ok(Self {
            id: format!("direct:{}", NEXT_DIRECT.fetch_add(1, Ordering::Relaxed)),
            title, artist, artwork: None, local: None, direct: Some(DirectAudio(url.into())),
        })
    }

    pub fn needs_catalog(&self) -> bool {
        self.local.is_none() && self.direct.is_none()
    }
}

const MAX_FRAME: usize = 2 * 1024 * 1024;
const MAX_ART: u64 = 4 * 1024 * 1024;
const MAX_PENDING: usize = 8;
const CLOSED: &str = "Catalog session closed";

#[derive(Serialize)]
#[serde(tag = "command")]
enum Operation {
    #[serde(rename = "search")]
    Search { query: String },
    #[serde(rename = "get_stream_url")]
    Stream { #[serde(rename = "videoId")] id: String },
}

#[derive(Serialize)]
struct Request {
    #[serde(rename = "callId")]
    id: u64,
    #[serde(flatten)]
    operation: Operation,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Reply {
    call_id: Option<u64>,
    event: Option<serde::de::IgnoredAny>,
    status: Option<String>,
    message: Option<String>,
    results: Option<Results>,
    url: Option<String>,
}

impl Reply {
    fn check(self) -> Result<Self, String> {
        match self.status.as_deref() {
            Some("ok") => Ok(self),
            Some("error") => Err(self.message.filter(|s| !s.is_empty())
                .unwrap_or_else(|| "Catalog request failed".into())),
            _ => Err("Invalid catalog response: missing or unknown status".into()),
        }
    }
}

#[derive(Deserialize)]
struct Results {
    top: Option<Row>,
    tracks: Vec<Row>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Row {
    result_type: Option<String>,
    id: Option<String>,
    title: Option<String>,
    #[serde(default)]
    artists: Vec<Option<String>>,
    thumb_url: Option<String>,
    is_available: Option<bool>,
}

impl Results {
    fn tracks(self) -> Vec<Track> {
        let top = self.top.filter(|r| matches!(r.result_type.as_deref(), Some("song" | "video")));
        let mut tracks: Vec<Track> = Vec::with_capacity(self.tracks.len() + usize::from(top.is_some()));
        for row in top.into_iter().chain(self.tracks) {
            let (Some(id), Some(title)) = (row.id, row.title) else { continue };
            if id.trim().is_empty() || title.trim().is_empty() || row.is_available == Some(false)
                || tracks.iter().any(|t| t.id == id) { continue; }
            let mut artists = row.artists.into_iter().flatten().filter(|s| !s.trim().is_empty());
            let mut artist = artists.next().unwrap_or_default();
            for other in artists { artist.push_str(", "); artist.push_str(&other); }
            tracks.push(Track { id, title, artist, local: None, direct: None,
                artwork: row.thumb_url.filter(|s| !s.is_empty()) });
        }
        tracks
    }
}

pub fn search(query: String) -> Result<Vec<Track>, String> {
    if query.trim().is_empty() { return Ok(Vec::new()); }
    if query.len() > 4096 { return Err("Search query is too long".into()); }
    rpc(Operation::Search { query }, Duration::from_secs(45))?.results
        .map(Results::tracks).ok_or_else(|| "Invalid catalog response: missing search results".into())
}

pub fn resolve(track: Track) -> Result<String, String> {
    if let Some(path) = track.local {
        let meta = path.metadata().map_err(|e| format!("Cannot open local track: {e}"))?;
        if !meta.is_file() { return Err("Local track is not a file".into()); }
        let path = std::path::absolute(path).map_err(|e| e.to_string())?;
        return path.into_os_string().into_string().map_err(|_| "Unsupported local filename".into());
    }
    if let Some(DirectAudio(url)) = track.direct { return Ok(url); }
    if track.id.trim().is_empty() { return Err("Missing track ID".into()); }
    let url = rpc(Operation::Stream { id: track.id }, Duration::from_secs(90))?.url
        .ok_or_else(|| "Invalid catalog response: missing stream URL".to_string())?;
    let uri: ureq::http::Uri = url.parse().map_err(|_| "Invalid stream URL")?;
    if !matches!(uri.scheme_str(), Some("http" | "https")) || uri.host().is_none() {
        return Err("Invalid stream URL".into());
    }
    Ok(url)
}

struct Catalog {
    closed: bool,
    session: Option<Session>,
    http: Option<ureq::Agent>,
    next_id: u64,
}

static CATALOG: Mutex<Catalog> = Mutex::new(Catalog {
    closed: false, session: None, http: None, next_id: 1,
});

fn lock<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(|e| e.into_inner())
}

pub fn artwork(url: String) -> Result<Vec<u8>, String> {
    let http = {
        let mut state = lock(&CATALOG);
        if state.closed { return Err(CLOSED.into()); }
        state.http.get_or_insert_with(|| ureq::Agent::config_builder()
            .https_only(true).max_redirects(3)
            .timeout_global(Some(Duration::from_secs(12)))
            .timeout_resolve(Some(Duration::from_secs(4)))
            .timeout_connect(Some(Duration::from_secs(4)))
            .build().into()).clone()
    };
    let response = http.get(url.as_str()).header("Accept", "image/*").call()
        .map_err(|e| format!("Artwork request failed: {e}"))?;
    read_artwork(response)
}

fn read_artwork(mut response: ureq::http::Response<ureq::Body>) -> Result<Vec<u8>, String> {
    if !response.status().is_success() { return Err(format!("Artwork HTTP {}", response.status())); }
    let bytes = response.body_mut().with_config().limit(MAX_ART).read_to_vec()
        .map_err(|e| format!("Cannot read artwork: {e}"))?;
    if bytes.is_empty() { return Err("Artwork is empty".into()); }
    Ok(bytes)
}

type RpcResult = Result<Reply, String>;

// One table per child. An EOF or late reply from an old child cannot wake a caller of its replacement.
#[derive(Default)]
struct Replies {
    failed: Option<String>,
    waiting: HashMap<u64, mpsc::Sender<RpcResult>>,
}

impl Replies {
    fn fail(&mut self, reason: String) {
        if self.failed.is_some() { return; }
        for (_, caller) in self.waiting.drain() { let _ = caller.send(Err(reason.clone())); }
        self.failed = Some(reason);
    }
}

fn read_replies(mut stdout: impl BufRead, replies: &Mutex<Replies>) -> String {
    let mut line = Vec::new();
    loop {
        line.clear();
        let n = match (&mut stdout).take(MAX_FRAME as u64 + 1).read_until(b'\n', &mut line) {
            Ok(n) => n,
            Err(e) => return format!("Cannot read catalog output: {e}"),
        };
        if n == 0 { return "Python catalog exited; check the bundled Python runtime and dependencies".into(); }
        if n > MAX_FRAME { return "Catalog response exceeds size limit".into(); }
        if !line.ends_with(b"\n") { return "Incomplete catalog response".into(); }
        if !line.trim_ascii_start().starts_with(b"{") { continue; } // dependency stdout, not JSONL
        let reply: Reply = match serde_json::from_slice(&line) {
            Ok(value) => value,
            Err(e) => return format!("Invalid catalog response: {e}"),
        };
        if reply.event.is_some() { continue; }
        if let Some(id) = reply.call_id {
            if let Some(caller) = lock(replies).waiting.remove(&id) { let _ = caller.send(reply.check()); }
        }
    }
}

struct Session {
    child: Child,
    #[cfg(windows)]
    job: Option<std::os::windows::io::OwnedHandle>,
    replies: Arc<Mutex<Replies>>,
    requests: Option<mpsc::Sender<Request>>,
    reader: Option<JoinHandle<()>>,
    writer: Option<JoinHandle<()>>,
    _data: TempDir,
}

impl Session {
    fn start() -> Result<Self, String> {
        let exe = env::current_exe().map_err(|e| format!("Cannot locate Deck: {e}"))?;
        let root = exe.parent().ok_or("Cannot locate bundle directory")?;
        let script = root.join("python/api.py");
        let python = root.join("python/bin/python.exe");
        if !script.is_file() || !python.is_file() {
            return Err("Missing python/api.py or python/bin/python.exe; extract the full Deck archive".into());
        }
        let data = tempfile::Builder::new().prefix("goymusic-deck-").tempdir()
            .map_err(|e| format!("Cannot create private catalog directory: {e}"))?;
        let mut cmd = Command::new(python);
        cmd.args(["-I", "-B", "-u"]).arg(script).current_dir(data.path())
            .env("IMAGEIO_FFMPEG_EXE", root.join("tools/ffmpeg.exe"))
            .stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::null());
        for key in ["GOYMUSIC_USER_DATA", "HOME", "USERPROFILE", "APPDATA", "LOCALAPPDATA",
            "XDG_CACHE_HOME", "XDG_CONFIG_HOME", "TEMP", "TMP", "TMPDIR"] {
            cmd.env(key, data.path());
        }
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            cmd.creation_flags(windows_sys::Win32::System::Threading::CREATE_NO_WINDOW);
        }
        let child = cmd.spawn().map_err(|e| format!("Cannot start bundled Python: {e}"))?;
        // Establish ownership before any fallible pipe, job or thread setup.
        let mut session = Self { child, #[cfg(windows)] job: None, replies: Arc::default(),
            requests: None, reader: None, writer: None, _data: data };
        #[cfg(windows)]
        {
            session.job = Some(child_job(&session.child)
                .map_err(|e| format!("Cannot contain Python process tree: {e}"))?);
        }
        let stdout = session.child.stdout.take().ok_or("Missing Python stdout")?;
        let stdin = session.child.stdin.take().ok_or("Missing Python stdin")?;
        let replies = Arc::clone(&session.replies);
        session.reader = Some(thread::Builder::new().name("catalog-reader".into()).spawn(move || {
            let reason = read_replies(BufReader::new(stdout), &replies);
            lock(&replies).fail(reason);
        }).map_err(|e| format!("Cannot start catalog reader: {e}"))?);
        let (tx, rx) = mpsc::channel::<Request>();
        let replies = Arc::clone(&session.replies);
        session.writer = Some(thread::Builder::new().name("catalog-writer".into()).spawn(move || {
            let mut stdin = BufWriter::new(stdin);
            for request in rx {
                let result = serde_json::to_writer(&mut stdin, &request).map_err(io::Error::other)
                    .and_then(|()| stdin.write_all(b"\n")).and_then(|()| stdin.flush());
                if let Err(e) = result { lock(&replies).fail(format!("Cannot write catalog request: {e}")); break; }
            }
        }).map_err(|e| format!("Cannot start catalog writer: {e}"))?);
        session.requests = Some(tx);
        Ok(session)
    }
}

#[cfg(windows)]
fn child_job(child: &Child) -> io::Result<std::os::windows::io::OwnedHandle> {
    use std::os::windows::io::{AsRawHandle, FromRawHandle, OwnedHandle};
    use windows_sys::Win32::System::JobObjects::*;
    // The unnamed job is non-inheritable. Closing the last handle (including on Deck crash)
    // ends the backend and its helpers. No operation is sent before this assignment succeeds.
    unsafe {
        let handle = CreateJobObjectW(std::ptr::null(), std::ptr::null());
        if handle.is_null() { return Err(io::Error::last_os_error()); }
        let job = OwnedHandle::from_raw_handle(handle);
        let mut limits = JOBOBJECT_EXTENDED_LIMIT_INFORMATION::default();
        limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
        if SetInformationJobObject(handle, JobObjectExtendedLimitInformation,
            (&limits as *const JOBOBJECT_EXTENDED_LIMIT_INFORMATION).cast(),
            std::mem::size_of_val(&limits) as u32) == 0
            || AssignProcessToJobObject(handle, child.as_raw_handle()) == 0 {
            return Err(io::Error::last_os_error());
        }
        Ok(job)
    }
}

impl Drop for Session {
    fn drop(&mut self) {
        lock(&self.replies).fail(CLOSED.into());
        self.requests.take();
        #[cfg(windows)]
        drop(self.job.take());
        let _ = self.child.kill();
        let _ = self.child.wait();
        if let Some(thread) = self.reader.take() { let _ = thread.join(); }
        if let Some(thread) = self.writer.take() { let _ = thread.join(); }
    }
}

fn rpc(operation: Operation, timeout: Duration) -> RpcResult {
    let (wait, generation) = {
        let mut state = lock(&CATALOG);
        if state.closed { return Err(CLOSED.into()); }
        if state.session.as_ref().is_some_and(|s| lock(&s.replies).failed.is_some()) {
            state.session.take();
        }
        if state.session.is_none() { state.session = Some(Session::start()?); }
        let id = state.next_id;
        state.next_id += 1;
        let session = state.session.as_ref().unwrap();
        let mut replies = lock(&session.replies);
        if let Some(reason) = &replies.failed { return Err(reason.clone()); }
        if replies.waiting.len() >= MAX_PENDING { return Err("Catalog busy; try again shortly".into()); }
        let (tx, wait) = mpsc::channel();
        replies.waiting.insert(id, tx);
        if session.requests.as_ref().unwrap().send(Request { id, operation }).is_err() {
            replies.fail("Catalog input closed".into());
        }
        (wait, Arc::clone(&session.replies))
    };
    let result = match wait.recv_timeout(timeout) {
        Ok(result) => result,
        Err(e) => {
            let reason = match e {
                mpsc::RecvTimeoutError::Disconnected => "Catalog disconnected",
                mpsc::RecvTimeoutError::Timeout => "Catalog session timed out",
            };
            lock(&generation).fail(reason.into());
            Err(reason.into())
        }
    };
    // On pipe failure or timeout end the whole session, not just its waiter. A normal
    // command error (e.g. unavailable song) does not interrupt other requests.
    if result.is_err() && lock(&generation).failed.is_some() {
        let mut state = lock(&CATALOG);
        if state.session.as_ref().is_some_and(|s| Arc::ptr_eq(&s.replies, &generation)) {
            state.session.take();
        }
    }
    result
}

pub fn shutdown() {
    let mut state = lock(&CATALOG);
    state.closed = true;
    if let Some(agent) = state.http.take() { agent.shutdown(); }
    state.session.take();
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn artwork_limits_apply_without_content_length() {
        fn response(size: u64) -> ureq::http::Response<ureq::Body> {
            let body = ureq::Body::builder().reader(io::repeat(7).take(size));
            ureq::http::Response::new(body)
        }
        assert_eq!(read_artwork(response(3)).unwrap(), [7; 3]);
        assert!(read_artwork(response(0)).is_err());
        assert!(read_artwork(response(MAX_ART + 1)).is_err());
    }

    #[test]
    fn ordinary_commands_use_flat_protocol_fields() {
        let request = Request { id: 19, operation: Operation::Stream { id: "video-id".into() } };
        assert_eq!(serde_json::to_value(request).unwrap(), serde_json::json!({
            "command": "get_stream_url", "videoId": "video-id", "callId": 19
        }));
    }

    #[test]
    fn correlates_interleaved_replies_and_ignores_events() {
        let replies = Mutex::new(Replies::default());
        let (first, search) = mpsc::channel();
        let (second, stream) = mpsc::channel();
        lock(&replies).waiting.extend([(1, first), (2, second)]);
        let wire = concat!("library diagnostic\n",
            "{\"event\":\"progress\",\"callId\":1}\n",
            "{\"callId\":2,\"status\":\"error\",\"message\":\"not available\"}\r\n",
            r#"{"callId":1,"status":"ok","results":{"top":{"resultType":"song","id":"A","title":"Song","artists":["One","Two"],"thumbUrl":"https://cover"},"tracks":[{"id":"A","title":"Duplicate"},{"id":"B","title":"Offline","isAvailable":false},{"id":"C","title":"Next"}]}}"#, "\n");
        read_replies(wire.as_bytes(), &replies);
        assert!(matches!(stream.try_recv().unwrap(), Err(s) if s == "not available"));
        let tracks = search.try_recv().unwrap().unwrap().results.unwrap().tracks();
        assert_eq!(tracks.len(), 2);
        assert_eq!(tracks[0].artist, "One, Two");
        assert_eq!(tracks[0].artwork.as_deref(), Some("https://cover"));
        assert_eq!(tracks[1].id, "C");
    }

    #[test]
    fn broken_frames_fail_all_waiters() {
        for (bytes, expected) in [(b"{invalid}\n".to_vec(), "Invalid"),
            (b"{\"callId\":1}".to_vec(), "Incomplete"), (vec![b'x'; MAX_FRAME + 1], "size limit")] {
            let replies = Mutex::new(Replies::default());
            let (tx, rx) = mpsc::channel();
            lock(&replies).waiting.insert(1, tx);
            let reason = read_replies(&bytes[..], &replies);
            lock(&replies).fail(reason);
            assert!(matches!(rx.try_recv().unwrap(), Err(s) if s.contains(expected)));
        }
    }

    #[test]
    fn direct_audio_keeps_signed_query_private_and_never_calls_python() {
        let input = "https://127.0.0.1:4430/Disc%201/A%20Song%0A%E2%80%AE.wav?token=secret#private";
        let track = Track::from_https_audio(input).unwrap();
        assert!(!track.needs_catalog());
        assert_eq!(track.title, "A Song .wav");
        assert_eq!(track.artist, "127.0.0.1");
        assert!(track.id.starts_with("direct:"));
        let debug = format!("{track:?}");
        assert!(!debug.contains("token") && !debug.contains("#private"));
        assert_eq!(resolve(track).unwrap(), input.split('#').next().unwrap());
    }

    #[test]
    fn direct_audio_rejects_non_https_and_userinfo() {
        for url in ["file:///tmp/track", "http://example.org/a", "https:/example.org/a",
            "https://user:pass@example.org/a", "https://@example.org/a", "https://example.org\\@evil.org/a"] {
            assert!(Track::from_https_audio(url).is_err());
        }
    }

    #[test]
    fn local_paths_never_start_the_catalog() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("Мой трек.mp3");
        let track = Track::local_path(path.clone());
        assert!(!track.needs_catalog());
        assert!(resolve(track.clone()).is_err());
        std::fs::File::create(&path).unwrap();
        assert_eq!(PathBuf::from(resolve(track).unwrap()), path);
    }
}
