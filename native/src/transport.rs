use std::sync::mpsc::{self, RecvTimeoutError, Sender};
use std::thread::JoinHandle;
use std::time::Duration;

use iced::futures::channel::mpsc::{unbounded, UnboundedReceiver};

use crate::audio::Player;

pub enum Command {
    Clear(u64),
    Load(u64, String),
    Playing(bool),
    Seek(f64),
    Save(crate::preferences::Preferences),
    Volume(f32),
    Visible(bool),
    Quit,
}

#[derive(Clone, Debug)]
pub enum Event {
    State(u64, bool, f64, Option<f64>),
    SettingsError(String),
    End(u64),
    Error(u64, String),
}

pub struct Transport {
    tx: Sender<Command>,
    thread: Option<JoinHandle<()>>,
}

impl Transport {
    pub fn start(volume: f32) -> (Self, UnboundedReceiver<Event>) {
        let (tx, rx) = mpsc::channel();
        let (out, events) = unbounded();
        let thread = std::thread::spawn(move || {
            // CPAL streams are thread-affine. Do not even open the device until a song is selected.
            let mut player: Option<Player> = None;
            let (mut id, mut playing, mut visible, mut volume) = (0, false, true, volume);
            let mut reported_second = None;
            loop {
                let command = if playing {
                    match rx.recv_timeout(Duration::from_millis(200)) {
                        Ok(command) => Some(command),
                        Err(RecvTimeoutError::Timeout) => None,
                        Err(RecvTimeoutError::Disconnected) => break,
                    }
                } else {
                    match rx.recv() { Ok(command) => Some(command), Err(_) => break }
                };
                let changed = command.is_some();
                match command {
                    Some(Command::Save(prefs)) => {
                        if let Err(e) = prefs.save() {
                            let _ = out.unbounded_send(Event::SettingsError(e.to_string()));
                        }
                        continue;
                    }
                    Some(Command::Quit) => break,
                    Some(Command::Clear(next)) => {
                        player = None;
                        id = next;
                        playing = false;
                        reported_second = None;
                        continue;
                    }
                    Some(Command::Load(next, source)) if next == id => {
                        let result = (|| {
                            let p = match &mut player {
                                Some(p) => p,
                                None => player.insert(Player::new()?),
                            };
                            p.set_volume(volume);
                            p.load(source)
                        })();
                        if let Err(error) = result {
                            player = None;
                            let _ = out.unbounded_send(Event::Error(id, error));
                            playing = false;
                            continue;
                        }
                        playing = true;
                    }
                    Some(Command::Load(..)) => continue,
                    Some(Command::Playing(want)) => {
                        if let Some(p) = &mut player {
                            if want { p.play(); } else { p.pause(); }
                            playing = want;
                        }
                    }
                    Some(Command::Seek(seconds)) => {
                        if let Some(p) = &mut player { p.seek(seconds); }
                    }
                    Some(Command::Volume(level)) => {
                        volume = level;
                        if let Some(p) = &mut player { p.set_volume(level); }
                        continue;
                    }
                    Some(Command::Visible(value)) => { visible = value; if !visible { continue; } }
                    None => {}
                }
                let Some(p) = &mut player else { continue };
                if let Some(error) = p.error() {
                    p.pause();
                    player = None;
                    playing = false;
                    let _ = out.unbounded_send(Event::Error(id, error));
                } else if playing && p.finished() {
                    p.pause();
                    player = None;
                    playing = false;
                    let _ = out.unbounded_send(Event::End(id));
                } else {
                    let position = p.position();
                    let second = position as u64;
                    if changed || (visible && reported_second != Some(second)) {
                        if out.unbounded_send(Event::State(id, playing, position, p.duration())).is_err() { break; }
                        reported_second = Some(second);
                    }
                }
            }
        });
        (Self { tx, thread: Some(thread) }, events)
    }

    pub fn send(&self, command: Command) { let _ = self.tx.send(command); }
}

impl Drop for Transport {
    fn drop(&mut self) {
        self.send(Command::Quit);
        if let Some(thread) = self.thread.take() { let _ = thread.join(); }
    }
}
