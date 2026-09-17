import test from 'node:test';
import assert from 'node:assert/strict';
import { DriveStore, documentOf, digest } from '../drive-store.js';
import { mergeRecords } from '../merge.js';
import { fakeDrive } from './fake-drive.mjs';
const device = { id: 'mac', name: 'Mac' };
const seed = () => ({
  companies: [{ id: 'a', name: 'A', notes: 'original', updatedAt: '2026-09-17' }],
  progress: [],
  events: [],
  files: [],
});
async function setup() {
  const fake = fakeDrive(),
    store = new DriveStore(fake.api, 'root', device);
  const original = documentOf(seed(), device);
  await store.jsonWrite('old', original, {
    name: '記録.json',
    parents: ['root'],
    appProperties: { syukatsuSnapshot: 'v1' },
  });
  await store.initialize(seed());
  return { ...fake, store, original };
}
async function late(s, patch, parent = s.original) {
  const doc = { ...documentOf(structuredClone(parent.data), device), parents: [parent.id] };
  patch(doc.data);
  const id = 'late-' + doc.id;
  await s.store.jsonWrite(id, doc, {
    name: '記録_late.json',
    parents: ['root'],
    appProperties: { syukatsuSnapshot: 'v1' },
  });
  return doc;
}
async function plan(s) {
  return s.store.prepareLegacy(await s.store.load({ allowLegacy: true }));
}
test('late old Mac additions become company files without deleting old records', async () => {
  const s = await setup();
  const before = await s.store.load();
  const originalFile = before.control.value.companies[0].fileId;
  await late(s, (d) => d.companies.push({ id: 'b', name: 'Mac only', updatedAt: '2026-09-17' }));
  await assert.rejects(s.store.load(), /旧版/);
  const p = await plan(s);
  assert.equal(mergeRecords(p.base, p.heads).conflicts.length, 0);
  await s.store.recoverLegacy(p);
  const result = await s.store.load();
  assert.equal(result.data.companies.length, 2);
  assert(s.files.has('old'));
  assert(s.files.has(originalFile));
  assert.equal(result.control.value.companies.length, 2);
  assert.equal(result.control.value.backups.at(-1).reason, 'before-legacy-recovery');
  assert.equal(await s.store.prepareLegacy(result), null);
});
test('current company edits and old history edits merge; true conflicts require choice', async () => {
  const s = await setup(),
    before = await s.store.load(),
    data = structuredClone(before.data);
  data.companies[0].name = 'new name';
  await s.store.save(before, data);
  await late(s, (d) => (d.companies[0].notes = 'late note'));
  await s.store.recoverLegacy(await plan(s));
  let current = await s.store.load();
  assert.equal(current.data.companies[0].name, 'new name');
  assert.equal(current.data.companies[0].notes, 'late note');
  // A second old-device branch from the original history must use the recorded ancestry.
  await late(s, (d) => (d.companies[0].notes = 'second old note'));
  let p = await plan(s),
    m = mergeRecords(p.base, p.heads);
  assert.equal(m.conflicts.length, 1);
  const choices = Object.fromEntries(
    m.conflicts.map((c) => [c.key, c.variants.findIndex((v) => v.value === 'second old note')]),
  );
  await s.store.recoverLegacy(p, choices);
  assert.equal((await s.store.load()).data.companies[0].notes, 'second old note');
});
test('failed recovery upload preserves the active index and source data; retry succeeds', async () => {
  const s = await setup(),
    old = await s.store.control();
  await late(s, (d) => d.companies.push({ id: 'b', name: 'B', updatedAt: '2026-09-17' }));
  let fail = true;
  s.setHook(({ payload }) => {
    if (fail && payload.format === 'syukatsu-company') {
      fail = false;
      throw new Error('connection lost');
    }
  });
  await assert.rejects(s.store.recoverLegacy(await plan(s)), /connection lost/);
  assert.equal((await s.store.control()).meta.etag, old.meta.etag);
  s.setHook(null);
  await s.store.recoverLegacy(await plan(s));
  assert.equal((await s.store.load()).data.companies.length, 2);
});
test('two recovering devices cannot publish stale choices', async () => {
  const s = await setup();
  await late(s, (d) => (d.companies[0].notes = 'old edit'));
  const p = await plan(s),
    other = new DriveStore(s.api, 'root', { id: 'phone', name: 'iPhone' });
  const q = await other.prepareLegacy(await other.load({ allowLegacy: true }));
  await s.store.recoverLegacy(p);
  await assert.rejects(other.recoverLegacy(q), (e) => e.retry === true);
  assert.equal((await other.load()).data.companies[0].notes, 'old edit');
});
test('late update during recovery prevents acknowledgement; source survives', async () => {
  const s = await setup();
  await late(s, (d) => (d.companies[0].notes = 'first'));
  const p = await plan(s);
  let injected = false;
  s.setHook(async ({ payload }) => {
    if (!injected && payload.format === 'syukatsu-company') {
      injected = true;
      await late(s, (d) => d.companies.push({ id: 'b', name: 'B', updatedAt: '2026-09-17' }));
    }
  });
  await assert.rejects(s.store.recoverLegacy(p), (e) => e.retry === true);
  assert.notEqual((await s.store.control()).value.legacyKey, await s.store.legacyKey());
  s.setHook(null);
  const next = await plan(s);
  assert.equal(mergeRecords(next.base, next.heads).conflicts.length, 0);
  await s.store.recoverLegacy(next);
  assert.equal((await s.store.load()).data.companies.length, 2);
});
test('changed or missing initial history cannot be silently acknowledged', async () => {
  const s = await setup();
  s.mutate('old', { body: documentOf(seed(), device) });
  await assert.rejects(plan(s), /変更・削除/);
});
test('in-flight old company write after switch is detected on retained source', async () => {
  const s = await setup(),
    before = await s.store.load(),
    id = before.control.value.companies[0].fileId;
  await late(s, (d) => (d.companies[0].notes = 'old edit'));
  await s.store.recoverLegacy(await plan(s));
  s.mutate(id, { body: { ...s.files.get(id).body, data: seed() } });
  await assert.rejects(s.store.load(), /追加更新/);
});
test('resumed migration refreshes its legacy fingerprint even when data is unchanged', async () => {
  const fake = fakeDrive(),
    store = new DriveStore(fake.api, 'root', device);
  const first = documentOf(seed(), device);
  await store.jsonWrite('old', first, {
    name: '記録.json',
    parents: ['root'],
    appProperties: { syukatsuSnapshot: 'v1' },
  });
  let fail = true;
  fake.setHook(({ payload }) => {
    if (fail && payload.format === 'syukatsu-company') {
      fail = false;
      throw new Error('interrupted');
    }
  });
  await assert.rejects(store.initialize(seed()), /interrupted/);
  fake.setHook(null);
  await store.jsonWrite(
    'new-old',
    { ...documentOf(seed(), device), parents: [first.id] },
    { name: '記録_new.json', parents: ['root'], appProperties: { syukatsuSnapshot: 'v1' } },
  );
  await store.initialize(seed());
  assert.deepEqual((await store.load()).data, seed());
});
test('selected deletion versus edit is respected without losing retained original file', async () => {
  const s = await setup(),
    before = await s.store.load();
  const empty = { companies: [], progress: [], events: [], files: [] };
  await s.store.save(before, empty);
  await late(s, (d) => (d.companies[0].notes = 'late edit'));
  const p = await plan(s),
    m = mergeRecords(p.base, p.heads);
  assert.equal(m.conflicts.length, 1);
  const c = m.conflicts[0],
    idx = c.variants.findIndex((v) => v.value === undefined);
  assert(idx >= 0);
  await s.store.recoverLegacy(p, { [c.key]: idx });
  assert.equal((await s.store.load()).data.companies.length, 0);
});
test('identical retransmitted legacy documents are safely deduplicated', async () => {
  const s = await setup(),
    doc = await late(s, (d) => (d.companies[0].notes = 'retransmitted'));
  await s.store.jsonWrite('duplicate', doc, {
    name: '記録_duplicate.json',
    parents: ['root'],
    appProperties: { syukatsuSnapshot: 'v1' },
  });
  await s.store.recoverLegacy(await plan(s));
  assert.equal((await s.store.load()).data.companies[0].notes, 'retransmitted');
});
