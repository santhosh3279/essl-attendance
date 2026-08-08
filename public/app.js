const $ = (sel) => document.querySelector(sel);
const el = (tag, props = {}, children = []) => {
  const node = Object.assign(document.createElement(tag), props);
  for (const child of [].concat(children)) {
    if (child != null) node.append(child.nodeType ? child : document.createTextNode(child));
  }
  return node;
};

const state = { devices: [], employees: [], view: 'dashboard', user: null };

const isAdmin = () => state.user?.role === 'admin';

async function api(path, options = {}) {
  const response = await fetch(path, {
    headers: { 'Content-Type': 'application/json' },
    credentials: 'same-origin',
    ...options,
    body: options.body ? JSON.stringify(options.body) : undefined,
  });
  const text = await response.text();
  const data = text ? JSON.parse(text) : null;

  // The session expired or was revoked — drop straight back to the sign-in screen.
  if (response.status === 401 && !path.startsWith('/api/auth/')) {
    state.user = null;
    showGate('login', 'Your session ended. Sign in again.');
    throw new Error(data?.error || 'not signed in');
  }
  if (!response.ok) throw new Error(data?.error || data?.errors?.join(', ') || response.statusText);
  return data;
}

function toast(message, kind = '') {
  const node = el('div', { className: `toast ${kind}`, textContent: message });
  $('#toasts').append(node);
  setTimeout(() => node.remove(), 5000);
}

function table(target, columns, rows, emptyText = 'Nothing to show yet.') {
  const node = typeof target === 'string' ? $(target) : target;
  node.replaceChildren();

  if (!rows.length) {
    node.append(
      el('tbody', {}, [el('tr', {}, [el('td', { className: 'empty', colSpan: columns.length }, emptyText)])]),
    );
    return;
  }

  node.append(el('thead', {}, [el('tr', {}, columns.map((c) => el('th', {}, c.label)))]));
  node.append(
    el(
      'tbody',
      {},
      rows.map((row) =>
        el(
          'tr',
          {},
          columns.map((c) => {
            const cell = el('td', { className: c.className || '' });
            const value = c.get(row);
            if (value == null) cell.append('—');
            else if (value.nodeType) cell.append(value);
            else cell.append(String(value));
            return cell;
          }),
        ),
      ),
    ),
  );
}

const pill = (text, kind) => el('span', { className: `pill ${kind}` }, text);
const today = () => new Date().toLocaleDateString('en-CA');
const shortTime = (stamp) => (stamp ? stamp.slice(11, 19) : '—');

/* ---------- navigation ---------- */

const loaders = {};

function show(view) {
  // A hidden nav button means this role cannot use the view — its loader would
  // just take a 403 and leave a blank screen.
  const tab = document.querySelector(`nav button[data-view="${view}"]`);
  if (!tab || tab.hidden) view = 'dashboard';

  state.view = view;
  document.querySelectorAll('nav button').forEach((b) => b.classList.toggle('active', b.dataset.view === view));
  document.querySelectorAll('.view').forEach((s) => s.classList.toggle('active', s.id === `view-${view}`));
  loaders[view]?.().catch((err) => toast(err.message, 'bad'));
}

document.querySelectorAll('nav button').forEach((button) => {
  button.addEventListener('click', () => show(button.dataset.view));
});

/* ---------- dashboard ---------- */

loaders.dashboard = async () => {
  const stats = await api('/api/dashboard');

  $('#statCards').replaceChildren(
    ...[
      { label: 'Present today', value: stats.presentToday, sub: `of ${stats.employees} active employees` },
      { label: 'Absent today', value: stats.absentToday, sub: stats.today },
      { label: 'Punches today', value: stats.punchesToday, sub: 'across all devices' },
      {
        label: 'Devices',
        value: `${stats.devices.ok}/${stats.devices.total}`,
        sub: stats.devices.failing ? `${stats.devices.failing} failing` : 'reporting OK',
      },
      { label: 'Unmapped IDs', value: stats.unmapped, sub: 'device users without an employee' },
    ].map((card) =>
      el('div', { className: 'card' }, [
        el('div', { className: 'label' }, card.label),
        el('div', { className: 'value' }, String(card.value)),
        el('div', { className: 'sub' }, card.sub),
      ]),
    ),
  );

  table('#recentTable', [
    { label: 'Time', get: (r) => r.punch_local },
    { label: 'Employee', get: (r) => r.employee_name || pill(`unmapped ID ${r.device_user_id}`, 'warn') },
    { label: 'Code', get: (r) => r.employee_code },
    { label: 'Device', get: (r) => r.device_name },
    { label: 'Source', get: (r) => pill(r.source, r.source === 'live' ? 'info' : 'muted') },
  ], stats.recent, 'No punches recorded yet. Add a device and hit "Sync all now".');

  await refreshDevices();
  table('#healthTable', [
    { label: 'Device', get: (d) => d.name },
    { label: 'Address', get: (d) => `${d.ip}:${d.port}`, className: 'mono' },
    { label: 'Status', get: (d) => statusPill(d) },
    { label: 'Last sync', get: (d) => d.last_sync_at },
    { label: 'Live', get: (d) => (d.live_capture ? pill(d.live_connected ? 'streaming' : 'starting', d.live_connected ? 'ok' : 'warn') : pill('off', 'muted')) },
    { label: 'Serial', get: (d) => d.serial, className: 'mono' },
  ], state.devices, 'No devices configured yet.');
};

