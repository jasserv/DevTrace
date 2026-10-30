//! Input validation shared by commands. The frontend mirrors these rules for instant
//! feedback, but the backend is authoritative.

use crate::error::{AppError, AppResult};

pub struct TextRule {
    pub field: &'static str,
    pub label: &'static str,
    pub max_chars: usize,
    pub required: bool,
    pub multiline: bool,
}

/// Trims and validates a text value, returning the normalized string.
pub fn text(rule: &TextRule, value: &str) -> AppResult<String> {
    check(rule, value.trim())
}

/// Validates preformatted text such as commands, configuration or notes. Leading blank lines
/// and trailing whitespace are removed; indentation of the first line is preserved.
pub fn preformatted(rule: &TextRule, value: &str) -> AppResult<String> {
    let trimmed_end = value.trim_end();
    let mut start = 0;
    for line in trimmed_end.split_inclusive('\n') {
        if !line.trim().is_empty() {
            break;
        }
        start += line.len();
    }
    check(rule, &trimmed_end[start..])
}

fn check(rule: &TextRule, normalized: &str) -> AppResult<String> {
    if normalized.is_empty() {
        if rule.required {
            return Err(AppError::validation(
                rule.field,
                format!("{} is required.", rule.label),
            ));
        }
        return Ok(String::new());
    }
    if normalized.chars().count() > rule.max_chars {
        return Err(AppError::validation(
            rule.field,
            format!(
                "{} must be {} characters or fewer.",
                rule.label, rule.max_chars
            ),
        ));
    }
    let invalid = normalized.chars().any(|c| {
        if c == '\n' || c == '\r' || c == '\t' {
            !rule.multiline
        } else {
            c.is_control()
        }
    });
    if invalid {
        let message = if rule.multiline {
            format!("{} contains unsupported control characters.", rule.label)
        } else {
            format!(
                "{} must be a single line without control characters.",
                rule.label
            )
        };
        return Err(AppError::validation(rule.field, message));
    }
    Ok(normalized.to_string())
}

/// Validates that an identifier looks like one we generated, before it reaches SQL.
pub fn id(field: &'static str, value: &str) -> AppResult<String> {
    let trimmed = value.trim();
    if trimmed.is_empty()
        || trimmed.len() > 64
        || !trimmed
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '-')
    {
        return Err(AppError::validation(field, "The identifier is not valid."));
    }
    Ok(trimmed.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    const NAME: TextRule = TextRule {
        field: "name",
        label: "Name",
        max_chars: 5,
        required: true,
        multiline: false,
    };
    const NOTES: TextRule = TextRule {
        field: "notes",
        label: "Notes",
        max_chars: 50,
        required: false,
        multiline: true,
    };
    const CODE: TextRule = TextRule {
        field: "code",
        label: "Command",
        max_chars: 40,
        required: true,
        multiline: true,
    };

    #[test]
    fn trims_and_accepts_valid_text() {
        assert_eq!(text(&NAME, "  Lab  ").unwrap(), "Lab");
    }

    #[test]
    fn rejects_missing_required_text() {
        let error = text(&NAME, "   ").unwrap_err();
        assert_eq!(error.field(), Some("name"));
        assert_eq!(error.to_string(), "Name is required.");
    }

    #[test]
    fn allows_empty_optional_text() {
        assert_eq!(text(&NOTES, "  ").unwrap(), "");
    }

    #[test]
    fn counts_characters_not_bytes() {
        assert!(text(&NAME, "ééééé").is_ok());
        assert!(text(&NAME, "éééééé").is_err());
    }

    #[test]
    fn single_line_rejects_newlines_multiline_allows_them() {
        assert!(text(&NAME, "a\nb").is_err());
        assert_eq!(text(&NOTES, "line 1\nline 2").unwrap(), "line 1\nline 2");
        assert!(text(&NOTES, "bell\u{7}").is_err());
    }

    #[test]
    fn preformatted_keeps_indentation_and_drops_blank_edges() {
        assert_eq!(
            preformatted(&CODE, "\n  \n    show running-config\n  | include ntp \n\n").unwrap(),
            "    show running-config\n  | include ntp"
        );
        assert_eq!(
            preformatted(&CODE, "\r\n\tGet-Service\r\n").unwrap(),
            "\tGet-Service"
        );
        assert_eq!(
            preformatted(&CODE, " \n \n").unwrap_err().to_string(),
            "Command is required."
        );
        assert!(preformatted(&CODE, "echo \u{1b}[31m").is_err());
        assert!(preformatted(&CODE, &"x".repeat(41)).is_err());
    }

    #[test]
    fn validates_identifiers() {
        assert!(id("id", "0190f5c2-7a3b-7c3d-8e4f-123456789abc").is_ok());
        assert!(id("id", "").is_err());
        assert!(id("id", "x'; DROP TABLE projects; --").is_err());
    }
}
