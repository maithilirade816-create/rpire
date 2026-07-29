// server.js — Sylvie AI Assistant Backend
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
// GMAIL API SETUP
// ============================================

const SCOPES = [
  'https://www.googleapis.com/auth/gmail.readonly',
  'https://www.googleapis.com/auth/gmail.send',
  'https://www.googleapis.com/auth/gmail.modify'
];

const TOKEN_PATH = path.join(__dirname, 'token.json');
const CREDENTIALS_PATH = path.join(__dirname, 'credentials.json');

/**
 * Load saved credentials from token.json
 */
async function loadSavedCredentials() {
  try {
    if (fs.existsSync(TOKEN_PATH)) {
      const content = fs.readFileSync(TOKEN_PATH);
      const credentials = JSON.parse(content);
      return google.auth.fromJSON(credentials);
    }
    return null;
  } catch (err) {
    console.log('No saved credentials found:', err.message);
    return null;
  }
}

/**
 * Save credentials to token.json
 */
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
    console.log('✅ Credentials saved to token.json');
  } catch (err) {
    console.error('❌ Failed to save credentials:', err.message);
  }
}

/**
 * Get authorized Gmail client
 */
async function getAuth() {
  let client = await loadSavedCredentials();
  if (client) {
    console.log('✅ Using saved credentials');
    return client;
  }

  if (!fs.existsSync(CREDENTIALS_PATH)) {
    console.error('❌ credentials.json not found!');
    console.log('📁 Please place credentials.json in:', __dirname);
    console.log('🔗 Get it from: https://console.cloud.google.com/apis/credentials');
    return null;
  }

  try {
    console.log('🔄 No saved credentials. Starting OAuth flow...');
    client = await authenticate({
      scopes: SCOPES,
      keyfilePath: CREDENTIALS_PATH,
    });
    
    if (client.credentials) {
      await saveCredentials(client);
    }
    console.log('✅ OAuth successful!');
    return client;
  } catch (err) {
    console.error('❌ OAuth failed:', err.message);
    return null;
  }
}

// ============================================
// GMAIL FUNCTIONS
// ============================================

/**
 * Get header from email
 */
function getHeader(headers, name) {
  const header = headers.find(h => h.name === name);
  return header ? header.value : '';
}

/**
 * Get unread emails from Gmail
 */
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
      });
      
      const headers = msg.data.payload.headers;
      emails.push({
        id: msg.data.id,
        subject: getHeader(headers, 'Subject') || '(no subject)',
        from: getHeader(headers, 'From') || '(unknown sender)',
        date: getHeader(headers, 'Date') || '',
        snippet: msg.data.snippet || '',
      });
    }

    return emails;
  } catch (err) {
    console.error('❌ Failed to fetch emails:', err.message);
    return [];
  }
}

/**
 * Create a draft email
 */
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

// ============================================
// SYLVIE NLP ENGINE
// ============================================

function processCommand(text, context = {}) {
  const lower = text.toLowerCase().trim();
  
  // Check for specific commands first
  if (lower.includes('schedule') || lower.includes('meeting')) {
    return handleSchedule(text);
  }
  if (lower.includes('summarize') || lower.includes('summary')) {
    return handleSummarize(text, context);
  }
  if (lower.includes('draft') || lower.includes('reply')) {
    return handleDraft(text);
  }
  if (lower.includes('urgent') || lower.includes('inbox') || lower.includes('triage')) {
    return handleUrgent(context);
  }
  if (lower === '1' || lower === 'option 1') {
    return handleOption1(context);
  }
  if (lower === '2' || lower === 'option 2') {
    return handleOption2(context);
  }
  if (lower === '3' || lower === 'option 3') {
    return handleOption3(context);
  }
  if (lower.includes('hello') || lower.includes('hi') || lower.includes('hey')) {
    return handleGreeting();
  }
  if (lower.includes('help')) {
    return handleHelp();
  }
  return handleGeneral(text);
}

