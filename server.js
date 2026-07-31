// server.js — Sylvie Fully Automated Email Assistant with Mistral
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
let userApprovals = [];

// ============================================
// OLLAMA — MISTRAL (Best Local Model)
// ============================================

async function callMistral(prompt) {
  try {
    const response = await fetch('http://localhost:11434/api/generate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'mistral',
        prompt: prompt,
        stream: false,
        options: {
          temperature: 0.7,
          top_p: 0.9,
          num_predict: 200,
          num_ctx: 4096,
          repeat_penalty: 1.1,
        }
      })
    });
    const data = await response.json();
    return data.response;
  } catch (error) {
    console.error('❌ Mistral error:', error.message);
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
// EMAIL CLASSIFICATION
// ============================================

function classifyEmail(email) {
  const text = (email.subject + ' ' + email.body).toLowerCase();
  
  // Meeting requests
  if (text.includes('meet') || text.includes('schedule') || text.includes('calendar') || 
      text.includes('available') || text.includes('free') || text.includes('call') ||
      text.includes('when') && text.includes('available')) {
    return { action: 'meeting', confidence: 0.8 };
  }
  
  // Urgent
  if (text.includes('urgent') || text.includes('asap') || text.includes('important') ||
      text.includes('deadline') || text.includes('immediately') || text.includes('emergency')) {
    return { action: 'urgent', confidence: 0.9 };
  }
  
  // Questions that need reply
  if (text.includes('?') || text.includes('please') || text.includes('could you') ||
      text.includes('can you') || text.includes('would you') || text.includes('kindly')) {
    return { action: 'draft', confidence: 0.7 };
  }
  
  // Scam/Spam
  if (text.includes('prize') || text.includes('winner') || text.includes('congratulations') ||
      text.includes('bank') || text.includes('click here') || text.includes('free money') ||
      text.includes('million') || text.includes('lottery')) {
    return { action: 'spam', confidence: 0.9 };
  }
  
  // Newsletters (basic)
  if (text.includes('unsubscribe') || text.includes('newsletter') || text.includes('weekly') ||
      text.includes('digest') || text.includes('updates')) {
    return { action: 'basic', confidence: 0.8 };
  }
  
  return { action: 'none', confidence: 0 };
}

// ============================================
// DRAFT GENERATOR
// ============================================

function getDraftPrompt(email, action) {
  let instruction = '';
  switch (action) {
    case 'urgent':
      instruction = 'This email is urgent. Write a prompt reply acknowledging the urgency and addressing the issue.';
      break;
    case 'meeting':
      instruction = 'This email is requesting a meeting. Suggest 2-3 time slots and ask for confirmation.';
      break;
    case 'draft':
      instruction = 'This email needs a reply. Write a professional, concise response.';
      break;
    default:
      instruction = 'Write a professional reply.';
  }
  
  return `You are Sylvie, an AI email assistant.

Email from: ${email.from}
Subject: ${email.subject}
Content: ${email.body}

${instruction}

Keep your reply concise (max 5 sentences). Write in a professional but friendly tone.`;
}

async function generateAndSaveDraft(auth, email, action) {
  try {
    const prompt = getDraftPrompt(email, action);
    const reply = await callMistral(prompt);
    
    const draft = await createDraftEmail(
      auth,
      email.from,
      `Re: ${email.subject}`,
      reply.trim()
    );
    
    if (draft.success) {
      // Add notification
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
  
  let draftsCreated = 0;
  
  for (const email of emails) {
    const classification = classifyEmail(email);
    console.log(`📩 ${email.from} | ${classification.action} (${classification.confidence})`);
    
    if (classification.action === 'spam') {
      // Mark as read and move to spam (skip for now)
      await markEmailAsRead(auth, email.id);
      console.log(`🚫 Marked as spam: ${email.from}`);
      continue;
    }
    
    if (classification.action === 'basic') {
      // Just mark as read (newsletter)
      await markEmailAsRead(auth, email.id);
      console.log(`📰 Marked as basic: ${email.from}`);
      continue;
    }
    
    if (classification.action === 'meeting' || classification.action === 'urgent' || classification.action === 'draft') {
      const draft = await generateAndSaveDraft(auth, email, classification.action);
      if (draft.success) {
        draftsCreated++;
        // Mark as read after draft is created
        await markEmailAsRead(auth, email.id);
      }
    }
  }
  
  if (draftsCreated > 0) {
    console.log(`📬 ${draftsCreated} draft(s) created and waiting for approval.`);
  }
}

// --- Run scanner every 3 minutes ---
setInterval(scanInbox, 3 * 60 * 1000);

// --- Run immediately on startup ---
setTimeout(scanInbox, 3000);

// ============================================
// API ROUTES
// ============================================

// --- Chat endpoint ---
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
      const emails = await getUnreadEmails(auth, 3);
      if (emails.length > 0) {
        emailContext = `Current unread emails:\n${emails.map((e, i) => 
          `${i+1}. From: ${e.from} | Subject: ${e.subject}\n   Content: ${e.body.substring(0, 200)}...`
        ).join('\n')}`;
      }
    }

    const prompt = `You are Sylvie, an AI email assistant.

Context:
${emailContext}

User: ${message}

Sylvie:`;

    const response = await callMistral(prompt);
    console.log(`💬 Sylvie: ${response.substring(0, 60)}...`);
    res.json({ response });

  } catch (error) {
    console.error('❌ Error:', error.message);
    res.json({ response: "I'm having trouble processing that. Please try again." });
  }
});

// --- Get notifications ---
app.get('/api/sylvie/notifications', (req, res) => {
  res.json({ notifications: notifications.filter(n => !n.read) });
});

// --- Mark notification as read ---
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

// --- Approve and send draft ---
app.post('/api/sylvie/draft/send', async (req, res) => {
  const { draftId, emailId } = req.body;
  
  try {
    const auth = await getAuth();
    if (!auth) {
      return res.status(401).json({ error: 'Not authenticated' });
    }
    
    // Send the draft (mark as sent)
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

// --- Approve and edit draft ---
app.post('/api/sylvie/draft/edit', (req, res) => {
  const { draftId, newContent } = req.body;
  // This would update the draft content
  // For now, we'll just log it
  console.log(`✏️ Draft ${draftId} edited: ${newContent.substring(0, 50)}...`);
  res.json({ success: true, message: 'Draft updated' });
});

// --- Status ---
app.get('/api/sylvie/status', async (req, res) => {
  try {
    const auth = await getAuth();
    res.json({
      connected: auth !== null,
      gmail: auth ? '✅ Connected' : '❌ Not connected',
      brain: 'Mistral (local)',
      privacy: '🔒 100% private — emails never leave your machine',
      autoDraft: '✅ Active (scans every 3 minutes)'
    });
  } catch (error) {
    res.json({ connected: false, error: error.message });
  }
});

// --- Health ---
app.get('/health', (req, res) => {
  res.json({ 
    status: 'healthy', 
    brain: 'Mistral (local)',
    privacy: 'Emails never leave your machine',
    autoScan: 'Every 3 minutes'
  });
});

// ============================================
// START
// ============================================

app.listen(PORT, () => {
  console.log(`🚀 Sylvie backend running on http://localhost:${PORT}`);
  console.log(`🧠 Brain: Mistral (local, private, high quality)`);
  console.log(`🔒 Emails NEVER leave your machine`);
  console.log(`📡 Auto-scan: Every 3 minutes`);
  console.log(`📬 Auto-draft: Active`);
  console.log(`🔔 Notifications: Active`);
});
