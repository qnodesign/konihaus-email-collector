require('dotenv').config();
const express = require('express');
const cors = require('cors');
const { S3Client, GetObjectCommand, PutObjectCommand } = require('@aws-sdk/client-s3');

const app = express();
app.use(express.json());
app.use(cors());

// Email regex pattern (basic validation)
const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// Initialize S3 client
const s3 = new S3Client({
  region: process.env.AWS_REGION || 'us-north-1',
  credentials: {
    accessKeyId: process.env.AWS_ACCESS_KEY_ID,
    secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY
  }
});

const BUCKET_NAME = process.env.S3_BUCKET_NAME || 'email-collector-bucket';
const FILE_KEY = 'emails.json';            // landing page signups
const BLOG_FILE_KEY = 'blog-emails.json';  // blog newsletter signups
const CODES_FILE_KEY = 'codes.json';       // qr key -> promo code (private, never shipped with the website)
const CODE_USAGES_FILE_KEY = 'code-usages.json'; // one entry per page load with a valid qr key (conversion monitoring)
// Usage is only logged for visits coming from these hosts (so localhost / dev testing is not counted)
const CODE_LOG_HOSTS = (process.env.CODE_LOG_HOSTS || 'konihaus.ch,www.konihaus.ch')
  .split(',').map(s => s.trim().toLowerCase()).filter(Boolean);
const SUPPORTED_LANGS = ['de', 'en'];
const DEFAULT_LANG = 'de';

// Get existing entries from an S3 JSON list
async function getListFromS3(key) {
  try {
    const command = new GetObjectCommand({
      Bucket: BUCKET_NAME,
      Key: key
    });
    const data = await s3.send(command);
    const bodyString = await data.Body.transformToString();
    return JSON.parse(bodyString);
  } catch (error) {
    if (error.name === 'NoSuchKey') {
      return [];
    }
    throw error;
  }
}

// Save a list to an S3 JSON file
async function saveListToS3(key, list) {
  const command = new PutObjectCommand({
    Bucket: BUCKET_NAME,
    Key: key,
    Body: JSON.stringify(list, null, 2),
    ContentType: 'application/json'
  });
  await s3.send(command);
}

// Client IP (handle Vercel proxy)
function getClientIp(req) {
  return req.headers['x-forwarded-for']
    ? req.headers['x-forwarded-for'].split(',')[0].trim()
    : req.ip;
}

// "de-CH", "EN", " en " -> "de" / "en"; anything else -> default
function normalizeLanguage(value) {
  if (typeof value !== 'string') return DEFAULT_LANG;
  const lang = value.trim().toLowerCase().slice(0, 2);
  return SUPPORTED_LANGS.includes(lang) ? lang : DEFAULT_LANG;
}

// Validate email format
function isValidEmail(email) {
  return emailRegex.test(email);
}

// Builds a subscribe handler that writes to its own S3 list.
// withLanguage: also store the visitor's language preference (blog newsletter).
function createSubscribeHandler({ fileKey, withLanguage }) {
  return async (req, res) => {
    try {
      const { email, language } = req.body;

      if (!email || typeof email !== 'string') {
        return res.status(400).json({
          success: false,
          message: 'Email is required'
        });
      }

      const trimmedEmail = email.trim().toLowerCase();

      if (!isValidEmail(trimmedEmail)) {
        return res.status(400).json({
          success: false,
          message: 'Invalid email format'
        });
      }

      const clientIp = getClientIp(req);

      // Get existing entries
      const emails = await getListFromS3(fileKey);

      // Check if email already exists
      if (emails.some(entry => entry.email === trimmedEmail)) {
        return res.status(400).json({
          success: false,
          message: 'Email already subscribed'
        });
      }

      // Check IP limit (max 3 emails per IP)
      const emailsFromIp = emails.filter(entry => entry.ipAddress === clientIp).length;
      if (emailsFromIp >= 3) {
        return res.status(429).json({
          success: false,
          message: 'Too many signups from this IP address'
        });
      }

      // Add new entry with timestamp and IP (+ language for the blog)
      const entry = {
        email: trimmedEmail,
        ipAddress: clientIp,
        subscribedAt: new Date().toISOString()
      };
      if (withLanguage) entry.language = normalizeLanguage(language);
      emails.push(entry);

      // Save back to S3
      await saveListToS3(fileKey, emails);

      res.status(200).json({
        success: true,
        message: 'Email subscribed successfully'
      });
    } catch (error) {
      console.error('Error:', error);
      res.status(500).json({
        success: false,
        message: 'Server error'
      });
    }
  };
}

// Landing page signup -> emails.json (unchanged behaviour)
app.post('/api/subscribe', createSubscribeHandler({ fileKey: FILE_KEY, withLanguage: true }));

