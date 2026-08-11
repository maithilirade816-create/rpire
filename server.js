// server.js — Sylvie with Phi-3 (Memory + Context + Meeting Notifications)
const express = require('express');
const cors = require('cors');
const dotenv = require('dotenv');
const fs = require('fs');
const path = require('path');
const { google } = require('googleapis');
const { authenticate } = require('@google-cloud/local-auth');

dotenv.config();

const app = express();
app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 3001;

// ============================================
// NOTIFICATIONS STORE
// ============================================
let notifications = [];

// ============================================
// CONVERSATION MEMORY
// ============================================
let conversationHistory = [];

// ============================================
// OLLAMA — PHI-3
// ============================================

async function callLlama(prompt) {
  try {
    const response = await fetch('http://localhost:11434/api/generate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'sylvie-mistral',
        prompt: prompt,
        stream: false,
        options: {
          temperature: 0.1,
          num_predict: 250,
          num_ctx: 1024,
          num_batch: 1024,
          repeat_penalty: 1.1,
        }
      })
    });
    const data = await response.json();
    return data.response;
  } catch (error) {
    console.error('❌ Llama error:', error.message);
    return "I'm having trouble connecting to my brain. Make sure Ollama is running with 'ollama serve'.";
  }
}

// ============================================
// GMAIL SETUP
// ============================================

const SCOPES = [
  'https://www.googleapis.com/auth/gmail.readonly',
  'https://www.googleapis.com/auth/gmail.send',
  'https://www.googleapis.com/auth/gmail.modify'
];

const CALENDAR_SCOPES = [
  'https://www.googleapis.com/auth/calendar.readonly',
  'https://www.googleapis.com/auth/calendar.events'
];

const TOKEN_PATH = path.join(__dirname, 'token.json');
const CREDENTIALS_PATH = path.join(__dirname, 'credentials.json');

async function loadSavedCredentials() {
  try {
    if (fs.existsSync(TOKEN_PATH)) {
      const content = fs.readFileSync(TOKEN_PATH);
      const credentials = JSON.parse(content);
      return google.auth.fromJSON(credentials);
    }
    return null;
  } catch (err) {
    return null;
  }
}

async function saveCredentials(client) {
  try {
    const content = fs.readFileSync(CREDENTIALS_PATH);
    const keys = JSON.parse(content);
    const key = keys.installed || keys.web;
    const payload = JSON.stringify({
      type: 'authorized_user',
      client_id: key.client_id,
      client_secret: key.client_secret,
      refresh_token: client.credentials.refresh_token,
    });
    fs.writeFileSync(TOKEN_PATH, payload);
  } catch (err) {
    console.error('Failed to save credentials:', err.message);
  }
}

async function getAuth() {
  let client = await loadSavedCredentials();
  if (client) return client;

  if (!fs.existsSync(CREDENTIALS_PATH)) {
    console.error('❌ credentials.json not found!');
    return null;
  }

  try {
    client = await authenticate({
      scopes: [...SCOPES, ...CALENDAR_SCOPES],
      keyfilePath: CREDENTIALS_PATH,
    });
    if (client.credentials) {
      await saveCredentials(client);
    }
    return client;
  } catch (err) {
    console.error('❌ OAuth failed:', err.message);
    return null;
  }
}

function getHeader(headers, name) {
  const header = headers.find(h => h.name === name);
  return header ? header.value : '';
}

function getEmailBody(payload) {
  let body = '';
  if (payload.parts) {
    for (const part of payload.parts) {
      if (part.mimeType === 'text/plain' && part.body && part.body.data) {
        body = Buffer.from(part.body.data, 'base64').toString('utf-8');
        break;
      }
    }
  } else if (payload.body && payload.body.data) {
    body = Buffer.from(payload.body.data, 'base64').toString('utf-8');
  }
  return body || '';
}

async function getUnreadEmails(auth, maxResults = 10) {
  try {
    const gmail = google.gmail({ version: 'v1', auth });
    const res = await gmail.users.messages.list({
      userId: 'me',
      q: 'is:unread',
      maxResults: maxResults,
    });

    const messages = res.data.messages || [];
    const emails = [];

    for (const message of messages) {
      const msg = await gmail.users.messages.get({
        userId: 'me',
        id: message.id,
        format: 'full',
      });
      
      const headers = msg.data.payload.headers;
      const body = getEmailBody(msg.data.payload);
      
      emails.push({
        id: msg.data.id,
        subject: getHeader(headers, 'Subject') || '(no subject)',
        from: getHeader(headers, 'From') || '(unknown sender)',
        to: getHeader(headers, 'To') || '',
        date: getHeader(headers, 'Date') || '',
        body: body,
        snippet: msg.data.snippet || '',
        isUnread: true,
      });
    }

    return emails;
  } catch (err) {
    console.error('❌ Failed to fetch emails:', err.message);
    return [];
  }
}

