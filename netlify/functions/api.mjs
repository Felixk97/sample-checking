// Netlify Function. Needs env var ACCESS_CODE. Data lives in Netlify Blobs (no setup needed).
import { getStore } from '@netlify/blobs';

const j = (o, s = 200) =>
  new Response(JSON.stringify(o), { status: s, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' } });

export const config = { path: '/api/*' };

export default async (req) => {
  const code = Netlify.env.get('ACCESS_CODE');
  if (!code || req.headers.get('x-code') !== code) return j({ error: 'Wrong access code' }, 401);

  const url = new URL(req.url);
  const route = url.pathname.replace(/^\/api\//, '');
  const meta = getStore({ name: 'meta', consistency: 'strong' });
  const rec = getStore({ name: 'received', consistency: 'strong' }); // one blob per scanned barcode
  const body = req.method === 'POST' ? await req.json().catch(() => ({})) : {};
  const key = (b) => encodeURIComponent(b);
  const unkey = (k) => decodeURIComponent(k);

  if (route === 'list') {
    const nl = (await meta.get('namelist', { type: 'json' })) || { v: 0, people: [] };
    const { blobs } = await rec.list();
    return j({ v: nl.v, people: String(nl.v) === url.searchParams.get('v') ? undefined : nl.people, got: blobs.map((b) => unkey(b.key)) });
  }

  if (route === 'details') {
    const { blobs } = await rec.list();
    const out = {};
    await Promise.all(blobs.map(async (b) => { out[unkey(b.key)] = await rec.get(b.key, { type: 'json' }); }));
    return j(out);
  }

  if (route === 'scan') {
    const bc = String(body.barcode || '').trim();
    const device = String(body.device || '');
    const nl = await meta.get('namelist', { type: 'json' });
    const p = nl && nl.people.find((x) => x.barcode === bc);
    if (!bc || !p) return j({ status: 'unknown' });
    const t = Date.now();
    // onlyIfNew makes the first scan win, even if two phones scan at the same moment
    const r = await rec.set(key(bc), JSON.stringify({ t, d: device }), { onlyIfNew: true });
    if (r.modified) return j({ status: 'ok', name: p.name, received_at: t, device });
    const old = (await rec.get(key(bc), { type: 'json' })) || {};
    return j({ status: 'dup', name: p.name, received_at: old.t, device: old.d });
  }

  if (route === 'undo') {
    await rec.delete(key(String(body.barcode || '')));
    return j({ ok: true });
  }

  if (route === 'upload') {
    const seen = new Set(), people = [];
    for (const p of Array.isArray(body.people) ? body.people : []) {
      const bc = String(p.barcode || '').trim(), nm = String(p.name || '').trim();
      if (bc && nm && !seen.has(bc)) { seen.add(bc); people.push({ name: nm, barcode: bc }); }
    }
    if (!people.length || people.length > 5000) return j({ error: 'Namelist must have 1 to 5000 rows' }, 400);
    await meta.setJSON('namelist', { v: Date.now(), people: people.sort((a, b) => a.name.localeCompare(b.name)) });
    const { blobs } = await rec.list();
    await Promise.all(blobs.map((b) => rec.delete(b.key)));
    return j({ ok: true, count: people.length });
  }

  return j({ error: 'Not found' }, 404);
};
