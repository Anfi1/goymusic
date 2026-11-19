use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};
use cpal::{FromSample, Sample, SampleFormat, SizedSample};
use ringbuf::traits::{Consumer, Observer, Producer, Split};
use ringbuf::{HeapCons, HeapProd, HeapRb};
use std::io::{self, Read};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::thread::{self, JoinHandle, Thread};
use std::time::Duration;

struct Feed {
    pcm: HeapCons<f32>,
    producer: Thread,
}

struct Mixer {
    feed: Option<Feed>,
    channels: usize,
    rate: u32,
    frames: u64,
    pending_until: Option<cpal::StreamInstant>,
    offset: f64,
    playing: bool,
    volume: f32,
}

impl Mixer {
    fn new(channels: u16, rate: u32) -> Self {
        Self {
            feed: None, channels: usize::from(channels), rate, frames: 0,
            offset: 0.0, playing: false, volume: 1.0, pending_until: None,
        }
    }

    fn position(&self) -> f64 {
        self.offset + self.frames as f64 / f64::from(self.rate)
    }

    // Only whole frames of decoded audio advance the clock. An underrun, pause
    // or a concurrent transport change outputs silence, never stale samples.
    fn render<T: Sample + FromSample<f32>>(&mut self, out: &mut [T], time: Option<cpal::OutputStreamTimestamp>) -> usize {
        let Some(feed) = self.feed.as_mut().filter(|_| self.playing) else { return 0 };
        let (a, b) = feed.pcm.as_slices();
        let frames = out.len().min(a.len() + b.len()) / self.channels;
        let count = frames * self.channels;
        for (dst, src) in out[..count].iter_mut().zip(a.iter().chain(b)) {
            *dst = T::from_sample((src * self.volume).clamp(-1.0, 1.0));
        }
        if count > 0 {
            feed.pcm.skip(count);
            self.frames += frames as u64;
            // A drained ring is not necessarily a drained endpoint. Don't let
            // the UI stop WASAPI before its final submitted frames are audible.
            if let Some(time) = time.filter(|_| feed.pcm.is_empty()) {
                self.pending_until = time.playback.add(Duration::from_secs_f64(frames as f64 / f64::from(self.rate)));
            }
            // A paused player may stay full indefinitely without polling.
            if feed.pcm.vacant_len() >= feed.pcm.capacity().get() / 2 {
                feed.producer.unpark();
            }
        } else if time.is_some_and(|t| self.pending_until.is_some_and(|end| t.callback >= end)) {
            self.pending_until = None;
        }
        count
    }
}

fn render<T: Sample + FromSample<f32>>(mixer: &Mutex<Mixer>, out: &mut [T], time: Option<cpal::OutputStreamTimestamp>) {
    let count = mixer.try_lock().map_or(0, |mut m| m.render(out, time));
    out[count..].fill(T::EQUILIBRIUM);
}

fn output_stream<T: SizedSample + FromSample<f32>>(
    device: &cpal::Device,
    config: &cpal::StreamConfig,
    mixer: Arc<Mutex<Mixer>>,
    failure: Arc<Mutex<Option<String>>>,
) -> Result<cpal::Stream, cpal::BuildStreamError> {
    device.build_output_stream(
        config,
        move |data: &mut [T], info| render(&mixer, data, Some(info.timestamp())),
        move |err| *failure.lock().unwrap() = Some(format!("Audio output: {err}")),
        None,
    )
}

#[derive(Default)]
struct Status {
    cancel: AtomicBool,
    eof: AtomicBool,
    duration_bits: AtomicU64,
    error: Mutex<Option<String>>,
}

fn duration_from_header(line: &[u8]) -> Option<f64> {
    let text = std::str::from_utf8(line.strip_prefix(b"  Duration: ")?).ok()?;
    let mut parts = text.split_once(',')?.0.split(':');
    let hours = parts.next()?.parse::<u32>().ok()?;
    let mins = parts.next()?.parse::<u32>().ok()?;
    let secs = parts.next()?.parse::<f64>().ok()?;
    let total = f64::from(hours) * 3600.0 + f64::from(mins) * 60.0 + secs;
    (parts.next().is_none() && mins < 60 && (0.0..60.0).contains(&secs) && total > 0.0)
        .then_some(total)
}

