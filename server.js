   // server.js
 
require('dotenv').config();
const express = require('express');
const bodyParser = require('body-parser');
const { google } = require('googleapis');
const request = require('request');

const app = express();
app.use(bodyParser.json());

const pendingHelpRequests = new Set();
const pausedPages = new Set();
const keywordMissCounters = {};
const greetedUsers = {};
const billSessions = {};
const leakSessions = {};


// google-auth-debug.js
require('dotenv').config();
const { JWT } = require('google-auth-library');

// Read environment variables
const clientEmail = process.env.GOOGLE_CLIENT_EMAIL;
let privateKey = process.env.GOOGLE_PRIVATE_KEY;

// Log what is being read from environment variables
console.log('🔹 GOOGLE_CLIENT_EMAIL:', clientEmail);
console.log('🔹 GOOGLE_PRIVATE_KEY (first 100 chars):', privateKey?.substring(0, 100), '...');

// Replace literal \n with actual newlines
privateKey = privateKey.replace(/\\n/g, '\n');

// Log the formatted key first few lines for sanity check
console.log('🔹 Formatted PRIVATE_KEY (first 3 lines):');
console.log(privateKey.split('\n').slice(0, 3).join('\n'));
console.log('...');

// Initialize JWT client
const jwtClient = new JWT({
  email: clientEmail,
  key: privateKey,
  scopes: ['https://www.googleapis.com/auth/calendar'], // change scope if needed
});

async function getAccessToken() {
  try {
    const tokenResponse = await jwtClient.authorize();

    // Log the token for debugging
    console.log('✅ Access Token received:', tokenResponse.access_token);

    return tokenResponse.access_token;
  } catch (error) {
    console.error('❌ Error fetching access token:', error);

    // Log the raw values being passed for debugging
    console.log('🔹 Debug info:');
    console.log('Email passed to JWT:', clientEmail);
    console.log('Key passed to JWT (first 100 chars):', privateKey.substring(0, 100), '...');

    throw error;
  }
}

// Test immediately
getAccessToken();

async function getAccessToken() {
  try {
    const tokenResponse = await jwtClient.authorize();
    console.log('✅ Access Token:', tokenResponse.access_token);
    return tokenResponse.access_token;
  } catch (error) {
    console.error('❌ Error fetching access token:', error);
    throw error;
  }
}

/**
 * Build a Messenger "web_url" button template attachment.
 * This renders a clickable button that opens a website (not a quick reply).
 */
function buildWebUrlButtonTemplate(text, title, url, webviewHeightRatio = 'full') {
  return {
    type: 'template',
    payload: {
      template_type: 'button',
      text,
      buttons: [
        {
          type: 'web_url',
          title,
          url,
          webview_height_ratio: webviewHeightRatio,
        },
      ],
    },
  };
}

const LEAK_QUESTIONS = [
  { key: 'name',      label: 'Name',                        ask: 'What is your name?',                                   type: 'text' },
  { key: 'contact',   label: 'Contact Number',               ask: 'What is your contact number?',                         type: 'contact' },
  { key: 'location',  label: 'Exact Location of Leak',       ask: 'What is the exact location of the leak?',              type: 'text' },
  { key: 'started',   label: 'When did the leak start?',     ask: 'When did the leak start?',                             type: 'text' },
  { key: 'size',      label: 'Size of Leak',                 ask: 'How would you describe the size of the leak?',         type: 'buttons', options: ['Small', 'Moderate', 'Large'] },
  { key: 'area',      label: 'Location Type',                ask: 'Where is the leak located?',                           type: 'buttons', options: ['Inside Property', 'Street Line'] },
  { key: 'damage',    label: 'Causing Flooding/Damage?',     ask: 'Is it causing flooding or damage?',                    type: 'buttons', options: ['Yes', 'No'] },
  { key: 'photo',     label: 'Photo',                        ask: 'Can you send a photo of the leak? (or type "skip")',   type: 'photo' },
];

// Clean up greeted users older than 24 hours
setInterval(() => {
  const oneDayAgo = Date.now() - (24 * 60 * 60 * 1000);
  Object.keys(greetedUsers).forEach(psid => {
    if (greetedUsers[psid] < oneDayAgo) {
      delete greetedUsers[psid];
      console.log(`👋 Welcome reset for ${psid} (24h expired)`);
    }
  });
}, 60 * 60 * 1000);

// Clean up stale leak sessions older than 30 minutes
setInterval(() => {
  const thirtyMinAgo = Date.now() - (30 * 60 * 1000);
  Object.keys(leakSessions).forEach(psid => {
    if (leakSessions[psid].startedAt < thirtyMinAgo) {
      delete leakSessions[psid];
      console.log(`🧹 Stale leak session cleared for ${psid}`);
    }
  });
}, 10 * 60 * 1000);


/* =======================
   GOOGLE SHEETS SETUP
======================= */

let sheets;

try {
  const credentials = process.env.GOOGLE_CREDENTIALS_BASE64
  ? JSON.parse(Buffer.from(process.env.GOOGLE_CREDENTIALS_BASE64, 'base64').toString())
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
   GEMINI AI (DISABLED)
======================= */

// Gemini AI integration removed. Sentiment analysis is disabled.
let genAI = null;


/* =======================
   NODEMAILER (DISABLED)
======================= */

// Nodemailer/email integration removed. Email reports are disabled.
let emailTransporter = null;


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
   COMMENTS COLLECTION & SENTIMENT ANALYSIS
======================= */

/**
 * Analyze sentiment (DISABLED)
 * Gemini AI integration removed — return neutral placeholder.
 */
async function analyzeSentiment(commentText) {
  console.warn('⚠️ Sentiment analysis disabled. Returning NEUTRAL for:', commentText ? commentText.substring(0,80) : '');
  return { sentiment: 'NEUTRAL', score: 0.5, reason: 'sentiment disabled' };
}

/**
 * Save comment to Google Sheet
 */
async function saveCommentToSheet(pageId, commentData, keywordsSheetId) {
  try {
    // Use the keywords sheet ID (same sheet where keywords/replies are stored)
    const sheetId = keywordsSheetId;
    
    if (!sheetId) {
      console.error('❌ No sheet ID configured for comments');
      return false;
    }

    const timestamp = new Date().toLocaleString('en-US', { timeZone: 'UTC' });
    
    const values = [
      timestamp,
      pageId,
      commentData.commentId,
      commentData.postId,
      commentData.senderId,
      commentData.senderName || 'Unknown',
      commentData.commentText,
      commentData.sentiment,
      commentData.sentimentScore || 0,
      commentData.sentimentReason || ''
    ];

    // Ensure the "Comments" sheet exists
    try {
      await sheets.spreadsheets.values.append({
        spreadsheetId: sheetId,
        range: 'Comments!A:J',
        valueInputOption: 'RAW',
        insertDataOption: 'INSERT_ROWS',
        resource: {
          values: [values],
        },
      });
      console.log(`✅ Comment saved to sheet: ${commentData.commentId}`);
      return true;
    } catch (appendErr) {
      if (appendErr.message && appendErr.message.includes('Unable to parse range')) {
        console.log('📄 Creating "Comments" sheet...');
        
        // Create the Comments sheet
        await sheets.spreadsheets.batchUpdate({
          spreadsheetId: sheetId,
          resource: {
            requests: [
              {
                addSheet: {
                  properties: {
                    title: 'Comments',
                    gridProperties: {
                      rowCount: 1000,
                      columnCount: 10
                    }
                  }
                }
              }
            ]
          }
        });

        // Add headers
        await sheets.spreadsheets.values.update({
          spreadsheetId: sheetId,
          range: 'Comments!A1:J1',
          valueInputOption: 'RAW',
          resource: {
            values: [['Timestamp', 'Page ID', 'Comment ID', 'Post ID', 'Sender ID', 'Sender Name', 'Comment Text', 'Sentiment', 'Sentiment Score', 'Sentiment Reason']]
          }
        });

        // Now append the comment
        await sheets.spreadsheets.values.append({
          spreadsheetId: sheetId,
          range: 'Comments!A:J',
          valueInputOption: 'RAW',
          insertDataOption: 'INSERT_ROWS',
          resource: {
            values: [values],
          },
        });

        console.log(`✅ Comment saved to new "Comments" sheet`);
        return true;
      } else {
        throw appendErr;
      }
    }
  } catch (err) {
    console.error('❌ Error saving comment to sheet:', err.message);
    return false;
  }
}

/**
 * Send sentiment analysis email report
 */
async function sendSentimentReportEmail(comments, recipientEmail = null) {
  console.warn('⚠️ Email reports disabled. sendSentimentReportEmail skipped.');
  return false;
}

/**
 * Get sender name from Facebook Graph API
 */
async function getSenderName(senderId, pageToken) {
  try {
    return new Promise((resolve) => {
      request(
        {
          uri: `https://graph.facebook.com/${process.env.GRAPH_API_VERSION}/${senderId}`,
          qs: { 
            fields: 'name',
            access_token: pageToken 
          },
          method: 'GET'
        },
        (err, res, body) => {
          try {
            if (!err && body) {
              const data = JSON.parse(body);
              resolve(data.name || 'Unknown');
            } else {
              resolve('Unknown');
            }
          } catch {
            resolve('Unknown');
          }
        }
      );
    });
  } catch (err) {
    console.error('Error getting sender name:', err.message);
    return 'Unknown';
  }
}

// Daily sentiment reporting and scheduling removed.
// scheduleDailySentimentReport() was removed per configuration (email/sentiment disabled).

//SMS INTEGRATION
// =======================
// SMS INTEGRATION (Semaphore)
// =======================

async function sendSMS(phoneNumber, message, senderName = null) {
  try {
    const https = require('https');
    const querystring = require('querystring');
    
    console.log('📤 Attempting to send SMS:');
    console.log('   To:', phoneNumber);
    console.log('   API Key:', process.env.SEMAPHORE_API_KEY ? 'Set (' + process.env.SEMAPHORE_API_KEY.substring(0, 10) + '...)' : '❌ NOT SET!');
    console.log('   Sender:', process.env.SEMAPHORE_SENDER_NAME || 'KIARA');
    console.log('   Message length:', message.length, 'characters');
    console.log('   Message preview:', message.substring(0, 100) + '...');
    
    const postData = querystring.stringify({
      apikey: process.env.SEMAPHORE_API_KEY,
      number: phoneNumber,
      message: message,
      sendername: senderName || process.env.SEMAPHORE_SENDER_NAME || 'KIARA'
    });
    
    return new Promise((resolve, reject) => {
      const options = {
        hostname: 'api.semaphore.co',
        port: 443,
        path: '/api/v4/messages',
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          'Content-Length': postData.length
        }
      };
      
      const req = https.request(options, (res) => {
        let data = '';
        
        console.log('📥 Semaphore API Response:');
        console.log('   Status Code:', res.statusCode);
        
        res.on('data', (chunk) => {
          data += chunk;
        });
        
        res.on('end', () => {
          console.log('   Response Body:', data);
          
          try {
            const response = JSON.parse(data);
            
            if (response.message_id || response[0]?.message_id) {
              console.log('✅ SMS sent successfully to:', phoneNumber);
              console.log('   Message ID:', response.message_id || response[0]?.message_id);
              resolve({ success: true, data: response });
            } else {
              console.error('❌ SMS failed!');
              console.error('   Error:', JSON.stringify(response, null, 2));
              resolve({ success: false, data: response });
            }
          } catch (err) {
            console.error('❌ SMS parse error:', err);
            console.error('   Raw response:', data);
            resolve({ success: false, error: err, rawResponse: data });
          }
        });
      });
      
      req.on('error', (err) => {
        console.error('❌ SMS request error:', err.message);
        resolve({ success: false, error: err });
      });
      
      req.write(postData);
      req.end();
    });
  } catch (err) {
    console.error('❌ Error in sendSMS function:', err);
    return { success: false, error: err };
  }
}

