// Read-only provider diagnosis. No app calls, database writes, or email content.
// Run as growth from the app directory, passing this reviewed file on stdin.
import { createDecipheriv } from 'node:crypto';
import pg from 'pg';

process.loadEnvFile('/home/growth/.env.production');
const client = new pg.Client({ connectionString: process.env.DATABASE_URL });
const fields = ['max_tokens', 'max_completion_tokens', 'response_format', 'messages', 'model', 'temperature', 'thinking'];
function safeError(payload, status) {
  const error = payload?.error ?? payload;
  const message = typeof error?.message === 'string' ? error.message : '';
  const code = typeof error?.code === 'string' && /^[a-z_][a-z0-9_]{0,63}$/i.test(error.code) ? error.code : null;
  const type = typeof error?.type === 'string' && /^[a-z_][a-z0-9_]{0,63}$/i.test(error.type) ? error.type : null;
  const param = fields.includes(error?.param) ? error.param : null;
  return { status, code, type, fields: fields.filter(field => field === param || message.includes(field)) };
}
await client.connect();
try {
  await client.query('BEGIN READ ONLY');
  const target = await client.query('SELECT current_database() AS db');
  if (target.rows[0]?.db !== 'growth') throw new Error('wrong_database');
  const result = await client.query('SELECT provider, base_url, model, encrypted_api_key FROM research_providers WHERE id = $1 AND is_enabled = true', ['67c3974f-0113-4dd4-9719-3893e8a61a11']);
  if (result.rows.length !== 1) throw new Error('provider_not_found');
  const row = result.rows[0];
  if (row.provider !== 'custom' || row.base_url !== 'https://vyceai.com') throw new Error('provider_changed');
  const parts = row.encrypted_api_key.split(':');
  if (parts.length !== 5 || parts.slice(0, 2).join(':') !== 'enc:v1') throw new Error('key_format');
  const decipher = createDecipheriv('aes-256-gcm', Buffer.from(process.env.APP_ENCRYPTION_KEY, 'base64'), Buffer.from(parts[2], 'base64'));
  decipher.setAuthTag(Buffer.from(parts[3], 'base64'));
  const key = Buffer.concat([decipher.update(Buffer.from(parts[4], 'base64')), decipher.final()]).toString('utf8');
  const base = row.base_url.replace(/\/+$/, '').replace(/\/v1$/i, '');
  const headers = { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` };
  const modelsResponse = await fetch(`${base}/v1/models`, { headers, signal: AbortSignal.timeout(30000), redirect: 'error' });
  const modelsPayload = await modelsResponse.json().catch(() => ({}));
  const ids = Array.isArray(modelsPayload.data) ? modelsPayload.data.map(item => item.id).filter(id => typeof id === 'string') : [];
  console.log(JSON.stringify({ step: 'models', status: modelsResponse.status, count: ids.length, exactModelMatch: ids.includes(row.model), model: row.model }));
  if (!modelsResponse.ok || !ids.includes(row.model)) process.exitCode = 2;
  else {
    const common = { model: row.model, messages: [{ role: 'system', content: 'Return JSON only.' }, { role: 'user', content: 'Return {"ok":true}.' }], response_format: { type: 'json_object' } };
    for (const variant of ['current_request', 'standard_max_tokens', 'without_response_format']) {
      const body = { ...common, ...(variant === 'current_request' ? { max_completion_tokens: 64 } : { max_tokens: 64 }) };
      if (variant === 'without_response_format') delete body.response_format;
      const response = await fetch(`${base}/v1/chat/completions`, { method: 'POST', headers, body: JSON.stringify(body), signal: AbortSignal.timeout(60000), redirect: 'error' });
      const payload = await response.json().catch(() => ({}));
      const content = payload?.choices?.[0]?.message?.content;
      console.log(JSON.stringify({ step: variant, url: `${base}/v1/chat/completions`, requestFields: Object.keys(body), ...safeError(payload, response.status), nonempty: typeof content === 'string' && content.trim().length > 0 }));
      if (response.ok && typeof content === 'string' && content.trim()) break;
      if (response.status !== 400 && response.status !== 422) break;
    }
  }
  await client.query('ROLLBACK');
} catch {
  // Never stringify an exception: connection strings and response bodies may be in it.
  console.log(JSON.stringify({ code: 'diagnostic_failed' }));
  process.exitCode = 1;
} finally {
  await client.end();
}
