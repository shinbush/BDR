const encoder = new TextEncoder();
const decoder = new TextDecoder();
const DAY_MS = 24 * 60 * 60 * 1000;
const DELIVERY_LEASE_MS = 5 * 60 * 1000;
const MAX_PAYMENT_FORECAST_HORIZON_MS = 370 * DAY_MS;
const MAX_PAYMENT_FORECAST_OCCURRENCES = 64;
const MAX_STATE_BYTES = 900_000;
const MAX_PAYMENT_BYTES = 12_000;
const MAX_WEBHOOK_BYTES = 128_000;
const PAYMENT_CADENCES = new Set(['weekly', 'monthly', 'yearly']);
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const json = (body, status = 200) => new Response(JSON.stringify(body), {
  status,
  headers: {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store'
  }
});

function requestError(message, status = 400) {
  const error = new Error(message);
  error.status = status;
  return error;
}

function errorStatus(error) {
  return Number.isInteger(error?.status) && error.status >= 400 && error.status < 600 ? error.status : 500;
}

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

function logError(message, error, extra = {}) {
  console.error(JSON.stringify({ message, error: errorMessage(error), ...extra }));
}

async function readJson(request, maxBytes) {
  const declaredLength = request.headers.get('content-length');
  if (declaredLength && (!/^\d+$/.test(declaredLength) || Number(declaredLength) > maxBytes)) {
    throw requestError('Request body is too large', 413);
  }

  const reader = request.body?.getReader();
  if (!reader) throw requestError('Request body is required');

  const chunks = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel();
        throw requestError('Request body is too large', 413);
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }

  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }

  try {
    return JSON.parse(decoder.decode(bytes));
  } catch {
    throw requestError('Invalid JSON payload');
  }
}

async function hmac(key, value) {
  const cryptoKey = await crypto.subtle.importKey('raw', key, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return new Uint8Array(await crypto.subtle.sign('HMAC', cryptoKey, encoder.encode(value)));
}

async function timingSafeEqual(left, right) {
  const [leftHash, rightHash] = await Promise.all([
    crypto.subtle.digest('SHA-256', encoder.encode(left)),
    crypto.subtle.digest('SHA-256', encoder.encode(right))
  ]);
  return crypto.subtle.timingSafeEqual(leftHash, rightHash);
}

function bytesToHex(bytes) {
  return Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('');
}

async function getTelegramUser(request, env) {
  const header = request.headers.get('authorization') || '';
  const initData = header.slice(0, 4).toLowerCase() === 'tma ' ? header.slice(4) : '';
  if (!initData || !env.BOT_TOKEN) return null;

  const params = new URLSearchParams(initData);
  const hash = params.get('hash') || '';
  const authDate = Number(params.get('auth_date'));
  const nowSeconds = Math.floor(Date.now() / 1000);
  if (!/^[0-9a-f]{64}$/i.test(hash) || !Number.isInteger(authDate) || authDate > nowSeconds + 300 || nowSeconds - authDate > 86_400) {
    return null;
  }

  params.delete('hash');
  const checkString = [...params.entries()]
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
    .map(([key, value]) => `${key}=${value}`)
    .join('\n');
  const secret = await hmac(encoder.encode('WebAppData'), env.BOT_TOKEN);
  const signature = await hmac(secret, checkString);
  if (!await timingSafeEqual(bytesToHex(signature), hash.toLowerCase())) return null;

  try {
    const user = JSON.parse(params.get('user') || 'null');
    return user && typeof user === 'object' && Number.isInteger(user.id) ? user : null;
  } catch {
    return null;
  }
}

function isUuid(value) {
  return typeof value === 'string' && UUID_PATTERN.test(value);
}

function requiredText(value, field, maxLength) {
  if (typeof value !== 'string') throw requestError(`Field ${field} is required`);
  const text = value.replace(/\s+/g, ' ').trim();
  if (!text || text.length > maxLength) throw requestError(`Field ${field} must contain 1-${maxLength} characters`);
  return text;
}

function parsePaymentPayload(payload) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) throw requestError('Invalid payment payload');

  const title = requiredText(payload.title, 'title', 120);
  const categoryId = requiredText(payload.category_id, 'category_id', 120);
  const amount = Number(payload.amount);
  if (!Number.isInteger(amount) || amount <= 0 || amount > 100_000_000) throw requestError('Amount must be a whole number from 1 to 100000000');

  const cadence = payload.cadence;
  if (!PAYMENT_CADENCES.has(cadence)) throw requestError('Invalid cadence');

  const timeLocal = payload.time_local;
  if (typeof timeLocal !== 'string' || !/^([01]\d|2[0-3]):[0-5]\d$/.test(timeLocal)) throw requestError('Invalid local time');

  const timezone = requiredText(payload.timezone, 'timezone', 80);
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: timezone }).format();
  } catch {
    throw requestError('Invalid timezone');
  }

  const nextReminderAt = Number(payload.next_reminder_at);
  if (!Number.isSafeInteger(nextReminderAt) || nextReminderAt <= 0 || nextReminderAt > Date.UTC(2100, 0, 1)) {
    throw requestError('Invalid next reminder time');
  }

  return { title, categoryId, amount, cadence, timeLocal, timezone, nextReminderAt };
}

