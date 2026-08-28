#!/usr/bin/env sh
# Generates the bcrypt hash Caddy needs for DEBUG_PASSWORD_HASH.
# Usage: ./scripts/hash-debug-password.sh
set -eu
docker run --rm -it caddy:2-alpine caddy hash-password
