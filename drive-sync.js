import { DriveStore, Changed, documentOf, WEEK } from './drive-store.js';
import { commonBase, mergeRecords, deviceLabel, stable } from './merge.js';
import { companyNote, noteName } from './company-notes.js';
import { snapshot, syncUpdate, stores, uid } from './db.js';
// Google Drive接続・同期状態（アクセストークンはメモリのみ）
const SCOPE = 'https://www.googleapis.com/auth/drive.file';
import { validate, headsOf, readBoundedJSON, MAX_SNAPSHOT_BYTES } from './data-validation.js';
export { validate, headsOf };
const LIMIT = MAX_SNAPSHOT_BYTES;
let historyDocs = [];
let scanBytes = 0,
  authPending = false;
let token = '',
  expiry = 0,
  owner = '',
  folder = '',
  busy = false,
  timer,
  conflict = null,
  scriptReady,
  queued = false,
  retryCount = 0,
  backend,
  backupEntries = [],
  backupPreview = null;
const panel = document.createElement('dialog');
panel.id = 'drive-dialog';
document.body.append(panel);
const button = document.createElement('button');
button.className = 'drive-status';
button.textContent = 'Drive 未接続';
document.querySelector('.topbar').append(button);
const escape = (v) =>
  String(v ?? '').replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c],
  );
let startMode = false,
  connectionStarted = false;
let status = '未接続',
  message = 'Google Driveに接続すると、編集後に自動保存します。';