function statusPill(device) {
  if (!device.enabled) return pill('disabled', 'muted');
  if (device.last_status === 'ok') return pill('online', 'ok');
  if (device.last_status === 'error') return pill('error', 'bad');
  return pill('never synced', 'muted');
}

/* ---------- devices ---------- */

async function refreshDevices() {
  state.devices = await api('/api/devices');
  const select = $('#punchDevice');
  const current = select.value;
  select.replaceChildren(el('option', { value: '' }, 'All'));
  for (const device of state.devices) select.append(el('option', { value: device.id }, device.name));
  select.value = current;
  return state.devices;
}

loaders.devices = async () => {
  await refreshDevices();
  const grid = $('#deviceGrid');
  grid.replaceChildren();

  if (!state.devices.length) {
    grid.append(el('div', { className: 'empty' }, 'No devices yet. Click "Add device" to register your ESSL terminals.'));
    return;
  }

  for (const device of state.devices) {
    const card = el('div', { className: 'device-card' }, [
      el('h3', {}, [device.name, ' ', statusPill(device)]),
      el('div', { className: 'meta' }, [
        `${device.ip}:${device.port}`,
        device.location ? ` · ${device.location}` : '',
        device.driver === 'fake' ? ' · simulated' : '',
      ]),
      kv('Serial', device.serial || '—'),
      kv('Model', device.model || '—'),
      kv('Connection', device.conn_mode),
      kv('Last sync', device.last_sync_at || 'never'),
      kv('Live capture', device.live_capture ? (device.live_connected ? 'streaming' : 'starting…') : 'off'),
    ]);

    if (device.last_error) {
      card.append(el('div', { className: 'kv' }, [el('span', { className: 'mono', style: 'color:var(--bad)' }, device.last_error.slice(0, 120))]));
    }

    // Viewers get the same information without the controls they cannot use.
    if (!isAdmin()) {
      grid.append(card);
      continue;
    }

    const actions = el('div', { className: 'actions' }, [
      button('Sync now', 'btn small', () => run(`/api/devices/${device.id}/sync`, 'Synced')),
      button('Test', 'btn small ghost', () => run(`/api/devices/${device.id}/test`, 'Device reachable')),
      button('Sync clock', 'btn small ghost', () => run(`/api/devices/${device.id}/clock-sync`, 'Device clock set from server')),
      button('Edit', 'btn small ghost', () => openDeviceDialog(device)),
      button('Delete', 'btn small danger', async () => {
        if (!confirm(`Delete device "${device.name}"? Punch history is kept.`)) return;
        await api(`/api/devices/${device.id}`, { method: 'DELETE' });
        toast('Device deleted', 'ok');
        loaders.devices();
      }),
    ]);

    card.append(actions);
    grid.append(card);
  }
};

const kv = (key, value) => el('div', { className: 'kv' }, [el('span', {}, key), el('span', {}, String(value))]);

function button(label, className, onClick) {
  const node = el('button', { className, textContent: label });
  node.addEventListener('click', async () => {
    node.disabled = true;
    try {
      await onClick();
    } catch (err) {
      toast(err.message, 'bad');
    } finally {
      node.disabled = false;
    }
  });
  return node;
}

async function run(path, okMessage) {
  const result = await api(path, { method: 'POST' });
  if (result.status === 'error' || result.ok === false) throw new Error(result.error);
  const detail = result.inserted != null ? ` — ${result.inserted} new, ${result.skipped} already stored` : '';
  toast(okMessage + detail, 'ok');
  loaders[state.view]?.();
}

