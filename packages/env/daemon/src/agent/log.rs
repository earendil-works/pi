//! The agent's log: lines with a UTC timestamp to stderr and, once opened, to `agent.log` in the state directory,
//! which is kept below about 1 MiB by moving it to `agent.log.1` (one generation is kept).

use std::fs::{self, File, OpenOptions};
use std::io::Write;
use std::path::PathBuf;
use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};

/// Size beyond which `agent.log` moves to `agent.log.1`.
const LOG_LIMIT: u64 = 1024 * 1024;

struct LogFile {
    path: PathBuf,
    file: File,
    size: u64,
}

static LOG: Mutex<Option<LogFile>> = Mutex::new(None);

/// Log to `path` from now on, as well as to stderr.
pub fn open(path: PathBuf) {
    let Ok(file) = OpenOptions::new().create(true).append(true).open(&path) else {
        return;
    };
    let size = file.metadata().map(|metadata| metadata.len()).unwrap_or(0);
    *LOG.lock().unwrap() = Some(LogFile { path, file, size });
}

/// One line of the agent's log.
pub fn line(text: &str) {
    let line = format!("{} {text}\n", timestamp(now_ms()));
    eprint!("{line}");
    let mut log = LOG.lock().unwrap();
    let Some(log) = log.as_mut() else {
        return;
    };
    if log.size + line.len() as u64 > LOG_LIMIT {
        let _ = fs::rename(&log.path, log.path.with_extension("log.1"));
        if let Ok(file) = OpenOptions::new()
            .create(true)
            .write(true)
            .truncate(true)
            .open(&log.path)
        {
            log.file = file;
            log.size = 0;
        }
    }
    if log.file.write_all(line.as_bytes()).is_ok() {
        log.size += line.len() as u64;
    }
}

pub fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|elapsed| elapsed.as_millis() as u64)
        .unwrap_or(0)
}

/// RFC 3339 UTC time of `ms` since the epoch, such as `2026-05-01T12:00:00.000Z`.
pub fn timestamp(ms: u64) -> String {
    let seconds = ms / 1000;
    let (hour, minute, second) = (seconds / 3600 % 24, seconds / 60 % 60, seconds % 60);
    // Howard Hinnant's civil_from_days.
    let days = (seconds / 86_400) as i64 + 719_468;
    let era = days.div_euclid(146_097);
    let day_of_era = days.rem_euclid(146_097);
    let year_of_era =
        (day_of_era - day_of_era / 1460 + day_of_era / 36_524 - day_of_era / 146_096) / 365;
    let day_of_year = day_of_era - (365 * year_of_era + year_of_era / 4 - year_of_era / 100);
    let shifted_month = (5 * day_of_year + 2) / 153;
    let day = day_of_year - (153 * shifted_month + 2) / 5 + 1;
    let month = if shifted_month < 10 {
        shifted_month + 3
    } else {
        shifted_month - 9
    };
    let year = year_of_era + era * 400 + i64::from(month <= 2);
    format!(
        "{year:04}-{month:02}-{day:02}T{hour:02}:{minute:02}:{second:02}.{:03}Z",
        ms % 1000
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn formats_utc_timestamps() {
        assert_eq!(timestamp(0), "1970-01-01T00:00:00.000Z");
        assert_eq!(timestamp(951_782_400_123), "2000-02-29T00:00:00.123Z");
        assert_eq!(timestamp(1_780_000_000_000), "2026-05-28T20:26:40.000Z");
    }
}
