#![cfg_attr(windows, windows_subsystem = "windows")]

mod audio;
mod catalog;
mod glyph;
#[cfg(windows)] mod media;
mod pictures;
mod preferences;
mod seek;
mod transport;
mod ui;

use std::{ops::Range, path::PathBuf, sync::Arc, time::{Duration, Instant}};
use iced::{event, keyboard, widget::{image::Handle, operation}, window, Event, Size, Subscription, Task, Theme};
use catalog::Track;
use preferences::Preferences;
use transport::{Command, Event as Audio, Transport};

const ROW: f32 = 54.0;
const ICON: &[u8] = include_bytes!("../../public/icon.png");
const AUDIO_EXT: &[&str] = &["mp3", "flac", "m4a", "wav", "ogg", "opus", "aac", "aiff", "wma", "webm", "mp4", "mka"];

fn boot() -> (Deck, Task<Message>) {
    let inputs = std::env::args_os().skip(1).map(|arg| {
        if let Some(link) = arg.to_str().filter(|value| is_link(value)) {
            Track::from_https_audio(link)
        } else {
            Ok(Track::local_path(PathBuf::from(arg)))
        }
    }).collect();
    Deck::new(inputs, Preferences::read())
}

fn main() -> iced::Result {
    let icon = image::load_from_memory(ICON).ok().and_then(|source| {
        let pixels = source.into_rgba8();
        let (w,h) = pixels.dimensions();
        window::icon::from_rgba(pixels.into_raw(), w, h).ok()
    });
    let result = iced::application(boot, Deck::update, Deck::view).title(Deck::title)
        .window(window::Settings { size: Size::new(1100.0, 720.0), min_size: Some(Size::new(880.0, 580.0)),
            icon, ..Default::default() })
        .settings(iced::Settings { default_text_size: iced::Pixels(14.0), antialiasing: true, ..Default::default() })
        .theme(|state: &Deck| state.theme.clone()).subscription(Deck::subscription)
        .run();
    catalog::shutdown();
    result
}

// Route explicit URIs to the direct-audio validator, never to catalog search.
// A Windows drive prefix (C:\Music\...) is not a URI.
fn is_link(value: &str) -> bool {
    let Some((scheme, rest)) = value.trim().split_once(':') else { return false };
    scheme.eq_ignore_ascii_case("https") || scheme.eq_ignore_ascii_case("http") ||
        (rest.starts_with("//") && scheme.len() > 1 &&
         scheme.starts_with(|c: char| c.is_ascii_alphabetic()) &&
         scheme.bytes().all(|c| c.is_ascii_alphanumeric() || b"+.-".contains(&c)))
}

#[test]
fn distinguish_direct_audio_intent_from_search_text_and_windows_paths() {
    for value in ["https://media.example/live", " HTTPS://media.example/a.wav ", "http://invalid.example", "ftp://invalid.example", "https:/broken"] {
        assert!(is_link(value));
    }
    for value in ["High Hopes", "Artist: title", r"C:\Audio\song.wav", "C://Audio/song.wav"] {
        assert!(!is_link(value));
    }
}

#[derive(Debug, Clone, Copy, Eq, PartialEq, Hash)]
enum Page { Home, Catalog }
#[derive(Debug, Clone, Copy, Eq, PartialEq)]
enum Phase { Empty, Loading, Playing, Paused, Ended, Failed }
#[derive(Debug, Clone, Copy, Eq, PartialEq, Hash)]
enum List { Queue, Results }
#[derive(Debug, Clone)]
enum Message {
    Page(Page), FocusSearch, Input(String), Search, Searched(Result<Vec<Track>, String>),
    Pick, Files(Vec<PathBuf>), Add(usize, bool), Select(usize), Remove(usize),
    Resolved(u64, bool, Result<String, String>), Picture(String, Option<pictures::Picture>),
    Audio(Audio), Toggle, SetPlaying(bool), Previous, Next, Stop, Seek(f64), SeekBy(f64), Preview(Option<f64>),
    Volume(f32), VolumeBy(f32), Save, Mute, Nyan(bool), Ambient(bool), Frame,
    Scroll(List, usize), Resize(window::Id, Size), Focus(window::Id, bool), Minimized(bool), Tab(bool), Dismiss,
    #[cfg(windows)] Opened(window::Id),
    #[cfg(windows)] Hwnd(isize),
}

