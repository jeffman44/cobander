#!/usr/bin/env bash
# Two-window end-to-end smoke under xvfb (Electron + fake mic). ~2-4 min. Output + screenshots in .e2e/
set -euo pipefail
cd "$(dirname "$0")/.."
exec xvfb-run -a -s "-screen 0 1440x900x24" node test/e2e.js
