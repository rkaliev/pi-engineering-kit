# Windows reference

## .NET projects

- The SDK version comes from `global.json` when present. Check it with `dotnet --list-sdks`. Target an LTS runtime unless the project says otherwise.
- Common commands:
  - `dotnet restore` — with a committed lockfile when `RestorePackagesWithLockFile` is set.
  - `dotnet build -c Release`
  - `dotnet test`
  - `dotnet format --verify-no-changes`
- Treat warnings as errors if the project does (`TreatWarningsAsErrors`), and turn on nullable reference types in new projects.
- **UI:** WPF, or WinUI 3 (Windows App SDK) for new Windows-only UI. Use MVVM (CommunityToolkit.Mvvm is a common choice), keep the code-behind thin, and use async commands. For older WinForms code, stay in WinForms.
- **Paths:** `Environment.GetFolderPath(SpecialFolder.LocalApplicationData)` for per-user data, `ProgramData` for machine-wide data. Never write to `Program Files`.
- **Logging:** structured logging (Serilog or Microsoft.Extensions.Logging) to a rolling file in the app data folder.

## Services and background work

- Use a Worker Service with `UseWindowsService()`. Install it with `sc.exe create` or through the installer. Give it a dedicated low-privilege account. Configure recovery (restart on failure).
- Scheduled tasks rather than always-on services for periodic work.

## Packaging

- **MSIX:** clean install and uninstall, auto-update through App Installer, and it requires signing.
- **Classic installers:** WiX Toolset or Inno Setup. Support silent install (`/quiet`, `/VERYSILENT`) for fleet deployment and POS rollouts.
- **Self-contained vs framework-dependent:** self-contained avoids runtime prerequisites on locked-down machines but produces a larger package.
- Test installs on a clean Windows VM (Windows Sandbox is convenient), both as a standard user and as an admin.

## Code signing

- Sign executables, DLLs, installers and MSIX with Authenticode through a cloud signing service or an HSM-backed certificate (for example Azure Trusted Signing), from CI. Timestamp every signature.
- Unsigned or newly signed binaries trigger SmartScreen warnings; plan for reputation building.
- The agent never exports or handles signing certificates or keys.

## Peripherals (POS)

- Serial/COM devices: `System.IO.Ports`. Handle port-busy errors and device replug, and never hard-code a COM number (make it configurable or auto-detect it).
- USB/HID scanners usually act as keyboards. OPOS/UPOS or vendor SDKs cover printers, drawers and scales.
- Fiscal devices: use the vendor's Windows driver or COM/SDK behind an interface (see pos-systems).
