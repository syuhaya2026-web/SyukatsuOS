// 項目単位の3方向・複数端末マージ
const STORES = ['companies', 'progress', 'events', 'files'];
const EMPTY = () => Object.fromEntries(STORES.map((name) => [name, []]));
export const stable = (value) => JSON.stringify(normalize(value));
function normalize(value) {
  if (value === undefined) return { __missingValue: true };
  if (Array.isArray(value)) return value.map(normalize);
  if (value && typeof value === 'object')
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, normalize(value[key])]),
    );
  return value;
}
const equal = (a, b) => stable(a) === stable(b);
const meaningful = (row) =>
  row &&
  Object.fromEntries(
    Object.entries(row).filter(([key]) => !['updatedAt', 'createdAt'].includes(key)),
  );
const changed = (a, b) => !equal(meaningful(a), meaningful(b));
// すべての枝に共通する、最も近い履歴。曖昧な場合は推測しない。
export function commonBase(docs, heads) {
  if (!heads.length) return EMPTY();
  const map = new Map(docs.map((doc) => [doc.id, doc]));
  const ancestors = (id) => {
    const found = new Set();
    function walk(key) {
      if (found.has(key)) return;
      const doc = map.get(key);
      if (!doc) throw new Error('共通履歴が不足しています。');
      found.add(key);
      doc.parents.forEach(walk);
    }
    walk(id);
    return found;
  };
  const sets = heads.map((doc) => ancestors(doc.id));
  const common = [...sets[0]].filter((id) => sets.every((set) => set.has(id)));
  if (!common.length) return EMPTY();
  const maximal = common.filter(
    (id) => !common.some((other) => other !== id && ancestors(other).has(id)),
  );
  if (maximal.length > 1) {
    // 同時に作られた統合履歴には複数の共通親がある。衝突なしで再構成できる場合だけ使う。
    const shared = maximal.map((id) => map.get(id));
    const virtual = mergeRecords(commonBase(docs, shared), shared);
    if (!virtual.conflicts.length) return virtual.data;
    throw new Error(
      '共通履歴を一意に決められません。自動統合を止めました。履歴を残して復旧対応を依頼してください。',
    );
  }
  return map.get(maximal[0]).data;
}
const FIELD_LABELS = {
  name: '企業名',
  notes: 'メモ',
  title: 'タイトル',
  date: '日時',
  currentStatusId: '現在のステータス',
  myPageUrl: 'My Page URL',
  companyUrl: '企業URL',
  logoUrl: 'ロゴURL',
  attachmentIds: '添付ファイル',
  companyId: '所属企業',
  type: 'ファイル形式',
  base64: 'ファイルの内容',
  size: 'ファイルサイズ',
  googleCalendarEventId: 'Google Calendar ID',
  syncStatus: 'カレンダー状態',
};
// choices は競合キー→候補番号。未選択の項目は保存せず、プレビューだけ作成する。
export function mergeRecords(base, heads, choices = {}) {
  const result = EMPTY(),
    conflicts = [];
  const index = (data) =>
    Object.fromEntries(
      STORES.map((name) => [name, new Map(data[name].map((row) => [row.id, row]))]),
    );
  const original = index(base),
    branches = [...heads]
      .sort((a, b) => a.id.localeCompare(b.id))
      .map((doc) => ({ ...doc, index: index(doc.data) }));
  function pick(store, id, field, variants) {
    const key = JSON.stringify([store, id, field]);
    const unique = [];
    for (const v of variants) {
      const same = unique.find((x) => equal(x.value, v.value));
      if (same) same.sources.push(v.source);
      else unique.push({ value: v.value, sources: [v.source] });
    }
    if (unique.length === 1) return unique[0].value;
    const sourceRow =
      original[store].get(id) || branches.map((x) => x.index[store].get(id)).find(Boolean);
    const companyId = store === 'companies' ? id : sourceRow?.companyId;
    const company =
      original.companies.get(companyId) ||
      branches.map((x) => x.index.companies.get(companyId)).find(Boolean);
    const entry = {
      key,
      store,
      id,
      field,
      label: FIELD_LABELS[field] || field,
      company: company?.name || '添付ファイル',
      record: sourceRow?.title || sourceRow?.name || '',
      variants: unique,
    };
    if (!Object.hasOwn(choices, key)) {
      conflicts.push(entry);
      return unique[0]?.value;
    }
    const choice = choices[key];
    if (!Number.isInteger(choice) || choice < 0 || choice >= unique.length)
      throw new Error('競合の選択が不正です。');
    return unique[choice].value;
  }
  function mergeRow(store, id, old, available, subtreeChanged = false) {
    const present = available.filter((x) => x.row !== undefined),
      missing = available.filter((x) => x.row === undefined);
    if (!present.length) return undefined;
    if (old && missing.length) {
      const edited = present.filter((x) => changed(old, x.row) || subtreeChanged);
      if (!edited.length) return undefined;
      const keepMarker = {
        ...edited[0].row,
        notes: '編集した記録を保持し、残っている変更を統合します。',
      };
      const keep = pick(store, id, '削除または編集', [
        ...missing.map((x) => ({ value: undefined, source: x.doc })),
        ...edited.map((x) => ({ value: keepMarker, source: x.doc })),
      ]);
      return keep === undefined ? undefined : mergeRow(store, id, old, present);
    }
    if (store === 'files') {
      const variants = present.filter((x) => !old || changed(old, x.row));
      return variants.length
        ? pick(
            store,
            id,
            'ファイル本体',
            variants.map((x) => ({ value: x.row, source: x.doc })),
          )
        : old;
    }
    const out = { id };
    const keys = new Set([
      ...(old ? Object.keys(old) : []),
      ...present.flatMap((x) => Object.keys(x.row)),
    ]);
    for (const field of keys) {
      if (field === 'id') continue;
      if (field === 'updatedAt' || field === 'createdAt') {
        const times = [old?.[field], ...present.map((x) => x.row[field])]
          .filter((x) => typeof x === 'string')
          .sort();
        if (times.length) out[field] = field === 'createdAt' ? times[0] : times.at(-1);
        continue;
      }
      if (field === 'attachmentIds') {
        const before = new Set(old?.attachmentIds || []),
          added = new Set(),
          removed = new Set();
        for (const { row } of present) {
          const after = new Set(row.attachmentIds || []);
          for (const v of after) if (!before.has(v)) added.add(v);
          for (const v of before) if (!after.has(v)) removed.add(v);
        }
        out[field] = [
          ...new Set([...before].filter((x) => !removed.has(x)).concat([...added])),
        ].sort();
        continue;
      }
      const variants = present
        .filter((x) => !equal(x.row[field], old?.[field]))
        .map((x) => ({ value: x.row[field], source: x.doc }));
      const value = variants.length ? pick(store, id, field, variants) : old?.[field];
      if (value !== undefined) out[field] = value;
    }
    return out;
  }
  const idsFor = (store) =>
    [
      ...new Set([
        ...original[store].keys(),
        ...branches.flatMap((b) => [...b.index[store].keys()]),
      ]),
    ].sort();
  for (const id of idsFor('companies')) {
    const old = original.companies.get(id);
    const available = branches.map((doc) => ({ doc, row: doc.index.companies.get(id) }));
    const hasDeletion = !!old && available.some((x) => !x.row);
    const subtreeChanged =
      hasDeletion &&
      branches.some(
        (b) =>
          b.index.companies.has(id) &&
          ['progress', 'events'].some((store) => {
            const before = base[store]
              .filter((x) => x.companyId === id)
              .map(meaningful)
              .sort((a, b) => a.id.localeCompare(b.id));
            const after = b.data[store]
              .filter((x) => x.companyId === id)
              .map(meaningful)
              .sort((a, b) => a.id.localeCompare(b.id));
            return !equal(before, after);
          }),
      );
    const row = mergeRow('companies', id, old, available, subtreeChanged);
    if (row) result.companies.push(structuredClone(row));
  }
  const kept = new Set(result.companies.map((x) => x.id));
  for (const store of ['progress', 'events', 'files'])
    for (const id of idsFor(store)) {
      const old = original[store].get(id),
        candidate = old || branches.map((b) => b.index[store].get(id)).find(Boolean);
      if (store !== 'files' && !kept.has(candidate.companyId)) continue;
      // 企業そのものを削除した枝は、その企業を残す選択後の子項目マージに使わない。
      const available = branches
        .filter((b) => store === 'files' || b.index.companies.has(candidate.companyId))
        .map((doc) => ({ doc, row: doc.index[store].get(id) }));
      const row = mergeRow(store, id, old, available);
      if (row) result[store].push(row);
    }
  for (const c of result.companies)
    if (
      c.currentStatusId &&
      !result.progress.some((p) => p.id === c.currentStatusId && p.companyId === c.id)
    )
      c.currentStatusId = '';
  return { data: result, conflicts };
}
export function deviceLabel(doc) {
  return `${doc.device?.name || '旧版の端末'}${doc.device?.id ? ' · ' + doc.device.id.slice(0, 6) : ''}`;
}
