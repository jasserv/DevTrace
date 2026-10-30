//! Log formats: turn lines of a terminal log into recorded entries. Each format is an adapter
//! behind `TranscriptParser`, so more formats can be added without touching the watcher.
//!
//! Text that looks like a secret (`password=…`, `--token …`, bearer tokens) is masked before
//! anything is stored. Masking is a safety net for obvious cases, not a guarantee; recorded steps
//! still go through review.

/// A recorded piece of a terminal session.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum LogEntry {
    /// A command typed at a prompt and the output that followed it.
    Command {
        command: String,
        output: Vec<String>,
    },
    /// Output without a recognized command.
    Output { lines: Vec<String> },
}

/// Turns log lines into entries.
pub trait TranscriptParser: Send {
    /// Feeds one complete line; returns entries that are now complete.
    fn push_line(&mut self, line: &str) -> Vec<LogEntry>;
    /// Returns what is buffered (after a quiet period, or when logging stops).
    fn flush(&mut self) -> Option<LogEntry>;
}

/// Lines kept per entry; longer output is split into several entries.
const MAX_LINES: usize = 400;

/// PowerShell transcripts (`Start-Transcript`): prompt lines (`PS C:\path> command`) start a
/// command; the following lines are its output. Blocks framed by lines of asterisks (the
/// transcript header and footer, invocation headers) describe the session, not the work, and are
/// skipped.
#[derive(Default)]
pub struct PowerShellTranscript {
    in_block: bool,
    command: Option<String>,
    output: Vec<String>,
}

fn is_frame(line: &str) -> bool {
    let trimmed = line.trim();
    trimmed.len() >= 10 && trimmed.chars().all(|character| character == '*')
}

/// `PS C:\Users\me> Get-Service` → `Get-Service`; `PS>dir` → `dir`.
fn prompt_command(line: &str) -> Option<&str> {
    let rest = line.strip_prefix("PS")?;
    if !(rest.starts_with(' ') || rest.starts_with('>')) {
        return None;
    }
    let end = rest.find('>')?;
    if end > 260 {
        return None;
    }
    Some(rest[end + 1..].trim())
}

impl PowerShellTranscript {
    fn finish_command(&mut self) -> Option<LogEntry> {
        let output = trim_blank(std::mem::take(&mut self.output));
        match self.command.take() {
            Some(command) => Some(LogEntry::Command { command, output }),
            None if !output.is_empty() => Some(LogEntry::Output { lines: output }),
            None => None,
        }
    }
}

impl TranscriptParser for PowerShellTranscript {
    fn push_line(&mut self, line: &str) -> Vec<LogEntry> {
        if is_frame(line) {
            self.in_block = !self.in_block;
            return Vec::new();
        }
        if self.in_block {
            return Vec::new();
        }
        let mut entries = Vec::new();
        if let Some(command) = prompt_command(line) {
            entries.extend(self.finish_command());
            if !command.is_empty() {
                self.command = Some(mask_secrets(command));
            }
            return entries;
        }
        self.output.push(mask_secrets(line));
        if self.output.len() >= MAX_LINES {
            entries.extend(self.finish_command());
        }
        entries
    }

    fn flush(&mut self) -> Option<LogEntry> {
        self.finish_command()
    }
}

/// Any other text log (PuTTY session logs, `tee` output…): lines are grouped into output entries
/// between quiet periods.
#[derive(Default)]
pub struct PlainLog {
    lines: Vec<String>,
}

impl TranscriptParser for PlainLog {
    fn push_line(&mut self, line: &str) -> Vec<LogEntry> {
        self.lines.push(mask_secrets(line));
        if self.lines.len() >= MAX_LINES {
            return self.flush().into_iter().collect();
        }
        Vec::new()
    }

    fn flush(&mut self) -> Option<LogEntry> {
        let lines = trim_blank(std::mem::take(&mut self.lines));
        (!lines.is_empty()).then_some(LogEntry::Output { lines })
    }
}

fn trim_blank(mut lines: Vec<String>) -> Vec<String> {
    while lines.last().is_some_and(|line| line.trim().is_empty()) {
        lines.pop();
    }
    let leading = lines
        .iter()
        .take_while(|line| line.trim().is_empty())
        .count();
    lines.drain(..leading);
    lines
}

const SECRET_KEYS: &[&str] = &[
    "password",
    "passwd",
    "pwd",
    "passphrase",
    "secret",
    "token",
    "apikey",
    "api_key",
    "api-key",
    "access_key",
    "accesskey",
    "private_key",
    "client_secret",
];

const MASK: &str = "********";