function notify(label, detail = '') {
  status = label;
  message = detail;
  button.textContent = 'Drive ' + label;
  if (startMode && label === '同期済み') {
    startMode = false;
    panel.close();
  }
  if (panel.open) renderPanel();
}
function loadGoogle() {
  if (window.google?.accounts?.oauth2) return Promise.resolve();
  if (scriptReady) return scriptReady;
  scriptReady = new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = 'https://accounts.google.com/gsi/client';
    s.onload = resolve;
    s.onerror = () => {
      scriptReady = null;
      reject(new Error('Googleへの接続に失敗しました。オンラインで再度開いてください。'));
    };
    document.head.append(s);
  });
  return scriptReady;
}
// 端末名と競合表示
function thisDevice() {
  let id = localStorage.getItem('drive-device-id');
  if (!id) {
    id = uid();
    localStorage.setItem('drive-device-id', id);
  }
  const ua = navigator.userAgent;
  const fallback = /iPhone/.test(ua)
    ? 'iPhone'
    : /iPad/.test(ua) || (/Mac/.test(ua) && navigator.maxTouchPoints > 1)
      ? 'iPad'
      : /Mac/.test(ua)
        ? 'Mac'
        : /Android/.test(ua)
          ? 'Android'
          : /Windows/.test(ua)
            ? 'Windows PC'
            : 'この端末';
  return { id, name: localStorage.getItem('drive-device-name') || fallback };
}
function conflictValue(item, variant) {
  const v = variant.value;
  if (v === undefined) return '削除する';
  if (item.field === 'currentStatusId')
    return variant.sources[0].data.progress.find((p) => p.id === v)?.title || '未設定';
  if (v && typeof v === 'object')
    return [
      v.name || v.title || '',
      v.date || '',
      v.notes || '',
      v.base64 ? '添付本体（' + Math.floor((v.base64.length * 3) / 4) + 'バイト前後）' : '',
      item.store === 'companies' ? 'この企業と残っている関連記録を保持します。' : '',
    ]
      .filter(Boolean)
      .join('\n');
  return String(v ?? '');
}
function conflictMarkup() {
  if (!conflict) return '';
  return `<div class="merge-conflicts"><p class="note">別々の変更は自動で取り込まれます。以下の衝突だけ残す内容を選んでください。「削除または編集」は関連記録にも影響します。</p>${conflict.pending.map((item, index) => `<section class="merge-item"><h3>${escape(item.company)}</h3><p class="muted">${escape({ companies: '企業情報', progress: '選考タイムライン', events: '予定', files: '添付ファイル' }[item.store])} / ${escape(item.record)} / ${escape(item.label)}</p>${item.variants.map((variant, n) => `<label class="merge-option"><span><input type="radio" name="merge-${index}" value="${n}" ${conflict.choices[item.key] === n ? 'checked' : ''}>${escape(variant.sources.map(deviceLabel).join(' / '))}</span><small>${escape(variant.sources.map((x) => new Date(x.savedAt).toLocaleString('ja-JP')).join(' / '))}</small><pre>${escape(conflictValue(item, variant))}</pre></label>`).join('')}</section>`).join('')}<button class="primary" id="drive-resolve" ${busy ? 'disabled' : ''}>選んだ項目を反映して統合</button></div>`;
}
// 接続設定画面
function renderPanel() {
  if (startMode) {
    renderStartup();
    return;
  }
  panel.innerHTML = `<div class="row"><h2>Google Drive同期</h2><button id="drive-close" aria-label="閉じる">✕</button></div><p>${escape(status)}</p><p class="info muted">${escape(message)}</p>${conflictMarkup()}${backupMarkup()}<label>この端末の名前<input id="drive-device" maxlength="80" value="${escape(thisDevice().name)}"></label><label>OAuthクライアントID<input id="drive-client" value="${escape(localStorage.getItem('drive-client-id') || '')}" placeholder="…apps.googleusercontent.com" ${token ? 'disabled' : ''}></label><p class="note">接続中は保存直後と10秒ごとに同期します。別項目は自動統合し、同じ項目の変更だけ選択します。再起動・認証切れ後は接続操作が必要です。</p><div class="actions"><button id="drive-connect" ${token || busy || authPending ? 'disabled' : ''}>Googleに接続</button><button id="drive-now" ${!token || busy ? 'disabled' : ''}>今すぐ同期</button><button id="drive-disconnect" ${!token || busy ? 'disabled' : ''}>接続を解除</button></div><p class="muted">Driveの「企業別ノート」は閲覧用です。編集はアプリから行ってください。添付込み20MiB上限。週1回の全体バックアップを作り、30日を超えた分はゴミ箱へ移します。</p>`;
  panel.querySelector('#drive-close').onclick = () => panel.close();
  bindBackups();
  panel.querySelector('#drive-device').oninput = (e) => {
    localStorage.setItem('drive-device-name', e.target.value.trim().slice(0, 80));
  };
  panel.querySelector('#drive-connect').onclick = connect;
  panel.querySelector('#drive-now').onclick = () => run();
  panel.querySelector('#drive-disconnect').onclick = () => {
    if (busy) return;
    token = '';
    expiry = 0;
    folder = '';
    backend = null;
    conflict = null;
    notify('未接続', '端末・Driveの保存データは残っています。');
  };
  if (conflict) {
    conflict.pending.forEach((item, index) =>
      panel.querySelectorAll(`[name="merge-${index}"]`).forEach(
        (input) =>
          (input.onchange = () => {
            conflict.choices[item.key] = Number(input.value);
          }),
      ),
    );
    panel.querySelector('#drive-resolve').onclick = resolveConflict;
  }
}
button.onclick = () => {
  renderPanel();
  panel.showModal();
  loadGoogle().catch((e) => notify('接続エラー', e.message));
};
// Google OAuth（秘密鍵不要・アプリが作成したファイルだけの権限）
function connect() {
  if (busy || authPending || token) return;
  try {
    const id = panel.querySelector('#drive-client').value.trim();
    if (!/^[\w.-]+\.apps\.googleusercontent\.com$/.test(id))
      throw new Error('手順書に沿ってOAuthクライアントIDを入力してください。');
    if (!window.google?.accounts?.oauth2)
      throw new Error('Googleの読み込み中です。少し待って接続を押してください。');
    localStorage.setItem('drive-client-id', id);
    connectionStarted = true;
    authPending = true;
    notify('接続中', 'Googleの確認画面を操作してください。');
    google.accounts.oauth2
      .initTokenClient({
        client_id: id,
        scope: SCOPE,
        callback: async (result) => {
          if (result.error) {
            authPending = false;
            notify('接続エラー', result.error);
            return;
          }
          token = result.access_token;
          expiry = Date.now() + Number(result.expires_in) * 1000 - 60000;
          try {
            const info = await api('about?fields=user(permissionId)');
            owner = info.user?.permissionId;
            if (typeof owner !== 'string' || !owner)
              throw new Error('Googleアカウントを確認できませんでした。');
            const local = await snapshot();
            if (local.state.owner && local.state.owner !== owner) {
              token = '';
              throw new Error(
                'この端末は別のGoogleアカウントに紐付いています。元のアカウントで接続してください。',
              );
            }
            folder = '';
            backend = null;
            await run();
          } catch (e) {
            token = '';
            expiry = 0;
            owner = '';
            folder = '';
            notify('接続エラー', e.message);
          } finally {
            authPending = false;
            if (panel.open) renderPanel();
          }
        },
        error_callback: () => {
          authPending = false;
          notify('未接続', 'ログインが完了していません。もう一度接続してください。');
        },
      })
      .requestAccessToken({ prompt: 'select_account' });
  } catch (e) {
    authPending = false;
    notify('設定を確認', e.message);
  }
}
// Drive API
async function api(path, options = {}, details = false) {
  if (!token || Date.now() >= expiry) {
    token = '';
    throw new Error('Googleに再接続してください。端末の変更は残っています。');
  }
  const url = new URL(
    path.startsWith('https://') ? path : 'https://www.googleapis.com/drive/v3/' + path,
  );
  if (
    url.origin !== 'https://www.googleapis.com' ||
    !/^\/(?:upload\/)?drive\/v3\//.test(url.pathname)
  )
    throw new Error('許可されていない接続先です。');
  const response = await fetch(url.href, {
    ...options,
    headers: { Authorization: 'Bearer ' + token, ...options.headers },
    signal: AbortSignal.timeout(60000),
    redirect: 'error',
    credentials: 'omit',
    referrerPolicy: 'no-referrer',
  });
  if (!response.ok) {
    if (response.status === 401) token = '';
    const error = new Error(
      response.status === 401
        ? 'Googleに再接続してください。'
        : `Driveとの通信に失敗しました（${response.status}）。端末の変更は残っています。`,
    );
    error.status = response.status;
    throw error;
  }
  const parsed = await readBoundedJSON(response);
  if (url.searchParams.get('alt') === 'media') {
    scanBytes += parsed.size;
    if (scanBytes > 100 * 1024 * 1024)
      throw new Error(
        '履歴の読込が100MBを超えました。同期を停止します。履歴は削除せず整理対応を依頼してください。',
      );
  }
  return details ? { value: parsed.value, etag: response.headers.get('etag') } : parsed.value;
}
async function list(q) {
  let result = [],
    pageToken;
  do {
    const params = new URLSearchParams({
      q,
      fields: 'nextPageToken,files(id,name,appProperties,version)',
      pageSize: '1000',
    });
    if (pageToken) params.set('pageToken', pageToken);
    const page = await api('files?' + params);
    result.push(...page.files);
    if (result.length > 500)
      throw new Error(
        'Drive履歴が500件を超えています。同期を停止します。履歴の整理対応が必要です。',
      );
    pageToken = page.nextPageToken;
  } while (pageToken);
  return result;
}
async function getFolder() {
  if (folder) return folder;
  const folders = await list(
    "trashed = false and mimeType = 'application/vnd.google-apps.folder' and appProperties has { key='syukatsu' and value='v1' }",
  );
  if (folders.length > 1)
    throw new Error(
      '就活OSフォルダが複数見つかりました。手動削除せず、整理対応を依頼してください。同期を停止します。',
    );
  if (folders.length) return (folder = folders[0].id);
  const f = await api('files', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      name: '就活OS',
      mimeType: 'application/vnd.google-apps.folder',
      appProperties: { syukatsu: 'v1' },
    }),
  });
  return (folder = f.id);
}
// 添付本体を含む持ち運び可能なJSON
async function encode(local) {
  const data = {};
  for (const name of stores)
    data[name] = local[name].map((x) => ({ ...x })).sort((a, b) => a.id.localeCompare(b.id));
  let total = 0;
  for (const f of data.files) {
    total += f.blob.size;
    if (total > LIMIT * 0.7)
      throw new Error('添付が大きすぎます。今回の同期上限はJSON合計20MBです。');
    f.base64 = await new Promise((resolve, reject) => {
      const r = new FileReader();
      r.onload = () => resolve(r.result.split(',')[1]);
      r.onerror = reject;
      r.readAsDataURL(f.blob);
    });
    delete f.blob;
  }
  return data;
}
function decode(doc) {
  validate(doc);
  const data = structuredClone(doc.data);
  for (const f of data.files) {
    const bytes = Uint8Array.from(atob(f.base64), (c) => c.charCodeAt(0));
    f.blob = new Blob([bytes], { type: f.type });
    f.size = bytes.length;
    delete f.base64;
  }
  return data;
}
async function readHeads() {
  scanBytes = 0;
  const id = await getFolder();
  const files = await list(
    `'${id}' in parents and trashed = false and appProperties has { key='syukatsuSnapshot' and value='v1' }`,
  );
  const docs = [];
  for (const f of files)
    docs.push(validate(await api(`files/${encodeURIComponent(f.id)}?alt=media`)));
  historyDocs = docs;
  return headsOf(docs);
}
async function upload(doc) {
  validate(doc);
  const body = JSON.stringify(doc);
  if (new Blob([body]).size > LIMIT)
    throw new Error('同期データが20MBを超えています。端末データは保存済みです。');
  const boundary = 'syukatsu_' + uid();
  const metadata = {
    name: '記録_' + doc.savedAt.replace(/[:.]/g, '-') + '_' + doc.id + '.json',
    parents: [await getFolder()],
    appProperties: { syukatsuSnapshot: 'v1' },
  };
  await api('https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart', {
    method: 'POST',
    headers: { 'Content-Type': 'multipart/related; boundary=' + boundary },
    body: new Blob([
      `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n`,
      JSON.stringify(metadata),
      `\r\n--${boundary}\r\nContent-Type: application/json\r\n\r\n`,
      body,
      `\r\n--${boundary}--`,
    ]),
  });
}
// 共通履歴から各項目の変更を統合する
const headKey = (heads) =>
  heads
    .map((x) => x.id)
    .sort()
    .join('|');