function formatBookingSMS(bookingData, config) {
  let name = '';
  let date = '';
  let details = [];
  
  config.forEach((stepConfig) => {
    const [stepNum, question, type] = stepConfig;
    const answer = bookingData[stepNum];
    
    if (!answer || answer === 'N/A') return;
    
    const questionLower = question.toLowerCase();
    
    if (questionLower.includes('name')) {
      name = answer;
    } 
    else if (type === 'date' || questionLower.includes('date') || questionLower.includes('when') || questionLower.includes('pick')) {
      date = answer;
    }
    else if (type === 'mobile' || type === 'phone' || type === 'contact' || questionLower.includes('contact') || questionLower.includes('number')) {
      // Skip contact
    }
    else {
   
      let label = question
        .replace(/\?/g, '')
        .replace(/[📅📱👤🍨📏📝⏰💇🎯✅❌]/g, '')
        .trim();

      label = label.split(/\s+/).pop();  // keep the last word only

      console.log(label);
      
      details.push(`${label}: ${answer}`);
    }
  });
  
  let smsText = `Booking Alert! A new booking was recieved from ${name ? '' + name : ''}`;
  
  if (date) {
    smsText += ` scheduled for ${date}`;
  }
  
  smsText += '.';
 
  if (details.length > 0) {
    smsText += '\n\n';
    details.forEach((detail, index) => {
      smsText += detail;
      if (index < details.length - 1) {
        smsText += '\n';
      }
    });
  }
  
  return smsText;
}

 
// =======================
// BOOKING SYSTEM - COMPLETE SCRIPT
// =======================

const bookingSessions = {};

// =======================
// USER LOCATION CACHE
// =======================

const userLocations = {};

// Clean up old locations every hour
setInterval(() => {
  const oneHourAgo = Date.now() - (60 * 60 * 1000);
  Object.keys(userLocations).forEach(psid => {
    if (userLocations[psid].timestamp < oneHourAgo) {
      delete userLocations[psid];
      console.log(`🧹 Cleaned up location cache for ${psid}`);
    }
  });
}, 60 * 60 * 1000);


// ✅ CLEANUP STALE BOOKING SESSIONS
const BOOKING_TIMEOUT = 30 * 60 * 1000; // 30 minutes

function cleanupStaleSessions() {
  const now = Date.now();
  Object.keys(bookingSessions).forEach(psid => {
    const session = bookingSessions[psid];
    if (session.startedAt && (now - session.startedAt.getTime() > BOOKING_TIMEOUT)) {
      delete bookingSessions[psid];
      console.log(`🧹 Cleaned up stale session for ${psid}`);
    }
  });
}

// Run cleanup every 10 minutes
setInterval(cleanupStaleSessions, 10 * 60 * 1000);

/**
 * Initializes a new booking session for a user.
 * @param {string} psid - Page Scoped ID (User ID).
 * @param {Array<Array>} bookingConfig - Configuration array defining booking steps.
 */

/**
 * Validates a mobile number (11 digits, starts with 09).
 * @param {string} number - The user's input.
 * @returns {{valid: boolean, formatted: string | null}}
 */
function validateMobileNumber(number) {
  const cleaned = number.replace(/\D/g, '');

  if (cleaned.length === 11 && cleaned.startsWith('09')) {
    return { valid: true, formatted: cleaned };
  }

  return { valid: false, formatted: null };
}

/**
 * Validates a free-text date format.
 * Accepts common formats like MM/DD/YYYY, YYYY-MM-DD, or Month DD, YYYY.
 * @param {string} dateString - The user's input date string.
 * @returns {{valid: boolean, formatted: string | null}}
 */
function validateDateFormat(dateString) {
  const cleaned = dateString.trim();
  const parsedDate = new Date(cleaned);
  
  // Check if valid date
  if (isNaN(parsedDate.getTime())) {
    return { valid: false };
  }
  
  // Check if date is in reasonable range
  const now = new Date();
  const minDate = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const maxDate = new Date(now.getFullYear() + 2, 11, 31);
  
  if (parsedDate < minDate || parsedDate > maxDate) {
    return { valid: false };
  }

  // Format the date consistently for storage
  const formattedDate = parsedDate.toLocaleDateString('en-US', {
    year: 'numeric',
    month: 'long',
    day: 'numeric'
  });

  return { valid: true, formatted: formattedDate };
}

/**
 * Processes the user's message for the current booking step.
 * @param {string} psid - User ID.
 * @param {string} userMessage - The message received from the user.
 */
function processBookingStep(psid, userMessage) {
  const session = bookingSessions[psid];

  if (!session || !session.config) {
    return { text: "Something went wrong. Please type 'order' to start again." };
  }

  const message = userMessage.toLowerCase().trim();
  const currentStepIndex = session.step;

  // STEP 0: Confirmation Check
  if (currentStepIndex === 0) {
    if (message.includes('yes') || message.includes('oo') || message.includes('sige')) {
      session.step = 1;
      return askQuestion(psid, 1);
    } else if (message.includes('no') || message.includes('dili') || message.includes('cancel')) {
      delete bookingSessions[psid];
      return { text: "Booking cancelled. No problem! Feel free to book anytime." };
    }
  }

  // STEP > 0: Answer Validation and Storage
  if (currentStepIndex > 0) {
    const prevStep = session.config[currentStepIndex - 1];
    const fieldName = prevStep[0];
    const questionType = prevStep[2];

    if (questionType === 'mobile' || questionType === 'phone' || questionType === 'contact') {
      const validation = validateMobileNumber(userMessage);

      if (!validation.valid) {
        return {
          text: "Invalid mobile number!\n\nPlease enter exactly 11 digits starting with 09.\nExample: 09123456789"
        };
      }

      session.data[fieldName] = validation.formatted;

    } else if (questionType === 'date') {
      const validation = validateDateFormat(userMessage);

      if (!validation.valid) {
        return {
          text: "Invalid date format!\n\nPlease enter the date using a standard format like **MM/DD/YYYY** or **Month DD, YYYY**.\nExample: 12/25/2025 or December 25, 2025"
        };
      }

      session.data[fieldName] = validation.formatted;

    } else {
      session.data[fieldName] = userMessage;
    }
  }

  // Check for completion
  if (currentStepIndex >= session.config.length) {
    return completeBooking(psid);
  }

  // Move to next step
  session.step = currentStepIndex + 1;
  return askQuestion(psid, currentStepIndex + 1);
}

/**
 * Generates the next question to be asked based on the step configuration.
 * @param {string} psid - User ID.
 * @param {number} stepIndex - The index of the question to ask (1-based).
 */
function askQuestion(psid, stepIndex) {
  const session = bookingSessions[psid];
  const stepConfig = session.config[stepIndex - 1];

  if (!stepConfig) {
    return completeBooking(psid);
  }

  const [stepNum, question, type, options] = stepConfig;

  if (type === 'text') {
    return { text: question };
  } else if (type === 'mobile' || type === 'phone' || type === 'contact') {
    return {
      text: question + "\n\n(Please enter 11 digits, e.g., 09123456789)",
      validateMobile: true
    };
  } else if (type === 'date') {
    return {
      text: question + "\n\n(Please enter the date as MM/DD/YYYY or Month DD, YYYY. Example: 12/25/2025)",
      validateDate: true
    };
  } else if (type === 'buttons' && options) {
    const optionList = options.split(',').map(opt => opt.trim());

    if (optionList.length <= 3) {
      const buttons = optionList.map(opt => {
        const [label, value] = opt.includes('-') ? opt.split('-') : [opt, opt];
        return {
          type: "postback",
          title: label,
          payload: `BOOKING_ANSWER_${value}`
        };
      });

      return {
        text: null,
        template: {
          type: "template",
          payload: {
            template_type: "button",
            text: question,
            buttons: buttons
          }
        }
      };
    } else {
      const elements = optionList.map(opt => {
        const [label, value] = opt.includes('-') ? opt.split('-') : [opt, opt];
        return {
          title: label,
          buttons: [{
            type: "postback",
            title: `Choose ${label.split('-')[0]}`,
            payload: `BOOKING_ANSWER_${value}`
          }]
        };
      });

      return {
        text: null,
        template: {
          type: "template",
          payload: {
            template_type: "generic",
            elements: elements
          }
        }
      };
    }
  }

  return { text: question };
}

/**
 * Finalizes the booking and generates a summary.
 * @param {string} psid - User ID.
 */
function completeBooking(psid) {
  const session = bookingSessions[psid];

  let summary = "BOOKING RECEIVED!\n\nSummary:\n";

  let mobileNumber = null;

  session.config.forEach((stepConfig) => {
    const [stepNum, question, type] = stepConfig;
    const answer = session.data[stepNum] || 'N/A';
    const label = question.replace('?', '').substring(0, 30);
    summary += `${label}: ${answer}\n`;

    if (type === 'mobile' || type === 'phone' || type === 'contact') {
      mobileNumber = session.data[stepNum];
    }
  });

  summary += "\nThank you! We'll confirm your booking shortly.";

  if (mobileNumber) {
    session.mobileNumber = mobileNumber;
    summary += "\n\nA confirmation SMS will be sent to your number.";
  }

  session.completed = true;

  return { text: summary };
}

/**
 * Public facing function to process user input.
 * @param {string} psid - User ID.
 * @param {string} userMessage - The message received from the user.
 */
function processBooking(psid, userMessage) {
  return processBookingStep(psid, userMessage);
}

/**
 * Placeholder for saving the order data to an external sheet (e.g., Google Sheets).
 * @param {string} psid - User ID.
 * @param {Object} orderData - The collected data (session.data).
 * @param {string} bookingSheetId - ID of the Google Sheet.
 */
async function saveOrder(psid, orderData, bookingSheetId) {
  try {
    const values = [psid];

    // Collect and sort data keys for consistent column order
    const sortedKeys = Object.keys(orderData).sort();
    sortedKeys.forEach(key => {
      values.push(orderData[key]);
    });

    values.push(new Date().toISOString());

    console.log('Attempting to save to sheet:', bookingSheetId);
    console.log('Data to save:', values);
    
    await sheets.spreadsheets.values.append({
      spreadsheetId: bookingSheetId,
      range: 'ConfirmedOrders!A:Z',
      valueInputOption: 'RAW',
      insertDataOption: 'INSERT_ROWS',
      resource: {
        values: [values],
      },
    });
    
    console.log(`Order saved successfully for PSID: ${psid}`);
    return true;
  } catch (err) {
    console.error('Error saving order:', err);
    console.error('Error details:', err.message);
    return false;
  }
}

// =======================
// BILL INQUIRY
// =======================

const BILL_SHEET_ID = '1_H-OIoLXyxbGsr7gezxc2AbpnUEaVidb-WRjTGFXRfQ';
const BILL_TAB_NAME = 'LatestBill';

async function lookupBill(conscode) {
  try {
    console.log(`🔍 Looking up bill for conscode: "${conscode}"`);

    const res = await sheets.spreadsheets.values.get({
      spreadsheetId: BILL_SHEET_ID,
      range: `${BILL_TAB_NAME}!A:Z`,
    });

    const rows = res.data.values || [];
    console.log(`📄 Bill sheet rows found: ${rows.length}`);

    if (rows.length < 2) {
      console.error('❌ UD sheet is empty or has only headers');
      return null;
    }

    // Map headers to column indices (case-insensitive)
    const headers = rows[0].map(h => (h || '').toLowerCase().trim());
    console.log('📋 UD sheet headers:', headers);

    const col = (name) => headers.findIndex(h => h.includes(name.toLowerCase()));

    const idxConscode      = col('conscode');
    const idxConsumption   = col('consumption');
    const idxWaterFee      = col('water fee');
    const idxInstallFee    = col('installation fee');
    const idxMeterMaint    = col('meter maintenance');
    const idxDueDate       = col('due date');
    const idxDisconDate    = col('disconnection date');

    console.log(`📌 Column indices — conscode:${idxConscode} consumption:${idxConsumption} waterFee:${idxWaterFee} installFee:${idxInstallFee} meterMaint:${idxMeterMaint} dueDate:${idxDueDate} disconDate:${idxDisconDate}`);

    if (idxConscode === -1) {
      console.error('❌ "conscode" column not found. Check your UD sheet headers.');
      return null;
    }

    // Log all conscode values found in the sheet for comparison
    const allConscodes = rows.slice(1).map(r => r[idxConscode]);
    console.log('📋 All conscodes in sheet:', JSON.stringify(allConscodes));

    // Strip everything except digits for a clean numeric comparison
    const digitsOnly = (s) => s.toString().replace(/[^0-9]/g, '');
    const userDigits = digitsOnly(conscode);
    console.log(`🔢 User conscode digits: "${userDigits}"`);

    const row = rows.slice(1).find(r => {
      if (!r[idxConscode]) return false;
      const sheetVal = r[idxConscode].toString();
      const sheetDigits = digitsOnly(sheetVal);
      const match = sheetDigits === userDigits || sheetVal.trim().toLowerCase() === conscode.trim().toLowerCase();
      if (match) console.log(`✅ Matched: sheet="${sheetVal}" digits="${sheetDigits}" vs user="${conscode}" digits="${userDigits}"`);
      return match;
    });

    if (!row) {
      console.log(`❌ No match found for conscode: "${conscode}"`);
      return null;
    }

    console.log(`✅ Match found for conscode: "${conscode}"`);

    const waterFee    = parseFloat(row[idxWaterFee])    || 0;
    const installFee  = parseFloat(row[idxInstallFee])  || 0;
    const meterMaint  = parseFloat(row[idxMeterMaint])  || 0;
    const totalAmount = waterFee + installFee + meterMaint;

    console.log(`💰 waterFee:${waterFee} installFee:${installFee} meterMaint:${meterMaint} total:${totalAmount}`);

    return {
      conscode:    row[idxConscode]    || conscode,
      consumption: row[idxConsumption] || '0',
      totalAmount: totalAmount.toFixed(2),
      dueDate:     idxDueDate    !== -1 ? (row[idxDueDate]    || 'N/A') : 'N/A',
      disconDate:  idxDisconDate !== -1 ? (row[idxDisconDate] || 'N/A') : 'N/A',
    };
  } catch (err) {
    console.error('❌ Error looking up bill:', err.message);
    console.error('   Full error:', err);
    return null;
  }
}

