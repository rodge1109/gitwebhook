# 🚀 Quick Start: Comments + Sentiment Analysis

## What Was Added?

✅ **Comment Collection System** - Automatically captures Facebook comments  
✅ **Gemini AI Sentiment Analysis** - Analyzes sentiment (Positive/Negative/Neutral)  
✅ **Google Sheets Storage** - Creates "Comments" tab automatically  
✅ **Email Reports** - Sends sentiment analysis via email  
✅ **API Endpoints** - Manual report triggers and data export  

---

## 5-Minute Setup

### 1. Gmail Configuration (Required for Email)

```bash
# In your .env file, find and update:

SMTP_HOST=smtp.gmail.com
SMTP_PORT=587
SMTP_USER=your-email@gmail.com          # Your Gmail address
SMTP_PASSWORD=xxxx xxxx xxxx xxxx       # 16-char app password (see below)
EMAIL_FROM=your-email@gmail.com
EMAIL_RECIPIENTS=boss@company.com,manager@company.com
```

**Get Gmail App Password:**
1. Go to: https://myaccount.google.com/apppasswords
2. Select Mail + Windows Computer
3. Copy the 16-character password
4. Paste into SMTP_PASSWORD above

### 2. Install Dependencies

```bash
npm install
```

### 3. Start Server

```bash
npm start
```

**You should see:**
```
✅ Google Sheets auth initialized
✅ Gemini AI initialized  
✅ Email transporter initialized
```

---

## That's It! How to Use

### Real-Time Comment Monitoring

- Comments are automatically detected when posted on your Facebook page
- Each comment is:
  1. Analyzed for sentiment using Gemini AI
  2. Saved to your "Comments" sheet in Google Sheets
  3. Included in daily email reports

### Check Comment Stats

```bash
curl http://localhost:3000/comment-stats
```

**Response:**
```json
{
  "totalComments": 156,
  "sentimentBreakdown": {
    "positive": 87,
    "negative": 45,
    "neutral": 24,
    "unknown": 0
  },
  "percentages": {
    "positive": "55.8%",
    "negative": "28.8%",
    "neutral": "15.4%"
  },
  "averageSentimentScore": "0.72"
}
```

### Send Report Manually

```bash
curl -X POST http://localhost:3000/send-sentiment-report
```

### Export All Comments

```bash
curl http://localhost:3000/comments-export
```

### Check Google Sheet

Comments are stored in your Google Sheet: 
- **Sheet Tab:** "Comments"
- **Columns:** Timestamp, Page ID, Sender, Comment Text, Sentiment, Score

---

## Understanding the Sentiment Analysis

Each comment gets analyzed for **Sentiment** and **Score**:

| Sentiment | Score | Meaning |
|-----------|-------|---------|
| 🟢 POSITIVE | 0.7-1.0 | Good feedback, happy customers |
| 🔴 NEGATIVE | 0-0.4 | Complaints, dissatisfaction |
| 🟡 NEUTRAL | 0.4-0.7 | Question, information, no opinion |
| ❓ UNKNOWN | 0 | Analysis failed |

---

## Email Report Contents

**Sent Daily at 9 AM UTC** (you can change this)

Include:
- Total comments analyzed
- Sentiment breakdown (%)
- Average sentiment score  
- Last 20 comments with sentiments

**Recipients:** Configured in `EMAIL_RECIPIENTS`

---

## Files Changed/Created

```
Modified:
  ✏️ package.json              (added nodemailer)
  ✏️ .env                      (added email config)
  ✏️ server.js                 (added 400+ lines of code)

Created:
  📄 COMMENTS_SETUP_GUIDE.md   (detailed guide)
  📄 QUICK_START.md            (this file)
```

---

## Troubleshooting

### Email not sending?
```bash
# Check your email settings work
curl -X POST http://localhost:3000/send-sentiment-report
```
- Verify Gmail app password is correct (not your regular password!)
- Check spam folder
- Ensure EMAIL_RECIPIENTS is comma-separated without spaces

### No comments appearing?
```bash
# Subscribe to feed events
curl http://localhost:3000/subscribe-feed
```
Refresh Facebook page and post a new comment to test.

### AI analysis not working?
- Verify GEMINI_API_KEY in .env is not empty
- Check API key hasn't expired at https://ai.google.dev/

### "Comments" sheet not created?
- It creates automatically on first comment
- If not appearing, check Google Sheets permissions
- Verify service account has access to the sheet

---

## Environment Variables

| Variable | Example | Purpose |
|----------|---------|---------|
| GEMINI_API_KEY | AIza... | Sentiment analysis |
| SHEET_ID | 1Qk5... | Main data storage |
| COMMENTS_SHEET_ID | (optional) | Separate comments sheet |
| SMTP_HOST | smtp.gmail.com | Email provider |
| SMTP_USER | your@gmail.com | Email address |
| SMTP_PASSWORD | xxxx xxxx | App password |
| EMAIL_FROM | your@gmail.com | Sender address |
| EMAIL_RECIPIENTS | admin@x.com,boss@x.com | Report recipients |

---

## Next Steps

1. ✅ Update `.env` with email config
2. ✅ Run `npm install`
3. ✅ Run `npm start`
4. ✅ Post a comment on your Facebook page
5. ✅ Check your "Comments" sheet
6. ✅ Test email: `curl -X POST http://localhost:3000/send-sentiment-report`

---

## API Reference

### Endpoints

```
GET  /comment-stats              - Comment statistics & sentiment breakdown
POST /send-sentiment-report      - Manually trigger email report
GET  /trigger-daily-report       - Test daily report (24h comments)
GET  /comments-export            - Export all comments as JSON
GET  /subscribe-feed             - Subscribe to feed events
```

---

## Features by Example

**When someone comments: "Great service, highly recommend!"**
- ✅ Comment extracted: "Great service, highly recommend!"
- ✅ Sentiment analyzed: POSITIVE (score: 0.98)
- ✅ Saved to sheet with timestamp
- ✅ Included in next daily email report

**When someone comments: "Poor quality, wasted money"**
- ✅ Comment extracted: "Poor quality, wasted money"  
- ✅ Sentiment analyzed: NEGATIVE (score: 0.15)
- ✅ Saved to sheet with timestamp
- ✅ Highlighted in daily email as negative feedback

---

## Support & Customization

See **COMMENTS_SETUP_GUIDE.md** for:
- Advanced email setup (Outlook, SendGrid, etc.)
- Changing report schedule
- Customizing email template
- Filtering specific sentiments
- Archiving old comments

---

**Ready? Start here:**
```bash
cd c:\Users\ADMIN\messenger-webhook
npm start
```

Then visit:
- **Google Sheet:** Your existing sheet (Comments tab will auto-create)
- **Stats:** http://localhost:3000/comment-stats
- **Manual Report:** curl -X POST http://localhost:3000/send-sentiment-report
