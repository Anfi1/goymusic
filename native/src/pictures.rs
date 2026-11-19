use std::collections::VecDeque;
use std::fs::File;
use std::io::{Cursor, Read};
use std::path::Path;
use std::sync::Arc;

use iced::widget::image::Handle;
use image::{AnimationDecoder, ImageReader, Limits};
use crate::catalog::{self, Track};

const MAX_FILE: usize = 4 * 1024 * 1024;
const CACHE_SIZE: usize = 32;

#[derive(Clone, Debug)]
pub struct Picture { pub cover: Handle, pub thumbnail: Handle, pub ambient: Handle }

#[derive(Default)]
pub struct Cache {
    items: VecDeque<(String, Option<Picture>)>,
    in_flight: Vec<String>,
    pub revision: u64,
}

impl Cache {
    pub fn get(&self, id: &str) -> Option<&Picture> {
        self.items.iter().find(|(k, _)| k == id).and_then(|(_, art)| art.as_ref())
    }

    pub fn available(&self) -> bool { self.in_flight.len() < 2 }

    pub fn request(&mut self, id: &str) -> bool {
        if !self.available() || self.in_flight.iter().any(|k| k == id) { return false; }
        if let Some(i) = self.items.iter().position(|(k, _)| k == id) {
            // Keep visible art (including a miss) ahead of off-screen history.
            if i != 0 {
                let item = self.items.remove(i).unwrap();
                self.items.push_front(item);
            }
            return false;
        }
        self.in_flight.push(id.to_owned());
        true
    }

    pub fn finish(&mut self, id: String, art: Option<Picture>) {
        self.in_flight.retain(|k| *k != id);
        if self.items.len() == CACHE_SIZE { self.items.pop_back(); }
        self.items.push_front((id, art));
        self.revision += 1;
    }
}

fn sidecar(audio: &Path) -> Option<Vec<u8>> {
    let parent = audio.parent()?;
    for ext in ["jpg", "png", "jpeg", "webp"] {
        for candidate in [audio.with_extension(ext), parent.join(format!("cover.{ext}")), parent.join(format!("folder.{ext}"))] {
            if candidate == audio { continue; }
            let Ok(f) = File::open(candidate) else { continue };
            let len = f.metadata().ok()?.len();
            if len == 0 || len > MAX_FILE as u64 { continue; }
            let mut bytes = Vec::with_capacity(len as usize);
            if f.take(MAX_FILE as u64 + 1).read_to_end(&mut bytes).is_ok() && bytes.len() <= MAX_FILE { return Some(bytes); }
        }
    }
    None
}

pub fn load(track: Track) -> Option<Picture> {
    let bytes = if let Some(path) = track.local { sidecar(&path)? } else { catalog::artwork(track.artwork?).ok()? };
    if bytes.len() > MAX_FILE { return None; }
    let mut limits = Limits::default();
    limits.max_image_width = Some(4096);
    limits.max_image_height = Some(4096);
    limits.max_alloc = Some(40 * 1024 * 1024);
    let mut reader = ImageReader::new(Cursor::new(bytes)).with_guessed_format().ok()?;
    reader.limits(limits);
    let source = reader.decode().ok()?;
    // Album thumbnails often arrive inside a widescreen matte. Match Deck's square cover crop.
    let side = source.width().min(source.height());
    let square = image::imageops::crop_imm(&source, (source.width()-side)/2, (source.height()-side)/2, side, side);
    let edge = side.min(320);
    let cover = image::imageops::thumbnail(&*square, edge, edge);
    let thumb = image::imageops::thumbnail(&cover, 84.min(edge), 84.min(edge));
    let ambient = image::imageops::blur(&image::imageops::thumbnail(&cover, 80, 80), 7.0);
    Some(Picture {
        cover: Handle::from_rgba(cover.width(), cover.height(), cover.into_raw()),
        thumbnail: Handle::from_rgba(thumb.width(), thumb.height(), thumb.into_raw()),
        ambient: Handle::from_rgba(ambient.width(), ambient.height(), ambient.into_raw()),
    })
}

pub fn nyan_frames() -> Arc<[Handle]> {
    let gif = image::codecs::gif::GifDecoder::new(Cursor::new(include_bytes!("../assets/nyan.gif"))).expect("bundled Deck GIF");
    gif.into_frames().take(32).map(|frame| {
        let frame = frame.expect("bundled Deck frame").into_buffer();
        Handle::from_rgba(frame.width(), frame.height(), frame.into_raw())
    }).collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn artwork_cache_bounds_concurrent_jobs_and_remembers_misses() {
        let mut cache = Cache::default();
        assert!(cache.request("active"));
        assert!(!cache.request("active"));
        assert!(cache.request("other"));
        assert!(!cache.request("overflow"));
        cache.finish("active".into(), None);
        cache.finish("other".into(), None);
        for i in 0..100 {
            assert!(!cache.request("active"));
            let id = i.to_string();
            assert!(cache.request(&id));
            cache.finish(id, None);
        }
        assert_eq!(cache.items.len(), CACHE_SIZE);
        assert!(!cache.request("active"));
        assert!(cache.request("other")); // previously cached, now evicted
    }

    #[test]
    fn bundled_nyan_is_animated_not_a_static_thumbnail() {
        let frames = nyan_frames();
        assert!(frames.len() > 1);
        assert!(frames.iter().all(|h| matches!(h, Handle::Rgba { width: 34, height: 21, .. })));
    }
}
