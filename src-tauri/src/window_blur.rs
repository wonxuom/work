#[cfg(target_os = "macos")]
fn blur_frame(width: f64, height: f64, expanded: bool) -> objc2_foundation::NSRect {
    use objc2_foundation::{NSPoint, NSRect, NSSize};
    let inset = if expanded { 28.0 } else { 24.0 };
    NSRect::new(
        NSPoint::new(inset, inset),
        NSSize::new(width - inset * 2.0, height - inset * 2.0),
    )
}

/// Liquid Glass dims itself whenever its window stops looking active (another window or app takes
/// focus), and NSGlassEffectView has no public state to pin the way NSVisualEffectView does. The
/// glass follows the window's private active-appearance query, so answer "active" for the widget.
#[cfg(target_os = "macos")]
fn keep_active_appearance(window: &objc2_app_kit::NSWindow) {
    use objc2::{
        ffi, msg_send,
        runtime::{AnyClass, AnyObject, Bool, Imp, Sel},
        sel,
    };

    extern "C-unwind" fn always_active(_: &AnyObject, _: Sel) -> Bool {
        Bool::YES
    }

    let class: &AnyClass = unsafe { msg_send![window, class] };
    // Tao registers its own NSWindow subclass; never patch NSWindow for every window in the process.
    if class.name() != c"TaoWindow" {
        return;
    }
    let imp: Imp = unsafe {
        std::mem::transmute::<extern "C-unwind" fn(&AnyObject, Sel) -> Bool, Imp>(always_active)
    };
    for name in [
        sel!(_hasActiveAppearance),
        sel!(_hasActiveAppearanceIgnoringKeyFocus),
    ] {
        // Fails harmlessly once the method was added by an earlier call.
        unsafe {
            ffi::class_addMethod(
                class as *const AnyClass as *mut AnyClass,
                name,
                imp,
                c"B@:".as_ptr(),
            )
        };
    }
}

#[tauri::command]
pub fn set_window_blur(
    window: tauri::WebviewWindow,
    enabled: bool,
    expanded: bool,
) -> Result<bool, String> {
    #[cfg(target_os = "macos")]
    {
        return window
            .with_webview(move |webview| {
                use objc2::{msg_send, rc::Retained, runtime::AnyClass, runtime::AnyObject};
                use objc2_app_kit::{
                    NSAppearance, NSAppearanceCustomization, NSAppearanceNameAqua,
                    NSAutoresizingMaskOptions, NSGlassEffectView, NSView,
                    NSVisualEffectBlendingMode, NSVisualEffectMaterial, NSVisualEffectState,
                    NSVisualEffectView, NSWindow, NSWindowOrderingMode,
                };
                use objc2_foundation::MainThreadMarker;

                // Tauri runs this callback on the UI thread; the NSWindow handle lives for its duration.
                let mtm =
                    MainThreadMarker::new().expect("webview callback must run on the main thread");
                let native = unsafe { &*webview.ns_window().cast::<NSWindow>() };
                let Some(content) = native.contentView() else {
                    return;
                };
                // NSGlassEffectView exists from macOS 26; looking it up by type earlier would panic.
                let glass_available = AnyClass::get(c"NSGlassEffectView").is_some();
                for view in content.subviews() {
                    if view.downcast_ref::<NSVisualEffectView>().is_some()
                        || glass_available && view.downcast_ref::<NSGlassEffectView>().is_some()
                    {
                        view.removeFromSuperview();
                    }
                }
                if !enabled {
                    return;
                }
                let bounds = content.bounds();
                let frame = blur_frame(bounds.size.width, bounds.size.height, expanded);
                let resize = NSAutoresizingMaskOptions::ViewWidthSizable
                    | NSAutoresizingMaskOptions::ViewHeightSizable;
                let aqua = unsafe { NSAppearance::appearanceNamed(NSAppearanceNameAqua) };
                let surface: Retained<NSView> = if glass_available {
                    keep_active_appearance(native);
                    let glass = NSGlassEffectView::initWithFrame(mtm.alloc(), frame);
                    glass.setCornerRadius(28.0);
                    glass.setAutoresizingMask(resize);
                    glass.setAppearance(aqua.as_deref());
                    Retained::into_super(glass)
                } else {
                    let blur = NSVisualEffectView::initWithFrame(mtm.alloc(), frame);
                    blur.setMaterial(NSVisualEffectMaterial::Popover);
                    blur.setBlendingMode(NSVisualEffectBlendingMode::BehindWindow);
                    // A floating workspace must not turn opaque when another app receives focus.
                    blur.setState(NSVisualEffectState::Active);
                    blur.setEmphasized(false);
                    blur.setAutoresizingMask(resize);
                    blur.setWantsLayer(true);
                    blur.setAppearance(aqua.as_deref());
                    // Keep the native blur inside the same rounded surface, not the transparent shadow gutter.
                    unsafe {
                        let layer: Option<Retained<AnyObject>> = msg_send![&blur, layer];
                        if let Some(layer) = layer {
                            let _: () = msg_send![&layer, setCornerRadius: 28.0_f64];
                            let _: () = msg_send![&layer, setMasksToBounds: true];
                        }
                    }
                    Retained::into_super(blur)
                };
                content.addSubview_positioned_relativeTo(
                    &surface,
                    NSWindowOrderingMode::Below,
                    None,
                );
            })
            .map(|_| enabled)
            .map_err(|error| error.to_string());
    }

    #[cfg(not(target_os = "macos"))]
    {
        let _ = (window, enabled, expanded);
        Ok(false)
    }
}

#[cfg(all(test, target_os = "macos"))]
mod tests {
    use super::blur_frame;

    #[test]
    fn blur_preserves_the_shadow_gutter_in_both_modes() {
        let widget = blur_frame(404.0, 592.0, false);
        assert_eq!(
            (
                widget.origin.x,
                widget.origin.y,
                widget.size.width,
                widget.size.height
            ),
            (24.0, 24.0, 356.0, 544.0)
        );
        let tracker = blur_frame(1000.0, 740.0, true);
        assert_eq!(
            (
                tracker.origin.x,
                tracker.origin.y,
                tracker.size.width,
                tracker.size.height
            ),
            (28.0, 28.0, 944.0, 684.0)
        );
    }
}
