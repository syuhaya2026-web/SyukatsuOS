import { all, write, put, remove, uid } from './db.js';
// 画面要素
const app = document.querySelector('#app'),
  modal = document.querySelector('#modal'),
  content = document.querySelector('#modal-content');
// 画面の状態
let data = {},
  query = '',
  sort = 'priority',
  toastTimer;
// HTMLエスケープ
const esc = (v) =>
  String(v ?? '').replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c],
  );
// 日付の表示
const localDate = (date = new Date()) =>
  `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
const dateLabel = (value) =>
  value
    ? new Date(value.length === 10 ? value + 'T00:00' : value).toLocaleString('ja-JP', {
        month: 'numeric',
        day: 'numeric',
        weekday: 'short',
        ...(value.length > 10 ? { hour: '2-digit', minute: '2-digit' } : {}),
      })
    : '日付未設定';
// 外部リンク
const safeURL = (value) => {
  try {
    const url = new URL(value);
    return ['https:', 'http:'].includes(url.protocol) ? url.href : '';
  } catch {
    return '';
  }
};
const link = (url, label) =>
  safeURL(url)
    ? /* HTML */ `<a
        class="button"
        href="${esc(safeURL(url))}"
        target="_blank"
        rel="noopener noreferrer"
        >${label}</a
      >`
    : '';
// 企業マーク
const companyMark = (c) => {
  const site = safeURL(c.companyUrl),
    url = safeURL(c.logoUrl) || (site ? new URL('/favicon.ico', site).href : '');
  return /* HTML */ `<span class="company-mark" aria-hidden="true"
    ><span>${esc(Array.from(c.name)[0] || '？')}</span>${url
      ? /* HTML */ `<img src="${esc(url)}" alt="" loading="lazy" referrerpolicy="no-referrer" />`
      : ''}</span
  >`;
};
document.addEventListener(
  'error',
  (e) => {
    if (e.target.matches?.('.company-mark img')) e.target.remove();
  },
  true,
);
document.addEventListener(
  'load',
  (e) => {
    if (e.target.matches?.('.company-mark img')) e.target.classList.add('loaded');
  },
  true,
);
// 現在の選考ステータス
const current = (c) => data.progress.find((p) => p.id === c.currentStatusId)?.title || '未設定';
const status = (c) => {
  const t = current(c),
    color = /最終/.test(t)
      ? 'red'
      : /面接/.test(t)
        ? 'orange'
        : /ES|応募|選考中/.test(t)
          ? 'blue'
          : /不合格|終了|辞退/.test(t)
            ? 'gray'
            : '';
  return /* HTML */ `<span class="status ${color}">${esc(t)}</span>`;
};
// 直近の予定と表示順
const nextEvent = (c) =>
  data.events
    .filter((e) => e.companyId === c.id && e.date.slice(0, 10) >= localDate())
    .sort((a, b) => a.date.localeCompare(b.date))[0];
const eventRank = (c) => {
  const e = nextEvent(c);
  if (!e) return 3;
  const days =
    (new Date(e.date.slice(0, 10) + 'T00:00') - new Date(localDate() + 'T00:00')) / 86400000;
  return days === 0 ? 0 : days <= 7 ? 1 : 2;
};
// 保存結果の通知
function toast(message) {
  const el = document.querySelector('#toast');
  el.textContent = message;
  el.style.display = 'block';
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (el.style.display = 'none'), 4000);
}
// 端末データの読み込み
async function refresh() {
  for (const name of ['companies', 'progress', 'events', 'files']) data[name] = await all(name);
  render();
}
// データの保存
async function commit(ops) {
  await write(ops);
  await refresh();
}
// 画面ルーティング
const route = () => location.hash.slice(1).split('/').map(decodeURIComponent);
function render() {
  const [id, section, progressId] = route(),
    c = data.companies.find((c) => c.id === id);
  if (c && section === 'progress') {
    const p = data.progress.find((p) => p.id === progressId && p.companyId === id);
    if (p) {
      viewProgress(p);
      return;
    }
    history.replaceState(null, '', '#' + c.id);
  }
  c ? renderDetail(c) : renderHome();
}
// 操作アイコン
const icon = (name) =>
  /* HTML */ `<svg
    width="19"
    height="19"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    stroke-width="1.7"
    stroke-linecap="round"
    stroke-linejoin="round"
    aria-hidden="true"
  >
    ${name === 'search'
      ? '<circle cx="10.5" cy="10.5" r="6.5"/><path d="m16 16 4 4"/>'
      : name === 'sort'
        ? '<path d="M8 4v16m-4-4 4 4 4-4M16 20V4m-4 4 4-4 4 4"/>'
        : '<path d="M12 5v14M5 12h14"/>'}
  </svg>`;
// ホーム画面
function renderHome() {
  const today = data.events.filter((e) => e.date.slice(0, 10) === localDate()).length;
  app.innerHTML = /* HTML */ `<div class="stats">
      <span><strong>${data.companies.length}</strong>登録企業</span
      ><span><strong>${today}</strong>今日の予定</span
      ><span><strong>${data.progress.length}</strong>進捗の記録</span>
    </div>
    <div class="row list-heading">
      <h2>企業一覧</h2>
      <div class="list-actions">
        <button
          id="search-toggle"
          class="icon-button"
          aria-label="企業を検索"
          title="企業を検索"
          aria-controls="search-panel"
          aria-expanded="${!!query}"
        >
          ${icon('search')}
        </button>
        <div class="sort-control">
          <button
            id="sort-toggle"
            class="icon-button ${sort !== 'priority' ? 'active' : ''}"
            aria-label="並び替え"
            title="並び替え"
            aria-controls="sort-menu"
            aria-expanded="false"
          >
            ${icon('sort')}
          </button>
          <div id="sort-menu" class="sort-menu" hidden>
            ${[
              ['priority', '予定が近い順'],
              ['name', '名前順'],
              ['updated', '更新順'],
              ['status', 'ステータス順'],
            ]
              .map(
                ([value, label]) =>
                  /* HTML */ `<button data-sort="${value}" aria-pressed="${sort === value}">
                    ${label}<span>${sort === value ? '✓' : ''}</span>
                  </button>`,
              )
              .join('')}
          </div>
        </div>
        <button
          class="icon-button primary"
          data-action="add-company"
          aria-label="企業を追加"
          title="企業を追加"
        >
          ${icon('plus')}
        </button>
      </div>
    </div>
    <div id="search-panel" class="search-panel" ${query ? '' : 'hidden'}>
      <input
        id="search"
        type="search"
        placeholder="企業名で検索"
        aria-label="企業名で検索"
        value="${esc(query)}"
      />
    </div>
    <div id="cards" class="cards"></div>`;
  const searchToggle = document.querySelector('#search-toggle'),
    panel = document.querySelector('#search-panel'),
    search = document.querySelector('#search'),
    sortToggle = document.querySelector('#sort-toggle'),
    menu = document.querySelector('#sort-menu');
  searchToggle.onclick = () => {
    panel.hidden = !panel.hidden;
    searchToggle.setAttribute('aria-expanded', String(!panel.hidden));
    if (!panel.hidden) search.focus();
    else {
      query = '';
      search.value = '';
      renderCards();
    }
  };
  search.oninput = (e) => {
    query = e.target.value;
    renderCards();
  };
  search.onkeydown = (e) => {
    if (e.key === 'Escape') {
      searchToggle.click();
      searchToggle.focus();
    }
  };
  sortToggle.onclick = () => {
    menu.hidden = !menu.hidden;
    sortToggle.setAttribute('aria-expanded', String(!menu.hidden));
    if (!menu.hidden) menu.querySelector('button').focus();
  };
  menu.onclick = (e) => {
    const button = e.target.closest('[data-sort]');
    if (!button) return;
    sort = button.dataset.sort;
    menu.querySelectorAll('button').forEach((b) => {
      b.setAttribute('aria-pressed', String(b.dataset.sort === sort));
      b.querySelector('span').textContent = b.dataset.sort === sort ? '✓' : '';
    });
    menu.hidden = true;
    sortToggle.setAttribute('aria-expanded', 'false');
    sortToggle.classList.toggle('active', sort !== 'priority');
    sortToggle.focus();
    renderCards();
  };
  menu.onkeydown = (e) => {
    if (e.key === 'Escape') {
      menu.hidden = true;
      sortToggle.setAttribute('aria-expanded', 'false');
      sortToggle.focus();
    }
  };
  renderCards();
}
document.addEventListener('click', (e) => {
  const menu = document.querySelector('#sort-menu');
  if (menu && !e.target.closest('.sort-control')) {
    menu.hidden = true;
    document.querySelector('#sort-toggle').setAttribute('aria-expanded', 'false');
  }
});
// 企業カード一覧
function renderCards() {
  const companies = data.companies
    .filter((c) => c.name.toLocaleLowerCase().includes(query.toLocaleLowerCase()))
    .sort((a, b) =>
      sort === 'name'
        ? a.name.localeCompare(b.name, 'ja')
        : sort === 'status'
          ? current(a).localeCompare(current(b), 'ja')
          : sort === 'updated'
            ? b.updatedAt.localeCompare(a.updatedAt)
            : eventRank(a) - eventRank(b) ||
              (nextEvent(a)?.date || '9999').localeCompare(nextEvent(b)?.date || '9999') ||
              b.updatedAt.localeCompare(a.updatedAt),
    );
  document.querySelector('#cards').innerHTML =
    companies
      .map((c) => {
        const e = nextEvent(c),
          rank = eventRank(c);
        return /* HTML */ `<article class="card">
          <button
            class="card-main"
            data-action="open-company"
            data-id="${c.id}"
            aria-label="${esc(c.name)}の詳細"
          >
            ${status(c)}${rank < 2
              ? /* HTML */ `<span class="badge ${rank === 0 ? 'today' : ''}"
                  >${rank === 0 ? '今日のイベント' : '近日のイベント'}</span
                >`
              : ''}
            <h2 class="company-name">${companyMark(c)}<span>${esc(c.name)}</span></h2>
            <div class="next">
              ${e ? `${dateLabel(e.date)}　${esc(e.title)}` : '次回の予定はまだありません'}
            </div></button
          >${link(c.myPageUrl, 'My Page')}
        </article>`;
      })
      .join('') ||
    '<div class="panel empty">企業が見つかりません。企業を追加して始めましょう。</div>';
}
// 企業詳細画面
function renderDetail(c) {
  const progress = data.progress
      .filter((p) => p.companyId === c.id)
      .sort((a, b) => b.date.localeCompare(a.date)),
    events = data.events
      .filter((e) => e.companyId === c.id)
      .sort((a, b) => a.date.localeCompare(b.date));
  app.innerHTML = /* HTML */ `<div class="row">
      <a href="#" class="back">← 企業一覧</a
      ><button data-action="edit-company" data-id="${c.id}">編集</button>
    </div>
    <div class="detail-header">
      ${status(c)}
      <h1 class="company-name">${companyMark(c)}<span>${esc(c.name)}</span></h1>
      <div class="row wrap" style="justify-content:flex-start">
        ${link(c.myPageUrl, 'My Page')}${link(c.companyUrl, '企業サイト')}
      </div>
    </div>
    <section class="panel section">
      <div class="row section-head">
        <h2>選考タイムライン</h2>
        <button data-action="add-progress" data-id="${c.id}">＋ 進捗を追加</button>
      </div>
      <div class="timeline">
        ${progress
          .map(
            (p) =>
              /* HTML */ `<button class="progress" data-action="view-progress" data-id="${p.id}">
                <strong>${esc(p.title)}</strong
                ><small
                  >${dateLabel(p.date)}${p.attachmentIds.length
                    ? ' · 添付 ' + p.attachmentIds.length + ' 件'
                    : ''}${p.id === c.currentStatusId ? ' · 現在のステータス' : ''}</small
                >
              </button>`,
          )
          .join('') || '<div class="empty">最初の進捗を記録しましょう。</div>'}
      </div>
    </section>
    <section class="panel section">
      <div class="row section-head">
        <h2>予定・イベント</h2>
        <button data-action="add-event" data-id="${c.id}">＋ 予定を追加</button>
      </div>
      ${events
        .map(
          (e) =>
            /* HTML */ `<div class="event-row row">
              <button data-action="edit-event" data-id="${e.id}">
                <span
                  ><strong>${esc(e.title)}</strong><br /><span class="muted"
                    >${dateLabel(e.date)}${e.date.slice(0, 10) < localDate()
                      ? ' · 過去の予定'
                      : ''}</span
                  ></span
                >
              </button>
            </div>`,
        )
        .join('') || '<div class="empty">面接や締切などの予定を追加できます。</div>'}
    </section>
    <section class="panel section">
      <h2>企業情報・メモ</h2>
      <p class="info">${esc(c.notes) || 'メモはまだありません。'}</p>
    </section>`;
}
// 共通ダイアログ
function show(html) {
  content.innerHTML = html;
  if (!modal.open) modal.showModal();
}
// フォーム共通要素
const heading = (title) =>
  /* HTML */ `<div class="row">
    <h2>${esc(title)}</h2>
    <button type="button" data-action="close" aria-label="閉じる">✕</button>
  </div>`;
const field = (label, name, value = '', type = 'text', required = false) =>
  /* HTML */ `<label
    >${label}<input
      name="${name}"
      type="${type}"
      value="${esc(value)}"
      ${required ? 'required' : ''}
  /></label>`;
const notes = (value = '', label = 'メモ') =>
  /* HTML */ `<label>${label}<textarea name="notes">${esc(value)}</textarea></label>`;
const actions = (deleteAction, id) =>
  /* HTML */ `<div class="actions">
    ${deleteAction
      ? /* HTML */ `<button
          type="button"
          class="danger"
          data-action="${deleteAction}"
          data-id="${id}"
        >
          削除
        </button>`
      : ''}<button type="button" data-action="close">キャンセル</button
    ><button class="primary" type="submit">保存する</button>
  </div>`;
// フォーム保存処理
function formHandler(handler) {
  content.querySelector('form').onsubmit = async (e) => {
    e.preventDefault();
    const button = e.submitter;
    button.disabled = true;
    try {
      await handler(new FormData(e.target));
      modal.close();
      toast('保存しました');
    } catch (error) {
      toast('保存できませんでした：' + error.message);
      button.disabled = false;
    }
  };
}
// 企業の追加・編集
function companyForm(c) {
  show(
    heading(c ? '企業を編集' : '企業を追加') +
      /* HTML */ `<form class="form">
        ${field('企業名', 'name', c?.name, 'text', true)}<label
          >現在のステータス<select name="currentStatusId">
            <option value="">未設定</option>
            ${data.progress
              .filter((p) => p.companyId === c?.id)
              .map(
                (p) =>
                  /* HTML */ `<option
                    value="${p.id}"
                    ${p.id === c.currentStatusId ? 'selected' : ''}
                  >
                    ${esc(p.title)}（${esc(p.date)}）
                  </option>`,
              )
              .join('')}
          </select></label
        >${!c
          ? '<div class="note">企業を追加した後、進捗を登録して現在のステータスに設定できます。</div>'
          : ''}${field('マイページURL', 'myPageUrl', c?.myPageUrl, 'url')}${field(
          '企業URL',
          'companyUrl',
          c?.companyUrl,
          'url',
        )}<span class="muted">企業サイトのアイコンを自動表示します。</span>${field(
          'ロゴ画像URL（任意）',
          'logoUrl',
          c?.logoUrl,
          'url',
        )}${notes(c?.notes)}${actions(c ? 'delete-company' : null, c?.id)}
      </form>`,
  );
  formHandler(async (f) => {
    for (const name of ['myPageUrl', 'companyUrl', 'logoUrl'])
      if (f.get(name) && !safeURL(f.get(name)))
        throw new Error('URLは https:// または http:// で入力してください。');
    const name = f.get('name').trim();
    if (!name) throw new Error('企業名を入力してください。');
    await commit([
      put('companies', {
        ...c,
        id: c?.id || uid(),
        ...Object.fromEntries(f),
        name,
        createdAt: c?.createdAt || new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      }),
    ]);
  });
}
// 進捗の追加・編集
function progressForm(c, p) {
  show(
    heading(p ? '進捗を編集' : '進捗を追加') +
      /* HTML */ `<form class="form">
        ${field('タイトル', 'title', p?.title, 'text', true)}${field(
          '日付',
          'date',
          p?.date || localDate(),
          'date',
          true,
        )}${notes(p?.notes)}<label class="check"
          ><input
            type="checkbox"
            name="current"
            ${!p || c.currentStatusId === p.id ? 'checked' : ''}
          />現在のステータスにする</label
        ><label>添付ファイルを追加<input name="uploads" type="file" multiple /></label>${p
          ?.attachmentIds.length
          ? /* HTML */ `<div class="files">
              ${p.attachmentIds
                .map((id) => {
                  const f = data.files.find((f) => f.id === id);
                  return /* HTML */ `<label class="check"
                    ><input type="checkbox" name="keep" value="${id}" checked />${esc(
                      f?.name || 'ファイルが見つかりません',
                    )}</label
                  >`;
                })
                .join('')}<span class="muted"
                >チェックを外すと、この進捗から添付を解除します。</span
              >
            </div>`
          : ''}
        <div class="note">
          ファイルは共通の保存領域に保管されます。大きなファイルは端末の空き容量にご注意ください。
        </div>
        ${actions(null)}
      </form>`,
  );
  formHandler(async (f) => {
    const title = f.get('title').trim();
    if (!title) throw new Error('タイトルを入力してください。');
    const id = p?.id || uid(),
      now = new Date().toISOString(),
      ops = [],
      ids = f.getAll('keep');
    for (const file of f.getAll('uploads')) {
      if (!file.name) continue;
      const fid = uid();
      ids.push(fid);
      ops.push(
        put('files', {
          id: fid,
          name: file.name,
          type: file.type,
          size: file.size,
          createdAt: now,
          blob: file,
        }),
      );
    }
    ops.push(
      put('progress', {
        id,
        companyId: c.id,
        title,
        date: f.get('date'),
        notes: f.get('notes'),
        attachmentIds: ids,
        createdAt: p?.createdAt || now,
        updatedAt: now,
      }),
      put('companies', {
        ...c,
        currentStatusId: f.has('current') ? id : c.currentStatusId === id ? '' : c.currentStatusId,
        updatedAt: now,
      }),
    );
    await commit(ops);
  });
}
// 進捗詳細画面
function viewProgress(p) {
  const c = data.companies.find((c) => c.id === p.companyId);
  app.innerHTML = /* HTML */ `<div class="row">
      <a href="#${c.id}" class="back">← ${esc(c.name)}</a
      ><button data-action="edit-progress" data-id="${p.id}">編集</button>
    </div>
    <div class="detail-header">
      <div class="muted">${dateLabel(p.date)}</div>
      <h1>${esc(p.title)}</h1>
    </div>
    <section class="panel section">
      <h2>メモ</h2>
      <p class="info">${esc(p.notes) || 'メモはまだありません。'}</p>
    </section>
    <section class="panel section">
      <h2>添付ファイル</h2>
      <div class="files">
        ${p.attachmentIds
          .map((id) => {
            const f = data.files.find((f) => f.id === id);
            return f
              ? /* HTML */ `<div class="file">
                  <button data-action="download" data-id="${id}">↓ ${esc(f.name)}</button
                  ><span class="muted">${Math.ceil(f.size / 1024)} KB</span>
                </div>`
              : '';
          })
          .join('') || '<span class="muted">添付なし</span>'}
      </div>
    </section>
    <div class="actions section">
      <button class="danger" data-action="delete-progress" data-id="${p.id}">この進捗を削除</button>
    </div>`;
}
// 予定の追加・編集
function eventForm(c, e) {
  show(
    heading(e ? '予定を編集' : '予定を追加') +
      /* HTML */ `<form class="form">
        ${field('予定名', 'title', e?.title, 'text', true)}${field(
          '日時',
          'date',
          e?.date || localDate() + 'T10:00',
          'datetime-local',
          true,
        )}${notes(e?.notes)}${actions(e ? 'delete-event' : null, e?.id)}
      </form>`,
  );
  formHandler(async (f) => {
    const title = f.get('title').trim();
    if (!title) throw new Error('予定名を入力してください。');
    await commit([
      put('events', {
        ...e,
        id: e?.id || uid(),
        companyId: c.id,
        title,
        date: f.get('date'),
        notes: f.get('notes'),
        googleCalendarEventId: e?.googleCalendarEventId || null,
        syncStatus: e?.googleCalendarEventId ? 'pending' : 'local',
        updatedAt: new Date().toISOString(),
      }),
      put('companies', { ...c, updatedAt: new Date().toISOString() }),
    ]);
  });
}
// 削除確認と関連データの整理
async function deleteRecord(kind, id) {
  const value = data[kind].find((v) => v.id === id);
  if (!value) return;
  show(
    heading('削除の確認') +
      /* HTML */ `<p>
          ${esc(value.name || value.title)}を削除しますか？${kind === 'companies'
            ? 'この企業の進捗と予定も削除します。'
            : ''}
        </p>
        <div class="actions">
          <button data-action="close">キャンセル</button
          ><button class="danger" id="confirm-delete">削除する</button>
        </div>`,
  );
  document.querySelector('#confirm-delete').onclick = async (e) => {
    e.target.disabled = true;
    try {
      const ops = [remove(kind, id)];
      if (kind === 'companies') {
        for (const store of ['progress', 'events'])
          for (const item of data[store].filter((v) => v.companyId === id))
            ops.push(remove(store, item.id));
      } else {
        const c = data.companies.find((c) => c.id === value.companyId);
        ops.push(
          put('companies', {
            ...c,
            currentStatusId:
              kind === 'progress' && c.currentStatusId === id ? '' : c.currentStatusId,
            updatedAt: new Date().toISOString(),
          }),
        );
      }
      await commit(ops);
      modal.close();
      if (kind === 'companies') location.hash = '';
      toast('削除しました');
    } catch (error) {
      toast('削除できませんでした：' + error.message);
      e.target.disabled = false;
    }
  };
}
// ボタン操作
const handlers = {
  'add-company': () => companyForm(),
  'edit-company': (id) => companyForm(data.companies.find((c) => c.id === id)),
  'open-company': (id) => (location.hash = id),
  'add-progress': (id) => progressForm(data.companies.find((c) => c.id === id)),
  'view-progress': (id) => {
    const p = data.progress.find((p) => p.id === id);
    location.hash = p.companyId + '/progress/' + id;
  },
  'edit-progress': (id) => {
    const p = data.progress.find((p) => p.id === id);
    progressForm(
      data.companies.find((c) => c.id === p.companyId),
      p,
    );
  },
  'add-event': (id) => eventForm(data.companies.find((c) => c.id === id)),
  'edit-event': (id) => {
    const e = data.events.find((e) => e.id === id);
    eventForm(
      data.companies.find((c) => c.id === e.companyId),
      e,
    );
  },
  'delete-company': (id) => deleteRecord('companies', id),
  'delete-progress': (id) => deleteRecord('progress', id),
  'delete-event': (id) => deleteRecord('events', id),
  close: () => modal.close(),
  download: (id) => {
    const f = data.files.find((f) => f.id === id);
    const url = URL.createObjectURL(f.blob),
      a = document.createElement('a');
    a.href = url;
    a.download = f.name;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 10000);
  },
};
document.addEventListener('click', async (e) => {
  const button = e.target.closest('[data-action]');
  if (!button) return;
  try {
    await handlers[button.dataset.action]?.(button.dataset.id);
  } catch (error) {
    toast(error.message);
  }
});
// 画面遷移
window.addEventListener('hashchange', () => {
  modal.close();
  render();
  window.scrollTo(0, 0);
});
// 表示復帰と定期更新
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') refresh().catch((error) => toast(error.message));
});
setInterval(() => {
  if (!modal.open && data.companies) {
    if (document.querySelector('#cards')) renderCards();
    else render();
  }
}, 60000);
// アプリ起動
try {
  await refresh();
} catch (error) {
  app.innerHTML = /* HTML */ `<div class="panel">
    <h1>保存領域を開けませんでした</h1>
    <p>${esc(error.message)}</p>
    <p>ブラウザの設定でサイトデータの保存を許可してから再読み込みしてください。</p>
  </div>`;
}
// オフライン機能の登録
if ('serviceWorker' in navigator)
  navigator.serviceWorker
    .register('./service-worker.js')
    .catch(() =>
      toast('オフライン機能を有効にできませんでした。HTTPSまたはlocalhostで開いてください。'),
    );
