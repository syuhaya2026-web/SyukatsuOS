import test from 'node:test';
import assert from 'node:assert/strict';
import { migrateAccount } from '../account-migration.js';
import { documentOf } from '../drive-store.js';
import { fakeDrive } from './fake-drive.mjs';
const data = () => ({
  companies: [
    { id: 'c', name: 'iPhoneだけの企業', selectionStatus: '早期選考', updatedAt: '2026-10-06' },
  ],
  progress: [{ id: 'p', companyId: 'c', title: '面接', date: '2026-10-06', attachmentIds: ['f'] }],
  events: [],
  files: [{ id: 'f', name: '資料.txt', type: 'text/plain', size: 5, base64: 'aGVsbG8=' }],
});
function setup() {
  const fake = fakeDrive();
  fake.files.clear();
  let local = {
    ...data(),
    state: {
      id: 'state',
      owner: 'banned-owner',
      revision: 'r1',
      dirty: false,
      base: ['old-history'],
      v2Base: data(),
      v2Control: 'old-control',
    },
  };
  const args = {
    api: fake.api,
    owner: 'new-owner',
    clientId: 'new-client',
    device: { id: 'phone', name: 'iPhone' },
    snapshot: async () => structuredClone(local),
    syncUpdate: async (revision, patch) => {
      if (local.state.revision !== revision) return false;
      Object.assign(local.state, patch);
      return true;
    },
    encode: async (snap) =>
      Object.fromEntries(
        ['companies', 'progress', 'events', 'files'].map((k) => [k, structuredClone(snap[k])]),
      ),
    prepared: { revision: 'r1', doc: documentOf(data(), { id: 'phone', name: 'iPhone' }) },
  };
  return {
    ...fake,
    args,
    get: () => local,
    edit: () => {
      local.companies[0].name = '送信中の追加編集';
      local.state.revision = 'r2';
      local.state.dirty = true;
    },
  };
}
test('migration copies attachments and verifies backup before switching account, without replacing local data', async () => {
  const s = setup(),
    result = await migrateAccount(s.args);
  assert.equal(s.get().state.owner, 'new-owner');
  assert.equal(s.get().state.accountMigration, null);
  assert.deepEqual(s.get().companies, data().companies);
  assert.deepEqual(s.get().state.base, []);
  assert.equal(s.files.get(result.backup.fileId).body.data.files[0].base64, 'aGVsbG8=');
  assert.equal(s.get().state.v2Control, s.files.get(result.root).appProperties.syukatsuV2);
});
test('interrupted upload keeps old owner and all local data; same target resumes without duplicate root', async () => {
  const s = setup();
  let fail = true;
  s.setHook(({ payload }) => {
    if (fail && payload.format === 'syukatsu-company') {
      fail = false;
      throw Error('offline');
    }
  });
  await assert.rejects(migrateAccount(s.args), /offline/);
  assert.equal(s.get().state.owner, 'banned-owner');
  assert.deepEqual(s.get().companies, data().companies);
  const root = s.get().state.accountMigration.root;
  s.setHook(null);
  await migrateAccount({ ...s.args, prepared: null });
  assert.equal(s.get().state.owner, 'new-owner');
  assert.equal([...s.files.values()].filter((f) => f.appProperties?.syukatsu === 'v1').length, 1);
  assert(s.files.has(root));
});
test('edits during transfer survive and stay dirty for normal synchronization', async () => {
  const s = setup();
  let once = false;
  s.setHook(({ payload }) => {
    if (!once && payload.format === 'syukatsu-company') {
      once = true;
      s.edit();
    }
  });
  await migrateAccount(s.args);
  assert.equal(s.get().companies[0].name, '送信中の追加編集');
  assert.equal(s.get().state.dirty, true);
  assert.equal(s.get().state.v2Base.companies[0].name, 'iPhoneだけの企業');
});
test('existing target folder is never overwritten', async () => {
  const s = setup();
  s.files.set('existing', { id: 'existing', version: '1', appProperties: { syukatsu: 'v1' } });
  await assert.rejects(migrateAccount(s.args), /既に/);
  assert.equal(s.files.size, 1);
  assert.equal(s.get().state.owner, 'banned-owner');
  assert(!s.get().state.accountMigration);
});
test('stale export and same account cannot start transfer', async () => {
  const s = setup();
  s.edit();
  await assert.rejects(migrateAccount(s.args), /内容が変わりました/);
  assert.equal(s.files.size, 0);
  const t = setup();
  await assert.rejects(migrateAccount({ ...t.args, owner: 'banned-owner' }), /別のGoogle/);
  assert.equal(t.files.size, 0);
});
test('pending migration refuses a different account or client ID', async () => {
  const s = setup();
  s.setHook(() => {
    throw Error('offline');
  });
  await assert.rejects(migrateAccount(s.args));
  await assert.rejects(migrateAccount({ ...s.args, owner: 'wrong-owner' }), /開始時と同じ/);
  await assert.rejects(migrateAccount({ ...s.args, clientId: 'wrong-client' }), /開始時と同じ/);
  assert.equal(s.get().state.owner, 'banned-owner');
});
