---
name: desktop-development
description: Use when building, packaging, signing or updating desktop applications for Windows or Linux, including .NET, WPF, WinUI, Electron, Tauri, Qt, GTK, installers, services or daemons
---

# Desktop development

Desktop apps live on machines you don't manage: different OS versions, locales, permissions, antivirus, proxies, no admin rights. They are updated in place, so a bad release sits on disk until the next update succeeds.

Platform details:
- `references/windows.md`: .NET, MSIX/installers, signing, services.
- `references/linux.md`: packaging, XDG, systemd, distributions.

## Always

- **Follow the existing stack and structure**, for example MVVM in WPF/WinUI, the main/renderer split in Electron, the Rust core plus web UI in Tauri. New windows copy an existing window's pattern.
- **Keep the UI thread free.** Do I/O, device access and heavy computation off the UI thread; marshal results back. Every long operation gets progress and cancellation.
- **Paths and files:**
  - use platform APIs for app data, config, cache and logs, never hard-coded paths or the install directory (it's often read-only);
  - handle long paths, spaces, non-ASCII user names and network drives;
  - write atomically (write a temp file, then rename).
- **Processes and IPC:** pass argument arrays, not shell strings. Validate messages between processes (the Electron preload bridge exposes a minimal API, with `contextIsolation` on and `nodeIntegration` off). Enforce a single instance where needed.
- **Security:**
  - never ship secrets in the app;
  - store credentials in the OS store (Windows Credential Manager/DPAPI, libsecret/KWallet);
  - validate update payloads with signatures;
  - request least privilege and elevate only for the specific step that needs it.
- **Hardware and peripherals** (POS printers, scanners, card readers, fiscal devices): isolate each behind an interface with a fake. Handle unplug and replug, and busy ports. See pos-systems.
- **Localization and accessibility:**
  - user-visible strings in resources;
  - culture-aware number, date and currency formatting (but invariant culture for data files and protocols);
  - keyboard navigation;
  - screen reader names;
  - high-contrast and DPI scaling;
  - the system's "reduce animations" setting, and hover effects only with a precise pointer (ui-motion for animation; the web-frontend references for design tokens, state and copy).

## Verification

1. Unit tests for view models and logic; integration tests for file and database adapters against a real local instance, and for device adapters against a fake (`../test-driven-development/references/test-standard.md`).
2. A build of the release configuration, and the package itself (installer, MSIX, AppImage, deb…).
3. Install the package into a clean VM or container. Run first-launch, upgrade from the previous version, and uninstall.
4. Manual smoke test of the changed flows, with screenshots. State which OS versions and architectures (x64/arm64) were actually tested.

## Updates and release

- Auto-update through a signed channel: MSIX/App Installer, Squirrel/electron-updater, Tauri updater, or distribution repositories. Keep a rollback path and never break the updater itself.
- Code signing keys stay in CI or an HSM/cloud signing service. The agent never handles them.
- Publishing a release or update is outward-facing: it needs the user's go-ahead.
