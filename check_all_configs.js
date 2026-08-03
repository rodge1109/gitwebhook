require('dotenv').config();
const { google } = require('googleapis');

let sheets;
function initGoogle() {
  try {
    const decoded = Buffer.from(process.env.GOOGLE_CREDENTIALS_BASE64, 'base64').toString();
    const credentials = JSON.parse(decoded);
    const auth = new google.auth.GoogleAuth({
      credentials,
      scopes: ['https://www.googleapis.com/auth/spreadsheets'],
    });
    sheets = google.sheets({ version: 'v4', auth });
  } catch (err) {
    console.error('Google Sheets auth failed:', err.message);
  }
}

async function checkAllConfigs() {
  try {
    const res = await sheets.spreadsheets.values.get({
      spreadsheetId: process.env.SHEET_ID,
      range: 'WebhookConfig!A:D',
    });
    const rows = res.data.values || [];
    console.log('--- ALL WEBHOOK CONFIG ROWS ---');
    rows.forEach((row, i) => {
      console.log('Row ' + (i+1) + ':');
      console.log('  Page ID: "' + row[0] + '" (length: ' + (row[0] ? row[0].length : 0) + ')');
      console.log('  Page Token: "' + (row[1] ? row[1].substring(0,10) + '...' : '') + '"');
      console.log('  Keywords ID: "' + row[2] + '" (length: ' + (row[2] ? row[2].length : 0) + ')');
      console.log('  Booking ID: "' + row[3] + '" (length: ' + (row[3] ? row[3].length : 0) + ')');
    });
    console.log('-------------------------------');
  } catch (err) {
    console.error('Error fetching sheet:', err.message);
  }
}

initGoogle();
checkAllConfigs();
