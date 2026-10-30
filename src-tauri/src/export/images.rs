//! Screenshots for exports. Evidence copies are read from the playbook's folder; when the author
//! highlighted areas, the boxes are drawn on a copy with numbers that match the captions. The
//! stored evidence is never modified.

use std::io::Cursor;
use std::path::Path;

use image::codecs::png::{CompressionType, FilterType, PngEncoder};
use image::{ExtendedColorType, ImageEncoder, Rgba, RgbaImage};

use crate::error::{AppError, AppResult};
use crate::export::document::ExportDocument;
use crate::features::attachments::Annotation;
use crate::features::review;
use crate::storage::{self, ImageFormat};

/// A screenshot ready to be written next to a Markdown file or embedded in HTML.
#[derive(Debug, Clone)]
pub struct Figure {
    /// For example `step-03-1.png`.
    pub file_name: String,
    pub media_type: &'static str,
    pub bytes: Vec<u8>,
    pub width: u32,
    pub height: u32,
    /// Captions of the numbered highlight boxes, in order (empty when unlabeled).
    pub highlights: Vec<String>,
    /// False when highlights exist but could not be drawn (the image could not be decoded).
    pub highlights_drawn: bool,
    pub redacted: bool,
}

/// One entry per screenshot reference of a step; `None` when the file is missing or unreadable.
pub type StepFigures = Vec<Option<Figure>>;

/// Prepares the screenshots of every step, in step order.
pub fn prepare(document: &ExportDocument, assets_dir: &Path) -> Vec<StepFigures> {
    let width = document.content.steps.len().to_string().len().max(2);
    document
        .content
        .steps
        .iter()
        .enumerate()
        .map(|(index, step)| {
            step.asset_ids
                .iter()
                .enumerate()
                .map(|(position, asset_id)| {
                    let asset = document.assets.get(asset_id)?;
                    let stem = format!("step-{:0width$}-{}", index + 1, position + 1);
                    match figure(assets_dir, &asset.relative_path, &asset.annotations, &stem) {
                        Ok(mut figure) => {
                            figure.redacted = asset.redacted;
                            Some(figure)
                        }
                        Err(error) => {
                            eprintln!("DevTrace: export skipped an image: {error}");
                            None
                        }
                    }
                })
                .collect()
        })
        .collect()
}

/// Number of screenshot references that could not be included.
pub fn missing(figures: &[StepFigures]) -> usize {
    figures
        .iter()
        .flatten()
        .filter(|slot| slot.is_none())
        .count()
}

/// Number of screenshots included.
pub fn included(figures: &[StepFigures]) -> usize {
    figures
        .iter()
        .flatten()
        .filter(|slot| slot.is_some())
        .count()
}

fn figure(
    assets_dir: &Path,
    relative_path: &str,
    annotations: &[Annotation],
    stem: &str,
) -> AppResult<Figure> {
    let path = storage::resolve_contained(assets_dir, relative_path)?;
    let bytes = std::fs::read(&path)?;
    let inspected = storage::inspect_image(&bytes)?;
    let highlights: Vec<String> = annotations
        .iter()
        .map(|annotation| annotation.label.clone())
        .collect();
    if !annotations.is_empty()
        && let Ok(mut image) = review::decode_image(&bytes)
    {
        draw_highlights(&mut image, annotations);
        let (width, height) = image.dimensions();
        return Ok(Figure {
            file_name: format!("{stem}.png"),
            media_type: ImageFormat::Png.media_type(),
            bytes: encode_png(&image)?,
            width,
            height,
            highlights,
            highlights_drawn: true,
            redacted: false,
        });
    }
    Ok(Figure {
        file_name: format!("{stem}.{}", inspected.format.extension()),
        media_type: inspected.format.media_type(),
        bytes,
        width: inspected.width,
        height: inspected.height,
        highlights_drawn: highlights.is_empty(),
        highlights,
        redacted: false,
    })
}

fn encode_png(image: &RgbaImage) -> AppResult<Vec<u8>> {
    let mut bytes = Cursor::new(Vec::new());
    PngEncoder::new_with_quality(&mut bytes, CompressionType::Fast, FilterType::Adaptive)
        .write_image(
            image.as_raw(),
            image.width(),
            image.height(),
            ExtendedColorType::Rgba8,
        )
        .map_err(|error| {
            AppError::internal(format!("Could not encode an export image: {error}"))
        })?;
    Ok(bytes.into_inner())
}