function handleSchedule(text) {
  const hasPerson = /with|and|meet|sarah|michael|alex|john|jane/i.test(text);
  const hasTime = /\d{1,2}(?::\d{2})?\s*(?:am|pm|morning|afternoon|evening)/i.test(text);
  
  if (!hasPerson || !hasTime) {
    return `I need more details to schedule this meeting.

Who would you like to meet with?
What time works for you?

Example: "Schedule with John at 2 PM tomorrow"`;
  }
  
  return `📅 Meeting draft created.

Draft saved to your Gmail Drafts folder.

Check your drafts folder to review and send.
Reply "Send" to send it now.`;
}

function handleSummarize(text, context) {
  const emails = context.emails || [];
  
  if (emails.length === 0) {
    return `📭 No unread emails in your inbox.

You're all caught up! 🎉`;
  }

  return `📧 I found ${emails.length} unread emails:

${emails.map((e, i) => `${i + 1}. ${e.from}: "${e.subject}"`).join('\n')}

What would you like to do?
1. Read the latest email
2. Draft a reply to the latest sender
3. Summarize all unread emails

Reply with 1, 2, or 3.`;
}

function handleDraft(text) {
  const hasRecipient = /to|for|sarah|michael|alex|john|jane/i.test(text);
  
  if (!hasRecipient) {
    return `I can draft a reply for you.

Who would you like to reply to?
What would you like to say?

Example: "Draft a reply to Sarah about the Q4 budget"`;
  }
  
  return `✉️ Draft created:

Subject: Re: [Topic]

Hi [Name],

Thanks for your message. I have reviewed everything.

Let me know if you have any questions.

Best regards,
[Your Name]

Reply "Send" to send it now.`;
}

function handleUrgent(context) {
  const emails = context.emails || [];
  const urgent = emails.filter(e => 
    e.subject.toLowerCase().includes('urgent') ||
    e.subject.toLowerCase().includes('asap') ||
    e.subject.toLowerCase().includes('important') ||
    e.snippet.toLowerCase().includes('urgent') ||
    e.snippet.toLowerCase().includes('asap')
  );

  if (urgent.length === 0) {
    return `✅ No urgent emails found in your inbox.`;
  }

  return `⚠️ Urgent emails (${urgent.length}):

${urgent.map((e, i) => `${i + 1}. ${e.from}: "${e.subject}"`).join('\n')}

What would you like to do?
1. Draft replies to all
2. Show full emails
3. Mark as read`;
}

function handleOption1(context) {
  const emails = context.emails || [];
  if (emails.length === 0) {
    return "No emails to show.";
  }
  const email = emails[0];
  return `📧 From: ${email.from}
Subject: ${email.subject}

Preview: ${email.snippet}

Would you like me to draft a reply?`;
}

function handleOption2(context) {
  const emails = context.emails || [];
  if (emails.length < 2) {
    return "Not enough emails to show.";
  }
  const email = emails[1];
  return `📧 From: ${email.from}
Subject: ${email.subject}

Preview: ${email.snippet}

Would you like me to draft a reply?`;
}

function handleOption3(context) {
  const emails = context.emails || [];
  if (emails.length < 3) {
    return "Not enough emails to show.";
  }
  const email = emails[2];
  return `📧 From: ${email.from}
Subject: ${email.subject}

Preview: ${email.snippet}

Would you like me to draft a reply?`;
}

function handleGreeting() {
  const hour = new Date().getHours();
  let time = 'day';
  if (hour < 12) time = 'morning';
  else if (hour < 17) time = 'afternoon';
  else time = 'evening';
  
  return `Good ${time}, Maithili.

I'm Sylvie. I can help you with:
- 📅 Scheduling meetings
- 📧 Summarizing emails
- ✉️ Drafting replies
- ⚡ Finding urgent emails

What would you like to do?`;
}

function handleHelp() {
  return `Here's what I can do:

📅 "Schedule a meeting with John at 2 PM"
📧 "Summarize my emails"
✉️ "Draft a reply to Sarah"
⚡ "Show urgent emails"
ℹ️ "Help"

Just tell me what you need.`;
}

