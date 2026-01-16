 require('dotenv').config();
const express = require('express');
const { google } = require('googleapis');
const app = express();

// Polyfill fetch if missing (Node <18)
if (typeof fetch !== "function") {
  global.fetch = (...args) =>
    import("node-fetch").then(({ default: fetch }) => fetch(...args));
}

const VERIFY_TOKEN = process.env.VERIFY_TOKEN || 'my_verify_token_12345';
const PAGE_ACCESS_TOKEN = process.env.PAGE_ACCESS_TOKEN;
const PORT = process.env.PORT || 3000;
const SHEET_ID = process.env.SHEET_ID || 'YOUR_SHEET_ID';
const SHEET_TAB = 'KeywordsDM';

app.use(express.json());

// --- Google Sheets setup ---
const auth = new google.auth.GoogleAuth({
  keyFile: './service-account.json',
  scopes: ['https://www.googleapis.com/auth/spreadsheets'],
});
const sheets = google.sheets({ version: 'v4', auth });

// --- Load keywords ---
let keywordReplies = [];

async function loadSheetData() {
  try {
    const res = await sheets.spreadsheets.values.get({
      spreadsheetId: SHEET_ID,
      range: `${SHEET_TAB}!A:B`,
    });

    const rows = res.data.values;
    if (!rows || rows.length === 0) {
      console.log('⚠️ No data found in sheet.');
      return;
    }

    keywordReplies = rows
      .filter(row => row[0] && row[1])
      .map(row => ({
        keywords: row[0].split(',').map(k => k.trim().toLowerCase()),
        replies: row[1].split('|').map(r => r.trim()),
      }));

    console.log(`✅ Loaded ${keywordReplies.length} keyword-reply rows`);
  } catch (err) {
    console.error('❌ Error loading sheet data:', err);
  }
}

// --- Lookup keyword reply ---
function lookupResponse(message) {
  const msg = message.toLowerCase();
  for (let row of keywordReplies) {
    for (let kw of row.keywords) {
      const regex = new RegExp(`\\b${kw}\\b`, 'i');
      if (regex.test(msg)) {
        let reply = row.replies[Math.floor(Math.random() * row.replies.length)];
        return reply.replace(/\\n/g, '\n');
      }
    }
  }
  return null;
}

// --- Send typing ---
async function sendTyping(sender_psid, action = 'typing_on') {
  await fetch(`https://graph.facebook.com/v17.0/me/messages?access_token=${PAGE_ACCESS_TOKEN}`, {
    method: 'POST',
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ recipient: { id: sender_psid }, sender_action: action }),
  });
}

// --- Send message ---
async function sendMessage(sender_psid, reply) {
  let messagePayload = typeof reply === 'string'
    ? { text: reply }
    : {
        attachment: {
          type: 'template',
          payload: { template_type: 'button', text: reply.text, buttons: reply.buttons }
        }
      };

  try {
    const res = await fetch(
      `https://graph.facebook.com/v17.0/me/messages?access_token=${PAGE_ACCESS_TOKEN}`,
      {
        method: 'POST',
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ recipient: { id: sender_psid }, message: messagePayload }),
      }
    );
    const data = await res.json();
    console.log("✅ Message sent:", JSON.stringify(data, null, 2));
  } catch (err) {
    console.error("❌ Unable to send message:", err);
  }
}

// --- Fetch user profile from Facebook ---
async function getUserProfile(sender_psid) {
  try {
    const res = await fetch(
      `https://graph.facebook.com/${sender_psid}?fields=first_name,last_name&access_token=${PAGE_ACCESS_TOKEN}`
    );
    return await res.json(); // { first_name, last_name, id }
  } catch (err) {
    console.error("❌ Failed to fetch user profile:", err);
    return {};
  }
}

// --- In-memory stores ---
const userOrderStates = {}; // order step
const userOrders = {};      // order answers

// --- Order questions ---
const orderQuestions = [
  { field: 'date', question: "📅 What date would you like your ice cream? (MM-DD-YYYY) \n\n (Type 'Cancel' to STOP anytime)"},
  { field: 'time', question: "⏰ What time would you like your order? (e.g., 2:00 PM)" },
  { field: 'name', question: "🙋 What's your name?" },
  { field: 'flavor', question: "🍦 Which flavor would you like?" },
  { field: 'email', question: "📧 What’s your email address?" },
  { field: 'phone', question: "📱 What’s your phone number?" },
  { field: 'size', question: "📏 What size would you like? (S/M/L)" },
];

// --- Validations ---
function isValidDate(input) {
  const today = new Date();
  const selected = new Date(input);
  return !isNaN(selected) && selected.setHours(0,0,0,0) >= today.setHours(0,0,0,0);
}

function isValidEmail(email) {
  const re = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  return re.test(String(email).toLowerCase());
}

function isValidPhone(phone) {
  const re = /^[+]?[\d\s-]{7,15}$/;
  return re.test(String(phone));
}

// --- Save order to Bookings tab ---
async function saveOrderToSheet(order) {
  try {
    const timestamp = new Date().toISOString();
    await sheets.spreadsheets.values.append({
      spreadsheetId: SHEET_ID,
      range: 'Bookings!A:H', // Timestamp | Date | Time | Name | Flavor | Email | Phone | Size
      valueInputOption: 'RAW',
      insertDataOption: 'INSERT_ROWS',
      requestBody: {
        values: [[timestamp, order.date, order.time, order.name, order.flavor, order.email, order.phone, order.size]],
      },
    });
    console.log('✅ Order saved with timestamp:', order);
  } catch (err) {
    console.error('❌ Failed to save order:', err);
  }
}