// Read metadata from the same open input (no second network request/ffprobe).
// Keep only a line prefix; names, URLs and arbitrarily long tags aren't retained.
fn read_header(mut stderr: impl Read, status: &Status) {
    let mut buf = [0; 4096];
    let mut line = [0; 64];
    let mut len = 0;
    loop {
        let n = match stderr.read(&mut buf) {
            Ok(0) | Err(_) => break,
            Ok(n) => n,
        };
        for &byte in &buf[..n] {
            if byte == b'\n' || byte == b'\r' {
                if let Some(d) = duration_from_header(&line[..len]) {
                    status.duration_bits.store(d.to_bits(), Ordering::Relaxed);
                    let _ = io::copy(&mut stderr, &mut io::sink());
                    return;
                }
                len = 0;
            } else if len < line.len() {
                line[len] = byte;
                len += 1;
            }
        }
    }
}

fn decode_pcm(
    mut pipe: impl Read, mut pcm: HeapProd<f32>, status: &Status, channels: usize,
) -> io::Result<u64> {
    let mut bytes = [0; 16 * 1024];
    let mut carry = 0;
    let mut samples = 0u64;
    while !status.cancel.load(Ordering::Acquire) {
        let n = match pipe.read(&mut bytes[carry..]) {
            Err(e) if e.kind() == io::ErrorKind::Interrupted => continue,
            n => n?,
        };
        if n == 0 {
            if carry != 0 || samples % channels as u64 != 0 {
                return Err(io::Error::new(io::ErrorKind::UnexpectedEof, "Incomplete PCM frame"));
            }
            break;
        }
        let len = n + carry;
        let end = len - len % 4;
        let mut pos = 0;
        while pos < end {
            if status.cancel.load(Ordering::Acquire) { return Ok(samples) }
            let words = bytes[pos..end].chunks_exact(4)
                .map(|w| f32::from_le_bytes([w[0], w[1], w[2], w[3]]));
            let pushed = pcm.push_iter(words);
            if pushed == 0 {
                thread::park();
            } else {
                samples += pushed as u64;
                pos += pushed * 4;
            }
        }
        bytes.copy_within(end..len, 0);
        carry = len - end;
    }
    Ok(samples)
}

struct Decoder {
    child: Arc<Mutex<Child>>,
    status: Arc<Status>,
    pcm_thread: Option<JoinHandle<()>>,
    log_thread: Option<JoinHandle<()>>,
}

