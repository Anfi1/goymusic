use std::{env, fs, io::{self, Read, Write}, path::PathBuf};
use serde::{Deserialize, Serialize};

#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq)]
#[serde(default)]
pub struct Preferences {
    pub nyan: bool,
    pub ambient: bool,
    pub volume: f32,
}

impl Default for Preferences {
    fn default() -> Self { Self { nyan: false, ambient: true, volume: 0.75 } }
}

fn path() -> Option<PathBuf> {
    #[cfg(windows)]
    let base = env::var_os("LOCALAPPDATA").map(PathBuf::from);
    #[cfg(not(windows))]
    let base = env::var_os("XDG_CONFIG_HOME").map(PathBuf::from)
        .or_else(|| env::var_os("HOME").map(|h| PathBuf::from(h).join(".config")));
    base.map(|p| p.join("GoyMusic-Native-Preview").join("appearance.json"))
}

impl Preferences {
    pub fn read() -> Self {
        let mut saved = path().and_then(|p| fs::File::open(p).ok())
            .and_then(|file| serde_json::from_reader::<_, Self>(file.take(4096)).ok())
            .unwrap_or_default();
        saved.volume = saved.volume.clamp(0.0, 1.0);
        saved
    }

    pub fn save(self) -> io::Result<()> {
        let path = path().ok_or_else(|| io::Error::other("Preview settings folder is unavailable"))?;
        let dir = path.parent().unwrap();
        fs::create_dir_all(dir)?;
        let mut temp = tempfile::NamedTempFile::new_in(dir)?;
        serde_json::to_writer(&mut temp, &self)?;
        temp.flush()?;
        temp.persist(path)?;
        Ok(())
    }
}
