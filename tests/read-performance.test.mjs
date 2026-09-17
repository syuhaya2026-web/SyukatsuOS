import test from 'node:test';
import assert from 'node:assert/strict';
import { DriveStore } from '../drive-store.js';
import { fakeDrive } from './fake-drive.mjs';
test('cold company reads are bounded at four and warm reads reuse verified data', async () => {
  const f = fakeDrive(),
    device = { id: 'mac', name: 'Mac' };
  const initial = new DriveStore(f.api, 'root', device);
  const data = {
    companies: Array.from({ length: 12 }, (_, i) => ({
      id: 'c' + String(i).padStart(2, '0'),
      name: 'C' + i,
      updatedAt: '2026-09-17',
    })),
    progress: [],
    events: [],
    files: [],
  };
  await initial.initialize(data);
  const ids = new Set((await initial.control()).value.companies.map((c) => c.fileId));
  let active = 0,
    peak = 0,
    media = 0;
  const api = async (path, options, details) => {
    const u = new URL(
      path.startsWith('http') ? path : 'https://www.googleapis.com/drive/v3/' + path,
    );
    if (ids.has(u.pathname.split('/').at(-1)) && u.searchParams.get('alt') === 'media') {
      active++;
      peak = Math.max(peak, active);
      media++;
      await new Promise((r) => setTimeout(r, 5));
      try {
        return await f.api(path, options, details);
      } finally {
        active--;
      }
    }
    return f.api(path, options, details);
  };
  const progress = [],
    store = new DriveStore(
      api,
      'root',
      device,
      () => {},
      (done, total) => progress.push([done, total]),
    );
  assert.deepEqual((await store.load()).data, data);
  assert.equal(peak, 4);
  assert.equal(media, 12);
  assert.deepEqual(progress.at(-1), [12, 12]);
  await store.load();
  assert.equal(media, 12);
});