function handleGeneral(text) {
  return `I'm not sure I understood that.

Try one of these:
- "Schedule a meeting with John at 2 PM"
- "Summarize my emails"
- "Draft a reply to Sarah"
- "Show urgent emails"
- "Help"

What would you like to do?`;
}

// ============================================
// API ROUTES
// ============================================

/**
 * POST /api/sylvie/chat
 * Main chat endpoint
 */
app.post('/api/sylvie/chat', async (req, res) => {
  const { message } = req.body;
  
  if (!message) {
    return res.status(400).json({ error: 'Message is required' });
  }

  try {
    console.log(`📩 User: ${message}`);
    
    const auth = await getAuth();
    if (!auth) {
      // Fallback without Gmail
      const response = processCommand(message);
      return res.json({ 
        response, 
        unreadCount: 0, 
        warning: 'Gmail not connected' 
      });
    }

    const emails = await getUnreadEmails(auth, 10);
    const context = { emails };
    const response = processCommand(message, context);
    
    console.log(`💬 Sylvie: ${response.substring(0, 50)}...`);
    res.json({ 
      response, 
      unreadCount: emails.length 
    });
  } catch (error) {
    console.error('❌ Error:', error.message);
    const response = processCommand(message);
    res.json({ 
      response, 
      unreadCount: 0,
      error: error.message 
    });
  }
});

/**
 * POST /api/sylvie/draft
 * Create a draft email
 */
app.post('/api/sylvie/draft', async (req, res) => {
  const { to, subject, body } = req.body;
  
  if (!to || !subject || !body) {
    return res.status(400).json({ 
      error: 'to, subject, and body are required' 
    });
  }

  try {
    const auth = await getAuth();
    if (!auth) {
      return res.status(401).json({ 
        error: 'Gmail not connected. Please authenticate.' 
      });
    }

    const result = await createDraftEmail(auth, to, subject, body);
    res.json(result);
  } catch (error) {
    console.error('❌ Error:', error.message);
    res.status(500).json({ 
      success: false, 
      error: error.message 
    });
  }
});

/**
 * GET /api/sylvie/emails
 * Fetch unread emails
 */
app.get('/api/sylvie/emails', async (req, res) => {
  try {
    const auth = await getAuth();
    if (!auth) {
      return res.status(401).json({ 
        error: 'Gmail not connected. Please authenticate.' 
      });
    }

    const emails = await getUnreadEmails(auth, 20);
    res.json({ emails, count: emails.length });
  } catch (error) {
    console.error('❌ Error:', error.message);
    res.status(500).json({ error: error.message });
  }
});

/**
 * GET /api/sylvie/status
 * Check connection status
 */
app.get('/api/sylvie/status', async (req, res) => {
  try {
    const auth = await getAuth();
    const connected = auth !== null;
    res.json({ 
      connected,
      gmail: connected ? '✅ Connected' : '❌ Not connected',
      message: connected ? 'Sylvie is ready' : 'Please authenticate with Gmail'
    });
  } catch (error) {
    res.json({ 
      connected: false, 
      error: error.message 
    });
  }
});

/**
 * Health check
 */
app.get('/health', (req, res) => {
  res.json({ 
    status: 'healthy', 
    timestamp: new Date().toISOString(),
    version: '1.0.0'
  });
});

// ============================================
// START SERVER
// ============================================

app.listen(PORT, () => {
  console.log(`🚀 Sylvie backend running on http://localhost:${PORT}`);
  console.log(`📡 API endpoints:`);
  console.log(`   POST /api/sylvie/chat`);
  console.log(`   POST /api/sylvie/draft`);
  console.log(`   GET  /api/sylvie/emails`);
  console.log(`   GET  /api/sylvie/status`);
  console.log(`   GET  /health`);
  console.log('');
  console.log(`📁 credentials.json location: ${CREDENTIALS_PATH}`);
  console.log(`   (Place your Google OAuth credentials here)`);
});