function paymentFromRow(row) {
  if (!row) return null;
  return {
    id: row.id,
    title: row.title,
    amount: Number(row.amount),
    category_id: row.category_id,
    cadence: row.cadence,
    time_local: row.time_local,
    timezone: row.timezone,
    anchor_day: Number(row.anchor_day),
    next_reminder_at: Number(row.next_reminder_at),
    active: Boolean(row.active),
    created_at: row.created_at,
    updated_at: row.updated_at,
    open_reminder_id: row.open_reminder_id || null,
    open_reminder_occurrence_at: row.open_reminder_occurrence_at === null || row.open_reminder_occurrence_at === undefined ? null : Number(row.open_reminder_occurrence_at),
    open_reminder_next_attempt_at: row.open_reminder_next_attempt_at === null || row.open_reminder_next_attempt_at === undefined ? null : Number(row.open_reminder_next_attempt_at),
    open_reminder_delivery_status: row.open_reminder_delivery_status || null
  };
}

const paymentSelect = `
  SELECT
    p.id, p.title, p.amount, p.category_id, p.cadence, p.time_local, p.timezone, p.anchor_day,
    p.next_reminder_at, p.active, p.created_at, p.updated_at,
    r.id AS open_reminder_id,
    r.occurrence_at AS open_reminder_occurrence_at,
    r.next_attempt_at AS open_reminder_next_attempt_at,
    r.delivery_status AS open_reminder_delivery_status
  FROM planned_payments p
  LEFT JOIN payment_reminders r ON r.id = (
    SELECT id
    FROM payment_reminders
    WHERE payment_id = p.id AND resolution IS NULL
    ORDER BY occurrence_at ASC
    LIMIT 1
  )`;

async function getPayment(env, telegramId, paymentId) {
  const row = await env.DB.prepare(`${paymentSelect}
    WHERE p.id = ? AND p.telegram_id = ? AND p.active = 1`)
    .bind(paymentId, telegramId)
    .first();
  return paymentFromRow(row);
}

async function listPayments(env, telegramId) {
  const result = await env.DB.prepare(`${paymentSelect}
    WHERE p.telegram_id = ? AND p.active = 1
    ORDER BY p.next_reminder_at ASC, p.created_at ASC`)
    .bind(telegramId)
    .all();
  return result.results.map(paymentFromRow);
}

function zonedParts(timestamp, timeZone) {
  const formatter = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23'
  });
  const values = Object.fromEntries(formatter.formatToParts(new Date(timestamp))
    .filter(part => part.type !== 'literal')
    .map(part => [part.type, Number(part.value)]));
  return { year: values.year, month: values.month, day: values.day, hour: values.hour, minute: values.minute };
}

function zonedDateTimeToEpoch({ year, month, day, hour, minute }, timeZone) {
  const expected = Date.UTC(year, month - 1, day, hour, minute);
  let candidate = expected;
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const actual = zonedParts(candidate, timeZone);
    const observed = Date.UTC(actual.year, actual.month - 1, actual.day, actual.hour, actual.minute);
    const delta = expected - observed;
    if (delta === 0) return candidate;
    candidate += delta;
  }
  return candidate;
}

