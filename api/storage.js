import { Redis } from '@upstash/redis';

// Vercel's Upstash integration has historically injected env vars under the
// legacy "KV_REST_API_*" names (kept for backward compatibility with the old
// Vercel KV product) as well as Upstash's own "UPSTASH_REDIS_REST_*" names,
// depending on how the integration was installed. We check both so this
// works regardless of which one shows up in your project's Environment
// Variables settings.
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

export default async function handler(req, res) {
  try {
    if (req.method === 'GET') {
      const { key, prefix } = req.query;

      if (prefix !== undefined) {
        const keys = await redis.keys(`${prefix}*`);
        return res.status(200).json({ keys });
      }

      if (!key) return res.status(400).json({ error: 'key is required' });
      const value = await redis.get(key);
      if (value === null || value === undefined) {
        return res.status(404).json({ error: 'not found' });
      }
      return res.status(200).json({ key, value });
    }

    if (req.method === 'POST') {
      const { key, value } = req.body || {};
      if (!key || typeof value !== 'string') {
        return res.status(400).json({ error: 'key and a string value are required' });
      }
      if (key.length > MAX_KEY_LEN) {
        return res.status(400).json({ error: `key must be under ${MAX_KEY_LEN} characters` });
      }
      if (Buffer.byteLength(value, 'utf8') > MAX_VALUE_BYTES) {
        return res.status(400).json({ error: 'value exceeds 5MB limit' });
      }
      await redis.set(key, value);
      return res.status(200).json({ key, value });
    }

    if (req.method === 'DELETE') {
      const { key } = req.query;
      if (!key) return res.status(400).json({ error: 'key is required' });
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

        
