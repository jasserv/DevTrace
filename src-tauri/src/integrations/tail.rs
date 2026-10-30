//! Incremental reading of a growing text file (a terminal log). Only complete lines are returned;
//! a partial last line waits for its newline. The encoding is detected from the first bytes:
//! UTF-16 LE/BE with a byte order mark, otherwise UTF-8 (with or without a BOM).

use std::fs::File;
use std::io::{Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};

use crate::error::AppResult;

/// Reads at most this much new text per poll, so a sudden large write cannot exhaust memory.
const MAX_READ: u64 = 1024 * 1024;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Encoding {
    Unknown,
    Utf8,
    Utf16Le,
    Utf16Be,
}

pub struct TailReader {
    path: PathBuf,
    offset: u64,
    encoding: Encoding,
    /// Undecoded bytes (an incomplete UTF-8 sequence or an odd UTF-16 byte).
    pending: Vec<u8>,
    /// Decoded text after the last complete line.
    partial: String,
}

impl TailReader {
    pub fn new(path: &Path) -> Self {
        Self {
            path: path.to_path_buf(),
            offset: 0,
            encoding: Encoding::Unknown,
            pending: Vec::new(),
            partial: String::new(),
        }
    }

    /// Bytes consumed so far.
    pub fn offset(&self) -> u64 {
        self.offset
    }

    /// Returns the complete lines appended since the last call. A file that shrank (truncated or
    /// replaced) is read again from the start.
    pub fn read_lines(&mut self) -> AppResult<Vec<String>> {
        let mut file = File::open(&self.path)?;
        let length = file.metadata()?.len();
        if length < self.offset {
            self.offset = 0;
            self.encoding = Encoding::Unknown;
            self.pending.clear();
            self.partial.clear();
        }
        if length == self.offset {
            return Ok(Vec::new());
        }
        file.seek(SeekFrom::Start(self.offset))?;
        let mut bytes = Vec::new();
        file.take(MAX_READ).read_to_end(&mut bytes)?;
        self.offset += bytes.len() as u64;
        self.pending.extend_from_slice(&bytes);
        if self.encoding == Encoding::Unknown {
            if self.pending.len() < 3 && self.offset < 3 {
                return Ok(Vec::new());
            }
            self.encoding = match self.pending.as_slice() {
                [0xFF, 0xFE, ..] => {
                    self.pending.drain(..2);
                    Encoding::Utf16Le
                }
                [0xFE, 0xFF, ..] => {
                    self.pending.drain(..2);
                    Encoding::Utf16Be
                }
                [0xEF, 0xBB, 0xBF, ..] => {
                    self.pending.drain(..3);
                    Encoding::Utf8
                }
                _ => Encoding::Utf8,
            };
        }
        let text = self.decode();
        self.partial.push_str(&text);
        let mut lines = Vec::new();
        while let Some(index) = self.partial.find('\n') {
            let mut line: String = self.partial.drain(..=index).collect();
            line.pop();
            if line.ends_with('\r') {
                line.pop();
            }
            lines.push(line);
        }
        Ok(lines)
    }

    /// Text after the last newline (returned when logging stops).
    pub fn take_partial(&mut self) -> Option<String> {
        let rest = std::mem::take(&mut self.partial);
        let rest = rest.trim_end_matches('\r').to_string();
        (!rest.trim().is_empty()).then_some(rest)
    }

    fn decode(&mut self) -> String {
        match self.encoding {
            Encoding::Utf16Le | Encoding::Utf16Be => {
                let even = self.pending.len() - self.pending.len() % 2;
                let (pairs, _) = self.pending[..even].as_chunks::<2>();
                let units: Vec<u16> = pairs
                    .iter()
                    .map(|pair| {
                        if self.encoding == Encoding::Utf16Le {
                            u16::from_le_bytes(*pair)
                        } else {
                            u16::from_be_bytes(*pair)
                        }
                    })
                    .collect();
                // Keep a trailing high surrogate for the next read.
                let keep_surrogate = units
                    .last()
                    .is_some_and(|unit| (0xD800..0xDC00).contains(unit));
                let usable = if keep_surrogate {
                    units.len() - 1
                } else {
                    units.len()
                };
                let text = String::from_utf16_lossy(&units[..usable]);
                self.pending.drain(..usable * 2);
                text
            }
            _ => match std::str::from_utf8(&self.pending) {
                Ok(text) => {
                    let text = text.to_string();
                    self.pending.clear();
                    text
                }
                Err(error) => {
                    let valid = error.valid_up_to();
                    // An incomplete sequence at the end waits for more bytes; anything else is
                    // replaced so one bad byte cannot stall the log.
                    let incomplete = error.error_len().is_none();
                    let end = if incomplete {
                        valid
                    } else {
                        valid + error.error_len().unwrap_or(1)
                    };
                    let text = String::from_utf8_lossy(&self.pending[..end]).into_owned();
                    self.pending.drain(..end);
                    text
                }
            },
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    fn append(path: &Path, bytes: &[u8]) {
        std::fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(path)
            .unwrap()
            .write_all(bytes)
            .unwrap();
    }

    #[test]
    fn returns_complete_lines_only_and_keeps_partial_text() {
        let temp = tempfile::tempdir().unwrap();
        let path = temp.path().join("log.txt");
        append(&path, b"\xEF\xBB\xBFfirst\r\nsec");
        let mut reader = TailReader::new(&path);
        assert_eq!(reader.read_lines().unwrap(), ["first"]);
        append(&path, b"ond\nthird\n");
        assert_eq!(reader.read_lines().unwrap(), ["second", "third"]);
        assert!(reader.read_lines().unwrap().is_empty());
        append(&path, b"tail");
        assert!(reader.read_lines().unwrap().is_empty());
        assert_eq!(reader.take_partial().as_deref(), Some("tail"));
    }

    #[test]
    fn decodes_utf16_and_split_utf8_sequences() {
        let temp = tempfile::tempdir().unwrap();
        let path = temp.path().join("utf16.txt");
        let mut bytes = vec![0xFF, 0xFE];
        for unit in "PS C:\\> dir\r\nCaf\u{e9}\r\n".encode_utf16() {
            bytes.extend_from_slice(&unit.to_le_bytes());
        }
        append(&path, &bytes[..9]);
        let mut reader = TailReader::new(&path);
        let mut lines = reader.read_lines().unwrap();
        append(&path, &bytes[9..]);
        lines.extend(reader.read_lines().unwrap());
        assert_eq!(lines, ["PS C:\\> dir", "Caf\u{e9}"]);

        let utf8 = temp.path().join("utf8.txt");
        let word = "na\u{ef}ve\n".as_bytes();
        append(&utf8, &word[..3]);
        let mut reader = TailReader::new(&utf8);
        assert!(reader.read_lines().unwrap().is_empty());
        append(&utf8, &word[3..]);
        assert_eq!(reader.read_lines().unwrap(), ["na\u{ef}ve"]);
    }

    #[test]
    fn starts_over_when_the_file_is_truncated() {
        let temp = tempfile::tempdir().unwrap();
        let path = temp.path().join("log.txt");
        append(&path, b"one\ntwo\n");
        let mut reader = TailReader::new(&path);
        assert_eq!(reader.read_lines().unwrap().len(), 2);
        std::fs::write(&path, b"new\n").unwrap();
        assert_eq!(reader.read_lines().unwrap(), ["new"]);
    }
}