async function setConflict(local, heads, base, choices = {}) {
  const signature = headKey(heads);
  if (conflict?.signature === signature && conflict.revision === local.state.revision)
    choices = conflict.choices;
  const merged = mergeRecords(base, heads, choices);
  conflict = {
    heads,
    base,
    choices,
    pending: merged.conflicts,
    signature,
    revision: local.state.revision,
  };
  startMode = false;
  notify(
    '競合あり',
    `${merged.conflicts.length}件の項目で選択が必要です。他の変更は統合されます。`,
  );
  if (!panel.open && !document.querySelector('#modal').open) {
    renderPanel();
    panel.showModal();
  }
}
async function legacyPerform() {
  let local = await snapshot();
  if (local.state.owner && local.state.owner !== owner)
    throw new Error('別のGoogleアカウントのため同期できません。');
  let heads = await readHeads();
  if (!heads.length && local.state.base?.length)
    throw new Error('Driveの履歴が見つかりません。履歴を削除せず確認してください。');
  // 送信成功直後に通信が切れた場合は、同じ変更を再送しない。
  const accepted = historyDocs.find((x) => x.id === local.state.revision);
  if (accepted) {
    if (!(await syncUpdate(local.state.revision, { base: [accepted.id], dirty: false, owner }))) {
      schedule();
      return;
    }
    local = await snapshot();
  }
  const dirty =
    local.state.dirty || (!local.state.owner && stores.some((name) => local[name].length));
  if (dirty) {
    const doc = {
      format: 'syukatsu-drive',
      version: 1,
      id: local.state.revision === 'initial' ? uid() : local.state.revision,
      parents: local.state.base || [],
      savedAt: new Date().toISOString(),
      device: thisDevice(),
      data: await encode(local),
    };
    await upload(doc);
    if (!(await syncUpdate(local.state.revision, { base: [doc.id], dirty: false, owner }))) {
      const current = await snapshot();
      await syncUpdate(current.state.revision, { base: [doc.id], owner });
      schedule();
      return;
    }
    local = await snapshot();
    heads = await readHeads();
  }
  if (!heads.length) {
    await syncUpdate(local.state.revision, { owner });
    await reportCompletion();
    return;
  }
  if (heads.length === 1) {
    const doc = heads[0];
    if (headKey(heads) !== (local.state.base || []).slice().sort().join('|')) {
      if (document.querySelector('#modal').open) {
        notify('受信待ち', '編集中の画面を閉じると最新情報を読み込みます。');
        return;
      }
      if (
        !(await syncUpdate(
          local.state.revision,
          { base: [doc.id], dirty: false, owner, revision: uid() },
          decode(doc),
        ))
      ) {
        schedule();
        return;
      }
      window.dispatchEvent(new Event('drive-data'));
    }
    await legacyFinishSync(doc);
    return;
  }
  const base = commonBase(historyDocs, heads),
    merged = mergeRecords(base, heads);
  if (merged.conflicts.length) {
    await setConflict(local, heads, base);
    return;
  }
  if (document.querySelector('#modal').open) {
    notify('受信待ち', '編集中の画面を閉じると変更を統合します。');
    return;
  }
  await saveMerge(local, heads, merged.data);
}
// 全分岐を親とする新しい履歴を作る。元の履歴は削除しない。
async function saveMerge(local, heads, data) {
  const doc = {
    format: 'syukatsu-drive',
    version: 1,
    id: uid(),
    parents: heads.map((x) => x.id),
    savedAt: new Date().toISOString(),
    device: thisDevice(),
    data,
  };
  const replacement = decode(doc);
  await upload(doc);
  if (
    !(await syncUpdate(
      local.state.revision,
      { base: [doc.id], dirty: false, owner, revision: uid() },
      replacement,
    ))
  ) {
    schedule();
    return;
  }
  conflict = null;
  window.dispatchEvent(new Event('drive-data'));
  await legacyFinishSync(doc);
}
async function legacyFinishSync(doc) {
  const latest = await snapshot();
  if (latest.state.dirty) {
    schedule();
    return;
  }
  const heads = await readHeads();
  if (heads.length !== 1 || heads[0].id !== doc.id) {
    schedule();
    return;
  }
  try {
    {
      // 別端末の遅れた書込も次の同期で修復するため、毎回メタデータを確認する。
      await publishNotes(doc);
      const after = await readHeads();
      if (after.length !== 1 || after[0].id !== doc.id) {
        schedule();
        return;
      }
      await syncUpdate(latest.state.revision, { notesRevision: doc.id });
    }
  } catch (error) {
    const now = await snapshot();
    if (now.state.dirty) {
      schedule();
      return;
    }
    conflict = null;
    notify(
      token ? '同期済み' : '再接続が必要',
      '記録はDriveに保存済みですが、企業別ノートは未更新です。' + error.message,
    );
    return;
  }
  await reportCompletion();
}
async function reportCompletion() {
  const latest = await snapshot();
  if (latest.state.dirty) {
    schedule();
    return;
  }
  conflict = null;
  notify('同期済み', new Date().toLocaleTimeString('ja-JP') + ' に確認しました。');
}
// 選択中にデータが変わった場合、選択を使い回さず再確認する。
async function resolveConflict() {
  if (navigator.locks) return navigator.locks.request('syukatsu-drive', resolveConflictLocked);
  return resolveConflictLocked();
}
async function resolveConflictLocked() {
  if (busy || !conflict) return;
  if (conflict.mode === 'v2') return resolveV2();
  if (conflict.pending.some((item) => !Object.hasOwn(conflict.choices, item.key))) {
    notify('競合あり', '各項目について、残す内容を選んでください。');
    return;
  }
  busy = true;
  notify('統合中', '選択した内容を確認して保存しています。');
  try {
    const local = await snapshot(),
      heads = await readHeads();
    if (local.state.revision !== conflict.revision || headKey(heads) !== conflict.signature)
      throw new Error('選択中に新しい変更がありました。「今すぐ同期」して選び直してください。');
    const merged = mergeRecords(conflict.base, heads, conflict.choices);
    if (merged.conflicts.length) {
      await setConflict(local, heads, conflict.base, conflict.choices);
      return;
    }
    await saveMerge(local, heads, merged.data);
  } catch (e) {
    notify('同期を確認', e.message);
  } finally {
    busy = false;
    if (panel.open) renderPanel();
  }
}
// 閲覧用テキストは同期原本から一方向に生成する
async function publishNotes(doc) {
  const root = await getFolder();
  const folders = await list(
    `'${root}' in parents and trashed = false and appProperties has { key='syukatsuNotesFolder' and value='v1' }`,
  );
  let notesFolder = folders.sort((a, b) => a.id.localeCompare(b.id))[0]?.id;
  if (!notesFolder) {
    const created = await api('files', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: '企業別ノート（閲覧用）',
        mimeType: 'application/vnd.google-apps.folder',
        parents: [root],
        appProperties: { syukatsuNotesFolder: 'v1' },
      }),
    });
    notesFolder = created.id;
  }
  const files = await list(
    `'${notesFolder}' in parents and trashed = false and appProperties has { key='syukatsuCompanyNote' and value='v1' }`,
  );
  const active = new Set(doc.data.companies.map((c) => c.id));
  for (const c of doc.data.companies) {
    const text = companyNote(c, doc.data),
      hash = Array.from(
        new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text))),
      )
        .map((x) => x.toString(16).padStart(2, '0'))
        .join('');
    const existing = files.filter((f) => f.appProperties?.companyId === c.id);
    const metadata = {
      name: noteName(c),
      appProperties: {
        syukatsuCompanyNote: 'v1',
        companyId: c.id,
        contentHash: hash,
        state: 'active',
      },
    };
    if (existing.length) {
      for (const f of existing)
        if (f.appProperties?.contentHash !== hash || f.name !== metadata.name)
          await writeNote(f.id, metadata, text);
    } else await writeNote(null, { ...metadata, parents: [notesFolder] }, text);
  }
  for (const f of files)
    if (!active.has(f.appProperties?.companyId) && f.appProperties?.state !== 'deleted') {
      await writeNote(
        f.id,
        { name: '[削除済み] ' + f.name, appProperties: { ...f.appProperties, state: 'deleted' } },
        'この企業は就活OSから削除されました。\n過去の内容は同期履歴JSONに残っています。\nこのファイルは閲覧用で、編集してもアプリには反映されません。\n',
      );
    }
}
async function writeNote(id, metadata, text) {
  const boundary = 'note_' + uid();
  await api(
    'https://www.googleapis.com/upload/drive/v3/files' +
      (id ? '/' + encodeURIComponent(id) : '') +
      '?uploadType=multipart',
    {
      method: id ? 'PATCH' : 'POST',
      headers: { 'Content-Type': 'multipart/related; boundary=' + boundary },
      body: new Blob([
        `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n`,
        JSON.stringify({ ...metadata, mimeType: 'text/plain' }),
        `\r\n--${boundary}\r\nContent-Type: text/plain; charset=UTF-8\r\n\r\n`,
        text,
        `\r\n--${boundary}--`,
      ]),
    },
  );
}
// 移行・同期・バックアップの進行表示（画面を閉じても処理は継続）
const operationBanner = document.createElement('div');
operationBanner.className = 'sync-operation';
operationBanner.hidden = true;
operationBanner.setAttribute('role', 'status');
document.body.append(operationBanner);
function operation(label, detail) {
  operationBanner.hidden = false;
  operationBanner.textContent = label + '：' + detail;
  notify(label, detail);
}
window.addEventListener('beforeunload', (e) => {
  if (!operationBanner.hidden) {
    e.preventDefault();
    e.returnValue = '';
  }
});
const blank = () => ({ companies: [], progress: [], events: [], files: [] });
async function storeV2() {
  if (!backend) backend = new DriveStore(api, await getFolder(), thisDevice(), operation);
  backend.device = thisDevice();
  return backend;
}
// v1の端末が保持していた共通基準を読み、オフライン中の変更も比較に含める。
async function localBase(local) {
  if (local.state.v2Base) return local.state.v2Base;
  if (!local.state.base?.length) return blank();
  await readHeads();
  const matches = local.state.base.map((id) => historyDocs.find((doc) => doc.id === id));
  if (matches.some((x) => !x))
    throw new Error(
      'この端末の旧同期基準が見つかりません。端末データと旧履歴を残して確認してください。',
    );
  if (matches.length === 1) return matches[0].data;
  const result = mergeRecords(commonBase(historyDocs, matches), matches);
  if (result.conflicts.length)
    throw new Error('旧同期基準に未解決の競合があります。移行前の記録を確認してください。');
  return result.data;
}
function v2Heads(local, remote, encoded) {
  return [
    documentOf(encoded, thisDevice()),
    documentOf(remote.data, { id: 'remote', name: 'Drive（別端末）' }),
  ].map((doc, i) => ({
    ...doc,
    id: i ? 'remote' : 'local',
    ...(i ? { devices: remote.devices } : {}),
  }));
}
function showV2Conflict(local, remote, base, heads, choices = {}) {
  if (
    conflict?.mode === 'v2' &&
    conflict.signature === remote.signature &&
    conflict.revision === local.state.revision
  )
    choices = conflict.choices;
  const merged = mergeRecords(base, heads, choices);
  for (const item of merged.conflicts)
    for (const variant of item.variants)
      variant.sources = variant.sources.map((source) => {
        const companyId =
          item.store === 'companies'
            ? item.id
            : source.data[item.store]?.find((x) => x.id === item.id)?.companyId;
        return { ...source, device: source.devices?.[companyId] || source.device };
      });
  conflict = {
    mode: 'v2',
    pending: merged.conflicts,
    choices,
    signature: remote.signature,
    revision: local.state.revision,
    base,
    heads,
  };
  startMode = false;
  notify(
    '競合あり',
    `${merged.conflicts.length}件の項目を確認してください。他の変更は自動で統合します。`,
  );
  if (!panel.open && !document.querySelector('#modal').open) {
    renderPanel();
    panel.showModal();
  }
}
async function perform() {
  scanBytes = 0;
  const store = await storeV2();
  if (!(await store.control())) {
    await legacyPerform();
    if (conflict) return;
    const source = await snapshot();
    if (source.state.dirty) {
      queued = true;
      return;
    }
    if (document.querySelector('#modal').open) {
      notify('移行待ち', '編集中の画面を閉じると企業別保存への移行を開始します。');
      return;
    }
    const seed = await encode(source);
    scanBytes = 0;
    await store.initialize(seed);
  }
  scanBytes = 0;
  const local = await snapshot();
  if (local.state.owner && local.state.owner !== owner)
    throw new Error('別のGoogleアカウントでは同期できません。');
  const remote = await store.load(),
    base = await localBase(local),
    encoded = await encode(local),
    heads = v2Heads(local, remote, encoded);
  backupEntries = remote.control.value.backups;
  const merged = mergeRecords(base, heads);
  if (merged.conflicts.length) {
    showV2Conflict(local, remote, base, heads);
    return;
  }
  if (document.querySelector('#modal').open) {
    notify('受信待ち', '編集中の画面を閉じると同期します。端末への保存は続けられます。');
    return;
  }
  await commitV2(local, remote, merged.data, encoded);
}
async function commitV2(local, remote, data, encoded) {
  // 添付の実体は削除しない。過去のバックアップからの復元時も参照だけを戻す。
  const ids = new Set(data.files.map((f) => f.id));
  data.files.push(...remote.data.files.filter((f) => !ids.has(f.id)));
  const replacement = decode(documentOf(data, thisDevice()));
  if ((await snapshot()).state.revision !== local.state.revision) throw new Changed();
  const store = await storeV2();
  await store.save(remote, data);
  if (document.querySelector('#modal').open) {
    notify('受信待ち', '編集中の画面を閉じると同期した内容を適用します。');
    return;
  }
  const patch = { v2Base: data, v2Control: store.controlId, dirty: false, owner, revision: uid() };
  const applied = await syncUpdate(local.state.revision, patch, replacement);
  if (!applied) {
    // 送信中の追加編集を、今送った内容の上に載せ直す。衝突時は次回の選択画面へ。
    const current = await snapshot(),
      currentData = await encode(current);
    const rebased = mergeRecords(encoded, [
      { ...documentOf(currentData, thisDevice()), id: 'local' },
      { ...documentOf(data, thisDevice()), id: 'remote' },
    ]);
    if (!rebased.conflicts.length)
      await syncUpdate(
        current.state.revision,
        { ...patch, dirty: true, revision: uid() },
        decode(documentOf(rebased.data, thisDevice())),
      );
    throw new Changed();
  }
  conflict = null;
  if (stable(encoded) !== stable(data)) window.dispatchEvent(new Event('drive-data'));
  scanBytes = 0;
  const confirmed = await store.load();
  if (stable(confirmed.data) !== stable(data)) {
    queued = true;
    return;
  }
  // 旧版同様の閲覧用ノートも、変更された企業だけ更新する。
  let noteWarning = '';
  try {
    await publishNotes(documentOf(confirmed.data, thisDevice()));
  } catch (e) {
    noteWarning = '企業別ノートは未更新です：' + e.message;
  }
  let backupWarning = '',
    backupCreated = false;
  try {
    backupCreated = await store.backup(confirmed);
    await store.cleanup();
  } catch (e) {
    if (e.retry) throw e;
    backupWarning = 'バックアップ確認は未完了です：' + e.message;
  }
  const currentControl = await store.control();
  backupEntries = currentControl.value.backups;
  if ((await snapshot()).state.dirty) {
    queued = true;
    return;
  }
  notify(
    backupWarning ? '同期済み・バックアップ要確認' : '同期済み',
    [
      new Date().toLocaleTimeString('ja-JP') + ' に同期しました。',
      backupCreated ? '全体バックアップが完了しました。' : '',
      noteWarning,
      backupWarning,
    ]
      .filter(Boolean)
      .join('\n'),
  );
}
async function resolveV2() {
  if (conflict.pending.some((item) => !Object.hasOwn(conflict.choices, item.key))) {
    notify('競合あり', '各項目について残す内容を選んでください。');
    return;
  }
  busy = true;
  notify('統合中', '選択を確認して保存しています。');
  try {
    scanBytes = 0;
    const local = await snapshot(),
      remote = await (await storeV2()).load();
    if (local.state.revision !== conflict.revision || remote.signature !== conflict.signature)
      throw new Error('選択中に更新がありました。「今すぐ同期」から選び直してください。');
    const encoded = await encode(local),
      heads = v2Heads(local, remote, encoded),
      merged = mergeRecords(conflict.base, heads, conflict.choices);
    if (merged.conflicts.length) {
      showV2Conflict(local, remote, conflict.base, heads, conflict.choices);
      return;
    }
    await commitV2(local, remote, merged.data, encoded);
  } catch (e) {
    notify('同期を確認', e.message);
    if (e.retry) queued = true;
  } finally {
    busy = false;
    operationBanner.hidden = true;
    if (panel.open) renderPanel();
    if (queued) {
      queued = false;
      setTimeout(run, 500);
    }
  }
}
// バックアップの一覧・内容確認・復元。復元前にも全体を保存する。
function backupMarkup() {
  if (!backupEntries.length) return '';
  const ordered = [...backupEntries].sort((a, b) => b.savedAt.localeCompare(a.savedAt));
  if (backupPreview)
    return `<section class="backup-panel"><h3>バックアップを復元</h3><p>${escape(new Date(backupPreview.entry.savedAt).toLocaleString('ja-JP'))}</p><p>企業 ${backupPreview.doc.data.companies.length}件・進捗 ${backupPreview.doc.data.progress.length}件・予定 ${backupPreview.doc.data.events.length}件</p><p class="note">現在の全体をバックアップしてから、この内容に戻します。復元結果は他の端末にも同期されます。Googleカレンダーの予定は変更しません。</p><button id="backup-restore" ${busy ? 'disabled' : ''}>この内容に復元する</button><button id="backup-cancel" ${busy ? 'disabled' : ''}>戻る</button></section>`;
  return `<section class="backup-panel"><h3>全体バックアップ</h3><p>次回の目安：${escape(new Date(Date.parse(ordered[0].savedAt) + WEEK).toLocaleDateString('ja-JP'))}</p><p class="muted">前回の成功から7日後、接続・同期できたときに作成します。30日を超えた分はゴミ箱へ移します。</p>${ordered.map((b) => `<div class="row"><span>${escape(new Date(b.savedAt).toLocaleString('ja-JP'))}</span><button data-backup="${escape(b.fileId)}" ${busy || !token ? 'disabled' : ''}>内容・復元</button></div>`).join('')}</section>`;
}
function bindBackups() {
  panel.querySelectorAll('[data-backup]').forEach(
    (b) =>
      (b.onclick = () =>
        backupTask(async () => {
          scanBytes = 0;
          const entry = backupEntries.find((x) => x.fileId === b.dataset.backup);
          backupPreview = { entry, doc: await (await storeV2()).readBackup(entry) };
        })),
  );
  const cancel = panel.querySelector('#backup-cancel');
  if (cancel)
    cancel.onclick = () => {
      backupPreview = null;
      renderPanel();
    };
  const restore = panel.querySelector('#backup-restore');
  if (restore)
    restore.onclick = () => {
      if (
        !confirm(
          '現在の記録をバックアップした後、選んだ日時の内容に戻します。復元結果を他の端末にも反映します。実行しますか？',
        )
      )
        return;
      backupTask(async () => {
        if (conflict) throw new Error('先に競合を解決してください。');
        scanBytes = 0;
        const store = await storeV2(),
          local = await snapshot(),
          remote = await store.load();
        if (local.state.dirty || stable(await encode(local)) !== stable(remote.data))
          throw new Error('先に「今すぐ同期」を完了してください。');
        const doc = await store.readBackup(backupPreview.entry);
        await store.backup(remote, { force: true, reason: 'before-restore' });
        // バックアップ作成中に他端末の企業が変わった場合は改めて確認する。
        const after = await store.load();
        if (stable(after.data) !== stable(remote.data))
          throw new Error('別端末の変更が届きました。同期してから復元をやり直してください。');
        if (document.querySelector('#modal').open)
          throw new Error('編集中の画面を閉じてから復元してください。');
        const restored = structuredClone(doc.data),
          ids = new Set(doc.data.files.map((f) => f.id));
        restored.files.push(...remote.data.files.filter((f) => !ids.has(f.id)));
        if (
          !(await syncUpdate(
            local.state.revision,
            { v2Base: remote.data, dirty: true, revision: uid() },
            decode(documentOf(restored, thisDevice())),
          ))
        )
          throw new Error('復元中に編集がありました。現在の変更を残して中止しました。');
        backupPreview = null;
        window.dispatchEvent(new Event('drive-data'));
        queued = true;
        notify('復元を保存中', '復元した内容をDriveへ同期しています。');
      });
    };
}
async function backupTask(fn) {
  const task = async () => {
    if (busy) return;
    busy = true;
    if (panel.open) renderPanel();
    try {
      await fn();
    } catch (e) {
      notify('バックアップを確認', e.message);
    } finally {
      busy = false;
      operationBanner.hidden = true;
      if (panel.open) renderPanel();
      if (queued) {
        queued = false;
        setTimeout(run, 0);
      }
    }
  };
  if (navigator.locks) await navigator.locks.request('syukatsu-drive', task);
  else await task();
}
async function run() {
  if (!token) return;
  if (busy) {
    queued = true;
    return;
  }
  if (!navigator.onLine) {
    notify('オフライン', '変更は端末に保存されています。');
    return;
  }
  busy = true;
  notify('同期中');
  try {
    if (navigator.locks) await navigator.locks.request('syukatsu-drive', perform);
    else await perform();
    retryCount = 0;
  } catch (e) {
    if (e.retry && retryCount++ < 3) {
      queued = true;
      notify('再確認中', e.message);
    } else notify(token ? '同期エラー' : '再接続が必要', e.message);
  } finally {
    busy = false;
    operationBanner.hidden = true;
    if (panel.open) renderPanel();
    if (queued) {
      queued = false;
      clearTimeout(timer);
      timer = setTimeout(run, 500);
    }
  }
}
function schedule() {
  clearTimeout(timer);
  notify(token ? '未同期' : '未接続', '端末には保存済みです。Driveへ送信します。');
  timer = setTimeout(run, 0);
}
window.addEventListener('local-change', schedule);
window.addEventListener('online', run);
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') run();
});
setInterval(() => {
  if (document.visibilityState === 'visible') run();
}, 10000);

