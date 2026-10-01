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
app.post('/api/subscribe', createSubscribeHandler({ fileKey: FILE_KEY, withLanguage: false }));

// Blog newsletter signup -> blog-emails.json (with language preference)
app.post('/api/blog-subscribe', createSubscribeHandler({ fileKey: BLOG_FILE_KEY, withLanguage: true }));

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