/// The light theme accent (`--color-accent`, #007AFF) used for highlights in the app.
const ACCENT: Rgba<u8> = Rgba([0, 122, 255, 255]);
const WHITE: Rgba<u8> = Rgba([255, 255, 255, 255]);

/// 3×5 bitmap digits; each row uses the low three bits, left column first.
const DIGITS: [[u8; 5]; 10] = [
    [0b111, 0b101, 0b101, 0b101, 0b111],
    [0b010, 0b110, 0b010, 0b010, 0b111],
    [0b111, 0b001, 0b111, 0b100, 0b111],
    [0b111, 0b001, 0b111, 0b001, 0b111],
    [0b101, 0b101, 0b111, 0b001, 0b001],
    [0b111, 0b100, 0b111, 0b001, 0b111],
    [0b111, 0b100, 0b111, 0b101, 0b111],
    [0b111, 0b001, 0b001, 0b001, 0b001],
    [0b111, 0b101, 0b111, 0b101, 0b111],
    [0b111, 0b101, 0b111, 0b001, 0b111],
];

/// Fills the half-open rectangle `[left, right) × [top, bottom)`, clipped to the image.
fn fill(image: &mut RgbaImage, left: i64, top: i64, right: i64, bottom: i64, color: Rgba<u8>) {
    let (width, height) = image.dimensions();
    let clamp_x = |value: i64| value.clamp(0, i64::from(width)) as u32;
    let clamp_y = |value: i64| value.clamp(0, i64::from(height)) as u32;
    for y in clamp_y(top)..clamp_y(bottom) {
        for x in clamp_x(left)..clamp_x(right) {
            image.put_pixel(x, y, color);
        }
    }
}

/// A frame of `thickness` pixels just inside the rectangle.
fn frame(
    image: &mut RgbaImage,
    (left, top, right, bottom): (i64, i64, i64, i64),
    thickness: i64,
    color: Rgba<u8>,
) {
    fill(image, left, top, right, top + thickness, color);
    fill(image, left, bottom - thickness, right, bottom, color);
    fill(
        image,
        left,
        top + thickness,
        left + thickness,
        bottom - thickness,
        color,
    );
    fill(
        image,
        right - thickness,
        top + thickness,
        right,
        bottom - thickness,
        color,
    );
}

/// Draws each highlight as an accent outline around the area (with a thin white edge so it
/// stays visible on dark screens) and a numbered badge at its top-left corner.
pub fn draw_highlights(image: &mut RgbaImage, annotations: &[Annotation]) {
    let (width, height) = image.dimensions();
    let shortest = i64::from(width.min(height));
    let stroke = (shortest / 360).clamp(2, 6);
    let scale = (shortest / 240).clamp(2, 8);
    for (index, annotation) in annotations.iter().enumerate() {
        let left = i64::from(annotation.x);
        let top = i64::from(annotation.y);
        let right = left + i64::from(annotation.width);
        let bottom = top + i64::from(annotation.height);
        frame(
            image,
            (
                left - stroke - 1,
                top - stroke - 1,
                right + stroke + 1,
                bottom + stroke + 1,
            ),
            1,
            WHITE,
        );
        frame(
            image,
            (left - stroke, top - stroke, right + stroke, bottom + stroke),
            stroke,
            ACCENT,
        );
        draw_badge(image, index + 1, (left - stroke, top - stroke), scale);
    }
}

