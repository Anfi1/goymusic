use std::time::Duration;
use iced::{futures::channel::mpsc::unbounded, window, Task};
use souvlaki::{MediaControlEvent as E, MediaControls, MediaMetadata, MediaPlayback, MediaPosition, PlatformConfig, SeekDirection};
use crate::{catalog::Track, Message, Phase};

pub fn handle(id: window::Id) -> Task<Message> {
    window::run(id, |window| match window.window_handle().map(|h| h.as_raw()) {
        Ok(window::raw_window_handle::RawWindowHandle::Win32(h)) => Message::Hwnd(h.hwnd.get()),
        _ => Message::Hwnd(0),
    })
}

pub struct Session(MediaControls);

impl Session {
    pub fn attach(hwnd: isize) -> Result<(Self, Task<Message>), String> {
        if hwnd == 0 { return Err("Window handle unavailable".into()); }
        let mut controls = MediaControls::new(PlatformConfig {
            display_name: "GoyMusic Deck", dbus_name: "GoyMusicDeck", hwnd: Some(hwnd as *mut _),
        }).map_err(|e| format!("{e:?}"))?;
        let (tx, rx) = unbounded();
        controls.attach(move |event| {
            let message = match event {
                E::Play => Message::SetPlaying(true),
                E::Pause => Message::SetPlaying(false),
                E::Toggle => Message::Toggle,
                E::Next => Message::Next,
                E::Previous => Message::Previous,
                E::Stop => Message::Stop,
                E::Seek(direction) => Message::SeekBy(if direction == SeekDirection::Forward { 5.0 } else { -5.0 }),
                E::SeekBy(direction, amount) => Message::SeekBy(amount.as_secs_f64() * if direction == SeekDirection::Forward { 1.0 } else { -1.0 }),
                E::SetPosition(position) => Message::Seek(position.0.as_secs_f64()),
                _ => return,
            };
            let _ = tx.unbounded_send(message);
        }).map_err(|e| format!("{e:?}"))?;
        Ok((Self(controls), Task::run(rx, |msg| msg)))
    }

    pub fn metadata(&mut self, track: &Track, duration: Option<f64>) {
        let _ = self.0.set_metadata(MediaMetadata { title: Some(&track.title), artist: Some(&track.artist),
            duration: duration.map(Duration::from_secs_f64), ..Default::default() });
    }

    pub fn playback(&mut self, phase: Phase, position: f64) {
        let progress = Some(MediaPosition(Duration::from_secs_f64(position)));
        let _ = self.0.set_playback(match phase {
            Phase::Playing => MediaPlayback::Playing { progress },
            Phase::Paused => MediaPlayback::Paused { progress },
            _ => MediaPlayback::Stopped,
        });
    }
}
