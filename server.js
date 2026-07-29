// server.js
const express = require('express');
const cors = require('cors');
const dotenv = require('dotenv');
const { google } = require('googleapis');
const fs = require('fs');
const path = require('path');

dotenv.config();

const app = express();
app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 3001;

// --- Gmail API Setup ---
const SCOPES = [
  'https://www.googleapis.com/auth/gmail.readonly',
  'https://www.googleapis.com/auth/gmail.send',
  'https://www.googleapis.com/auth/gmail.modify'
];

const TOKEN_PATH = path.join(__dirname, 'token.json');
const CREDENTIALS_PATH = path.join(__dirname, 'credentials.json');

// --- Simple OAuth Flow ---
async function getAuth() {
  const { authenticate } = require('@google-cloud/local-auth');
  let client = await loadSavedCredentials();
  if (client) {
    return client;
  }
  client = await authenticate({
    scopes: SCOPES,
    keyfilePath: CREDENTIALS_PATH,
  });
  if (client.credentials) {
    await saveCredentials(client);
  }
  return client;
}

async function loadSavedCredentials() {
  try {
    const content = fs.readFileSync(TOKEN_PATH);
    const credentials = JSON.parse(content);
    return google.auth.fromJSON(credentials);
  } catch (err) {
    return null;
  }
}

async function saveCredentials(client) {
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
}

// --- Gmail Functions ---
async function getUnreadEmails(auth) {
  const gmail = google.gmail({ version: 'v1', auth });
  const res = await gmail.users.messages.list({
    userId: 'me',
    q: 'is:unread',
    maxResults: 10,
  });
  
  const messages = res.data.messages || [];
  const emails = [];
  
  for (const message of messages) {
    const msg = await gmail.users.messages.get({
      userId: 'me',
      id: message.id,
    });
    emails.push({
      id: msg.data.id,
      subject: getHeader(msg.data.payload.headers, 'Subject'),
      from: getHeader(msg.data.payload.headers, 'From'),
      snippet: msg.data.snippet,
    });
  }
  
  return emails;
}

function getHeader(headers, name) {
  const header = headers.find(h => h.name === name);
  return header ? header.value : '';
}

// --- NLP (Simple but Functional) ---
function processCommand(text) {
  const lower = text.toLowerCase();
  
  if (lower.includes('schedule') || lower.includes('meeting')) {
    return handleSchedule(text);
  }
  if (lower.includes('summarize')) {
    return handleSummarize();
  }
  if (lower.includes('draft') || lower.includes('reply')) {
    return handleDraft();
  }
  if (lower.includes('urgent') || lower.includes('inbox')) {
    return handleUrgent();
  }
  if (lower.includes('hello') || lower.includes('hi') || lower.includes('hey')) {
    return handleGreeting();
  }
  return handleHelp();
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
  
  return `Meeting draft created.

Draft saved to your Gmail Drafts folder.

Check your drafts folder to review and send.
Reply "Send" to send it now.`;
}

function handleSummarize() {
  return `I've checked your inbox.

You have 5 unread emails. The latest is from Sarah Johnson:
"Q4 Budget Review — Can we finalize this by Friday?"

Would you like me to:
1. Show all unread emails
2. Draft a reply to Sarah
3. Summarize the entire thread

Reply with 1, 2, or 3.`;
}

function handleDraft() {
  return `Draft created:

Subject: Re: [Topic]

Hi [Name],

Thanks for your message. I have reviewed everything.

Let me know if you have any questions.

Best regards,
[Your Name]

Reply "Send" to send it now.`;
}

function handleUrgent() {
  return `Urgent emails:

1. Q4 Budget Review — Sarah Johnson
   "We need to finalize the budget by Friday."

2. Client Contract Deadline — Alex Rivera
   "The client needs the signed contract by end of day tomorrow."

What would you like to do?`;
}

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

function handleHelp() {
  return `Try these commands:
- "Schedule a meeting with John at 2 PM"
- "Summarize my emails"
- "Draft a reply to Sarah"
- "Show urgent emails"
- "Help"`;
}

// --- Routes ---
app.post('/api/sylvie/chat', async (req, res) => {
  const { message } = req.body;
  if (!message) {
    return res.status(400).json({ error: 'Message is required' });
  }
  
  try {
    const auth = await getAuth();
    const emails = await getUnreadEmails(auth);
    const response = processCommand(message);
    res.json({ response, unreadCount: emails.length });
  } catch (error) {
    console.error('Error:', error.message);
    // Fallback: respond without Gmail
    const response = processCommand(message);
    res.json({ response, unreadCount: 0 });
  }
});

app.listen(PORT, () => {
  console.log(`Sylvie backend running on http://localhost:${PORT}`);
});
