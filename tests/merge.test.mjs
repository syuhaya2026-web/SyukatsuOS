import test from 'node:test';
import assert from 'node:assert/strict';
import { mergeRecords, commonBase } from '../merge.js';
import { companyNote, noteName } from '../company-notes.js';
import { validate } from '../data-validation.js';
const data = () => ({
  companies: [
    {
      id: 'c',
      name: 'A株式会社',
      notes: '元のメモ',
      updatedAt: '2026-09-16T00:00:00Z',
      currentStatusId: 'p',
    },
  ],
  progress: [
    {
      id: 'p',
      companyId: 'c',
      title: '面接',
      date: '2026-09-16',
      notes: '元のメモ',
      attachmentIds: [],
    },
  ],
  events: [],
  files: [],
});
const head = (id, data, parents = []) => ({
  format: 'syukatsu-drive',
  version: 1,
  id,
  parents,
  savedAt: '2026-09-16T00:00:00Z',
  device: { id, name: id === 'a' ? 'Mac' : 'iPhone' },
  data,
});
function setup() {
  const base = data();
  return { base, a: structuredClone(base), b: structuredClone(base) };
}
const run = (base, a, b, choices = {}) => mergeRecords(base, [head('a', a), head('b', b)], choices);
test('different fields in one company merge and do not mutate source', () => {
  const { base, a, b } = setup();
  a.companies[0].name = '新社名';
  b.companies[0].notes = '新メモ';
  const before = JSON.stringify([base, a, b]);
  const out = run(base, a, b);
  assert.equal(out.conflicts.length, 0);
  assert.equal(out.data.companies[0].name, '新社名');
  assert.equal(out.data.companies[0].notes, '新メモ');
  assert.equal(JSON.stringify([base, a, b]), before);
});
test('different companies and new events merge', () => {
  const { base, a, b } = setup();
  a.companies[0].notes = 'Mac';
  b.companies.push({ id: 'd', name: 'B', updatedAt: '2026-09-16' });
  b.events.push({ id: 'e', companyId: 'd', title: '説明会', date: '2026-10-01T12:00' });
  const out = run(base, a, b);
  assert.equal(out.conflicts.length, 0);
  assert.equal(out.data.companies.length, 2);
  assert.equal(out.data.events.length, 1);
  validate(head('m', out.data));
});
test('same field asks, retaining independent changes and stable choices with reordered heads', () => {
  const { base, a, b } = setup();
  a.progress[0].title = '面接合格';
  b.progress[0].title = '面接が合格';
  a.companies[0].notes = 'Mac別変更';
  b.progress[0].notes = 'iPhone別変更';
  const out = run(base, a, b);
  assert.equal(out.conflicts.length, 1);
  const conflict = out.conflicts[0];
  assert.equal(conflict.company, 'A株式会社');
  assert.equal(conflict.label, 'タイトル');
  const merged = mergeRecords(base, [head('b', b), head('a', a)], { [conflict.key]: 1 });
  assert.equal(merged.conflicts.length, 0);
  assert.equal(merged.data.progress[0].title, '面接が合格');
  assert.equal(merged.data.progress[0].notes, 'iPhone別変更');
  assert.equal(merged.data.companies[0].notes, 'Mac別変更');
});
test('three devices with same edit agree, distinct third value conflicts', () => {
  const { base, a, b } = setup();
  a.progress[0].title = b.progress[0].title = '合格';
  const c = structuredClone(base);
  assert.equal(mergeRecords(base, [head('a', a), head('b', b), head('c', c)]).conflicts.length, 0);
  c.progress[0].title = '不合格';
  const out = mergeRecords(base, [head('a', a), head('b', b), head('c', c)]);
  assert.equal(out.conflicts[0].variants.length, 2);
  assert.equal(out.conflicts[0].variants[0].sources.length, 2);
});
test('metadata timestamps do not create conflicts', () => {
  const { base, a, b } = setup();
  a.companies[0].updatedAt = '2026-09-17';
  b.companies[0].updatedAt = '2026-09-18';
  const out = run(base, a, b);
  assert.equal(out.conflicts.length, 0);
  assert.equal(out.data.companies[0].updatedAt, '2026-09-18');
});
test('independent attachment additions and removal merge as a set', () => {
  const { base, a, b } = setup();
  for (const d of [base, a, b]) {
    d.progress[0].attachmentIds = ['f'];
    d.files = [{ id: 'f', name: 'old', type: 'text/plain', base64: '' }];
  }
  a.progress[0].attachmentIds = ['a'];
  a.files.push({ id: 'a', name: 'new a', type: 'text/plain', base64: '' });
  b.progress[0].attachmentIds.push('b');
  b.files.push({ id: 'b', name: 'new b', type: 'text/plain', base64: '' });
  const out = run(base, a, b);
  assert.deepEqual(out.data.progress[0].attachmentIds, ['a', 'b']);
  assert.equal(out.data.files.length, 3);
  validate(head('m', out.data));
});
test('deletion versus unchanged is automatic, cleared status leaves input untouched', () => {
  const { base, a, b } = setup();
  a.progress = [];
  a.companies[0].currentStatusId = '';
  const out = run(base, a, b);
  assert.equal(out.conflicts.length, 0);
  assert.equal(out.data.progress.length, 0);
  assert.equal(out.data.companies[0].currentStatusId, '');
  assert.equal(base.companies[0].currentStatusId, 'p');
});
test('deletion versus editing asks and can keep record', () => {
  const { base, a, b } = setup();
  a.progress = [];
  a.companies[0].currentStatusId = '';
  b.progress[0].notes = 'edited';
  const out = run(base, a, b);
  assert.equal(out.conflicts.length, 1);
  assert.equal(out.conflicts[0].field, '削除または編集');
  const keep = run(base, a, b, { [out.conflicts[0].key]: 1 });
  assert.equal(keep.data.progress[0].notes, 'edited');
});
test('company deletion versus new child asks and keeps related records', () => {
  const { base, a, b } = setup();
  a.companies = [];
  a.progress = [];
  b.events.push({ id: 'e', companyId: 'c', title: '予定', date: '2026-10-01T12:00' });
  const out = run(base, a, b);
  assert.equal(out.conflicts.length, 1);
  const keep = run(base, a, b, { [out.conflicts[0].key]: 1 });
  assert.equal(keep.data.companies.length, 1);
  assert.equal(keep.data.progress.length, 1);
  assert.equal(keep.data.events.length, 1);
  validate(head('m', keep.data));
  const del = run(base, a, b, { [out.conflicts[0].key]: 0 });
  assert.equal(del.data.companies.length, 0);
  assert.equal(del.data.progress.length, 0);
  assert.equal(del.data.events.length, 0);
});
test('whole file content collisions ask, not corrupt base64', () => {
  const { base, a, b } = setup();
  base.files = [{ id: 'f', name: 'f', type: 'text/plain', base64: 'YQ==' }];
  a.files = [{ ...base.files[0], base64: 'Yg==' }];
  b.files = [{ ...base.files[0], base64: 'Yw==' }];
  const out = run(base, a, b);
  assert.equal(out.conflicts[0].field, 'ファイル本体');
  assert.equal(run(base, a, b, { [out.conflicts[0].key]: 1 }).data.files[0].base64, 'Yw==');
});
test('shared nearest ancestor and unrelated roots', () => {
  const base = head('root', data()),
    a = head('a', data(), ['root']),
    b = head('b', data(), ['root']);
  assert.equal(commonBase([base, a, b], [a, b]), base.data);
  assert.deepEqual(
    commonBase(
      [a, b].map((x) => ({ ...x, parents: [] })),
      [a, b],
    ),
    { companies: [], progress: [], events: [], files: [] },
  );
  assert.throws(() => commonBase([a, b], [a, b]), /不足/);
});
test('ambiguous crisscross history stops conservatively', () => {
  const r = head('r', data()),
    a = head('a', data(), ['r']),
    b = head('b', data(), ['r']),
    m = head('m', data(), ['a', 'b']),
    n = head('n', data(), ['a', 'b']);
  a.data.progress[0].title = '合格';
  b.data.progress[0].title = '不合格';
  assert.throws(() => commonBase([r, a, b, m, n], [m, n]), /一意/);
});
test('readable company note contains titles, memo, names and safe filename', () => {
  const d = data();
  d.progress[0].attachmentIds = ['f'];
  d.files = [{ id: 'f', name: '面接写真.png', type: 'image/png', size: 1024, base64: 'c2VjcmV0' }];
  const note = companyNote(d.companies[0], d);
  assert.match(note, /A株式会社/);
  assert.match(note, /選考タイムライン/);
  assert.match(note, /面接写真.png/);
  assert.ok(!note.includes('c2VjcmV0'));
  assert.match(note, /アプリには反映されません/);
  assert.equal(noteName({ name: 'A/B', id: 'c' }), 'A_B__c.txt');
});
test('untrusted device metadata rejected, old histories accepted', () => {
  validate(head('a', data()));
  assert.throws(() => validate({ ...head('a', data()), device: { id: 3, name: {} } }));
  const old = head('a', data());
  delete old.device;
  validate(old);
});