// 起動時の再接続案内（認証操作はユーザーのタップで開始）
function renderStartup() {
  const configured = localStorage.getItem('drive-client-id') || '';
  panel.innerHTML = `${connectionStarted ? '<div class="startup-dismiss"><button id="startup-close" aria-label="閉じて接続を続ける">✕</button></div>' : ''}<div class="startup-connect"><p class="eyebrow">就活OS</p><h2>最新の記録で始める</h2><p>Google Driveに接続して、別の端末の変更を読み込みます。</p><input id="drive-client" type="hidden" value="${escape(configured)}"><p class="muted">${escape(message || 'Googleへの接続を準備しています。')}</p><button class="primary" id="startup-connect" ${busy || authPending || !window.google?.accounts?.oauth2 ? 'disabled' : ''}>Googleで続ける</button><button id="startup-local">${authPending || busy || token ? '閉じてアプリを使う' : '端末の記録で使う'}</button><button class="back" id="startup-settings">接続設定</button><p class="muted">${authPending || busy || token ? '閉じても接続・同期は続きます。進み具合は右上のDrive表示で確認できます。' : '自動接続にはGoogleの許可が必要です。未接続の間は端末だけに保存します。'}</p></div>`;
  panel.querySelector('#startup-connect').onclick = connect;
  const close = panel.querySelector('#startup-close');
  if (close)
    close.onclick = () => {
      startMode = false;
      panel.close();
    };
  panel.querySelector('#startup-local').onclick = () => {
    startMode = false;
    panel.close();
    if (!authPending && !busy && !token)
      notify('未接続', '端末の記録で使用中です。同期するにはDriveに接続してください。');
  };
  panel.querySelector('#startup-settings').onclick = () => {
    startMode = false;
    renderPanel();
  };
}
panel.addEventListener('cancel', () => {
  startMode = false;
});
queueMicrotask(() => {
  if (!localStorage.getItem('drive-client-id')) return;
  startMode = true;
  renderPanel();
  panel.showModal();
  loadGoogle()
    .then(() => {
      if (startMode) notify('未接続', '「Googleで続ける」を押してください。');
    })
    .catch((e) => notify('未接続', e.message));
});