struct Deck {
    theme: Theme, logo: Handle, prefs: Preferences, saved: Preferences, last_volume: f32,
    page: Page, query: String, searched: bool, searching: bool, search_error: Option<String>,
    results: Vec<Track>, queue: Vec<Track>, current: Option<usize>, revision: u64,
    offsets: [usize; 2], height: f32, cache: pictures::Cache,
    generation: u64, remote_busy: bool, picker: bool, focused: bool, notice: Option<String>,
    transport: Transport, phase: Phase, position: f64, duration: Option<f64>, preview: Option<f64>,
    frames: Arc<[Handle]>, frame: usize, motion: bool, minimized: bool, sample_time: Instant,
    #[cfg(windows)] media: Option<media::Session>,
}

impl Deck {
    fn new(inputs: Result<Vec<Track>, String>, prefs: Preferences) -> (Self, Task<Message>) {
        let (transport, rx) = Transport::start(prefs.volume);
        let mut state = Self {
            theme: ui::theme(), logo: Handle::from_bytes(ICON), prefs, saved: prefs, last_volume: prefs.volume.max(0.05),
            page: Page::Home, query: String::new(), searched: false, searching: false, search_error: None,
            results: Vec::new(), queue: Vec::new(), current: None, revision: 0, offsets: [0;2], height: 720.0,
            cache: Default::default(), generation: 0, remote_busy: false, picker: false, focused: true, notice: None,
            transport, phase: Phase::Empty, position: 0.0, duration: None, preview: None,
            frames: pictures::nyan_frames(), frame: 0, motion: animations_enabled(), minimized: false, sample_time: Instant::now(),
            #[cfg(windows)] media: None,
        };
        let open = match inputs {
            Ok(tracks) => state.append(tracks),
            Err(error) => { state.notice = Some(error); Task::none() }
        };
        (state, Task::batch([Task::run(rx, Message::Audio), open]))
    }

    fn track(&self) -> Option<&Track> { self.current.and_then(|i| self.queue.get(i)) }
    fn title(&self) -> String { self.track().map_or_else(|| "GoyMusic Deck".into(), |t| format!("{} | GoyMusic Deck", t.title)) }
    fn next_index(&self) -> usize { self.current.map_or(0, |i| i + 1) }
    fn ready(&self) -> bool { matches!(self.phase, Phase::Playing | Phase::Paused) }
    fn animating(&self) -> bool {
        self.prefs.nyan && self.motion && self.focused && !self.minimized && self.phase == Phase::Playing && self.duration.is_some()
    }
    fn range(&self, list: List) -> Range<usize> {
        let (skip, len) = match list { List::Queue => (self.next_index(), self.queue.len()), List::Results => (0,self.results.len()) };
        let visible = ((self.height / ROW).ceil() as usize + 2).min(128);
        let start = skip + self.offsets[list as usize].saturating_sub(1).min(len.saturating_sub(skip).saturating_sub(1));
        start..(start + visible).min(len)
    }

    fn fetch_pictures(&mut self) -> Task<Message> {
        if !self.cache.available() { return Task::none(); }
        let upcoming = self.range(List::Queue);
        let results = self.range(List::Results);
        // Keep the active cover and first visible rows warm; never let a large display
        // churn through more candidates than the image budget can retain.
        let candidates = self.current.into_iter().filter_map(|i| self.queue.get(i))
            .chain(self.queue[upcoming].iter().take(14))
            .chain(self.results[results].iter().take(if self.page == Page::Catalog { 14 } else { 0 }));
        let mut jobs = Vec::new();
        for track in candidates {
            if (track.local.is_some() || track.artwork.is_some()) && self.cache.request(&track.id) {
                let track = track.clone();
                let id = track.id.clone();
                jobs.push(Task::perform(async move { tokio::task::spawn_blocking(move || pictures::load(track)).await.ok().flatten() }, move |art| Message::Picture(id.clone(), art)));
                if !self.cache.available() { break; }
            }
        }
        Task::batch(jobs)
    }