/// Masks values that follow secret-looking keys (`password=…`, `token: …`, `--password …`,
/// `-Password …`) and bearer tokens.
pub fn mask_secrets(line: &str) -> String {
    let lower = line.to_ascii_lowercase();
    let bytes = line.as_bytes();
    let mut ranges: Vec<(usize, usize)> = Vec::new();
    for key in SECRET_KEYS.iter().chain(["bearer", "basic"].iter()) {
        let mut from = 0;
        while let Some(found) = lower[from..].find(key) {
            let start = from + found;
            from = start + key.len();
            let before = start.checked_sub(1).map(|index| bytes[index]);
            if before.is_some_and(|byte| byte.is_ascii_alphanumeric()) {
                continue;
            }
            let mut index = start + key.len();
            // Only exact keys: `password1` or `passwordless` do not match.
            if bytes
                .get(index)
                .is_some_and(|byte| byte.is_ascii_alphanumeric())
            {
                continue;
            }
            // Optional closing quote of a quoted key: "password": value
            if matches!(bytes.get(index), Some(b'"' | b'\'')) {
                index += 1;
            }
            let after_spaces = |mut position: usize| {
                while bytes
                    .get(position)
                    .is_some_and(|byte| *byte == b' ' || *byte == b'\t')
                {
                    position += 1;
                }
                position
            };
            let auth_scheme = *key == "bearer" || *key == "basic";
            let flag = before == Some(b'-');
            let mut value_start = after_spaces(index);
            match bytes.get(value_start) {
                Some(b'=' | b':') if !auth_scheme => value_start = after_spaces(value_start + 1),
                Some(_) if auth_scheme || flag => {
                    if value_start == index {
                        continue;
                    }
                }
                _ => continue,
            }
            let quote = match bytes.get(value_start) {
                Some(quote @ (b'"' | b'\'')) => {
                    value_start += 1;
                    Some(*quote)
                }
                _ => None,
            };
            let mut value_end = value_start;
            while let Some(byte) = bytes.get(value_end) {
                let stop = match quote {
                    Some(quote) => *byte == quote,
                    None => {
                        byte.is_ascii_whitespace()
                            || matches!(byte, b';' | b',' | b'&' | b'"' | b'\'')
                    }
                };
                if stop {
                    break;
                }
                value_end += 1;
            }
            if value_end > value_start {
                ranges.push((value_start, value_end));
            }
        }
    }
    if ranges.is_empty() {
        return line.to_string();
    }
    ranges.sort_unstable();
    let mut out = String::with_capacity(line.len());
    let mut position = 0;
    for (start, end) in ranges {
        if start < position {
            continue;
        }
        out.push_str(&line[position..start]);
        out.push_str(MASK);
        position = end;
    }
    out.push_str(&line[position..]);
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn feed(parser: &mut dyn TranscriptParser, text: &str) -> Vec<LogEntry> {
        let mut entries = Vec::new();
        for line in text.lines() {
            entries.extend(parser.push_line(line));
        }
        entries.extend(parser.flush());
        entries
    }

    #[test]
    fn powershell_commands_are_paired_with_their_output_and_frames_skipped() {
        let transcript = "**********************\n\
            Transcript header line\n\
            Another header line\n\
            **********************\n\
            Transcript started, output file is C:\\logs\\a.txt\n\
            PS C:\\Users\\me> Get-Service sshd\n\
            \n\
            Status   Name\n\
            Running  sshd\n\
            \n\
            PS C:\\Users\\me>\n\
            PS C:\\Users\\me> Restart-Service sshd\n\
            PS C:\\Users\\me> Stop-Transcript\n\
            **********************\n\
            Transcript footer\n\
            **********************\n";
        let entries = feed(&mut PowerShellTranscript::default(), transcript);
        assert_eq!(
            entries,
            [
                LogEntry::Output {
                    lines: vec!["Transcript started, output file is C:\\logs\\a.txt".into()]
                },
                LogEntry::Command {
                    command: "Get-Service sshd".into(),
                    output: vec!["Status   Name".into(), "Running  sshd".into()],
                },
                LogEntry::Command {
                    command: "Restart-Service sshd".into(),
                    output: vec![]
                },
                LogEntry::Command {
                    command: "Stop-Transcript".into(),
                    output: vec![]
                },
            ]
        );
    }

    #[test]
    fn plain_logs_group_lines_until_flushed() {
        let mut parser = PlainLog::default();
        assert!(parser.push_line("router# show version").is_empty());
        assert!(parser.push_line("Version 17.9").is_empty());
        assert_eq!(
            parser.flush(),
            Some(LogEntry::Output {
                lines: vec!["router# show version".into(), "Version 17.9".into()]
            })
        );
        assert_eq!(parser.flush(), None);
        for index in 0..MAX_LINES - 1 {
            assert!(parser.push_line(&format!("line {index}")).is_empty());
        }
        assert_eq!(parser.push_line("last").len(), 1, "long output is split");
    }

    #[test]
    fn obvious_secrets_are_masked() {
        assert_eq!(
            mask_secrets("mysql -u root password=hunter2 db"),
            "mysql -u root password=******** db"
        );
        assert_eq!(
            mask_secrets("export API_KEY=abc123"),
            "export API_KEY=********"
        );
        assert_eq!(
            mask_secrets("\"token\": \"eyJhbGciOi\","),
            "\"token\": \"********\","
        );
        assert_eq!(
            mask_secrets("curl -H 'Authorization: Bearer abc.def'"),
            "curl -H 'Authorization: Bearer ********'"
        );
        assert_eq!(
            mask_secrets("tool --password s3cret --verbose"),
            "tool --password ******** --verbose"
        );
        assert_eq!(
            mask_secrets("New-LocalUser -Password $pw"),
            "New-LocalUser -Password ********"
        );
        assert_eq!(
            mask_secrets("Set-Item passwordless enabled"),
            "Set-Item passwordless enabled"
        );
        assert_eq!(mask_secrets("Get-Service sshd"), "Get-Service sshd");
        assert_eq!(mask_secrets("pwd"), "pwd");
    }
}
