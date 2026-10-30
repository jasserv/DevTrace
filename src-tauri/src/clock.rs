//! Identifier and timestamp conventions.
//!
//! * Identifiers are UUIDv7 strings: globally unique, stable, and roughly time-ordered.
//! * Timestamps are RFC 3339 UTC strings with millisecond precision, for example
//!   `2026-10-22T15:33:42.123Z`. The fixed width makes lexical order equal chronological order.

use chrono::{SecondsFormat, Utc};

pub fn new_id() -> String {
    uuid::Uuid::now_v7().to_string()
}

pub fn now() -> String {
    Utc::now().to_rfc3339_opts(SecondsFormat::Millis, true)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ids_are_unique_uuid_strings() {
        let a = new_id();
        let b = new_id();
        assert_ne!(a, b);
        assert_eq!(a.len(), 36);
        assert!(uuid::Uuid::parse_str(&a).is_ok());
    }

    #[test]
    fn timestamps_are_fixed_width_utc() {
        let ts = now();
        assert_eq!(ts.len(), "2026-10-22T15:33:42.123Z".len());
        assert!(ts.ends_with('Z'));
        assert!(chrono::DateTime::parse_from_rfc3339(&ts).is_ok());
    }
}
