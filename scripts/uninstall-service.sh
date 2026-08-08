#!/usr/bin/env bash
#
# Removes the systemd service. The app, its database and node_modules are left alone.
#
#   sudo bash scripts/uninstall-service.sh

set -euo pipefail

SERVICE_NAME=attendance
UNIT_PATH="/etc/systemd/system/$SERVICE_NAME.service"

[[ $EUID -eq 0 ]] || { echo "must run as root — try: sudo bash scripts/uninstall-service.sh" >&2; exit 1; }

systemctl disable --now "$SERVICE_NAME" 2>/dev/null || true
rm -f "$UNIT_PATH"
systemctl daemon-reload
systemctl reset-failed "$SERVICE_NAME" 2>/dev/null || true

echo "service removed. Database and application files were not touched."
