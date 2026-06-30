// netlify/functions/lead.js
const SUPABASE_URL = process.env.SUPABASE_URL;
const SERVICE_ROLE = process.env.SUPABASE_SERVICE_ROLE_KEY;

const TABLE  = 'contacts';
const TENANT = 'lv';

const NOTIFY_TO       = process.env.LEAD_NOTIFY_TO || '';
const SEND_EMAIL_URL  = process.env.SEND_EMAIL_URL || '';
const INTERNAL_SECRET = process.env.INTERNAL_SEND_SECRET || '';

const CORS = {
  'Access-Control-Allow-Origin': process.env.ALLOWED_ORIGIN || '*',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

const json = (status, obj) => ({
  statusCode: status,
  headers: { ...CORS, 'Content-Type': 'application/json' },
  body: JSON.stringify(obj),
});

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: CORS, body: '' };
  if (event.httpMethod !== 'POST')    return json(405, { ok: false, error: 'method not allowed' });

  let data;
  try { data = JSON.parse(event.body || '{}'); }
  catch { return json(400, { ok: false, error: 'invalid JSON' }); }

  // Honeypot: bots fill this, humans never see it
  if (data.company) return json(200, { ok: true });

  const name  = String(data.name  || '').trim();
  const phone = String(data.phone || '').trim();
  const email = String(data.email || '').trim();

  if (!name) return json(400, { ok: false, error: 'name required' });
  if (phone.replace(/\D/g, '').length < 10) return json(400, { ok: false, error: 'valid phone required' });
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return json(400, { ok: false, error: 'valid email required' });

  if (!SUPABASE_URL || !SERVICE_ROLE) return json(500, { ok: false, error: 'server not configured' });

  // Split full name into first / last to match the contacts table schema
  const nameParts = name.split(' ');
  const firstName = nameParts[0] || name;
  const lastName  = nameParts.slice(1).join(' ') || '';

  const row = {
    first:     firstName,
    last:      lastName,
    email:     email,
    phone:     phone,
    tenant_id: TENANT,
  };

  try {
    const res = await fetch(`${SUPABASE_URL}/rest/v1/${TABLE}`, {
      method: 'POST',
      headers: {
        'apikey': SERVICE_ROLE,
        'Authorization': `Bearer ${SERVICE_ROLE}`,
        'Content-Type': 'application/json',
        'Prefer': 'return=minimal',
      },
      body: JSON.stringify(row),
    });
    if (!res.ok) {
      const detail = (await res.text()).slice(0, 300);
      return json(502, { ok: false, error: 'db insert failed', detail });
    }
  } catch (e) {
    return json(502, { ok: false, error: 'db unreachable' });
  }

  if (NOTIFY_TO && SEND_EMAIL_URL) {
    try {
      await fetch(SEND_EMAIL_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-internal-secret': INTERNAL_SECRET },
        body: JSON.stringify({
          to: NOTIFY_TO,
          subject: `New gutter lead: ${name}`,
          text: `New lead from the gutter site\n\nName: ${name}\nPhone: ${phone}\nEmail: ${email}\nQuestion: ${data.source_question || ''}\nPage: ${data.source_page || ''}`,
        }),
      });
    } catch (_) { /* swallow — lead already saved */ }
  }

  return json(200, { ok: true });
};
