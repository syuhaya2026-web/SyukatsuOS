// 保存ストア
export const stores = ['companies', 'progress', 'events', 'files'];
// IndexedDBの初期化・同期情報の追加
export const dbReady = new Promise((resolve, reject) => {
  const request = indexedDB.open('syukatsu-os', 2);
  request.onupgradeneeded = () => {
    for (const name of [...stores, 'sync']) {
      if (request.result.objectStoreNames.contains(name)) continue;
      const store = request.result.createObjectStore(name, { keyPath: 'id' });
      if (name === 'progress' || name === 'events') store.createIndex('companyId', 'companyId');
    }
  };
  request.onsuccess = () => {
    request.result.onversionchange = () => request.result.close();
    resolve(request.result);
  };
  request.onerror = () => reject(request.error);
  request.onblocked = () => reject(new Error('別の就活OSタブを閉じて再読み込みしてください。'));
});
export async function all(name) {
  const db = await dbReady;
  return new Promise((resolve, reject) => {
    const req = db.transaction(name).objectStore(name).getAll();
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}
// 端末変更と未同期マークを同じトランザクションで保存
export async function write(operations) {
  const db = await dbReady;
  return new Promise((resolve, reject) => {
    const tx = db.transaction(
      [...new Set([...operations.map((o) => o.store), 'sync'])],
      'readwrite',
    );
    tx.oncomplete = () => {
      window.dispatchEvent(new Event('local-change'));
      resolve();
    };
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error || new Error('保存を中断しました'));
    const sync = tx.objectStore('sync'),
      req = sync.get('state');
    req.onsuccess = () => sync.put({ ...req.result, id: 'state', dirty: true, revision: uid() });
    for (const op of operations) {
      const store = tx.objectStore(op.store);
      op.delete ? store.delete(op.id) : store.put(op.value);
    }
  });
}
// データと同期状態の一貫したスナップショット
export async function snapshot() {
  const db = await dbReady;
  return new Promise((resolve, reject) => {
    const tx = db.transaction([...stores, 'sync']);
    const result = {};
    for (const name of stores) {
      const r = tx.objectStore(name).getAll();
      r.onsuccess = () => (result[name] = r.result);
    }
    const r = tx.objectStore('sync').get('state');
    r.onsuccess = () =>
      (result.state = r.result || {
        id: 'state',
        revision: 'initial',
        dirty: false,
        base: [],
      });
    tx.oncomplete = () => resolve(result);
    tx.onerror = () => reject(tx.error);
  });
}
// 同期中に編集された場合は置き換えを中止
export async function syncUpdate(expected, patch, replacement) {
  const db = await dbReady;
  return new Promise((resolve, reject) => {
    const tx = db.transaction([...stores, 'sync'], 'readwrite');
    let changed = false;
    const r = tx.objectStore('sync').get('state');
    r.onsuccess = () => {
      const old = r.result || { id: 'state', revision: 'initial', base: [] };
      if (old.revision !== expected) return;
      changed = true;
      if (replacement)
        for (const name of stores) {
          const store = tx.objectStore(name);
          store.clear();
          for (const value of replacement[name]) store.put(value);
        }
      tx.objectStore('sync').put({ ...old, ...patch, id: 'state' });
    };
    tx.oncomplete = () => resolve(changed);
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error || new Error('同期の保存を中断しました'));
  });
}
export const put = (store, value) => ({ store, value });
export const remove = (store, id) => ({ store, id, delete: true });
export const uid = () => crypto.randomUUID();
