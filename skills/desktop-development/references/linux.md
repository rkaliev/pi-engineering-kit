# Linux reference

## Paths and conventions

- Follow the XDG Base Directory spec:
  - config: `$XDG_CONFIG_HOME` (default `~/.config/<app>`);
  - data: `$XDG_DATA_HOME` (`~/.local/share/<app>`);
  - cache: `$XDG_CACHE_HOME` (`~/.cache/<app>`);
  - runtime files: `$XDG_RUNTIME_DIR`.
- System services use `/etc/<app>` for config, `/var/lib/<app>` for state and `/var/log` for logs, or journald.
- Desktop integration: a `.desktop` file, icons in the hicolor theme, and a MIME types registration where needed.
- Don't assume bash, GNU coreutils flags or a particular distribution in scripts. Use `#!/usr/bin/env bash` and `set -euo pipefail` when bash is required.

## Services

- Write a systemd unit:
  ```ini
  [Service]
  ExecStart=/usr/bin/<app>
  User=<app>
  Restart=on-failure
  NoNewPrivileges=yes
  ProtectSystem=strict
  ProtectHome=yes
  StateDirectory=<app>
  ```
- Log to stdout/stderr; journald collects it. Read with `journalctl -u <app> -f`.
- Use socket or timer units instead of hand-rolled daemons and cron where they fit.

## Packaging

| Format | Use when |
|---|---|
| deb / rpm | Managed fleets and servers. Declare dependencies properly; build in a clean container per target distribution |
| Flatpak | Desktop apps for many distributions, sandboxed. Declare permissions minimally |
| Snap | Ubuntu-focused distribution with auto-updates |
| AppImage | A single portable file with no install. Updates are the app's job |
| Container image | Services. Minimal base, non-root user, pinned digest |

- Build release artifacts in CI in pinned container images, per architecture (x86_64/aarch64).
- Sign packages and repository metadata (GPG for apt/yum repos).

## Testing

- Unit and integration tests in CI containers.
- Install the package in clean containers or VMs of each supported distribution (for example the current Ubuntu LTS, Debian stable, Fedora). Test install, upgrade and removal.
- GUI checks: run under Xvfb or a Wayland headless compositor in CI, with screenshots as evidence.
- Devices (serial ports, USB HID): add the user to the correct group (`dialout`, udev rules) instead of running as root. Document the udev rule in the package.
