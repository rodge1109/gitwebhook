 const request = require('request');

const testPayload = {
  object: 'page',
  entry: [{
    id: '1163897463662109', // Your page ID from Google Sheet
    messaging: [{
      sender: { id: 'test-user-123' },
      message: { text: 'hello' } // Try a keyword from your sheet
    }]
  }]
};

request(
  {
    uri: 'http://localhost:3000/webhook',
    method: 'POST',
    json: testPayload
  },
  (err, res, body) => {
    if (!err && res.statusCode === 200) {
      console.log('✅ Test passed:', res.statusCode);
    } else {
      console.error('❌ Test failed:', err || body);
    }
  }
);