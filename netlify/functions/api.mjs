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
  const L = decodeURIComponent(req.headers.get('x-list') || 'main').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 30) || 'main';
  const NL = L === 'main' ? 'namelist' : 'namelist-' + L; // each batch has its own namelist and tally
  const meta = getStore({ name: 'meta', consistency: 'strong' });
  const rec = getStore({ name: L === 'main' ? 'received' : 'rec-' + L, consistency: 'strong' }); // one blob per scanned barcode
  const ev = getStore({ name: L === 'main' ? 'events' : 'ev-' + L, consistency: 'strong' }); // unknown + duplicate attempts
  const body = req.method === 'POST' ? await req.json().catch(() => ({})) : {};
  const key = (b) => encodeURIComponent(b);
  const unkey = (k) => decodeURIComponent(k);

  if (route === 'list') {
    const nl = (await meta.get(NL, { type: 'json' })) || { v: 0, people: [] };
    const { blobs } = await rec.list();
    return j({ label: nl.label || '', note: nl.note || '', v: nl.v, people: String(nl.v) === url.searchParams.get('v') ? undefined : nl.people, got: blobs.map((b) => unkey(b.key)) });
  }

  if (route === 'batches') {
    const { blobs } = await meta.list({ prefix: 'namelist' });
    const out = await Promise.all(blobs.map(async (b) => {
      const nl = await meta.get(b.key, { type: 'json' });
      return { name: b.key === 'namelist' ? 'main' : b.key.replace(/^namelist-/, ''), label: (nl && nl.label) || '', note: (nl && nl.note) || '', count: (nl && nl.people.length) || 0 };
    }));
    return j({ batches: out });
  }

  if (route === 'stats') {
    const { blobs } = await ev.list();
    return j({ events: blobs.map((b) => { const [t, type, d, bc] = decodeURIComponent(b.key).split('|'); return { t: +t, type, d, b: bc }; }) });
  }

  if (route === 'details') {
    const { blobs } = await rec.list();
    const out = {};
    await Promise.all(blobs.map(async (b) => { out[unkey(b.key)] = await rec.get(b.key, { type: 'json' }); }));
    return j(out);
  }

  if (route === 'scan') {
    const bc = String(body.barcode || '').trim();
    const device = String(body.device || '').replace(/[|]/g, '').slice(0, 30);
    const now = Date.now(), t = Math.min(now, Number(body.t) || now);
    const log = (type) => ev.set(encodeURIComponent([t, type, device, bc].join('|')), '1');
    const nl = await meta.get(NL, { type: 'json' });
    const p = nl && nl.people.find((x) => x.barcode === bc);
    if (!bc || !p) { if (bc) await log('u'); return j({ status: 'unknown' }); }
    // onlyIfNew makes the first scan win, even if two phones scan at the same moment
    const r = await rec.set(key(bc), JSON.stringify({ t, d: device }), { onlyIfNew: true });
    if (r.modified) return j({ status: 'ok', name: p.name, received_at: t, device });
    await log('d');
    const old = (await rec.get(key(bc), { type: 'json' })) || {};
    return j({ status: 'dup', name: p.name, received_at: old.t, device: old.d });
  }

  if (route === 'remove') {
    const gone = new Set([].concat(body.barcodes || body.barcode || []).map(String));
    const nl = (await meta.get(NL, { type: 'json' })) || { v: 0, people: [] };
    nl.people = nl.people.filter((p) => !gone.has(p.barcode)); nl.v = Date.now();
    await meta.setJSON(NL, nl);
    await Promise.all([...gone].map((b) => rec.delete(key(b))));
    return j({ ok: true });
  }

  if (route === 'note') {
    const nl = (await meta.get(NL, { type: 'json' })) || { v: 0, people: [] };
    nl.note = String(body.note || '').trim().slice(0, 200);
    if (!nl.label && body.label) nl.label = String(body.label).trim().slice(0, 60);
    await meta.setJSON(NL, nl);
    return j({ ok: true });
  }

  if (route === 'clear') {
    await meta.delete(NL);
    const { blobs } = await rec.list();
    await Promise.all(blobs.map((b) => rec.delete(b.key)));
    const ee = await ev.list(); await Promise.all(ee.blobs.map((b) => ev.delete(b.key)));
    return j({ ok: true });
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
    let all = people, label = String(body.label || '').trim().slice(0, 60), note = body.note === undefined ? undefined : String(body.note).trim().slice(0, 200);
    if (body.merge) {
      const nl = await meta.get(NL, { type: 'json' });
      if (!label && nl && nl.label) label = nl.label;
      if (note === undefined && nl && nl.note) note = nl.note;
      const m = new Map(((nl && nl.people) || []).map((p) => [p.barcode, p]));
      for (const p of people) m.set(p.barcode, p);
      all = [...m.values()];
    }
    await meta.setJSON(NL, { label, note: note || '', v: Date.now(), people: all.sort((a, b) => a.name.localeCompare(b.name)) });
    if (!body.merge) {
      const { blobs } = await rec.list();
      await Promise.all(blobs.map((b) => rec.delete(b.key)));
    const ee = await ev.list(); await Promise.all(ee.blobs.map((b) => ev.delete(b.key)));
    }
    return j({ ok: true, count: all.length });
  }

  return j({ error: 'Not found' }, 404);
};
