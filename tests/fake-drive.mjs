export function fakeDrive({ ignoreConditions = false } = {}) {
  const files = new Map([
    [
      'root',
      {
        id: 'root',
        name: '就活OS',
        appProperties: { syukatsu: 'v1' },
        version: '1',
        createdTime: new Date().toISOString(),
      },
    ],
  ]);
  let seq = 0;
  let hook = null;
  const error = (status) => Object.assign(new Error('HTTP ' + status), { status });
  const metadata = (f) => Object.fromEntries(Object.entries(f).filter(([k]) => k !== 'body'));
  const mutate = (id, patch) => {
    const f = files.get(id);
    if (!f) throw error(404);
    Object.assign(f, patch, { version: String(Number(f.version) + 1) });
    return f;
  };
  const api = async (path, options = {}, details = false) => {
    const u = new URL(
        path.startsWith('http') ? path : 'https://www.googleapis.com/drive/v3/' + path,
      ),
      method = options.method || 'GET';
    let value,
      tag = '';
    if (u.pathname.endsWith('/generateIds')) value = { ids: ['f' + ++seq] };
    else if (u.pathname.includes('/upload/')) {
      const text = await options.body.text(),
        boundary = options.headers['Content-Type'].split('boundary=')[1],
        parts = text.split('--' + boundary),
        body = (s) => s.slice(s.indexOf('\r\n\r\n') + 4).replace(/\r\n$/, '');
      const meta = JSON.parse(body(parts[1])),
        payload = meta.mimeType === 'text/plain' ? body(parts[2]) : JSON.parse(body(parts[2]));
      const id = method === 'POST' ? meta.id || 'f' + ++seq : u.pathname.split('/').pop();
      if (method === 'POST') {
        if (files.has(id)) throw error(409);
        files.set(id, {
          ...meta,
          id,
          body: payload,
          version: '1',
          createdTime: new Date().toISOString(),
        });
      } else {
        const f = files.get(id);
        if (!f) throw error(404);
        if (!ignoreConditions && options.headers['If-Match'] !== `"${f.version}"`) throw error(412);
        mutate(id, { ...meta, body: payload });
      }
      if (hook) await hook({ id, payload, method });
      value = { id };
    } else if (u.pathname.endsWith('/files') && method === 'POST') {
      value = JSON.parse(options.body);
      if (!value.id) value.id = 'f' + ++seq;
      if (files.has(value.id)) throw error(409);
      files.set(value.id, { ...value, version: '1', createdTime: new Date().toISOString() });
    } else if (u.pathname.endsWith('/files')) {
      const q = u.searchParams.get('q') || '',
        parent = q.match(/'([^']+)' in parents/),
        prop = q.match(/key='([^']+)' and value='([^']+)'/);
      value = {
        files: [...files.values()]
          .filter(
            (f) =>
              !f.trashed &&
              (!parent || f.parents?.includes(parent[1])) &&
              (!prop || f.appProperties?.[prop[1]] === prop[2]),
          )
          .map(metadata),
      };
    } else {
      const id = u.pathname.split('/').pop(),
        f = files.get(id);
      if (!f) throw error(404);
      if (method === 'PATCH') {
        if (!ignoreConditions && options.headers['If-Match'] !== `"${f.version}"`) throw error(412);
        value = metadata(mutate(id, JSON.parse(options.body)));
      } else value = u.searchParams.get('alt') === 'media' ? f.body : metadata(f);
      tag = `"${files.get(id).version}"`;
    }
    return details ? { value: structuredClone(value), etag: tag } : structuredClone(value);
  };
  return { api, files, mutate, setHook: (f) => (hook = f) };
}
