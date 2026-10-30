//! Markdown export (CommonMark with GitHub task lists). Playbooks are plain text, so every piece
//! of user text is escaped to render literally: an export must never turn text into markup.

use std::fmt::Write as _;

use crate::export::RenderContext;
use crate::export::document::{self, ExportDocument};
use crate::export::images::{Figure, StepFigures};
use crate::features::playbook_content::ListItem;

/// Escapes one line of plain text for Markdown inline content.
pub fn inline(line: &str) -> String {
    let body = line.trim_start_matches([' ', '\t']);
    let indent = &line[..line.len() - body.len()];
    let body = body.trim_end();
    let mut out = String::with_capacity(line.len() + 8);
    // Indentation stays visible as non-breaking spaces and cannot start a code block.
    for character in indent.chars() {
        out.push_str(if character == '\t' {
            "\u{a0}\u{a0}\u{a0}\u{a0}"
        } else {
            "\u{a0}"
        });
    }
    let line_start = indent.is_empty();
    let ordered_marker = line_start && ordered_list_marker(body);
    for (index, character) in body.char_indices() {
        let escape = match character {
            '\\' | '`' | '*' | '_' | '[' | ']' | '<' | '>' | '|' | '~' | '#' | '$' => true,
            '-' | '+' | '=' => line_start && index == 0,
            '.' | ')' => ordered_marker && body[..index].bytes().all(|b| b.is_ascii_digit()),
            '&' => entity_like(&body[index + 1..]),
            _ => false,
        };
        if escape {
            out.push('\\');
        }
        out.push(character);
    }
    out
}

/// True when the text after an `&` would form an entity such as `&amp;` or `&#169;`.
fn entity_like(rest: &str) -> bool {
    let name = rest.strip_prefix('#').unwrap_or(rest);
    let length = name
        .bytes()
        .take_while(u8::is_ascii_alphanumeric)
        .take(32)
        .count();
    length > 0 && name.as_bytes().get(length) == Some(&b';')
}

/// `1.` or `12)` followed by a space or the end of the line starts an ordered list.
fn ordered_list_marker(body: &str) -> bool {
    let digits = body.bytes().take_while(u8::is_ascii_digit).count();
    if digits == 0 || digits > 9 {
        return false;
    }
    let rest = &body.as_bytes()[digits..];
    matches!(rest.first(), Some(b'.' | b')')) && matches!(rest.get(1), None | Some(b' ' | b'\t'))
}

/// Multi-line plain text as paragraphs; single line breaks become hard breaks.
pub fn prose(text: &str) -> String {
    let mut paragraphs = Vec::new();
    let mut lines: Vec<String> = Vec::new();
    for line in text.lines() {
        if line.trim().is_empty() {
            if !lines.is_empty() {
                paragraphs.push(lines.join("\\\n"));
                lines.clear();
            }
        } else {
            lines.push(inline(line));
        }
    }
    if !lines.is_empty() {
        paragraphs.push(lines.join("\\\n"));
    }
    paragraphs.join("\n\n")
}

/// A fenced code block whose fence is longer than any backtick run in the code.
pub fn fence(code: &str) -> String {
    let mut longest = 0;
    let mut run = 0;
    for character in code.chars() {
        if character == '`' {
            run += 1;
            longest = longest.max(run);
        } else {
            run = 0;
        }
    }
    let ticks = "`".repeat((longest + 1).max(3));
    format!("{ticks}\n{}\n{ticks}", code.trim_end())
}

/// A list item: the marker, then plain text with continuation lines indented by `indent`.
fn list_item(marker: &str, indent: usize, text: &str) -> String {
    list_item_markdown(marker, indent, &prose(text))
}

/// A list item from already rendered Markdown.
fn list_item_markdown(marker: &str, indent: usize, markdown: &str) -> String {
    let pad = " ".repeat(indent);
    markdown
        .lines()
        .enumerate()
        .map(|(index, line)| match (index, line.is_empty()) {
            (0, _) => format!("{marker}{line}"),
            (_, true) => String::new(),
            _ => format!("{pad}{line}"),
        })
        .collect::<Vec<_>>()
        .join("\n")
}

fn blockquote(text: &str) -> String {
    text.lines()
        .map(|line| {
            if line.is_empty() {
                ">".to_string()
            } else {
                format!("> {line}")
            }
        })
        .collect::<Vec<_>>()
        .join("\n")
}

fn item_text(item: &ListItem) -> String {
    match document::origin_tag(item.origin) {
        Some(tag) => format!("{}\n({tag})", item.text),
        None => item.text.clone(),
    }
}

enum ListStyle {
    Bullets,
    Numbers,
    Checklist,
    Warnings,
}

