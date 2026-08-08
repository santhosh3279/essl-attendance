import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const tmpDb = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'att-auth-')), 'test.db');
process.env.DB_PATH = tmpDb;

const { db } = await import('../src/db.js');
const { createApp } = await import('../src/app.js');

const server = createApp().listen(0);
await new Promise((resolve) => server.once('listening', resolve));
const base = `http://127.0.0.1:${server.address().port}`;

/** Tiny fetch wrapper that remembers a session cookie, like a browser would. */
function client() {
  let cookie = null;
  return async function call(method, path, body) {
    const response = await fetch(base + path, {
      method,
      headers: {
        'Content-Type': 'application/json',
        ...(cookie ? { Cookie: cookie } : {}),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const setCookie = response.headers.getSetCookie?.()[0];
    if (setCookie) cookie = setCookie.split(';')[0];

    const text = await response.text();
    let data = null;
    try {
      data = text ? JSON.parse(text) : null;
    } catch {
      data = text;
    }
    return { status: response.status, body: data };
  };
}

const anon = client();
const admin = client();
const viewer = client();

test('every /api route is denied without a session, except status and health', async () => {
  const protectedPaths = [
    ['GET', '/api/dashboard'],
    ['GET', '/api/devices'],
    ['GET', '/api/employees'],
    ['GET', '/api/mappings'],
    ['GET', '/api/users'],
    ['GET', '/api/sync-logs'],
    ['GET', '/api/events'],
    ['GET', '/api/attendance?from=2026-01-01&to=2026-01-02'],
    ['GET', '/api/attendance.csv?from=2026-01-01&to=2026-01-02'],
    ['GET', '/api/punches?from=2026-01-01&to=2026-01-02'],
    ['POST', '/api/sync'],
    ['POST', '/api/devices'],
  ];

  for (const [method, route] of protectedPaths) {
    const result = await anon(method, route, method === 'POST' ? {} : undefined);
    assert.equal(result.status, 401, `${method} ${route} should be 401`);
  }

  assert.equal((await anon('GET', '/api/auth/status')).status, 200);
  assert.equal((await anon('GET', '/api/health')).status, 200);
});

test('first-run setup creates an admin and then refuses forever', async () => {
  const status = await anon('GET', '/api/auth/status');
  assert.equal(status.body.needsSetup, true);

  const created = await admin('POST', '/api/auth/setup', {
    username: 'boss',
    name: 'The Boss',
    password: 'first-admin-pw',
  });
  assert.equal(created.status, 201);
  assert.equal(created.body.user.role, 'admin');

  const replay = await anon('POST', '/api/auth/setup', {
    username: 'attacker',
    name: 'Attacker',
    password: 'another-password',
  });
  assert.equal(replay.status, 409, 'setup must not run twice');

  const after = await anon('GET', '/api/auth/status');
  assert.equal(after.body.needsSetup, false);
});

test('wrong password is rejected and locks out after repeated failures', async () => {
  // Aimed at a username that does not exist: it exercises the same lockout path
  // (and the dummy-hash branch) without locking a real account for 15 minutes.
  const attacker = client();
  const guess = { username: 'ghost-user', password: 'not-the-password' };

  for (let i = 0; i < 5; i += 1) {
    assert.equal((await attacker('POST', '/api/auth/login', guess)).status, 401);
  }
  assert.equal(
    (await attacker('POST', '/api/auth/login', guess)).status,
    429,
    'should be locked out after 5 failures',
  );

  // The lockout is per username, so other accounts keep working from the same host.
  const boss = client();
  assert.equal(
    (await boss('POST', '/api/auth/login', { username: 'boss', password: 'first-admin-pw' })).status,
    200,
    'one attacked account must not lock out everyone sharing an IP',
  );
});

test('a viewer can read and export but cannot change anything', async () => {
  const created = await admin('POST', '/api/users', {
    username: 'desk',
    name: 'Front Desk',
    role: 'viewer',
    password: 'viewer-password',
  });
  assert.equal(created.status, 201);

  const login = await viewer('POST', '/api/auth/login', {
    username: 'desk',
    password: 'viewer-password',
  });
  assert.equal(login.status, 200);
  assert.equal(login.body.user.role, 'viewer');

  assert.equal((await viewer('GET', '/api/dashboard')).status, 200);
  assert.equal(
    (await viewer('GET', '/api/attendance.csv?from=2026-01-01&to=2026-01-02')).status,
    200,
  );

  assert.equal((await viewer('POST', '/api/devices', { name: 'x', ip: '1.2.3.4' })).status, 403);
  assert.equal((await viewer('DELETE', '/api/employees/1')).status, 403);
  assert.equal((await viewer('POST', '/api/sync')).status, 403);
  assert.equal((await viewer('GET', '/api/users')).status, 403, 'account list is admin-only');
  assert.equal(
    (await viewer('POST', '/api/users', { username: 'z', name: 'z', password: 'zzzzzzzz' })).status,
    403,
  );
});

test('a cross-site form post is rejected before it reaches a route', async () => {
  // A browser form can only send urlencoded/multipart/plain, never JSON.
  const response = await fetch(`${base}/api/sync`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: 'x=1',
  });
  assert.equal(response.status, 415);
});

test('the last active admin cannot be demoted, disabled or deleted', async () => {
  const users = await admin('GET', '/api/users');
  const boss = users.body.find((u) => u.username === 'boss');

  assert.equal((await admin('PUT', `/api/users/${boss.id}`, { role: 'viewer' })).status, 409);
  assert.equal((await admin('PUT', `/api/users/${boss.id}`, { active: false })).status, 409);
  assert.equal((await admin('DELETE', `/api/users/${boss.id}`)).status, 409);

  // With a second admin present, the first may step down.
  const second = await admin('POST', '/api/users', {
    username: 'deputy',
    name: 'Deputy',
    role: 'admin',
    password: 'deputy-password',
  });
  assert.equal(second.status, 201);
  assert.equal((await admin('PUT', `/api/users/${boss.id}`, { role: 'viewer' })).status, 200);

  // A role change ends that user's sessions, so restore boss through the deputy
  // and sign back in — later tests still need an admin.
  const deputy = client();
  await deputy('POST', '/api/auth/login', { username: 'deputy', password: 'deputy-password' });
  assert.equal((await deputy('PUT', `/api/users/${boss.id}`, { role: 'admin' })).status, 200);

  assert.equal(
    (await admin('GET', '/api/users')).status,
    401,
    'the demoted admin session must already be dead',
  );
  await admin('POST', '/api/auth/login', { username: 'boss', password: 'first-admin-pw' });
  assert.equal((await admin('GET', '/api/users')).status, 200);
});

test('revoking a session logs that browser out immediately', async () => {
  const target = client();
  await admin('POST', '/api/users', {
    username: 'temp',
    name: 'Temp',
    role: 'viewer',
    password: 'temp-password',
  });
  await target('POST', '/api/auth/login', { username: 'temp', password: 'temp-password' });
  assert.equal((await target('GET', '/api/dashboard')).status, 200);

  const users = await admin('GET', '/api/users');
  const temp = users.body.find((u) => u.username === 'temp');
  const signedOut = await admin('POST', `/api/users/${temp.id}/sign-out`);
  assert.equal(signedOut.body.sessionsEnded, 1);

  assert.equal((await target('GET', '/api/dashboard')).status, 401, 'session must be dead');
});

test('deactivating a user kills their session too', async () => {
  const target = client();
  await admin('POST', '/api/users', {
    username: 'leaver',
    name: 'Leaver',
    role: 'viewer',
    password: 'leaver-password',
  });
  await target('POST', '/api/auth/login', { username: 'leaver', password: 'leaver-password' });
  assert.equal((await target('GET', '/api/dashboard')).status, 200);

  const users = await admin('GET', '/api/users');
  const leaver = users.body.find((u) => u.username === 'leaver');
  assert.equal((await admin('PUT', `/api/users/${leaver.id}`, { active: false })).status, 200);

  assert.equal((await target('GET', '/api/dashboard')).status, 401);
  assert.equal(
    (await target('POST', '/api/auth/login', { username: 'leaver', password: 'leaver-password' }))
      .status,
    401,
    'a disabled account cannot sign back in',
  );
});

test.after(() => {
  server.close();
  db.close();
  fs.rmSync(path.dirname(tmpDb), { recursive: true, force: true });
});
