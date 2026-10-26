// Netlify Function. Needs env var ACCESS_CODE. Data lives in Netlify Blobs (no setup needed).
import { getStore } from '@netlify/blobs';

const j = (o, s = 200) =>
  new Response(JSON.stringify(o), { status: s, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' } });

const PROMPT = `This is a photo of a printed attendance sheet listing people (it may be rotated or tilted). For every person row, return the full name and the barcode number from the "Barcode No" column (digits only). If a barcode is crossed out or struck through, use the handwritten replacement written next to it (the latest one) and set the flag to "c". If a note like "New barcode" gives a replacement, use that and flag "c". If a person also has an extra barcode under "ADD ON" and the main one is still valid, return the main one and flag "?". If you are unsure of any digit or the row is unclear, flag "?". Skip rows with no barcode. Ignore LCE numbers and dates. Return ONLY a JSON array like [["Full Name","2601050827",""]] with no other text.`;

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

  if (route === 'extract') {
    const gk = Netlify.env.get('GEMINI_API_KEY'), ak = Netlify.env.get('ANTHROPIC_API_KEY');
    if (!gk && !ak) return j({ error: 'GEMINI_API_KEY is not set in Netlify. Use the on-device reader.' }, 500);
    let r;
    if (gk) {
      r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${Netlify.env.get('GEMINI_MODEL') || 'gemini-2.5-flash'}:generateContent`, {
        method: 'POST', headers: { 'x-goog-api-key': gk, 'content-type': 'application/json' },
        body: JSON.stringify({ contents: [{ parts: [{ inline_data: { mime_type: 'image/jpeg', data: body.image } }, { text: PROMPT }] }], generationConfig: { temperature: 0, responseMimeType: 'application/json' } })
      });
    } else {
      r = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST', headers: { 'x-api-key': ak, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
        body: JSON.stringify({ model: Netlify.env.get('CLAUDE_MODEL') || 'claude-sonnet-5-5', max_tokens: 4000,
          messages: [{ role: 'user', content: [{ type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: body.image } }, { type: 'text', text: PROMPT }] }] })
      });
    }
    const d = await r.json().catch(() => ({}));
    if (r.status === 429) return j({ error: 'Free limit reached. Wait a while, or use the on-device reader.' }, 429);
    if (!r.ok) return j({ error: (d.error && d.error.message) || 'AI request failed' }, 502);
    const t = gk ? ((d.candidates && d.candidates[0] && d.candidates[0].content && d.candidates[0].content.parts) || []).map((x) => x.text || '').join('')
                 : (d.content || []).map((c) => c.text || '').join('');
    let rows;
    try { rows = JSON.parse(t.match(/\[[\s\S]*\]/)[0]); } catch { return j({ error: 'Could not read this photo. Try a clearer one.' }, 422); }
    return j({ rows: rows.filter((x) => Array.isArray(x) && x[0] && x[1]).map((x) => ({ n: String(x[0]).trim(), b: String(x[1]).replace(/\s/g, ''), f: x[2] || '' })) });
  }

  if (route === 'remove') {
    const bc = String(body.barcode || '');
    const nl = (await meta.get('namelist', { type: 'json' })) || { v: 0, people: [] };
    nl.people = nl.people.filter((p) => p.barcode !== bc); nl.v = Date.now();
    await meta.setJSON('namelist', nl);
    await rec.delete(key(bc));
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
    let all = people;
    if (body.merge) {
      const nl = await meta.get('namelist', { type: 'json' });
      const m = new Map(((nl && nl.people) || []).map((p) => [p.barcode, p]));
      for (const p of people) m.set(p.barcode, p);
      all = [...m.values()];
    }
    await meta.setJSON('namelist', { v: Date.now(), people: all.sort((a, b) => a.name.localeCompare(b.name)) });
    if (!body.merge) {
      const { blobs } = await rec.list();
      await Promise.all(blobs.map((b) => rec.delete(b.key)));
    }
    return j({ ok: true, count: all.length });
  }

  return j({ error: 'Not found' }, 404);
};