fn list_section(out: &mut String, title: &str, items: &[ListItem], style: ListStyle) {
    if items.is_empty() {
        return;
    }
    let _ = write!(out, "\n## {title}\n\n");
    let rendered: Vec<String> = items
        .iter()
        .enumerate()
        .map(|(index, item)| {
            let text = item_text(item);
            match style {
                ListStyle::Bullets => list_item("- ", 2, &text),
                ListStyle::Numbers => {
                    let marker = format!("{}. ", index + 1);
                    let indent = marker.len();
                    list_item(&marker, indent, &text)
                }
                // Continuation lines align with the item content (after "- "), not the box.
                ListStyle::Checklist => list_item("- [ ] ", 2, &text),
                ListStyle::Warnings => blockquote(&format!("**Warning:** {}", prose(&text))),
            }
        })
        .collect();
    let separator = if matches!(style, ListStyle::Warnings) {
        "\n\n"
    } else {
        "\n"
    };
    out.push_str(&rendered.join(separator));
    out.push('\n');
}

fn text_section(out: &mut String, title: &str, text: &str) {
    if text.trim().is_empty() {
        return;
    }
    let _ = write!(out, "\n## {title}\n\n{}\n", prose(text));
}

fn figure(out: &mut String, step_number: usize, position: usize, slot: Option<&Figure>, dir: &str) {
    let Some(figure) = slot else {
        let _ = write!(
            out,
            "\n*Screenshot {position} of step {step_number} is unavailable: its file is missing from the workspace.*\n"
        );
        return;
    };
    let _ = write!(
        out,
        "\n![Step {step_number}, screenshot {position}]({dir}/{})\n",
        figure.file_name
    );
    if figure.redacted {
        out.push_str("\n*Areas of this screenshot were permanently redacted.*\n");
    }
    if !figure.highlights.is_empty() {
        out.push_str(if figure.highlights_drawn {
            "\nHighlighted in the screenshot:\n\n"
        } else {
            "\nHighlighted areas (the boxes could not be drawn on this image):\n\n"
        });
        let lines: Vec<String> = figure
            .highlights
            .iter()
            .enumerate()
            .map(|(index, label)| {
                let label = if label.trim().is_empty() {
                    "Highlighted area"
                } else {
                    label
                };
                let marker = format!("{}. ", index + 1);
                let indent = marker.len();
                list_item(&marker, indent, label)
            })
            .collect();
        out.push_str(&lines.join("\n"));
        out.push('\n');
    }
}

