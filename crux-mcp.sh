#!/bin/sh
# crux-mcp.sh — VSCode MCP wrapper
# Runs the crux MCP server inside the container so Node 25 is available on hosts that don't have it.
#
# VSCode MCP settings.json entry:
#   {
#     "mcp": {
#       "servers": {
#         "crux": {
#           "command": "/path/to/crux/crux-mcp.sh",
#           "args": []
#         }
#       }
#     }
#   }

set -e

CRUX_DIR="$(cd "$(dirname "$0")" && pwd)"
WORKSPACE="${PWD}"

exec container run -i --rm \
  -v "${CRUX_DIR}:/crux:ro" \
  -v "node_modules_cache:/crux/node_modules" \
  -v "${WORKSPACE}:/workspace" \
  -v "${CRUX_DIR}/.crux-home:/root/.crux" \
  -w /workspace \
  crux \
  node /crux/index.ts