function addDays(year, month, day, days) {
  const date = new Date(Date.UTC(year, month - 1, day + days));
  return { year: date.getUTCFullYear(), month: date.getUTCMonth() + 1, day: date.getUTCDate() };
}

function daysInMonth(year, month) {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

function occurrenceAfter(payment, occurrenceAt, intervals = 1) {
  const local = zonedParts(Number(occurrenceAt), payment.timezone);
  const [hour, minute] = payment.time_local.split(':').map(Number);
  const anchorDay = Number(payment.anchor_day) || local.day;
  const count = Math.max(1, Math.floor(Number(intervals) || 1));
  let target;
  if (payment.cadence === 'weekly') {
    target = addDays(local.year, local.month, local.day, 7 * count);
  } else if (payment.cadence === 'monthly') {
    const absoluteMonth = local.year * 12 + (local.month - 1) + count;
    const year = Math.floor(absoluteMonth / 12);
    const month = absoluteMonth % 12 + 1;
    target = { year, month, day: Math.min(anchorDay, daysInMonth(year, month)) };
  } else {
    const year = local.year + count;
    target = { year, month: local.month, day: Math.min(anchorDay, daysInMonth(year, local.month)) };
  }
  return zonedDateTimeToEpoch({ ...target, hour, minute }, payment.timezone);
}

function nextOccurrenceAt(payment) {
  return occurrenceAfter(payment, payment.next_reminder_at);
}

function firstFutureOccurrence(payment, occurrenceAt, now) {
  const occurrenceLocal = zonedParts(occurrenceAt, payment.timezone);
  const nowLocal = zonedParts(now, payment.timezone);
  let intervals = 1;
  if (payment.cadence === 'weekly') {
    const occurrenceDay = Date.UTC(occurrenceLocal.year, occurrenceLocal.month - 1, occurrenceLocal.day);
    const nowDay = Date.UTC(nowLocal.year, nowLocal.month - 1, nowLocal.day);
    intervals = Math.max(1, Math.floor((nowDay - occurrenceDay) / (7 * DAY_MS)));
  } else if (payment.cadence === 'monthly') {
    intervals = Math.max(1, (nowLocal.year - occurrenceLocal.year) * 12 + nowLocal.month - occurrenceLocal.month);
  } else {
    intervals = Math.max(1, nowLocal.year - occurrenceLocal.year);
  }
  let future = occurrenceAfter(payment, occurrenceAt, intervals);
  while (future <= now) future = occurrenceAfter(payment, future);
  return future;
}

function paymentForecastCutoff(url) {
  const until = Number(url.searchParams.get('until'));
  const now = Date.now();
  if (!Number.isSafeInteger(until) || until <= now || until > now + MAX_PAYMENT_FORECAST_HORIZON_MS) {
    throw requestError('Invalid payment forecast cutoff');
  }
  return until;
}

function forecastPaymentOccurrences(payment, until, now) {
  let occurrenceAt = Number(payment.next_reminder_at);
  if (!Number.isSafeInteger(occurrenceAt) || occurrenceAt >= until) return [];
  const occurrences = [];
  // The server never advances a schedule while its due reminder is unresolved.
  // Reserve that overdue item once, then forecast only upcoming occurrences.
  if (occurrenceAt <= now) {
    occurrences.push({ payment_id: payment.id, category_id: payment.category_id, amount: Number(payment.amount), occurrence_at: occurrenceAt, overdue: true });
    occurrenceAt = firstFutureOccurrence(payment, occurrenceAt, now);
  }
  while (occurrenceAt < until && occurrences.length < MAX_PAYMENT_FORECAST_OCCURRENCES) {
    occurrences.push({ payment_id: payment.id, category_id: payment.category_id, amount: Number(payment.amount), occurrence_at: occurrenceAt, overdue: false });
    occurrenceAt = occurrenceAfter(payment, occurrenceAt);
  }
  return occurrences;
}

async function forecastPayments(env, telegramId, until) {
  const now = Date.now();
  const occurrences = (await listPayments(env, telegramId)).flatMap(payment => forecastPaymentOccurrences(payment, until, now));
  const byCategory = {};
  let total = 0;
  let overdueCount = 0;
  for (const occurrence of occurrences) {
    const amount = Math.max(0, Number(occurrence.amount) || 0);
    total += amount;
    byCategory[occurrence.category_id] = (byCategory[occurrence.category_id] || 0) + amount;
    if (occurrence.overdue) overdueCount += 1;
  }
  return { until, generated_at: now, total, by_category: byCategory, occurrence_count: occurrences.length, overdue_count: overdueCount };
}

function tomorrowAtLocalTime(payment) {
  const today = zonedParts(Date.now(), payment.timezone);
  const tomorrow = addDays(today.year, today.month, today.day, 1);
  const [hour, minute] = payment.time_local.split(':').map(Number);
  return zonedDateTimeToEpoch({ ...tomorrow, hour, minute }, payment.timezone);
}

async function createPayment(env, telegramId, payload) {
  const payment = parsePaymentPayload(payload);
  const id = crypto.randomUUID();
  const anchorDay = zonedParts(payment.nextReminderAt, payment.timezone).day;
  await env.DB.prepare(`INSERT INTO planned_payments
    (id, telegram_id, title, amount, category_id, cadence, time_local, timezone, anchor_day, next_reminder_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .bind(id, telegramId, payment.title, payment.amount, payment.categoryId, payment.cadence, payment.timeLocal, payment.timezone, anchorDay, payment.nextReminderAt)
    .run();
  return getPayment(env, telegramId, id);
}

async function updatePayment(env, telegramId, paymentId, payload) {
  const existing = await getPayment(env, telegramId, paymentId);
  if (!existing) throw requestError('Planned payment not found', 404);
  const payment = parsePaymentPayload(payload);
  const anchorDay = zonedParts(payment.nextReminderAt, payment.timezone).day;
  await env.DB.batch([
    env.DB.prepare(`UPDATE planned_payments
      SET title = ?, amount = ?, category_id = ?, cadence = ?, time_local = ?, timezone = ?, anchor_day = ?, next_reminder_at = ?, updated_at = CURRENT_TIMESTAMP
      WHERE id = ? AND telegram_id = ? AND active = 1`)
      .bind(payment.title, payment.amount, payment.categoryId, payment.cadence, payment.timeLocal, payment.timezone, anchorDay, payment.nextReminderAt, paymentId, telegramId),
    env.DB.prepare(`UPDATE payment_reminders
      SET resolution = 'cancelled', updated_at = CURRENT_TIMESTAMP
      WHERE payment_id = ? AND telegram_id = ? AND resolution IS NULL`)
      .bind(paymentId, telegramId)
  ]);
  return getPayment(env, telegramId, paymentId);
}

async function deletePayment(env, telegramId, paymentId) {
  const existing = await getPayment(env, telegramId, paymentId);
  if (!existing) throw requestError('Planned payment not found', 404);
  await env.DB.batch([
    env.DB.prepare('DELETE FROM payment_reminders WHERE payment_id = ? AND telegram_id = ?').bind(paymentId, telegramId),
    env.DB.prepare('DELETE FROM planned_payments WHERE id = ? AND telegram_id = ?').bind(paymentId, telegramId)
  ]);
}

async function getOpenReminder(env, telegramId, paymentId, reminderId = null) {
  const filter = reminderId ? 'AND r.id = ?' : '';
  const statement = env.DB.prepare(`SELECT
      p.id, p.telegram_id, p.title, p.amount, p.category_id, p.cadence, p.time_local, p.timezone, p.anchor_day, p.next_reminder_at, p.active,
      r.id AS reminder_id, r.occurrence_at, r.next_attempt_at, r.delivery_status
    FROM planned_payments p
    JOIN payment_reminders r ON r.payment_id = p.id
    WHERE p.id = ? AND p.telegram_id = ? AND p.active = 1 AND r.resolution IS NULL ${filter}
    ORDER BY r.occurrence_at ASC
    LIMIT 1`);
  const row = reminderId
    ? await statement.bind(paymentId, telegramId, reminderId).first()
    : await statement.bind(paymentId, telegramId).first();
  return row || null;
}

async function advanceReminder(env, telegramId, paymentId, reminderId, resolution) {
  const reminder = await getOpenReminder(env, telegramId, paymentId, reminderId);
  if (!reminder) throw requestError('Open reminder not found', 409);
  const nextReminderAt = nextOccurrenceAt(reminder);
  await env.DB.batch([
    env.DB.prepare(`UPDATE payment_reminders
      SET resolution = ?, updated_at = CURRENT_TIMESTAMP
      WHERE id = ? AND telegram_id = ? AND resolution IS NULL`)
      .bind(resolution, reminderId, telegramId),
    env.DB.prepare(`UPDATE planned_payments
      SET next_reminder_at = ?, updated_at = CURRENT_TIMESTAMP
      WHERE id = ? AND telegram_id = ? AND active = 1
        AND EXISTS (
          SELECT 1 FROM payment_reminders r
          WHERE r.id = ? AND r.payment_id = planned_payments.id AND r.resolution = ?
        )`)
      .bind(nextReminderAt, paymentId, telegramId, reminderId, resolution)
  ]);
  return getPayment(env, telegramId, paymentId);
}

async function postponePayment(env, telegramId, paymentId, reminderId) {
  const reminder = await getOpenReminder(env, telegramId, paymentId, reminderId || null);
  if (reminder) {
    const nextAttemptAt = tomorrowAtLocalTime(reminder);
    await env.DB.prepare(`UPDATE payment_reminders
      SET delivery_status = 'pending', next_attempt_at = ?, updated_at = CURRENT_TIMESTAMP
      WHERE id = ? AND telegram_id = ? AND resolution IS NULL`)
      .bind(nextAttemptAt, reminder.reminder_id, telegramId)
      .run();
    return getPayment(env, telegramId, paymentId);
  }

  if (reminderId) throw requestError('Open reminder not found', 409);
  const payment = await getPayment(env, telegramId, paymentId);
  if (!payment) throw requestError('Planned payment not found', 404);
  await env.DB.prepare(`UPDATE planned_payments
    SET next_reminder_at = ?, updated_at = CURRENT_TIMESTAMP
    WHERE id = ? AND telegram_id = ? AND active = 1`)
    .bind(tomorrowAtLocalTime(payment), paymentId, telegramId)
    .run();
  return getPayment(env, telegramId, paymentId);
}

async function handlePaymentAction(env, telegramId, paymentId, action, payload) {
  const reminderId = typeof payload?.reminder_id === 'string' && isUuid(payload.reminder_id) ? payload.reminder_id : null;
  if (payload?.reminder_id !== undefined && !reminderId) throw requestError('Invalid reminder id');

  if (action === 'complete') {
    if (!reminderId) throw requestError('Reminder id is required to complete a planned payment');
    return { payment: await advanceReminder(env, telegramId, paymentId, reminderId, 'paid'), status: 'paid' };
  }
  if (action === 'skip') {
    if (!reminderId) throw requestError('Reminder id is required to skip a planned payment');
    return { payment: await advanceReminder(env, telegramId, paymentId, reminderId, 'skipped'), status: 'skipped' };
  }
  if (action === 'postpone') return { payment: await postponePayment(env, telegramId, paymentId, reminderId), status: 'postponed' };
  throw requestError('Unknown planned payment action');
}

function retryDelay(attemptCount) {
  return Math.min(DAY_MS, 5 * 60 * 1000 * 2 ** Math.min(Math.max(attemptCount - 1, 0), 8));
}

function paymentDateText(timestamp, timeZone) {
  return new Intl.DateTimeFormat('ru-RU', {
    timeZone,
    day: 'numeric',
    month: 'long',
    hour: '2-digit',
    minute: '2-digit'
  }).format(new Date(timestamp));
}

function paymentAmountText(amount) {
  return `${new Intl.NumberFormat('ru-RU').format(Number(amount))} ₽`;
}

function reminderWebAppUrl(env, paymentId, reminderId) {
  const url = new URL(env.APP_URL);
  url.searchParams.set('payment', paymentId);
  url.searchParams.set('reminder', reminderId);
  return url.toString();
}

async function telegramApi(env, method, payload) {
  if (!env.BOT_TOKEN) throw new Error('BOT_TOKEN is not configured');
  const response = await fetch(`https://api.telegram.org/bot${env.BOT_TOKEN}/${method}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(12_000)
  });
  const result = await response.json().catch(() => null);
  if (!response.ok || !result?.ok) {
    const error = new Error(`Telegram ${method} failed${result?.description ? `: ${result.description}` : ''}`);
    error.telegramStatus = response.status;
    throw error;
  }
  return result.result;
}

