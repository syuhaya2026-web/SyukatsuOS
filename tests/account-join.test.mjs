import test from 'node:test';
import assert from 'node:assert/strict';
import { joinAccount } from '../account-migration.js';
import { DriveStore, documentOf } from '../drive-store.js';
import { fakeDrive } from './fake-drive.mjs';
async function setup() {
  const f = fakeDrive(),
    device = { id: 'mac', name: 'Mac' },
    store = new DriveStore(f.api, 'root', device);
  const remote = {
    companies: [{ id: 'phone', name: 'iPhone最新', updatedAt: '2026-10-07' }],
    progress: [],
    events: [],
    files: [{ id: 'f', name: 'メモ.txt', type: 'text/plain', base64: 'aGk=', size: 2 }],
  };
  await store.initialize(remote);
  const old = {
    companies: [{ id: 'mac', name: 'Macだけの旧データ', updatedAt: '2026-10-01' }],
    progress: [],
    events: [],
    files: [],
  };
  let local = {
    ...structuredClone(old),
    state: { owner: 'old-owner', revision: 'r', base: ['lost'], dirty: true },
  };
  const calls = [];
  const args = {
    api: async (p, o) => {
      calls.push(o?.method || 'GET');
      return f.api(p, o);
    },
    owner: 'new-owner',
    device,
    snapshot: async () => structuredClone(local),
    syncUpdate: async (r, patch, replacement) => {
      if (r !== local.state.revision) return false;
      local = { ...replacement, state: { ...local.state, ...patch } };
      return true;
    },
    encode: async (l) =>
      Object.fromEntries(['companies', 'progress', 'events', 'files'].map((k) => [k, l[k]])),
    decode: (d) => d.data,
    prepared: { revision: 'r', doc: documentOf(old, device) },
    onConfirm: async () => true,
  };
  return {
    f,
    store,
    args,
    calls,
    remote,
    get: () => local,
    edit: () => {
      local.state.revision = 'r2';
      local.companies[0].name = '編集中';
    },
  };
}
test('join replaces only backed-up local data and never writes to Drive', async () => {
  const s = await setup();
  assert(await joinAccount(s.args));
  assert.deepEqual(s.get().companies, s.remote.companies);
  assert.equal(s.get().files[0].base64, 'aGk=');
  assert.equal(s.get().state.owner, 'new-owner');
  assert.deepEqual(s.get().state.base, []);
  assert(!s.get().state.dirty);
  assert(s.calls.every((m) => m === 'GET'));
  assert.equal(s.args.prepared.doc.data.companies[0].id, 'mac');
});
test('cancel retains old account and local data', async () => {
  const s = await setup();
  assert.equal(await joinAccount({ ...s.args, onConfirm: () => false }), false);
  assert.equal(s.get().state.owner, 'old-owner');
  assert.equal(s.get().companies[0].id, 'mac');
});
test('edits during confirmation abort local replacement', async () => {
  const s = await setup();
  await assert.rejects(
    joinAccount({
      ...s.args,
      onConfirm: () => {
        s.edit();
        return true;
      },
    }),
    (e) => e.retry,
  );
  assert.equal(s.get().companies[0].name, '編集中');
  assert.equal(s.get().state.owner, 'old-owner');
});
test('remote edits during confirmation require reread instead of stale replacement', async () => {
  const s = await setup();
  await assert.rejects(
    joinAccount({
      ...s.args,
      onConfirm: async () => {
        const r = await s.store.load(),
          data = structuredClone(r.data);
        data.companies[0].name = '更新されたiPhone';
        await s.store.save(r, data);
        return true;
      },
    }),
    (e) => e.retry,
  );
  assert.equal(s.get().state.owner, 'old-owner');
});
test('missing target and stale backup cannot change local state', async () => {
  const s = await setup();
  await assert.rejects(joinAccount({ ...s.args, prepared: null }), /バックアップ/);
  s.f.files.delete('root');
  await assert.rejects(joinAccount(s.args), /特定/);
  assert.equal(s.get().state.owner, 'old-owner');
});
