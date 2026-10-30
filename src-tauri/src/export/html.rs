//! Self-contained HTML export: one file with embedded screenshots and styles, no scripts and a
//! Content-Security-Policy that forbids loading anything else. The PDF export prints this same
//! document, so the stylesheet includes print rules.

use std::fmt::Write as _;

use base64::Engine as _;
use base64::engine::general_purpose::STANDARD as BASE64;

use crate::export::RenderContext;
use crate::export::document::{self, ExportDocument};
use crate::export::images::{Figure, StepFigures};
use crate::features::playbook_content::ListItem;

/// Escapes text for HTML element content and quoted attribute values.
pub fn escape(text: &str) -> String {
    let mut out = String::with_capacity(text.len() + 16);
    for character in text.chars() {
        match character {
            '&' => out.push_str("&amp;"),
            '<' => out.push_str("&lt;"),
            '>' => out.push_str("&gt;"),
            '"' => out.push_str("&quot;"),
            '\'' => out.push_str("&#39;"),
            _ => out.push(character),
        }
    }
    out
}

/// Scripts, frames, forms, fonts and remote content are all blocked; only the embedded styles
/// and `data:` images load.
const CSP: &str = "default-src 'none'; img-src data:; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'";

/// Light-theme values of the app's design tokens (src/styles/tokens.css), so exports match.
const STYLES: &str = r#"
:root{color-scheme:light;--text:#1d1d1f;--muted:#6e6e73;--line:#e5e5e7;--surface:#f5f5f7;--accent:#007aff;--caution:#b25000;--caution-surface:#fff5e8}
*{box-sizing:border-box}
html{-webkit-text-size-adjust:100%}
body{margin:0;background:#fff;color:var(--text);font:14px/1.55 -apple-system,BlinkMacSystemFont,"Segoe UI Variable Text","Segoe UI",system-ui,sans-serif;-webkit-print-color-adjust:exact;print-color-adjust:exact}
.doc{max-width:860px;margin:0 auto;padding:40px 32px 56px}
.eyebrow{margin:0;color:var(--muted);font-size:11px;font-weight:600;letter-spacing:.06em;text-transform:uppercase}
h1{margin:4px 0 6px;font-size:26px;line-height:1.25;font-weight:650;letter-spacing:-.01em;overflow-wrap:anywhere}
h2{margin:32px 0 10px;padding-bottom:6px;border-bottom:1px solid var(--line);font-size:17px;font-weight:600}
h3{display:flex;gap:10px;align-items:baseline;margin:0 0 4px;font-size:15px;font-weight:600;overflow-wrap:anywhere}
.status{margin:0;color:var(--muted);font-size:13px}
.banner{margin:12px 0 0;padding:10px 12px;border-left:3px solid var(--accent);background:var(--surface);font-size:13px}
.banner.caution{border-left-color:var(--caution);background:var(--caution-surface)}
.banner strong{margin-right:6px}
.summary{margin:14px 0 0;font-size:15px}
.meta{display:grid;grid-template-columns:repeat(auto-fill,minmax(170px,1fr));gap:10px 24px;margin:18px 0 0;padding:12px 0;border-top:1px solid var(--line);border-bottom:1px solid var(--line)}
.meta div{min-width:0}
.meta dt{color:var(--muted);font-size:11px;font-weight:600;letter-spacing:.04em;text-transform:uppercase}
.meta dd{margin:2px 0 0;overflow-wrap:anywhere}
.text{white-space:pre-wrap;overflow-wrap:anywhere}
.items{margin:0;padding-left:22px}
.items li{margin:4px 0}
.checklist{margin:0;padding:0;list-style:none}
.checklist li{display:flex;gap:10px;margin:6px 0}
.box{flex:none;width:13px;height:13px;margin-top:4px;border:1.5px solid var(--muted);border-radius:2px}
.warning{margin:8px 0;padding:10px 12px;border-left:3px solid var(--caution);background:var(--caution-surface)}
.label{margin:0 0 3px;color:var(--muted);font-size:11px;font-weight:600;letter-spacing:.04em;text-transform:uppercase}
.warning .label{color:var(--caution)}
.tag{margin-left:6px;color:var(--muted);font-size:11px}
.steps{margin:0;padding:0;list-style:none}
.step{padding:18px 0;border-top:1px solid var(--line)}
.step:first-child{padding-top:4px;border-top:0}
.num{flex:none;display:inline-flex;align-items:center;justify-content:center;min-width:22px;height:22px;padding:0 6px;border-radius:4px;background:var(--text);color:#fff;font-size:12px;font-weight:600}
.source{margin:0 0 8px;color:var(--muted);font-size:12px}
.field{margin:12px 0 0}
pre{margin:0;padding:10px 12px;border:1px solid var(--line);border-radius:4px;background:var(--surface);white-space:pre-wrap;overflow-wrap:anywhere}
pre,code{font:12.5px/1.5 ui-monospace,"Cascadia Mono","Cascadia Code",Consolas,"SF Mono",Menlo,monospace}
figure{margin:14px 0 0}
figure img{display:block;max-width:100%;height:auto;border:1px solid var(--line);border-radius:4px}
figcaption{margin-top:6px;color:var(--muted);font-size:12px}
figcaption ol{margin:4px 0 0;padding-left:20px}
.missing{padding:14px;border:1px dashed var(--line);border-radius:4px;color:var(--muted);font-size:12px}
footer{margin-top:40px;padding-top:12px;border-top:1px solid var(--line);color:var(--muted);font-size:11.5px}
@media print{
.doc{max-width:none;padding:0}
h2,h3{break-after:avoid}
figure,pre,.warning,.banner,.checklist li,.meta{break-inside:avoid}
figure img{width:auto;max-height:21cm}
}
"#;

fn text_block(class: &str, text: &str) -> String {
    format!("<div class=\"{class}\">{}</div>", escape(text.trim_end()))
}

fn tag(origin_tag: Option<&str>) -> String {
    origin_tag
        .map(|tag| format!("<span class=\"tag\">({})</span>", escape(tag)))
        .unwrap_or_default()
}

enum ListStyle {
    Bullets,
    Numbers,
    Checklist,
    Warnings,
}

fn list_section(out: &mut String, id: &str, title: &str, items: &[ListItem], style: ListStyle) {
    if items.is_empty() {
        return;
    }
    let _ = write!(out, "<section id=\"{id}\"><h2>{}</h2>", escape(title));
    let entries = items.iter().map(|item| {
        (
            text_block("text", &item.text),
            tag(document::origin_tag(item.origin)),
        )
    });
    match style {
        ListStyle::Bullets | ListStyle::Numbers => {
            let element = if matches!(style, ListStyle::Numbers) {
                "ol"
            } else {
                "ul"
            };
            let _ = write!(out, "<{element} class=\"items\">");
            for (text, tag) in entries {
                let _ = write!(out, "<li>{text}{tag}</li>");
            }
            let _ = write!(out, "</{element}>");
        }
        ListStyle::Checklist => {
            out.push_str("<ul class=\"checklist\">");
            for (text, tag) in entries {
                let _ = write!(
                    out,
                    "<li><span class=\"box\" aria-hidden=\"true\"></span><div>{text}{tag}</div></li>"
                );
            }
            out.push_str("</ul>");
        }
        ListStyle::Warnings => {
            for (text, tag) in entries {
                let _ = write!(
                    out,
                    "<div class=\"warning\" role=\"note\"><p class=\"label\">Warning</p>{text}{tag}</div>"
                );
            }
        }
    }
    out.push_str("</section>");
}

fn text_section(out: &mut String, id: &str, title: &str, text: &str) {
    if text.trim().is_empty() {
        return;
    }
    let _ = write!(
        out,
        "<section id=\"{id}\"><h2>{}</h2>{}</section>",
        escape(title),
        text_block("text", text)
    );
}

fn field(out: &mut String, label: &str, body: &str) {
    let _ = write!(
        out,
        "<div class=\"field\"><p class=\"label\">{}</p>{body}</div>",
        escape(label)
    );
}

fn figure(out: &mut String, step_number: usize, position: usize, slot: Option<&Figure>) {
    let Some(figure) = slot else {
        let _ = write!(
            out,
            "<figure><div class=\"missing\">Screenshot {position} of step {step_number} is unavailable: its file is missing from the workspace.</div></figure>"
        );
        return;
    };
    let _ = write!(
        out,
        "<figure><img src=\"data:{};base64,{}\" width=\"{}\" height=\"{}\" alt=\"Step {step_number}, screenshot {position}\">",
        figure.media_type,
        BASE64.encode(&figure.bytes),
        figure.width,
        figure.height
    );
    let mut caption = String::new();
    if figure.redacted {
        caption.push_str("<p>Areas of this screenshot were permanently redacted.</p>");
    }
    if !figure.highlights.is_empty() {
        caption.push_str(if figure.highlights_drawn {
            "<p>Highlighted in the screenshot:</p><ol>"
        } else {
            "<p>Highlighted areas (the boxes could not be drawn on this image):</p><ol>"
        });
        for label in &figure.highlights {
            let label = if label.trim().is_empty() {
                "Highlighted area"
            } else {
                label
            };
            let _ = write!(caption, "<li>{}</li>", escape(label));
        }
        caption.push_str("</ol>");
    }
    if !caption.is_empty() {
        let _ = write!(out, "<figcaption>{caption}</figcaption>");
    }
    out.push_str("</figure>");
}

/// Renders the complete HTML document.
pub fn render(
    document: &ExportDocument,
    figures: &[StepFigures],
    context: &RenderContext,
) -> String {
    let content = &document.content;
    let title = escape(&document.title);
    let mut out = String::with_capacity(64 * 1024);
    let _ = write!(
        out,
        "<!DOCTYPE html>\n<html lang=\"en\">\n<head>\n<meta charset=\"utf-8\">\n\
         <meta http-equiv=\"Content-Security-Policy\" content=\"{CSP}\">\n\
         <meta name=\"viewport\" content=\"width=device-width, initial-scale=1\">\n\
         <meta name=\"generator\" content=\"DevTrace {}\">\n<title>{title}</title>\n<style>{STYLES}</style>\n</head>\n<body>\n<main class=\"doc\">\n<header>",
        escape(&context.app_version)
    );
    let _ = write!(
        out,
        "<p class=\"eyebrow\">Playbook</p><h1>{title}</h1><p class=\"status\">{}</p>",
        escape(&document.version.status_line())
    );
    for banner in document.banners() {
        let _ = write!(
            out,
            "<div class=\"banner{}\" role=\"note\"><strong>{}.</strong>{}</div>",
            if banner.caution { " caution" } else { "" },
            escape(&banner.title),
            escape(&banner.text)
        );
    }
    if !document.summary.trim().is_empty() {
        out.push_str(&text_block("summary text", &document.summary));
    }
    let mut meta = Vec::new();
    if let document::Version::Revision { note, .. } = &document.version
        && !note.trim().is_empty()
    {
        meta.push(("Revision note", note.clone()));
    }
    meta.extend(document.fields.iter().cloned());
    if !meta.is_empty() {
        out.push_str("<dl class=\"meta\">");
        for (label, value) in meta {
            let _ = write!(
                out,
                "<div><dt>{}</dt><dd class=\"text\">{}</dd></div>",
                escape(label),
                escape(&value)
            );
        }
        out.push_str("</dl>");
    }
    out.push_str("</header>\n");

    text_section(&mut out, "purpose", "Purpose", &content.purpose);
    text_section(&mut out, "scope", "Scope", &content.scope);
    list_section(
        &mut out,
        "prerequisites",
        "Prerequisites",
        &content.prerequisites,
        ListStyle::Bullets,
    );
    list_section(
        &mut out,
        "permissions",
        "Required permissions",
        &content.permissions,
        ListStyle::Bullets,
    );
    list_section(
        &mut out,
        "warnings",
        "Warnings",
        &content.warnings,
        ListStyle::Warnings,
    );

    out.push_str("<section id=\"steps\"><h2>Steps</h2>");
    if content.steps.is_empty() {
        out.push_str("<p class=\"source\">This playbook has no steps.</p>");
    } else {
        out.push_str("<ol class=\"steps\">");
    }
    for (index, step) in content.steps.iter().enumerate() {
        let number = index + 1;
        let _ = write!(
            out,
            "<li class=\"step\" id=\"step-{number}\"><h3><span class=\"num\">{number}</span><span>{}</span></h3><p class=\"source\">{}</p>",
            escape(&step.title),
            escape(&document.provenance(step))
        );
        if !step.instruction.trim().is_empty() {
            out.push_str(&text_block("text", &step.instruction));
        }
        if !step.command.trim().is_empty() {
            field(
                &mut out,
                "Command or configuration",
                &format!(
                    "<pre><code>{}</code></pre>",
                    escape(step.command.trim_end())
                ),
            );
        }
        if !step.expected_result.trim().is_empty() {
            field(
                &mut out,
                "Expected result",
                &text_block("text", &step.expected_result),
            );
        }
        if !step.note.trim().is_empty() {
            field(&mut out, "Note", &text_block("text", &step.note));
        }
        if let Some(slots) = figures.get(index) {
            for (position, slot) in slots.iter().enumerate() {
                figure(&mut out, number, position + 1, slot.as_ref());
            }
        }
        out.push_str("</li>");
    }
    if !content.steps.is_empty() {
        out.push_str("</ol>");
    }
    out.push_str("</section>\n");

    list_section(
        &mut out,
        "verification",
        "Verification",
        &content.verification,
        ListStyle::Checklist,
    );
    list_section(
        &mut out,
        "troubleshooting",
        "Troubleshooting",
        &content.troubleshooting,
        ListStyle::Bullets,
    );
    list_section(
        &mut out,
        "rollback",
        "Rollback and recovery",
        &content.rollback,
        ListStyle::Numbers,
    );

    let _ = write!(
        out,
        "\n<footer>{}</footer>\n</main>\n</body>\n</html>\n",
        escape(&context.footer(&document.playbook_id))
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
    fn escapes_markup_in_text_and_attributes() {
        assert_eq!(
            escape(r#"<script>alert("x")</script> & 'y'"#),
            "&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt; &amp; &#39;y&#39;"
        );
    }

    #[test]
    fn documents_are_self_contained_and_never_contain_script() {
        let mut document = sample();
        document.title = "<script>alert(1)</script>".into();
        document.content.steps[1].command = "echo \"</code></pre><script>x</script>\"".into();
        let figure = Figure {
            file_name: "step-01-1.png".into(),
            media_type: "image/png",
            bytes: vec![1, 2, 3],
            width: 10,
            height: 20,
            highlights: vec!["<b>Save</b>".into()],
            highlights_drawn: true,
            redacted: false,
        };
        let figures = vec![vec![Some(figure)], Vec::new(), Vec::new()];
        let html = render(&document, &figures, &context());
        assert!(html.starts_with("<!DOCTYPE html>"));
        assert!(html.contains("Content-Security-Policy"));
        assert!(html.contains("default-src 'none'"));
        assert!(!html.to_lowercase().contains("<script"));
        assert!(html.contains("&lt;script&gt;alert(1)&lt;/script&gt;"));
        assert!(html.contains("src=\"data:image/png;base64,AQID\" width=\"10\" height=\"20\""));
        assert!(html.contains("<li>&lt;b&gt;Save&lt;/b&gt;</li>"));
        assert!(!html.contains("http://") && !html.contains("https://"));
    }

    #[test]
    fn renders_sections_steps_and_provenance_in_order() {
        let document = sample();
        let figures = vec![vec![None], Vec::new(), Vec::new()];
        let html = render(&document, &figures, &context());
        let order = [
            "<h1>Rotate the VPN certificate</h1>",
            "<div class=\"banner\" role=\"note\"><strong>Draft.</strong>",
            "<dt>Platform</dt><dd class=\"text\">FortiGate</dd>",
            "<section id=\"purpose\"><h2>Purpose</h2>",
            "<section id=\"prerequisites\">",
            "<section id=\"permissions\">",
            "<section id=\"warnings\"><h2>Warnings</h2><div class=\"warning\" role=\"note\"><p class=\"label\">Warning</p>",
            "<section id=\"steps\"><h2>Steps</h2><ol class=\"steps\">",
            "<span class=\"num\">1</span><span>Open the certificate list</span>",
            "From session \u{201c}Rotate VPN certificate\u{201d} (captured screenshot)",
            "<div class=\"text\">Open the console.\nSign in as admin.</div>",
            "Screenshot 1 of step 1 is unavailable",
            "<p class=\"label\">Command or configuration</p><pre><code>get vpn certificate local",
            "<p class=\"label\">Expected result</p>",
            "<span>Restart the tunnel</span></h3><p class=\"source\">Written in the playbook</p>",
            "<section id=\"verification\"><h2>Verification</h2><ul class=\"checklist\">",
            "<section id=\"troubleshooting\">",
            "<section id=\"rollback\"><h2>Rollback and recovery</h2><ol class=\"items\">",
            "<footer>Exported from DevTrace 0.1.0",
        ];
        let mut from = 0;
        for expected in order {
            let found = html[from..]
                .find(expected)
                .unwrap_or_else(|| panic!("missing or out of order: {expected}"));
            from += found + expected.len();
        }
    }
}
