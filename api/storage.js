import { Redis } from '@upstash/redis';

// Vercel's Upstash integration has historically injected env vars under the
// legacy "KV_REST_API_*" names (kept for backward compatibility with the old
// Vercel KV product) as well as Upstash's own "UPSTASH_REDIS_REST_*" names,
// depending on how the integration was installed. We check both so this
// works regardless of which one shows up in your project's Environment
// Variables settings.
// -------------------
const redis = new Redis({
  url: process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL,
  token: process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN,
  // Treat every value as a raw string in both directions — no implicit
  // JSON parsing/stringifying. The app already does its own JSON.stringify
  // / JSON.parse at the call sites, so this avoids any double-encoding or
  // "helpful" auto-parsing surprises from the Redis client.
  automaticDeserialization: false,
});

const MAX_KEY_LEN = 200;
const MAX_VALUE_BYTES = 5_000_000; // 5MB, matching the original storage contract

// SECURITY: Rate limiting — 60 requests per minute per IP, using the same
// Redis instance. Prevents abuse, wallet-drain attacks, and brute-force
// enumeration of case IDs.
const RATE_LIMIT_WINDOW = 60;  // seconds
const RATE_LIMIT_MAX    = 60;  // max requests per window

// PRIVACY: Auto-expire all case and document data after 30 days of
// inactivity. Every read or write refreshes the TTL, so active cases
// stay alive, but abandoned ones are cleaned up automatically.
const KEY_TTL_SECONDS = 30 * 24 * 60 * 60; // 30 days

export default async function handler(req, res) {
  try {
    // --- Rate limiting (per-IP, sliding window via Redis) ---
    const ip = (req.headers['x-forwarded-for'] || req.headers['x-real-ip'] || 'unknown').split(',')[0].trim();
    const rlKey = `rl:${ip}`;
    const current = await redis.incr(rlKey);
    if (current === 1) await redis.expire(rlKey, RATE_LIMIT_WINDOW);
    if (current > RATE_LIMIT_MAX) {
      res.setHeader('Retry-After', String(RATE_LIMIT_WINDOW));
      return res.status(429).json({ error: 'too many requests — try again shortly' });
    }

    const isPost = req.method === 'POST';
    const key = isPost ? (req.body || {}).key : req.query.key;

    // Block unused prefix keys listing to prevent enumeration of cases
    if (req.method === 'GET' && req.query.prefix !== undefined) {
      return res.status(400).json({ error: 'listing keys is disabled for security' });
    }

    // Validate that the key matches expected patterns:
    // 1. case:<caseId>
    // 2. doc:<caseId>:<role>:<fieldId>
    if (['GET', 'POST', 'DELETE'].includes(req.method)) {
      if (!key) {
        return res.status(400).json({ error: 'key is required' });
      }
      if (!/^(case:[a-zA-Z0-9]{7,32}|doc:[a-zA-Z0-9]{7,32}:[AB]:[a-zA-Z0-9]+)$/.test(key)) {
        return res.status(400).json({ error: 'invalid key format' });
      }
    }

    if (req.method === 'GET') {
      const value = await redis.get(key);
      if (value === null || value === undefined) {
        return res.status(404).json({ error: 'not found' });
      }
      // Refresh TTL on read so active cases stay alive
      await redis.expire(key, KEY_TTL_SECONDS);
      return res.status(200).json({ key, value });
    }

    if (req.method === 'POST') {
      const { value } = req.body || {};
      if (typeof value !== 'string') {
        return res.status(400).json({ error: 'key and a string value are required' });
      }
      if (key.length > MAX_KEY_LEN) {
        return res.status(400).json({ error: `key must be under ${MAX_KEY_LEN} characters` });
      }
      if (Buffer.byteLength(value, 'utf8') > MAX_VALUE_BYTES) {
        return res.status(400).json({ error: 'value exceeds 5MB limit' });
      }
      await redis.set(key, value, { ex: KEY_TTL_SECONDS });
      return res.status(200).json({ key, value });
    }

    if (req.method === 'DELETE') {
      await redis.del(key);
      return res.status(200).json({ key, deleted: true });
    }

    res.setHeader('Allow', 'GET, POST, DELETE');
    return res.status(405).json({ error: 'method not allowed' });
  } catch (e) {
    console.error('storage api error:', e);
    return res.status(500).json({ error: 'storage error' });
  }
}