impl Decoder {
    fn start(exe: &Path, source: &str, offset: f64, duration: Option<f64>, channels: u16, rate: u32)
        -> Result<(Self, Feed), String>
    {
        let mut cmd = Command::new(exe);
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            cmd.creation_flags(0x08000000); // CREATE_NO_WINDOW
        }
        cmd.args(["-nostdin", "-hide_banner", "-nostats", "-loglevel", "info", "-xerror"]);
        if offset > 0.0 { cmd.arg("-ss").arg(offset.to_string()); }
        if source.starts_with("https://") {
            let root = exe.parent().and_then(Path::parent).ok_or("Cannot locate Deck CA bundle")?;
            let ca = ["python/bin/Lib/site-packages/certifi/cacert.pem", "python/fork/certifi/cacert.pem"]
                .into_iter().map(|relative| root.join(relative)).find(|path| path.is_file())
                .ok_or("Missing Deck CA bundle; re-extract the portable archive")?;
            cmd.args(["-protocol_whitelist", "https,tls,tcp,crypto", "-tls_verify", "1", "-ca_file"])
                .arg(ca).args(["-rw_timeout", "15000000", "-i", source]);
        } else {
            let file = Path::new(source).canonicalize().map_err(|e| format!("Open audio file: {e}"))?;
            if !file.is_file() { return Err("Audio source is not a file".into()) }
            cmd.args(["-protocol_whitelist", "file", "-i"]).arg(file);
        }
        let mut child = cmd.args(["-map", "0:a:0", "-vn", "-sn", "-dn", "-ar"])
            .arg(rate.to_string()).arg("-ac").arg(channels.to_string())
            .args(["-c:a", "pcm_f32le", "-f", "f32le", "pipe:1"])
            .stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::piped())
            .spawn().map_err(|e| format!("Start bundled FFmpeg: {e}"))?;
        let stdout = child.stdout.take().unwrap();
        let stderr = child.stderr.take().unwrap();
        let child = Arc::new(Mutex::new(child));
        let status = Arc::new(Status::default());
        status.duration_bits.store(duration.unwrap_or(0.0).to_bits(), Ordering::Relaxed);
        // Own the process even when starting either worker fails.
        let mut decoder = Self { child: child.clone(), status: status.clone(), pcm_thread: None, log_thread: None };
        let log_status = status.clone();
        decoder.log_thread = Some(thread::Builder::new().name("ffmpeg-metadata".into())
            .spawn(move || read_header(stderr, &log_status)).map_err(|e| e.to_string())?);
        let channels = usize::from(channels);
        let (prod, pcm) = HeapRb::<f32>::new((rate as usize / 2).max(1) * channels).split();
        let worker = thread::Builder::new().name("ffmpeg-pcm".into()).spawn(move || {
            let result = decode_pcm(stdout, prod, &status, channels);
            if let Err(e) = &result {
                *status.error.lock().unwrap() = Some(format!("Read decoded audio: {e}"));
                let _ = child.lock().unwrap().kill();
            }
            // Never wait with the child locked: stop/seek must be able to kill
            // even while a transport is stalled on I/O or closing its pipes.
            while !status.cancel.load(Ordering::Acquire) {
                let exit = child.lock().unwrap().try_wait();
                match exit {
                    Ok(None) => thread::sleep(Duration::from_millis(5)),
                    Ok(Some(s)) if s.success() && result.is_ok() => {
                        if result.as_ref().ok() == Some(&0) && offset == 0.0 {
                            *status.error.lock().unwrap() = Some("Source contains no audio samples".into());
                        } else {
                            status.eof.store(true, Ordering::Release);
                        }
                        break;
                    }
                    other => {
                        status.error.lock().unwrap().get_or_insert_with(|| match other {
                            Ok(Some(s)) => format!("FFmpeg stopped ({s}); unsupported audio or unavailable stream"),
                            Err(e) => format!("Wait for FFmpeg: {e}"),
                            Ok(None) => unreachable!(),
                        });
                        break;
                    }
                }
            }
        }).map_err(|e| e.to_string())?;
        let producer = worker.thread().clone();
        decoder.pcm_thread = Some(worker);
        Ok((decoder, Feed { pcm, producer }))
    }
}

impl Drop for Decoder {
    fn drop(&mut self) {
        self.status.cancel.store(true, Ordering::Release);
        {
            let mut child = self.child.lock().unwrap();
            let _ = child.kill(); // releases blocking stdout/stderr reads immediately
            let _ = child.wait();
        }
        if let Some(handle) = self.pcm_thread.take() {
            handle.thread().unpark(); // full ring, including when paused
            let _ = handle.join();
        }
        if let Some(handle) = self.log_thread.take() { let _ = handle.join(); }
    }
}

fn bundled_ffmpeg() -> Result<PathBuf, String> {
    let exe = std::env::current_exe().map_err(|e| e.to_string())?;
    Ok(exe.parent().ok_or("Cannot locate the Deck directory")?.join("tools")
        .join(format!("ffmpeg{}", std::env::consts::EXE_SUFFIX)))
}

pub struct Player {
    mixer: Arc<Mutex<Mixer>>,
    device: Option<(cpal::Device, cpal::SupportedStreamConfig)>,
    stream: Option<cpal::Stream>,
    output_failure: Arc<Mutex<Option<String>>>,
    decoder: Option<Decoder>,
    exe: PathBuf,
    source: Option<String>,
    transport_error: Option<String>,
}

