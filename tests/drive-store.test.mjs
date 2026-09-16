import test from 'node:test';
import assert from 'node:assert/strict';
import { DriveStore, Changed, WEEK, RETENTION, documentOf } from '../drive-store.js';
import { mergeRecords } from '../merge.js';
import { fakeDrive } from './fake-drive.mjs';

const seed = () => ({
  companies: [
    { id: 'a', name: 'A株式会社', notes: '元', updatedAt: '2026-09-17' },
    { id: 'b', name: 'B株式会社', updatedAt: '2026-09-17' },
  ],
  progress: [
    {
      id: 'p',
      companyId: 'a',
      title: '面接',
      date: '2026-09-17',
      notes: 'メモ',
      attachmentIds: ['file'],
    },
  ],
  events: [],
  files: [{ id: 'file', name: '資料.txt', type: 'text/plain', base64: 'aGVsbG8=', size: 5 }],
});
const device = { id: 'mac', name: 'Mac' };
async function setup() {
  const fake = fakeDrive(),
    store = new DriveStore(fake.api, 'root', device);
  await store.initialize(seed());
  return { ...fake, store };
}
test('initialization verifies conditions, keeps a full checked backup, splits company and attachments', async () => {
  const { store, files } = await setup();
  const r = await store.load();
  assert.deepEqual(r.data, seed());
  assert.equal(r.control.value.backups.length, 1);
  assert.equal(r.control.value.companies.length, 2);
  assert.equal(r.control.value.files.length, 1);
  const slot = r.control.value.companies[0];
  assert.deepEqual(files.get(slot.fileId).body.data.files, []);
  const backup = await store.readBackup(r.control.value.backups[0]);
  assert.equal(backup.data.files[0].base64, 'aGVsbG8=');
});
test('same company updates overwrite the same file, not creating edit histories', async () => {
  const { store, files } = await setup();
  const count = files.size,
    r = await store.load(),
    id = r.control.value.companies[0].fileId;
  const d = structuredClone(r.data);
  d.companies[0].notes = 'changed';
  await store.save(r, d);
  assert.equal(files.size, count);
  assert.equal((await store.load()).data.companies[0].notes, 'changed');
  assert.equal((await store.control()).value.companies[0].fileId, id);
});
test('concurrent same-company updates reject stale write and merge different fields', async () => {
  const { store, api } = await setup();
  const other = new DriveStore(api, 'root', { id: 'phone', name: 'iPhone' }),
    a = await store.load(),
    b = await other.load(),
    da = structuredClone(a.data),
    db = structuredClone(b.data);
  da.companies[0].name = '新社名';
  db.companies[0].notes = 'iPhoneメモ';
  await store.save(a, da);
  await assert.rejects(() => other.save(b, db), Changed);
  const fresh = await other.load(),
    merged = mergeRecords(b.data, [
      { ...documentOf(db, device), id: 'local' },
      { ...documentOf(fresh.data, device), id: 'remote' },
    ]);
  assert.equal(merged.conflicts.length, 0);
  await other.save(fresh, merged.data);
  const result = (await store.load()).data;
  assert.equal(result.companies[0].name, '新社名');
  assert.equal(result.companies[0].notes, 'iPhoneメモ');
});
test('different-company concurrent writes both succeed, deletions stay as tombstones', async () => {
  const { store, api, files } = await setup(),
    other = new DriveStore(api, 'root', device);
  const a = await store.load(),
    b = await other.load(),
    da = structuredClone(a.data),
    db = structuredClone(b.data);
  da.companies[0].notes = 'A changed';
  db.companies[1].notes = 'B changed';
  await store.save(a, da);
  await other.save(b, db);
  let r = await store.load();
  assert.equal(r.data.companies[0].notes, 'A changed');
  assert.equal(r.data.companies[1].notes, 'B changed');
  const count = files.size,
    d = structuredClone(r.data);
  d.companies = d.companies.filter((x) => x.id !== 'a');
  d.progress = [];
  await store.save(r, d);
  r = await store.load();
  assert.equal(r.data.companies.length, 1);
  assert.equal(files.size, count);
  assert.equal(
    files.get(r.control.value.companies.find((x) => x.id === 'a').fileId).body.deleted,
    true,
  );
});
test('weekly backup catches overdue startup; retention trashes only expired backups after success', async () => {
  const { store, files } = await setup();
  let r = await store.load();
  const start = Date.parse(r.control.value.backups[0].savedAt);
  assert.equal(await store.backup(r, { now: start + WEEK - 1 }), false);
  assert.equal(await store.backup(r, { now: start + WEEK }), true);
  r = await store.load();
  assert.equal(await store.backup(r, { now: start + 2 * WEEK + 100 }), true);
  r = await store.load();
  assert.equal(await store.backup(r, { now: start + RETENTION + WEEK }), true);
  const backups = (await store.control()).value.backups;
  assert(backups.every((b) => start + RETENTION + WEEK - Date.parse(b.savedAt) <= RETENTION));
  assert.equal(backups.length, 3);
  assert([...files.values()].some((f) => f.appProperties?.syukatsuBackup && f.trashed));
  await store.cleanup(start + 100 * WEEK);
  assert.equal((await store.control()).value.backups.length, 1);
});
test('failed upload never advances backup date or deletes the previous backup', async () => {
  const { store, setHook, files } = await setup(),
    r = await store.load(),
    old = r.control.value.backups[0];
  setHook(({ payload }) => {
    if (payload.format === 'syukatsu-drive') throw new Error('connection lost');
  });
  await assert.rejects(
    () => store.backup(r, { now: Date.parse(old.savedAt) + WEEK }),
    /connection lost/,
  );
  assert.equal((await store.control()).value.backups.length, 1);
  assert(!files.get(old.fileId).trashed);
});
test('simultaneous weekly attempts register only one backup', async () => {
  const { store, api } = await setup(),
    other = new DriveStore(api, 'root', device);
  const a = await store.load(),
    b = await other.load(),
    now = Date.parse(a.control.value.backups[0].savedAt) + WEEK;
  await Promise.all([store.backup(a, { now }), other.backup(b, { now })]);
  assert.equal((await store.control()).value.backups.length, 2);
});
test('unsafe conditional API stops migration and repeated attempts reuse draft', async () => {
  const fake = fakeDrive({ ignoreConditions: true }),
    store = new DriveStore(fake.api, 'root', device);
  await assert.rejects(() => store.initialize(seed()), /条件付き/);
  const count = fake.files.size;
  await assert.rejects(() => store.initialize(seed()), /条件付き/);
  assert.equal(fake.files.size, count);
  assert(!fake.files.get('root').appProperties.syukatsuV2);
});
test('late legacy update is detected rather than silently discarded', async () => {
  const { store, files } = await setup();
  files.set('legacy', {
    id: 'legacy',
    version: '1',
    parents: ['root'],
    appProperties: { syukatsuSnapshot: 'v1' },
  });
  await assert.rejects(() => store.load(), /旧版/);
});
test('backup tampering blocks restore and retention', async () => {
  const { store, files, mutate } = await setup(),
    r = await store.load(),
    entry = r.control.value.backups[0];
  const changed = structuredClone(files.get(entry.fileId).body);
  changed.data.companies[0].name = 'tamper';
  mutate(entry.fileId, { body: changed });
  await assert.rejects(() => store.readBackup(entry), /変更/);
  await assert.rejects(() => store.cleanup(Date.now() + RETENTION), /変更/);
});

