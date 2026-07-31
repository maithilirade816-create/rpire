// server.js — Sylvie with Phi-3 (Local, Private)
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
// OLLAMA (Phi-3) — THE BRAIN
// ============================================

async function callPhi3(prompt) {
  try {
    const response = await fetch('http://localhost:11434/api/generate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'phi3',
        prompt: prompt,
        stream: false,
        options: {
          temperature: 0.7,
          top_p: 0.9,
        }
      })
    });
    const data = await response.json();
    return data.response;
  } catch (error) {
    console.error('❌ Phi-3 error:', error.message);
    return "I'm having trouble connecting to my brain. Make sure Ollama is running.";
  }
}

// ============================================
// SYLVIE PERSONALITY
// ============================================

function getSylviePersonality() {
  return `You are Sylvie, an AI email assistant running locally on the user's machine.

Your traits:
- You talk like a real person — warm, helpful, slightly witty
- You give honest opinions when asked
- You're curious and ask follow-up questions
- You're direct but kind
- You remember the conversation context

Your voice:
- Use casual, natural language
- Don't be overly formal
- Use contractions (I'm, you're, it's)
- Be conversational, not corporate

Important: If the user asks who you are, say you're Sylvie, their local AI assistant powered by Phi-3, running entirely on their machine — so their emails and data never leave their computer.

If the user asks about emails, use the email context provided below.`;
}

// ============================================
// GMAIL SETUP
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
      scopes: SCOPES,
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
        snippet: msg.data.snippet || '',
      });
    }

    return emails;
  } catch (err) {
    console.error('Failed to fetch emails:', err.message);
    return [];
  }
}

// ============================================
// MAIN CHAT HANDLER
// ============================================

let conversationHistory = [];

app.post('/api/sylvie/chat', async (req, res) => {
  const { message } = req.body;
  if (!message) {
    return res.status(400).json({ error: 'Message is required' });
  }

  try {
    console.log(`📩 User: ${message}`);

    const auth = await getAuth();
    let emailContext = 'No unread emails.';
    if (auth) {
      const emails = await getUnreadEmails(auth, 5);
      if (emails.length > 0) {
        emailContext = `Current unread emails:\n${emails.map((e, i) => 
          `${i+1}. From: ${e.from} | Subject: ${e.subject}`
        ).join('\n')}`;
      }
    }

    const prompt = `${getSylviePersonality()}

Email Context:
${emailContext}

Conversation history:
${conversationHistory.slice(-10).join('\n')}

User: ${message}

Sylvie:`;

    const response = await callPhi3(prompt);

    conversationHistory.push(`User: ${message}`);
    conversationHistory.push(`Sylvie: ${response}`);
    if (conversationHistory.length > 20) {
      conversationHistory.shift();
    }

    console.log(`💬 Sylvie: ${response.substring(0, 60)}...`);
    res.json({ response });

  } catch (error) {
    console.error('❌ Error:', error.message);
    res.json({ 
      response: "I'm having trouble processing that. Please try again." 
    });
  }
});

app.post('/api/sylvie/reset', (req, res) => {
  conversationHistory = [];
  res.json({ success: true, message: 'Context reset' });
});

app.get('/api/sylvie/status', async (req, res) => {
  try {
    const auth = await getAuth();
    res.json({
      connected: auth !== null,
      gmail: auth ? '✅ Connected' : '❌ Not connected',
      brain: 'Phi-3 (local)',
      privacy: '🔒 100% private — emails never leave your machine'
    });
  } catch (error) {
    res.json({ connected: false, error: error.message });
  }
});

app.get('/health', (req, res) => {
  res.json({ 
    status: 'healthy', 
    brain: 'Phi-3 (local)',
    privacy: 'Emails never leave your machine'
  });
});

app.listen(PORT, () => {
  console.log(`🚀 Sylvie backend running on http://localhost:${PORT}`);
  console.log(`🧠 Brain: Phi-3 (local, 100% private)`);
  console.log(`🔒 Emails NEVER leave your machine`);
});
