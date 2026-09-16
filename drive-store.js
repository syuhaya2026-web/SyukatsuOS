// 企業単位の保存・条件付き更新・週次バックアップ。認証と画面は呼び出し側が担当する。
import { stable } from './merge.js';
import { validate, MAX_SNAPSHOT_BYTES } from './data-validation.js';
export const WEEK = 7 * 24 * 60 * 60 * 1000;
export const RETENTION = 30 * 24 * 60 * 60 * 1000;
const empty = () => ({ companies: [], progress: [], events: [], files: [] });
const safeId = (id) => typeof id === 'string' && /^[a-zA-Z0-9_-]{1,200}$/.test(id);
const check = (value, message) => {
  if (!value) throw new Error(message);
};
export class Changed extends Error {
  constructor() {
    super('別の更新が届きました。読み直して統合します。');
    this.retry = true;
  }
}
export const documentOf = (data, device, now = Date.now()) => ({
  format: 'syukatsu-drive',
  version: 1,
  id: crypto.randomUUID(),
  parents: [],
  savedAt: new Date(now).toISOString(),
  device,
  data,
});
export async function digest(value) {
  return [
    ...new Uint8Array(
      await crypto.subtle.digest('SHA-256', new TextEncoder().encode(stable(value))),
    ),
  ]
    .map((x) => x.toString(16).padStart(2, '0'))
    .join('');
}
export function companyData(data, id) {
  return {
    companies: data.companies.filter((x) => x.id === id),
    progress: data.progress.filter((x) => x.companyId === id),
    events: data.events.filter((x) => x.companyId === id),
    files: [],
  };
}
const fileName = (name) =>
  String(name)
    .replace(/[\\/\u0000-\u001f]/g, '_')
    .slice(0, 80);
const revisionKey = (files) =>
  files
    .map((f) => `${f.id}:${f.version}`)
    .sort()
    .join('|');
