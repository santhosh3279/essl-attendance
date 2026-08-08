#!/usr/bin/env bash
#
# Makes a consistent copy of the production database while the service is running.
#
#   bash scripts/backup.sh [destination-folder]
#
# Uses SQLite's VACUUM INTO through Node's built-in SQLite, so it needs no
# sqlite3 command-line tool and no extra packages.

set -euo pipefail

APP_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DEST_DIR="${1:-$APP_DIR/backups}"
ENV_FILE="$APP_DIR/.env.production"

SOURCE_DB="$APP_DIR/data/attendance.db"
if [[ -f "$ENV_FILE" ]]; then
  FROM_ENV="$(grep -E '^DB_PATH=' "$ENV_FILE" | cut -d= -f2- | tr -d '"' | tr -d "'" || true)"
  [[ -n "$FROM_ENV" ]] && SOURCE_DB="$FROM_ENV"
fi

[[ -f "$SOURCE_DB" ]] || { echo "database not found: $SOURCE_DB" >&2; exit 1; }

mkdir -p "$DEST_DIR"
TARGET="$DEST_DIR/attendance-$(date +%F-%H%M).db"

NODE_BIN="${NODE_BIN:-$(command -v node)}"
[[ -n "$NODE_BIN" ]] || { echo "node not found — set NODE_BIN=/path/to/node" >&2; exit 1; }

"$NODE_BIN" --input-type=module -e "
import { DatabaseSync } from 'node:sqlite';
const db = new DatabaseSync(process.argv[1], { readOnly: true });
db.exec(\`VACUUM INTO '\${process.argv[2].replace(/'/g, \"''\")}'\`);
const punches = db.prepare('SELECT COUNT(*) AS n FROM punches').get().n;
const employees = db.prepare('SELECT COUNT(*) AS n FROM employees').get().n;
db.close();
console.log(\`backed up \${punches} punches, \${employees} employees\`);
" "$SOURCE_DB" "$TARGET" 2>&1 | grep -v ExperimentalWarning | grep -v 'trace-warnings'

echo "wrote $TARGET ($(du -h "$TARGET" | cut -f1))"
echo "Keep copies off this server — a failed disk takes the originals and the backups together."
