/**
 * Patches two crash bugs in zkteco-js that take the whole process down.
 *
 * Runs automatically after `npm install` (package.json "postinstall"), so the
 * fixes survive a reinstall instead of living as invisible local edits.
 * Idempotent: a sentinel comment marks an already-patched file.
 *
 * 1. readWithBuffer() rejects on a request timeout and then falls through to
 *    `reply.subarray(0, 16)` with reply still null — there is no `return` after
 *    the reject. The TypeError is thrown inside an async promise executor, so it
 *    surfaces as an unhandled rejection and Node exits. Any bulk-read timeout
 *    takes the service down.
 *
 * 2. The CMD_ACK_OK / CMD_PREPARE_DATA branch reads a 4-byte size at offset 1 of
 *    the payload without checking the payload is that long. Real devices do send
 *    short replies, and it throws ERR_OUT_OF_RANGE the same fatal way.
 *
 * Note: the vendored file uses CRLF, so every pattern here tolerates \r.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SENTINEL = 'PATCHED_BY_ATTENDANCE_APP';
const rootDir = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const target = path.join(rootDir, 'node_modules', 'zkteco-js', 'src', 'ztcp.js');

if (!fs.existsSync(target)) {
  console.log('[patch-zkteco] zkteco-js not installed, nothing to do');
  process.exit(0);
}

let source = fs.readFileSync(target, 'utf8');

if (source.includes(SENTINEL)) {
  console.log('[patch-zkteco] already patched');
  process.exit(0);
}

const patches = [
  {
    name: 'return after reject instead of dereferencing null',
    pattern: /\} catch \(err\) \{\r?\n\s*reject\(err\)\r?\n\s*console\.log\(reply\)\r?\n\s*\r?\n\s*\}/,
    replacement:
      `} catch (err) {\r\n` +
      `                return reject(err) // ${SENTINEL}\r\n` +
      `            }\r\n` +
      `            if (!reply || reply.length < 16) {\r\n` +
      `                return reject(new Error('SHORT_OR_EMPTY_REPLY'))\r\n` +
      `            }`,
  },
  {
    name: 'bounds-check the chunk size read',
    pattern: /(const recvData = reply\.subarray\(16\)\r?\n)(\s*)(const size = recvData\.readUIntLE\(1, 4\))/,
    replacement:
      `$1$2if (recvData.length < 5) {\r\n` +
      `$2    return resolve({data: Buffer.from([]), mode: 8})\r\n` +
      `$2}\r\n` +
      `$2$3`,
  },
];

let failed = false;
for (const patch of patches) {
  if (!patch.pattern.test(source)) {
    console.error(`[patch-zkteco] FAILED: could not find "${patch.name}" — library version changed?`);
    failed = true;
    continue;
  }
  source = source.replace(patch.pattern, patch.replacement);
  console.log(`[patch-zkteco] applied: ${patch.name}`);
}

fs.writeFileSync(target, source);

// A failure here means the app can still be killed by a device timeout, so make
// it loud rather than letting install look clean.
process.exit(failed ? 1 : 0);
