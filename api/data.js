export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, PUT, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, x-app-secret');

  if (req.method === 'OPTIONS') return res.status(200).end();

  const SUPABASE_URL = process.env.SUPABASE_URL;
  const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_KEY;

  if (!SUPABASE_URL || !SUPABASE_KEY) {
    return res.status(500).json({ error: 'Supabase env vars not configured' });
  }

  const SB = {
    'apikey': SUPABASE_KEY,
    'Authorization': `Bearer ${SUPABASE_KEY}`,
    'Content-Type': 'application/json',
  };

  // ── GET: load all data ──
  if (req.method === 'GET') {
    const r = await fetch(
      `${SUPABASE_URL}/rest/v1/store?id=eq.main&select=data`,
      { headers: SB }
    );
    if (!r.ok) return res.status(500).json({ error: `Supabase: ${r.status}` });
    const rows = await r.json();
    if (!rows.length) return res.json({ projects: [], clays: [], glazeLib: [] });
    return res.json(rows[0].data || { projects: [], clays: [], glazeLib: [] });
  }

  // ── PUT: save all data ──
  if (req.method === 'PUT') {
    let body;
    try { body = await readBody(req); }
    catch (e) { return res.status(400).json({ error: 'Invalid JSON body' }); }

    const r = await fetch(`${SUPABASE_URL}/rest/v1/store`, {
      method: 'POST',
      headers: { ...SB, 'Prefer': 'resolution=merge-duplicates' },
      body: JSON.stringify({
        id: 'main',
        data: body,
        updated_at: new Date().toISOString(),
      }),
    });

    if (!r.ok) return res.status(500).json({ error: await r.text() });
    return res.json({ ok: true });
  }

  res.status(405).json({ error: 'Method not allowed' });
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let raw = '';
    req.on('data', chunk => raw += chunk);
    req.on('end', () => { try { resolve(JSON.parse(raw)); } catch (e) { reject(e); } });
    req.on('error', reject);
  });
}
