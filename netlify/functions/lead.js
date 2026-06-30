// netlify/functions/lead.js
// ---------------------------------------------------------------------------
// Receives a lead from the LV gutter landing pages and inserts it into the
// Supabase `contacts` table as tenant_id='lv' (the CRM "Contact" section).
//
// WHY A FUNCTION (not the page → Supabase directly):
// Your tables are locked to authenticated-only RLS (authenticated_tenant_all).
// A public landing page visitor is anonymous and has no insert permission — and
// you don't want to reopen an anon write path. This function uses the SERVICE
// ROLE key SERVER-SIDE (which bypasses RLS) so the page never needs a key and
// your lockdown stays intact.
//
// REQUIRED Netlify env vars (set on the SAME site as the landing pages):
//   SUPABASE_URL                 (same value your CRM uses)
//   SUPABASE_SERVICE_ROLE_KEY    (the SERVICE ROLE key — server-side only, NEVER in HTML)
//
// OPTIONAL (email notification — safe to leave unset; it never blocks the save):
//   LEAD_NOTIFY_TO        e.g. Infolvgeneralservices@gmail.com
//   SEND_EMAIL_URL        your existing send-email function URL
//   INTERNAL_SEND_SECRET  the shared secret your send-email.js already expects
//   ALLOWED_ORIGIN        lock to your gutter domain (defaults to * )
// ---------------------------------------------------------------------------

const SUPABASE_URL = process.env.SUPABASE_URL;
const SERVICE_ROLE = process.env.SUPABASE_SERVICE_ROLE_KEY;

// --- adjust ONLY if your contacts columns are named differently ---
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

  // Honeypot: bots fill this hidden field, humans never see it. Silently accept + drop.
  if (data.company) return json(200, { ok: true });

  const name  = String(data.name  || '').trim();
  const phone = String(data.phone || '').trim();
  const email = String(data.email || '').trim();

  // Server-side validation (never trust the client)
  if (!name) return json(400, { ok: false, error: 'name required' });
  if (phone.replace(/\D/g, '').length < 10) return json(400, { ok: false, error: 'valid phone required' });
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return json(400, { ok: false, error: 'valid email required' });

  if (!SUPABASE_URL || !SERVICE_ROLE) return json(500, { ok: false, error: 'server not configured' });

  // Row to insert into the contacts table
  const row = {
    name:  name,
    email: email,
    phone: phone,
    tenant_id: TENANT,
    // If your contacts table has these columns, uncomment to capture lead source
    // (lets you see in the CRM which question drove each booking):
    // status: 'New Lead',
    // source: 'Gutter landing page',
    // notes:  'From: ' + (data.source_question || '') + ' — ' + (data.source_page || ''),
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

  // Optional notification — best-effort, wrapped so a failure can NEVER lose the lead
  if (NOTIFY_TO && SEND_EMAIL_URL) {
    try {
      await fetch(SEND_EMAIL_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-internal-secret': INTERNAL_SECRET },
        // NOTE: match these fields to what your send-email.js actually expects
        body: JSON.stringify({
          to: NOTIFY_TO,
          subject: `New gutter lead: ${name}`,
          text: `New lead from the gutter site\n\nName: ${name}\nPhone: ${phone}\nEmail: ${email}\nQuestion: ${data.source_question || ''}\nPage: ${data.source_page || ''}`,
        }),
      });
    } catch (_) { /* swallow — the lead is already saved */ }
  }

  return json(200, { ok: true });
};
