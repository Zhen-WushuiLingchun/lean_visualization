#!/usr/bin/env bash
# ProofFlow one-click launcher (Linux, macOS, Git Bash).
#   ./proofflow.sh                    -> serves the bundled example (examples/toy)
#   ./proofflow.sh /path/to/project   -> serves that Lean project
#   ./proofflow.sh /path --port 4871  -> extra flags are passed to `proofflow serve`
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
export PATH="$HOME/.elan/bin:$PATH"

need() { command -v "$1" >/dev/null 2>&1 || { echo "[ProofFlow] $2"; exit 1; }; }
need node "Node.js 22 or newer is required: https://nodejs.org"
need pnpm "pnpm is required: npm install -g pnpm (or: corepack enable)"
need lake "Lean's lake was not found; install elan: https://github.com/leanprover/elan"

if [ ! -d "$ROOT/node_modules" ]; then
  echo "[ProofFlow] Installing dependencies (first run)..."
  (cd "$ROOT" && pnpm install)
fi
if [ ! -f "$ROOT/packages/server/dist/cli.js" ] || [ ! -f "$ROOT/packages/web/dist/index.html" ]; then
  echo "[ProofFlow] Building packages (first run)..."
  (cd "$ROOT" && pnpm build)
fi

PROJECT="${1:-$ROOT/examples/toy}"
if [ $# -gt 0 ]; then shift; fi
echo "[ProofFlow] Project: $PROJECT"
echo "[ProofFlow] Starting server on http://127.0.0.1:4870 (Ctrl+C to stop)..."
exec node "$ROOT/packages/server/dist/cli.js" serve --project "$PROJECT" --open "$@"