async function sendReminder(env, reminder) {
  if (!env.APP_URL) throw new Error('APP_URL is not configured');
  const webAppUrl = reminderWebAppUrl(env, reminder.payment_id, reminder.id);
  const keyboard = [
    [{ text: 'Провести в Копилке', web_app: { url: webAppUrl } }]
  ];
  if (env.TELEGRAM_WEBHOOK_SECRET) {
    keyboard.push([{ text: 'Отложить на завтра', callback_data: `pp:p:${reminder.id}` }]);
    keyboard.push([{ text: 'Пропустить', callback_data: `pp:s:${reminder.id}` }]);
  }

  const message = [
    'Напоминание о платеже',
    '',
    reminder.title,
    `Сумма: ${paymentAmountText(reminder.amount)}`,
    `По плану: ${paymentDateText(reminder.occurrence_at, reminder.timezone)}`,
    '',
    'Баланс не изменён. Подтвердите расход только после фактической оплаты.'
  ].join('\n');

  return telegramApi(env, 'sendMessage', {
    chat_id: reminder.telegram_id,
    text: message,
    reply_markup: { inline_keyboard: keyboard }
  });
}

async function createDueReminders(env, now) {
  const duePayments = await env.DB.prepare(`SELECT p.*
    FROM planned_payments p
    WHERE p.active = 1
      AND p.next_reminder_at <= ?
      AND NOT EXISTS (
        SELECT 1 FROM payment_reminders r
        WHERE r.payment_id = p.id AND r.resolution IS NULL
      )
    ORDER BY p.next_reminder_at ASC
    LIMIT 50`)
    .bind(now)
    .all();

  let created = 0;
  for (const payment of duePayments.results) {
    const reminderId = crypto.randomUUID();
    const result = await env.DB.prepare(`INSERT OR IGNORE INTO payment_reminders
      (id, payment_id, telegram_id, occurrence_at, next_attempt_at)
      SELECT ?, p.id, p.telegram_id, p.next_reminder_at, ?
      FROM planned_payments p
      WHERE p.id = ? AND p.active = 1
        AND NOT EXISTS (
          SELECT 1 FROM payment_reminders r
          WHERE r.payment_id = p.id AND r.resolution IS NULL
        )`)
      .bind(reminderId, now, payment.id)
      .run();
    created += Number(result.meta.changes || 0);
  }
  return created;
}