test('interrupted retention resumes from persistent garbage queue', async () => {
  const { store, api, files } = await setup();
  const first = await store.load(),
    now = Date.parse(first.control.value.backups[0].savedAt) + RETENTION + WEEK;
  let failOnce = true;
  store.api = async (path, options, details) => {
    if (failOnce && options?.method === 'PATCH' && options.body?.includes?.('"trashed":true')) {
      failOnce = false;
      throw new Error('connection interrupted during cleanup');
    }
    return api(path, options, details);
  };
  await assert.rejects(() => store.backup(first, { now }), /interrupted/);
  const pending = await store.control();
  assert(pending.value.garbage.length > 0);
  const id = pending.value.garbage[0];
  assert(!files.get(id).trashed);
  store.api = api;
  await store.cleanup(now);
  assert.equal((await store.control()).value.garbage.length, 0);
  assert(files.get(id).trashed);
  assert.equal((await store.control()).value.backups.length, 1);
});
test('missing conditional metadata blocks writes before migration', async () => {
  const fake = fakeDrive(),
    store = new DriveStore(
      async (path, options, details) => {
        const r = await fake.api(path, options, details);
        if (String(path).includes('/v2/')) delete r.etag;
        return r;
      },
      'root',
      device,
    );
  await assert.rejects(() => store.initialize(seed()), /安全な上書き/);
  assert.equal(fake.files.size, 1);
});
test('migration resumes its draft after a failed upload without losing source', async () => {
  const fake = fakeDrive(),
    store = new DriveStore(fake.api, 'root', device);
  let fail = true;
  fake.setHook(({ payload }) => {
    if (fail && payload.format === 'syukatsu-company') {
      fail = false;
      throw new Error('interrupted');
    }
  });
  await assert.rejects(() => store.initialize(seed()), /interrupted/);
  assert(!fake.files.get('root').appProperties.syukatsuV2);
  fake.setHook(null);
  await store.initialize(seed());
  assert.deepEqual((await store.load()).data, seed());
});
test('backup reference cannot point at a non-backup file', async () => {
  const { store } = await setup(),
    r = await store.load();
  await assert.rejects(
    () => store.readBackup({ fileId: r.control.value.files[0].fileId, hash: '0'.repeat(64) }),
    /バックアップ以外/,
  );
});

test('v2 JSON ETag works without response headers and keeps private markers', async () => {
  const fake = fakeDrive(),
    store = new DriveStore(fake.api, 'root', device);
  assert.equal((await fake.api('files/root', {}, true)).etag, '');
  await store.initialize(seed());
  assert(fake.files.get('root').appProperties.syukatsuV2);
  assert.equal(fake.files.get('root').appProperties.syukatsu, 'v1');
  const remote = await store.load();
  const data = structuredClone(remote.data);
  data.companies[0].name = 'Updated';
  await store.save(remote, data);
  assert.equal((await store.load()).data.companies[0].name, 'Updated');
});