// =======================
// UTILITIES
// =======================

const keywordsCache = {};

async function getPageConfig(pageId) {
  try {
    const res = await sheets.spreadsheets.values.get({
      spreadsheetId: process.env.SHEET_ID,
      range: 'WebhookConfig!A:G',
    });

    const rows = res.data.values || [];
    const config = rows.find(row => row[0] === pageId);

    if (!config) return null;

    return {
      pageId: config[0],
      pageToken: config[1],
      keywordsSheetId: config[2],
      bookingSheetId: config[3] || config[2],
      recipientEmail: config[6] || '',
    };
  } catch (err) {
    console.error('Error fetching page config:', err);
    return null;
  }
}

async function getKeywords(sheetId, forceRefresh = false) {
  if (forceRefresh || !keywordsCache[sheetId]) {
    try {
      const res = await sheets.spreadsheets.values.get({
        spreadsheetId: sheetId,
        range: 'KeywordsDM!A:D',
      });
      keywordsCache[sheetId] = res.data.values || [];
      console.log(`Keywords refreshed for sheet ${sheetId} (${keywordsCache[sheetId].length} keywords loaded)`);
    } catch (err) {
      console.error(`Error fetching KeywordsDM from sheet ${sheetId}:`, err);
      return keywordsCache[sheetId] || [];
    }
  }
  return keywordsCache[sheetId];
}


async function logPSID(psid) {
  try {
    await sheets.spreadsheets.values.append({
      spreadsheetId: process.env.SHEET_ID,
      range: 'PSIDs!A:B',
      valueInputOption: 'RAW',
      insertDataOption: 'INSERT_ROWS',
      resource: {
        values: [[psid, new Date().toISOString()]],
      },
    });
    console.log(`PSID logged: ${psid}`);
  } catch (err) {
    console.error('Error logging PSID:', err);
  }
}

async function logHelpRequest(psid, userInfo, location, bookingSheetId) {
  try {
    const timestamp = new Date().toLocaleString('en-PH', { timeZone: 'Asia/Manila' });
    
    // Generate Maps link only if coordinates exist
    let mapsLink = '';
    if (location?.lat && location?.long) {
      mapsLink = `https://maps.google.com/?q=${location.lat},${location.long}`;
    }
    
    const values = [
      psid,
      userInfo?.fullName || 'Unknown',
      location?.address || 'Not provided',
      location?.lat || '',
      location?.long || '',
      mapsLink,
      timestamp
    ];

    await sheets.spreadsheets.values.append({
      spreadsheetId: bookingSheetId,
      range: 'HelpRequests!A:G',
      valueInputOption: 'RAW',
      insertDataOption: 'INSERT_ROWS',
      resource: {
        values: [values],
      },
    });
    console.log(`✅ Help request logged for ${psid} with location: ${location?.address || 'N/A'}`);
  } catch (err) {
    console.error('Error logging help request:', err);
  }
}

function getCurrentTime() {
  const now = new Date();
  const timeString = now.toLocaleString('en-PH', { 
    timeZone: 'Asia/Manila',
    dateStyle: 'full',
    timeStyle: 'short'
  });
  return `Current time: ${timeString}`;
}

async function executeSpecialAction(action, senderPsid, pageToken) {
  switch (action) {
    case 'request_location':
      if (!senderPsid || !pageToken) {
        return "Please use the Messenger app to share your location.";
      }

      pendingHelpRequests.add(senderPsid); // ✅ mark as waiting
      await requestLocation(senderPsid, pageToken);

      // Return message to indicate bot is waiting
      return { handled: true, text: "📍 Please share your location so we can send help!" };

    default:
      return null;
  }
}



// =======================
// LOCATION UTILITIES
// =======================

/**
 * Get address from coordinates using free geocoding API
 */
async function getAddressFromCoordinates(lat, long) {
  return new Promise((resolve) => {
    const https = require('https');
    
    // Using OpenStreetMap's free Nominatim API
    const url = `https://nominatim.openstreetmap.org/reverse?format=json&lat=${lat}&lon=${long}`;
    
    https.get(url, {
      headers: {
        'User-Agent': 'FacebookMessengerBot/1.0'
      }
    }, (res) => {
      let data = '';
      
      res.on('data', (chunk) => {
        data += chunk;
      });
      
      res.on('end', () => {
        try {
          const result = JSON.parse(data);
          if (result.display_name) {
            resolve(result.display_name);
          } else {
            resolve(null);
          }
        } catch (error) {
          console.error('Error parsing geocoding response:', error);
          resolve(null);
        }
      });
    }).on('error', (error) => {
      console.error('Error fetching address:', error);
      resolve(null);
    });
  });
}
// =======================
// GET USER INFO FROM FACEBOOK
// =======================

/**
 * Get user's name and profile info from Facebook
 */

async function getUserInfo(psid, pageToken) {
  return new Promise((resolve, reject) => {
    request(
      {
        uri: `https://graph.facebook.com/${process.env.GRAPH_API_VERSION}/${psid}`,
        qs: { 
          fields: 'first_name,last_name,profile_pic',
          access_token: pageToken 
        },
        method: 'GET'
      },
      (err, res, body) => {
        if (!err && body) {
          try {
            const data = JSON.parse(body);
            console.log(`👤 User info retrieved: ${data.first_name} ${data.last_name}`);
            resolve({
              firstName: data.first_name || 'Unknown',
              lastName: data.last_name || '',
              fullName: `${data.first_name || 'Unknown'} ${data.last_name || ''}`.trim()
            });
          } catch (error) {
            console.error('Error parsing user info:', error);
            resolve({ firstName: 'Unknown', lastName: '', fullName: 'Unknown User' });
          }
        } else {
          console.error('Error fetching user info:', err);
          resolve({ firstName: 'Unknown', lastName: '', fullName: 'Unknown User' });
        }
      }
    );
  });
}

// =======================
// GET HOTLINE NUMBERS
// =======================

/**
 * Get hotline numbers from Google Sheets
 */
async function getHotlines(sheetId, type = 'emergency') {
  try {
    const res = await sheets.spreadsheets.values.get({
      spreadsheetId: sheetId,
      range: 'Hotlines!A:C',
    });

    const rows = res.data.values || [];

    if (rows.length <= 1) {
      console.log('❌ No hotlines found in sheet');
      return [];
    }

    // Filter by type (pass null to get all entries)
    const hotlines = [];
    for (let i = 1; i < rows.length; i++) {
      const [hotlineType, name, phoneNumber] = rows[i];

      if (phoneNumber && (type === null || (hotlineType && hotlineType.toLowerCase() === type.toLowerCase()))) {
        hotlines.push({
          type: hotlineType,
          name: name || 'Hotline',
          phoneNumber: phoneNumber
        });
      }
    }
    
    console.log(`📞 Found ${hotlines.length} hotline(s) for type: ${type}`);
    return hotlines;
    
  } catch (error) {
    console.error('Error fetching hotlines:', error);
    return [];
  }
}

// =======================
// LEAK REPORT HELPERS
// =======================

function askLeakQuestion(senderPsid, next, pageToken) {
  sendTyping(senderPsid, pageToken);
  setTimeout(() => {
    if (next.type === 'buttons') {
      callSendAPI(senderPsid, null, pageToken, null, {
        type: 'template',
        payload: {
          template_type: 'button',
          text: next.ask,
          buttons: next.options.map(o => ({ type: 'postback', title: o, payload: `LEAK_ANS_${o.toUpperCase().replace(/\s+/g, '_')}` }))
        }
      });
    } else {
      callSendAPI(senderPsid, next.ask, pageToken);
    }
  }, 1000);
}

function finishLeakReport(session, senderPsid, pageToken, pageId) {
  const d = session.data;
  const summary =
    `✅ LEAK REPORT RECEIVED\n\n` +
    `Name: ${d.name || 'N/A'}\n` +
    `Contact: ${d.contact || 'N/A'}\n` +
    `Location: ${d.location || 'N/A'}\n` +
    `Started: ${d.started || 'N/A'}\n` +
    `Size: ${d.size || 'N/A'}\n` +
    `Area: ${d.area || 'N/A'}\n` +
    `Flooding/Damage: ${d.damage || 'N/A'}\n` +
    `Photo: ${d.photo || 'No photo provided'}\n\n` +
    `Thank you! Our team has been notified and will respond shortly.`;
  delete leakSessions[senderPsid];
  sendTyping(senderPsid, pageToken);
  setTimeout(() => callSendAPI(senderPsid, summary, pageToken), 1000);
  sendLeakReportSMSToTeam(d, pageId);
}

// =======================
// LEAK REPORT SMS ALERT
// =======================

async function sendLeakReportSMSToTeam(data, pageId) {
  try {
    const pageConfig = await getPageConfig(pageId);
    const sheetId = pageConfig?.keywordsSheetId;
    if (!sheetId) { console.error('❌ No sheetId for leak SMS'); return; }

    // Fetch all hotline phones and sender name config in parallel
    const [hotlines, configRes] = await Promise.all([
      getHotlines(sheetId, null),
      sheets.spreadsheets.values.get({ spreadsheetId: '1Qk55w8gG6o5TUlEKtBpvx-JTwxoHr1lqB_l0AswXzi0', range: 'A:I' }),
    ]);

    const phones = hotlines.map(h => h.phoneNumber);
    if (!phones.length) { console.log('⚠️ No phones found in Hotlines column C'); return; }

    const configRow = (configRes.data.values || []).find(r => r[0] === pageId);
    const senderName = (configRow && configRow[8]) ? configRow[8].trim() : 'BogoWD';
    console.log(`📛 SMS sender name: "${senderName}"`);

    const smsText =
      `LEAK REPORT\n` +
      `Name: ${data.name || 'N/A'}\n` +
      `Contact: ${data.contact || 'N/A'}\n` +
      `Location: ${data.location || 'N/A'}\n` +
      `Started: ${data.started || 'N/A'}\n` +
      `Size: ${data.size || 'N/A'}\n` +
      `Area: ${data.area || 'N/A'}\n` +
      `Flooding/Damage: ${data.damage || 'N/A'}`;

    console.log(`📤 Sending leak alert SMS to ${phones.length} number(s)...`);
    for (const phone of phones) {
      await sendSMS(phone, smsText, senderName);
    }
  } catch (err) {
    console.error('❌ Error sending leak report SMS:', err.message);
  }
}

// =======================
// SEND HELP/EMERGENCY ALERT
// =======================

/**
 * Send emergency SMS alert with user info and location
 */