test('concurrent independent merges reconstruct a virtual common base', () => {
  const r = head('r', data()),
    a = head('a', data(), ['r']),
    b = head('b', data(), ['r']);
  a.data.companies[0].name = '新社名';
  b.data.companies[0].notes = '新メモ';
  const merged = mergeRecords(r.data, [a, b]).data;
  const m = head('m', structuredClone(merged), ['a', 'b']),
    n = head('n', structuredClone(merged), ['a', 'b']);
  assert.deepEqual(commonBase([r, a, b, m, n], [m, n]), merged);
  m.data.progress[0].title = '合格';
  n.data.progress[0].notes = '面接メモ';
  const result = mergeRecords(commonBase([r, a, b, m, n], [m, n]), [m, n]);
  assert.equal(result.conflicts.length, 0);
  assert.equal(result.data.progress[0].title, '合格');
  assert.equal(result.data.progress[0].notes, '面接メモ');
});

test('keeping a record after deletion retains edits from two other devices', () => {
  const { base, a, b } = setup(),
    c = structuredClone(base);
  a.companies = [];
  a.progress = [];
  b.companies[0].name = '社名変更';
  c.companies[0].notes = 'メモ変更';
  const heads = [head('a', a), head('b', b), head('c', c)];
  const pending = mergeRecords(base, heads);
  assert.equal(pending.conflicts.length, 1);
  assert.equal(pending.conflicts[0].variants.length, 2);
  const kept = mergeRecords(base, heads, { [pending.conflicts[0].key]: 1 });
  assert.equal(kept.conflicts.length, 0);
  assert.equal(kept.data.companies[0].name, '社名変更');
  assert.equal(kept.data.companies[0].notes, 'メモ変更');
});
