use std::sync::atomic::{AtomicU32, Ordering};

use base64::Engine;
use serde::{Deserialize, Serialize};

static IMAGE_ID: AtomicU32 = AtomicU32::new(1);
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct ImageDimensions {
    pub width: u32,
    pub height: u32,
}
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub enum ImageProtocol {
    Kitty,
    ITerm2,
    #[default]
    None,
}
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct TerminalCapabilities {
    pub protocol: ImageProtocol,
    pub true_color: bool,
}
#[must_use]
pub fn allocate_image_id() -> u32 {
    IMAGE_ID.fetch_add(1, Ordering::Relaxed)
}
#[must_use]
pub fn get_png_dimensions(data: &[u8]) -> Option<ImageDimensions> {
    if data.len() < 24 || &data[..8] != b"\x89PNG\r\n\x1a\n" {
        return None;
    }
    Some(ImageDimensions {
        width: u32::from_be_bytes(data[16..20].try_into().ok()?),
        height: u32::from_be_bytes(data[20..24].try_into().ok()?),
    })
}
#[must_use]
pub fn get_gif_dimensions(data: &[u8]) -> Option<ImageDimensions> {
    if data.len() < 10 || !matches!(&data[..6], b"GIF87a" | b"GIF89a") {
        return None;
    }
    Some(ImageDimensions {
        width: u16::from_le_bytes(data[6..8].try_into().ok()?) as u32,
        height: u16::from_le_bytes(data[8..10].try_into().ok()?) as u32,
    })
}
#[must_use]
pub fn get_jpeg_dimensions(data: &[u8]) -> Option<ImageDimensions> {
    if data.len() < 4 || data[..2] != [0xff, 0xd8] {
        return None;
    }
    let mut i = 2;
    while i + 9 < data.len() {
        if data[i] != 0xff {
            i += 1;
            continue;
        }
        let marker = data[i + 1];
        if matches!(marker,0xc0..=0xc3|0xc5..=0xc7|0xc9..=0xcb|0xcd..=0xcf) {
            return Some(ImageDimensions {
                height: u16::from_be_bytes(data[i + 5..i + 7].try_into().ok()?) as u32,
                width: u16::from_be_bytes(data[i + 7..i + 9].try_into().ok()?) as u32,
            });
        }
        if i + 4 > data.len() {
            break;
        }
        let length = u16::from_be_bytes(data[i + 2..i + 4].try_into().ok()?) as usize;
        if length < 2 {
            break;
        }
        i += length + 2;
    }
    None
}
#[must_use]
pub fn get_webp_dimensions(data: &[u8]) -> Option<ImageDimensions> {
    if data.len() < 30 || &data[..4] != b"RIFF" || &data[8..12] != b"WEBP" {
        return None;
    }
    match &data[12..16] {
        b"VP8X" => Some(ImageDimensions {
            width: 1 + u32::from_le_bytes([data[24], data[25], data[26], 0]),
            height: 1 + u32::from_le_bytes([data[27], data[28], data[29], 0]),
        }),
        _ => None,
    }
}
#[must_use]
pub fn get_image_dimensions(data: &[u8], mime: &str) -> Option<ImageDimensions> {
    match mime {
        "image/png" => get_png_dimensions(data),
        "image/jpeg" => get_jpeg_dimensions(data),
        "image/gif" => get_gif_dimensions(data),
        "image/webp" => get_webp_dimensions(data),
        _ => None,
    }
}
#[must_use]
pub fn calculate_image_rows(dimensions: ImageDimensions, width_cells: u32, cell_ratio: f32) -> u32 {
    if dimensions.width == 0 {
        return 0;
    }
    ((dimensions.height as f32 / dimensions.width as f32 * width_cells as f32 / cell_ratio.max(0.1)).ceil() as u32)
        .max(1)
}
#[must_use]
pub fn encode_kitty(data: &[u8], id: u32, columns: u32, rows: u32) -> String {
    let encoded = base64::engine::general_purpose::STANDARD.encode(data);
    let chunks = encoded.as_bytes().chunks(4096).collect::<Vec<_>>();
    chunks
        .iter()
        .enumerate()
        .map(|(index, chunk)| {
            format!(
                "\x1b_Ga=T,f=100,i={id},c={columns},r={rows},m={};{}\x1b\\",
                u8::from(index + 1 < chunks.len()),
                String::from_utf8_lossy(chunk)
            )
        })
        .collect()
}
#[must_use]
pub fn encode_iterm2(data: &[u8], filename: Option<&str>, width: u32, height: u32) -> String {
    let name = filename
        .map(|name| base64::engine::general_purpose::STANDARD.encode(name))
        .unwrap_or_default();
    format!(
        "\x1b]1337;File=name={name};inline=1;width={width};height={height}:{}\x07",
        base64::engine::general_purpose::STANDARD.encode(data)
    )
}
#[must_use]
pub fn image_fallback(mime: &str, dimensions: Option<ImageDimensions>) -> String {
    dimensions.map_or_else(
        || format!("[Image: {mime}]"),
        |d| format!("[Image: {mime}, {}x{}]", d.width, d.height),
    )
}
#[must_use]
pub fn delete_kitty_image(id: u32) -> String {
    format!("\x1b_Ga=d,d=i,i={id}\x1b\\")
}
#[must_use]
pub fn delete_all_kitty_images() -> &'static str {
    "\x1b_Ga=d,d=A\x1b\\"
}