let editingDeviceId = null;

function openDeviceDialog(device = null) {
  editingDeviceId = device?.id ?? null;
  $('#deviceDialogTitle').textContent = device ? `Edit ${device.name}` : 'Add device';
  $('#dName').value = device?.name ?? '';
  $('#dLocation').value = device?.location ?? '';
  $('#dIp').value = device?.ip ?? '';
  $('#dPort').value = device?.port ?? 4370;
  $('#dInport').value = device?.inport ?? '';
  // The stored key is never sent back to the browser, so this always starts blank.
  $('#dCommKey').value = '';
  $('#dCommKeyHint').textContent = device?.has_comm_key
    ? 'A comm key is saved. Leave blank to keep it, or type a new one to replace it.'
    : 'Device password. On the terminal: Comm / Security settings. Blank if none set.';
  $('#dConnMode').value = device?.conn_mode ?? 'auto';
  $('#dDriver').value = device?.driver ?? 'zk';
  $('#dEnabled').checked = device ? !!device.enabled : true;
  $('#dLive').checked = device ? !!device.live_capture : false;
  $('#deviceDialog').showModal();
}

$('#addDeviceBtn').addEventListener('click', () => openDeviceDialog());
$('#deviceCancel').addEventListener('click', () => $('#deviceDialog').close());

$('#deviceForm').addEventListener('submit', async (event) => {
  event.preventDefault();
  const body = {
    name: $('#dName').value.trim(),
    location: $('#dLocation').value.trim() || null,
    ip: $('#dIp').value.trim(),
    port: Number($('#dPort').value) || 4370,
    inport: Number($('#dInport').value) || null,
    // Omitted when blank so editing a device does not wipe its saved key.
    ...($('#dCommKey').value.trim() ? { comm_key: $('#dCommKey').value.trim() } : {}),
    conn_mode: $('#dConnMode').value,
    driver: $('#dDriver').value,
    enabled: $('#dEnabled').checked,
    live_capture: $('#dLive').checked,
  };

  try {
    if (editingDeviceId) await api(`/api/devices/${editingDeviceId}`, { method: 'PUT', body });
    else await api('/api/devices', { method: 'POST', body });
    $('#deviceDialog').close();
    toast('Device saved', 'ok');
    loaders.devices();
  } catch (err) {
    toast(err.message, 'bad');
  }
});

/* ---------- employees ---------- */

async function refreshEmployees() {
  state.employees = await api('/api/employees');
  const select = $('#attEmployee');
  const current = select.value;
  select.replaceChildren(el('option', { value: '' }, 'All'));
  for (const employee of state.employees) {
    select.append(el('option', { value: employee.id }, `${employee.code} — ${employee.name}`));
  }
  select.value = current;
  return state.employees;
}

loaders.employees = async () => {
  await refreshEmployees();
  const term = $('#employeeSearch').value.trim().toLowerCase();
  const rows = state.employees.filter(
    (e) => !term || e.name.toLowerCase().includes(term) || e.code.toLowerCase().includes(term),
  );

  const columns = [
    { label: 'Code', get: (e) => e.code, className: 'mono' },
    { label: 'Name', get: (e) => e.name },
    { label: 'Department', get: (e) => e.department },
    { label: 'Status', get: (e) => (e.active ? pill('active', 'ok') : pill('inactive', 'muted')) },
    { label: 'Devices mapped', get: (e) => e.mapped_devices },
    { label: 'Punches', get: (e) => e.punch_count },
  ];

  if (isAdmin()) {
    columns.push({
      label: '',
      get: (e) =>
        el('span', {}, [
          button('Edit', 'btn small ghost', () => openEmployeeDialog(e)),
          ' ',
          button('Delete', 'btn small danger', async () => {
            if (!confirm(`Delete ${e.name}? Punch history is kept but unlinked.`)) return;
            await api(`/api/employees/${e.id}`, { method: 'DELETE' });
            toast('Employee deleted', 'ok');
            loaders.employees();
          }),
        ]),
    });
  }

  table('#employeeTable', columns, rows, 'No employees yet.');
};

$('#employeeSearch').addEventListener('input', () => loaders.employees());

let editingEmployeeId = null;