async function dispatchDueReminders(env, now) {
  const pending = await env.DB.prepare(`SELECT
      r.id, r.payment_id, r.telegram_id, r.occurrence_at, r.next_attempt_at, r.attempt_count,
      p.title, p.amount, p.timezone
    FROM payment_reminders r
    JOIN planned_payments p ON p.id = r.payment_id
    WHERE p.active = 1
      AND r.resolution IS NULL
      AND r.delivery_status IN ('pending', 'failed', 'sending')
      AND r.next_attempt_at <= ?
    ORDER BY r.next_attempt_at ASC
    LIMIT 50`)
    .bind(now)
    .all();

  let sent = 0;
  for (const reminder of pending.results) {
    const claimed = await env.DB.prepare(`UPDATE payment_reminders
      SET delivery_status = 'sending', attempt_count = attempt_count + 1, next_attempt_at = ?, updated_at = CURRENT_TIMESTAMP
      WHERE id = ? AND resolution IS NULL
        AND delivery_status IN ('pending', 'failed', 'sending')
        AND next_attempt_at <= ?`)
      .bind(now + DELIVERY_LEASE_MS, reminder.id, now)
      .run();
    if (!Number(claimed.meta.changes)) continue;

    try {
      const message = await sendReminder(env, reminder);
      await env.DB.prepare(`UPDATE payment_reminders
        SET delivery_status = 'sent', telegram_message_id = ?, updated_at = CURRENT_TIMESTAMP
        WHERE id = ? AND resolution IS NULL`)
        .bind(Number(message?.message_id) || null, reminder.id)
        .run();
      sent += 1;
    } catch (error) {
      const retryAt = Date.now() + retryDelay(Number(reminder.attempt_count) + 1);
      await env.DB.prepare(`UPDATE payment_reminders
        SET delivery_status = 'failed', next_attempt_at = ?, updated_at = CURRENT_TIMESTAMP
        WHERE id = ? AND resolution IS NULL`)
        .bind(retryAt, reminder.id)
        .run();
      logError('planned_payment_reminder_send_failed', error, { reminderId: reminder.id });
    }
  }
  return sent;
}

