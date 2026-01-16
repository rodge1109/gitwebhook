 const { google } = require('googleapis');
const credentials = require('./service-account.json');
const SHEET_ID = '1MtOw4N2AzrvCya3HI0kRB0ll-PQingLOtoddm9UerkU';

async function testSheet() {
  const auth = new google.auth.GoogleAuth({
    credentials,
    scopes: ['https://www.googleapis.com/auth/spreadsheets.readonly'],
  });
  const client = await auth.getClient();
  const sheets = google.sheets({ version: 'v4', auth: client });

  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: SHEET_ID,
    range: 'KeywordsDM!A:B',
  });

  console.log(res.data.values);
}

testSheet();
