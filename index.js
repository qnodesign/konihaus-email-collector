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
  region: process.env.AWS_REGION || 'us-east-1',
  credentials: {
    accessKeyId: process.env.AWS_ACCESS_KEY_ID,
    secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY
  }
});

const BUCKET_NAME = process.env.S3_BUCKET_NAME || 'email-collector-bucket';
const FILE_KEY = 'emails.json';

// Get existing emails from S3
async function getEmailsFromS3() {
  try {
    const command = new GetObjectCommand({
      Bucket: BUCKET_NAME,
      Key: FILE_KEY
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

// Save emails to S3
async function saveEmailsToS3(emails) {
  const command = new PutObjectCommand({
    Bucket: BUCKET_NAME,
    Key: FILE_KEY,
    Body: JSON.stringify(emails, null, 2),
    ContentType: 'application/json'
  });
  await s3.send(command);
}

// Validate email format
function isValidEmail(email) {
  return emailRegex.test(email);
}

// Subscribe endpoint
app.post('/api/subscribe', async (req, res) => {
  try {
    const { email } = req.body;

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

    // Get existing emails
    const emails = await getEmailsFromS3();

    // Check if email already exists
    if (emails.some(entry => entry.email === trimmedEmail)) {
      return res.status(400).json({
        success: false,
        message: 'Email already subscribed'
      });
    }

    // Add new email with timestamp
    emails.push({
      email: trimmedEmail,
      subscribedAt: new Date().toISOString()
    });

    // Save back to S3
    await saveEmailsToS3(emails);

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