function openEmployeeDialog(employee = null) {
  editingEmployeeId = employee?.id ?? null;
  $('#employeeDialogTitle').textContent = employee ? `Edit ${employee.name}` : 'Add employee';
  $('#eCode').value = employee?.code ?? '';
  $('#eName').value = employee?.name ?? '';
  $('#eDept').value = employee?.department ?? '';
  $('#eActive').checked = employee ? !!employee.active : true;
  $('#employeeDialog').showModal();
}

$('#addEmployeeBtn').addEventListener('click', () => openEmployeeDialog());
$('#employeeCancel').addEventListener('click', () => $('#employeeDialog').close());

$('#employeeForm').addEventListener('submit', async (event) => {
  event.preventDefault();
  const body = {
    code: $('#eCode').value.trim(),
    name: $('#eName').value.trim(),
    department: $('#eDept').value.trim() || null,
    active: $('#eActive').checked,
  };
  try {
    if (editingEmployeeId) await api(`/api/employees/${editingEmployeeId}`, { method: 'PUT', body });
    else await api('/api/employees', { method: 'POST', body });
    $('#employeeDialog').close();
    toast('Employee saved', 'ok');
    loaders.employees();
  } catch (err) {
    toast(err.message, 'bad');
  }
});

/* ---------- mapping ---------- */

loaders.mappings = async () => {
  await refreshEmployees();
  const onlyUnmapped = $('#onlyUnmapped').checked;
  const rows = await api(`/api/mappings${onlyUnmapped ? '?unmapped=1' : ''}`);

  table('#mappingTable', [
    { label: 'Device', get: (m) => m.device_name },
    { label: 'Enrollment ID', get: (m) => m.device_user_id, className: 'mono' },
    { label: 'Name on device', get: (m) => m.device_user_name },
    { label: 'Punches', get: (m) => m.punch_count },
    { label: 'Employee', get: (m) => employeeSelect(m) },
    {
      label: '',
      get: (m) =>
        m.employee_id || !isAdmin()
          ? pill(m.employee_id ? 'linked' : 'unmapped', m.employee_id ? 'ok' : 'warn')
          : button('Create employee', 'btn small ghost', async () => {
              await api(`/api/mappings/${m.id}/create-employee`, { method: 'POST', body: {} });
              toast('Employee created and linked', 'ok');
              loaders.mappings();
            }),
    },
  ], rows, onlyUnmapped ? 'Every device user is linked to an employee.' : 'No device users seen yet — run a sync.');
};

function employeeSelect(mapping) {
  if (!isAdmin()) return mapping.employee_name ?? null;

  const select = el('select');
  select.append(el('option', { value: '' }, '— not linked —'));
  for (const employee of state.employees) {
    select.append(el('option', { value: employee.id }, `${employee.code} — ${employee.name}`));
  }
  select.value = mapping.employee_id ?? '';
  select.addEventListener('change', async () => {
    try {
      const result = await api(`/api/mappings/${mapping.id}`, {
        method: 'PUT',
        body: { employeeId: select.value || null },
      });
      toast(`Mapping saved — ${result.backfilled} past punches attributed`, 'ok');
      loaders.mappings();
    } catch (err) {
      toast(err.message, 'bad');
    }
  });
  return select;
}

$('#onlyUnmapped').addEventListener('change', () => loaders.mappings());

$('#autoLinkBtn').addEventListener('click', async () => {
  try {
    const result = await api('/api/mappings/auto-link', { method: 'POST' });
    toast(`Linked ${result.linked} device users, ${result.remaining} still unmatched`, 'ok');
    loaders.mappings();
  } catch (err) {
    toast(err.message, 'bad');
  }
});

/* ---------- attendance ---------- */

const statusKind = { present: 'ok', late: 'warn', incomplete: 'warn', absent: 'bad' };

loaders.attendance = async () => {
  await refreshEmployees();
  const departments = await api('/api/departments');
  const select = $('#attDept');
  const current = select.value;
  select.replaceChildren(el('option', { value: '' }, 'All'));
  for (const department of departments) select.append(el('option', { value: department }, department));
  select.value = current;
  await loadAttendance();
};

function attendanceQuery() {
  const params = new URLSearchParams({ from: $('#attFrom').value, to: $('#attTo').value });
  if ($('#attEmployee').value) params.set('employeeId', $('#attEmployee').value);
  if ($('#attDept').value) params.set('department', $('#attDept').value);
  return params;
}

