import { snapshot, syncUpdate, stores, uid } from './db.js';
// Google Drive接続・同期状態（アクセストークンはメモリのみ）
const SCOPE = 'https://www.googleapis.com/auth/drive.file';
import { validate, headsOf, readBoundedJSON, MAX_SNAPSHOT_BYTES } from './data-validation.js';
export { validate, headsOf };
const LIMIT = MAX_SNAPSHOT_BYTES;
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
// 接続設定画面
function renderPanel() {
  if (startMode) {
    renderStartup();
    return;
  }
  panel.innerHTML = `<div class="row"><h2>Google Drive同期</h2><button id="drive-close" aria-label="閉じる">✕</button></div><p>${escape(status)}</p><p class="info muted">${escape(message)}</p><label>OAuthクライアントID<input id="drive-client" value="${escape(localStorage.getItem('drive-client-id') || '')}" placeholder="…apps.googleusercontent.com" ${token ? 'disabled' : ''}></label><p class="note">記録・添付を自分のDriveの「就活OS」に保存します。接続中は変更後と30秒ごとに同期します。再起動・認証切れの後は「接続」が必要です。接続前の端末データも同期対象になります。</p>${conflict ? `<label>使用するデータ<select id="drive-choice"><option value="local">この端末のデータ</option>${conflict.heads.map((x) => `<option value="${escape(x.id)}">Drive：${escape(x.savedAt)} / ${x.data.companies.length}企業</option>`).join('')}</select></label><p class="note">両方に変更があります。選んだ内容で現在のデータ全体を置き換えます。選ばなかった内容もDriveに履歴として残します。</p><button id="drive-resolve">選んだ内容で統一する</button>` : ''}<div class="actions"><button id="drive-connect" ${token || busy || authPending ? 'disabled' : ''}>Googleに接続</button><button id="drive-now" ${!token || busy ? 'disabled' : ''}>今すぐ同期</button><button id="drive-disconnect" ${!token || busy ? 'disabled' : ''}>接続を解除</button></div><p class="muted">1回の同期は添付を含むJSONで20MBまで。履歴は自動削除しません。通信中にアプリを閉じると、次の接続まで未同期になります。</p>`;
  panel.querySelector('#drive-close').onclick = () => panel.close();
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
  if (conflict) panel.querySelector('#drive-resolve').onclick = resolveConflict;
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
      fields: 'nextPageToken,files(id,name)',
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
// 新旧の関係で判定し、同時編集を黙って上書きしない
async function perform() {
  const local = await snapshot();
  if (local.state.owner && local.state.owner !== owner)
    throw new Error('別のGoogleアカウントのため同期できません。');
  const heads = await readHeads(),
    base = local.state.base || [],
    same = heads.length === base.length && heads.every((x) => base.includes(x.id));
  const empty = stores.every((name) => local[name].length === 0);
  const dirty = local.state.dirty || (!local.state.owner && !empty);
  if (heads.length === 1 && heads[0].id === local.state.revision) {
    await syncUpdate(local.state.revision, { base: [heads[0].id], dirty: false, owner });
    await reportCompletion();
    return;
  }
  if ((heads.length > 1 && !same) || (!same && heads.length && dirty)) {
    conflict = { heads, revision: local.state.revision };
    notify('競合あり', '同期を止めました。Driveボタンから使用する内容を選んでください。');
    return;
  }
  if (!heads.length && base.length)
    throw new Error('Driveの履歴が見つかりません。フォルダの削除・変更を確認してください。');
  if (!dirty && heads.length && !same) {
    const remote = heads[0];
    if (document.querySelector('#modal').open) {
      notify('受信待ち', '編集中の画面を閉じると最新情報を読み込みます。');
      return;
    }
    if (
      await syncUpdate(
        local.state.revision,
        { base: [remote.id], dirty: false, owner, revision: uid() },
        decode(remote),
      )
    )
      window.dispatchEvent(new Event('drive-data'));
    else schedule();
  } else if (dirty) {
    const doc = {
      format: 'syukatsu-drive',
      version: 1,
      id: local.state.revision === 'initial' ? uid() : local.state.revision,
      parents: base,
      savedAt: new Date().toISOString(),
      data: await encode(local),
    };
    await upload(doc);
    if (
      !(await syncUpdate(local.state.revision, {
        base: [doc.id],
        dirty: false,
        owner,
      }))
    ) {
      const latest = await snapshot();
      await syncUpdate(latest.state.revision, { base: [doc.id], owner });
      schedule();
    }
    const after = await readHeads();
    if (after.length > 1) {
      conflict = { heads: after, revision: (await snapshot()).state.revision };
      notify('競合あり', '別の端末でも編集されました。使用する内容を選んでください。');
      return;
    }
  } else await syncUpdate(local.state.revision, { owner });
  await reportCompletion();
}
// 保存中の追加編集を「同期済み」と誤表示しない
async function reportCompletion() {
  const latest = await snapshot();
  if (latest.state.dirty) {
    schedule();
    return;
  }
  conflict = null;
  notify('同期済み', new Date().toLocaleTimeString('ja-JP') + ' に確認しました。');
}
// 競合解消も新しい履歴として残す
async function resolveConflict() {
  if (navigator.locks) return navigator.locks.request('syukatsu-drive', resolveConflictLocked);
  return resolveConflictLocked();
}
async function resolveConflictLocked() {
  if (busy || !conflict) return;
  const choice = panel.querySelector('#drive-choice').value;
  if (!confirm('選んだ内容で現在のデータ全体を置き換えます。続けますか？')) return;
  busy = true;
  try {
    let heads = await readHeads();
    if (
      heads
        .map((x) => x.id)
        .sort()
        .join() !==
      conflict.heads
        .map((x) => x.id)
        .sort()
        .join()
    )
      throw new Error('Driveに新しい変更があります。今すぐ同期して選び直してください。');
    const local = await snapshot();
    if (local.state.revision !== conflict.revision)
      throw new Error('端末に新しい変更があります。今すぐ同期して選び直してください。');
    const chosen = heads.find((x) => x.id === choice);
    if (choice !== 'local' && !chosen) throw new Error('選択内容が見つかりません。');
    const own = choice === 'local' ? local : decode(chosen);
    if (choice !== 'local') {
      const rescue = {
        format: 'syukatsu-drive',
        version: 1,
        id: uid(),
        parents: local.state.base || [],
        savedAt: new Date().toISOString(),
        data: await encode(local),
      };
      await upload(rescue);
      const before = heads;
      heads = await readHeads();
      const expected = new Set([
        ...before.map((x) => x.id).filter((x) => !rescue.parents.includes(x)),
        rescue.id,
      ]);
      if (heads.length !== expected.size || heads.some((x) => !expected.has(x.id)))
        throw new Error(
          '競合確認中に別端末が更新しました。今すぐ同期して選び直してください。端末データは変更していません。',
        );
    }
    if (
      !(await syncUpdate(
        local.state.revision,
        { dirty: true, base: heads.map((x) => x.id), owner, revision: uid() },
        own,
      ))
    )
      throw new Error('編集中の変更があるため中止しました。');
    conflict = null;
    window.dispatchEvent(new Event('drive-data'));
  } catch (e) {
    notify('同期を確認', e.message);
  } finally {
    busy = false;
    if (panel.open) renderPanel();
  }
  if (!conflict) setTimeout(run, 0);
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