    fn begin(&mut self, index: usize) -> Task<Message> {
        if index >= self.queue.len() { return Task::none(); }
        self.generation += 1;
        self.current = Some(index);
        self.phase = Phase::Loading;
        self.position = 0.0;
        self.duration = None;
        self.preview = None;
        self.frame = 0;
        self.notice = None;
        self.revision += 1;
        self.offsets[List::Queue as usize] = 0;
        self.transport.send(Command::Clear(self.generation));
        self.sync_media(true);
        Task::batch([self.resolve(), self.fetch_pictures(), operation::snap_to(ui::list_id(List::Queue), operation::RelativeOffset::START)])
    }

    fn append(&mut self, tracks: impl IntoIterator<Item = Track>) -> Task<Message> {
        let first = self.queue.len();
        self.queue.extend(tracks);
        if self.queue.len() == first { return Task::none(); }
        self.revision += 1;
        if self.current.is_none() || self.phase == Phase::Ended {
            self.page = Page::Home;
            return self.begin(first);
        }
        self.fetch_pictures()
    }

    fn play_now(&mut self, track: Track) -> Task<Message> {
        let index = self.next_index();
        self.queue.insert(index, track);
        self.page = Page::Home;
        self.begin(index)
    }

    fn resolve(&mut self) -> Task<Message> {
        let Some(track) = self.track() else { return Task::none() };
        let remote = track.needs_catalog();
        if remote && self.remote_busy { return Task::none(); }
        let track = track.clone();
        let id = self.generation;
        self.remote_busy |= remote;
        Task::perform(async move { tokio::task::spawn_blocking(move || catalog::resolve(track)).await.map_err(|e| e.to_string()).and_then(|r| r) }, move |r| Message::Resolved(id, remote, r))
    }

