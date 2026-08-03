require('dotenv').config();
const { google } = require('googleapis');

let sheets;
function initGoogle() {
  const decoded = Buffer.from(process.env.GOOGLE_CREDENTIALS_BASE64, 'base64').toString();
  const credentials = JSON.parse(decoded);
  const auth = new google.auth.GoogleAuth({
    credentials,
    scopes: ['https://www.googleapis.com/auth/spreadsheets'],
  });
  sheets = google.sheets({ version: 'v4', auth });
}

async function getPageConfig(pageId) {
  try {
    const res = await sheets.spreadsheets.values.get({
      spreadsheetId: process.env.SHEET_ID,
      range: 'WebhookConfig!A:D',
    });

    const rows = res.data.values || [];
    console.log("Total rows fetched:", rows.length);
    
    // Exact logic from server.js
    const config = rows.find(row => String(row[0]).trim() === String(pageId).trim());

    if (!config) {
      console.log("Config not found!");
      return null;
    }

    const result = {
      pageId: config[0],
      pageToken: config[1],
      keywordsSheetId: config[2],
      bookingSheetId: config[3] || config[2],
    };
    
    console.log("Result object:", result);
    return result;
  } catch (err) {
    console.error('Error fetching page config:', err);
    return null;
  }
}

initGoogle();
getPageConfig('1163897463662109'); // passing as string
getPageConfig(1163897463662109);   // passing as number