async function sendHelpAlert(psid, pageToken, keywordsSheetId, location = null, bookingSheetId = null) {
  try {
    console.log(` Help request received from ${psid}`);
    
    // Get user info from Facebook
    const userInfo = await getUserInfo(psid, pageToken);
    
    // Get hotline numbers
    const hotlines = await getHotlines(keywordsSheetId, 'emergency');
    
    if (hotlines.length === 0) {
      console.error('❌ No emergency hotlines configured');
      return {
        success: false,
        message: "Emergency hotlines not configured. Please contact support directly."
      };
    }
    
    // Build SMS message
    let smsMessage = ` HELP REQUEST ALERT \n\n`;
    smsMessage += `From: ${userInfo.fullName}\n`;
    smsMessage += `Facebook ID: ${psid}\n`;
    
    if (location) {
      smsMessage += `\nLocation:\n`;
      if (location.address) {
       smsMessage += `${location.address}\n`;
      }
      if (location.lat && location.long) {
        smsMessage += `Coordinates: ${location.lat}, ${location.long}\n`;
        smsMessage += `Maps: https://maps.google.com/?q=${location.lat},${location.long}\n`;
      }
      } else {
      smsMessage += `\nLocation: Not shared\n`;
     }
    
     smsMessage += `\nTime: ${new Date().toLocaleString('en-PH', { timeZone: 'Asia/Manila' })}`;
    
    console.log('SMS Message:\n', smsMessage);
    
    // Send SMS to all hotlines
    let sentCount = 0;
    const results = [];
    
    for (const hotline of hotlines) {
      console.log(`Sending alert to ${hotline.name}: ${hotline.phoneNumber}`);
      
      const smsResult = await sendSMS(hotline.phoneNumber, smsMessage);
      
      if (smsResult.success) {
        sentCount++;
        results.push(` ${hotline.name}`);
      } else {
        results.push(` ${hotline.name} (failed)`);
      }
    }
    
    // Log help request to sheet if bookingSheetId is provided
    if (bookingSheetId) {
      await logHelpRequest(psid, userInfo, location, bookingSheetId);
    }
    
    if (sentCount > 0) {
      return {
        success: true,
        message: ` Help alert sent to ${sentCount} emergency contact(s)!\n\n${results.join('\n')}\n\nSomeone will assist you shortly.`
      };
    } else {
      return {
        success: false,
        message: "Failed to send emergency alerts. Please try contacting support directly."
      };
    }
    
  } catch (error) {
    console.error('❌ Error sending help alert:', error);
    return {
      success: false,
      message: "Error sending alert. Please contact support directly."
    };
  }
}

/**
 * Request location from user with button template
 * (Location Quick Reply is deprecated in API v4.0+)
 */
function requestLocation(senderPsid, pageToken) {
  const messageData = {
    recipient: { id: senderPsid },
    message: {
      attachment: {
        type: "template",
        payload: {
          template_type: "button",
          text: "📍 To help you better, we need your location.\n\nPlease share your location using the button below:",
          buttons: [
            {
              type: "postback",
              title: "📍 Share My Location",
              payload: "HELP_SHARE_LOCATION"
            }
          ]
        }
      }
    }
  };
  
  console.log('Sending location request with button template');
  
  request(
    {
      uri: `https://graph.facebook.com/${process.env.GRAPH_API_VERSION}/me/messages`,
      qs: { access_token: pageToken },
      method: 'POST',
      json: messageData
    },
    (err, res, body) => {
      if (!err && body && !body.error) {
        console.log('📍 Location request sent! Response:', body);
      } else {
        console.error('❌ Unable to send location request:', err || body?.error);
      }
    }
  );
}


// =======================
// MESSENGER API HELPERS
// =======================

function sendTyping(senderPsid, pageToken) {
  request(
    {
      uri: `https://graph.facebook.com/${process.env.GRAPH_API_VERSION}/me/messages`,
      qs: { access_token: pageToken },
      method: 'POST',
      json: {
        recipient: { id: senderPsid },
        sender_action: 'typing_on',
      },
    },
    (err) => {
      if (!err) console.log('Typing indicator sent!');
      else console.error('Unable to send typing indicator:', err);
    }
  );
}

function parseCarousel(columnC) {
  const raw = columnC.slice('CAROUSEL::'.length);
  const btnPattern = /^\[([^\]]+)\](?:\(([^)]+)\))?$/;
  const elements = raw.split(';;').map(cardStr => {
    const fields = cardStr.split('|').map(f => f.trim());
    const element = { title: 'Untitled' };
    const buttons = [];
    fields.forEach((field, idx) => {
      if (idx === 0) {
        element.title = field || 'Untitled';
      } else if (btnPattern.test(field)) {
        const m = field.match(btnPattern);
        const title = m[1].trim();
        const url = m[2] ? m[2].trim() : null;
        buttons.push(url
          ? { type: 'web_url', title, url }
          : { type: 'postback', title, payload: `CAROUSEL_${title.toUpperCase().replace(/[^A-Z0-9]+/g, '_')}` }
        );
      } else if (field.startsWith('http://') || field.startsWith('https://')) {
        element.image_url = field;
      } else if (field) {
        element.subtitle = field;
      }
    });
    if (buttons.length) element.buttons = buttons.slice(0, 3);
    return element;
  }).filter(e => e.title);
  return elements;
}

function callSendAPI(senderPsid, response, pageToken, quickReplies = null, template = null, imageUrl = null, fileUrl = null) {
  let messageData = {
    recipient: { id: senderPsid }
  };

  if (template) {
    messageData.message = { attachment: template };
  } else if (fileUrl) {
    console.log('Sending file:', fileUrl);
    messageData.message = {
      attachment: {
        type: 'file',
        payload: {
          url: fileUrl,
          is_reusable: true
        }
      }
    };
  } else if (imageUrl) {
    console.log('Sending image:', imageUrl);
    messageData.message = {
      attachment: {
        type: 'image',
        payload: {
          url: imageUrl,
          is_reusable: true
        }
      }
    };
  } else if (quickReplies) {
    messageData.message = { text: response, quick_replies: quickReplies };
  } else {
    messageData.message = { text: response };
  }
  
  console.log('API Request Body:', JSON.stringify(messageData, null, 2));
  
  request(
    {
      uri: `https://graph.facebook.com/${process.env.GRAPH_API_VERSION}/me/messages`,
      qs: { access_token: pageToken },
      method: 'POST',
      json: messageData,
    },
    (err, res, body) => {
      if (!err) {
        console.log('Message sent! Response:', body);
      }
      else console.error('❌ Unable to send message:', err.message, body);
    }
  );
}

// =======================
// ✅ IMPROVED COMMENT REPLY FUNCTION
// =======================

function replyToComment(commentId, message, pageToken) {
  return new Promise((resolve, reject) => {
    console.log(`Replying to comment ${commentId}:`, message);

    // Try private reply first
    request(
      {
        uri: `https://graph.facebook.com/${process.env.GRAPH_API_VERSION}/${commentId}/private_replies`,
        qs: { access_token: pageToken },
        method: 'POST',
        json: { message: message }
      },
      (err, res, body) => {
        if (!err && body && !body.error) {
          console.log('✅ Private reply sent! Response:', body);
          resolve(body);
        } else {
          console.log('⚠️ Private reply failed, trying public reply...');
          
          // Fallback to public reply
          request(
            {
              uri: `https://graph.facebook.com/${process.env.GRAPH_API_VERSION}/${commentId}/comments`,
              qs: { access_token: pageToken },
              method: 'POST',
              json: { message: message }
            },
            (err2, res2, body2) => {
              if (!err2 && body2 && !body2.error) {
                console.log('✅ Public reply sent! Response:', body2);
                resolve(body2);
              } else {
                console.error('❌ Both reply methods failed:', body2?.error || err2);
                reject(err2 || body2?.error);
              }
            }
          );
        }
      }
    );
  });
}

// =======================
// AUTO-POST TO FACEBOOK PAGE
// =======================

/**
 * Post text to Facebook Page
 */
async function postToFacebook(pageId, pageToken, message) {
  return new Promise((resolve, reject) => {
    request(
      {
        uri: `https://graph.facebook.com/${process.env.GRAPH_API_VERSION}/${pageId}/feed`,
        qs: { access_token: pageToken },
        method: 'POST',
        json: { message: message }
      },
      (err, res, body) => {
        if (!err && body && !body.error) {
          console.log('✅ Post published! Post ID:', body.id);
          resolve(body);
        } else {
          console.error('❌ Failed to post:', err || body?.error);
          reject(err || body?.error);
        }
      }
    );
  });
}

/**
 * Post image to Facebook Page
 */
async function postImageToFacebook(pageId, pageToken, imageUrl, caption = '') {
  return new Promise((resolve, reject) => {
    request(
      {
        uri: `https://graph.facebook.com/${process.env.GRAPH_API_VERSION}/${pageId}/photos`,
        qs: { access_token: pageToken },
        method: 'POST',
        json: {
          url: imageUrl,
          caption: caption
        }
      },
      (err, res, body) => {
        if (!err && body && !body.error) {
          console.log('✅ Image posted! Post ID:', body.id);
          resolve(body);
        } else {
          console.error('❌ Failed to post image:', err || body?.error);
          reject(err || body?.error);
        }
      }
    );
  });
}

/**
 * Post multiple images as album
 */
async function postMultipleImagesToFacebook(pageId, pageToken, imageUrls, message = '') {
  try {
    const photoIds = [];
    
    for (const imageUrl of imageUrls) {
      const result = await new Promise((resolve, reject) => {
        request(
          {
            uri: `https://graph.facebook.com/${process.env.GRAPH_API_VERSION}/${pageId}/photos`,
            qs: { access_token: pageToken },
            method: 'POST',
            json: {
              url: imageUrl,
              published: false
            }
          },
          (err, res, body) => {
            if (!err && body && !body.error) {
              resolve(body.id);
            } else {
              reject(err || body?.error);
            }
          }
        );
      });
      
      photoIds.push({ media_fbid: result });
    }
    
    return new Promise((resolve, reject) => {
      request(
        {
          uri: `https://graph.facebook.com/${process.env.GRAPH_API_VERSION}/${pageId}/feed`,
          qs: { access_token: pageToken },
          method: 'POST',
          json: {
            message: message,
            attached_media: photoIds
          }
        },
        (err, res, body) => {
          if (!err && body && !body.error) {
            console.log('✅ Album posted! Post ID:', body.id);
            resolve(body);
          } else {
            console.error('❌ Failed to post album:', err || body?.error);
            reject(err || body?.error);
          }
        }
      );
    });
  } catch (error) {
    console.error('❌ Error posting album:', error);
    throw error;
  }
}


// =======================
// ✅ COMMENT DUPLICATE PROTECTION
// =======================

const processedComments = new Set();

// Clean up processed comments every hour to prevent memory bloat
setInterval(() => {
  console.log(`🧹 Clearing processed comments cache (${processedComments.size} entries)`);
  processedComments.clear();
}, 60 * 60 * 1000);

 

// =======================
// Get Page Token
// =======================
async function getPageToken(pageId) {
  try {
    const config = await getPageConfig(pageId);
    
    if (config && config.pageToken) {
      console.log(`✅ Token retrieved for page ${pageId}`);
      return config.pageToken;
    }
    
    console.warn(`⚠️ No token in sheet for page ${pageId}, using env fallback`);
    return process.env.PAGE_ACCESS_TOKEN;
    
  } catch (error) {
    console.error('❌ Error getting page token:', error.message);
    return process.env.PAGE_ACCESS_TOKEN;
  }
}


// =======================
// WEBHOOK VERIFICATION (GET)
// =======================
app.get('/webhook', (req, res) => {
  const VERIFY_TOKEN = process.env.VERIFY_TOKEN || 'your_verify_token_here';
  
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];
  
  if (mode && token) {
    if (mode === 'subscribe' && token === VERIFY_TOKEN) {
      console.log('✅ WEBHOOK_VERIFIED');
      res.status(200).send(challenge);
    } else {
      console.log('❌ WEBHOOK_VERIFICATION_FAILED');
      res.sendStatus(403);
    }
  } else {
    res.sendStatus(400);
  }
});