    fn fail(&mut self, error: String) { self.phase = Phase::Failed; self.notice = Some(error); self.sync_media(false); }
    fn volume(&mut self, value: f32) {
        self.prefs.volume = value.clamp(0.0, 1.0);
        self.transport.send(Command::Volume(self.prefs.volume));
        if self.prefs.volume > 0.0 { self.last_volume = self.prefs.volume; }
    }
    fn save(&mut self) {
        if self.prefs != self.saved { self.transport.send(Command::Save(self.prefs)); self.saved = self.prefs; }
    }
    fn sync_media(&mut self, metadata: bool) {
        #[cfg(windows)] if let Some(media) = &mut self.media {
            if metadata { if let Some(t) = self.current.and_then(|i| self.queue.get(i)) { media.metadata(t, self.duration); } }
            media.playback(self.phase, self.position);
        }
        #[cfg(not(windows))] let _ = metadata;
    }

    fn update(&mut self, msg: Message) -> Task<Message> {
        match msg {
            Message::Page(page) => { self.page = page; return self.fetch_pictures(); }
            Message::FocusSearch => { self.page = Page::Catalog; return Task::batch([operation::focus(ui::search_id()), self.fetch_pictures()]); }
            Message::Input(value) => self.query = value,
            Message::Search => {
                if is_link(&self.query) {
                    return match Track::from_https_audio(self.query.trim()) {
                        Ok(track) => {
                            self.query.clear();
                            self.play_now(track)
                        }
                        Err(error) => { self.notice = Some(error); Task::none() }
                    };
                }
                if self.searching || self.query.trim().is_empty() { return Task::none(); }
                self.searching = true;
                self.search_error = None;
                self.page = Page::Catalog;
                self.results.clear();
                self.revision += 1;
                self.offsets[List::Results as usize] = 0;
                let query = self.query.trim().to_owned();
                return Task::perform(async move { tokio::task::spawn_blocking(move || catalog::search(query)).await.map_err(|e| e.to_string()).and_then(|r| r) }, Message::Searched);
            }
            Message::Searched(result) => {
                self.searching = false; self.searched = true; self.revision += 1;
                match result { Ok(tracks) => self.results = tracks, Err(e) => self.search_error = Some(e) }
                return Task::batch([self.fetch_pictures(), operation::snap_to(ui::list_id(List::Results), operation::RelativeOffset::START)]);
            }
            Message::Pick if !self.picker => {
                self.picker = true;
                return Task::perform(async { rfd::AsyncFileDialog::new().set_title("Open audio files").add_filter("Audio", AUDIO_EXT)
                    .add_filter("All files", &["*"]).pick_files().await.unwrap_or_default().into_iter().map(|file| file.path().to_owned()).collect() }, Message::Files);
            }
            Message::Files(paths) => {
                self.picker = false;
                return self.append(paths.into_iter().map(Track::local_path));
            }
            Message::Add(i, play) => if let Some(track) = self.results.get(i) {
                if play { return self.play_now(track.clone()); }
                self.queue.push(track.clone());
                self.revision += 1;
                return self.fetch_pictures();
            },
            Message::Select(i) => return self.begin(i),
            Message::Remove(i) if i >= self.next_index() && i < self.queue.len() => {
                self.queue.remove(i); self.revision += 1; return self.fetch_pictures();
            }
            Message::Resolved(id, remote, result) => {
                if remote { self.remote_busy = false; }
                if id == self.generation && self.phase == Phase::Loading {
                    match result { Ok(source) => self.transport.send(Command::Load(id, source)), Err(e) => self.fail(e) }
                } else if remote && self.phase == Phase::Loading && self.track().is_some_and(Track::needs_catalog) { return self.resolve(); }
            }
            Message::Picture(id, art) => { self.cache.finish(id, art); return self.fetch_pictures(); }
            Message::Audio(Audio::State(id, playing, position, duration)) if self.generation == id => {
                let phase = if playing { Phase::Playing } else { Phase::Paused };
                let duration = duration.filter(|d| d.is_finite() && *d > 0.0);
                let changed_duration = duration != self.duration;
                let changed = self.phase != phase || changed_duration;
                self.position = position.max(0.0);
                self.sample_time = Instant::now();
                self.duration = duration;
                self.phase = phase;
                if changed { self.sync_media(changed_duration); }
            }
            Message::Audio(Audio::End(id)) if self.generation == id => {
                let next = self.next_index();
                if next < self.queue.len() { return self.begin(next); }
                self.phase = Phase::Ended;
                self.position = self.duration.unwrap_or(self.position);
                self.sync_media(false);
            }
            Message::Audio(Audio::Error(id, e)) if self.generation == id => self.fail(e),
            Message::Audio(Audio::SettingsError(e)) => self.notice = Some(format!("Could not save preview settings: {e}")),
            Message::Toggle => return self.update(Message::SetPlaying(self.phase != Phase::Playing)),
            Message::SetPlaying(want) => {
                if self.ready() { self.transport.send(Command::Playing(want)); }
                else if want && self.phase != Phase::Loading { return self.begin(self.current.unwrap_or(0)); }
            }
            Message::Stop => {
                self.generation += 1; self.transport.send(Command::Clear(self.generation));
                self.phase = if self.current.is_some() { Phase::Ended } else { Phase::Empty };
                self.position = 0.0; self.preview = None; self.sync_media(false);
            }
            Message::Next => return self.begin(self.next_index()),
            Message::Previous => if let Some(i) = self.current {
                if self.ready() && (self.position > 3.0 || i == 0) { return self.update(Message::Seek(0.0)); }
                return self.begin(i.saturating_sub(1));
            },
            Message::Preview(value) => self.preview = value,
            Message::SeekBy(delta) => return self.update(Message::Seek(self.position + delta)),
            Message::Seek(s) => {
                self.preview = None;
                if self.ready() { if let Some(d) = self.duration {
                    self.position = s.clamp(0.0, d);
                    self.transport.send(Command::Seek(self.position)); self.sync_media(false);
                } }
            }
            Message::Volume(v) => self.volume(v),
            Message::VolumeBy(delta) => { self.volume(self.prefs.volume + delta); self.save(); }
            Message::Mute => { self.volume(if self.prefs.volume > 0.0 { 0.0 } else { self.last_volume }); self.save(); }
            Message::Save => self.save(),
            Message::Nyan(v) => { self.prefs.nyan = v; self.frame = 0; self.save(); }
            Message::Ambient(v) => { self.prefs.ambient = v; self.save(); }
            Message::Frame => self.frame = (self.frame + 1) % self.frames.len(),
            Message::Scroll(list, start) => { if self.offsets[list as usize] != start { self.offsets[list as usize] = start; return self.fetch_pictures(); } }
            Message::Resize(id, size) => {
                self.height = size.height;
                return Task::batch([self.fetch_pictures(), minimized(id)]);
            }
            Message::Focus(id, focused) => {
                self.focused = focused;
                if !focused { self.preview = None; }
                return minimized(id);
            }
            Message::Minimized(value) => {
                if self.minimized != value {
                    self.minimized = value;
                    self.transport.send(Command::Visible(!value));
                }
            }
            Message::Tab(back) => return if back { operation::focus_previous() } else { operation::focus_next() },
            Message::Dismiss => self.notice = None,
            #[cfg(windows)] Message::Opened(id) => return media::handle(id),
            #[cfg(windows)] Message::Hwnd(hwnd) => match media::Session::attach(hwnd) {
                Ok((session, events)) => { self.media = Some(session); self.sync_media(true); return events; }
                Err(e) => self.notice = Some(format!("System media controls unavailable: {e}")),
            },
            _ => {}
        }
        Task::none()
    }

    fn subscription(&self) -> Subscription<Message> {
        let events = event::listen_with(|e, status, id| {
            match e {
                Event::Window(window::Event::Focused) => Some(Message::Focus(id, true)),
                Event::Window(window::Event::Unfocused) => Some(Message::Focus(id, false)),
                Event::Window(window::Event::Resized(size)) => Some(Message::Resize(id, size)),
                Event::Window(window::Event::FileDropped(path)) => Some(Message::Files(vec![path])),
                #[cfg(windows)] Event::Window(window::Event::Opened { .. }) => Some(Message::Opened(id)),
                Event::Keyboard(keyboard::Event::KeyPressed { key, modifiers, .. }) => {
                    use keyboard::{Key, key::Named as N};
                    match key.as_ref() {
                        Key::Character("o") if modifiers.command() => Some(Message::Pick),
                        Key::Character("f") if modifiers.command() => Some(Message::FocusSearch),
                        Key::Named(N::Tab) => Some(Message::Tab(modifiers.shift())),
                        Key::Named(N::MediaPlayPause) => Some(Message::Toggle),
                        Key::Named(N::MediaPlay) => Some(Message::SetPlaying(true)),
                        Key::Named(N::MediaPause) => Some(Message::SetPlaying(false)),
                        Key::Named(N::MediaStop) => Some(Message::Stop),
                        Key::Named(N::MediaTrackNext) => Some(Message::Next),
                        Key::Named(N::MediaTrackPrevious) => Some(Message::Previous),
                        _ if status == event::Status::Captured => None,
                        Key::Named(N::Space) => Some(Message::Toggle),
                        Key::Named(N::ArrowRight) if modifiers.command() => Some(Message::Next),
                        Key::Named(N::ArrowLeft) if modifiers.command() => Some(Message::Previous),
                        Key::Named(N::ArrowRight) => Some(Message::SeekBy(5.0)),
                        Key::Named(N::ArrowLeft) => Some(Message::SeekBy(-5.0)),
                        Key::Named(N::ArrowUp) => Some(Message::VolumeBy(0.05)),
                        Key::Named(N::ArrowDown) => Some(Message::VolumeBy(-0.05)),
                        Key::Character("m") => Some(Message::Mute),
                        Key::Named(N::Escape) => Some(Message::Page(Page::Home)),
                        _ => None,
                    }
                }
                _ => None,
            }
        });
        if self.animating() {
            Subscription::batch([events, iced::time::every(Duration::from_millis(100)).map(|_| Message::Frame)])
        } else { events }
    }
}

fn minimized(id: window::Id) -> Task<Message> {
    window::is_minimized(id).map(|m| Message::Minimized(m.unwrap_or(false)))
}

impl Drop for Deck {
    fn drop(&mut self) { self.save(); }
}

#[cfg(windows)]
fn animations_enabled() -> bool {
    use windows_sys::Win32::UI::WindowsAndMessaging::{SystemParametersInfoW, SPI_GETCLIENTAREAANIMATION};
    let mut enabled = 1i32;
    // The SPI contract writes one BOOL to this pointer.
    unsafe { SystemParametersInfoW(SPI_GETCLIENTAREAANIMATION, 0, (&mut enabled as *mut i32).cast(), 0); }
    enabled != 0
}
#[cfg(not(windows))]
fn animations_enabled() -> bool { true }
