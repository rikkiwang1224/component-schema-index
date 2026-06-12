#!/usr/bin/env bash
# Link agent-server component-data for local CSI development
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
AGENT_DATA="${1:-$ROOT/../agent-server/src/agent/tools/component-data}"
LINK="$ROOT/data-linked"

if [[ ! -d "$AGENT_DATA" ]]; then
  echo "agent-server component-data not found: $AGENT_DATA"
  exit 1
fi

ln -sfn "$AGENT_DATA" "$LINK"
echo "Linked: $LINK -> $AGENT_DATA"
echo ""
echo "Run with:"
echo "  export CSI_DATA_ROOT=$LINK"
echo "  pnpm verify:resolver"