/// Renders the document. Screenshots are referenced as `<image_dir>/<file name>`.
pub fn render(
    document: &ExportDocument,
    figures: &[StepFigures],
    context: &RenderContext,
    image_dir: &str,
) -> String {
    let content = &document.content;
    let mut out = String::new();
    let _ = writeln!(out, "# {}", inline(&document.title));
    for banner in document.banners() {
        let _ = write!(
            out,
            "\n{}\n",
            blockquote(&format!("**{}.** {}", banner.title, prose(&banner.text)))
        );
    }
    if !document.summary.trim().is_empty() {
        let _ = write!(out, "\n{}\n", prose(&document.summary));
    }
    let _ = write!(
        out,
        "\n- **Status:** {}",
        inline(&document.version.status_line())
    );
    if let document::Version::Revision { note, .. } = &document.version
        && !note.trim().is_empty()
    {
        let _ = write!(
            out,
            "\n{}",
            list_item_markdown("- ", 2, &format!("**Revision note:** {}", prose(note)))
        );
    }
    for (label, value) in &document.fields {
        let _ = write!(out, "\n- **{label}:** {}", inline(value));
    }
    out.push('\n');

    text_section(&mut out, "Purpose", &content.purpose);
    text_section(&mut out, "Scope", &content.scope);
    list_section(
        &mut out,
        "Prerequisites",
        &content.prerequisites,
        ListStyle::Bullets,
    );
    list_section(
        &mut out,
        "Required permissions",
        &content.permissions,
        ListStyle::Bullets,
    );
    list_section(&mut out, "Warnings", &content.warnings, ListStyle::Warnings);

    out.push_str("\n## Steps\n");
    if content.steps.is_empty() {
        out.push_str("\n*This playbook has no steps.*\n");
    }
    for (index, step) in content.steps.iter().enumerate() {
        let number = index + 1;
        let _ = write!(
            out,
            "\n### {number}. {}\n\n*{}*\n",
            inline(&step.title),
            inline(&document.provenance(step))
        );
        if !step.instruction.trim().is_empty() {
            let _ = write!(out, "\n{}\n", prose(&step.instruction));
        }
        if !step.command.trim().is_empty() {
            let _ = write!(out, "\n{}\n", fence(&step.command));
        }
        if !step.expected_result.trim().is_empty() {
            let _ = write!(
                out,
                "\n**Expected result:** {}\n",
                prose(&step.expected_result)
            );
        }
        if !step.note.trim().is_empty() {
            let _ = write!(out, "\n**Note:** {}\n", prose(&step.note));
        }
        if let Some(slots) = figures.get(index) {
            for (position, slot) in slots.iter().enumerate() {
                figure(&mut out, number, position + 1, slot.as_ref(), image_dir);
            }
        }
    }

    list_section(
        &mut out,
        "Verification",
        &content.verification,
        ListStyle::Checklist,
    );
    list_section(
        &mut out,
        "Troubleshooting",
        &content.troubleshooting,
        ListStyle::Bullets,
    );
    list_section(
        &mut out,
        "Rollback and recovery",
        &content.rollback,
        ListStyle::Numbers,
    );

    let _ = write!(
        out,
        "\n---\n\n*{}*\n",
        inline(&context.footer(&document.playbook_id))
    );
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::export::document::tests::sample;

    fn context() -> RenderContext {
        RenderContext {
            exported_at: "2026-10-23T07:00:00.000Z".into(),
            app_version: "0.1.0".into(),
        }
    }

    #[test]
    fn inline_text_is_escaped_to_render_literally() {
        assert_eq!(
            inline("**bold** <b>x</b> [a](b) `c` $5 | ~s~ #tag"),
            r"\*\*bold\*\* \<b\>x\</b\> \[a\](b) \`c\` \$5 \| \~s\~ \#tag"
        );
        assert_eq!(inline("- not a list"), r"\- not a list");
        assert_eq!(inline("1. not a list"), r"1\. not a list");
        assert_eq!(inline("3.14 is fine"), "3.14 is fine");
        assert_eq!(inline("R&D &amp; C:\\Temp"), r"R&D \&amp; C:\\Temp");
        assert_eq!(inline("    indented"), "\u{a0}\u{a0}\u{a0}\u{a0}indented");
        assert_eq!(inline("a - b"), "a - b");
    }

    #[test]
    fn prose_keeps_line_breaks_and_paragraphs() {
        assert_eq!(prose("one\ntwo\n\n\nthree"), "one\\\ntwo\n\nthree");
        assert_eq!(prose("ends with \\"), "ends with \\\\");
    }

    #[test]
    fn fences_are_longer_than_any_backtick_run() {
        assert_eq!(fence("ls -la"), "```\nls -la\n```");
        assert_eq!(fence("a ```` b\n"), "`````\na ```` b\n`````");
    }

    #[test]
    fn renders_every_section_in_order_with_provenance() {
        let document = sample();
        let figures = vec![vec![None], Vec::new(), Vec::new()];
        let markdown = render(&document, &figures, &context(), "images");
        let order = [
            "# Rotate the VPN certificate",
            "> **Draft.** This version has not been published",
            "- **Status:** Draft \u{2014} not published",
            "- **Platform:** FortiGate",
            "## Purpose",
            "## Scope",
            "## Prerequisites\n\n- Admin account",
            "## Required permissions",
            "## Warnings\n\n> **Warning:** Tunnels drop briefly",
            "## Steps",
            "### 1. Open the certificate list",
            "*From session \u{201c}Rotate VPN certificate\u{201d} (captured screenshot)*",
            "Open the console.\\\nSign in as admin.",
            "*Screenshot 1 of step 1 is unavailable",
            "### 2. Check expiry",
            "edited after copying*",
            "````\nget vpn certificate local\nshow ```fenced```\n````",
            "**Expected result:** The certificate is listed.",
            "**Note:** Run from the CLI console.",
            "### 3. Restart the tunnel\n\n*Written in the playbook*",
            "## Verification\n\n- [ ] Clients reconnect",
            "## Troubleshooting\n\n- Check the CA chain",
            "## Rollback and recovery\n\n1. Re-import the old certificate",
            "Exported from DevTrace 0.1.0",
        ];
        let mut from = 0;
        for expected in order {
            let found = markdown[from..]
                .find(expected)
                .unwrap_or_else(|| panic!("missing or out of order: {expected}\n\n{markdown}"));
            from += found + expected.len();
        }
        assert!(markdown.contains("never adds verification results"));
    }

    #[test]
    fn empty_sections_are_left_out_and_images_are_linked() {
        let mut document = sample();
        document.content.purpose.clear();
        document.content.verification.clear();
        let figure = Figure {
            file_name: "step-01-1.png".into(),
            media_type: "image/png",
            bytes: Vec::new(),
            width: 10,
            height: 10,
            highlights: vec!["Save".into(), String::new()],
            highlights_drawn: true,
            redacted: true,
        };
        let figures = vec![vec![Some(figure)], Vec::new(), Vec::new()];
        let markdown = render(&document, &figures, &context(), "images");
        assert!(!markdown.contains("## Purpose"));
        assert!(!markdown.contains("## Verification"));
        assert!(markdown.contains("![Step 1, screenshot 1](images/step-01-1.png)"));
        assert!(markdown.contains("permanently redacted"));
        assert!(markdown.contains("1. Save\n2. Highlighted area"));
    }
}