async function createDraftEmail(auth, to, subject, body) {
  try {
    const gmail = google.gmail({ version: 'v1', auth });
    
    const email = [
      `To: ${to}`,
      `Subject: ${subject}`,
      'Content-Type: text/plain; charset="UTF-8"',
      '',
      body,
    ].join('\n');

    const encodedEmail = Buffer.from(email)
      .toString('base64')
      .replace(/\+/g, '-')
      .replace(/\//g, '_')
      .replace(/=+$/, '');

    const res = await gmail.users.drafts.create({
      userId: 'me',
      requestBody: {
        message: {
          raw: encodedEmail,
        },
      },
    });

    console.log('✅ Draft saved to Gmail');
    return { success: true, draftId: res.data.id };
  } catch (err) {
    console.error('❌ Failed to create draft:', err.message);
    return { success: false, error: err.message };
  }
}

async function markEmailAsRead(auth, emailId) {
  try {
    const gmail = google.gmail({ version: 'v1', auth });
    await gmail.users.messages.modify({
      userId: 'me',
      id: emailId,
      requestBody: {
        removeLabelIds: ['UNREAD'],
      },
    });
    console.log('✅ Email marked as read');
    return true;
  } catch (err) {
    console.error('❌ Failed to mark as read:', err.message);
    return false;
  }
}

// ============================================
// CALENDAR INTEGRATION
// ============================================

async function getFreeSlots(auth, days = 3) {
  try {
    const calendar = google.calendar({ version: 'v3', auth });
    const now = new Date();
    const startTime = new Date(now.getTime() + 30 * 60 * 1000);
    const endTime = new Date(now.getTime() + days * 24 * 60 * 60 * 1000);

    const res = await calendar.freebusy.query({
      requestBody: {
        timeMin: startTime.toISOString(),
        timeMax: endTime.toISOString(),
        items: [{ id: 'primary' }],
      },
    });

    const busySlots = res.data.calendars?.primary?.busy || [];
    return busySlots;
  } catch (err) {
    console.error('❌ Calendar error:', err.message);
    return [];
  }
}

function findFreeSlots(busySlots, startDate, endDate) {
  const slots = [];
  let current = new Date(startDate);
  const end = new Date(endDate);
  
  while (current < end) {
    const slotEnd = new Date(current.getTime() + 30 * 60 * 1000);
    const isFree = !busySlots.some(busy => {
      const busyStart = new Date(busy.start);
      const busyEnd = new Date(busy.end);
      return current < busyEnd && slotEnd > busyStart;
    });
    if (isFree) {
      slots.push({
        start: new Date(current),
        end: new Date(slotEnd),
      });
    }
    current = new Date(current.getTime() + 30 * 60 * 1000);
  }
  return slots;
}

// ============================================
// SMART CLASSIFICATION
// ============================================

function classifyEmail(email) {
  const subject = email.subject.toLowerCase();
  const body = email.body.toLowerCase();
  const text = subject + ' ' + body;
  const from = email.from.toLowerCase();

  const systemDomains = ['netlify.com', 'render.com', 'aws.com', 'amazon.com', 
    'stripe.com', 'paddle.com', 'google.com', 'microsoft.com',
    'github.com', 'vercel.com', 'heroku.com', 'digitalocean.com'];
  for (const domain of systemDomains) {
    if (from.includes(domain)) {
      return { action: 'system', confidence: 1.0 };
    }
  }

  if (text.includes('credits') || text.includes('billing') || text.includes('invoice') ||
      text.includes('payment') || text.includes('subscription') || text.includes('upgrade') ||
      text.includes('plan') || text.includes('pricing')) {
    return { action: 'system', confidence: 1.0 };
  }

  const spamKeywords = ['unsubscribe', 'prize', 'winner', 'congratulations', 'bank', 'million', 'lottery',
    'free money', 'viagra', 'crypto', 'bitcoin', 'nigerian prince', 'investment opportunity',
    'earn money', 'make money fast', 'no cost', 'risk free', 'guaranteed'
  ];
  for (const word of spamKeywords) {
    if (text.includes(word)) {
      return { action: 'spam', confidence: 0.9 };
    }
  }

  const ignoreKeywords = ['reminder', 'verify your account', 'confirm your email',
    'no-reply', 'donotreply', 'do-not-reply', 'notifications@',
    'please verify', 'account verification', 'email confirmation'
  ];
  for (const word of ignoreKeywords) {
    if (text.includes(word)) {
      return { action: 'ignore', confidence: 0.9 };
    }
  }

  const promoKeywords = ['newsletter', 'digest', 'update', 'weekly', 'monthly',
    'promotion', 'sale', 'discount', 'offer', 'deal',
    'product hunt daily', 'betalist', 'indie hackers', 'pinterest'
  ];
  for (const word of promoKeywords) {
    if (text.includes(word)) {
      return { action: 'ignore', confidence: 0.9 };
    }
  }

  const ignoreSenders = ['noreply', 'no-reply', 'donotreply', 'do-not-reply',
    'newsletter', 'digest', 'daily', 'weekly', 'updates'
  ];
  for (const word of ignoreSenders) {
    if (from.includes(word)) {
      return { action: 'ignore', confidence: 0.9 };
    }
  }

  const meetingKeywords = ['meet', 'schedule', 'calendar', 'available', 'free', 'call',
    'when are you free', 'let\'s meet', 'can we meet', 'set up a meeting', 'book a call',
    'are you free', 'what time works for you'
  ];
  let isMeeting = false;
  for (const word of meetingKeywords) {
    if (text.includes(word)) {
      isMeeting = true;
      break;
    }
  }
  
  if (isMeeting && !text.includes('upgrade') && !text.includes('credits')) {
    return { action: 'meeting', confidence: 0.8 };
  }

  const urgentKeywords = ['urgent', 'asap', 'important', 'deadline', 'immediately',
    'emergency', 'critical', 'time sensitive', 'action required'
  ];
  for (const word of urgentKeywords) {
    if (text.includes(word)) {
      return { action: 'urgent', confidence: 0.9 };
    }
  }

  if (text.includes('?') || 
      text.includes('please') && text.includes('let me know') ||
      text.includes('could you') || text.includes('can you') ||
      text.includes('would you') || text.includes('kindly') ||
      text.includes('request') || text.includes('asking')) {
    return { action: 'draft', confidence: 0.7 };
  }

  return { action: 'ignore', confidence: 0.5 };
}

// ============================================
// DRAFT GENERATOR
// ============================================

function getDraftPrompt(email, action, userName, freeSlots) {
  const name = userName || 'Maithili';
  let instruction = '';
  switch (action) {
    case 'urgent':
      instruction = 'This email is urgent. Write a prompt reply acknowledging the urgency.';
      break;
    case 'meeting':
      instruction = `This email is requesting a meeting. 
      DO NOT suggest specific times. 
      Reply politely saying you'll check your schedule and get back to them.`;
      break;
    case 'draft':
      instruction = 'This email needs a reply. Write a professional, concise response.';
      break;
    default:
      instruction = 'Write a professional reply.';
  }
  
  return `You are Sylvie, an AI email assistant helping ${name}.

Email from: ${email.from}
Subject: ${email.subject}
Content: ${email.body}

${instruction}

Important rules:
- Sign the email as "${name}"
- Keep it concise (max 4 sentences)
- Be professional but friendly
- If it's a meeting request, say "I'll check my availability and get back to you shortly" - do NOT suggest times.`;
}

async function generateAndSaveDraft(auth, email, action, userName) {
  try {
    let reply = '';
    let draft = null;

    // --- MEETING REQUEST: NOTIFY USER, DON'T BOOK ---
    if (action === 'meeting') {
      // 1. Create a notification for the user
      notifications.push({
        id: Date.now(),
        type: 'meeting_request',
        emailId: email.id,
        from: email.from,
        subject: email.subject,
        body: email.body,
        read: false,
        status: 'awaiting_user_input',
        timestamp: new Date().toISOString()
      });

      // 2. Draft a polite reply (no time suggestions)
      reply = `Thanks for your email. I'll check my availability and get back to you shortly with some options.`;
      
      draft = await createDraftEmail(
        auth,
        email.from,
        `Re: ${email.subject}`,
        reply.trim()
      );

      console.log(`📩 Meeting request from ${email.from} — user notified.`);
      return draft;
    }

    // --- OTHER ACTIONS (urgent, draft) ---
    const prompt = getDraftPrompt(email, action, userName, null);
    reply = await callLlama(prompt);
    
    draft = await createDraftEmail(
      auth,
      email.from,
      `Re: ${email.subject}`,
      reply.trim()
    );
    
    if (draft.success) {
      notifications.push({
        id: Date.now(),
        type: 'draft_ready',
        emailId: email.id,
        from: email.from,
        subject: email.subject,
        draftId: draft.draftId,
        reply: reply.trim(),
        read: false,
        timestamp: new Date().toISOString()
      });
      
      console.log(`✉️ Draft ready for ${email.from}`);
    }
    
    return draft;
  } catch (error) {
    console.error('❌ Draft generation failed:', error.message);
    return { success: false, error: error.message };
  }
}

// ============================================
// BACKGROUND SCANNER
// ============================================

async function scanInbox() {
  console.log('🔍 Scanning inbox...');
  
  const auth = await getAuth();
  if (!auth) {
    console.log('❌ Not authenticated. Skipping scan.');
    return;
  }
  
  const emails = await getUnreadEmails(auth, 10);
  console.log(`📧 Found ${emails.length} unread emails.`);
  
  const userName = 'Maithili';
  
  for (const email of emails) {
    const classification = classifyEmail(email);
    console.log(`📩 ${email.from} | ${classification.action} (${classification.confidence})`);
    
    if (classification.action === 'ignore' || classification.action === 'system') {
      await markEmailAsRead(auth, email.id);
      console.log(`⏭️ Ignored: ${email.from}`);
      continue;
    }
    
    if (classification.action === 'spam') {
      await markEmailAsRead(auth, email.id);
      console.log(`🚫 Marked as spam: ${email.from}`);
      continue;
    }
    
    if (classification.action === 'meeting' || 
        classification.action === 'urgent' || 
        classification.action === 'draft') {
      await generateAndSaveDraft(auth, email, classification.action, userName);
      await markEmailAsRead(auth, email.id);
    }
  }
}

setInterval(scanInbox, 3 * 60 * 1000);
setTimeout(scanInbox, 3000);

// ============================================
// API ROUTES
// ============================================

app.post('/api/sylvie/chat', async (req, res) => {
  const { message } = req.body;
  if (!message) {
    return res.status(400).json({ error: 'Message is required' });
  }

  try {
    console.log(`📩 User: ${message}`);

    const lower = message.toLowerCase();

    // --- HARD RULE: DRAFT / EMAIL REQUEST (UPDATED) ---
    if (lower.includes('draft') || lower.includes('write an email') || lower.includes('send an email')) {
      // Extract recipient
      let recipient = 'them';
      const recipientMatch = message.match(/(?:to|for)\s*([^\s,]+)/i);
      if (recipientMatch) {
        recipient = recipientMatch[1];
      }

      // Generate draft using Llama
      const draftPrompt = `Draft a professional email to ${recipient}. 
Content: ${message}
Keep it concise and clear. Sign with "Maithili".`;

      let draftBody = await callLlama(draftPrompt);

      // Clean up the draft
      draftBody = draftBody.replace(/^["']|["']$/g, '').trim();

      // Save as draft in Gmail
      const auth = await getAuth();
      const draft = await createDraftEmail(auth, recipient, 'Re: Your request', draftBody);

      if (draft.success) {
        return res.json({
          type: 'draft',
          to: recipient,
          subject: 'Re: Your request',
          body: draftBody,
          draftId: draft.draftId
        });
      } else {
        return res.json({
          type: 'error',
          response: '❌ Failed to save draft. Please try again.'
        });
      }
    }

    // --- HARD RULE: SHOW INBOX ---
    if (lower.includes('inbox') || lower.includes('emails')) {
      const auth = await getAuth();
      if (!auth) {
        return res.json({ response: 'Please connect Gmail first.' });
      }
      const emails = await getUnreadEmails(auth, 5);
      
      let response;
      if (emails.length === 0) {
        response = '📭 Your inbox is empty. Nice!';
      } else {
        response = '📧 Your latest emails:\n\n';
        emails.forEach((e, i) => {
          response += `${i+1}. From: ${e.from}\n`;
          response += `   Subject: ${e.subject}\n`;
          response += `   Preview: ${e.snippet.substring(0, 60)}...\n\n`;
        });
      }
      
      conversationHistory.push({ role: 'user', content: message });
      conversationHistory.push({ role: 'assistant', content: response });
      conversationHistory.push({ role: 'system', content: `Last shown emails: ${emails.length} emails from inbox` });
      
      return res.json({ response });
    }

    // --- HARD RULE: SHOW URGENT ---
    if (lower.includes('urgent')) {
      const auth = await getAuth();
      if (!auth) {
        return res.json({ response: 'Please connect Gmail first.' });
      }
      const emails = await getUnreadEmails(auth, 10);
      const urgent = emails.filter(e => {
        const text = (e.subject + ' ' + e.body).toLowerCase();
        return text.includes('urgent') || text.includes('asap') || text.includes('deadline') ||
               text.includes('important') || text.includes('immediately');
      });
      
      let response;
      if (urgent.length === 0) {
        response = '📭 No urgent emails in your inbox.';
      } else {
        response = '⚠️ Urgent emails:\n\n';
        urgent.forEach((e, i) => {
          response += `${i+1}. From: ${e.from}\n`;
          response += `   Subject: ${e.subject}\n`;
          response += `   Preview: ${e.snippet.substring(0, 80)}...\n\n`;
        });
      }
      
      conversationHistory.push({ role: 'user', content: message });
      conversationHistory.push({ role: 'assistant', content: response });
      
      return res.json({ response });
    }

    // --- HARD RULE: HELP ---
    if (lower.includes('help')) {
      const response = `I can help you with:

1. "Draft an email to [name] about [topic]"
2. "Show my inbox"
3. "Show urgent emails"
4. "Schedule a meeting with [name]"

Try one of these.`;
      
      conversationHistory.push({ role: 'user', content: message });
      conversationHistory.push({ role: 'assistant', content: response });
      
      return res.json({ response });
    }

    // --- DEFAULT: Use Llama with memory ---
    const auth = await getAuth();
    let emailContext = 'No unread emails.';
    if (auth) {
      const emails = await getUnreadEmails(auth, 3);
      if (emails.length > 0) {
        emailContext = `Current unread emails:\n${emails.map((e, i) => 
          `${i+1}. From: ${e.from} | Subject: ${e.subject}`
        ).join('\n')}`;
      }
    }

    const historyStr = conversationHistory.slice(-6).map(msg => 
      `${msg.role}: ${msg.content}`
    ).join('\n');

    const prompt = `You are Sylvie, an AI email assistant. 
      ALWAYS respond in English.
      NEVER switch languages.
      NEVER mention Vercel, AWS, or other companies unless the user specifically asks.
      If you don't know something, say "I don't know" instead of making it up.
      Keep responses short and helpful.
      REMEMBER the conversation history provided below.

Conversation history:
${historyStr}

Current context:
${emailContext}

User: ${message}

Sylvie:`;

    let response = await callLlama(prompt);
    
    // Filter out French
    if (response.includes('Bonjour') || response.includes('Merci') || response.includes('je') || response.includes('vous')) {
      response = "I'll respond in English. What would you like me to do?";
    }
    
    // Filter out Vercel
    if (response.includes('vercel') || response.includes('Vercel')) {
      response = "I'm here to help with your emails. What would you like me to do?";
    }
    
    conversationHistory.push({ role: 'user', content: message });
    conversationHistory.push({ role: 'assistant', content: response });
    
    if (conversationHistory.length > 30) {
      conversationHistory = conversationHistory.slice(-20);
    }
    
    res.json({ response });

  } catch (error) {
    console.error('❌ Error:', error.message);
    res.json({ response: "I'm having trouble processing that. Please try again." });
  }
});

app.post('/api/sylvie/reset', (req, res) => {
  conversationHistory = [];
  res.json({ success: true, message: 'Conversation reset' });
});

// ============================================
// NOTIFICATION & DRAFT ROUTES
// ============================================

app.get('/api/sylvie/notifications', (req, res) => {
  const pending = notifications.filter(n => !n.read && n.status !== 'confirmed');
  res.json({ notifications: pending });
});

app.post('/api/sylvie/notification/read', (req, res) => {
  const { id } = req.body;
  const notif = notifications.find(n => n.id === id);
  if (notif) {
    notif.read = true;
    res.json({ success: true });
  } else {
    res.status(404).json({ error: 'Notification not found' });
  }
});

app.post('/api/sylvie/draft/send', async (req, res) => {
  const { draftId } = req.body;
  
  try {
    const auth = await getAuth();
    if (!auth) {
      return res.status(401).json({ error: 'Not authenticated' });
    }
    
    const gmail = google.gmail({ version: 'v1', auth });
    await gmail.users.drafts.send({
      userId: 'me',
      requestBody: {
        id: draftId,
      },
    });
    
    console.log('✅ Draft sent successfully');
    res.json({ success: true, message: 'Email sent' });
  } catch (error) {
    console.error('❌ Failed to send draft:', error.message);
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/sylvie/meeting/confirm', async (req, res) => {
  const { notificationId, timeSlot } = req.body;

  if (!notificationId || !timeSlot) {
    return res.status(400).json({ error: 'Missing notificationId or timeSlot' });
  }

  const notif = notifications.find(n => n.id === notificationId && n.type === 'meeting_request');
  if (!notif) {
    return res.status(404).json({ error: 'Meeting request not found' });
  }

  try {
    const auth = await getAuth();
    if (!auth) {
      return res.status(401).json({ error: 'Not authenticated' });
    }

    const calendar = google.calendar({ version: 'v3', auth });
    
    const event = {
      summary: `Meeting with ${notif.from}`,
      description: `Meeting requested via email: ${notif.body}`,
      start: {
        dateTime: timeSlot,
        timeZone: 'Asia/Kolkata',
      },
      end: {
        dateTime: new Date(new Date(timeSlot).getTime() + 60*60*1000).toISOString(),
        timeZone: 'Asia/Kolkata',
      },
      attendees: [{ email: notif.from }],
    };

    const response = await calendar.events.insert({
      calendarId: 'primary',
      requestBody: event,
      sendUpdates: 'all',
    });

    notif.status = 'confirmed';
    notif.meetingLink = response.data.htmlLink;

    console.log(`✅ Meeting confirmed with ${notif.from}`);
    res.json({ 
      success: true, 
      meetingLink: response.data.htmlLink,
      message: 'Meeting booked successfully!'
    });

  } catch (error) {
    console.error('❌ Calendar booking error:', error.message);
    res.status(500).json({ error: error.message });
  }
});

app.get('/api/sylvie/inbox', async (req, res) => {
  try {
    const auth = await getAuth();
    if (!auth) {
      return res.json({ 
        total: 0, 
        urgent: 0, 
        drafts: 0, 
        meetings: 0,
        emails: [],
        credits: 50
      });
    }
    
    const emails = await getUnreadEmails(auth, 10);
    const classified = emails.map(e => {
      const classification = classifyEmail(e);
      return { ...e, classification: classification.action };
    });
    
    const urgent = classified.filter(e => e.classification === 'urgent');
    const drafts = notifications.filter(n => n.type === 'draft_ready' && !n.read);
    const meetings = classified.filter(e => e.classification === 'meeting');
    
    res.json({
      total: emails.length,
      urgent: urgent.length,
      drafts: drafts.length,
      meetings: meetings.length,
      emails: classified.slice(0, 5),
      credits: 50
    });
  } catch (error) {
    console.error('❌ Inbox error:', error.message);
    res.json({ total: 0, urgent: 0, drafts: 0, meetings: 0, emails: [], credits: 50 });
  }
});

app.get('/api/sylvie/status', async (req, res) => {
  try {
    const auth = await getAuth();
    res.json({
      connected: auth !== null,
      gmail: auth ? '✅ Connected' : '❌ Not connected',
      brain: 'Phi-3 (local, private)',
      privacy: '🔒 100% private — emails never leave your machine',
      autoDraft: '✅ Active (scans every 3 minutes)',
      calendar: '✅ Connected (reads availability)'
    });
  } catch (error) {
    res.json({ connected: false, error: error.message });
  }
});

app.get('/health', (req, res) => {
  res.json({ 
    status: 'healthy', 
    brain: 'Phi-3 (local, private)',
    privacy: 'Emails never leave your machine',
    autoScan: 'Every 3 minutes'
  });
});

// ============================================
// START
// ============================================

app.listen(PORT, () => {
  console.log(`🚀 Sylvie backend running on http://localhost:${PORT}`);
  console.log(`🧠 Brain: Phi-3 (local, private)`);
  console.log(`🔒 Emails NEVER leave your machine`);
  console.log(`📡 Auto-scan: Every 3 minutes`);
  console.log(`📬 Auto-draft: Active (smart classification)`);
  console.log(`🔔 Notifications: Active`);
  console.log(`📅 Calendar: Connected (reads availability)`);
  console.log(`💬 Memory: Active (remembers conversation)`);
});
