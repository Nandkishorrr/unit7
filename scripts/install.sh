#!/bin/sh
# Unit7, in one command: curl -fsSL https://raw.githubusercontent.com/Nandkishorrr/unit7/main/scripts/install.sh | sh
# It needs Node 24 and git. It puts Unit7 in ~/.unit7-app and links `unit7`, and says each step as it goes.
set -eu
REPO=https://github.com/Nandkishorrr/unit7.git DIR="${UNIT7_DIR:-$HOME/.unit7-app}" BRANCH="${UNIT7_BRANCH:-main}"
need() { command -v "$1" >/dev/null 2>&1 || { echo "Unit7 needs $1. $2" >&2; exit 1; }; }
need git "Install it first."
need node "Install Node 24: https://nodejs.org"
major=$(node -p 'process.versions.node.split(".")[0]')
[ "$major" -ge 24 ] || { echo "Unit7 needs Node 24 or newer, and this is $(node -v)." >&2; exit 1; }
if [ -d "$DIR/.git" ]; then echo "Updating $DIR"; git -C "$DIR" pull --ff-only; else echo "Downloading to $DIR"; git clone --depth 1 --branch "$BRANCH" "$REPO" "$DIR"; fi
cd "$DIR"
echo "Installing what it needs"
npm ci --no-audit --no-fund
npx vite build >/dev/null || echo "Couldn't build the web app. The CLI still works."
npm prune --omit=dev --no-audit --no-fund >/dev/null
bindir="$HOME/.local/bin"; mkdir -p "$bindir"; ln -sf "$DIR/bin/unit7.mjs" "$bindir/unit7"
case ":$PATH:" in *":$bindir:"*) ;; *) echo "Add $bindir to your PATH." ;; esac
echo "Done. Start it with: unit7 serve"