async function loadAttendance() {
  const data = await api(`/api/attendance?${attendanceQuery()}`);
  const counts = data.rows.reduce((acc, row) => {
    acc[row.status] = (acc[row.status] || 0) + 1;
    return acc;
  }, {});
  const totalHours = data.rows.reduce((sum, row) => sum + (row.hours || 0), 0);

  $('#attSummary').replaceChildren(
    ...[
      { label: 'Records', value: data.rows.length, sub: `${data.from} → ${data.to}` },
      { label: 'Present', value: (counts.present || 0) + (counts.late || 0), sub: `${counts.late || 0} late` },
      { label: 'Absent', value: counts.absent || 0, sub: `${counts.incomplete || 0} incomplete` },
      { label: 'Total hours', value: totalHours.toFixed(1), sub: 'first in → last out' },
    ].map((card) =>
      el('div', { className: 'card' }, [
        el('div', { className: 'label' }, card.label),
        el('div', { className: 'value' }, String(card.value)),
        el('div', { className: 'sub' }, card.sub),
      ]),
    ),
  );

  table('#attendanceTable', [
    { label: 'Date', get: (r) => r.day },
    { label: 'Code', get: (r) => r.code, className: 'mono' },
    { label: 'Employee', get: (r) => r.name },
    { label: 'Department', get: (r) => r.department },
    { label: 'First in', get: (r) => r.firstIn },
    { label: 'Last out', get: (r) => r.lastOut },
    { label: 'Hours', get: (r) => r.hours },
    { label: 'Punches', get: (r) => r.punches },
    { label: 'Devices', get: (r) => (r.devices.length ? r.devices.join(', ') : null) },
    { label: 'Status', get: (r) => pill(r.status, statusKind[r.status] || 'muted') },
  ], data.rows, 'No employees or no data for this range.');
}

$('#attLoadBtn').addEventListener('click', () => loadAttendance().catch((e) => toast(e.message, 'bad')));
$('#attCsvBtn').addEventListener('click', () => {
  window.location = `/api/attendance.csv?${attendanceQuery()}`;
});
$('#attTodayBtn').addEventListener('click', () => {
  $('#attFrom').value = today();
  $('#attTo').value = today();
  loadAttendance();
});
$('#attMonthBtn').addEventListener('click', () => {
  const now = new Date();
  $('#attFrom').value = new Date(now.getFullYear(), now.getMonth(), 1).toLocaleDateString('en-CA');
  $('#attTo').value = today();
  loadAttendance();
});

/* ---------- punch log ---------- */

function punchQuery() {
  const params = new URLSearchParams({ from: $('#punchFrom').value, to: $('#punchTo').value });
  if ($('#punchDevice').value) params.set('deviceId', $('#punchDevice').value);
  return params;
}

loaders.punches = async () => {
  await refreshDevices();
  const rows = await api(`/api/punches?${punchQuery()}`);
  table('#punchTable', [
    { label: 'Timestamp', get: (p) => p.punch_local },
    { label: 'Device', get: (p) => p.device_name },
    { label: 'Enrollment ID', get: (p) => p.device_user_id, className: 'mono' },
    { label: 'Code', get: (p) => p.employee_code, className: 'mono' },
    { label: 'Employee', get: (p) => p.employee_name || pill('unmapped', 'warn') },
    { label: 'Source', get: (p) => pill(p.source, p.source === 'live' ? 'info' : 'muted') },
  ], rows, 'No punches in this range.');
};

$('#punchLoadBtn').addEventListener('click', () => loaders.punches().catch((e) => toast(e.message, 'bad')));
$('#punchCsvBtn').addEventListener('click', () => {
  window.location = `/api/punches.csv?${punchQuery()}`;
});

/* ---------- sync log ---------- */

loaders.synclog = async () => {
  const rows = await api('/api/sync-logs?limit=100');
  table('#syncTable', [
    { label: 'Started', get: (s) => s.started_at },
    { label: 'Device', get: (s) => s.device_name },
    { label: 'Trigger', get: (s) => pill(s.trigger, 'muted') },
    { label: 'Result', get: (s) => pill(s.status, s.status === 'ok' ? 'ok' : 'bad') },
    { label: 'Fetched', get: (s) => s.fetched },
    { label: 'New', get: (s) => s.inserted },
    { label: 'Duplicate', get: (s) => s.skipped },
    { label: 'Took', get: (s) => (s.duration_ms != null ? `${(s.duration_ms / 1000).toFixed(1)}s` : null) },
    { label: 'Error', get: (s) => s.error, className: 'wrap mono' },
  ], rows, 'No syncs recorded yet.');
};

