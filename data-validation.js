// Driveファイルを取り込む前の形式・参照・容量検証
export const MAX_SNAPSHOT_BYTES = 20 * 1024 * 1024;
const idPattern = /^[a-zA-Z0-9_-]{1,128}$/;
const object = (v) => v && typeof v === 'object' && !Array.isArray(v);
const text = (v, max = 1000000) => typeof v === 'string' && v.length <= max;
const id = (v) => typeof v === 'string' && idPattern.test(v);
const bad = (message) => {
  throw new Error(message);
};
export function validate(doc) {
  if (
    !object(doc) ||
    doc.format !== 'syukatsu-drive' ||
    doc.version !== 1 ||
    !id(doc.id) ||
    !Array.isArray(doc.parents) ||
    doc.parents.length > 500 ||
    !doc.parents.every(id) ||
    doc.parents.includes(doc.id) ||
    new Set(doc.parents).size !== doc.parents.length ||
    !text(doc.savedAt, 64) ||
    !Number.isFinite(Date.parse(doc.savedAt)) ||
    !object(doc.data)
  )
    bad('Drive履歴の形式が不正です。端末データは変更していません。');
  if (
    doc.device !== undefined &&
    (!object(doc.device) || !id(doc.device.id) || !text(doc.device.name, 80))
  )
    bad('端末情報の形式が不正です。');
  const sets = {};
  for (const name of ['companies', 'progress', 'events', 'files']) {
    const rows = doc.data[name];
    if (!Array.isArray(rows) || rows.length > 50000) bad('Driveデータの件数・形式が不正です。');
    sets[name] = new Set();
    for (const row of rows) {
      if (!object(row) || !id(row.id) || sets[name].has(row.id)) bad('DriveデータのIDが不正です。');
      sets[name].add(row.id);
      if (row.notes != null && !text(row.notes)) bad('メモの形式が不正です。');
    }
  }
  for (const c of doc.data.companies) {
    if (!text(c.name, 10000) || !text(c.updatedAt, 64)) bad('企業データが不正です。');
    for (const key of ['myPageUrl', 'companyUrl', 'logoUrl']) {
      if (c[key] == null || c[key] === '') continue;
      if (!text(c[key], 8192)) bad('URLが不正です。');
      let url;
      try {
        url = new URL(c[key]);
      } catch {
        bad('URLが不正です。');
      }
      if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password)
        bad('許可されていないURLです。');
    }
    if (
      c.currentStatusId &&
      !doc.data.progress.some((p) => p.id === c.currentStatusId && p.companyId === c.id)
    )
      bad('現在ステータスの参照が不正です。');
  }
  for (const p of doc.data.progress)
    if (
      !sets.companies.has(p.companyId) ||
      !text(p.title, 10000) ||
      !text(p.date, 10) ||
      !/^\d{4}-\d{2}-\d{2}$/.test(p.date) ||
      !Number.isFinite(Date.parse(p.date)) ||
      !Array.isArray(p.attachmentIds) ||
      p.attachmentIds.some((x) => !sets.files.has(x))
    )
      bad('進捗データが不正です。');
  for (const e of doc.data.events)
    if (
      !sets.companies.has(e.companyId) ||
      !text(e.title, 10000) ||
      !text(e.date, 32) ||
      !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(e.date) ||
      !Number.isFinite(Date.parse(e.date))
    )
      bad('予定データが不正です。');
  let encoded = 0;
  for (const f of doc.data.files) {
    if (
      !text(f.base64, MAX_SNAPSHOT_BYTES) ||
      !text(f.name, 10000) ||
      !text(f.type, 255) ||
      f.base64.length % 4 !== 0 ||
      !/^[A-Za-z0-9+/]*={0,2}$/.test(f.base64)
    )
      bad('添付データが不正です。');
    encoded += f.base64.length;
    if (encoded > MAX_SNAPSHOT_BYTES) bad('添付データの合計が上限を超えています。');
  }
  return doc;
}
// 分岐の検出・循環や欠落した履歴を拒否
export function headsOf(docs) {
  const map = new Map();
  for (const doc of docs) {
    if (map.has(doc.id) && JSON.stringify(map.get(doc.id)) !== JSON.stringify(doc))
      bad('同じIDで異なる履歴があります。');
    map.set(doc.id, doc);
  }
  const parents = new Set();
  const visiting = new Set(),
    done = new Set();
  function visit(key) {
    if (visiting.has(key)) bad('Drive履歴が循環しています。');
    if (done.has(key)) return;
    const doc = map.get(key);
    if (!doc) bad('Drive履歴が一部失われています。ファイルを削除・編集しないでください。');
    visiting.add(key);
    for (const parent of doc.parents) {
      parents.add(parent);
      visit(parent);
    }
    visiting.delete(key);
    done.add(key);
  }
  for (const key of map.keys()) visit(key);
  return [...map.values()].filter((doc) => !parents.has(doc.id));
}
// 巨大応答をJSON展開する前に制限
export async function readBoundedJSON(response, limit = MAX_SNAPSHOT_BYTES) {
  if (Number(response.headers.get('content-length')) > limit)
    bad('Drive応答が容量上限を超えています。');
  const reader = response.body.getReader(),
    chunks = [];
  let size = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > limit) {
        await reader.cancel();
        bad('Drive応答が容量上限を超えています。');
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return { value: JSON.parse(new TextDecoder().decode(bytes)), size };
}