// =======================
// Webhook handler
// =======================
app.post('/webhook', async (req, res) => {
  const body = req.body;

  // Check for valid object type
  if (body.object === 'page') {
    for (const entry of body.entry) {
      const pageId = entry.id;
      const pageToken = await getPageToken(pageId);
      
      if (!pageToken) {
        console.error(`❌ No token retrieved for page ${pageId}`);
        continue;
      }
      
      console.log(`✅ Token retrieved for page ${pageId} (length: ${pageToken.length})`);

      // Handle Messenger messages and postbacks
      if (entry.messaging) {
        for (const messaging of entry.messaging) {
          const senderPsid = messaging.sender.id;

          // 🔍 DEBUG: Log all incoming messages
          console.log('\n🔍 INCOMING MESSAGE DEBUG:');
          console.log('   Has postback:', !!messaging.postback);
          console.log('   Has message:', !!messaging.message);
          if (messaging.message) {
            console.log('   Message has text:', !!messaging.message.text);
            console.log('   Message has attachments:', !!messaging.message.attachments);
            if (messaging.message.attachments) {
              console.log('   Attachments count:', messaging.message.attachments.length);
              messaging.message.attachments.forEach((att, idx) => {
                console.log(`   [${idx}] Type: ${att.type}`);
              });
            }
          }
          console.log('');

          // Handle admin echo commands (!pause / !resume)
          if (messaging.message && messaging.message.is_echo) {
            const echoText = (messaging.message.text || '').trim().toLowerCase();
            if (echoText === '!pause') {
              pausedPages.add(pageId);
              console.log(`⏸️ Auto-reply PAUSED for all users on page ${pageId} by admin`);
            } else if (echoText === '!resume') {
              pausedPages.delete(pageId);
              console.log(`▶️ Auto-reply RESUMED for all users on page ${pageId} by admin`);
            }
            continue; // Never process admin echoes as user messages
          }

          if (messaging.postback) {
            const payload = messaging.postback.payload;
            console.log(`Postback received: ${payload}`);

            if (payload === 'BOOKING_YES') {
              // Booking flow for YES
              if (bookingSessions[senderPsid] && bookingSessions[senderPsid].step === 0) {
                const nextQuestion = askQuestion(senderPsid, 1);
                bookingSessions[senderPsid].step = 1;

                sendTyping(senderPsid, pageToken);
                setTimeout(() => {
                  if (nextQuestion.template) {
                    callSendAPI(senderPsid, null, pageToken, null, nextQuestion.template);
                  } else if (nextQuestion.quickReplies) {
                    callSendAPI(senderPsid, nextQuestion.text, pageToken, nextQuestion.quickReplies);
                  } else {
                    callSendAPI(senderPsid, nextQuestion.text, pageToken);
                  }
                }, 1000);
              }
              continue;
            } else if (payload === 'BOOKING_NO') {
              // Booking flow for NO
              delete bookingSessions[senderPsid];
              sendTyping(senderPsid, pageToken);
              setTimeout(() => {
                callSendAPI(senderPsid, "Booking cancelled. No problem! Feel free to book anytime.", pageToken);
              }, 1000);
              continue;
            } else if (payload.startsWith('BOOKING_ANSWER_')) {
              // Handle booking answers
              const answer = payload.replace('BOOKING_ANSWER_', '').replace(/_/g, ' ');

              if (answer === 'Other date' || payload === 'BOOKING_ANSWER_CUSTOM_DATE') {
                bookingSessions[senderPsid].waitingForCustomDate = true;
                sendTyping(senderPsid, pageToken);
                setTimeout(() => {
                  callSendAPI(senderPsid, "Please type your preferred date (e.g., December 15, 2025):", pageToken);
                }, 1000);
                continue;
              }

              if (bookingSessions[senderPsid]) {
                const currentStep = bookingSessions[senderPsid].step;
                const stepConfig = bookingSessions[senderPsid].config[currentStep - 1];
                if (stepConfig) {
                  bookingSessions[senderPsid].data[stepConfig[0]] = answer;
                }

                const nextQuestion = processBookingStep(senderPsid, answer);

                sendTyping(senderPsid, pageToken);
                setTimeout(() => {
                  if (nextQuestion.template) {
                    callSendAPI(senderPsid, null, pageToken, null, nextQuestion.template);
                  } else if (nextQuestion.quickReplies) {
                    callSendAPI(senderPsid, nextQuestion.text, pageToken, nextQuestion.quickReplies);
                  } else {
                    callSendAPI(senderPsid, nextQuestion.text, pageToken);
                  }
                }, 1000);
              }
              continue;
            } else if (payload.startsWith('LEAK_ANS_')) {
              // Handle leak report button answers
              if (leakSessions[senderPsid]) {
                const session = leakSessions[senderPsid];
                const q = LEAK_QUESTIONS[session.step];
                const answer = payload.replace('LEAK_ANS_', '').replace(/_/g, ' ').toLowerCase().replace(/\b\w/g, c => c.toUpperCase());
                session.data[q.key] = answer;
                session.step++;

                if (session.step < LEAK_QUESTIONS.length) {
                  askLeakQuestion(senderPsid, LEAK_QUESTIONS[session.step], pageToken);
                } else {
                  finishLeakReport(session, senderPsid, pageToken, pageId);
                }
              }
              continue;
            } else if (payload === 'HELP_SHARE_LOCATION') {
              // Handle help location request
              console.log(`📍 User clicked location button for help request`);
              
              sendTyping(senderPsid, pageToken);
              setTimeout(() => {
                callSendAPI(senderPsid, 
                  "📍 To send help, please share your location:\n\n**OPTION 1 - Automatic (Recommended):**\nLook for the attachment/paperclip icon (📎) near the message input box, tap it, select 'Location', and share.\n\n**OPTION 2 - Manual (If no attachment button):**\nIf you don't see an attachment button, simply type or paste your address/location below.\n\nExample: 'Manila, Philippines' or 'Makati City, BGC'",
                  pageToken
                );
              }, 1000);
              
              // Mark as pending so we can process either location or text
              if (!bookingSessions[senderPsid]) {
                bookingSessions[senderPsid] = {
                  step: 'waiting_for_location',
                  startedAt: new Date()
                };
              }
              continue;
            } else {
              // Non-order postback: treat button title as typed text for keyword matching
              console.log(`🔄 Non-order postback, treating as text: "${messaging.postback.title}"`);
              messaging.message = { text: messaging.postback.title || payload };
            }
          }

// ==========================================
// Handle Location Messages
// ==========================================
if (messaging.message && messaging.message.attachments) {
  const attachments = messaging.message.attachments;
  
  console.log('📎 Attachments received:', JSON.stringify(attachments, null, 2));
  
  // Check if user sent a location
  const locationAttachment = attachments.find(att => att.type === 'location');
  
  console.log('🔍 Location attachment found:', locationAttachment ? 'YES' : 'NO');
  
if (locationAttachment) {
  console.log('📍 Full location payload:', JSON.stringify(locationAttachment, null, 2));
  
  const coords = locationAttachment.payload.coordinates;
  const lat = coords.lat;
  const long = coords.long;
  
  console.log(`📍 Location received from ${senderPsid}: ${lat}, ${long}`);
  
  // Get page config
  const pageConfig = await getPageConfig(pageId);
  const keywordsSheetId = pageConfig?.keywordsSheetId;
  const bookingSheetId = pageConfig?.bookingSheetId;
  
  // Get address from coordinates using reverse geocoding
  const address = await getAddressFromCoordinates(lat, long);
  
  // Store location in cache
  userLocations[senderPsid] = {
    lat: lat,
    long: long,
    address: address,
    timestamp: Date.now()
  };
  
  console.log(`💾 Location stored for ${senderPsid}`);
  
  // Check if this was in response to a help request
  if (pendingHelpRequests.has(senderPsid)) {
    console.log(`🚨 Processing pending help request with location for ${senderPsid}`);
    
    // Remove from pending
    pendingHelpRequests.delete(senderPsid);
    
    // Send help alert WITH location
    const alertResult = await sendHelpAlert(
      senderPsid, 
      pageToken, 
      keywordsSheetId, 
      { lat, long, address },
      bookingSheetId
    );
    
    sendTyping(senderPsid, pageToken);
    setTimeout(() => {
      callSendAPI(senderPsid, alertResult.message, pageToken);
    }, 1500);
  } else {
    // Normal location share (not help request)
    let reply = `📍 Location saved!\n\n`;
    if (address) {
      reply += `Address: ${address}\n\n`;
    }
    reply += `Coordinates: ${lat}, ${long}\n`;
    reply += `Google Maps: https://www.google.com/maps?q=${lat},${long}`;
    
    sendTyping(senderPsid, pageToken);
    setTimeout(() => {
      callSendAPI(senderPsid, reply, pageToken);
    }, 1500);
  }
  
  continue; // Skip text handler
}
}

          // Handle text messages (including quick replies)
if (messaging.message && (messaging.message.text || messaging.message.quick_reply)) {
  const qrPayload = messaging.message.quick_reply?.payload;
  const userInput = messaging.message.text || qrPayload || '';
  const receivedText = userInput.toLowerCase().trim();

  // Skip auto-reply if admin has paused this conversation
  if (pausedPages.has(pageId)) {
    console.log(`⏸️ Skipping auto-reply — page ${pageId} is paused by admin`);
    continue;
  }

  // Get page config first
  const pageConfig = await getPageConfig(pageId);
  const keywordsSheetId = pageConfig?.keywordsSheetId;
  const bookingSheetId = pageConfig?.bookingSheetId;

  // Add safety check
  if (!keywordsSheetId || !bookingSheetId) {
    console.error(`❌ Missing config for page ${pageId}`);
    sendTyping(senderPsid, pageToken);
    setTimeout(() => {
      callSendAPI(senderPsid, "Sorry, configuration error. Please contact support.", pageToken);
    }, 1000);
    continue;
  }

  // ==========================================
  // PRIORITY: Check if waiting for location (BEFORE keywords)
  // ==========================================
  if (bookingSessions[senderPsid] && bookingSessions[senderPsid].step === 'waiting_for_location') {
    console.log(`📍 Processing location input for ${senderPsid}`);
    const userLocation = userInput.trim();
    
    if (userLocation.length < 3) {
      sendTyping(senderPsid, pageToken);
      setTimeout(() => {
        callSendAPI(senderPsid, "Please enter a valid location or address (at least 3 characters).", pageToken);
      }, 1000);
      continue;
    }
    
    // Store location text
    userLocations[senderPsid] = {
      address: userLocation,
      lat: null,
      long: null,
      timestamp: Date.now(),
      isManual: true
    };
    
    // Send help alert with manual location
    const alertResult = await sendHelpAlert(senderPsid, pageToken, keywordsSheetId, { address: userLocation }, bookingSheetId);
    
    // Clear the location wait session
    delete bookingSessions[senderPsid];
    
    sendTyping(senderPsid, pageToken);
    setTimeout(() => {
      callSendAPI(senderPsid, alertResult.message, pageToken);
    }, 1500);
    continue; // Skip everything else
  }

  // Refresh keywords on 'refresh data' command
  if (receivedText === 'refresh data') {
    await getKeywords(keywordsSheetId, true);
    sendTyping(senderPsid, pageToken);
    setTimeout(() => callSendAPI(senderPsid, 'Keywords refreshed!', pageToken), 1500);
    console.log('Keywords refreshed');
    continue;
  }

  // ==========================================
// HANDLE HELP/EMERGENCY REQUEST
// ==========================================
if (receivedText === 'help' || receivedText === 'emergency' || receivedText === 'sos') {
  console.log(`🚨 Emergency help request from ${senderPsid}`);
  
  // Check if user has cached location
  const location = userLocations[senderPsid];
  
  if (location) {
    // User has location, send alert immediately
    console.log(`✅ Using cached location for ${senderPsid}`);
    
    const alertResult = await sendHelpAlert(senderPsid, pageToken, keywordsSheetId, location, bookingSheetId);
    
    sendTyping(senderPsid, pageToken);
    setTimeout(() => {
      callSendAPI(senderPsid, alertResult.message, pageToken);
    }, 1500);
  } else {
    // NO LOCATION - Request it (MANDATORY)
    console.log(`⚠️ No location for ${senderPsid}, requesting now...`);
    
    // Mark as pending help request
    pendingHelpRequests.add(senderPsid);
    
    sendTyping(senderPsid, pageToken);
    setTimeout(() => {
      requestLocation(senderPsid, pageToken);
    }, 1000);
  }
  
  continue;
}

  // Handle booking session
  if (bookingSessions[senderPsid]) {
    console.log(`Processing booking step: ${bookingSessions[senderPsid].step}`);

    // Check if user wants to cancel
    if (receivedText === 'cancel' || receivedText === 'stop' || receivedText === 'exit') {
      delete bookingSessions[senderPsid];
      sendTyping(senderPsid, pageToken);
      setTimeout(() => {
        callSendAPI(senderPsid, "Booking cancelled. No problem! Feel free to book anytime.", pageToken);
      }, 1000);
      continue;
    }

    // Check if waiting for a custom date
    if (bookingSessions[senderPsid].waitingForCustomDate) {
      const customDate = userInput;

      // Validate the custom date
      const validation = validateDateFormat(customDate);
      if (!validation.valid) {
        sendTyping(senderPsid, pageToken);
        setTimeout(() => {
          callSendAPI(senderPsid,
            "Invalid date format!\n\nPlease enter the date using a standard format like **MM/DD/YYYY** or **Month DD, YYYY**.\nExample: 12/25/2025 or December 25, 2025",
            pageToken);
        }, 1000);
        continue;
      }

      // Save valid date and move to next step
      const currentStep = bookingSessions[senderPsid].step;
      const stepConfig = bookingSessions[senderPsid].config[currentStep - 1];

      if (stepConfig) {
        bookingSessions[senderPsid].data[stepConfig[0]] = validation.formatted;
      }

      delete bookingSessions[senderPsid].waitingForCustomDate;

      bookingSessions[senderPsid].step++;
      const nextQuestion = askQuestion(senderPsid, bookingSessions[senderPsid].step);

      sendTyping(senderPsid, pageToken);
      setTimeout(() => {
        if (nextQuestion.template) {
          callSendAPI(senderPsid, null, pageToken, null, nextQuestion.template);
        } else if (nextQuestion.quickReplies) {
          callSendAPI(senderPsid, nextQuestion.text, pageToken, nextQuestion.quickReplies);
        } else {
          callSendAPI(senderPsid, nextQuestion.text, pageToken);
        }
      }, 1500);
      continue;
    }

    // Proceed with booking if not waiting for a custom date
    const bookingReply = processBooking(senderPsid, userInput);

    if (bookingSessions[senderPsid] && bookingSessions[senderPsid].completed) {
      const session = bookingSessions[senderPsid];
      console.log('Booking completed! Saving...');

      const saveResult = await saveOrder(senderPsid, session.data, bookingSheetId);

      if (saveResult) {
        console.log('Saved to Google Sheets!');
      } else {
        console.error('FAILED to save!');
      }

      if (session.mobileNumber && process.env.SEMAPHORE_API_KEY) {
        const smsMessage = formatBookingSMS(session.data, session.config);
        const smsResult = await sendSMS(session.mobileNumber, smsMessage);

        if (smsResult.success) {
          console.log(`SMS sent to ${session.mobileNumber}`);
        }
      }

      delete bookingSessions[senderPsid];
    }

    sendTyping(senderPsid, pageToken);
    setTimeout(() => {
      if (bookingReply.template) {
        callSendAPI(senderPsid, null, pageToken, null, bookingReply.template);
      } else if (bookingReply.quickReplies) {
        callSendAPI(senderPsid, bookingReply.text, pageToken, bookingReply.quickReplies);
      } else {
        callSendAPI(senderPsid, bookingReply.text, pageToken);
      }
    }, 1500);
    continue;
  }

  // ==========================================
  // HANDLE LEAK REPORT SESSION
  // ==========================================
  if (leakSessions[senderPsid]) {
    const session = leakSessions[senderPsid];
    const q = LEAK_QUESTIONS[session.step];

    // Capture answer
    if (q.type === 'photo') {
      // Accept image attachment or skip
      const attachments = messaging.message?.attachments || [];
      const photo = attachments.find(a => a.type === 'image');
      if (photo) {
        session.data.photo = photo.payload.url;
      } else {
        session.data.photo = userInput.toLowerCase().includes('skip') ? 'No photo provided' : userInput;
      }
    } else if (q.type === 'contact') {
      const validation = validateMobileNumber(userInput);
      if (!validation.valid) {
        sendTyping(senderPsid, pageToken);
        setTimeout(() => callSendAPI(senderPsid, 'Invalid number. Please enter 11 digits starting with 09 (e.g. 09123456789):', pageToken), 1000);
        continue;
      }
      session.data[q.key] = validation.formatted;
    } else {
      session.data[q.key] = userInput.trim();
    }

    session.step++;

    // Ask next question or finish
    if (session.step < LEAK_QUESTIONS.length) {
      askLeakQuestion(senderPsid, LEAK_QUESTIONS[session.step], pageToken);
    } else {
      finishLeakReport(session, senderPsid, pageToken, pageId);
    }
    continue;
  }

  // ==========================================
  // HANDLE BILL INQUIRY SESSION (waiting for conscode)
  // ==========================================
  if (billSessions[senderPsid]) {
    delete billSessions[senderPsid];
    const conscode = userInput.trim();

    sendTyping(senderPsid, pageToken);

    const bill = await lookupBill(conscode);

    if (!bill) {
      setTimeout(() => {
        callSendAPI(senderPsid, `Sorry, we couldn't find a record for Conscode: "${conscode}". Please check and try again by typing BILL.`, pageToken);
      }, 1000);
    } else {
      const billReply = `Your bill (Conscode: ${bill.conscode}) for THIS MONTH is ${bill.totalAmount}. Consumption: ${bill.consumption} cubic meter. Due Date: ${bill.dueDate}. Disconnection Date: ${bill.disconDate}. Please pay on time. Thank you.`;
      setTimeout(() => {
        callSendAPI(senderPsid, billReply, pageToken);
      }, 1000);
    }
    continue;
  }

  console.log('New message from:', senderPsid);
  await logPSID(senderPsid);

  const keywords = await getKeywords(keywordsSheetId);

  // First message from user (or 24h since last): fire "welcome" keyword
  const lastGreeted = greetedUsers[senderPsid] || 0;
  const twentyFourHours = 24 * 60 * 60 * 1000;
  if (Date.now() - lastGreeted > twentyFourHours) {
    greetedUsers[senderPsid] = Date.now();
    console.log(`👋 First message from ${senderPsid}, sending welcome`);

    const welcomeMatch = keywords.find(row => {
      if (!row[0]) return false;
      const keywordList = row[0].toLowerCase().split(',').map(k => k.trim());
      return keywordList.includes('welcome');
    });

    if (welcomeMatch && welcomeMatch[1]) {
      const responses = welcomeMatch[1].split('|').map(r => r.trim());
      const welcomeReply = responses[Math.floor(Math.random() * responses.length)];

      let welcomeImageUrls = [];
      let welcomeFileUrls = [];
      const welcomeColumnC = welcomeMatch[2] ? welcomeMatch[2].trim() : null;

      if (welcomeColumnC) {
        const isUrlLike = (text) =>
          text.startsWith('http://') || text.startsWith('https://') || text.includes('drive.google.com');

        if (isUrlLike(welcomeColumnC)) {
          const allUrls = welcomeColumnC.split('|').map(url => url.trim()).filter(url => url.length > 0);
          allUrls.forEach(url => {
            const lowerUrl = url.toLowerCase();
            if (lowerUrl.endsWith('.pdf') || lowerUrl.endsWith('.doc') || lowerUrl.endsWith('.docx') || lowerUrl.endsWith('.xls') || lowerUrl.endsWith('.xlsx') || lowerUrl.includes('export=download')) {
              welcomeFileUrls.push(url);
            } else {
              welcomeImageUrls.push(url);
            }
          });
        }
      }

      sendTyping(senderPsid, pageToken);
      setTimeout(() => {
        callSendAPI(senderPsid, welcomeReply, pageToken);
        welcomeImageUrls.forEach(url => {
          callSendAPI(senderPsid, null, pageToken, null, null, url);
        });
        welcomeFileUrls.forEach(url => {
          callSendAPI(senderPsid, null, pageToken, null, null, null, url);
        });
      }, 1500);
      continue;
    }
  }


  // Keyword matching logic
  let match = keywords.find(row => {
    if (!row[0]) return false;
    const keywordList = row[0].toLowerCase().split(',').map(k => k.trim());
    return keywordList.some(keyword => receivedText.includes(keyword));
  });

  // If no direct match found, look for a 'fallback' keyword row and use it
  if (!match) {
    const fallbackRow = keywords.find(row => {
      if (!row[0]) return false;
      const keywordList = row[0].toLowerCase().split(',').map(k => k.trim());
      return keywordList.includes('fallback');
    });
    if (fallbackRow) {
      match = fallbackRow;
      console.log('🔁 Using fallback keyword response');
    }
  }

  let reply = "Hi! I want to make sure I help you correctly. Could you please clarify your concern?";

  // Track keyword misses per user
  if (!match) {
    keywordMissCounters[senderPsid] = (keywordMissCounters[senderPsid] || 0) + 1;
    console.log(`❌ Keyword miss #${keywordMissCounters[senderPsid]} for ${senderPsid}`);

    if (keywordMissCounters[senderPsid] === 1) {
      // 1st miss: greet by name
      const userInfo = await getUserInfo(senderPsid, pageToken);
      const firstName = userInfo?.firstName && userInfo.firstName !== 'Unknown' ? userInfo.firstName : null;
      reply = firstName
        ? `Hi ${firstName}! I want to make sure I help you correctly. Could you please clarify your question?`
        : `Hi! I want to make sure I help you correctly. Could you please clarify your concern?`;
    }

    if (keywordMissCounters[senderPsid] === 3) {
      // 3rd miss: handoff message (Gemini fallback removed)
      sendTyping(senderPsid, pageToken);
      setTimeout(() => {
        callSendAPI(senderPsid, "Our admin will respond to you when available. Thank you for your patience!", pageToken);
      }, 1500);
      continue;
    } else if (keywordMissCounters[senderPsid] >= 2) {
      // 2nd miss and 4+ misses: go silent, no reply at all
      console.log(`🔇 Silent mode for ${senderPsid} (miss #${keywordMissCounters[senderPsid]})`);
      continue;
    }
  } else {
    keywordMissCounters[senderPsid] = 0;
  }

  // Helper: parse a column value into sendable parts
  const isUrlLike = (text) =>
    text.startsWith('http://') || text.startsWith('https://') || text.includes('drive.google.com');

  const parseColumnContent = async (value) => {
    const result = { imageUrls: [], fileUrls: [], carouselTemplate: null, secondaryText: null };
    if (!value) return result;
    if (value.startsWith('CAROUSEL::')) {
      const elements = parseCarousel(value);
      if (elements.length) result.carouselTemplate = { type: 'template', payload: { template_type: 'generic', elements: elements.slice(0, 10) } };
    } else if (isUrlLike(value)) {
      value.split('|').map(u => u.trim()).filter(Boolean).forEach(url => {
        const lower = url.toLowerCase();
        if (lower.endsWith('.pdf') || lower.endsWith('.doc') || lower.endsWith('.docx') || lower.endsWith('.xls') || lower.endsWith('.xlsx') || lower.includes('export=download')) {
          result.fileUrls.push(url);
        } else {
          result.imageUrls.push(url);
        }
      });
    } else {
      const actionResult = await executeSpecialAction(value.toLowerCase(), senderPsid, pageToken);
      if (actionResult) result.secondaryText = actionResult;
      else result.secondaryText = value;
    }
    return result;
  };

  let colC = { imageUrls: [], fileUrls: [], carouselTemplate: null, secondaryText: null };
  let colD = { imageUrls: [], fileUrls: [], carouselTemplate: null, secondaryText: null };

  if (match) {
    // Column B — primary reply text
    if (match[1]) {
      const responses = match[1].split('|').map(r => r.trim());
      reply = responses[Math.floor(Math.random() * responses.length)];
    }
    // Column C
    if (match[2]) {
      console.log('Column C value:', match[2].trim());
      colC = await parseColumnContent(match[2].trim());
    }
    // Column D
    if (match[3]) {
      console.log('Column D value:', match[3].trim());
      colD = await parseColumnContent(match[3].trim());
    }
  }

  // Convert bracketed tokens into buttons
  // [Button Text] → postback button
  // [Button Text](https://example.com) → URL button
  const buttonPattern = /\[([^\]]+)\](?:\(([^)]+)\))?/g;
  const buttonMatches = [...reply.matchAll(buttonPattern)];

  const makeButton = (m, idx) => {
    const title = m[1].trim();
    const url = m[2] ? m[2].trim() : null;
    if (url) {
      return { type: "web_url", title, url };
    }
    return { type: "postback", title, payload: `BTN_${title.toUpperCase().replace(/[^A-Z0-9]+/g, '_')}_${idx}` };
  };

  // Helper: send all parts of a parsed column (text/images/files/carousel)
  const sendColParts = (col) => {
    if (!col) return;
    if (col.secondaryText) {
      const secMatches = [...col.secondaryText.matchAll(buttonPattern)];
      if (secMatches.length) {
        const secButtons = secMatches.slice(0, 3).map((m, idx) => makeButton(m, idx));
        const cleanText = col.secondaryText.replace(buttonPattern, '').replace(/\s+/g, ' ').trim() || 'Please choose an option:';
        callSendAPI(senderPsid, null, pageToken, null, { type: 'template', payload: { template_type: 'button', text: cleanText, buttons: secButtons } });
      } else {
        callSendAPI(senderPsid, col.secondaryText, pageToken);
      }
    }
    if (col.carouselTemplate) callSendAPI(senderPsid, null, pageToken, null, col.carouselTemplate);
    col.imageUrls.forEach(url => callSendAPI(senderPsid, null, pageToken, null, null, url));
    col.fileUrls.forEach(url => callSendAPI(senderPsid, null, pageToken, null, null, null, url));
  };

  // Column B — send first
  sendTyping(senderPsid, pageToken);
  setTimeout(() => {
    if (buttonMatches.length && colC.imageUrls.length === 0) {
      const buttons = buttonMatches.slice(0, 3).map((m, idx) => makeButton(m, idx));
      const cleanText = reply.replace(buttonPattern, '').replace(/\s+/g, ' ').trim() || 'Please choose an option:';
      callSendAPI(senderPsid, null, pageToken, null, { type: 'template', payload: { template_type: 'button', text: cleanText, buttons } });
    } else {
      callSendAPI(senderPsid, reply, pageToken);
    }
  }, 1500);

  // Column C — send after B
  const hasColC = colC.secondaryText || colC.carouselTemplate || colC.imageUrls.length || colC.fileUrls.length;
  if (hasColC) {
    setTimeout(() => sendColParts(colC), 2500);
  }

  // Column D — send after C
  const hasColD = colD.secondaryText || colD.carouselTemplate || colD.imageUrls.length || colD.fileUrls.length;
  if (hasColD) {
    setTimeout(() => sendColParts(colD), 3500);
  }
}
              }
      }

      // ==========================================
      // Handle Facebook Post Comments
      // ==========================================
      if (entry.changes) {
        console.log(`🔄 Processing ${entry.changes.length} change(s) for page ${pageId}`);
        for (const change of entry.changes) {
          console.log('📝 Change detected:', change.field);
          
          if (change.field !== 'feed') {
            console.log(`   ⏭️  Skipping non-feed change: ${change.field}`);
            continue;
          }

          // Handle feed comments
          if (change.field === 'feed' && change.value) {
            const value = change.value;
            console.log(`📋 Feed change value:`, JSON.stringify(value, null, 2));
            
            // Check if this is a comment
            if (value.item === 'comment' && value.comment_id) {
              const commentId = value.comment_id;
              const commentText = value.message || '';
              const senderId = value.from?.id;
              const postId = value.post_id;

              console.log(`💬 Comment received on post ${postId}`);
              console.log(`   Comment ID: ${commentId}`);
              console.log(`   From: ${senderId}`);
              console.log(`   Text: ${commentText}`);


 // 🛑 Skip if comment is from the page itself (prevent infinite loop)
  if (senderId === pageId) {
    console.log(`⏭️  Skipping comment from page itself`);
    continue;
  }

              // Prevent duplicate processing
              if (processedComments.has(commentId)) {
                console.log(`⏭️  Comment ${commentId} already processed, skipping`);
                continue;
              }

              // Mark as processed
              processedComments.add(commentId);

              // Get page config early (for keywordsSheetId)
              const pageConfig = await getPageConfig(pageId);
              const keywordsSheetId = pageConfig?.keywordsSheetId;

              if (!keywordsSheetId) {
                console.log(`ⓘ No keywords sheet configured for page ${pageId}, skipping comment processing`);
                continue;
              }

              // ===== NEW: SENTIMENT ANALYSIS & COMMENT COLLECTION =====
              console.log(`🔍 Starting sentiment analysis for comment: "${commentText.substring(0, 50)}..."`);

              // Get sender name
              const senderName = await getSenderName(senderId, pageToken);
              console.log(`👤 Sender: ${senderName} (${senderId})`);

              // Analyze sentiment
              const sentimentAnalysis = await analyzeSentiment(commentText);
              console.log(`📊 Sentiment Result: ${sentimentAnalysis.sentiment} (Score: ${sentimentAnalysis.score})`);

              // Save comment to Google Sheet
              const commentData = {
                commentId,
                postId,
                senderId,
                senderName,
                commentText,
                sentiment: sentimentAnalysis.sentiment,
                sentimentScore: sentimentAnalysis.score,
                sentimentReason: sentimentAnalysis.reason
              };

              const saved = await saveCommentToSheet(pageId, commentData, keywordsSheetId);
              
              if (!saved) {
                console.warn(`⚠️ Failed to save comment to sheet`);
              }

              // Send email report if this is the 10th, 50th, or 100th comment
              try {
                const res = await sheets.spreadsheets.values.get({
                  spreadsheetId: keywordsSheetId,
                  range: 'Comments!A:A',
                });
                const commentCount = (res.data.values || []).length - 1; // Subtract header
                
                if (commentCount > 0 && (commentCount % 10 === 0)) {
                  console.log(`📧 Comment milestone reached (${commentCount} comments). Sending report to ${pageConfig?.recipientEmail}...`);
                  
                  // Get recent comments for report
                  const commentRes = await sheets.spreadsheets.values.get({
                    spreadsheetId: keywordsSheetId,
                    range: 'Comments!A2:J1000',
                  });
                  
                  const rows = commentRes.data.values || [];
                  const comments = rows.map(row => ({
                    timestamp: row[0],
                    pageId: row[1],
                    commentId: row[2],
                    postId: row[3],
                    senderId: row[4],
                    senderName: row[5],
                    commentText: row[6],
                    sentiment: row[7],
                    sentimentScore: parseFloat(row[8]) || 0,
                    sentimentReason: row[9]
                  }));
                  
                  if (comments.length > 0) {
                    if (pageConfig?.recipientEmail) {
                      await sendSentimentReportEmail(comments.slice(-20), pageConfig.recipientEmail); // Send last 20
                    } else {
                      console.warn(`⚠️ No email configured for milestone report on page ${pageId}`);
                    }
                  }
                }
              } catch (err) {
                console.error('❌ Error sending milestone email:', err.message);
              }

              // ===== OPTIONAL: Auto-reply based on sentiment =====
              // Get keywords
              const keywords = await getKeywords(keywordsSheetId);
              const receivedText = commentText.toLowerCase().trim();

              // Find matching keyword for auto-reply
              const match = keywords.find(row => {
                if (!row[0]) return false;
                const keywordList = row[0].toLowerCase().split(',').map(k => k.trim());
                return keywordList.some(keyword => receivedText.includes(keyword));
              });

              let reply = "Thanks for your comment! 😊";

              if (match && match[1]) {
                const responses = match[1].split('|').map(r => r.trim());
                reply = responses[Math.floor(Math.random() * responses.length)];
              }

              // Send private reply to comment
              try {
                console.log(`📤 Attempting to reply to comment ${commentId} with: "${reply}"`);
                await replyToComment(commentId, reply, pageToken);
                console.log(`✅ Replied to comment ${commentId}`);
              } catch (error) {
                console.error(`❌ Failed to reply to comment ${commentId}:`, error.message || error);
                console.error(`   Full error:`, error);
              }
            }
          }
        }
      }

    }
  }
  res.sendStatus(200);
});
 
