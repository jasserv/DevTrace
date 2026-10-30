//! Automatic capture when the screen changes (Milestone 8, opt-in per capture).
//!
//! While a capture is recording with automatic capture on, the target is sampled about once a
//! second as a 96×64 grayscale image that stays in memory. When the sample differs clearly from
//! the last screenshot and has stopped changing (the screen settled), a full screenshot is taken
//! like any other, with the trigger `auto`. Nothing is sampled while paused. This notices visible
//! changes only: it does not observe clicks, keystrokes or any other input.

use std::collections::VecDeque;
use std::time::{Duration, Instant};

/// How often the target is sampled.
pub const SAMPLE_INTERVAL: Duration = Duration::from_millis(1000);
/// A sample point counts as different when its brightness changed by more than this.
const PIXEL_THRESHOLD: u8 = 16;
/// Share of sample points that must differ from the last screenshot to count as a change.
const CHANGE_FRACTION: f64 = 0.02;
/// Share of sample points that must differ between consecutive samples to count as motion.
const MOTION_FRACTION: f64 = 0.004;
/// Consecutive still samples required before a changed screen counts as settled.
const SETTLE_SAMPLES: u32 = 2;
/// Minimum time between automatic screenshots.
const MIN_INTERVAL: Duration = Duration::from_secs(3);
/// At most this many automatic screenshots per minute.
const MAX_PER_MINUTE: usize = 12;

/// Share of positions whose values differ by more than `PIXEL_THRESHOLD`.
pub fn difference(a: &[u8], b: &[u8]) -> f64 {
    if a.is_empty() || a.len() != b.len() {
        return 1.0;
    }
    let changed = a
        .iter()
        .zip(b)
        .filter(|(left, right)| left.abs_diff(**right) > PIXEL_THRESHOLD)
        .count();
    changed as f64 / a.len() as f64
}

/// Decides when a sampled screen has changed and settled. Pure, so it is unit-tested.
#[derive(Debug, Default)]
pub struct ChangeDetector {
    /// Sample of the screen at the last screenshot (or when watching started).
    baseline: Option<Vec<u8>>,
    previous: Option<Vec<u8>>,
    still_samples: u32,
    recent_shots: VecDeque<Instant>,
}

impl ChangeDetector {
    /// Forgets everything (after a pause, or when automatic capture is switched on).
    pub fn reset(&mut self) {
        self.baseline = None;
        self.previous = None;
        self.still_samples = 0;
    }

    /// Feeds one sample; returns true when a screenshot should be taken now.
    pub fn observe(&mut self, sample: &[u8], now: Instant) -> bool {
        let Some(baseline) = &self.baseline else {
            self.baseline = Some(sample.to_vec());
            self.previous = Some(sample.to_vec());
            return false;
        };
        let changed = difference(baseline, sample) > CHANGE_FRACTION;
        let moving = self
            .previous
            .as_ref()
            .is_none_or(|previous| difference(previous, sample) > MOTION_FRACTION);
        self.still_samples = if moving { 0 } else { self.still_samples + 1 };
        self.previous = Some(sample.to_vec());
        while self
            .recent_shots
            .front()
            .is_some_and(|shot| now.duration_since(*shot) > Duration::from_secs(60))
        {
            self.recent_shots.pop_front();
        }
        let spaced = self
            .recent_shots
            .back()
            .is_none_or(|last| now.duration_since(*last) >= MIN_INTERVAL);
        changed
            && self.still_samples >= SETTLE_SAMPLES
            && spaced
            && self.recent_shots.len() < MAX_PER_MINUTE
    }

    /// Records that a screenshot was stored for `sample`.
    pub fn taken(&mut self, sample: &[u8], now: Instant) {
        self.baseline = Some(sample.to_vec());
        self.recent_shots.push_back(now);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn frame(value: u8) -> Vec<u8> {
        vec![value; 96 * 64]
    }

    /// A frame where `share` of the points are bright.
    fn partly(share: f64) -> Vec<u8> {
        let mut sample = frame(20);
        let count = (sample.len() as f64 * share) as usize;
        for value in sample.iter_mut().take(count) {
            *value = 220;
        }
        sample
    }

    #[test]
    fn a_change_is_captured_once_after_it_settles() {
        let mut detector = ChangeDetector::default();
        let start = Instant::now();
        let at = |seconds: u64| start + Duration::from_secs(seconds);
        assert!(
            !detector.observe(&frame(20), at(0)),
            "first sample is the baseline"
        );
        assert!(!detector.observe(&frame(20), at(1)), "no change");
        // A dialog opens: the screen changes and keeps changing for a moment.
        assert!(!detector.observe(&partly(0.10), at(2)), "still moving");
        assert!(!detector.observe(&partly(0.20), at(3)), "still moving");
        assert!(!detector.observe(&partly(0.20), at(4)), "settling");
        assert!(
            detector.observe(&partly(0.20), at(5)),
            "settled: take a screenshot"
        );
        detector.taken(&partly(0.20), at(5));
        assert!(
            !detector.observe(&partly(0.20), at(6)),
            "same screen as the screenshot"
        );
        assert!(!detector.observe(&partly(0.20), at(7)));
    }

    #[test]
    fn small_changes_such_as_a_blinking_cursor_are_ignored() {
        let mut detector = ChangeDetector::default();
        let start = Instant::now();
        detector.observe(&frame(20), start);
        for second in 1..10 {
            let sample = if second % 2 == 0 {
                frame(20)
            } else {
                partly(0.01)
            };
            assert!(!detector.observe(&sample, start + Duration::from_secs(second)));
        }
    }

    #[test]
    fn screenshots_are_spaced_and_limited_per_minute() {
        let mut detector = ChangeDetector::default();
        let start = Instant::now();
        let mut taken = 0;
        let mut value = 20u8;
        detector.observe(&frame(value), start);
        // A new stable screen every 3 seconds, sampled twice a second, for one minute.
        for tick in 1..120u64 {
            if tick % 6 == 0 {
                value = if value == 20 { 220 } else { 20 };
            }
            let now = start + Duration::from_millis(tick * 500);
            if detector.observe(&frame(value), now) {
                detector.taken(&frame(value), now);
                taken += 1;
            }
        }
        // 60 seconds of samples: never closer than 3 s and never more than 12 per minute.
        assert!(taken > 0);
        assert!(taken <= MAX_PER_MINUTE, "{taken} screenshots");
    }

    #[test]
    fn reset_starts_from_a_new_baseline() {
        let mut detector = ChangeDetector::default();
        let start = Instant::now();
        detector.observe(&frame(20), start);
        detector.reset();
        assert!(!detector.observe(&frame(220), start + Duration::from_secs(1)));
        assert!(!detector.observe(&frame(220), start + Duration::from_secs(2)));
        assert!(!detector.observe(&frame(220), start + Duration::from_secs(3)));
        assert!((difference(&frame(1), &frame(200)) - 1.0).abs() < f64::EPSILON);
        assert!(difference(&frame(10), &frame(20)) < f64::EPSILON);
    }
}