async function processDuePayments(env) {
  const now = Date.now();
  const created = await createDueReminders(env, now);
  const sent = await dispatchDueReminders(env, now);
  console.log(JSON.stringify({ message: 'planned_payment_cron_finished', created, sent }));
}

async function configureTelegramWebhook(env) {
  if (!env.APP_URL || !env.TELEGRAM_WEBHOOK_SECRET) {
    throw requestError('Telegram notification actions are not configured yet', 503);
  }
  const url = new URL('/api/bot/webhook', env.APP_URL).toString();
  await telegramApi(env, 'setWebhook', {
    url,
    secret_token: env.TELEGRAM_WEBHOOK_SECRET,
    allowed_updates: ['callback_query'],
    drop_pending_updates: false
  });
  return url;
}

async function answerCallback(env, callbackId, text) {
  await telegramApi(env, 'answerCallbackQuery', {
    callback_query_id: callbackId,
    text,
    show_alert: false
  });
}

async function handleBotWebhook(request, env) {
  if (request.method !== 'POST') return json({ error: 'Method not allowed' }, 405);
  const secret = request.headers.get('x-telegram-bot-api-secret-token') || '';
  if (!env.TELEGRAM_WEBHOOK_SECRET || !await timingSafeEqual(secret, env.TELEGRAM_WEBHOOK_SECRET)) {
    return json({ error: 'Forbidden' }, 403);
  }

  const update = await readJson(request, MAX_WEBHOOK_BYTES);
  const callback = update?.callback_query;
  if (!callback || typeof callback !== 'object' || typeof callback.id !== 'string') return json({ ok: true });

  const match = typeof callback.data === 'string' ? /^pp:([ps]):([0-9a-f-]{36})$/i.exec(callback.data) : null;
  if (!match || !isUuid(match[2]) || !callback.from?.id) {
    await answerCallback(env, callback.id, 'Это действие больше недоступно.');
    return json({ ok: true });
  }

  const reminder = await env.DB.prepare(`SELECT r.id, r.payment_id, r.telegram_id
    FROM payment_reminders r
    WHERE r.id = ? AND r.resolution IS NULL`)
    .bind(match[2])
    .first();
  if (!reminder || String(reminder.telegram_id) !== String(callback.from.id)) {
    await answerCallback(env, callback.id, 'Напоминание уже обработано.');
    return json({ ok: true });
  }

  if (match[1] === 'p') {
    try {
      await postponePayment(env, String(reminder.telegram_id), reminder.payment_id, reminder.id);
      await answerCallback(env, callback.id, 'Напомню завтра. Баланс не менялся.');
    } catch (error) {
      if (errorStatus(error) !== 409) throw error;
      await answerCallback(env, callback.id, 'Напоминание уже обработано.');
    }
  } else {
    try {
      await advanceReminder(env, String(reminder.telegram_id), reminder.payment_id, reminder.id, 'skipped');
      await answerCallback(env, callback.id, 'Платёж пропущен. Баланс не менялся.');
    } catch (error) {
      if (errorStatus(error) !== 409) throw error;
      await answerCallback(env, callback.id, 'Напоминание уже обработано.');
    }
  }
  return json({ ok: true });
}

