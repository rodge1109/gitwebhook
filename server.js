   // server.js
 
require('dotenv').config();
const express = require('express');
const bodyParser = require('body-parser');
const { google } = require('googleapis');
const request = require('request');

const app = express();
app.use(bodyParser.json());

const pendingHelpRequests = new Set();


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


// =======================
// SMS INTEGRATION (Semaphore)
// =======================

async function sendSMS(phoneNumber, message) {
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
      sendername: process.env.SEMAPHORE_SENDER_NAME || 'KIARA'
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
async function startBooking(psid, bookingConfig) {
  bookingSessions[psid] = {
    step: 0,
    config: bookingConfig,
    data: {},
    startedAt: new Date()
  };

  return {
    text: null,
    template: {
      type: "template",
      payload: {
        template_type: "button",
        text: "Great! I'll help you with your booking.\n\nAre you ready to proceed?",
        buttons: [
          {
            type: "postback",
            title: "YES, Continue",
            payload: "BOOKING_YES"
          },
          {
            type: "postback",
            title: "NO, Cancel",
            payload: "BOOKING_NO"
          }
        ]
      }
    }
  };
}

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
// UTILITIES
// =======================

const keywordsCache = {};

async function getPageConfig(pageId) {
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
    console.error('Error fetching page config:', err);
    return null;
  }
}

