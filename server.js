require('dotenv').config();
const express = require('express');
const cors = require('cors');
const Anthropic = require('@anthropic-ai/sdk').default;

const app = express();
app.use(cors({
  origin: '*',
  credentials: false
}));
app.use(express.json());

// Initialize Claude
const anthropic = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY,
});

// Claude endpoint
app.post('/api/chat/claude', async (req, res) => {
  try {
    const { message, systemPrompt, conversationHistory } = req.body;
    const messages = [
      ...(conversationHistory || []).map(msg => ({
        role: msg.role === 'assistant' ? 'assistant' : 'user',
        content: msg.content
      })),
      { role: 'user', content: message }
    ];

    const response = await anthropic.messages.create({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 1024,
      system: systemPrompt || '',
      messages: messages,
    });

    res.json({ success: true, response: response.content[0].text, ai: 'claude' });
  } catch (error) {
    console.error('Claude Error:', error);
    res.status(500).json({ success: false, error: error.message, ai: 'claude' });
  }
});

// Grok endpoint
app.post('/api/chat/grok', async (req, res) => {
  try {
    const { message, systemPrompt, conversationHistory } = req.body;

    const messages = [
      { role: 'system', content: systemPrompt || 'You are Grok, a witty AI assistant.' },
      ...(conversationHistory || []).map(msg => ({
        role: msg.role === 'assistant' ? 'assistant' : 'user',
        content: msg.content
      })),
      { role: 'user', content: message }
    ];

    const response = await fetch('https://api.x.ai/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${process.env.XAI_API_KEY}`,
      },
      body: JSON.stringify({
        model: 'grok-3',
        messages: messages,
      }),
    });

    const data = await response.json();
    console.log('Grok API response:', JSON.stringify(data));

    if (data.choices && data.choices[0] && data.choices[0].message) {
      res.json({ success: true, response: data.choices[0].message.content, ai: 'grok' });
    } else if (data.error) {
      res.json({ success: true, response: `Grok API error: ${data.error.message || JSON.stringify(data.error)}`, ai: 'grok' });
    } else {
      res.json({ success: true, response: 'Grok returned an unexpected response format.', ai: 'grok' });
    }
  } catch (error) {
    console.error('Grok Error:', error);
    res.json({ success: true, response: `Grok error: ${error.message}`, ai: 'grok' });
  }
});

// Gemini endpoint
app.post('/api/chat/gemini', async (req, res) => {
  try {
    const { message, systemPrompt, conversationHistory } = req.body;

    const contents = [
      ...(conversationHistory || []).map(msg => ({
        parts: [{ text: msg.content }],
        role: msg.role === 'assistant' ? 'model' : 'user'
      })),
      {
        parts: [{ text: message }],
        role: 'user'
      }
    ];

    const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${process.env.GOOGLE_API_KEY}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        contents: contents,
      }),
    });

    const data = await response.json();
    console.log('Gemini API response:', JSON.stringify(data));

    if (data.candidates && data.candidates[0] && data.candidates[0].content && data.candidates[0].content.parts) {
      res.json({ success: true, response: data.candidates[0].content.parts[0].text, ai: 'gemini' });
    } else if (data.error) {
      res.json({ success: true, response: `Gemini API error: ${data.error.message}`, ai: 'gemini' });
    } else {
      res.json({ success: true, response: 'Gemini returned an unexpected response format.', ai: 'gemini' });
    }
  } catch (error) {
    console.error('Gemini Error:', error);
    res.json({ success: true, response: `Gemini error: ${error.message}`, ai: 'gemini' });
  }
});

const PORT = process.env.PORT || 8000;
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