async function handleState(request, env, user) {
  const telegramId = String(user.id);
  if (request.method === 'GET') {
    const record = await env.DB.prepare('SELECT financial_data, updated_at FROM user_finance WHERE telegram_id = ?')
      .bind(telegramId)
      .first();
    return json({ state: record ? JSON.parse(record.financial_data) : null, updatedAt: record?.updated_at || null });
  }

  if (request.method === 'PUT') {
    const payload = await readJson(request, MAX_STATE_BYTES);
    if (!payload?.state) throw requestError('Invalid state payload');
    const financialData = JSON.stringify(payload.state);
    if (financialData.length > MAX_STATE_BYTES) throw requestError('State payload is too large', 413);
    await env.DB.prepare(`INSERT INTO user_finance (telegram_id, name, username, financial_data, updated_at)
      VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP)
      ON CONFLICT(telegram_id) DO UPDATE SET
        name = excluded.name,
        username = excluded.username,
        financial_data = excluded.financial_data,
        updated_at = CURRENT_TIMESTAMP`)
      .bind(telegramId, [user.first_name, user.last_name].filter(Boolean).join(' '), user.username || null, financialData)
      .run();
    return json({ ok: true });
  }
  return json({ error: 'Method not allowed' }, 405);
}

async function handleApi(request, env, user, url) {
  const telegramId = String(user.id);
  if (url.pathname === '/api/state') return handleState(request, env, user);

  if (url.pathname === '/api/notifications/activate') {
    if (request.method !== 'POST') return json({ error: 'Method not allowed' }, 405);
    const webhookUrl = await configureTelegramWebhook(env);
    return json({ ok: true, webhookUrl });
  }

  if (url.pathname === '/api/planned-payments') {
    if (request.method === 'GET') return json({ payments: await listPayments(env, telegramId) });
    if (request.method === 'POST') return json({ payment: await createPayment(env, telegramId, await readJson(request, MAX_PAYMENT_BYTES)) }, 201);
    return json({ error: 'Method not allowed' }, 405);
  }

  if (url.pathname === '/api/planned-payments/forecast') {
    if (request.method !== 'GET') return json({ error: 'Method not allowed' }, 405);
    return json(await forecastPayments(env, telegramId, paymentForecastCutoff(url)));
  }

  const match = /^\/api\/planned-payments\/([0-9a-f-]{36})(?:\/(complete|postpone|skip))?$/i.exec(url.pathname);
  if (!match || !isUuid(match[1])) return json({ error: 'Not found' }, 404);
  const paymentId = match[1];
  const action = match[2];
  if (action) {
    if (request.method !== 'POST') return json({ error: 'Method not allowed' }, 405);
    return json(await handlePaymentAction(env, telegramId, paymentId, action, await readJson(request, MAX_PAYMENT_BYTES)));
  }
  if (request.method === 'PUT') return json({ payment: await updatePayment(env, telegramId, paymentId, await readJson(request, MAX_PAYMENT_BYTES)) });
  if (request.method === 'DELETE') {
    await deletePayment(env, telegramId, paymentId);
    return json({ ok: true });
  }
  return json({ error: 'Method not allowed' }, 405);
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    try {
      if (url.pathname === '/cdn-cgi/handler/scheduled' || url.pathname === '/__scheduled') {
        return new Response('Not found', { status: 404 });
      }
      if (!url.pathname.startsWith('/api/')) return env.ASSETS.fetch(request);
      if (request.method === 'OPTIONS') return new Response(null, { status: 204 });
      if (url.pathname === '/api/bot/webhook') return handleBotWebhook(request, env);

      const user = await getTelegramUser(request, env);
      if (!user?.id) return json({ error: 'Unauthorized Telegram session' }, 401);
      return handleApi(request, env, user, url);
    } catch (error) {
      const status = errorStatus(error);
      logError('worker_request_failed', error, { method: request.method, path: url.pathname, status });
      return json({ error: status < 500 ? errorMessage(error) : 'Internal server error' }, status);
    }
  },

  async scheduled(controller, env, ctx) {
    ctx.waitUntil(processDuePayments(env).catch(error => {
      logError('planned_payment_cron_failed', error, { cron: controller.cron, scheduledTime: controller.scheduledTime });
      throw error;
    }));
  }
};
