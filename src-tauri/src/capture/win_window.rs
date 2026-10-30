//! Single-window capture on Windows: `PrintWindow` into a 32-bit DIB, then a 1:1 crop to the
//! visible frame.
//!
//! `GetWindowRect` includes the invisible resize borders of modern windows; the visible frame is
//! `DWMWA_EXTENDED_FRAME_BOUNDS`. `xcap` scales the whole bitmap before cropping, which shifts the
//! content and leaves dark bands along two edges, so DevTrace crops without scaling instead.
//! `PW_RENDERFULLCONTENT` also renders DirectX/DirectComposition content and works while the
//! window is covered by other windows.

use std::ffi::c_void;
use std::ptr;

use image::RgbaImage;
use windows::Win32::Foundation::{HWND, LPARAM, RECT};
use windows::Win32::Graphics::Dwm::{DWMWA_EXTENDED_FRAME_BOUNDS, DwmGetWindowAttribute};
use windows::Win32::Graphics::Gdi::{
    BI_RGB, BITMAPINFO, BITMAPINFOHEADER, CreateCompatibleDC, CreateDIBSection, DIB_RGB_COLORS,
    DeleteDC, DeleteObject, GdiFlush, SelectObject,
};
use windows::Win32::Storage::Xps::{PRINT_WINDOW_FLAGS, PrintWindow};
use windows::Win32::UI::WindowsAndMessaging::{EnumWindows, GetWindowRect};
use windows::core::BOOL;

use super::Crop;

/// Renders DirectX and DirectComposition content as well (Windows 8.1 and later).
const PW_RENDERFULLCONTENT: PRINT_WINDOW_FLAGS = PRINT_WINDOW_FLAGS(2);

struct Search {
    id: u32,
    found: Option<HWND>,
}

unsafe extern "system" fn visit(hwnd: HWND, lparam: LPARAM) -> BOOL {
    // SAFETY: `lparam` is the `Search` passed to `EnumWindows` below, alive for the whole call.
    let search = unsafe { &mut *(lparam.0 as *mut Search) };
    // Same identity as `xcap::Window::id` (the window handle truncated to 32 bits).
    if hwnd.0 as usize as u32 == search.id {
        search.found = Some(hwnd);
        return BOOL(0);
    }
    BOOL(1)
}

/// Finds the top-level window with the given `xcap` id.
pub fn find(id: u32) -> Option<HWND> {
    let mut search = Search { id, found: None };
    // EnumWindows reports an error when the callback stops early; the result is in `search`.
    let _ = unsafe { EnumWindows(Some(visit), LPARAM(&mut search as *mut Search as isize)) };
    search.found
}

/// Where the visible frame lies inside the full window rectangle.
fn frame_crop(outer: RECT, frame: RECT) -> Crop {
    let width = (outer.right - outer.left).max(0) as u32;
    let height = (outer.bottom - outer.top).max(0) as u32;
    let left = (frame.left - outer.left).clamp(0, width as i32) as u32;
    let top = (frame.top - outer.top).clamp(0, height as i32) as u32;
    Crop {
        left,
        top,
        width: ((frame.right - frame.left).max(0) as u32).min(width - left),
        height: ((frame.bottom - frame.top).max(0) as u32).min(height - top),
    }
}