async function getKeywords(sheetId, forceRefresh = false) {
  if (forceRefresh || !keywordsCache[sheetId]) {
    try {
      const res = await sheets.spreadsheets.values.get({
        spreadsheetId: sheetId,
        range: 'KeywordsDM!A:C',
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

async function getBookingConfig(sheetId) {
  try {
    const res = await sheets.spreadsheets.values.get({
      spreadsheetId: sheetId,
      range: 'BookingConfig!A:D',
    });
    const rows = res.data.values || [];
    return rows.slice(1);
  } catch (err) {
    console.error(`Error fetching BookingConfig from sheet ${sheetId}:`, err);
    return null;
  }
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
    
    // Filter by type and return phone numbers
    const hotlines = [];
    for (let i = 1; i < rows.length; i++) {
      const [hotlineType, name, phoneNumber] = rows[i];
      
      if (hotlineType && hotlineType.toLowerCase() === type.toLowerCase() && phoneNumber) {
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
// SEND HELP/EMERGENCY ALERT
// =======================

/**
 * Send emergency SMS alert with user info and location
 */
async function sendHelpAlert(psid, pageToken, keywordsSheetId, location = null) {
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
    
// =======================
// REMINDER FOR PENDING HELP REQUESTS
// =======================

// Check for pending help requests every 30 seconds
setInterval(() => {
  pendingHelpRequests.forEach(async (psid) => {
    const timePending = Date.now() - (userLocations[psid]?.timestamp || 0);
    
    // If pending for more than 2 minutes, send reminder
    if (timePending > 2 * 60 * 1000) {
      console.log(`⏰ Reminding ${psid} to share location...`);
      
      try {
        // Get page token (you'll need to store this or fetch it)
        // For now, we'll skip auto-reminder
        // You can enhance this if needed
      } catch (error) {
        console.error('Error sending reminder:', error);
      }
    }
  });
}, 30 * 1000);


    // Build SMS message
    let smsMessage = ` HELP REQUEST ALERT \n\n`;
    smsMessage += `From: ${userInfo.fullName}\n`;
    smsMessage += `Facebook ID: ${psid}\n`;
    
    if (location) {
      smsMessage += `\nLocation:\n`;
      if (location.address) {
       smsMessage += `${location.address}\n`;
      }
      smsMessage += `Coordinates: ${location.lat}, ${location.long}\n`;
      smsMessage += `Maps: https://maps.google.com/?q=${location.lat},${location.long}\n`;
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
 * Request location from user with quick reply button
 */
function requestLocation(senderPsid, pageToken) {
  const messageData = {
    recipient: { id: senderPsid },
    message: {
      text: "📍 Please share your location so I can help you better!",
      quick_replies: [
        {
          content_type: "location",          // Use text instead of location
          title: "Share my location",    // What the user sees on the button
          payload: "USER_WILL_SEND_LOCATION" // Your bot will receive this payload
        }
      ]
    }
  };
  
  request(
    {
      uri: `https://graph.facebook.com/${process.env.GRAPH_API_VERSION}/me/messages`,
      qs: { access_token: pageToken },
      method: 'POST',
      json: messageData
    },
    (err, res, body) => {
      if (!err) {
        console.log('📍 Location request sent!');
      } else {
        console.error('❌ Unable to send location request:', err);
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

function callSendAPI(senderPsid, response, pageToken, quickReplies = null, template = null, imageUrl = null) {
  let messageData = {
    recipient: { id: senderPsid }
  };
  
  if (template) {
    messageData.message = { attachment: template };
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
// SCHEDULED POSTS CHECKER (Multi-Page Support)
// =======================

async function checkScheduledPosts() {
  try {
    console.log('🔍 Checking for scheduled posts across all pages...');
    
    // Get all pages from WebhookConfig
    const configRes = await sheets.spreadsheets.values.get({
      spreadsheetId: process.env.SHEET_ID,
      range: 'WebhookConfig!A:D',
    });
    
    const configRows = configRes.data.values || [];
    
    if (configRows.length <= 1) {
      console.log('❌ No pages found in WebhookConfig');
      return;
    }
    
    // Loop through each page (skip header row)
    for (let p = 1; p < configRows.length; p++) {
      const [pageId, pageToken, keywordsSheetId, bookingSheetId] = configRows[p];
      
      if (!pageId || !pageToken || !keywordsSheetId) {
        console.log(`⏭️  Skipping incomplete config row ${p}`);
        continue;
      }
      
      console.log(`📄 Checking scheduled posts for page: ${pageId}`);
      
      try {
        // Get scheduled posts from the keywords sheet
        const res = await sheets.spreadsheets.values.get({
          spreadsheetId: keywordsSheetId,
          range: 'ScheduledPosts!A:E',
        });
        
        const rows = res.data.values || [];
        
        if (rows.length <= 1) {
          console.log(`  📭 No scheduled posts found for page ${pageId}`);
          continue;
        }
        
        const now = new Date();
        let postsFound = 0;
        
        // Check each scheduled post
        for (let i = 1; i < rows.length; i++) {
          const row = rows[i];
          const [scheduledTime, type, message, imageUrls, posted] = row;
          
          // Skip if already posted
          if (posted && posted.toLowerCase() === 'yes') {
            continue;
          }
          
          // Skip if incomplete
          if (!scheduledTime || !type || !message) {
            continue;
          }
          
          // Parse scheduled time
          const postTime = new Date(scheduledTime);
          
          // Check if it's time to post (within last 10 minutes)
          const timeDiff = now - postTime;
          const tenMinutes = 10 * 60 * 1000;
          
          if (timeDiff >= 0 && timeDiff <= tenMinutes) {
            postsFound++;
            console.log(`  📅 Time to post for page ${pageId}: "${message.substring(0, 50)}..."`);
            
            try {
              let postResult;
              
              // Post based on type
              if (type === 'text') {
                postResult = await postToFacebook(pageId, pageToken, message);
              } else if (type === 'image') {
                if (!imageUrls) {
                  console.error('  ❌ No image URL provided for image post');
                  continue;
                }
                postResult = await postImageToFacebook(pageId, pageToken, imageUrls, message);
              } else if (type === 'album') {
                if (!imageUrls) {
                  console.error('  ❌ No image URLs provided for album post');
                  continue;
                }
                const urls = imageUrls.split('|').map(url => url.trim());
                postResult = await postMultipleImagesToFacebook(pageId, pageToken, urls, message);
              } else {
                console.error(`  ❌ Unknown post type: ${type}`);
                continue;
              }
              
              // Mark as posted
              await sheets.spreadsheets.values.update({
                spreadsheetId: keywordsSheetId,
                range: `ScheduledPosts!E${i + 1}`,
                valueInputOption: 'RAW',
                resource: {
                  values: [['YES']]
                }
              });
              
              console.log(`  ✅ Post published! Post ID: ${postResult.id}`);
              
            } catch (error) {
              console.error(`  ❌ Error posting:`, error.message);
            }
          }
        }
        
        if (postsFound === 0) {
          console.log(`  ⏰ No posts ready to publish for page ${pageId}`);
        }
        
      } catch (error) {
        // If ScheduledPosts sheet doesn't exist for this page, that's OK
        if (error.message && error.message.includes('Unable to parse range')) {
          console.log(`  ⏭️  No ScheduledPosts sheet found for page ${pageId}`);
        } else {
          console.error(`  ❌ Error checking posts for page ${pageId}:`, error.message);
        }
      }
    }
    
    console.log('✅ Finished checking all pages');
    
  } catch (error) {
    console.error('❌ Error in scheduled posts checker:', error);
  }
}

// Run scheduler every 5 minutes
setInterval(checkScheduledPosts, 5 * 60 * 1000);

// Run once on startup
checkScheduledPosts();

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

  // Initialize the processedComments set
  const processedComments = new Set();

  // Check for valid object type
  if (body.object === 'page') {
    for (const entry of body.entry) {
      const pageId = entry.id;
      const pageToken = await getPageToken(pageId);

      // Handle Messenger messages and postbacks
      if (entry.messaging) {
        for (const messaging of entry.messaging) {
          const senderPsid = messaging.sender.id;

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
            } else if (payload === 'BOOKING_NO') {
              // Booking flow for NO
              delete bookingSessions[senderPsid];
              sendTyping(senderPsid, pageToken);
              setTimeout(() => {
                callSendAPI(senderPsid, "Booking cancelled. No problem! Feel free to book anytime.", pageToken);
              }, 1000);
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
            }
            continue;
          }

// ==========================================
// Handle Location Messages
// ==========================================
if (messaging.message && messaging.message.attachments) {
  const attachments = messaging.message.attachments;
  
  // Check if user sent a location
  const locationAttachment = attachments.find(att => att.type === 'location');
  
if (locationAttachment) {
  const coords = locationAttachment.payload.coordinates;
  const lat = coords.lat;
  const long = coords.long;
  
  console.log(`📍 Location received from ${senderPsid}: ${lat}, ${long}`);
  
  // Get page config
  const pageConfig = await getPageConfig(pageId);
  const keywordsSheetId = pageConfig?.keywordsSheetId;
  
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
      { lat, long, address }
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

          // Handle text messages
if (messaging.message && messaging.message.text) {
  const receivedText = messaging.message.text.toLowerCase().trim();
  
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
    
    const alertResult = await sendHelpAlert(senderPsid, pageToken, keywordsSheetId, location);
    
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
      callSendAPI(
        senderPsid, 
        "🚨 EMERGENCY HELP REQUEST\n\n⚠️ To send help, we need your location.\n\nPlease click the button below to share your current location:",
        pageToken,
        [{ content_type: "location" }]
      );
    }, 1000);
    
    // Send follow-up instruction
    setTimeout(() => {
      callSendAPI(
        senderPsid,
        "📍 How to share location:\n\n1. Click the 📍 button above\n2. Allow location access\n3. Confirm your location\n\nHelp will be sent immediately after!",
        pageToken
      );
    }, 2500);
  }
  
  continue;
}

  // Handle booking session
  if (bookingSessions[senderPsid]) {
    console.log(`Processing booking step: ${bookingSessions[senderPsid].step}`);

    // Check if waiting for a custom date
    if (bookingSessions[senderPsid].waitingForCustomDate) {
      const customDate = messaging.message.text;

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
    const bookingReply = processBooking(senderPsid, messaging.message.text);

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

  console.log('New message from:', senderPsid);
  await logPSID(senderPsid);

  const keywords = await getKeywords(keywordsSheetId);

  // Check for order or booking commands
  if (receivedText.includes('order') || receivedText.includes('book')) {
    const bookingConfig = await getBookingConfig(bookingSheetId);

    if (bookingConfig && bookingConfig.length > 0) {
      const bookingReply = await startBooking(senderPsid, bookingConfig);
      sendTyping(senderPsid, pageToken);
      setTimeout(() => {
        if (bookingReply.template) {
          callSendAPI(senderPsid, null, pageToken, null, bookingReply.template);
        } else {
          callSendAPI(senderPsid, bookingReply.text, pageToken);
        }
      }, 1500);
    } else {
      sendTyping(senderPsid, pageToken);
      setTimeout(() => {
        callSendAPI(senderPsid, "Sorry, booking is not available at the moment.", pageToken);
      }, 1500);
    }
    continue;
  }

  // Keyword matching logic
  const match = keywords.find(row => {
    if (!row[0]) return false;
    const keywordList = row[0].toLowerCase().split(',').map(k => k.trim());
    return keywordList.some(keyword => receivedText.includes(keyword));
  });

  let reply = "Sorry, I didn't understand that. Can you please rephrase?";
  let imageUrls = [];

  if (match) {
    const column_c = match[2] ? match[2].trim() : null;

    console.log('Column C value:', column_c);

    if (column_c && (column_c.startsWith('http://') || column_c.startsWith('https://') || column_c.includes('drive.google.com'))) {
      imageUrls = column_c.split('|').map(url => url.trim()).filter(url => url.length > 0);
      console.log('Image URLs detected:', imageUrls);
    }

    const action = column_c && imageUrls.length === 0 ? column_c.toLowerCase() : null;

    if (action && imageUrls.length === 0) {
      const actionResult = await executeSpecialAction(action);
      reply = actionResult || match[1];
    } else if (match[1]) {
      const responses = match[1].split('|').map(r => r.trim());
      reply = responses[Math.floor(Math.random() * responses.length)];
    }
  }

  sendTyping(senderPsid, pageToken);
  setTimeout(() => {
    callSendAPI(senderPsid, reply, pageToken);

    if (imageUrls.length > 0) {
      imageUrls.forEach(url => {
        callSendAPI(senderPsid, null, pageToken, null, null, url);
      });
    }
  }, 1500);
}
              }
      }

      // ==========================================
      // Handle Facebook Post Comments
      // ==========================================
      if (entry.changes) {
        for (const change of entry.changes) {
          console.log('📝 Change detected:', change.field);

          // Handle feed comments
          if (change.field === 'feed' && change.value) {
            const value = change.value;
            
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

              // Get page config
              const pageConfig = await getPageConfig(pageId);
              const keywordsSheetId = pageConfig?.keywordsSheetId;

              if (!keywordsSheetId) {
                console.error(`❌ No keywords sheet configured for page ${pageId}`);
                continue;
              }

              // Get keywords
              const keywords = await getKeywords(keywordsSheetId);
              const receivedText = commentText.toLowerCase().trim();

              // Find matching keyword
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
                await replyToComment(commentId, reply, pageToken);
                console.log(`✅ Replied to comment ${commentId}`);
              } catch (error) {
                console.error(`❌ Failed to reply to comment ${commentId}:`, error);
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
          subscribed_fields: 'messages,messaging_postbacks,feed,messaging_handovers'
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
// SERVER START
// =======================
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
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
});