# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/). Version numbers
follow `MAJOR.MINOR.PATCH`; the current number is in `VERSION`.

## [Unreleased] - 0.1.0

First version prepared for publication. Not yet tagged or released.

### Added

- Application
  - 17 chassis, including walkers, tracked, three-wheeler, U-frame, H-frame, delta, pancake and a
    melty puck.
  - 36 hardpoint modules in kinetic, control, thermal, electrical, projectile and passive
    categories, on five hardpoints.
  - Interference checking between installed modules.
  - Full-body shell spinner and ring spinner mechanics.
  - Weight classes from 1 lb to 250 lb; adjustable chassis dimensions; per-face armour.
  - Drive options: wheel count, tyre compound, floor magnets, wheel guards, two-speed gearbox,
    suspension, hub motors, omni and mecanum wheels.
  - Optional components, N2 or CO2 pneumatics, ballast, cost estimate.
  - Liveries, custom paint, finish levels and team text.
  - Studio and Factory Floor modes.
  - Labels, x-ray, electrical and thermal views; piece-level teardown; test stand.
  - Garage, parts list with CSV download, tale of the tape, snapshot.
  - Arena mode (`static/bb_arena.js`, `tools/check_arena.js`).
  - URL query parameters for automation.
  - CPU renderer used when WebGL is unavailable.
- Project
  - `README.md`, `CONTRIBUTING.md`, `THIRD_PARTY_NOTICES.md`, `CHANGELOG.md`, `VERSION`.
  - `requirements.txt`.
  - `.gitignore`.
  - `tools/test.sh`, a single command that runs all the Node checks.
  - GitHub Actions workflow `.github/workflows/ci.yml`.
  - `docs/` directory for the README screenshot (image not yet added).

### Changed

- `run.sh` creates or reuses a local `.venv`, installs `requirements.txt` and starts the server. It
  no longer depends on another project's virtualenv path, and it no longer kills whatever process
  is using the port.
- `server.py` reads `HOST` and `PORT` environment variables as the defaults for `--host` and
  `--port` (still `0.0.0.0` and `8105` when unset), and `/api/health` reports the port in use.

### Not yet included

- `static/bb_arena.css`, which `templates/index.html` already links.
- A licence. The licence is to be decided by the owner.