/* ---------- global actions ---------- */

$('#syncAllBtn').addEventListener('click', async (event) => {
  const node = event.currentTarget;
  node.disabled = true;
  node.textContent = 'Syncing…';
  try {
    const result = await api('/api/sync', { method: 'POST' });
    const inserted = result.results.reduce((sum, r) => sum + (r.inserted || 0), 0);
    const failed = result.results.filter((r) => r.status === 'error');
    toast(
      `Sync finished — ${inserted} new punches` + (failed.length ? `, ${failed.length} device(s) failed` : ''),
      failed.length ? 'bad' : 'ok',
    );
    loaders[state.view]?.();
  } catch (err) {
    toast(err.message, 'bad');
  } finally {
    node.disabled = false;
    node.textContent = 'Sync all now';
  }
});

/* ---------- live stream ---------- */

let stream = null;

function connectStream() {
  stream?.close();
  const source = new EventSource('/api/events');
  stream = source;

  source.addEventListener('open', () => {
    $('#streamDot').className = 'dot ok';
    $('#streamText').textContent = 'live';
  });

  source.addEventListener('error', () => {
    $('#streamDot').className = 'dot bad';
    $('#streamText').textContent = 'reconnecting…';
  });

  source.addEventListener('punch', (event) => {
    const punch = JSON.parse(event.data);
    toast(`${punch.employeeName || `ID ${punch.deviceUserId}`} · ${punch.deviceName} · ${shortTime(punch.punchLocal)}`);
    if (['dashboard', 'punches'].includes(state.view)) loaders[state.view]?.();
  });

  source.addEventListener('sync', (event) => {
    const summary = JSON.parse(event.data);
    if (summary.status === 'error') toast(`${summary.deviceName}: ${summary.error}`, 'bad');
    if (state.view === 'dashboard') loaders.dashboard();
  });
}

/* ---------- users ---------- */

loaders.users = async () => {
  const rows = await api('/api/users');
  table('#userTable', [
    { label: 'Username', get: (u) => u.username, className: 'mono' },
    { label: 'Name', get: (u) => u.name },
    { label: 'Role', get: (u) => pill(u.role, u.role === 'admin' ? 'info' : 'muted') },
    { label: 'Status', get: (u) => (u.active ? pill('active', 'ok') : pill('disabled', 'muted')) },
    { label: 'Sessions', get: (u) => u.active_sessions },
    { label: 'Last sign-in', get: (u) => u.last_login_at },
    {
      label: '',
      get: (u) =>
        el('span', {}, [
          button('Edit', 'btn small ghost', () => openUserDialog(u)),
          ' ',
          button('Sign out', 'btn small ghost', async () => {
            const result = await api(`/api/users/${u.id}/sign-out`, { method: 'POST' });
            toast(`${result.sessionsEnded} session(s) ended`, 'ok');
            loaders.users();
          }),
          ' ',
          button('Delete', 'btn small danger', async () => {
            if (!confirm(`Delete user "${u.username}"?`)) return;
            await api(`/api/users/${u.id}`, { method: 'DELETE' });
            toast('User deleted', 'ok');
            loaders.users();
          }),
        ]),
    },
  ], rows, 'No users.');
};

let editingUserId = null;

function openUserDialog(user = null) {
  editingUserId = user?.id ?? null;
  $('#userDialogTitle').textContent = user ? `Edit ${user.username}` : 'Add user';
  $('#uUsername').value = user?.username ?? '';
  $('#uName').value = user?.name ?? '';
  $('#uRole').value = user?.role ?? 'viewer';
  $('#uActive').checked = user ? !!user.active : true;
  $('#uPassword').value = '';
  $('#uPasswordHint').textContent = user
    ? 'Leave blank to keep the current password. Changing it signs them out everywhere.'
    : 'At least 8 characters.';
  $('#userDialog').showModal();
}

$('#addUserBtn').addEventListener('click', () => openUserDialog());
$('#userCancel').addEventListener('click', () => $('#userDialog').close());