impl Player {
    pub fn new() -> Result<Self, String> {
        let device = cpal::default_host().default_output_device().ok_or("No default audio output")?;
        Self::open(device, bundled_ffmpeg()?)
    }

    fn open(device: cpal::Device, exe: PathBuf) -> Result<Self, String> {
        let config = device.default_output_config().map_err(|e| format!("Audio format: {e}"))?;
        let mixer = Arc::new(Mutex::new(Mixer::new(config.channels(), config.sample_rate().0)));
        Ok(Self { mixer, device: Some((device, config)), stream: None,
            output_failure: Arc::new(Mutex::new(None)), decoder: None,
            exe, source: None, transport_error: None })
    }

    fn build_stream(&self, device: &cpal::Device, supported: &cpal::SupportedStreamConfig) -> Result<cpal::Stream, String> {
        let config = supported.config();
        macro_rules! stream {
            ($ty:ty) => { output_stream::<$ty>(device, &config, self.mixer.clone(), self.output_failure.clone()) };
        }
        match supported.sample_format() {
            SampleFormat::F32 => stream!(f32), SampleFormat::F64 => stream!(f64),
            SampleFormat::I16 => stream!(i16), SampleFormat::U16 => stream!(u16),
            SampleFormat::I32 => stream!(i32), SampleFormat::U32 => stream!(u32),
            SampleFormat::I8 => stream!(i8), SampleFormat::U8 => stream!(u8),
            SampleFormat::I64 => stream!(i64), SampleFormat::U64 => stream!(u64),
            f => return Err(format!("Unsupported output sample format {f}")),
        }.map_err(|e| format!("Open audio output: {e}"))
    }

    fn replace(&mut self, source: String, offset: f64, playing: bool, duration: Option<f64>) -> Result<(), String> {
        // A paused WASAPI session retains queued frames. A new source/seek
        // must never replay those frames when its endpoint starts.
        self.stream = None;
        let (channels, rate) = {
            let mut m = self.mixer.lock().unwrap();
            m.feed = None;
            m.playing = false;
            m.pending_until = None;
            m.frames = 0;
            m.offset = offset;
            (m.channels as u16, m.rate)
        };
        self.decoder = None;
        self.source = None;
        self.transport_error = None;
        if let Some(err) = self.output_failure.lock().unwrap().as_ref() { return Err(err.clone()) }
        match Decoder::start(&self.exe, &source, offset, duration, channels, rate) {
            Ok((decoder, feed)) => {
                self.mixer.lock().unwrap().feed = Some(feed);
                self.decoder = Some(decoder);
                self.source = Some(source);
                if playing {
                    if let Err(error) = self.resume() {
                        self.decoder = None;
                        self.mixer.lock().unwrap().feed = None;
                        self.transport_error = Some(error.clone());
                        return Err(error);
                    }
                }
                Ok(())
            }
            Err(e) => {
                self.transport_error = Some(e.clone());
                Err(e)
            }
        }
    }

    pub fn load(&mut self, source: String) -> Result<(), String> {
        self.replace(source, 0.0, true, None)
    }

    pub fn pause(&mut self) {
        {
            let mut m = self.mixer.lock().unwrap();
            if !m.playing { return }
            m.playing = false;
        }
        if self.stream.as_ref().is_some_and(|stream| stream.pause().is_err()) {
            // Backends without endpoint pause can still go idle by closing it.
            self.stream = None;
        }
    }

    fn resume(&mut self) -> Result<(), String> {
        if self.decoder.is_none() || self.mixer.lock().unwrap().playing { return Ok(()) }
        if self.stream.is_none() {
            if let Some((device, config)) = &self.device {
                self.stream = Some(self.build_stream(device, config)?);
            }
        }
        if let Some(stream) = &self.stream {
            stream.play().map_err(|e| format!("Start audio output: {e}"))?;
        }
        self.mixer.lock().unwrap().playing = true;
        Ok(())
    }

    pub fn play(&mut self) {
        if let Err(e) = self.resume() { self.transport_error = Some(e); }
    }

