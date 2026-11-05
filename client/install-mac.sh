#!/bin/sh
# Installs the `ask` client on the laptop: ~/.local/bin/ask + ~/.llm-harness/client.json.
# The API key stays in the macOS Keychain (service "llm-harness"); client.json only holds the command that reads it.
# Usage: sh install-mac.sh http://<desktop-tailscale-ip>:8080 [path/to/ask.mjs]
#        (ask.mjs defaults to the copy next to this script, then ~/Downloads/ask.mjs)
set -e
url=${1:-}
case "$url" in
  http://*|https://*) ;;
  *) echo "usage: sh install-mac.sh http://<desktop-tailscale-ip>:8080 [path/to/ask.mjs]"; exit 2;;
esac
here=$(cd "$(dirname "$0")" && pwd)
src=${2:-}
[ -z "$src" ] && for c in "$here/ask.mjs" "$HOME/Downloads/ask.mjs"; do [ -f "$c" ] && src=$c && break; done
[ -f "$src" ] || { echo "ask.mjs not found; pass its path as the second argument"; exit 1; }

if ! command -v node >/dev/null 2>&1; then
  echo "Node.js 18+ is required: install it from https://nodejs.org (LTS .pkg) or with 'brew install node', then re-run."
  exit 1
fi

mkdir -p "$HOME/.local/bin" "$HOME/.llm-harness"
cp "$src" "$HOME/.local/bin/ask"
chmod +x "$HOME/.local/bin/ask"

cfg="$HOME/.llm-harness/client.json"
if [ ! -f "$cfg" ]; then
  cat > "$cfg" <<EOF
{
  "url": "${url%/}",
  "model": "qwen3.8-27b",
  "keyCommand": "security find-generic-password -a \\"\$USER\\" -s llm-harness -w"
}
EOF
  echo "config written: $cfg"
else
  echo "config kept: $cfg"
fi

case ":$PATH:" in
  *":$HOME/.local/bin:"*) ;;
  *) echo 'export PATH="$HOME/.local/bin:$PATH"' >> "$HOME/.zshrc"; echo "added ~/.local/bin to PATH in ~/.zshrc (open a new terminal)";;
esac

security find-generic-password -a "$USER" -s llm-harness -w >/dev/null 2>&1 \
  || echo "warning: no Keychain item 'llm-harness'; add it: security add-generic-password -a \"\$USER\" -s llm-harness -w"
echo "installed: $HOME/.local/bin/ask"
