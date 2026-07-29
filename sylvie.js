// sylvie.js — The core AI engine for Rpire

class Sylvie {
  constructor(config = {}) {
    this.model = config.model || 'ollama';
    this.apiUrl = config.apiUrl || 'http://localhost:11434/api/generate';
    this.apiKey = config.apiKey || '';
    this.userVoice = this.loadUserVoice();
    this.context = {
      history: [],
      preferences: {}
    };
  }

  // --- Core Request Handler ---
  async process(request) {
    const { action, input, context } = request;

    // Build the prompt based on the action
    const prompt = this.buildPrompt(action, input, context);

    // Get response from AI model
    const response = await this.callModel(prompt);

    // Format the response
    return this.formatResponse(action, response);
  }

  // --- Build Prompt Based on Action ---
  buildPrompt(action, input, context) {
    const basePrompt = `You are Sylvie, an AI assistant for Rpire. 
      You help professionals manage their emails, meetings, and inbox.
      Your tone is professional, clear, and helpful.
      Write in the user's voice when drafting.`;

    switch (action) {
      case 'draft':
        return this.buildDraftPrompt(basePrompt, input, context);
      case 'summarize':
        return this.buildSummarizePrompt(basePrompt, input, context);
      case 'triage':
        return this.buildTriagePrompt(basePrompt, input, context);
      case 'learn':
        return this.buildLearnPrompt(basePrompt, input, context);
      default:
        return `${basePrompt}\n\nUser request: ${input}`;
    }
  }

  // --- Drafting Prompt ---
  buildDraftPrompt(basePrompt, input, context) {
    const voice = this.userVoice || 'professional and concise';
    const thread = context?.thread || 'No previous conversation.';
    
    return `${basePrompt}
      
      Your task: Write a professional email draft based on the following.
      
      User's writing style: ${voice}
      Email thread context: ${thread}
      
      User's instruction: ${input}
      
      Write a draft that sounds like the user wrote it. 
      Keep it concise, professional, and action-oriented.
      
      Draft:`;
  }

  // --- Summarizing Prompt ---
  buildSummarizePrompt(basePrompt, input, context) {
    const type = context?.type || 'email thread';
    
    return `${basePrompt}
      
      Your task: Summarize the following ${type}.
      
      Content to summarize: ${input}
      
      Provide a clear, concise summary with:
      1. Key points (bullet points)
      2. Action items (if any)
      3. Next steps
      
      Summary:`;
  }

  // --- Triage Prompt ---
  buildTriagePrompt(basePrompt, input, context) {
    return `${basePrompt}
      
      Your task: Classify the following email as URGENT, BASIC, or SCAM.
      
      Email content: ${input}
      
      Rules:
      - URGENT: Time-sensitive, requires action today
      - BASIC: Informational, can wait
      - SCAM: Suspicious, spam, or phishing
      
      Respond with only one word: URGENT, BASIC, or SCAM.`;
  }

  // --- Voice Learning Prompt ---
  buildLearnPrompt(basePrompt, input, context) {
    return `${basePrompt}
      
      Your task: Analyze the following writing sample to learn the user's voice.
      
      Sample: ${input}
      
      Extract:
      1. Tone (formal, casual, professional, friendly)
      2. Sentence structure (short, long, varied)
      3. Common phrases
      4. Preferred greeting and sign-off
      
      Learning summary:`;
  }

  // --- Call AI Model ---
  async callModel(prompt) {
    try {
      if (this.model === 'ollama') {
        return await this.callOllama(prompt);
      } else if (this.model === 'openai') {
        return await this.callOpenAI(prompt);
      } else {
        // Fallback: mock response for testing
        return this.mockResponse(prompt);
      }
    } catch (error) {
      console.error('Sylvie error:', error);
      return this.mockResponse(prompt);
    }
  }

  // --- Ollama (Local, Free) ---
  async callOllama(prompt) {
    const response = await fetch(this.apiUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'llama3',
        prompt: prompt,
        stream: false
      })
    });
    const data = await response.json();
    return data.response;
  }

  // --- OpenAI (Cloud, Paid) ---
  async callOpenAI(prompt) {
    const response = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${this.apiKey}`
      },
      body: JSON.stringify({
        model: 'gpt-3.5-turbo',
        messages: [{ role: 'user', content: prompt }],
        temperature: 0.7
      })
    });
    const data = await response.json();
    return data.choices[0].message.content;
  }

  // --- Mock Response (for testing without API) ---
  mockResponse(prompt) {
    if (prompt.includes('draft')) {
      return `Subject: Follow-up on our conversation

Hi,

Thanks for your time earlier. I've attached the documents we discussed.

Please let me know if you have any questions or if you'd like to schedule a follow-up.

Best regards,
[Your Name]`;
    }
    if (prompt.includes('summarize')) {
      return `Summary:
• Key point 1: The project is on track
• Key point 2: Budget approved
• Key point 3: Next milestone due Friday

Action items:
- Send updated timeline
- Schedule client review

Next steps:
- Team sync tomorrow at 10 AM`;
    }
    if (prompt.includes('URGENT')) {
      return 'URGENT';
    }
    if (prompt.includes('BASIC')) {
      return 'BASIC';
    }
    if (prompt.includes('SCAM')) {
      return 'SCAM';
    }
    return 'I understand your request. How can I help you today?';
  }

  // --- Voice Learning ---
  loadUserVoice() {
    const saved = localStorage.getItem('sylvie_voice');
    return saved ? JSON.parse(saved) : null;
  }

  saveUserVoice(voice) {
    localStorage.setItem('sylvie_voice', JSON.stringify(voice));
    this.userVoice = voice;
  }

  learnFromSample(sample) {
    const summary = this.process({
      action: 'learn',
      input: sample,
      context: { type: 'writing sample' }
    });
    this.saveUserVoice(summary);
    return summary;
  }
}

// --- Export for use in dashboard ---
export default Sylvie;