    pub fn seek(&mut self, seconds: f64) {
        if !seconds.is_finite() { return }
        let Some(source) = self.source.take() else { return };
        let duration = self.duration();
        let offset = seconds.clamp(0.0, duration.unwrap_or(f64::MAX));
        let playing = self.mixer.lock().unwrap().playing;
        let _ = self.replace(source, offset, playing, duration); // error() exposes asynchronous transport failures
    }

    pub fn set_volume(&mut self, linear: f32) {
        if linear.is_finite() { self.mixer.lock().unwrap().volume = linear.clamp(0.0, 1.0); }
    }

    pub fn position(&self) -> f64 { self.mixer.lock().unwrap().position() }

    pub fn duration(&self) -> Option<f64> {
        let d = f64::from_bits(self.decoder.as_ref()?.status.duration_bits.load(Ordering::Relaxed));
        (d > 0.0).then_some(d)
    }

    pub fn finished(&self) -> bool {
        if !self.decoder.as_ref().is_some_and(|d| d.status.eof.load(Ordering::Acquire)) { return false }
        let m = self.mixer.lock().unwrap();
        m.pending_until.is_none() && m.feed.as_ref().is_some_and(|f| f.pcm.is_empty())
    }

    pub fn error(&self) -> Option<String> {
        self.output_failure.lock().unwrap().clone().or_else(|| self.transport_error.clone())
            .or_else(|| self.decoder.as_ref()?.status.error.lock().unwrap().clone())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use std::time::Instant;

    #[test]
    fn callback_counts_only_whole_frames_and_applies_volume() {
        let (mut prod, pcm) = HeapRb::<f32>::new(8).split();
        let mut mix = Mixer::new(2, 8000);
        mix.feed = Some(Feed { pcm, producer: thread::current() });
        mix.volume = 0.5;
        let mix = Mutex::new(mix);
        let mut out = [f32::NAN; 4];
        assert_eq!(prod.push_slice(&[0.5, -1.0, 0.25]), 3);
        render(&mix, &mut out, None);
        assert_eq!(out, [0.0; 4]);
        mix.lock().unwrap().playing = true;
        render(&mix, &mut out, None);
        assert_eq!(out, [0.25, -0.5, 0.0, 0.0]);
        render(&mix, &mut out, None);
        assert_eq!(out, [0.0; 4]); // dangling left sample cannot become a right sample
        assert_eq!(mix.lock().unwrap().frames, 1);
        assert_eq!(prod.push_slice(&[0.75]), 1);
        render(&mix, &mut out, None);
        assert_eq!(out, [0.125, 0.375, 0.0, 0.0]);
        assert_eq!(mix.lock().unwrap().frames, 2);
    }

    #[test]
    fn decoder_rejects_a_partial_final_frame() {
        let (prod, _) = HeapRb::<f32>::new(8).split();
        let bytes = 0.5f32.to_le_bytes();
        assert_eq!(decode_pcm(&bytes[..], prod, &Status::default(), 2).unwrap_err().kind(),
            io::ErrorKind::UnexpectedEof);
    }

    struct Fixture(PathBuf);

    impl Fixture {
        fn make(name: &str, invert: bool) -> Self {
            let path = std::env::temp_dir().join(format!("goy-deck-{}-{name}.wav", std::process::id()));
            let rate = 48000u32;
            let size = rate * 4;
            let mut wav = Vec::with_capacity(44 + size as usize);
            wav.extend_from_slice(b"RIFF");
            wav.extend_from_slice(&(36 + size).to_le_bytes());
            wav.extend_from_slice(b"WAVEfmt \x10\x00\x00\x00\x01\x00\x02\x00");
            wav.extend_from_slice(&rate.to_le_bytes());
            wav.extend_from_slice(&(rate * 4).to_le_bytes());
            wav.extend_from_slice(b"\x04\x00\x10\x00data");
            wav.extend_from_slice(&size.to_le_bytes());
            for i in 0..rate {
                let sample: i16 = if (i < rate / 2) ^ invert { 8192 } else { -8192 };
                wav.extend_from_slice(&sample.to_le_bytes());
                wav.extend_from_slice(&sample.to_le_bytes());
            }
            fs::write(&path, wav).unwrap();
            Self(path)
        }

        fn source(&self) -> String { self.0.to_str().unwrap().to_owned() }
    }

    impl Drop for Fixture {
        fn drop(&mut self) { let _ = fs::remove_file(&self.0); }
    }

    fn test_player() -> Player {
        let exe = std::env::var_os("GOYMUSIC_TEST_FFMPEG").map(PathBuf::from).unwrap_or_else(|| {
            let bundled = bundled_ffmpeg().unwrap();
            if bundled.is_file() { bundled } else { PathBuf::from("ffmpeg") }
        });
        if let Some(device) = cpal::default_host().default_output_device()
            .filter(|d| d.default_output_config().is_ok())
        {
            return Player::open(device, exe).expect("Open real default endpoint");
        }
        // Hosted runners often have no endpoint. Only replace the final device;
        // FFmpeg, pipes, ring, render callback, transport and clock stay real.
        Player { mixer: Arc::new(Mutex::new(Mixer::new(2, 48000))), device: None, stream: None,
            output_failure: Arc::new(Mutex::new(None)), decoder: None, exe,
            source: None, transport_error: None }
    }

    fn until(p: &Player, mut ready: impl FnMut() -> bool) {
        let deadline = Instant::now() + Duration::from_secs(12);
        while !ready() {
            assert_eq!(p.error(), None);
            assert!(Instant::now() < deadline, "Timed out at position {}", p.position());
            thread::sleep(Duration::from_millis(2));
        }
    }

    #[test]
    fn ffmpeg_playback_seek_replace_and_drain() {
        let a = Fixture::make("first", false);
        let b = Fixture::make("second", true);
        let mut p = test_player();
        assert!(p.stream.is_none());
        p.play();
        assert!(p.stream.is_none(), "No active track should open a render session");
        p.set_volume(0.05);
        p.load(a.source()).unwrap();
        p.pause();
        p.seek(0.0); // deterministic even if the real endpoint ran before pause
        until(&p, || p.mixer.lock().unwrap().feed.as_ref().unwrap().pcm.is_full());
        let old = p.decoder.as_ref().unwrap().child.clone();
        let position = p.position();
        assert!(p.mixer.lock().unwrap().feed.as_ref().unwrap().pcm.iter().take(256).any(|s| *s > 0.1));
        assert_eq!(p.position(), position);
        // Switch while the old decoder is backpressured, then seek while paused.
        p.load(b.source()).unwrap();
        assert!(old.lock().unwrap().try_wait().unwrap().is_some());
        p.pause();
        p.seek(0.0);
        until(&p, || p.duration() == Some(1.0) &&
            p.mixer.lock().unwrap().feed.as_ref().unwrap().pcm.occupied_len() >= 256);
        assert!(p.mixer.lock().unwrap().feed.as_ref().unwrap().pcm.iter().take(256).any(|s| *s < -0.1));
        p.seek(0.75);
        until(&p, || p.mixer.lock().unwrap().feed.as_ref().unwrap().pcm.occupied_len() >= 256);
        assert!(p.mixer.lock().unwrap().feed.as_ref().unwrap().pcm.iter().take(256).any(|s| *s > 0.1));
        assert_eq!(p.position(), 0.75);
        assert!(!p.finished());
        p.play();
        let mut heard = false;
        until(&p, || {
            if p.device.is_none() {
                let mut out = [0.0f32; 512];
                render(&p.mixer, &mut out, None);
                heard |= out.iter().any(|s| *s > 0.005);
            }
            p.finished()
        });
        assert!(p.device.is_some() || heard);
        assert!((p.position() - 1.0).abs() < 0.002);
        assert_eq!(p.error(), None);

        // The exit status, not an empty pipe during buffering, determines EOF.
        fs::write(&a.0, b"not audio").unwrap();
        p.load(a.source()).unwrap();
        let deadline = Instant::now() + Duration::from_secs(12);
        while p.error().is_none() {
            assert!(Instant::now() < deadline, "Decoder failed silently");
            thread::sleep(Duration::from_millis(2));
        }
        assert!(!p.finished());
    }
}
