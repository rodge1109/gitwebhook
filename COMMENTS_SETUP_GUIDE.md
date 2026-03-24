# 📊 Comments Collection & Sentiment Analysis Setup Guide

## Overview

This guide explains how to collect Facebook comments, perform sentiment analysis using Gemini AI, save them to Google Sheets, and email reports to designated recipients.

## Features Implemented

✅ **Comment Collection** - Automatically collects comments from Facebook posts  
✅ **Sentiment Analysis** - Uses Gemini AI to analyze comment sentiment (Positive/Negative/Neutral)  
✅ **Google Sheet Storage** - Saves all comments with metadata to a "Comments" tab  
✅ **Automated Email Reports** - Sends sentiment analysis reports via email  
✅ **Scheduled Daily Reports** - Runs at 9 AM UTC daily  
✅ **Milestone Reports** - Sends reports every 10, 50, 100+ comments  

---

## Step 1: Configure Email (Gmail Example)

### For Gmail:

1. **Enable 2-Factor Authentication**:
   - Go to https://myaccount.google.com/security
   - Enable 2-Step Verification

2. **Generate App Password**:
   - Go to https://myaccount.google.com/apppasswords
   - Select "Mail" and "Windows Computer"
   - Google will generate a 16-character password
   - Copy this password

3. **Update `.env` file**:

```bash
# Email Configuration
SMTP_HOST=smtp.gmail.com
SMTP_PORT=587
SMTP_USER=your-email@gmail.com
SMTP_PASSWORD=xxxx xxxx xxxx xxxx    # (16-char app password from step 2)
EMAIL_FROM=your-email@gmail.com
EMAIL_RECIPIENTS=admin@example.com,manager@example.com
```

### For Other Email Providers:

**Microsoft Outlook/Office365:**
```bash
SMTP_HOST=smtp.office365.com
SMTP_PORT=587
SMTP_USER=your-email@outlook.com
SMTP_PASSWORD=your-password
```

**SendGrid:**
```bash
SMTP_HOST=smtp.sendgrid.net
SMTP_PORT=587
SMTP_USER=apikey
SMTP_PASSWORD=SG.xxxxxxxxxxxxx
```

---

## Step 2: Configure Google Sheets

### Option A: Use Existing Sheet (Recommended)

Your existing `SHEET_ID` in `.env` will automatically create a "Comments" tab. No action needed!

### Option B: Use Separate Sheet for Comments

1. Create a new Google Sheet
2. Copy its Sheet ID from the URL: `https://docs.google.com/spreadsheets/d/**SHEET_ID**/edit`
3. Add to `.env`:

```bash
COMMENTS_SHEET_ID=1xxxxxxxxxxxxx  # Your new sheet ID
```

4. Grant access:
   - Share the sheet with the service account email (found in `service-account.json`)
   - Run the server once to auto-create the "Comments" tab

---

## Step 3: Verify Gemini API Key

Your `GEMINI_API_KEY` is already configured in `.env`. Verify it's correct:

```bash
GEMINI_API_KEY='AIzaSyD3wUysN8P-hkkEsujKpQ0BZ84nmgNc0r4'
```

❓ **No API Key?**
1. Go to https://ai.google.dev/
2. Click "Get API Key"
3. Create a new project or select existing
4. Generate an API key
5. Update `.env` with your key

---

## Step 4: Start the Server

```bash
npm install  # Install nodemailer
npm start
```

You should see:
```
✅ Google Sheets auth initialized
✅ Gemini AI initialized
✅ Email transporter initialized
```

---

## How It Works

### 1. **Comment Detection** (Automatic)
- Your webhook receives Facebook comment notifications
- System extracts: timestamp, comment text, sender ID/name, post ID

### 2. **Sentiment Analysis** (Automatic)
- Gemini AI analyzes each comment
- Returns: **Sentiment** (POSITIVE/NEGATIVE/NEUTRAL), **Score** (0-1), **Reason**

### 3. **Data Storage** (Automatic)
- Comments saved to Google Sheet with columns:
  - Timestamp, Page ID, Comment ID, Post ID
  - Sender ID, Sender Name, Comment Text
  - Sentiment, Sentiment Score, Sentiment Reason

### 4. **Email Reports** (Automatic)
- **Daily Report**: 9 AM UTC (past 24 hours)
- **Milestone Reports**: Every 10, 50, 100 comments

### Report Contents:
- Total comments analyzed
- Sentiment breakdown (%): Positive, Negative, Neutral
- Average sentiment score
- Sample of 20 most recent comments

---

## Manual Report Trigger

To send a report on-demand via API:

```bash
curl -X POST http://localhost:3000/send-sentiment-report
```

