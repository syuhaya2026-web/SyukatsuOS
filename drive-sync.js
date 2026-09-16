import { commonBase, mergeRecords, deviceLabel } from './merge.js';
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
  scriptReady;
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
let startMode = false;
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
  panel.innerHTML = `<div class="row"><h2>Google Drive同期</h2><button id="drive-close" aria-label="閉じる">✕</button></div><p>${escape(status)}</p><p class="info muted">${escape(message)}</p>${conflictMarkup()}<label>この端末の名前<input id="drive-device" maxlength="80" value="${escape(thisDevice().name)}"></label><label>OAuthクライアントID<input id="drive-client" value="${escape(localStorage.getItem('drive-client-id') || '')}" placeholder="…apps.googleusercontent.com" ${token ? 'disabled' : ''}></label><p class="note">接続中は保存後と30秒ごとに同期します。別項目は自動統合し、同じ項目の変更だけ選択します。再起動・認証切れ後は接続操作が必要です。</p><div class="actions"><button id="drive-connect" ${token || busy || authPending ? 'disabled' : ''}>Googleに接続</button><button id="drive-now" ${!token || busy ? 'disabled' : ''}>今すぐ同期</button><button id="drive-disconnect" ${!token || busy ? 'disabled' : ''}>接続を解除</button></div><p class="muted">Driveの「企業別ノート」は閲覧用です。編集はアプリから行ってください。添付込み20MB上限・履歴の自動削除なし。</p>`;
  panel.querySelector('#drive-close').onclick = () => panel.close();
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
async function api(path, options = {}) {
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
    throw new Error(
      response.status === 401
        ? 'Googleに再接続してください。'
        : `Driveとの通信に失敗しました（${response.status}）。端末の変更は残っています。`,
    );
  }
  const parsed = await readBoundedJSON(response);
  if (url.searchParams.get('alt') === 'media') {
    scanBytes += parsed.size;
    if (scanBytes > 100 * 1024 * 1024)
      throw new Error(
        '履歴の読込が100MBを超えました。同期を停止します。履歴は削除せず整理対応を依頼してください。',
      );
  }
  return parsed.value;
}
async function list(q) {
  let result = [],
    pageToken;
  do {
    const params = new URLSearchParams({
      q,
      fields: 'nextPageToken,files(id,name,appProperties)',
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
  for (const name of stores) data[name] = local[name].map((x) => ({ ...x }));
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
async function perform() {
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
    await finishSync(doc);
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
  await finishSync(doc);
}
async function finishSync(doc) {
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
async function run() {
  if (busy || !token) return;
  if (!navigator.onLine) {
    notify('オフライン', '変更は端末に保存されています。');
    return;
  }
  busy = true;
  notify('同期中');
  try {
    if (navigator.locks) await navigator.locks.request('syukatsu-drive', perform);
    else await perform();
  } catch (e) {
    notify(token ? '同期エラー' : '再接続が必要', e.message);
  } finally {
    busy = false;
    if (panel.open) renderPanel();
  }
}
function schedule() {
  clearTimeout(timer);
  notify(token ? '未同期' : '未接続', '端末には保存済みです。Driveへの反映を待っています。');
  timer = setTimeout(run, 3000);
}
window.addEventListener('local-change', schedule);
window.addEventListener('online', run);
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') run();
});
setInterval(() => {
  if (document.visibilityState === 'visible') run();
}, 30000);

// 起動時の再接続案内（認証操作はユーザーのタップで開始）
function renderStartup() {
  const configured = localStorage.getItem('drive-client-id') || '';
  panel.innerHTML = `<div class="startup-connect"><p class="eyebrow">就活OS</p><h2>最新の記録で始める</h2><p>Google Driveに接続して、別の端末の変更を読み込みます。</p><input id="drive-client" type="hidden" value="${escape(configured)}"><p class="muted">${escape(message || 'Googleへの接続を準備しています。')}</p><button class="primary" id="startup-connect" ${busy || authPending || !window.google?.accounts?.oauth2 ? 'disabled' : ''}>Googleで続ける</button><button id="startup-local">端末の記録で使う</button><button class="back" id="startup-settings">接続設定</button><p class="muted">自動接続にはGoogleの許可が必要です。端末の記録で使う場合、Driveとの同期は行いません。</p></div>`;
  panel.querySelector('#startup-connect').onclick = connect;
  panel.querySelector('#startup-local').onclick = () => {
    startMode = false;
    panel.close();
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
