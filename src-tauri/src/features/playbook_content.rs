//! The playbook document: sections, numbered steps and the provenance of every item.
//!
//! Items copied from reviewed session steps are `session`; once changed in the editor they are
//! `edited`; items written in the playbook are `authored`. Generation never writes verification
//! results, expected results or warnings that were not recorded: those sections start empty.

use std::collections::HashSet;

use serde::{Deserialize, Serialize};

use crate::clock;
use crate::error::{AppError, AppResult};
use crate::features::events::{Event, EventReviewStatus, EventSource};
use crate::validate::{self, TextRule};

pub const SCHEMA_VERSION: u32 = 1;
pub const MAX_STEPS: usize = 500;
pub const MAX_LIST_ITEMS: usize = 100;

text_enum! {
    /// Where an item of a playbook came from.
    pub enum Origin {
        /// Copied unchanged from an approved session step.
        Session => "session",
        /// Copied from a session step, then changed in the playbook editor.
        Edited => "edited",
        /// Written in the playbook editor.
        Authored => "authored",
    }
}

fn authored() -> Origin {
    Origin::Authored
}

fn schema_version() -> u32 {
    SCHEMA_VERSION
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ListItem {
    pub id: String,
    pub text: String,
    #[serde(default = "authored")]
    pub origin: Origin,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PlaybookStep {
    pub id: String,
    pub title: String,
    #[serde(default)]
    pub instruction: String,
    /// Command or configuration snippet, shown monospaced. Never executed.
    #[serde(default)]
    pub command: String,
    #[serde(default)]
    pub expected_result: String,
    #[serde(default)]
    pub note: String,
    /// Evidence copies (`playbook_assets`) shown with the step.
    #[serde(default)]
    pub asset_ids: Vec<String>,
    #[serde(default = "authored")]
    pub origin: Origin,
    #[serde(default)]
    pub source_session_id: Option<String>,
    #[serde(default)]
    pub source_event_id: Option<String>,
    /// How the source step was recorded (capture, file, clipboard, manual).
    #[serde(default)]
    pub source_kind: Option<EventSource>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PlaybookContent {
    #[serde(default = "schema_version")]
    pub schema_version: u32,
    #[serde(default)]
    pub purpose: String,
    #[serde(default)]
    pub scope: String,
    #[serde(default)]
    pub prerequisites: Vec<ListItem>,
    #[serde(default)]
    pub permissions: Vec<ListItem>,
    #[serde(default)]
    pub steps: Vec<PlaybookStep>,
    #[serde(default)]
    pub verification: Vec<ListItem>,
    #[serde(default)]
    pub warnings: Vec<ListItem>,
    #[serde(default)]
    pub troubleshooting: Vec<ListItem>,
    #[serde(default)]
    pub rollback: Vec<ListItem>,
}

impl Default for PlaybookContent {
    fn default() -> Self {
        Self {
            schema_version: SCHEMA_VERSION,
            purpose: String::new(),
            scope: String::new(),
            prerequisites: Vec::new(),
            permissions: Vec::new(),
            steps: Vec::new(),
            verification: Vec::new(),
            warnings: Vec::new(),
            troubleshooting: Vec::new(),
            rollback: Vec::new(),
        }
    }
}

impl PlaybookContent {
    /// Reads stored content; a missing or older document becomes an empty current one.
    pub fn from_json(raw: &str) -> Self {
        serde_json::from_str::<Self>(raw).unwrap_or_default()
    }

    pub fn asset_ids(&self) -> HashSet<&str> {
        self.steps
            .iter()
            .flat_map(|step| step.asset_ids.iter().map(String::as_str))
            .collect()
    }
}

const fn rule(
    field: &'static str,
    label: &'static str,
    max_chars: usize,
    required: bool,
) -> TextRule {
    TextRule {
        field,
        label,
        max_chars,
        required,
        multiline: true,
    }
}

const PURPOSE: TextRule = rule("purpose", "Purpose", 10_000, false);
const SCOPE: TextRule = rule("scope", "Scope", 10_000, false);
const ITEM: TextRule = rule("items", "Item", 2_000, true);
const STEP_TITLE: TextRule = TextRule {
    field: "steps",
    label: "Step title",
    max_chars: 200,
    required: true,
    multiline: false,
};
const INSTRUCTION: TextRule = rule("steps", "Instruction", 10_000, false);
const COMMAND: TextRule = rule("steps", "Command", 20_000, false);
const EXPECTED: TextRule = rule("steps", "Expected result", 5_000, false);
const NOTE: TextRule = rule("steps", "Note", 5_000, false);

fn list(
    field: &'static str,
    label: &str,
    items: &[ListItem],
    ids: &mut HashSet<String>,
) -> AppResult<Vec<ListItem>> {
    if items.len() > MAX_LIST_ITEMS {
        return Err(AppError::validation(
            field,
            format!("{label} can have at most {MAX_LIST_ITEMS} items."),
        ));
    }
    items
        .iter()
        .map(|item| {
            let id = validate::id(field, &item.id)?;
            if !ids.insert(id.clone()) {
                return Err(AppError::validation(
                    field,
                    "Item identifiers must be unique.",
                ));
            }
            let text =
                validate::preformatted(&TextRule { field, ..ITEM }, &item.text).map_err(|_| {
                    AppError::validation(
                        field,
                        format!("Every item in {label} needs text of at most 2000 characters."),
                    )
                })?;
            Ok(ListItem {
                id,
                text,
                origin: item.origin,
            })
        })
        .collect()
}

/// Validates and normalizes a document. `asset_ids` are the evidence copies of this playbook.
pub fn validate_content(
    content: &PlaybookContent,
    asset_ids: &HashSet<String>,
) -> AppResult<PlaybookContent> {
    if content.schema_version != SCHEMA_VERSION {
        return Err(AppError::validation(
            "content",
            "This playbook was written by a different version of DevTrace.",
        ));
    }
    if content.steps.len() > MAX_STEPS {
        return Err(AppError::validation(
            "steps",
            format!("A playbook can have at most {MAX_STEPS} steps."),
        ));
    }
    let mut ids = HashSet::new();
    let steps = content
        .steps
        .iter()
        .enumerate()
        .map(|(index, step)| {
            let number = index + 1;
            let id = validate::id("steps", &step.id)?;
            if !ids.insert(id.clone()) {
                return Err(AppError::validation(
                    "steps",
                    "Step identifiers must be unique.",
                ));
            }
            let title = validate::text(&STEP_TITLE, &step.title).map_err(|_| {
                AppError::validation(
                    "steps",
                    format!("Step {number} needs a title of at most 200 characters."),
                )
            })?;
            for asset in &step.asset_ids {
                if !asset_ids.contains(asset) {
                    return Err(AppError::validation(
                        "steps",
                        format!(
                            "Step {number} refers to an image that is not part of this playbook."
                        ),
                    ));
                }
            }
            if step.origin != Origin::Authored && step.source_event_id.is_none() {
                return Err(AppError::validation(
                    "steps",
                    format!(
                        "Step {number} is marked as coming from a session but has no source step."
                    ),
                ));
            }
            Ok(PlaybookStep {
                id,
                title,
                instruction: validate::preformatted(&INSTRUCTION, &step.instruction)?,
                command: validate::preformatted(&COMMAND, &step.command)?,
                expected_result: validate::preformatted(&EXPECTED, &step.expected_result)?,
                note: validate::preformatted(&NOTE, &step.note)?,
                asset_ids: step.asset_ids.clone(),
                origin: step.origin,
                source_session_id: step.source_session_id.clone(),
                source_event_id: step.source_event_id.clone(),
                source_kind: step.source_kind,
            })
        })
        .collect::<AppResult<Vec<_>>>()?;
    Ok(PlaybookContent {
        schema_version: SCHEMA_VERSION,
        purpose: validate::preformatted(&PURPOSE, &content.purpose)?,
        scope: validate::preformatted(&SCOPE, &content.scope)?,
        prerequisites: list(
            "prerequisites",
            "Prerequisites",
            &content.prerequisites,
            &mut ids,
        )?,
        permissions: list(
            "permissions",
            "Required permissions",
            &content.permissions,
            &mut ids,
        )?,
        steps,
        verification: list(
            "verification",
            "Verification",
            &content.verification,
            &mut ids,
        )?,
        warnings: list("warnings", "Warnings", &content.warnings, &mut ids)?,
        troubleshooting: list(
            "troubleshooting",
            "Troubleshooting",
            &content.troubleshooting,
            &mut ids,
        )?,
        rollback: list("rollback", "Rollback", &content.rollback, &mut ids)?,
    })
}

/// One playbook step per approved session step, in timeline order. `assets_for` returns the
/// evidence copies made for an event. Rejected, excluded and pending steps are never used.
pub fn steps_from_events(
    session_id: &str,
    events: &[Event],
    mut assets_for: impl FnMut(&Event) -> Vec<String>,
) -> Vec<PlaybookStep> {
    events
        .iter()
        .filter(|event| event.review_status == EventReviewStatus::Approved)
        .map(|event| PlaybookStep {
            id: clock::new_id(),
            title: event.title.clone(),
            instruction: event.description.clone(),
            command: if event.event_type.has_code() {
                event.code.clone()
            } else {
                String::new()
            },
            expected_result: String::new(),
            note: event.notes.clone(),
            asset_ids: assets_for(event),
            origin: Origin::Session,
            source_session_id: Some(session_id.to_string()),
            source_event_id: Some(event.id.clone()),
            source_kind: Some(event.source),
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::features::events::EventType;

    fn event(id: &str, status: EventReviewStatus, event_type: EventType) -> Event {
        Event {
            id: id.into(),
            session_id: "s".into(),
            position: 0,
            occurred_at: "t".into(),
            event_type,
            source: EventSource::Manual,
            title: format!("Title {id}"),
            description: "Do it".into(),
            notes: "Careful".into(),
            code: if event_type == EventType::Command {
                "show version".into()
            } else {
                String::new()
            },
            review_status: status,
            created_at: "t".into(),
            updated_at: "t".into(),
            metadata: serde_json::json!({}),
            attachments: Vec::new(),
        }
    }

    #[test]
    fn generates_only_from_approved_steps_and_invents_nothing() {
        let events = vec![
            event("a", EventReviewStatus::Approved, EventType::Step),
            event("b", EventReviewStatus::Rejected, EventType::Step),
            event("c", EventReviewStatus::Excluded, EventType::Step),
            event("d", EventReviewStatus::Pending, EventType::Step),
            event("e", EventReviewStatus::Approved, EventType::Command),
        ];
        let steps = steps_from_events("s", &events, |event| vec![format!("asset-{}", event.id)]);
        assert_eq!(steps.len(), 2);
        assert_eq!(steps[0].title, "Title a");
        assert_eq!(steps[0].instruction, "Do it");
        assert_eq!(steps[0].note, "Careful");
        assert_eq!(steps[0].command, "");
        assert_eq!(
            steps[0].expected_result, "",
            "expected results are never invented"
        );
        assert_eq!(steps[0].origin, Origin::Session);
        assert_eq!(steps[0].source_event_id.as_deref(), Some("a"));
        assert_eq!(steps[0].asset_ids, ["asset-a"]);
        assert_eq!(steps[1].command, "show version");
    }

    #[test]
    fn stored_documents_round_trip_and_unknown_fields_are_rejected() {
        let content = PlaybookContent {
            purpose: "Rotate keys".into(),
            verification: vec![ListItem {
                id: "v1".into(),
                text: "Login works".into(),
                origin: Origin::Authored,
            }],
            ..PlaybookContent::default()
        };
        let json = serde_json::to_string(&content).unwrap();
        assert_eq!(PlaybookContent::from_json(&json), content);
        assert_eq!(PlaybookContent::from_json("{}"), PlaybookContent::default());
        assert!(
            serde_json::from_str::<PlaybookContent>(r#"{"purpose":"x","aiSummary":"y"}"#).is_err()
        );
    }

    fn step(id: &str) -> PlaybookStep {
        PlaybookStep {
            id: id.into(),
            title: format!(" Step {id} "),
            instruction: "\n  Run it\n".into(),
            command: String::new(),
            expected_result: String::new(),
            note: String::new(),
            asset_ids: Vec::new(),
            origin: Origin::Authored,
            source_session_id: None,
            source_event_id: None,
            source_kind: None,
        }
    }

    #[test]
    fn validation_normalizes_text_and_checks_references() {
        let assets: HashSet<String> = ["img1".to_string()].into();
        let mut content = PlaybookContent {
            steps: vec![step("s1")],
            ..PlaybookContent::default()
        };
        content.steps[0].asset_ids = vec!["img1".into()];
        let valid = validate_content(&content, &assets).unwrap();
        assert_eq!(valid.steps[0].title, "Step s1");
        assert_eq!(valid.steps[0].instruction, "  Run it");

        let mut foreign = content.clone();
        foreign.steps[0].asset_ids = vec!["other".into()];
        assert_eq!(
            validate_content(&foreign, &assets).unwrap_err().field(),
            Some("steps")
        );

        let mut untitled = content.clone();
        untitled.steps[0].title = "  ".into();
        assert!(
            validate_content(&untitled, &assets)
                .unwrap_err()
                .to_string()
                .contains("Step 1 needs a title")
        );

        let mut fake_origin = content.clone();
        fake_origin.steps[0].origin = Origin::Session;
        assert!(validate_content(&fake_origin, &assets).is_err());

        let mut duplicate = content.clone();
        duplicate.verification = vec![ListItem {
            id: "s1".into(),
            text: "x".into(),
            origin: Origin::Authored,
        }];
        assert!(validate_content(&duplicate, &assets).is_err());

        let mut empty_item = content.clone();
        empty_item.warnings = vec![ListItem {
            id: "w1".into(),
            text: " ".into(),
            origin: Origin::Authored,
        }];
        assert_eq!(
            validate_content(&empty_item, &assets).unwrap_err().field(),
            Some("warnings")
        );

        let mut wrong_version = content;
        wrong_version.schema_version = 99;
        assert!(validate_content(&wrong_version, &assets).is_err());
    }
}