// --- Format summary ---
function formatOrderSummary(order) {
  return `🎉 Thank you! Here’s your order summary:\n\n` +
         `📅 Date: ${order.date}\n` +
         `⏰ Time: ${order.time}\n` +
         `🙋 Name: ${order.name}\n` +
         `🍦 Flavor: ${order.flavor}\n` +
         `📧 Email: ${order.email}\n` +
         `📱 Phone: ${order.phone}\n` +
         `📏 Size: ${order.size}\n\n` +
         `Please confirm or cancel your order.`;
}

// --- Handle order flow with confirmation ---
async function handleOrderFlow(senderId, messageText, isPostback = false) {
  if (!userOrderStates[senderId]) {
    userOrderStates[senderId] = 0;
    userOrders[senderId] = {};
  }

  let step = userOrderStates[senderId];

  // Check for cancel
  if (messageText.trim().toLowerCase() === 'cancel') {
    await sendMessage(senderId, "❌ Your order has been cancelled.");
    userOrderStates[senderId] = null;
    userOrders[senderId] = null;
    return;
  }

  // Save previous answer if not first question
  if (step > 0 && !isPostback) {
    const prevField = orderQuestions[step - 1].field;

    if (prevField === 'date' && !isValidDate(messageText)) {
      userOrderStates[senderId]--;
      await sendMessage(senderId, "❌ Invalid date. Please enter today or a future date (YYYY-MM-DD). Or type 'cancel' to exit.");
      return;
    }

    if (prevField === 'email' && !isValidEmail(messageText)) {
      userOrderStates[senderId]--;
      await sendMessage(senderId, "❌ Invalid email format. Please enter a valid email (e.g., name@example.com). Or type 'cancel' to exit.");
      return;
    }

    if (prevField === 'phone' && !isValidPhone(messageText)) {
      userOrderStates[senderId]--;
      await sendMessage(senderId, "❌ Invalid phone number. Please enter 7–15 digits (may include +, spaces, or dashes). Or type 'cancel' to exit.");
      return;
    }

    userOrders[senderId][prevField] = messageText;
  }

  // If all questions answered, show summary
  if (step >= orderQuestions.length) {
    const order = userOrders[senderId];
    const summaryText = formatOrderSummary(order);

    const buttons = [
      { type: 'postback', title: 'Confirm ✅', payload: 'confirm_order' },
      { type: 'postback', title: 'Cancel ❌', payload: 'cancel_order' },
    ];

    await sendMessage(senderId, { text: summaryText, buttons });
    return;
  }

  const currentQuestion = orderQuestions[step];
  userOrderStates[senderId]++;

  await sendMessage(senderId, currentQuestion.question);
}

// --- Webhook verification ---
app.get('/webhook', (req, res) => {
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];
  if (mode === 'subscribe' && token === VERIFY_TOKEN) {
    console.log('✅ Webhook verified!');
    res.status(200).send(challenge);
  } else res.sendStatus(403);
});

// --- Webhook POST ---
app.post('/webhook', async (req, res) => {
  const body = req.body;
  if (body.object === 'page') {
    const bookingKeywords = ['order', 'book', 'appointment'];

    for (let entry of body.entry) {
      for (let event of entry.messaging) {
        const senderId = event.sender.id;

        if (event.message && event.message.text) {
          const msgText = event.message.text.trim();
          const msgTextLower = msgText.toLowerCase();

          await sendTyping(senderId);

          if (userOrderStates[senderId] !== undefined && userOrderStates[senderId] !== null) {
            await handleOrderFlow(senderId, msgText);
          } else if (bookingKeywords.some(kw => msgTextLower.includes(kw))) {
            await handleOrderFlow(senderId, msgText);
          } else if (msgTextLower === 'reload') {
            await sendMessage(senderId, "🔄 Reloading keyword data...");
            await loadSheetData();
            await sendMessage(senderId, "✅ Reload complete!");
          } else {
            let reply = lookupResponse(msgTextLower);
            if (!reply) {
              const profile = await getUserProfile(senderId);
              const firstName = profile.first_name || "friend";
              reply = `👋 Hi ${firstName}, we will get back to you shortly. Thanks!`;
            }
            await sendMessage(senderId, reply);
          }
        }

        // Handle postbacks
        else if (event.postback && event.postback.payload) {
          const payload = event.postback.payload.trim().toLowerCase();

          if (payload === 'confirm_order' && userOrders[senderId]) {
            const profile = await getUserProfile(senderId);
            const firstName = profile.first_name || "there";

            await saveOrderToSheet(userOrders[senderId]);
            await sendMessage(senderId, `✅ Thanks, ${firstName}! Your order has been confirmed and saved.`);
            
            userOrderStates[senderId] = null;
            userOrders[senderId] = null;
          } else if (payload === 'cancel_order' && userOrders[senderId]) {
            await sendMessage(senderId, "❌ Your order has been cancelled.");
            userOrderStates[senderId] = null;
            userOrders[senderId] = null;
          } else if (userOrderStates[senderId] !== undefined && userOrderStates[senderId] !== null) {
            await handleOrderFlow(senderId, payload, true);
          } else {
            let reply = lookupResponse(payload);
            if (!reply) {
              const profile = await getUserProfile(senderId);
              const firstName = profile.first_name || "friend";
              reply = `👋 Hi ${firstName}, we will get back to you shortly. Thanks!`;
            }
            await sendMessage(senderId, reply);
          }
        }
      }
    }
    res.sendStatus(200);
  } else res.sendStatus(404);
});

// --- Start server ---
app.listen(PORT, async () => {
  console.log(`🚀 Messenger Webhook running at http://localhost:${PORT}`);
  await loadSheetData();
});