---

## Google Sheet Structure

Once running, your "Comments" sheet will have this structure:

| Timestamp | Page ID | Comment ID | Post ID | Sender ID | Sender Name | Comment Text | Sentiment | Score | Reason |
|-----------|---------|-----------|---------|-----------|------------|--------------|-----------|-------|--------|
| 2024-01-15 10:30:45 | 123456 | c789 | p456 | u123 | John Doe | Great product! | POSITIVE | 0.95 | Positive language |
| 2024-01-15 10:31:02 | 123456 | c790 | p456 | u124 | Jane Smith | Not satisfied. | NEGATIVE | 0.88 | Negative sentiment |

---

## Troubleshooting

### ❌ "Email transporter not configured"
- Check `.env` has all email fields filled
- Verify SMTP_USER and SMTP_PASSWORD are correct
- For Gmail: Ensure you used the 16-char app password (not regular password)

### ❌ "Gemini AI not initialized"
- Verify `GEMINI_API_KEY` in `.env` is correct
- No quotes needed in the actual code (quotes are just for `.env`)
- Check API key is not expired

### ❌ "Unable to parse range 'Comments!A:J'"
- Server will auto-create the sheet on first use
- Wait for log: `✅ Comment saved to new "Comments" sheet`

### ❌ "No comments appearing"
- Ensure webhook is subscribed to "feed" events
- Check logs: `POST /webhook` should show feed changes
- Run: `curl http://localhost:3000/subscribe-feed`

### ❌ "Email not being sent"
- Check "EMAIL_RECIPIENTS" is comma-separated with no spaces before email
- Verify Gmail security settings allow app access
- Check spam/junk folder

---

## Environment Variables Reference

```bash
# Required for comments
GEMINI_API_KEY=your-gemini-key
SHEET_ID=your-sheet-id
PAGE_ACCESS_TOKEN=your-facebook-token

# Optional: Separate comments sheet
COMMENTS_SHEET_ID=different-sheet-id

# Email Configuration (Required for reports)
SMTP_HOST=smtp.gmail.com
SMTP_PORT=587
SMTP_USER=sender@gmail.com
SMTP_PASSWORD=app-password
EMAIL_FROM=sender@gmail.com
EMAIL_RECIPIENTS=email1@domain.com,email2@domain.com
```

---

## API Endpoints

### Trigger Manual Sentiment Report
```
POST /send-sentiment-report
```

### Check Comment Count
```
GET /comment-stats
```

### Trigger Daily Report (testing)
```
POST /trigger-daily-report
```

---

## Example Logs

When a comment is received:

```
💬 Comment received on post p456
   Comment ID: c789
   From: u123
   Text: Great service!
👤 Sender: John Doe (u123)
🔍 Starting sentiment analysis...
📊 Sentiment Result: POSITIVE (Score: 0.95)
✅ Comment saved to sheet: c789
📧 Comment milestone reached (50 comments). Sending report...
✅ Sentiment report email sent to: admin@example.com, manager@example.com
```

---

## Customization

### Change Daily Report Time

Edit `scheduleDailySentimentReport()` function:

```javascript
if (now.getHours() === 9 && now.getMinutes() < 5) {  // Change 9 to desired hour (0-23 UTC)
```

### Change Report Recipients

Update `.env`:
```bash
EMAIL_RECIPIENTS=new-email@domain.com,another@domain.com
```

### Change Milestone Frequency

Edit comment handling section:
```javascript
if (commentCount > 0 && (commentCount % 50 === 0)) {  // Change 10 to desired interval
```

### Customize Email Template

Edit `sendSentimentReportEmail()` function to modify email format and content.

---

## FAQ

**Q: How often are comments checked?**  
A: In real-time as they come in via webhook. Also receives backfill for 4-hour old comments.

**Q: Can I filter negative comments only?**  
A: Yes! Modify the report generation to include only comments where `sentiment === 'NEGATIVE'`

**Q: Is data stored securely?**  
A: Comments are in your Google Sheet (you control permissions), Gemini API calls are encrypted.

**Q: What if Gemini API fails?**  
A: Comment is still saved with `sentiment: 'UNKNOWN'`. No email alert is sent to prevent spam.

**Q: Can I archive old comments?**  
A: Yes, manually archive the "Comments" sheet and create a new one.

---

## Support

For issues:
1. Check the logs: `npm start`
2. Verify all `.env` variables are set
3. Test email separately: `curl -X POST http://localhost:3000/send-sentiment-report`
4. Ensure webhook is configured in Facebook Developer console

---

**Last Updated**: January 2025  
**Version**: 1.0.0
