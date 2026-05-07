# Email Collector API

Simple API to collect and validate email addresses for your service launch.

## Features

- Email validation (basic format check)
- Store emails in AWS S3
- Duplicate prevention
- Timestamp tracking
- CORS enabled for frontend integration

## Setup

### 1. Install Dependencies

```bash
npm install
```

### 2. Configure Environment

Copy `.env.example` to `.env` and fill in your AWS credentials:

```bash
cp .env.example .env
```

```
PORT=3000
AWS_ACCESS_KEY_ID=your_key_here
AWS_SECRET_ACCESS_KEY=your_secret_here
AWS_REGION=us-east-1
S3_BUCKET_NAME=email-collector-bucket
```

### 3. Create AWS S3 Bucket

1. Log in to [AWS Console](https://console.aws.amazon.com/)
2. Create a new S3 bucket (e.g., `email-collector-bucket`)
3. Generate an IAM user with S3 access and get the access key/secret

### 4. Run Locally

```bash
npm run dev
```

Server runs on `http://localhost:3000`

## API Endpoint

### POST /api/subscribe

Subscribe an email to your launch list.

**Request:**
```json
{
  "email": "user@example.com"
}
```

**Success Response (200):**
```json
{
  "success": true,
  "message": "Email subscribed successfully"
}
```

**Error Responses:**
- `400` - Invalid email format or already subscribed
- `500` - Server error

### GET /api/health

Health check endpoint.

## Deployment to Vercel

### 1. Push to Git

```bash
git init
git add .
git commit -m "Initial commit"
git remote add origin https://github.com/yourusername/email-collector.git
git push -u origin main
```

### 2. Deploy to Vercel

1. Go to [vercel.com](https://vercel.com)
2. Click "New Project"
3. Import your GitHub repository
4. Add environment variables in Settings:
   - `AWS_ACCESS_KEY_ID`
   - `AWS_SECRET_ACCESS_KEY`
   - `AWS_REGION`
   - `S3_BUCKET_NAME`
5. Click Deploy

Your API will be live at `https://your-project.vercel.app`

## Example Frontend Usage

```javascript
const email = 'user@example.com';

fetch('https://your-project.vercel.app/api/subscribe', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ email })
})
.then(res => res.json())
.then(data => console.log(data));
```

## File Storage

Emails are stored in AWS S3 as a JSON file with timestamps:

```json
[
  {
    "email": "user1@example.com",
    "subscribedAt": "2026-05-07T10:30:00.000Z"
  },
  {
    "email": "user2@example.com",
    "subscribedAt": "2026-05-07T10:35:00.000Z"
  }
]
```

Access your emails anytime from the S3 console or programmatically via AWS SDK.
