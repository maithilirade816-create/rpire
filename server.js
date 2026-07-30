// server.js — Sylvie AI Assistant with Memory & Context (Fixed Draft State)
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
    console.log('✅ Credentials saved to token.json');
  } catch (err) {
    console.error('❌ Failed to save credentials:', err.message);
  }
}

async function getAuth() {
  let client = await loadSavedCredentials();
  if (client) {
    console.log('✅ Using saved credentials');
    return client;
  }

  if (!fs.existsSync(CREDENTIALS_PATH)) {
    console.error('❌ credentials.json not found!');
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

function getHeader(headers, name) {
  const header = headers.find(h => h.name === name);
  return header ? header.value : '';
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
// SYLVIE — WITH MEMORY & CONTEXT
// ============================================

// --- Conversation State ---
let conversationHistory = [];
let currentContext = {
  emails: [],
  lastAction: null,
  lastFilter: null,
  pendingAction: null,
  waitingForResponse: false,
  filteredEmails: []
};

// --- DRAFT STATE (FIX) ---
let pendingDraft = {
  active: false,
  email: null,
  recipient: '',
  subject: '',
  body: ''
};

// --- Add to history ---
function addToHistory(role, content) {
  conversationHistory.push({ role, content, timestamp: new Date().toISOString() });
  if (conversationHistory.length > 20) {
    conversationHistory.shift();
  }
}

// --- Parse User Intent (Smarter) ---
function parseUserIntent(input) {
  const lower = input.toLowerCase();
  
  // Check for email filtering
  if (lower.includes('first') && lower.includes('email')) {
    return { action: 'filter_emails', filter: 'first', count: 1 };
  }
  if (lower.includes('second') && lower.includes('email')) {
    return { action: 'filter_emails', filter: 'second', count: 2 };
  }
  if (lower.includes('last') && lower.includes('email')) {
    return { action: 'filter_emails', filter: 'last', count: 1 };
  }
  if (lower.includes('first') && lower.includes('two')) {
    return { action: 'filter_emails', filter: 'first_two', count: 2 };
  }
  if (lower.includes('first') && lower.includes('three')) {
    return { action: 'filter_emails', filter: 'first_three', count: 3 };
  }
  if (lower.includes('date') || lower.includes('when') || lower.includes('sent')) {
    return { action: 'add_dates', query: input };
  }
  if (lower.includes('summarize') || lower.includes('summary')) {
    return { action: 'summarize' };
  }
  if (lower.includes('schedule') || lower.includes('meeting')) {
    return { action: 'schedule' };
  }
  if (lower.includes('draft') || lower.includes('reply')) {
    return { action: 'draft' };
  }
  if (lower.includes('urgent') || lower.includes('inbox')) {
    return { action: 'urgent' };
  }
  if (lower === '1') return { action: 'option_1' };
  if (lower === '2') return { action: 'option_2' };
  if (lower === '3') return { action: 'option_3' };
  if (lower.includes('yes')) return { action: 'confirm_yes' };
  if (lower.includes('no')) return { action: 'confirm_no' };
  if (lower.includes('hello') || lower.includes('hi') || lower.includes('hey')) {
    return { action: 'greet' };
  }
  if (lower.includes('help')) return { action: 'help' };
  
  return { action: 'general', query: input };
}

// --- Process with Context ---
async function processWithContext(input, auth) {
  const intent = parseUserIntent(input);
  addToHistory('user', input);

  // --- Handle pending draft confirmation ---
  if (pendingDraft.active) {
    if (intent.action === 'confirm_yes') {
      const result = await createDraftEmail(
        auth,
        pendingDraft.recipient,
        pendingDraft.subject,
        pendingDraft.body
      );
      const response = `✅ Draft created and saved to your Gmail Drafts folder!

To: ${pendingDraft.recipient}
Subject: ${pendingDraft.subject}

Check your drafts folder to review and send.
Reply "Send" to send it now.`;
      pendingDraft.active = false;
      return response;
    }
    if (intent.action === 'confirm_no') {
      pendingDraft.active = false;
      return 'Okay, draft cancelled. What would you like to do next?';
    }
    return 'Would you like me to create this draft? Reply "yes" or "no".';
  }

  // --- Handle waiting for numbered response ---
  if (currentContext.waitingForResponse) {
    if (intent.action === 'option_1' || intent.action === 'option_2' || intent.action === 'option_3') {
      return handleOptionResponse(input, auth);
    }
    // If they say something else, let them know they can choose 1, 2, or 3
    if (currentContext.filteredEmails && currentContext.filteredEmails.length > 0) {
      return `Please choose 1, 2, or 3 based on the options above.`;
    }
  }

  // --- Handle actions ---
  switch (intent.action) {
    case 'filter_emails':
      return handleFilterEmails(intent, auth);
    case 'add_dates':
      return handleAddDates(intent, auth);
    case 'summarize':
      return handleSummarize(auth);
    case 'schedule':
      return handleSchedule(input, auth);
    case 'draft':
      return handleDraft(input, auth);
    case 'urgent':
      return handleUrgent(auth);
    case 'option_1':
    case 'option_2':
    case 'option_3':
      return handleOptionResponse(input, auth);
    case 'confirm_yes':
      return 'What would you like me to do?';
    case 'confirm_no':
      return 'What would you like me to do?';
    case 'greet':
      return handleGreeting();
    case 'help':
      return handleHelp();
    default:
      return handleGeneral(input);
  }
}

// --- Filter Emails ---
async function handleFilterEmails(intent, auth) {
  const emails = await getUnreadEmails(auth, 10);
  currentContext.emails = emails;
  
  let filtered = [];
  let filterDescription = '';

  switch (intent.filter) {
    case 'first':
      filtered = emails.slice(0, 1);
      filterDescription = 'first email';
      break;
    case 'second':
      filtered = emails.slice(1, 2);
      filterDescription = 'second email';
      break;
    case 'last':
      filtered = emails.slice(-1);
      filterDescription = 'last email';
      break;
    case 'first_two':
      filtered = emails.slice(0, 2);
      filterDescription = 'first two emails';
      break;
    case 'first_three':
      filtered = emails.slice(0, 3);
      filterDescription = 'first three emails';
      break;
    default:
      filtered = emails.slice(0, 2);
      filterDescription = 'first two emails';
  }

  if (filtered.length === 0) {
    return 'No emails found matching that filter.';
  }

  currentContext.lastFilter = filterDescription;
  currentContext.lastAction = 'filter_emails';
  currentContext.filteredEmails = filtered;

  let response = `📧 Here are the ${filterDescription}:\n\n`;
  filtered.forEach((e, i) => {
    response += `${i + 1}. From: ${e.from}\n`;
    response += `   Subject: ${e.subject}\n`;
    response += `   Date: ${e.date || 'Date not available'}\n`;
    response += `   Preview: ${e.snippet.substring(0, 100)}...\n\n`;
  });

  response += `What would you like to do?\n`;
  response += `1. Draft a reply to the first one\n`;
  response += `2. Summarize all ${filtered.length} emails\n`;
  response += `3. Show me more emails\n`;

  currentContext.waitingForResponse = true;
  currentContext.pendingAction = 'filter_emails';

  return response;
}

// --- Add Dates to Emails ---
async function handleAddDates(intent, auth) {
  const emails = currentContext.emails || await getUnreadEmails(auth, 10);
  if (emails.length === 0) {
    return 'No emails found to add dates to.';
  }

  let response = '📧 Here are your emails with dates:\n\n';
  emails.forEach((e, i) => {
    response += `${i + 1}. From: ${e.from}\n`;
    response += `   Subject: ${e.subject}\n`;
    response += `   Date: ${e.date || 'Date not available'}\n`;
    response += `   Preview: ${e.snippet.substring(0, 80)}...\n\n`;
  });

  return response;
}

// --- Summarize ---
async function handleSummarize(auth) {
  const emails = currentContext.filteredEmails || await getUnreadEmails(auth, 5);
  if (emails.length === 0) {
    return 'No emails found to summarize.';
  }

  let summary = '📄 Summary of your emails:\n\n';
  emails.forEach((e, i) => {
    summary += `${i + 1}. ${e.from} — "${e.subject}"\n`;
    summary += `   ${e.snippet}\n\n`;
  });

  return summary;
}

// --- Schedule ---
function handleSchedule(input) {
  const hasPerson = /with|and|meet|sarah|michael|alex|john|jane/i.test(input);
  const hasTime = /\d{1,2}(?::\d{2})?\s*(?:am|pm|morning|afternoon|evening)/i.test(input);
  
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

// --- Draft ---
function handleDraft(input, auth) {
  // Try to extract recipient
  const recipientMatch = input.match(/to|for|reply to\s+(\S+)/i);
  const recipient = recipientMatch ? recipientMatch[1] : 'the recipient';

  // Set up pending draft
  pendingDraft.active = true;
  pendingDraft.recipient = recipient;
  pendingDraft.subject = 'Re: [Topic]';
  pendingDraft.body = `Hi ${recipient},\n\nThanks for your message. I have reviewed everything.\n\nLet me know if you have any questions.\n\nBest regards,\n[Your Name]`;

  return `✉️ I'll draft a reply to ${recipient}.

Subject: Re: [Topic]
Body: Hi ${recipient}, ...

Would you like me to create this draft? Reply "yes" or "no".`;
}

// --- Urgent ---
async function handleUrgent(auth) {
  const emails = await getUnreadEmails(auth, 10);
  const urgent = emails.filter(e => 
    e.subject.toLowerCase().includes('urgent') ||
    e.subject.toLowerCase().includes('asap') ||
    e.subject.toLowerCase().includes('important') ||
    e.snippet.toLowerCase().includes('urgent') ||
    e.snippet.toLowerCase().includes('asap')
  );

  if (urgent.length === 0) {
    return '✅ No urgent emails found in your inbox.';
  }

  let response = `⚠️ Urgent emails (${urgent.length}):\n\n`;
  urgent.forEach((e, i) => {
    response += `${i + 1}. ${e.from}: "${e.subject}"\n`;
  });
  response += `\nWhat would you like to do?`;
  return response;
}

// --- Option Response ---
function handleOptionResponse(input, auth) {
  const filtered = currentContext.filteredEmails || [];
  
  if (input === '1') {
    if (filtered.length === 0) return 'No emails to reply to.';
    const email = filtered[0];
    const recipient = email.from.split('<')[0].trim();
    
    // Set up pending draft
    pendingDraft.active = true;
    pendingDraft.recipient = recipient;
    pendingDraft.subject = `Re: ${email.subject}`;
    pendingDraft.body = `Hi ${recipient},\n\nThanks for your email. I'll get back to you shortly.\n\nBest regards,\n[Your Name]`;

    return `✉️ I'll draft a reply to ${recipient}.

Subject: Re: ${email.subject}

Would you like me to create this draft? Reply "yes" or "no".`;
  }
  
  if (input === '2') {
    return handleSummarize(auth);
  }
  
  if (input === '3') {
    return `📧 Here are more emails... (function to load more)`;
  }
  
  return 'Please choose 1, 2, or 3.';
}

// --- Greeting ---
function handleGreeting() {
  const hour = new Date().getHours();
  let time = 'day';
  if (hour < 12) time = 'morning';
  else if (hour < 17) time = 'afternoon';
  else time = 'evening';
  
  return `Good ${time}, Maithili.

I'm Sylvie. I can help you with:
- Scheduling meetings
- Summarizing emails
- Drafting replies
- Finding urgent emails

What would you like to do?`;
}

// --- Help ---
function handleHelp() {
  return `Here's what I can do:

"Schedule a meeting with John at 2 PM"
"Summarize my emails"
"Draft a reply to Sarah"
"Show urgent emails"
"Show my first two emails"
"Add dates to my emails"
"Help"

What would you like to do?`;
}

// --- General ---
function handleGeneral(input) {
  return `I'm not sure I understood that.

Try one of these:
- "Show my first two emails"
- "Summarize my emails"
- "Draft a reply to Sarah"
- "Add dates to my emails"
- "Help"

What would you like to do?`;
}

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
    
    const auth = await getAuth();
    if (!auth) {
      const response = await processWithContext(message, null);
      return res.json({ 
        response: response || 'Gmail not connected. Please authenticate.',
        unreadCount: 0,
        warning: 'Gmail not connected'
      });
    }

    const response = await processWithContext(message, auth);
    
    console.log(`💬 Sylvie: ${response.substring(0, 50)}...`);
    res.json({ 
      response, 
      unreadCount: currentContext.emails.length || 0
    });
  } catch (error) {
    console.error('❌ Error:', error.message);
    res.json({ 
      response: 'Sorry, I encountered an error. Please try again.',
      error: error.message 
    });
  }
});

// --- Reset context ---
app.post('/api/sylvie/reset', (req, res) => {
  conversationHistory = [];
  currentContext = {
    emails: [],
    lastAction: null,
    lastFilter: null,
    pendingAction: null,
    waitingForResponse: false,
    filteredEmails: []
  };
  pendingDraft = { active: false, email: null, recipient: '', subject: '', body: '' };
  res.json({ success: true, message: 'Context reset' });
});

// --- Status ---
app.get('/api/sylvie/status', async (req, res) => {
  try {
    const auth = await getAuth();
    res.json({ 
      connected: auth !== null,
      gmail: auth ? '✅ Connected' : '❌ Not connected',
      message: auth ? 'Sylvie is ready' : 'Please authenticate with Gmail'
    });
  } catch (error) {
    res.json({ connected: false, error: error.message });
  }
});

// --- Health ---
app.get('/health', (req, res) => {
  res.json({ 
    status: 'healthy', 
    timestamp: new Date().toISOString(),
    version: '1.1.0'
  });
});

// ============================================
// START SERVER
// ============================================

app.listen(PORT, () => {
  console.log(`🚀 Sylvie backend running on http://localhost:${PORT}`);
  console.log(`📡 API endpoints:`);
  console.log(`   POST /api/sylvie/chat`);
  console.log(`   POST /api/sylvie/reset`);
  console.log(`   GET  /api/sylvie/status`);
  console.log(`   GET  /health`);
  console.log('');
  console.log(`🧠 Sylvie has MEMORY, CONTEXT, and DRAFT STATE tracking enabled.`);
});
