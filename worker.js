const json = (body, status = 200) => new Response(JSON.stringify(body), {
  status,
  headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' }
});

const encoder = new TextEncoder();

async function hmac(key, value) {
  const cryptoKey = await crypto.subtle.importKey('raw', key, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return new Uint8Array(await crypto.subtle.sign('HMAC', cryptoKey, encoder.encode(value)));
}

function equalBytes(left, right) {
  if (left.length !== right.length) return false;
  let difference = 0;
  for (let index = 0; index < left.length; index += 1) difference |= left[index] ^ right[index];
  return difference === 0;
}

async function getTelegramUser(request, env) {
  const header = request.headers.get('authorization') || '';
  const initData = header.startsWith('tma ') ? header.slice(4) : '';
  if (!initData || !env.BOT_TOKEN) return null;

  const params = new URLSearchParams(initData);
  const hash = params.get('hash');
  const authDate = Number(params.get('auth_date'));
  if (!hash || !authDate || Date.now() / 1000 - authDate > 86_400) return null;

  params.delete('hash');
  const checkString = [...params.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([key, value]) => `${key}=${value}`).join('\n');
  // Telegram uses the constant WebAppData as HMAC key and the bot token as data.
  const secret = await hmac(encoder.encode('WebAppData'), env.BOT_TOKEN);
  const signature = await hmac(secret, checkString);
  const received = Uint8Array.from(hash.match(/.{1,2}/g) || [], part => Number.parseInt(part, 16));
  if (!equalBytes(signature, received)) return null;

  try { return JSON.parse(params.get('user')); } catch { return null; }
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (!url.pathname.startsWith('/api/')) return env.ASSETS.fetch(request);
    if (request.method === 'OPTIONS') return new Response(null, { status: 204 });

    const user = await getTelegramUser(request, env);
    if (!user?.id) return json({ error: 'Unauthorized Telegram session' }, 401);

    if (url.pathname !== '/api/state') return json({ error: 'Not found' }, 404);
    const telegramId = String(user.id);

    if (request.method === 'GET') {
      const record = await env.DB.prepare('SELECT financial_data, updated_at FROM user_finance WHERE telegram_id = ?').bind(telegramId).first();
      return json({ state: record ? JSON.parse(record.financial_data) : null, updatedAt: record?.updated_at || null });
    }

    if (request.method === 'PUT') {
      const payload = await request.json().catch(() => null);
      if (!payload?.state || JSON.stringify(payload.state).length > 900_000) return json({ error: 'Invalid state payload' }, 400);
      await env.DB.prepare(`INSERT INTO user_finance (telegram_id, name, username, financial_data, updated_at)
        VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP)
        ON CONFLICT(telegram_id) DO UPDATE SET name = excluded.name, username = excluded.username, financial_data = excluded.financial_data, updated_at = CURRENT_TIMESTAMP`)
        .bind(telegramId, [user.first_name, user.last_name].filter(Boolean).join(' '), user.username || null, JSON.stringify(payload.state)).run();
      return json({ ok: true });
    }
    return json({ error: 'Method not allowed' }, 405);
  }
};
