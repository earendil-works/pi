#![allow(missing_docs)]
//! Differential terminal UI, components, input decoding, autocomplete, and inline images.

mod autocomplete;
mod components;
mod extras;
mod image;
mod keys;
mod tui;
mod utils;

pub use autocomplete::*;
pub use components::BoxComponent as Box;
pub use components::*;
pub use extras::*;
pub use image::*;
pub use keys::*;
pub use tui::*;
pub use utils::*;

#[must_use]
pub fn shared<C: Component + 'static>(component: C) -> SharedComponent {
    std::sync::Arc::new(parking_lot::Mutex::new(component))
}
