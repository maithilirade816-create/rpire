// --- Add to the top with other state variables ---
let pendingDraft = {
  active: false,
  email: null,
  recipient: '',
  subject: ''
};

// --- Update processWithContext ---
async function processWithContext(input, auth) {
  const intent = parseUserIntent(input);
  addToHistory('user', input);

  // Check if we're in the middle of a draft confirmation
  if (pendingDraft.active) {
    if (input.toLowerCase().includes('yes') || input === 'y') {
      // Create and send the draft
      const result = await createDraftEmail(
        auth,
        pendingDraft.recipient,
        pendingDraft.subject,
        pendingDraft.body
      );
      pendingDraft.active = false;
      return `✅ Draft created and saved to your Gmail Drafts folder!

To: ${pendingDraft.recipient}
Subject: ${pendingDraft.subject}

Check your drafts folder to review and send.
Reply "Send" to send it now.`;
    }
    if (input.toLowerCase().includes('no') || input === 'n') {
      pendingDraft.active = false;
      return 'Okay, draft cancelled. What would you like to do next?';
    }
    // If they say something else, keep the draft pending
    return 'Would you like me to create this draft? Reply "yes" or "no".';
  }

  // Check if we're waiting for a numbered response
  if (currentContext.waitingForResponse) {
    if (input === '1' || input === '2' || input === '3') {
      return handleOptionResponse(input, auth);
    }
  }

  // Handle different actions
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
    case 'greet':
      return handleGreeting();
    case 'help':
      return handleHelp();
    default:
      return handleGeneral(input);
  }
}