// =======================
// SUBSCRIBE PAGES TO FEED
// =======================
app.get('/subscribe-feed', async (req, res) => {
  try {
    const pageConfig = await getPageConfig(process.env.PAGE_ID || req.query.pageId);
    
    if (!pageConfig) {
      return res.status(404).json({ 
        error: 'Page configuration not found',
        message: 'Please add page config to WebhookConfig sheet'
      });
    }

    const subscribeUrl = `https://graph.facebook.com/${process.env.GRAPH_API_VERSION}/${pageConfig.pageId}/subscribed_apps`;
    
    request.post(
      {
        uri: subscribeUrl,
        qs: { 
          access_token: pageConfig.pageToken,
          subscribed_fields: 'messages,messaging_postbacks,feed,messaging_handovers,message_echoes'
        }
      },
      (err, response, body) => {
        if (!err && response.statusCode === 200) {
          console.log('✅ Page subscribed to webhook');
          res.json({ 
            success: true, 
            message: 'Page subscribed successfully',
            response: JSON.parse(body)
          });
        } else {
          console.error('❌ Failed to subscribe page:', err || body);
          res.status(500).json({ 
            success: false, 
            error: err || body 
          });
        }
      }
    );
  } catch (error) {
    res.status(500).json({ 
      success: false, 
      error: error.message 
    });
  }
});

