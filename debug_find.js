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
    console.log("Rows:");
    rows.forEach(r => console.log("Row ID:", r[0], "Length:", r[0] ? r[0].length : 0));
    
    console.log("\\nSearching for:", pageId, "Length:", pageId.length);
    const config = rows.find(row => row[0] === pageId);

    if (!config) {
       console.log("NOT FOUND!");
       // Let's do a loose match to see what's wrong
       const loose = rows.find(row => String(row[0]).trim() == String(pageId).trim());
       if (loose) {
         console.log("Found loosely! Exact string chars:");
         for(let i=0; i<loose[0].length; i++) console.log(loose[0].charCodeAt(i));
         console.log("Target string chars:");
         for(let i=0; i<pageId.length; i++) console.log(pageId.charCodeAt(i));
       }
       return null;
    }

    console.log("FOUND EXACTLY!");
    console.log("config[2] (keywords):", config[2], "Length:", config[2] ? config[2].length : 0);
    console.log("config[3] (booking):", config[3], "Length:", config[3] ? config[3].length : 0);
    return config;
  } catch (err) {
    console.error('Error fetching page config:', err);
    return null;
  }
}

initGoogle();
getPageConfig('1163897463662109');
