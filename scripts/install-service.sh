#!/usr/bin/env bash
#
# Installs ESSL Attendance as a systemd service that starts on boot.
#
#   sudo bash scripts/install-service.sh
#
# Idempotent: safe to re-run after a code update or an nvm node upgrade.

set -euo pipefail

SERVICE_NAME=attendance
APP_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TEMPLATE="$APP_DIR/scripts/attendance.service"
UNIT_PATH="/etc/systemd/system/$SERVICE_NAME.service"

# The account the service runs as: whoever owns the app directory, not root.
RUN_USER="$(stat -c '%U' "$APP_DIR")"
RUN_GROUP="$(stat -c '%G' "$APP_DIR")"

die() { echo "error: $*" >&2; exit 1; }

[[ $EUID -eq 0 ]] || die "must run as root — try: sudo bash scripts/install-service.sh"
[[ -f "$TEMPLATE" ]] || die "missing unit template at $TEMPLATE"
[[ -f "$APP_DIR/src/index.js" ]] || die "$APP_DIR does not look like the app directory"
[[ -f "$APP_DIR/.env.production" ]] || die "missing $APP_DIR/.env.production"
[[ -d "$APP_DIR/node_modules" ]] || die "dependencies not installed — run 'npm install' as $RUN_USER first"

# Resolve node. Under nvm it is on nobody's PATH but the owning user's, and a
# login shell does not always load nvm, so try several locations and take the
# first one that actually runs.
resolve_node() {
  local candidates=() candidate home_dir from_login

  from_login="$(sudo -u "$RUN_USER" -H bash -lc 'command -v node' 2>/dev/null || true)"
  [[ -n "$from_login" ]] && candidates+=("$from_login")

  home_dir="$(getent passwd "$RUN_USER" | cut -d: -f6)"
  if [[ -n "$home_dir" ]]; then
    candidates+=("$home_dir/.nvm/current/bin/node")
    # Newest install first.
    while IFS= read -r candidate; do
      candidates+=("$candidate")
    done < <(ls -1dt "$home_dir"/.nvm/versions/node/*/bin/node 2>/dev/null || true)
  fi

  candidates+=(/usr/local/bin/node /usr/bin/node)

  for candidate in "${candidates[@]}"; do
    [[ -x "$candidate" ]] || continue
    "$candidate" --version >/dev/null 2>&1 || continue
    readlink -f "$candidate"
    return 0
  done
  return 1
}

NODE_BIN="${NODE_BIN:-$(resolve_node || true)}"
[[ -n "$NODE_BIN" ]] || die "could not find a working node for user $RUN_USER.
       Re-run with the path spelled out, for example:
         sudo NODE_BIN=\$(which node) bash scripts/install-service.sh"
NODE_BIN="$(readlink -f "$NODE_BIN")"
[[ -x "$NODE_BIN" ]] || die "node binary not executable: $NODE_BIN"
"$NODE_BIN" --version >/dev/null 2>&1 || die "node binary does not run: $NODE_BIN"

NODE_VERSION="$("$NODE_BIN" -v)"
if [[ "$NODE_BIN" == *"/.nvm/"* ]]; then
  echo "note: node comes from nvm ($NODE_BIN)."
  echo "      Upgrading node there removes this path and the service will fail at next boot."
  echo "      Re-run this script after any node upgrade, or install a system node in /usr/bin."
fi

echo "app dir : $APP_DIR"
echo "user    : $RUN_USER:$RUN_GROUP"
echo "node    : $NODE_BIN ($NODE_VERSION)"

# Generate the unit from the template.
TMP_UNIT="$(mktemp)"
trap 'rm -f "$TMP_UNIT"' EXIT
sed -e "s|__APP_DIR__|$APP_DIR|g" \
    -e "s|__NODE_BIN__|$NODE_BIN|g" \
    -e "s|__USER__|$RUN_USER|g" \
    -e "s|__GROUP__|$RUN_GROUP|g" \
    "$TEMPLATE" > "$TMP_UNIT"

grep -q '__' "$TMP_UNIT" && die "unit still has unreplaced placeholders"

install -m 644 -o root -g root "$TMP_UNIT" "$UNIT_PATH"
echo "installed $UNIT_PATH"

systemctl daemon-reload
systemctl enable "$SERVICE_NAME" >/dev/null
systemctl restart "$SERVICE_NAME"

sleep 2
if systemctl is-active --quiet "$SERVICE_NAME"; then
  PORT="$(grep -E '^PORT=' "$APP_DIR/.env.production" | cut -d= -f2 | tr -d '[:space:]')"
  # The address on the default route — `hostname -I` can hand back a docker bridge.
  IP="$(ip route get 1.1.1.1 2>/dev/null | awk '{print $7; exit}')"
  echo
  echo "service is running and enabled at boot."
  echo "open: http://${IP:-<server-ip>}:${PORT:-3000}"
  echo
  echo "logs   : journalctl -u $SERVICE_NAME -f"
  echo "status : systemctl status $SERVICE_NAME"
  echo "stop   : sudo systemctl stop $SERVICE_NAME"
else
  echo
  echo "service failed to start. Last 30 log lines:" >&2
  journalctl -u "$SERVICE_NAME" -n 30 --no-pager >&2
  exit 1
fi
