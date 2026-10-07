// 旧アカウントを読まずに端末の全データを新アカウントへ退避する。
import { DriveStore, Changed } from './drive-store.js';
import { validate } from './data-validation.js';
import { stable } from './merge.js';

export async function migrateAccount({
  api,
  owner,
  clientId,
  device,
  snapshot,
  syncUpdate,
  encode,
  prepared,
  onProgress = () => {},
}) {
  let local = await snapshot();
  let pending = local.state.accountMigration;
  if (!pending) {
    if (!prepared || prepared.revision !== local.state.revision)
      throw new Error(
        '端末の内容が変わりました。最新のバックアップを保存してから移行してください。',
      );
    if (!local.state.owner || local.state.owner === owner)
      throw new Error('移行元とは別のGoogleアカウントを選択してください。');
    const doc = validate(prepared.doc);
    if (!Object.values(doc.data).some((rows) => rows.length))
      throw new Error(
        'この端末には移行する記録がありません。記録が見えるiPhoneのアプリで操作してください。',
      );
    if (stable(doc.data) !== stable(await encode(local)))
      throw new Error('バックアップと端末の内容が一致しません。もう一度保存してください。');
    const existing = await api(
      'files?' +
        new URLSearchParams({
          q: "trashed = false and mimeType = 'application/vnd.google-apps.folder' and appProperties has { key='syukatsu' and value='v1' }",
          fields: 'files(id),nextPageToken',
          pageSize: '1',
        }),
    );
    if (existing.files.length || existing.nextPageToken)
      throw new Error(
        '選んだアカウントには既に就活OSの保存先があります。上書きせず停止しました。移行先のアカウントを確認してください。',
      );
    const generated = await api('files/generateIds?count=1&space=drive&type=files');
    const root = generated.ids?.[0];
    if (typeof root !== 'string' || !/^[a-zA-Z0-9_-]{1,200}$/.test(root))
      throw new Error('移行先の準備ができませんでした。');
    pending = {
      owner,
      clientId,
      root,
      sourceOwner: local.state.owner,
      doc,
      startedAt: new Date().toISOString(),
    };
    // 移行元と送信する内容を先に端末へ記録する。通常の記録は変更しない。
    if (
      !(await syncUpdate(local.state.revision, {
        accountMigration: pending,
        revision: crypto.randomUUID(),
      }))
    )
      throw new Changed();
  }
  if (pending.owner !== owner || pending.clientId !== clientId)
    throw new Error(
      '移行途中です。開始時と同じ移行先アカウント・クライアントIDで再接続してください。',
    );
  validate(pending.doc);
  if (local.state.owner !== pending.sourceOwner)
    throw new Error('移行元の情報が変わりました。端末データを残して停止しました。');
  onProgress(
    'アカウント移行中',
    'この端末の記録を新しいDriveへ保存します。完了までアプリを閉じないでください。',
  );
  try {
    await api('files', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        id: pending.root,
        name: '就活OS',
        mimeType: 'application/vnd.google-apps.folder',
        appProperties: { syukatsu: 'v1' },
      }),
    });
  } catch (e) {
    if (e.status !== 409) throw e;
  }
  const store = new DriveStore(api, pending.root, device, onProgress);
  const root = await store.meta(pending.root);
  if (root.appProperties?.syukatsu !== 'v1')
    throw new Error('移行先のフォルダを確認できませんでした。');
  await store.initialize(pending.doc.data);
  const remote = await store.load();
  if (stable(remote.data) !== stable(pending.doc.data))
    throw new Error('移行先の内容が一致しません。端末の記録を残して停止しました。');
  const backup = remote.control.value.backups.find((b) => b.reason === 'migration');
  if (!backup || stable((await store.readBackup(backup)).data) !== stable(pending.doc.data))
    throw new Error('移行先の全体バックアップを確認できません。端末の記録は残しています。');
  // 最新の端末データを保持したまま、確認済みの新しい同期基準に切り替える。
  local = await snapshot();
  if (
    local.state.accountMigration?.root !== pending.root ||
    local.state.owner !== pending.sourceOwner
  )
    throw new Changed();
  const current = await encode(local);
  if (
    !(await syncUpdate(local.state.revision, {
      owner,
      base: [],
      v2Base: pending.doc.data,
      v2Control: store.controlId,
      dirty: stable(current) !== stable(pending.doc.data),
      accountMigration: null,
      revision: crypto.randomUUID(),
    }))
  )
    throw new Changed();
  return { root: pending.root, backup, companies: pending.doc.data.companies.length };
}

// 移行済みDriveを別端末で受信する。切替処理中はDriveへ一切書き込まない。
export async function joinAccount({
  api,
  owner,
  device,
  snapshot,
  syncUpdate,
  encode,
  decode,
  prepared,
  onConfirm,
  onProgress = () => {},
}) {
  const local = await snapshot();
  if (local.state.accountMigration)
    throw new Error('この端末には未完了の送信移行があります。先にその移行を完了してください。');
  if (!local.state.owner || local.state.owner === owner)
    throw new Error('旧アカウントとは別の、iPhoneで移行済みのアカウントを選んでください。');
  if (
    !prepared ||
    prepared.revision !== local.state.revision ||
    stable(validate(prepared.doc).data) !== stable(await encode(local))
  )
    throw new Error('端末の最新バックアップを保存・確認してから切り替えてください。');
  onProgress(
    '移行先を確認中',
    '新しいDriveの内容を読み込んでいます。まだ端末の記録は変更していません。',
  );
  const folders = await api(
    'files?' +
      new URLSearchParams({
        q: "trashed = false and mimeType = 'application/vnd.google-apps.folder' and appProperties has { key='syukatsu' and value='v1' }",
        fields: 'files(id),nextPageToken',
        pageSize: '2',
      }),
  );
  if (folders.files.length !== 1 || folders.nextPageToken)
    throw new Error(
      '移行済みの保存先を一つに特定できません。iPhoneと同じアカウント・クライアントIDを確認してください。',
    );
  const store = new DriveStore(api, folders.files[0].id, device);
  const remote = await store.load();
  if (!Object.values(remote.data).some((rows) => rows.length))
    throw new Error('移行先に記録がありません。iPhoneでの移行を確認してください。');
  const latest = [...remote.control.value.backups].sort((a, b) =>
    b.savedAt.localeCompare(a.savedAt),
  )[0];
  if (!latest)
    throw new Error('移行先に全体バックアップがありません。iPhoneでの移行を確認してください。');
  await store.readBackup(latest);
  const summary = {
    companies: remote.data.companies.length,
    progress: remote.data.progress.length,
    events: remote.data.events.length,
    files: remote.data.files.length,
  };
  if (!(await onConfirm(summary))) return false;
  const fresh = await store.load();
  if (fresh.signature !== remote.signature) throw new Changed();
  const current = await snapshot();
  if (
    current.state.revision !== local.state.revision ||
    current.state.owner !== local.state.owner ||
    current.state.accountMigration
  )
    throw new Changed();
  const replacement = decode({ ...prepared.doc, data: remote.data });
  if (
    !(await syncUpdate(
      local.state.revision,
      {
        owner,
        base: [],
        v2Base: remote.data,
        v2Control: store.controlId,
        dirty: false,
        accountMigration: null,
        revision: crypto.randomUUID(),
      },
      replacement,
    ))
  )
    throw new Changed();
  return true;
}
