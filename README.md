# ESSL Attendance

Web app for managing attendance across multiple ESSL / ZKTeco biometric terminals.
Talks the ZK protocol via [`zkteco-js`](https://www.npmjs.com/package/zkteco-js), stores
everything in SQLite, and serves a single-page UI.

## Printable guide

`docs/ESSL-Attendance-Guide.pdf` — 10-page installation and user manual covering setup,
adding terminals, daily use, roles, troubleshooting, backups and the settings reference.
Written for whoever operates the system, not just whoever installs it.

Regenerate after editing `docs/manual.html`:

```bash
npm run docs:build          # needs wkhtmltopdf
pip install pypdf reportlab # optional: adds page numbers
```

## Two environments

Each has its own standalone env file — nothing is merged, so what you read is what
runs. `.env.example` documents every key.

| | Development | Production |
|---|---|---|
| Command | `npm run dev` | `npm start`, or the systemd service |
| Env file | `.env.development` | `.env.production` |
| Listens on | `127.0.0.1:3000` (this machine only) | `0.0.0.0:3000` (LAN) |
| Database | `data/dev.db` | `data/attendance.db` |
| Poll interval | 2 min | 10 min |
| Reload on edit | yes (`--watch`) | no |

`npm run seed:demo` only ever writes to the dev database, so it cannot contaminate
production data.

## Development

```bash
npm install
npm run seed:demo    # 3 simulated terminals + a week of punches
npm run dev          # http://127.0.0.1:3000
```

## Production — install as a service

Starts on boot, restarts on crash, retries forever.

```bash
npm install --omit=dev
sudo bash scripts/install-service.sh
```

The installer resolves your `node` binary, generates
`/etc/systemd/system/attendance.service`, enables it and starts it. Re-run it any
time after a code update or a node upgrade — it is idempotent.

If it cannot find node, spell out the path (`sudo` strips the environment, so pass it
on the command line, not via `export`):

```bash
sudo NODE_BIN="$(which node)" bash scripts/install-service.sh
```

```bash
systemctl status attendance      # is it up
journalctl -u attendance -f      # follow the log
sudo systemctl restart attendance
sudo bash scripts/uninstall-service.sh   # remove service, keep data
```

Then open `http://<server-ip>:3000` from any machine on the LAN.

**First boot: open the app and create the admin account straight away.** Until you
do, the setup page is available to anyone who reaches the port — it is a race you win
by being first. After that, every route requires a session (see *Accounts and roles*).

Traffic is still plain HTTP, so keep it on a trusted LAN and never port-forward it.
To limit exposure:
`sudo ufw allow from <your-subnet>/24 to any port 3000 proto tcp`.

**Node under nvm:** this server's node lives at
`/home/erpdev/.nvm/versions/node/v24.14.0/bin/node`, and systemd needs that absolute
path. Upgrading node via nvm deletes that directory and the service will fail at the
next boot — re-run the installer afterwards. To avoid the issue entirely, install a
system node (NodeSource) at `/usr/bin/node` and re-run the installer once.

## Accounts and roles

The first time you open the app it shows a **create the first admin** page. That page
works only while no account exists — once the first admin is created it returns 409
forever, so there is no default password and no window to squat in.

| | Admin | Viewer |
|---|---|---|
| Attendance grid, punch log, CSV export | yes | yes |
| Dashboard, devices, sync history (read) | yes | yes |
| Add/edit devices, sync, clock sync | yes | no |
| Add/edit employees, map enrollment IDs | yes | no |
| Manage accounts | yes | no |

Admins create the other accounts under **Users**. Everyone can change their own
password, which signs out their other sessions but not the current one.

How it is enforced:

- The guard is mounted on `/api` **before** every feature router, so a route added
  later is protected unless it is explicitly listed as public. Only
  `/api/auth/status`, `/api/auth/login`, `/api/auth/setup` and `/api/health` are open.
- Any non-GET is admin-only by default; viewers get the GETs, which is why the CSV
  exports work for them.
- Passwords are hashed with `scrypt` (`node:crypto`, no native dependency), compared
  in constant time. An unknown username still burns a dummy hash so response timing
  does not reveal which accounts exist.
- Sessions live in the database and are revocable. Only the SHA-256 of the token is
  stored, so a database copy does not hand over live sessions. 8 hours, sliding.
- Deactivating a user, changing their role or resetting their password kills their
  open sessions immediately. Admins can also force sign-out from the Users tab.
- The last active admin cannot be demoted, disabled or deleted.
- Failed logins: 5 per username, then a 15-minute lockout. The per-address limit is
  deliberately looser (20) so one attacked account cannot lock out everyone sharing
  an IP.
- The session cookie is `HttpOnly` and `SameSite=Strict`, and non-GET requests must
  be `application/json` — a cross-site HTML form cannot send that, which covers CSRF.

**What this does not do:** the cookie has no `Secure` flag, because that would stop
the browser sending it over plain HTTP. Traffic on the LAN is unencrypted, so
passwords are readable by anyone who can capture packets between browser and server.
Putting it behind a TLS reverse proxy fixes that; add `Secure` to the cookie in
`src/auth/sessions.js` at the same time. If you do add a proxy, note that `req.ip`
becomes the proxy's address and the per-IP lockout stops distinguishing clients until
you enable Express's `trust proxy`.

## Adding your three terminals

1. **Devices → Add device.** Name, IP, port (ESSL default `4370`), driver `Real ESSL / ZKTeco device`.
2. **Test** — reads the serial, model and firmware. If it fails, see *Connection* below.
3. **Sync now** — pulls the users and the full attendance log.
4. **Mapping** — link each device enrollment number to an employee.
   *Auto-link by matching code* does this in one click when the enrollment number
   equals the employee code. Linking backfills all past punches.
5. **Attendance** — daily grid, merged across all three devices, exportable as CSV.

### Connection

`auto` tries TCP 4370 first and falls back to UDP only when the device actively
refuses the TCP connection. If a terminal times out instead of refusing, set the
device to **UDP only**. `tcp` forces TCP and errors rather than silently falling back.

## How it works

```
browser ── HTTP/SSE ── Express ── DeviceAdapter ── zkteco-js ── terminal
                          │
                       SQLite
```

**`DeviceAdapter`** (`src/devices/adapter.js`) is the only thing that touches the
hardware library. Two implementations exist: `zk` (real) and `fake` (synthetic punches,
used by the demo seed and the tests), so the whole app runs without hardware present.

**One session per device.** ZK terminals accept a single connection at a time.
`src/devices/registry.js` serialises every access per device through a promise chain,
and pauses any live-capture stream while a sync runs, then resumes it.

**Sync is idempotent.** A terminal returns its *entire* log on every read. Punches are
deduplicated by `(device_serial, device_user_id, punch_local)` — keyed on the serial,
not the IP, so a DHCP change does not duplicate history. Re-syncing inserts nothing new.

**Enrollment numbers are per device.** ID 5 on the Main Gate is not ID 5 on the
Warehouse. `device_user_map` reconciles them to a single `employees` row; punches store
the resolved `employee_id` and are backfilled when a mapping changes.

**In/out is derived, not trusted.** Most deployments never press the in/out key, so the
device's punch-type field is stored but ignored: the first punch of the day is the
in, the last is the out, merged across all devices. Punches within
`DUPLICATE_PUNCH_WINDOW_MINUTES` of each other collapse into one (double-taps).

**Clock drift.** Terminals report wall-clock time with no timezone, so the device and
the server must agree. *Sync clock* on each device card pushes the server time.
Both the device-local stamp and a normalised UTC value are stored.

**Serials, not IPs.** The dedup key is the device serial. If a terminal's firmware
won't report one, punches are keyed on `ip:<address>:<port>` and automatically
re-keyed the first time the real serial becomes readable — history is migrated,
not duplicated.

**Each device needs its own local UDP bind port** (`inport`). Leave the field blank
and one is assigned automatically; two devices sharing it collide with `EADDRINUSE`
when they sync in parallel, and `zkteco-js` reports that failure late and unhelpfully.

## Sync modes

| Mode | Where | Notes |
|---|---|---|
| Scheduled poll | `POLL_INTERVAL_MINUTES`, default 10 | The reliable baseline. Set `0` to disable. |
| Manual | *Sync all now* / per-device *Sync now* | |
| Live capture | Per-device toggle | Streams punches as they happen. A blip silently ends the stream, so the poll always stays on as the safety net. |

## Configuration

Set in `.env.development` / `.env.production`; see `.env.example` for the full list.
`NODE_ENV`, `PORT`, `HOST`, `DB_PATH`, `POLL_INTERVAL_MINUTES`,
`DEVICE_TIMEOUT_SECONDS`, `WORKDAY_START` (drives the *late* flag), `WORKDAY_END`,
`DUPLICATE_PUNCH_WINDOW_MINUTES`.

`DB_PATH` is resolved against the working directory, so production sets it
absolutely — a relative path plus a wrong `WorkingDirectory` would silently create an
empty database elsewhere. A real shell variable beats the env file
(`PORT=4000 npm start` works), which is handy for a one-off.

`GET /api/health` reports the active environment, bind address and resolved database
path — the quickest way to confirm which profile is running.

## API

| Method | Path | |
|---|---|---|
| GET/POST | `/api/devices` | list / create |
| PUT/DELETE | `/api/devices/:id` | update / remove (punch history is kept) |
| POST | `/api/devices/:id/test` | connect and read device info |
| POST | `/api/devices/:id/sync` | pull users + attendance |
| POST | `/api/devices/:id/clock-sync` | push server time to the device |
| GET | `/api/devices/:id/users` | enrollment numbers seen on that device |
| GET | `/api/auth/status` | public — signed in? setup needed? |
| POST | `/api/auth/setup` | public — creates the first admin, once |
| POST | `/api/auth/login` / `/logout` | public / any user |
| POST | `/api/auth/change-password` | any user, ends their other sessions |
| GET/POST | `/api/users` | admin only |
| PUT/DELETE | `/api/users/:id` | admin only |
| POST | `/api/users/:id/sign-out` | admin only, revokes their sessions |
| GET/POST | `/api/employees` | |
| PUT/DELETE | `/api/employees/:id` | |
| GET | `/api/mappings?unmapped=1` | device user → employee links |
| PUT | `/api/mappings/:id` | link an employee, backfills punches |
| POST | `/api/mappings/:id/create-employee` | create + link in one step |
| POST | `/api/mappings/auto-link` | link every ID that matches an employee code |
| GET | `/api/attendance?from&to&employeeId&department` | daily grid |
| GET | `/api/attendance.csv?…` | same as CSV |
| GET | `/api/punches?from&to&deviceId&limit` | raw punch log |
| GET | `/api/punches.csv?…` | |
| POST | `/api/sync` | sync every enabled device |
| GET | `/api/sync-logs?limit` | sync history |
| GET | `/api/events` | Server-Sent Events: `punch`, `sync` |
| GET | `/api/dashboard` | summary counters |

## Tests

```bash
npm test
```

13 tests. Sync behaviour (dedup on re-sync, per-device enrollment isolation, mapping
backfill, serial re-keying, ID normalisation) against the fake adapter, plus the auth
gate over real HTTP: unauthenticated access denied, setup runs once, lockout, viewer
role limits, CSRF content-type guard, last-admin protection, session revocation.

## Known behaviour and limits

- **No weekend or holiday calendar.** Every day in the selected range counts, so
  Sundays and holidays show as `absent` in the grid, the CSV and the dashboard's
  absent counter. Filter by date range, or add a holiday table if you need it.
- **No TLS.** Logins and session cookies cross the network in clear text. Fine on a
  trusted LAN, not over anything wider — put it behind a TLS reverse proxy for that.
- **No password reset.** An admin resets another user's password from the Users tab.
  If you lose every admin password, the way back in is a row edit in SQLite.
- **`clearAttendanceLog` is deliberately not exposed.** It erases the log stored in
  the terminal's own memory and cannot be undone. Normal operation never needs it —
  re-reads are handled by the dedup index.
- **Docker:** the default bridge network commonly breaks UDP to LAN devices. Use host
  networking, or run on the host directly.

**Reset:** `rm -rf data/` drops the database; the schema is recreated on next start.
There is no migration step — `db.js` uses `CREATE TABLE IF NOT EXISTS`, so if you add
or change a column, existing installs keep the old schema and fail at query time.
Reset after any schema edit, or write the `ALTER TABLE` yourself.

## Verification status

Every path above is verified against the fake adapter and the HTTP API, including
dedup on re-sync, serial re-keying, live capture, SSE, and CSV export. **Nothing has
been tested against real ESSL hardware** — use *Test* on each device card as the first
real-world check.

One thing to watch on real hardware: a live-captured punch and the same punch read
later by polling are decoded from two different wire formats. If they disagree by a
second, the punch log will show both rows. The attendance grid is unaffected — the
`DUPLICATE_PUNCH_WINDOW_MINUTES` collapse absorbs the pair — so check the *Punch Log*
tab against a terminal you punch on yourself before trusting raw exports.

## Layout

```
.env.development           dev profile (loopback, dev.db, fast poll)
.env.production            prod profile (LAN, attendance.db)
scripts/
  attendance.service       systemd unit template
  install-service.sh       generates + installs + enables it (needs sudo)
  uninstall-service.sh     removes the service, keeps the data
  seed-demo.js             3 simulated terminals + a week of data (dev DB only)
src/
  index.js                 server lifecycle
  app.js                   Express app + the /api auth gate (mounted first)
  config.js  db.js         config, schema
  auth/
    passwords.js           scrypt hashing, constant-time compare
    sessions.js            server-side sessions, cookie handling
    middleware.js          deny-by-default gate, role checks, CSRF guard
  devices/
    adapter.js             the DeviceAdapter contract
    zkAdapter.js           real hardware (zkteco-js)
    fakeAdapter.js         synthetic device
    registry.js            per-device serialisation + live sessions
  sync/
    syncService.js         fetch, dedup, store, backfill
    scheduler.js           polling + live capture lifecycle
  services/
    attendanceService.js   daily grid, dashboard, CSV
  routes/                  auth, users, devices, employees, attendance, sync
public/                    single-page UI (no build step)
test/                      node:test
```
