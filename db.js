// 保存ストア
export const stores = ['companies', 'progress', 'events', 'files'];
// IndexedDBの初期化
export const dbReady = new Promise((resolve, reject) => {
  const request = indexedDB.open('syukatsu-os', 1);
  request.onupgradeneeded = () => {
    for (const name of stores) {
      const store = request.result.createObjectStore(name, { keyPath: 'id' });
      if (name === 'progress' || name === 'events') store.createIndex('companyId', 'companyId');
    }
  };
  request.onsuccess = () => resolve(request.result);
  request.onerror = () => reject(request.error);
  request.onblocked = () => reject(new Error('別のタブを閉じて再読み込みしてください。'));
});
// 全件取得
export async function all(name) {
  const db = await dbReady;
  return new Promise((resolve, reject) => {
    const req = db.transaction(name).objectStore(name).getAll();
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}
// 複数ストアの一括保存
export async function write(operations) {
  const db = await dbReady;
  return new Promise((resolve, reject) => {
    const tx = db.transaction([...new Set(operations.map((o) => o.store))], 'readwrite');
    tx.oncomplete = resolve;
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error || new Error('保存を中断しました'));
    for (const op of operations) {
      const s = tx.objectStore(op.store);
      op.delete ? s.delete(op.id) : s.put(op.value);
    }
  });
}
// 保存操作の生成
export const put = (store, value) => ({ store, value });
export const remove = (store, id) => ({ store, id, delete: true });
export const uid = () => crypto.randomUUID();