// Blog newsletter signup -> blog-emails.json (with language preference)
app.post('/api/blog-subscribe', createSubscribeHandler({ fileKey: BLOG_FILE_KEY, withLanguage: true }));

// ---- Promo codes: GET /api/getcode?str=<qr-key> -> { success: true, code } -------------
// codes.json lives in S3, not in the website. Only an exact key match returns a code;
// anything else gets { success: false } with HTTP 200 (a 404 would be logged as an error in the browser console).
const CODES_CACHE_MS = 5 * 60 * 1000; // edits to codes.json show up within 5 minutes
let codesCache = { data: null, at: 0 };

async function getCodes() {
  if (codesCache.data && Date.now() - codesCache.at < CODES_CACHE_MS) return codesCache.data;
  let data = {};
  try {
    const out = await s3.send(new GetObjectCommand({ Bucket: BUCKET_NAME, Key: CODES_FILE_KEY }));
    const parsed = JSON.parse(await out.Body.transformToString());
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) data = parsed;
  } catch (error) {
    if (error.name !== 'NoSuchKey') throw error;
  }
  codesCache = { data, at: Date.now() };
  return data;
}

// Best-effort rate limit per IP (in memory, so per serverless instance) to slow down key guessing
const codeHits = new Map();
function codeRateLimited(ip) {
  const now = Date.now();
  const recent = (codeHits.get(ip) || []).filter(t => now - t < 60 * 1000);
  recent.push(now);
  codeHits.set(ip, recent);
  if (codeHits.size > 5000) codeHits.clear();
  return recent.length > 30;
}

// Appends { ip, time, code } to code-usages.json. Uses S3 conditional writes (ETag) with a few retries so two
// simultaneous visitors don't overwrite each other's entry. Never throws and never overwrites a file it can't
// read as a JSON array: tracking must not break the page.
async function logCodeUsage(entry) {
  const MAX_ATTEMPTS = 5;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      let list = [];
      let etag;
      try {
        const out = await s3.send(new GetObjectCommand({ Bucket: BUCKET_NAME, Key: CODE_USAGES_FILE_KEY }));
        list = JSON.parse(await out.Body.transformToString());
        etag = out.ETag;
      } catch (error) {
        if (error.name !== 'NoSuchKey') throw error;
      }
      if (!Array.isArray(list)) throw new Error(`${CODE_USAGES_FILE_KEY} is not a JSON array`);
      list.push(entry);
      await s3.send(new PutObjectCommand({
        Bucket: BUCKET_NAME,
        Key: CODE_USAGES_FILE_KEY,
        Body: JSON.stringify(list, null, 2),
        ContentType: 'application/json',
        ...(etag ? { IfMatch: etag } : { IfNoneMatch: '*' })
      }));
      return;
    } catch (error) {
      const status = error.$metadata && error.$metadata.httpStatusCode;
      const conflict = error.name === 'PreconditionFailed' || error.name === 'ConditionalRequestConflict' || status === 412 || status === 409;
      if (!conflict || attempt === MAX_ATTEMPTS) {
        console.error('Code usage log failed:', error);
        return;
      }
      await new Promise(resolve => setTimeout(resolve, 20 + Math.random() * 100)); // someone else wrote first: retry
    }
  }
}

// True when the browser says the request comes from the live website (Origin header, Referer as fallback).
// Exact host match over https only. This filters dev noise; it is not a security check (headers can be faked).
function isLoggableOrigin(req) {
  const source = req.headers.origin || req.headers.referer;
  if (!source) return false;
  try {
    const url = new URL(source);
    return url.protocol === 'https:' && CODE_LOG_HOSTS.includes(url.hostname.toLowerCase());
  } catch (error) {
    return false;
  }
}

app.get('/api/getcode', async (req, res) => {
  res.set('Cache-Control', 'no-store');
  try {
    if (codeRateLimited(getClientIp(req))) {
      return res.status(429).json({ success: false });
    }
    const str = typeof req.query.str === 'string' ? req.query.str.trim().toLowerCase() : '';
    if (!/^[a-z0-9-]{1,80}$/.test(str)) {
      return res.status(200).json({ success: false });
    }
    const codes = await getCodes();
    if (!Object.hasOwn(codes, str) || typeof codes[str] !== 'string') {
      return res.status(200).json({ success: false });
    }
    // Valid key: record the visit, but only if it comes from konihaus.ch (awaited, because Vercel freezes the
    // function once the response is sent). The code itself is returned to every caller, so localhost testing works.
    if (isLoggableOrigin(req)) {
      await logCodeUsage({ ip: getClientIp(req), time: new Date().toISOString(), code: str });
    }
    res.status(200).json({ success: true, code: codes[str] });
  } catch (error) {
    console.error('Error:', error);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// Root endpoint
app.get('/', (req, res) => {
  res.status(200).json({ status: 'ok' });
});

// Health check
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok' });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});