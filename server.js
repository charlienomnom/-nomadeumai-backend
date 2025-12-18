require('dotenv').config();
const express = require('express');
const cors = require('cors');
const Anthropic = require('@anthropic-ai/sdk').default;
const multer = require('multer');
const path = require('path');
const fs = require('fs').promises;
const fsSync = require('fs');
const pdfParse = require('pdf-parse');
const mammoth = require('mammoth');

const app = express();

// CORS configuration - allows both production and local development
app.use(cors({
  origin: ['http://localhost:3000', 'http://localhost:3001', 'https://nomadeumai-frontend.vercel.app'],
  credentials: true
}));

app.use(express.json());

// Configure multer for file uploads - FIXED: use synchronous fs for multer callbacks
const uploadDir = path.join(__dirname, 'uploads');
if (!fsSync.existsSync(uploadDir)) {
  fsSync.mkdirSync(uploadDir, { recursive: true });
}

const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, uploadDir);
  },
  filename: (req, file, cb) => {
    const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
    cb(null, uniqueSuffix + '-' + file.originalname);
  }
});

const upload = multer({
  storage: storage,
  limits: { fileSize: 10 * 1024 * 1024 }, // 10MB limit
  fileFilter: (req, file, cb) => {
    const allowedTypes = /jpeg|jpg|png|gif|pdf|doc|docx|txt/;
    const extname = allowedTypes.test(path.extname(file.originalname).toLowerCase());
    const mimetype = allowedTypes.test(file.mimetype);
    
    if (mimetype && extname) {
      return cb(null, true);
    } else {
      cb(new Error('Invalid file type. Only images, PDFs, and documents are allowed.'));
    }
  }
});

// Initialize Claude
const anthropic = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY,
});

// Helper function to filter error messages from conversation history
function filterConversationHistory(history) {
  if (!history) return [];
  try {
    const parsed = JSON.parse(history);
    return parsed.filter(msg => {
      // Filter out error messages from other AIs
      if (msg.role === 'assistant' && msg.content && typeof msg.content === 'string') {
        const lowerContent = msg.content.toLowerCase();
        if (lowerContent.includes('api error:') || 
            lowerContent.includes('api key not valid') ||
            lowerContent.includes('error:')) {
          return false;
        }
      }
      return true;
    });
  } catch (error) {
    console.error('Error parsing conversation history:', error);
    return [];
  }
}

// Helper function to process uploaded files
async function processFile(file) {
  const filePath = file.path;
  const fileExt = path.extname(file.originalname).toLowerCase();
  
  try {
    // Handle images
    if (['.jpg', '.jpeg', '.png', '.gif'].includes(fileExt)) {
      const imageBuffer = await fs.readFile(filePath);
      const base64Image = imageBuffer.toString('base64');
      const mediaType = file.mimetype;
      
      return {
        type: 'image',
        data: base64Image,
        mediaType: mediaType,
        filename: file.originalname
      };
    }
    
    // Handle PDFs
    if (fileExt === '.pdf') {
      const dataBuffer = await fs.readFile(filePath);
      const pdfData = await pdfParse(dataBuffer);
      return {
        type: 'text',
        data: pdfData.text,
        filename: file.originalname
      };
    }
    
    // Handle Word documents
    if (['.doc', '.docx'].includes(fileExt)) {
      const result = await mammoth.extractRawText({ path: filePath });
      return {
        type: 'text',
        data: result.value,
        filename: file.originalname
      };
    }
    
    // Handle text files
    if (fileExt === '.txt') {
      const textData = await fs.readFile(filePath, 'utf-8');
      return {
        type: 'text',
        data: textData,
        filename: file.originalname
      };
    }
    
    return null;
  } finally {
    // Clean up uploaded file
    try {
      await fs.unlink(filePath);
    } catch (error) {
      console.error('Error deleting file:', error);
    }
  }
}

// Claude endpoint with file support
app.post('/api/chat/claude', upload.array('files', 5), async (req, res) => {
  try {
    const { message, systemPrompt, conversationHistory } = req.body;
    const files = req.files || [];
    
    // Process uploaded files
    const processedFiles = await Promise.all(files.map(processFile));
    
    // Build messages array with filtered conversation history
    const messages = [
      ...filterConversationHistory(conversationHistory).map(msg => ({
        role: msg.role === 'assistant' ? 'assistant' : 'user',
        content: msg.content
      }))
    ];
    
    // Build content for current message
    let content = [];
    
    // Add file content first
    for (const file of processedFiles) {
      if (file) {
        if (file.type === 'image') {
          content.push({
            type: 'image',
            source: {
              type: 'base64',
              media_type: file.mediaType,
              data: file.data
            }
          });
        } else if (file.type === 'text') {
          content.push({
            type: 'text',
            text: `[Content from file: ${file.filename}]\n\n${file.data}\n\n[End of file content]`
          });
        }
      }
    }
    
    // Add user message
    content.push({
      type: 'text',
      text: message
    });
    
    messages.push({ role: 'user', content });
    
    const response = await anthropic.messages.create({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 4096, // INCREASED from 1024 to prevent truncation
      system: systemPrompt || '',
      messages: messages,
    });

    res.json({ success: true, response: response.content[0].text, ai: 'claude' });
  } catch (error) {
    console.error('Claude error:', error);
    res.status(500).json({ success: false, error: error.message, ai: 'claude' });
  }
});

