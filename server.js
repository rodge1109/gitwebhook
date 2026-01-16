 // server.js
require('dotenv').config();
const express = require('express');
const bodyParser = require('body-parser');
const { google } = require('googleapis');
const request = require('request');

const app = express();
app.use(bodyParser.json());

/* =======================
   GOOGLE SHEETS SETUP
======================= */

let sheets;

try {
  const credentials = process.env.GOOGLE_CREDENTIALS
    ? JSON.parse(process.env.GOOGLE_CREDENTIALS.replace(/\\n/g, '\n'))
    : require('./credentials.json'); // local fallback

  const auth = new google.auth.GoogleAuth({
    credentials,
    scopes: [
      'https://www.googleapis.com/auth/spreadsheets',
      'https://www.googleapis.com/auth/spreadsheets.readonly',
    ],
  });

  sheets = google.sheets({ version: 'v4', auth });
  console.log('✅ Google Sheets auth initialized');
} catch (err) {
  console.error('❌ Google Sheets auth failed');
  console.error(err.message);
}

/* =======================
   HEALTH CHECK (RENDER)
======================= */

app.get('/health', async (req, res) => {
  if (!sheets) {
    return res.status(500).json({
      status: 'ERROR',
      sheets: false,
      message: 'Google Sheets not initialized'
    });
  }

  try {
    await sheets.spreadsheets.get({
      spreadsheetId: process.env.SHEET_ID,
    });

    res.json({
      status: 'OK',
      sheets: true
    });
  } catch (err) {
    res.status(500).json({
      status: 'ERROR',
      sheets: false,
      error: err.message
    });
  }
});

/* =======================
   UTILITIES
======================= */

const bookingSessions = {};
const keywordsCache = {};

/* =======================
   GOOGLE SHEET HELPERS
======================= */

async function getPageConfig(pageId) {
  if (!sheets) return null;

  try {
    const res = await sheets.spreadsheets.values.get({
      spreadsheetId: process.env.SHEET_ID,
      range: 'WebhookConfig!A:D',
    });

    const rows = res.data.values || [];
    const config = rows.find(row => row[0] === pageId);

    if (!config) return null;

    return {
      pageId: config[0],
      pageToken: config[1],
      keywordsSheetId: config[2],
      bookingSheetId: config[3] || config[2],
    };
  } catch (err) {
    console.error('Error fetching page config:', err.message);
    return null;
  }
}

async function getKeywords(sheetId, forceRefresh = false) {
  if (!keywordsCache[sheetId] || forceRefresh) {
    const res = await sheets.spreadsheets.values.get({
      spreadsheetId: sheetId,
      range: 'KeywordsDM!A:C',
    });
    keywordsCache[sheetId] = res.data.values || [];
  }
  return keywordsCache[sheetId];
}

async function getBookingConfig(sheetId) {
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: sheetId,
    range: 'BookingConfig!A:D',
  });
  return (res.data.values || []).slice(1);
}

async function saveOrder(psid, data, sheetId) {
  const values = [psid, ...Object.values(data), new Date().toISOString()];

  await sheets.spreadsheets.values.append({
    spreadsheetId: sheetId,
    range: 'ConfirmedOrders!A:Z',
    valueInputOption: 'RAW',
    resource: { values: [values] },
  });
}

/* =======================
   MESSENGER HELPERS
======================= */

function sendTyping(psid, token) {
  request({
    uri: `https://graph.facebook.com/${process.env.GRAPH_API_VERSION}/me/messages`,
    qs: { access_token: token },
    method: 'POST',
    json: {
      recipient: { id: psid },
      sender_action: 'typing_on',
    },
  });
}

function callSendAPI(psid, text, token) {
  request({
    uri: `https://graph.facebook.com/${process.env.GRAPH_API_VERSION}/me/messages`,
    qs: { access_token: token },
    method: 'POST',
    json: {
      recipient: { id: psid },
      message: { text },
    },
  });
}

/* =======================
   WEBHOOK VERIFY
======================= */

app.get('/webhook', (req, res) => {
  const VERIFY_TOKEN = process.env.VERIFY_TOKEN;
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];

  if (mode === 'subscribe' && token === VERIFY_TOKEN) {
    return res.status(200).send(challenge);
  }

  res.sendStatus(403);
});

/* =======================
   WEBHOOK RECEIVE
======================= */

app.post('/webhook', async (req, res) => {
  const body = req.body;

  if (body.object !== 'page') return res.sendStatus(404);

  for (const entry of body.entry) {
    const pageId = entry.id;
    const config = await getPageConfig(pageId);

    if (!config) {
      console.error(`No config found for page ${pageId}`);
      continue;
    }

    for (const msg of entry.messaging) {
      if (!msg.message?.text) continue;

      const psid = msg.sender.id;
      const text = msg.message.text.toLowerCase();

      sendTyping(psid, config.pageToken);

      if (text.includes('order')) {
        callSendAPI(psid, 'Booking started!', config.pageToken);
        continue;
      }

      const keywords = await getKeywords(config.keywordsSheetId);
      const match = keywords.find(r => r[0] && text.includes(r[0].toLowerCase()));

      callSendAPI(
        psid,
        match ? match[1] : "Sorry, I didn't understand that.",
        config.pageToken
      );
    }
  }

  res.sendStatus(200);
});

/* =======================
   SERVER
======================= */

const PORT = process.env.PORT || 3000;
app.listen(PORT, () =>
  console.log(`🚀 Webhook server running on port ${PORT}`)
);