// =======================
// CHECK SUBSCRIPTION STATUS
// =======================
app.get('/check-subscriptions', async (req, res) => {
  try {
    const pageConfig = await getPageConfig(process.env.PAGE_ID || req.query.pageId);
    
    if (!pageConfig) {
      return res.status(404).json({ 
        error: 'Page configuration not found' 
      });
    }

    const checkUrl = `https://graph.facebook.com/${process.env.GRAPH_API_VERSION}/${pageConfig.pageId}/subscribed_apps`;
    
    request.get(
      {
        uri: checkUrl,
        qs: { access_token: pageConfig.pageToken }
      },
      (err, response, body) => {
        if (!err && response.statusCode === 200) {
          const data = JSON.parse(body);
          console.log('✅ Subscription status retrieved');
          res.json({ 
            success: true,
            pageId: pageConfig.pageId,
            subscriptions: data.data || []
          });
        } else {
          console.error('❌ Failed to check subscriptions:', err || body);
          res.status(500).json({ 
            success: false, 
            error: err || body 
          });
        }
      }
    );
  } catch (error) {
    res.status(500).json({ 
      success: false, 
      error: error.message 
    });
  }
});

// =======================
// BILL SHEET TEST ENDPOINT
// =======================
app.get('/check-bill-sheet', async (req, res) => {
  const conscode = req.query.conscode || '';
  try {
    const sheetRes = await sheets.spreadsheets.values.get({
      spreadsheetId: BILL_SHEET_ID,
      range: `${BILL_TAB_NAME}!A:Z`,
    });
    const rows = sheetRes.data.values || [];
    const headers = rows[0] || [];
    const allConscodes = rows.slice(1).map(r => r[0]);

    if (conscode) {
      const bill = await lookupBill(conscode);
      return res.json({ success: true, headers, allConscodes, bill });
    }

    res.json({ success: true, headers, totalRows: rows.length - 1, allConscodes });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

/* =======================
   SENTIMENT ANALYSIS API ENDPOINTS
======================= */

/**
 * GET /comment-stats
 * Get statistics about collected comments
 */
app.get('/comment-stats', async (req, res) => {
  try {
    // Get all pages from WebhookConfig
    const configRes = await sheets.spreadsheets.values.get({
      spreadsheetId: process.env.SHEET_ID,
      range: 'WebhookConfig!A:G',
    });

    const configRows = configRes.data.values || [];
    const allComments = [];

    // Fetch comments from each page's keywords sheet
    for (let i = 1; i < configRows.length; i++) {
      const [pageId, , keywordsSheetId] = configRows[i];
      
      if (!pageId || !keywordsSheetId) continue;

      try {
        const commentRes = await sheets.spreadsheets.values.get({
          spreadsheetId: keywordsSheetId,
          range: 'Comments!A2:J1000',
        });

        const rows = commentRes.data.values || [];
        rows.forEach(row => {
          allComments.push({
            timestamp: row[0],
            sentiment: row[7],
            sentimentScore: parseFloat(row[8]) || 0
          });
        });
      } catch (err) {
        // Sheet might not have Comments tab yet
        if (!err.message.includes('Unable to parse range')) {
          console.error(`Error fetching comments from page:`, err.message);
        }
      }
    }

    const comments = allComments;
    const positiveCount = comments.filter(c => c.sentiment === 'POSITIVE').length;
    const negativeCount = comments.filter(c => c.sentiment === 'NEGATIVE').length;
    const neutralCount = comments.filter(c => c.sentiment === 'NEUTRAL').length;
    const unknownCount = comments.filter(c => c.sentiment === 'UNKNOWN').length;
    const avgScore = comments.length > 0 
      ? comments.reduce((sum, c) => sum + c.sentimentScore, 0) / comments.length 
      : 0;

    res.json({
      success: true,
      totalComments: comments.length,
      sentimentBreakdown: {
        positive: positiveCount,
        negative: negativeCount,
        neutral: neutralCount,
        unknown: unknownCount
      },
      percentages: {
        positive: comments.length > 0 ? ((positiveCount / comments.length) * 100).toFixed(1) : '0.0',
        negative: comments.length > 0 ? ((negativeCount / comments.length) * 100).toFixed(1) : '0.0',
        neutral: comments.length > 0 ? ((neutralCount / comments.length) * 100).toFixed(1) : '0.0',
        unknown: comments.length > 0 ? ((unknownCount / comments.length) * 100).toFixed(1) : '0.0'
      },
      averageSentimentScore: avgScore.toFixed(2)
    });
  } catch (err) {
    res.status(500).json({ 
      success: false, 
      error: err.message,
      hint: 'Make sure WebhookConfig is set up and pages have keywords sheets' 
    });
  }
});

/**
 * POST /send-sentiment-report
 * Manually trigger sending a sentiment analysis report
 */
app.post('/send-sentiment-report', async (req, res) => {
  try {
    // Get all pages from WebhookConfig
    const configRes = await sheets.spreadsheets.values.get({
      spreadsheetId: process.env.SHEET_ID,
      range: 'WebhookConfig!A:G',
    });

    const configRows = configRes.data.values || [];
    const allComments = [];

    // Fetch comments from each page's keywords sheet
    for (let i = 1; i < configRows.length; i++) {
      const [pageId, , keywordsSheetId, , , , recipientEmail] = configRows[i];
      
      if (!pageId || !keywordsSheetId) continue;

      try {
        const commentRes = await sheets.spreadsheets.values.get({
          spreadsheetId: keywordsSheetId,
          range: 'Comments!A2:J1000',
        });

        const rows = commentRes.data.values || [];
        rows.forEach(row => {
          allComments.push({
            timestamp: row[0],
            pageId: row[1],
            commentId: row[2],
            postId: row[3],
            senderId: row[4],
            senderName: row[5],
            commentText: row[6],
            sentiment: row[7],
            sentimentScore: parseFloat(row[8]) || 0,
            sentimentReason: row[9]
          });
        });
      } catch (err) {
        if (!err.message.includes('Unable to parse range')) {
          console.error(`Error fetching comments:`, err.message);
        }
      }
    }

    if (allComments.length === 0) {
      return res.status(400).json({ 
        success: false, 
        message: 'No comments to report yet' 
      });
    }

    // Send reports to each page's email with their comments
    let emailsSent = 0;
    for (let i = 1; i < configRows.length; i++) {
      const [pageId, , , , , , recipientEmail] = configRows[i];
      if (!recipientEmail) continue;
      
      // Get comments for this specific page
      const pageComments = allComments.filter(c => c.pageId === pageId);
      if (pageComments.length > 0) {
        const sent = await sendSentimentReportEmail(pageComments.slice(-50), recipientEmail);
        if (sent) emailsSent++;
      }
    }

    if (emailsSent > 0) {
      res.json({
        success: true,
        message: `Sentiment reports sent to ${emailsSent} page email(s)`,
        totalComments: allComments.length,
        pageEmailsSent: emailsSent
      });
    } else {
      res.status(500).json({
        success: false,
        message: 'Failed to send email. Check configuration.'
      });
    }
  } catch (err) {
    res.status(500).json({ 
      success: false, 
      error: err.message 
    });
  }
});

/**
 * GET /trigger-daily-report
 * Manually trigger the daily sentiment report (for testing)
 */
app.get('/trigger-daily-report', async (req, res) => {
  try {
    // Get all pages from WebhookConfig
    const configRes = await sheets.spreadsheets.values.get({
      spreadsheetId: process.env.SHEET_ID,
      range: 'WebhookConfig!A:G',
    });

    const configRows = configRes.data.values || [];
    const allComments = [];

    // Fetch comments from each page's keywords sheet
    for (let i = 1; i < configRows.length; i++) {
      const [pageId, , keywordsSheetId, , , , recipientEmail] = configRows[i];
      
      if (!pageId || !keywordsSheetId) continue;

      try {
        const commentRes = await sheets.spreadsheets.values.get({
          spreadsheetId: keywordsSheetId,
          range: 'Comments!A2:J1000',
        });

        const rows = commentRes.data.values || [];
        rows.forEach(row => {
          allComments.push({
            timestamp: row[0],
            pageId: row[1],
            commentId: row[2],
            postId: row[3],
            senderId: row[4],
            senderName: row[5],
            commentText: row[6],
            sentiment: row[7],
            sentimentScore: parseFloat(row[8]) || 0,
            sentimentReason: row[9]
          });
        });
      } catch (err) {
        if (!err.message.includes('Unable to parse range')) {
          console.error(`Error fetching comments:`, err.message);
        }
      }
    }

    if (allComments.length === 0) {
      return res.status(400).json({ 
        success: false, 
        message: 'No comments to report yet' 
      });
    }

    // Filter comments from last 24 hours
    const oneDayAgo = Date.now() - (24 * 60 * 60 * 1000);
    const recentComments = allComments.filter(c => {
      const commentTime = new Date(c.timestamp).getTime();
      return commentTime > oneDayAgo;
    });

    let emailsSent = 0;
    if (recentComments.length > 0) {
      // Send reports to each page's email with their recent comments
      for (let i = 1; i < configRows.length; i++) {
        const [pageId, , , , , , recipientEmail] = configRows[i];
        if (!recipientEmail) continue;
        
        const pageComments = recentComments.filter(c => c.pageId === pageId);
        if (pageComments.length > 0) {
          const sent = await sendSentimentReportEmail(pageComments, recipientEmail);
          if (sent) emailsSent++;
        }
      }
    }

    res.json({
      success: true,
      message: emailsSent > 0 ? `Daily reports sent to ${emailsSent} email(s)` : 'No comments from last 24h',
      recentComments: recentComments.length,
      totalComments: allComments.length,
      emailsSent
    });
  } catch (err) {
    res.status(500).json({ 
      success: false, 
      error: err.message 
    });
  }
});

/**
 * GET /comments-export
 * Export all comments as JSON
 */
app.get('/comments-export', async (req, res) => {
  try {
    // Get all pages from WebhookConfig
    const configRes = await sheets.spreadsheets.values.get({
      spreadsheetId: process.env.SHEET_ID,
      range: 'WebhookConfig!A:G',
    });

    const configRows = configRes.data.values || [];
    const allComments = [];

    // Fetch comments from each page's keywords sheet
    for (let i = 1; i < configRows.length; i++) {
      const [pageId, , keywordsSheetId] = configRows[i];
      
      if (!pageId || !keywordsSheetId) continue;

      try {
        const commentRes = await sheets.spreadsheets.values.get({
          spreadsheetId: keywordsSheetId,
          range: 'Comments!A2:J1000',
        });

        const rows = commentRes.data.values || [];
        rows.forEach(row => {
          allComments.push({
            timestamp: row[0],
            pageId: row[1],
            commentId: row[2],
            postId: row[3],
            senderId: row[4],
            senderName: row[5],
            commentText: row[6],
            sentiment: row[7],
            sentimentScore: parseFloat(row[8]) || 0,
            sentimentReason: row[9]
          });
        });
      } catch (err) {
        if (!err.message.includes('Unable to parse range')) {
          console.error(`Error fetching comments:`, err.message);
        }
      }
    }

    res.json({
      success: true,
      totalComments: allComments.length,
      comments: allComments
    });
  } catch (err) {
    res.status(500).json({ 
      success: false, 
      error: err.message 
    });
  }
});

// --- Scheduled Posts Checker (reuse existing jwtClient) ---
const axios = require('axios'); // make sure axios is imported

// Helper to get a valid access token
async function getAccessToken() {
  try {
    const tokenResponse = await jwtClient.authorize(); // uses existing jwtClient
    console.log('✅ Access Token fetched');
    console.log('🔹 Email:', jwtClient.email);
    console.log('🔹 Scopes:', jwtClient.scopes.join(','));
    console.log('🔹 Token (first 50 chars):', tokenResponse.access_token.substring(0, 50), '...');
    return tokenResponse.access_token;
  } catch (err) {
    console.error('❌ Error fetching access token:', err);
    throw err;
  }
}

// --- Scheduled Posts Checker (Node.js fetch version, no axios needed) ---

// Helper to get a valid access token using existing jwtClient
async function getAccessToken() {
  try {
    const tokenResponse = await jwtClient.authorize(); // uses your existing jwtClient
    console.log('✅ Access Token fetched');
    console.log('🔹 Email:', jwtClient.email);
    console.log('🔹 Scopes:', jwtClient.scopes.join(','));
    console.log('🔹 Token (first 50 chars):', tokenResponse.access_token.substring(0, 50), '...');
    return tokenResponse.access_token;
  } catch (err) {
    console.error('❌ Error fetching access token:', err);
    throw err;
  }
}

// Scheduled posts checker function using fetch
async function checkScheduledPosts() {
  try {
    const accessToken = await getAccessToken();

    // Example API call — replace with your actual scheduled posts endpoint
    const response = await fetch('https://www.googleapis.com/calendar/v3/calendars/primary/events', {
      headers: { Authorization: `Bearer ${accessToken}` },
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`HTTP ${response.status}: ${errorText}`);
    }

    const data = await response.json();
    console.log('✅ Scheduled posts fetched:', data.items?.length || 0);
  } catch (err) {
    console.error('❌ Error in scheduled posts checker:', err.message);
  }
}

// Run every 5 minutes
setInterval(() => {
  console.log('🕑 Running scheduled posts check...');
  checkScheduledPosts();
}, 5 * 60 * 1000);

// Run once immediately on server start
checkScheduledPosts();


// =======================
// AUTO-SUBSCRIBE ALL PAGES ON STARTUP
// =======================
async function autoSubscribeAllPages() {
  try {
    console.log('\n🔄 Auto-subscribing all pages to feed events...\n');
    
    const res = await sheets.spreadsheets.values.get({
      spreadsheetId: process.env.SHEET_ID,
      range: 'WebhookConfig!A:G',
    });

    const rows = res.data.values || [];
    if (rows.length < 2) {
      console.warn('⚠️  No pages configured in WebhookConfig sheet');
      return;
    }

    let successCount = 0;
    let failCount = 0;

    // Skip header row, subscribe each page
    for (let i = 1; i < rows.length; i++) {
      const row = rows[i];
      const pageId = row[0];
      const pageToken = row[1];

      if (!pageId || !pageToken) {
        console.warn(`⏭️  Skipping row ${i + 1}: Missing pageId or pageToken`);
        continue;
      }

      try {
        await new Promise((resolve, reject) => {
          request.post(
            {
              uri: `https://graph.facebook.com/${process.env.GRAPH_API_VERSION || 'v23.0'}/${pageId}/subscribed_apps`,
              qs: {
                access_token: pageToken,
                subscribed_fields: 'messages,messaging_postbacks,feed,messaging_handovers,message_echoes'
              }
            },
            (err, response, body) => {
              if (!err && response.statusCode === 200) {
                console.log(`✅ Page ${pageId} subscribed to feed events`);
                successCount++;
                resolve();
              } else {
                console.error(`❌ Failed to subscribe page ${pageId}:`, err || body);
                failCount++;
                resolve(); // Don't reject, continue with next page
              }
            }
          );
        });
      } catch (err) {
        console.error(`❌ Error subscribing page ${pageId}:`, err.message);
        failCount++;
      }
    }

    console.log(`\n📊 Subscription Results: ${successCount} succeeded, ${failCount} failed\n`);
  } catch (error) {
    console.error('❌ Error in autoSubscribeAllPages:', error.message);
  }
}



// =======================
// SERVER START
// =======================
const PORT = process.env.PORT || 3000;
app.listen(PORT, async () => {
  console.log(`\n${'='.repeat(80)}`);
  console.log(`✅ Server running on port ${PORT}`);
  console.log(`✅ Graph API: ${process.env.GRAPH_API_VERSION || 'v21.0'}`);
  console.log(`${'='.repeat(80)}\n`);
  console.log(`📋 Available endpoints:`);
  console.log(`   GET  /webhook              - Webhook verification`);
  console.log(`   POST /webhook              - Receive events`);
  console.log(`   GET  /health               - Health check`);
  console.log(`   GET  /subscribe-feed       - Subscribe pages to feed`);
  console.log(`   GET  /check-subscriptions  - Check subscription status`);
  console.log(`${'='.repeat(80)}\n`);

  // Auto-subscribe all pages to feed events (disabled - use /subscribe-feed endpoint manually)
  // await autoSubscribeAllPages();
});
