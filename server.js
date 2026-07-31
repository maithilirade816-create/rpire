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
// OLLAMA SETUP (Local, Private)
// ============================================

async function callOllama(prompt) {
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
    console.error('❌ Ollama error:', error.message);
    return fallbackResponse(prompt);
  }
}

// ============================================
// FALLBACK (If Ollama fails)
// ============================================

function fallbackResponse(input) {
  const lower = input.toLowerCase();
  if (lower.includes('hello') || lower.includes('hi')) {
    return "Hi there! I'm Sylvie. What would you like to do today?";
  }
  return "I'm here to help. What would you like me to do?";
}

// ============================================
// SYLVIE PERSONALITY
// ============================================

function getSylviePersonality() {
  return `You are Sylvie, an AI email assistant with a warm, intelligent, and slightly witty personality.

Your traits:
- You talk like a real person
- You give honest opinions when asked
- You're curious and ask follow-up questions
- You have a subtle sense of humor
- You're direct but kind

Your voice:
- Use casual, natural language
- Don't be overly formal
- Use contractions (I'm, you're, it's)
- Be conversational, not corporate

If the user asks who you are, say "I'm Sylvie, your AI assistant. I'm running locally on your machine, so your emails and data never leave your computer."`;
}

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
      const key = JSON.parse(fs.readFileSync(CREDENTIALS_PATH)).installed;
      fs.writeFileSync(TOKEN_PATH, JSON.stringify({
        type: 'authorized_user',
        client_id: key.client_id,
        client_secret: key.client_secret,
        refresh_token: client.credentials.refresh_token,
      }));
    }
    return client;
  } catch (err) {
    console.error('❌ OAuth failed:', err.message);
    return null;
  }
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
        subject: headers.find(h => h.name === 'Subject')?.value || '(no subject)',
        from: headers.find(h => h.name === 'From')?.value || '(unknown)',
        snippet: msg.data.snippet || '',
      });
    }
    return emails;
  } catch (err) {
    return [];
  }
}

// ============================================
// CHAT HANDLER
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
      const emails = await getUnreadEmails(auth, 10);
      if (emails.length > 0) {
        emailContext = `Current unread emails:\n${emails.map((e, i) => 
          `${i+1}. From: ${e.from} | Subject: ${e.subject}`
        ).join('\n')}`;
      }
    }

    const prompt = `${getSylviePersonality()}

Context:
${emailContext}

Previous conversation:
${conversationHistory.slice(-6).join('\n')}

User: ${message}

Sylvie:`;

    // CALL PHI-3 VIA OLLAMA
    const response = await callOllama(prompt);

    conversationHistory.push(`User: ${message}`);
    conversationHistory.push(`Sylvie: ${response}`);
    if (conversationHistory.length > 20) {
      conversationHistory.shift();
    }

    console.log(`💬 Sylvie: ${response.substring(0, 50)}...`);
    res.json({ response, unreadCount: 0 });

  } catch (error) {
    console.error('❌ Error:', error.message);
    res.json({ response: fallbackResponse(message) });
  }
});

app.get('/health', (req, res) => {
  res.json({ status: 'healthy', brain: 'Phi-3 (local, private)' });
});

app.listen(PORT, () => {
  console.log(`🚀 Sylvie backend running on http://localhost:${PORT}`);
  console.log(`🧠 Brain: Phi-3 (local, 100% private)`);
  console.log(`🔒 Emails NEVER leave your machine`);
});
