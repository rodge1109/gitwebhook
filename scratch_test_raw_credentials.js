require('dotenv').config();
const { google } = require('googleapis');
const { JWT } = require('google-auth-library');

async function testCredentials() {
  try {
    const raw = process.env.GOOGLE_CREDENTIALS_BASE64;
    if (!raw) {
      console.error('Missing GOOGLE_CREDENTIALS_BASE64');
      return;
    }
    const decoded = Buffer.from(raw.trim().replace(/^['"]|['"]$/g, ''), 'base64').toString();
    const credentials = JSON.parse(decoded);
    
    console.log('Client Email:', credentials.client_email);
    console.log('Project ID:', credentials.project_id);
    
    // Explicitly use JWT client to force authentication using ONLY the private key
    const client = new JWT({
      email: credentials.client_email,
      key: credentials.private_key,
      scopes: ['https://www.googleapis.com/auth/spreadsheets'],
    });

    console.log('Attempting to authorize...');
    await client.authorize();
    console.log('✅ Authentication SUCCESS! The credentials are valid.');
  } catch (error) {
    console.error('❌ Authentication FAILED using credentials:', error.message);
  }
}

testCredentials();