// Grok endpoint with file support
app.post('/api/chat/grok', upload.array('files', 5), async (req, res) => {
  try {
    const { message, systemPrompt, conversationHistory } = req.body;
    const files = req.files || [];
    
    // Process uploaded files
    const processedFiles = await Promise.all(files.map(processFile));
    
    // FIX: Check if user uploaded images (Grok can't handle them)
    const hasImages = processedFiles.some(file => file && file.type === 'image');
    if (hasImages) {
      return res.json({ 
        success: true, 
        response: "I cannot analyze images as I don't have vision capabilities. I can only process text-based content like PDFs, Word documents, and text files. Please provide text content instead, or try Claude which has vision capabilities.", 
        ai: 'grok' 
      });
    }
    
    const messages = [
      { role: 'system', content: systemPrompt || 'You are Grok, a witty AI assistant.' },
      ...filterConversationHistory(conversationHistory).map(msg => ({
        role: msg.role === 'assistant' ? 'assistant' : 'user',
        content: msg.content
      }))
    ];
    
    // Build message with file content (text only)
    let userMessage = '';
    for (const file of processedFiles) {
      if (file && file.type === 'text') {
        userMessage += `[Content from file: ${file.filename}]\n\n${file.data}\n\n[End of file content]\n\n`;
      }
    }
    userMessage += message;
    
    messages.push({ role: 'user', content: userMessage });

    // Add timeout handling
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 60000); // 60 second timeout

    try {
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
        signal: controller.signal
      });

      clearTimeout(timeout);

      const data = await response.json();
      console.log('Grok API response:', JSON.stringify(data));

      if (data.choices && data.choices[0] && data.choices[0].message) {
        res.json({ success: true, response: data.choices[0].message.content, ai: 'grok' });
      } else if (data.error) {
        res.json({ success: true, response: `Grok API error: ${data.error.message}`, ai: 'grok' });
      } else {
        res.json({ success: true, response: 'Grok returned an unexpected response format.', ai: 'grok' });
      }
    } catch (fetchError) {
      clearTimeout(timeout);
      if (fetchError.name === 'AbortError') {
        res.json({ success: true, response: 'Grok request timed out. Please try again with a shorter message or smaller file.', ai: 'grok' });
      } else {
        throw fetchError;
      }
    }
  } catch (error) {
    console.error('Grok error:', error);
    res.json({ success: true, response: `Grok error: ${error.message}`, ai: 'grok' });
  }
});

// Gemini endpoint with file support
app.post('/api/chat/gemini', upload.array('files', 5), async (req, res) => {
  try {
    const { message, systemPrompt, conversationHistory } = req.body;
    const files = req.files || [];
    
    // Process uploaded files
    const processedFiles = await Promise.all(files.map(processFile));
    
    const contents = [
      ...filterConversationHistory(conversationHistory).map(msg => ({
        parts: [{ text: msg.content }],
        role: msg.role === 'assistant' ? 'model' : 'user'
      }))
    ];
    
    // Build parts for current message
    let parts = [];
    for (const file of processedFiles) {
      if (file && file.type === 'text') {
        parts.push({ text: `[Content from file: ${file.filename}]\n\n${file.data}\n\n[End of file content]` });
      }
    }
    parts.push({ text: message });
    
    contents.push({
      parts: parts,
      role: 'user'
    });

    // Add timeout handling
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 60000); // 60 second timeout

    try {
      // FIXED: Changed from gemini-2.5-flash to gemini-1.5-flash (correct model name)
      const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=${process.env.GEMINI_API_KEY}`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          contents: contents,
        }),
        signal: controller.signal
      });

      clearTimeout(timeout);

      const data = await response.json();
      console.log('Gemini API response:', JSON.stringify(data));

      if (data.candidates && data.candidates[0] && data.candidates[0].content && data.candidates[0].content.parts) {
        res.json({ success: true, response: data.candidates[0].content.parts[0].text, ai: 'gemini' });
      } else if (data.error) {
        res.json({ success: true, response: `Gemini API error: ${data.error.message}`, ai: 'gemini' });
      } else {
        res.json({ success: true, response: 'Gemini returned an unexpected response format.', ai: 'gemini' });
      }
    } catch (fetchError) {
      clearTimeout(timeout);
      if (fetchError.name === 'AbortError') {
        res.json({ success: true, response: 'Gemini request timed out. Please try again with a shorter message or smaller file.', ai: 'gemini' });
      } else {
        throw fetchError;
      }
    }
  } catch (error) {
    console.error('Gemini error:', error);
    res.json({ success: true, response: `Gemini error: ${error.message}`, ai: 'gemini' });
  }
});

const PORT = process.env.PORT || 8000;
app.listen(PORT, '0.0.0.0', () => {
  console.log(`Server running on port ${PORT}`);
});