export class DriveStore {
  constructor(api, root, device, onProgress = () => {}) {
    this.api = api;
    this.root = root;
    this.device = device;
    this.onProgress = onProgress;
    this.cache = new Map();
    this.controlId = '';
  }
  async meta(id, allowTrashed = false) {
    check(safeId(id), 'DriveのファイルIDが不正です。');
    const r = await this.api(`files/${id}?fields=id,name,appProperties,version,trashed`, {}, true);
    check(
      r.etag && !r.etag.startsWith('W/'),
      '安全な上書きに必要な情報をDriveから取得できません。元のデータは残したまま処理を停止しました。',
    );
    check(
      allowTrashed || !r.value.trashed,
      '同期ファイルがゴミ箱に移動されています。Driveで元に戻してください。',
    );
    return { ...r.value, etag: r.etag };
  }
  async list(q) {
    let token,
      result = [];
    do {
      const p = new URLSearchParams({
        q,
        fields: 'nextPageToken,files(id,name,appProperties,version,createdTime)',
        pageSize: '1000',
      });
      if (token) p.set('pageToken', token);
      const r = await this.api('files?' + p);
      result.push(...r.files);
      token = r.nextPageToken;
      check(result.length <= 10000, '保存ファイルが多すぎるため同期を停止しました。');
    } while (token);
    return result;
  }
  async listed(folder, key) {
    return this.list(
      `'${folder}' in parents and trashed = false and appProperties has { key='${key}' and value='v2' }`,
    );
  }
  async legacyKey() {
    return revisionKey(
      await this.list(
        `'${this.root}' in parents and trashed = false and appProperties has { key='syukatsuSnapshot' and value='v1' }`,
      ),
    );
  }
  async generated() {
    const r = await this.api('files/generateIds?count=1&space=drive&type=files');
    check(safeId(r.ids?.[0]), 'ファイルIDを取得できませんでした。');
    return r.ids[0];
  }
  async jsonWrite(id, value, metadata, etag) {
    const text = JSON.stringify(value, null, 2);
    check(new Blob([text]).size <= MAX_SNAPSHOT_BYTES, '保存データが20MiBを超えています。');
    const boundary = 'syukatsu_' + crypto.randomUUID();
    try {
      return await this.api(
        'https://www.googleapis.com/upload/drive/v3/files' +
          (etag ? '/' + id : '') +
          '?uploadType=multipart',
        {
          method: etag ? 'PATCH' : 'POST',
          headers: {
            'Content-Type': 'multipart/related; boundary=' + boundary,
            ...(etag ? { 'If-Match': etag } : {}),
          },
          body: new Blob([
            `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n`,
            JSON.stringify({ ...metadata, ...(!etag ? { id } : {}), mimeType: 'application/json' }),
            `\r\n--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n`,
            text,
            `\r\n--${boundary}--`,
          ]),
        },
      );
    } catch (e) {
      if (e.status === 412) throw new Changed();
      throw e;
    }
  }
  async patch(id, value, etag) {
    try {
      return await this.api('files/' + id, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', 'If-Match': etag },
        body: JSON.stringify(value),
      });
    } catch (e) {
      if (e.status === 412) throw new Changed();
      throw e;
    }
  }
  async read(id, listedVersion) {
    const cached = this.cache.get(id);
    if (cached && listedVersion && cached.meta.version === listedVersion) return cached;
    const before = await this.meta(id);
    if (cached && cached.meta.etag === before.etag) return cached;
    const value = await this.api(`files/${id}?alt=media`);
    const after = await this.meta(id);
    if (before.etag !== after.etag) throw new Changed();
    const result = { value, meta: after };
    this.cache.set(id, result);
    return result;
  }
  async control() {
    const root = await this.meta(this.root);
    const id = root.appProperties?.syukatsuV2;
    if (!id) return null;
    this.controlId = id;
    const result = await this.read(id);
    const c = result.value;
    check(
      c.format === 'syukatsu-index' &&
        c.version === 2 &&
        Array.isArray(c.companies) &&
        Array.isArray(c.files) &&
        Array.isArray(c.backups),
      '新しい同期管理ファイルの形式が不正です。',
    );
    for (const key of ['companiesFolder', 'filesFolder', 'backupsFolder'])
      check(safeId(c[key]), '保存フォルダ情報が不正です。');
    for (const group of [c.companies, c.files]) {
      const ids = new Set(),
        driveIds = new Set();
      for (const x of group) {
        check(
          safeId(x.id) && safeId(x.fileId) && !ids.has(x.id) && !driveIds.has(x.fileId),
          '保存一覧のIDが重複・不正です。',
        );
        ids.add(x.id);
        driveIds.add(x.fileId);
      }
    }
    check(
      !c.garbage || (Array.isArray(c.garbage) && c.garbage.every(safeId)),
      '整理待ち一覧が不正です。',
    );
    for (const b of c.backups)
      check(
        safeId(b.fileId) && Number.isFinite(Date.parse(b.savedAt)) && /^[a-f0-9]{64}$/.test(b.hash),
        'バックアップ一覧が不正です。',
      );
    return result;
  }
  async updateControl(current, next) {
    await this.jsonWrite(this.controlId, next, { name: '同期管理.json' }, current.meta.etag);
    this.cache.delete(this.controlId);
  }
  async folder(name) {
    const id = await this.generated();
    await this.api('files', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        id,
        name,
        mimeType: 'application/vnd.google-apps.folder',
        parents: [this.root],
      }),
    });
    return id;
  }
  // 実アカウント上でも条件付き書込を検査する。対応していなければ既存データを移行しない。
  async verifyConditionalWrites(id, value) {
    const before = await this.meta(id);
    let rejected = false;
    try {
      await this.jsonWrite(id, value, { name: '同期管理.json' }, '"syukatsu-invalid-etag"');
    } catch (e) {
      if (e.retry) rejected = true;
      else throw e;
    }
    check(
      rejected,
      'Driveが安全な条件付き更新を受け付けません。旧データは残したまま移行を停止しました。',
    );
    await this.jsonWrite(
      id,
      { ...value, probe: crypto.randomUUID() },
      { name: '同期管理.json' },
      before.etag,
    );
    let staleRejected = false;
    try {
      await this.jsonWrite(
        id,
        { ...value, probe: crypto.randomUUID() },
        { name: '同期管理.json' },
        before.etag,
      );
    } catch (e) {
      if (e.retry) staleRejected = true;
      else throw e;
    }
    check(staleRejected, '同時更新の保護を確認できません。移行は完了していません。');
    const root = await this.meta(this.root);
    let rootRejected = false;
    try {
      await this.patch(this.root, { name: root.name }, '"syukatsu-invalid-etag"');
    } catch (e) {
      if (e.retry) rootRejected = true;
      else throw e;
    }
    check(rootRejected, 'フォルダの同時更新を保護できません。移行を停止しました。');
  }
  async initialize(data) {
    const existing = await this.control();
    if (existing) return existing;
    validate(documentOf(data, this.device));
    const root = await this.meta(this.root),
      legacyKey = await this.legacyKey();
    this.onProgress(
      '移行中',
      '企業ごとの保存を準備しています。完了までアプリを閉じないでください。',
    );
    const seedHash = await digest(data),
      storageKey = 'drive-v2-prepare-' + this.root;
    let id = this.pendingId || globalThis.localStorage?.getItem(storageKey),
      control;
    if (id) {
      try {
        control = (await this.read(id)).value;
      } catch (e) {
        if (e.status !== 404) throw e;
        id = null;
      }
    }
    if (control?.seedHash !== seedHash) {
      id = null;
      control = null;
    }
    if (!id) {
      id = await this.generated();
      this.pendingId = id;
      globalThis.localStorage?.setItem(storageKey, id);
      control = {
        format: 'syukatsu-index',
        version: 2,
        companies: [],
        files: [],
        backups: [],
        legacyKey,
        seedHash,
        createdAt: new Date().toISOString(),
      };
      try {
        await this.jsonWrite(id, control, {
          name: '同期管理_準備中.json',
          parents: [this.root],
          appProperties: { syukatsuControl: 'v2' },
        });
      } catch (e) {
        if (e.status !== 409) throw e;
      }
    }
    const checkpoint = async () => {
      const m = await this.meta(id);
      await this.jsonWrite(id, control, { name: '同期管理_準備中.json' }, m.etag);
      this.cache.delete(id);
    };
    await this.verifyConditionalWrites(id, control);
    for (const [key, name] of [
      ['companiesFolder', '企業データ'],
      ['filesFolder', '添付データ'],
      ['backupsFolder', '全体バックアップ'],
    ])
      if (!control[key]) {
        control[key] = await this.folder(name);
        await checkpoint();
      }
    for (const f of data.files) {
      if (control.files.some((x) => x.id === f.id)) continue;
      const fileId = await this.generated();
      await this.jsonWrite(
        fileId,
        { format: 'syukatsu-file', version: 2, file: f },
        {
          name: fileName(f.name) + '__' + f.id + '.json',
          parents: [control.filesFolder],
          appProperties: { syukatsuAttachment: 'v2' },
        },
      );
      control.files.push({ id: f.id, fileId });
      await checkpoint();
    }
    for (const c of data.companies) {
      if (control.companies.some((x) => x.id === c.id)) continue;
      const fileId = await this.generated();
      await this.jsonWrite(fileId, this.bundle(data, c.id), {
        name: fileName(c.name) + '__' + c.id + '.json',
        parents: [control.companiesFolder],
        appProperties: { syukatsuCompany: 'v2' },
      });
      control.companies.push({ id: c.id, fileId });
      await checkpoint();
    }
    // 初回の全体バックアップを確認できた後にだけ、利用中の保存先を切り替える。
    if (!control.backups.length) {
      control.backups.push(await this.createBackup(data, control, 'migration'));
      await checkpoint();
    } else await this.readBackup(control.backups[0]);
    delete control.probe;
    const current = await this.meta(id);
    await this.jsonWrite(id, control, { name: '同期管理.json' }, current.etag);
    if ((await this.legacyKey()) !== legacyKey) throw new Changed();
    const currentRoot = await this.meta(this.root);
    if (currentRoot.appProperties?.syukatsuV2) return this.control();
    try {
      await this.patch(
        this.root,
        { appProperties: { ...(currentRoot.appProperties || {}), syukatsuV2: id } },
        currentRoot.etag,
      );
    } catch (e) {
      if (e.retry && (await this.control())) return this.control();
      throw e;
    }
    this.controlId = id;
    this.pendingId = null;
    globalThis.localStorage?.removeItem(storageKey);
    return this.control();
  }
  bundle(data, id) {
    return {
      format: 'syukatsu-company',
      version: 2,
      id,
      revision: crypto.randomUUID(),
      savedAt: new Date().toISOString(),
      device: this.device,
      deleted: !data.companies.some((c) => c.id === id),
      data: companyData(data, id),
    };
  }
  async scan(control) {
    const [companies, files] = await Promise.all([
      this.listed(control.companiesFolder, 'syukatsuCompany'),
      this.listed(control.filesFolder, 'syukatsuAttachment'),
    ]);
    return { companies, files, key: revisionKey([...companies, ...files]) };
  }
  async load() {
    const control = await this.control();
    check(control, '新しい保存先が見つかりません。');
    check(
      (await this.legacyKey()) === control.value.legacyKey,
      '旧版のアプリから更新が届いています。データ保護のため停止しました。全端末を更新し、旧履歴を消さずに移行対応を依頼してください。',
    );
    const scan = await this.scan(control.value),
      data = empty(),
      records = new Map(),
      devices = {};
    for (const entry of control.value.files) {
      const listed = scan.files.find((f) => f.id === entry.fileId);
      check(listed, '添付データの一部が見つかりません。Driveのゴミ箱を確認してください。');
      const record = await this.read(entry.fileId, listed.version);
      check(
        record.value.format === 'syukatsu-file' &&
          record.value.version === 2 &&
          record.value.file?.id === entry.id,
        '添付データが不正です。',
      );
      data.files.push(record.value.file);
      records.set(entry.fileId, record);
    }
    for (const entry of control.value.companies) {
      const listed = scan.companies.find((f) => f.id === entry.fileId);
      check(listed, '企業データの一部が見つかりません。Driveのゴミ箱を確認してください。');
      const record = await this.read(entry.fileId, listed.version),
        v = record.value;
      check(
        v.format === 'syukatsu-company' &&
          v.version === 2 &&
          v.id === entry.id &&
          typeof v.deleted === 'boolean' &&
          v.data &&
          Array.isArray(v.data.companies) &&
          Array.isArray(v.data.progress) &&
          Array.isArray(v.data.events) &&
          Array.isArray(v.data.files) &&
          v.data.files.length === 0,
        '企業ファイルの形式が不正です。',
      );
      check(
        v.deleted
          ? !v.data.companies.length && !v.data.progress.length && !v.data.events.length
          : v.data.companies.length === 1 &&
              v.data.companies[0].id === entry.id &&
              [...v.data.progress, ...v.data.events].every((x) => x.companyId === entry.id),
        '企業ファイル内の参照が不正です。',
      );
      validate({ ...documentOf({ ...v.data, files: data.files }, v.device), savedAt: v.savedAt });
      for (const key of ['companies', 'progress', 'events']) data[key].push(...v.data[key]);
      records.set(entry.fileId, record);
      devices[entry.id] = v.device;
    }
    for (const rows of Object.values(data)) rows.sort((a, b) => a.id.localeCompare(b.id));
    validate(documentOf(data, this.device));
    check(
      new Blob([JSON.stringify(data)]).size <= MAX_SNAPSHOT_BYTES,
      'データ全体が20MiBを超えています。',
    );
    const end = await this.scan(control.value),
      endControl = await this.meta(this.controlId);
    if (end.key !== scan.key || endControl.etag !== control.meta.etag) throw new Changed();
    return { data, control, records, devices, signature: control.meta.etag + '|' + scan.key };
  }
  // 送信済みの別項目は保持。途中で412になった場合は呼出元が全体を読み直す。
  async save(remote, data) {
    validate(documentOf(data, this.device));
    let control = remote.control;
    for (const file of data.files) {
      const old = remote.data.files.find((x) => x.id === file.id);
      if (old) {
        check(
          stable(old) === stable(file),
          '保存済み添付の内容が変更されています。新しい添付として追加してください。',
        );
        continue;
      }
      const fileId = await this.generated();
      await this.jsonWrite(
        fileId,
        { format: 'syukatsu-file', version: 2, file },
        {
          name: fileName(file.name) + '__' + file.id + '.json',
          parents: [control.value.filesFolder],
          appProperties: { syukatsuAttachment: 'v2' },
        },
      );
      await this.updateControl(control, {
        ...control.value,
        files: [...control.value.files, { id: file.id, fileId }],
      });
      control = await this.control();
    }
    const ids = [
      ...new Set([...remote.data.companies.map((c) => c.id), ...data.companies.map((c) => c.id)]),
    ];
    for (const id of ids) {
      const before = companyData(remote.data, id),
        after = companyData(data, id);
      if (stable(before) === stable(after)) continue;
      const slot = control.value.companies.find((x) => x.id === id),
        company = data.companies.find((x) => x.id === id),
        name = (company ? fileName(company.name) : '[削除済み]') + '__' + id + '.json',
        value = this.bundle(data, id);
      if (slot) {
        const original = remote.records.get(slot.fileId);
        if (!original) throw new Changed();
        await this.jsonWrite(slot.fileId, value, { name }, original.meta.etag);
        this.cache.delete(slot.fileId);
      } else {
        const fileId = await this.generated();
        await this.jsonWrite(fileId, value, {
          name,
          parents: [control.value.companiesFolder],
          appProperties: { syukatsuCompany: 'v2' },
        });
        await this.updateControl(control, {
          ...control.value,
          companies: [...control.value.companies, { id, fileId }],
        });
        control = await this.control();
      }
    }
  }
  async createBackup(data, control, reason, now = Date.now()) {
    const doc = documentOf(data, this.device, now);
    validate(doc);
    const fileId = await this.generated(),
      hash = await digest(doc);
    await this.jsonWrite(fileId, doc, {
      name: '全体_' + doc.savedAt.replace(/[:.]/g, '-') + '.json',
      parents: [control.backupsFolder],
      appProperties: { syukatsuBackup: 'v2' },
    });
    const read = await this.read(fileId);
    validate(read.value);
    check(
      (await digest(read.value)) === hash,
      'バックアップの保存内容を確認できません。古いバックアップは残しています。',
    );
    return { fileId, hash, savedAt: doc.savedAt, reason, companies: data.companies.length };
  }
  async backup(remote, { force = false, reason = 'weekly', now = Date.now() } = {}) {
    let control = await this.control();
    const last = [...control.value.backups].sort((a, b) => b.savedAt.localeCompare(a.savedAt))[0];
    if (!force && last && now - Date.parse(last.savedAt) < WEEK) return false;
    // 他端末から未反映の更新が入った場合、古い読込結果では作成しない。
    const fresh = await this.load();
    if (fresh.signature !== remote.signature) throw new Changed();
    this.onProgress(
      'バックアップ中',
      '全体を保存しています。完了するまでアプリを閉じないでください。',
    );
    const entry = await this.createBackup(fresh.data, control.value, reason, now);
    for (let attempt = 0; attempt < 4; attempt++) {
      control = await this.control();
      const newest = [...control.value.backups].sort((a, b) =>
        b.savedAt.localeCompare(a.savedAt),
      )[0];
      if (!force && newest && now - Date.parse(newest.savedAt) < WEEK) {
        await this.trash(entry.fileId);
        return false;
      }
      check(
        !control.value.garbage?.includes(entry.fileId),
        '整理済みのバックアップは再登録できません。やり直してください。',
      );
      await this.readBackup(entry);
      try {
        await this.updateControl(control, {
          ...control.value,
          backups: [...control.value.backups, entry],
        });
        await this.cleanup(now);
        return true;
      } catch (e) {
        if (!e.retry) throw e;
      }
    }
    throw new Changed();
  }
  async readBackup(entry) {
    const r = await this.read(entry.fileId);
    check(
      r.meta.appProperties?.syukatsuBackup === 'v2',
      'バックアップ以外のファイルを参照しています。',
    );
    validate(r.value);
    check(
      (await digest(r.value)) === entry.hash,
      'バックアップの内容が変更されています。復元を中止しました。',
    );
    return r.value;
  }
  async trash(id) {
    const m = await this.meta(id, true);
    check(m.appProperties?.syukatsuBackup === 'v2', 'バックアップ以外のファイルは整理しません。');
    if (!m.trashed) await this.patch(id, { trashed: true }, m.etag);
    this.cache.delete(id);
  }
  async cleanup(now = Date.now()) {
    let control = await this.control();
    const ordered = [...control.value.backups].sort((a, b) => b.savedAt.localeCompare(a.savedAt));
    if (!ordered.length) return;
    await this.readBackup(ordered[0]);
    const expired = ordered.slice(1).filter((x) => now - Date.parse(x.savedAt) > RETENTION);
    const candidates = await this.listed(control.value.backupsFolder, 'syukatsuBackup');
    const unregistered = candidates.filter(
      (f) =>
        !ordered.some((b) => b.fileId === f.id) &&
        Number.isFinite(Date.parse(f.createdTime)) &&
        now - Date.parse(f.createdTime) > RETENTION,
    );
    const garbage = [
      ...new Set([
        ...(control.value.garbage || []),
        ...expired.map((x) => x.fileId),
        ...unregistered.map((x) => x.id),
      ]),
    ];
    if (!garbage.length) return;
    check(
      !garbage.includes(ordered[0].fileId),
      '最後の正常なバックアップは削除しません。整理待ち一覧を確認してください。',
    );
    const retained = ordered.filter((x) => !garbage.includes(x.fileId));
    check(retained.length > 0, '最後のバックアップは整理しません。');
    await this.updateControl(control, { ...control.value, backups: retained, garbage });
    // 整理待ちIDを先に記録する。中断されても次の起動時に続きから処理する。
    const completed = [];
    for (const id of garbage) {
      try {
        await this.trash(id);
        completed.push(id);
      } catch (e) {
        if (e.status === 404) completed.push(id);
        else throw e;
      }
    }
    control = await this.control();
    await this.updateControl(control, {
      ...control.value,
      garbage: (control.value.garbage || []).filter((id) => !completed.includes(id)),
    });
  }
}