fn draw_badge(image: &mut RgbaImage, number: usize, (anchor_x, anchor_y): (i64, i64), scale: i64) {
    let digits: Vec<usize> = number
        .to_string()
        .bytes()
        .map(|digit| usize::from(digit - b'0'))
        .collect();
    let count = digits.len() as i64;
    let padding = scale * 3 / 2;
    let badge_width = count * 3 * scale + (count - 1) * scale + 2 * padding;
    let badge_height = 5 * scale + 2 * padding;
    let max_x = (i64::from(image.width()) - badge_width).max(0);
    let max_y = (i64::from(image.height()) - badge_height).max(0);
    // Above the outline when there is room, otherwise just inside it.
    let preferred_y = if anchor_y - badge_height >= 0 {
        anchor_y - badge_height
    } else {
        anchor_y
    };
    let x = anchor_x.clamp(0, max_x);
    let y = preferred_y.clamp(0, max_y);
    frame(
        image,
        (x - 1, y - 1, x + badge_width + 1, y + badge_height + 1),
        1,
        WHITE,
    );
    fill(image, x, y, x + badge_width, y + badge_height, ACCENT);
    for (position, digit) in digits.iter().enumerate() {
        let origin_x = x + padding + position as i64 * 4 * scale;
        let origin_y = y + padding;
        for (row, bits) in DIGITS[*digit].iter().enumerate() {
            for column in 0..3_i64 {
                if bits & (0b100 >> column) != 0 {
                    let pixel_x = origin_x + column * scale;
                    let pixel_y = origin_y + row as i64 * scale;
                    fill(
                        image,
                        pixel_x,
                        pixel_y,
                        pixel_x + scale,
                        pixel_y + scale,
                        WHITE,
                    );
                }
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::export::document::{self, AssetRef};

    fn annotation(x: u32, y: u32, width: u32, height: u32) -> Annotation {
        Annotation {
            id: "a".into(),
            x,
            y,
            width,
            height,
            label: "Save button".into(),
        }
    }

    #[test]
    fn highlights_are_outlined_and_numbered_without_touching_the_area() {
        let mut image = RgbaImage::from_pixel(400, 300, Rgba([200, 200, 200, 255]));
        draw_highlights(&mut image, &[annotation(100, 100, 80, 40)]);
        // stroke = 2 for a 300 px image: the outline sits just outside the area.
        assert_eq!(*image.get_pixel(99, 120), ACCENT);
        assert_eq!(*image.get_pixel(97, 120), WHITE);
        // The highlighted area itself stays visible.
        assert_eq!(*image.get_pixel(140, 120), Rgba([200, 200, 200, 255]));
        // The badge sits above the outline and contains white digit pixels.
        let badge: Vec<_> = (60..98)
            .flat_map(|y| (98..130).map(move |x| (x, y)))
            .map(|(x, y)| *image.get_pixel(x, y))
            .collect();
        assert!(badge.contains(&ACCENT) && badge.contains(&WHITE));
    }

    #[test]
    fn badges_stay_inside_the_image_at_the_edges() {
        let mut image = RgbaImage::from_pixel(64, 32, Rgba([0, 0, 0, 255]));
        draw_highlights(
            &mut image,
            &[annotation(0, 0, 10, 10), annotation(54, 22, 10, 10)],
        );
        assert_eq!(image.dimensions(), (64, 32));
    }

    #[test]
    fn prepares_figures_and_reports_missing_files() {
        let temp = tempfile::tempdir().unwrap();
        let assets = temp.path();
        let png = crate::capture::screen::encode_png(&image::RgbImage::from_pixel(
            40,
            20,
            image::Rgb([250, 250, 250]),
        ))
        .unwrap();
        std::fs::create_dir_all(assets.join("p1")).unwrap();
        std::fs::write(assets.join("p1/img1.png"), &png).unwrap();

        let mut document = document::tests::sample();
        document.content.steps[2].asset_ids = vec!["img1".into(), "gone".into()];
        document.assets.insert(
            "gone".into(),
            AssetRef {
                relative_path: "p1/gone.png".into(),
                annotations: Vec::new(),
                redacted: false,
            },
        );
        document.assets.get_mut("img1").unwrap().annotations = vec![annotation(5, 5, 10, 8)];

        let figures = prepare(&document, assets);
        assert_eq!(figures.len(), 3);
        let first = figures[0][0].as_ref().unwrap();
        assert_eq!(first.file_name, "step-01-1.png");
        assert_eq!((first.width, first.height), (40, 20));
        assert_eq!(first.highlights, ["Save button"]);
        assert!(first.highlights_drawn);
        assert_ne!(first.bytes, png, "highlights are drawn on a copy");
        assert_eq!(
            std::fs::read(assets.join("p1/img1.png")).unwrap(),
            png,
            "evidence is unchanged"
        );
        assert_eq!(figures[2][0].as_ref().unwrap().file_name, "step-03-1.png");
        assert!(figures[2][1].is_none());
        assert_eq!((included(&figures), missing(&figures)), (2, 1));
    }
}