$('#userForm').addEventListener('submit', async (event) => {
  event.preventDefault();
  const body = {
    username: $('#uUsername').value.trim(),
    name: $('#uName').value.trim(),
    role: $('#uRole').value,
    active: $('#uActive').checked,
  };
  if ($('#uPassword').value) body.password = $('#uPassword').value;
  if (!editingUserId && !body.password) return toast('A password is required', 'bad');

  try {
    if (editingUserId) await api(`/api/users/${editingUserId}`, { method: 'PUT', body });
    else await api('/api/users', { method: 'POST', body });
    $('#userDialog').close();
    toast('User saved', 'ok');
    loaders.users();
  } catch (err) {
    toast(err.message, 'bad');
  }
});

/* ---------- account ---------- */

$('#passwordBtn').addEventListener('click', () => {
  $('#passwordForm').reset();
  $('#passwordDialog').showModal();
});
$('#passwordCancel').addEventListener('click', () => $('#passwordDialog').close());

$('#passwordForm').addEventListener('submit', async (event) => {
  event.preventDefault();
  if ($('#pNew').value !== $('#pConfirm').value) return toast('New passwords do not match', 'bad');

  try {
    const result = await api('/api/auth/change-password', {
      method: 'POST',
      body: { currentPassword: $('#pCurrent').value, newPassword: $('#pNew').value },
    });
    $('#passwordDialog').close();
    toast(`Password changed — ${result.otherSessionsEnded} other session(s) signed out`, 'ok');
  } catch (err) {
    toast(err.message, 'bad');
  }
});

$('#logoutBtn').addEventListener('click', async () => {
  try {
    await api('/api/auth/logout', { method: 'POST' });
  } catch { /* signing out locally regardless */ }
  state.user = null;
  stream?.close();
  stream = null;
  showGate('login', 'Signed out.');
});

/* ---------- sign-in gate ---------- */

let gateMode = 'login';

function showGate(mode, message = '') {
  gateMode = mode;
  const setup = mode === 'setup';

  $('#gate').hidden = false;
  document.querySelector('header').hidden = true;
  document.querySelector('main').hidden = true;

  $('#gateTitle').textContent = setup ? 'Create the first admin' : 'Sign in';
  $('#gateHint').textContent = setup
    ? 'No accounts exist yet. This one gets full control, and this page closes for good afterwards.'
    : message;
  $('#gateHint').hidden = !$('#gateHint').textContent;

  $('#gNameField').hidden = !setup;
  $('#gConfirmField').hidden = !setup;
  $('#gName').required = setup;
  $('#gConfirm').required = setup;
  $('#gPassword').autocomplete = setup ? 'new-password' : 'current-password';
  $('#gateSubmit').textContent = setup ? 'Create admin' : 'Sign in';

  const showMessage = !!message && !setup;
  $('#gateError').textContent = showMessage ? message : '';
  $('#gateError').hidden = !showMessage;
  $('#gateForm').reset();
  $('#gUsername').focus();
}

function showApp(user) {
  state.user = user;
  $('#gate').hidden = true;
  document.querySelector('header').hidden = false;
  document.querySelector('main').hidden = false;

  $('#whoami').textContent = `${user.name} (${user.role})`;
  // Viewers never see the controls they are not allowed to use.
  for (const node of document.querySelectorAll('[data-admin]')) node.hidden = !isAdmin();

  connectStream();
  show('dashboard');
}

$('#gateForm').addEventListener('submit', async (event) => {
  event.preventDefault();
  const error = $('#gateError');
  error.hidden = true;
  $('#gateSubmit').disabled = true;

  try {
    if (gateMode === 'setup' && $('#gPassword').value !== $('#gConfirm').value) {
      throw new Error('Passwords do not match');
    }
    const path = gateMode === 'setup' ? '/api/auth/setup' : '/api/auth/login';
    const body = {
      username: $('#gUsername').value.trim(),
      password: $('#gPassword').value,
      ...(gateMode === 'setup' ? { name: $('#gName').value.trim() } : {}),
    };
    const result = await api(path, { method: 'POST', body });
    showApp(result.user);
  } catch (err) {
    error.textContent = err.message;
    error.hidden = false;
  } finally {
    $('#gateSubmit').disabled = false;
  }
});

/* ---------- boot ---------- */

for (const id of ['#attFrom', '#attTo', '#punchFrom', '#punchTo']) $(id).value = today();
$('#attFrom').value = new Date(Date.now() - 6 * 864e5).toLocaleDateString('en-CA');

const status = await api('/api/auth/status');
if (status.authenticated) showApp(status.user);
else showGate(status.needsSetup ? 'setup' : 'login');
