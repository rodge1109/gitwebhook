   // server.js
require('dotenv').config();
const express = require('express');
const bodyParser = require('body-parser');
const { google } = require('googleapis');
const request = require('request');

const app = express();
app.use(bodyParser.json());

// =======================
// GOOGLE SHEETS API SETUP
// =======================
const auth = new google.auth.GoogleAuth({
  keyFile: 'credentials.json',
  scopes: ['https://www.googleapis.com/auth/spreadsheets.readonly', 'https://www.googleapis.com/auth/spreadsheets'],
});
const sheets = google.sheets({ version: 'v4', auth });

// =======================
// SMS INTEGRATION (Semaphore)
// =======================

async function sendSMS(phoneNumber, message) {
  try {
    const https = require('https');
    const querystring = require('querystring');
    
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
        
        res.on('data', (chunk) => {
          data += chunk;
        });
        
        res.on('end', () => {
          try {
            const response = JSON.parse(data);
            if (response.message_id || response[0]?.message_id) {
              console.log('✅ SMS sent successfully:', phoneNumber);
              resolve({ success: true, data: response });
            } else {
              console.error('❌ SMS failed:', response);
              resolve({ success: false, data: response });
            }
          } catch (err) {
            console.error('❌ SMS parse error:', err);
            resolve({ success: false, error: err });
          }
        });
      });
      
      req.on('error', (err) => {
        console.error('❌ SMS request error:', err);
        resolve({ success: false, error: err });
      });
      
      req.write(postData);
      req.end();
    });
  } catch (err) {
    console.error('❌ Error sending SMS:', err);
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
  // Regex to check for common date patterns (e.g., 12/25/2025, Dec 25, 2025)
  const dateRegex = /^\s*(\d{1,2}[\/\-]\d{1,2}[\/\-]\d{2,4}|\w+\s+\d{1,2},\s*\d{4})\s*$/i;

  if (!dateRegex.test(dateString)) {
    return { valid: false };
  }

  // Attempt to parse the date to ensure it's a real date
  const parsedDate = new Date(dateString);
  if (isNaN(parsedDate.getTime()) || parsedDate.getFullYear() < 2000) {
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

    } else if (questionType === 'date') { // MODIFIED DATE VALIDATION
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
  } else if (type === 'date') { // MODIFIED DATE PROMPT (Text input only)
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

  // Note: Booking session typically stays in memory until an external process
  // (like saveOrder) retrieves the data, or a timeout clears it.

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
 * NOTE: This requires the 'sheets' object to be defined and configured.
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
    
    // NOTE: This assumes 'sheets' is an initialized Google Sheets API client
    
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

async function executeSpecialAction(action) {
  switch(action) {
    case 'time':
      return getCurrentTime();
    default:
      return null;
  }
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

function callSendAPI(senderPsid, response, pageToken, quickReplies = null, template = null) {
  let messageData = {
    recipient: { id: senderPsid }
  };
  
  if (template) {
    messageData.message = { attachment: template };
  } else if (quickReplies) {
    messageData.message = { text: response, quick_replies: quickReplies };
  } else {
    messageData.message = { text: response };
  }
  
  request(
    {
      uri: `https://graph.facebook.com/${process.env.GRAPH_API_VERSION}/me/messages`,
      qs: { access_token: pageToken },
      method: 'POST',
      json: messageData,
    },
    (err, res, body) => {
      if (!err) console.log('Message sent!');
      else console.error('Unable to send message:', err, body);
    }
  );
}
 
// =======================
// WEBHOOK HANDLERS
// =======================

app.get('/webhook', (req, res) => {
  const VERIFY_TOKEN = process.env.VERIFY_TOKEN;
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];

  if (mode && token) {
    if (mode === 'subscribe' && token === VERIFY_TOKEN) {
      console.log('WEBHOOK_VERIFIED');
      res.status(200).send(challenge);
    } else {
      res.sendStatus(403);
    }
  }
});

app.post('/webhook', async (req, res) => {
  const body = req.body;
  console.log('Incoming webhook:', JSON.stringify(body, null, 2));

  if (body.object === 'page') {
    for (const entry of body.entry) {
      const pageId = entry.id;
      const config = await getPageConfig(pageId);

      if (!config) {
        console.error(`No config found for page ${pageId}`);
        continue;
      }

      const { pageToken, keywordsSheetId } = config;
      const bookingSheetId = config.bookingSheetId || keywordsSheetId;

      for (const messaging of entry.messaging) {
        if (messaging.postback) {
          const senderPsid = messaging.sender.id;
          const payload = messaging.postback.payload;
          
          console.log(`Postback received: ${payload}`);
          
          if (payload === 'BOOKING_YES') {
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
            delete bookingSessions[senderPsid];
            sendTyping(senderPsid, pageToken);
            setTimeout(() => {
              callSendAPI(senderPsid, "Booking cancelled. No problem! Feel free to book anytime.", pageToken);
            }, 1000);
          } else if (payload.startsWith('BOOKING_ANSWER_')) {
            const answer = payload.replace('BOOKING_ANSWER_', '').replace(/_/g, ' ');

            // Check if it's "Other date" button
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
        
        if (messaging.message && messaging.message.text) {
          const senderPsid = messaging.sender.id;
          const receivedText = messaging.message.text.toLowerCase().trim();
          
          if (receivedText === 'refresh data') {
            await getKeywords(keywordsSheetId, true);
            sendTyping(senderPsid, pageToken);
            setTimeout(() => callSendAPI(senderPsid, 'Keywords refreshed!', pageToken), 1500);
            console.log('Keywords refreshed');
            continue;
          }
          
          if (bookingSessions[senderPsid]) {
            console.log(`Processing booking step: ${bookingSessions[senderPsid].step}`);

            // Check if waiting for custom date
            if (bookingSessions[senderPsid].waitingForCustomDate) {
              const customDate = messaging.message.text;
              const currentStep = bookingSessions[senderPsid].step;
              const stepConfig = bookingSessions[senderPsid].config[currentStep - 1];
              
              // Save the custom date - FIXED: use stepConfig[0] not stepConfig[1]
              if (stepConfig) {
                bookingSessions[senderPsid].data[stepConfig[0]] = customDate;
              }
              
              // Clear the flag
              delete bookingSessions[senderPsid].waitingForCustomDate;
              
              // Move to next question
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

          const match = keywords.find(row => {
            if (!row[0]) return false;
            const keywordList = row[0].toLowerCase().split(',').map(k => k.trim());
            return keywordList.some(keyword => receivedText.includes(keyword));
          });

          let reply = "Sorry, I didn't understand that. Try another keyword!";
          
          if (match) {
            const action = match[2] ? match[2].trim().toLowerCase() : null;
            
            if (action) {
              const actionResult = await executeSpecialAction(action);
              reply = actionResult || match[1];
            } else if (match[1]) {
              const responses = match[1].split('|').map(r => r.trim());
              reply = responses[Math.floor(Math.random() * responses.length)];
            }
          }

          sendTyping(senderPsid, pageToken);
          setTimeout(() => callSendAPI(senderPsid, reply, pageToken), 1500);
        }
      }
    }

    res.sendStatus(200);
  } else {
    res.sendStatus(404);
  }
});

// =======================
// SERVER
// =======================
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Webhook server running on port ${PORT}`));