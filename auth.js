// auth.js — Simple Gmail OAuth Setup
const { authenticate } = require('@google-cloud/local-auth');
const fs = require('fs');
const path = require('path');
const { google } = require('googleapis');

const SCOPES = [
  'https://www.googleapis.com/auth/gmail.readonly',
  'https://www.googleapis.com/auth/gmail.send',
  'https://www.googleapis.com/auth/gmail.modify'
];

const CREDENTIALS_PATH = path.join(__dirname, 'credentials.json');
const TOKEN_PATH = path.join(__dirname, 'token.json');

async function run() {
  try {
    console.log('🔄 Starting OAuth flow...');
    console.log('📁 Using credentials from:', CREDENTIALS_PATH);
    
    const client = await authenticate({
      scopes: SCOPES,
      keyfilePath: CREDENTIALS_PATH,
    });

    if (client.credentials) {
      // Save token
      const key = JSON.parse(fs.readFileSync(CREDENTIALS_PATH)).installed;
      const tokenData = {
        type: 'authorized_user',
        client_id: key.client_id,
        client_secret: key.client_secret,
        refresh_token: client.credentials.refresh_token,
      };
      fs.writeFileSync(TOKEN_PATH, JSON.stringify(tokenData, null, 2));
      console.log('✅ Authentication successful!');
      console.log('📁 Token saved to:', TOKEN_PATH);
      console.log('🔑 You can now run the server.');
    } else {
      console.log('❌ No credentials received.');
    }
  } catch (error) {
    console.error('❌ Error:', error.message);
    if (error.message.includes('access_denied')) {
      console.log('\n🔧 Fix: Add your email as a test user in Google Cloud Console.');
      console.log('1. Go to https://console.cloud.google.com/apis/credentials');
      console.log('2. Click "OAuth consent screen"');
      console.log('3. Scroll to "Test users"');
      console.log('4. Click "Add Users" and enter your email');
      console.log('5. Click "Save" and try again');
    }
  }
}

run();
