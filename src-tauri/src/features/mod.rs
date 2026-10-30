//! Feature modules. Each owns its domain types, SQL and thin Tauri command handlers.
//! Native capture lives in `crate::capture` and document export in `crate::export`, so their
//! responsibilities stay isolated.

pub mod attachments;
pub mod changes;
pub mod events;
pub mod overview;
pub mod playbook_content;
pub mod playbooks;
pub mod projects;
pub mod review;
pub mod revisions;
pub mod sessions;
pub mod settings;
pub mod system;