/// Captures a window's visible frame as an opaque RGBA image.
pub fn capture(hwnd: HWND) -> Result<RgbaImage, String> {
    let mut outer = RECT::default();
    unsafe { GetWindowRect(hwnd, &mut outer) }.map_err(|error| error.message())?;
    let mut frame = RECT::default();
    let framed = unsafe {
        DwmGetWindowAttribute(
            hwnd,
            DWMWA_EXTENDED_FRAME_BOUNDS,
            &mut frame as *mut RECT as *mut c_void,
            size_of::<RECT>() as u32,
        )
    };
    if framed.is_err() {
        frame = outer;
    }
    let (width, height) = (outer.right - outer.left, outer.bottom - outer.top);
    if width <= 0 || height <= 0 {
        return Err("the window has no visible area".into());
    }

    let info = BITMAPINFO {
        bmiHeader: BITMAPINFOHEADER {
            biSize: size_of::<BITMAPINFOHEADER>() as u32,
            biWidth: width,
            // Negative height: rows are stored top-down.
            biHeight: -height,
            biPlanes: 1,
            biBitCount: 32,
            biCompression: BI_RGB.0,
            ..Default::default()
        },
        ..Default::default()
    };

    unsafe {
        let dc = CreateCompatibleDC(None);
        if dc.is_invalid() {
            return Err("no drawing surface is available".into());
        }
        let mut bits: *mut c_void = ptr::null_mut();
        let bitmap = match CreateDIBSection(Some(dc), &info, DIB_RGB_COLORS, &mut bits, None, 0) {
            Ok(bitmap) => bitmap,
            Err(error) => {
                let _ = DeleteDC(dc);
                return Err(error.message());
            }
        };
        let previous = SelectObject(dc, bitmap.into());
        let printed = PrintWindow(hwnd, dc, PW_RENDERFULLCONTENT).as_bool()
            || PrintWindow(hwnd, dc, PRINT_WINDOW_FLAGS(0)).as_bool();
        let _ = GdiFlush();
        let result = if printed && !bits.is_null() {
            // SAFETY: the DIB section holds width * height 32-bit pixels and stays selected
            // (alive) until after the copy.
            let pixels =
                std::slice::from_raw_parts(bits as *const u8, width as usize * height as usize * 4);
            Ok(crop_bgra(pixels, width as u32, frame_crop(outer, frame)))
        } else {
            Err("the window did not draw itself".into())
        };
        SelectObject(dc, previous);
        let _ = DeleteObject(bitmap.into());
        let _ = DeleteDC(dc);
        result
    }
}

/// Copies `crop` out of a top-down BGRA buffer `width` pixels wide, as opaque RGBA.
pub fn crop_bgra(pixels: &[u8], width: u32, crop: Crop) -> RgbaImage {
    let mut image = RgbaImage::new(crop.width, crop.height);
    let stride = width as usize * 4;
    for (row, out) in image
        .as_mut()
        .chunks_exact_mut(crop.width as usize * 4)
        .enumerate()
    {
        let start = (crop.top as usize + row) * stride + crop.left as usize * 4;
        let source = &pixels[start..start + crop.width as usize * 4];
        let (targets, _) = out.as_chunks_mut::<4>();
        let (sources, _) = source.as_chunks::<4>();
        for (to, &[blue, green, red, _]) in targets.iter_mut().zip(sources) {
            *to = [red, green, blue, 255];
        }
    }
    image
}

#[cfg(test)]
mod tests {
    use super::*;

    fn rect(left: i32, top: i32, right: i32, bottom: i32) -> RECT {
        RECT {
            left,
            top,
            right,
            bottom,
        }
    }

    #[test]
    fn crops_the_invisible_resize_borders() {
        // A typical Windows 11 window: 7 px invisible borders left, right and bottom.
        let crop = frame_crop(rect(93, 60, 733, 547), rect(100, 60, 726, 540));
        assert_eq!(
            crop,
            Crop {
                left: 7,
                top: 0,
                width: 626,
                height: 480
            }
        );
        // Without DWM information the whole window is used.
        assert_eq!(
            frame_crop(rect(0, 0, 10, 5), rect(0, 0, 10, 5)),
            Crop {
                left: 0,
                top: 0,
                width: 10,
                height: 5
            }
        );
        // A frame that reaches outside the window is clamped.
        assert_eq!(
            frame_crop(rect(0, 0, 10, 10), rect(-5, 8, 30, 30)),
            Crop {
                left: 0,
                top: 8,
                width: 10,
                height: 2
            }
        );
    }

    #[test]
    fn copies_bgra_rows_as_opaque_rgba() {
        // 3x2 image, BGRA, alpha 0 as PrintWindow often leaves it.
        let pixels: Vec<u8> = (0..6u8)
            .flat_map(|index| [index, 10 + index, 20 + index, 0])
            .collect();
        let image = crop_bgra(
            &pixels,
            3,
            Crop {
                left: 1,
                top: 0,
                width: 2,
                height: 2,
            },
        );
        assert_eq!(image.dimensions(), (2, 2));
        assert_eq!(image.get_pixel(0, 0).0, [21, 11, 1, 255]);
        assert_eq!(image.get_pixel(1, 1).0, [25, 15, 5, 255]);
    }
}
