// server.js - Updated with NOMAD MODE support
const express = require('express');
const cors = require('cors');
const Anthropic = require('@anthropic-ai/sdk').default;
const multer = require('multer');
const path = require('path');
const fs = require('fs').promises;
const fsSync = require('fs');
const pdfParse = require('pdf-parse');
const mammoth = require('mammoth');

// Import Pinecone integration
const { storeDocument, getRelevantContext } = require('./pinecone-integration');

const app = express();

// CORS configuration - allows both production and local development
app.use(cors({
  origin: ['http://localhost:3000', 'http://localhost:3001', 'https://nomadeumai-frontend.vercel.app'],
  credentials: true
}));

app.use(express.json());

// Configure multer for file uploads
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
    const allowedExtensions = /jpeg|jpg|png|gif|pdf|doc|docx|txt/;
    const extname = allowedExtensions.test(path.extname(file.originalname).toLowerCase());
    
    // More permissive mimetype check - allow text files
    const allowedMimetypes = /image\/|application\/pdf|application\/msword|application\/vnd\.openxmlformats-officedocument\.wordprocessingml\.document|text\//;
    const mimetype = allowedMimetypes.test(file.mimetype);
    
    if (mimetype && extname) {
      return cb(null, true);
    } else {
      cb(new Error('Invalid file type. Only images, PDFs, Word documents, and text files are allowed.'));
    }
  }
});

// Initialize Anthropic client
const anthropic = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY,
});

// NOMAD MODE System Prompts
const PRECISION_PROMPT = `You are operating in PRECISION MODE. Follow these strict guidelines:

1. ONLY use information from the provided knowledge base context when available
2. If the answer is not in the knowledge base, clearly state "I don't have that information in my knowledge base"
3. DO NOT fabricate names, numbers, dates, or specific details
4. DO NOT make speculative guesses about facts
5. When uncertain, acknowledge uncertainty explicitly
6. Prioritize accuracy over creativity

Be helpful and informative, but never sacrifice factual accuracy for completeness.`;

const NOMAD_MODE_PROMPT = `🌪️ YOU ARE IN NOMAD MODE 🌪️

You are operating with creative freedom. In this mode:

1. EXPLORE wild possibilities and make bold speculations
2. CONNECT dots in unconventional ways
3. DREAM beyond conventional facts when appropriate
4. CREATE scenarios and possibilities freely
5. VENTURE into imaginative territory
6. SPECULATE confidently about potential outcomes

However:
- When knowledge base context is provided, use it as inspiration but feel free to expand creatively
- Acknowledge when you're speculating vs. stating facts
- Be bold, imaginative, and exploratory
- The user wants creative exploration, not just factual recitation

You are the user's creative muse. Wander freely. Create boldly.`;

// Helper function to get system prompt based on mode
function getSystemPrompt(nomadMode, customPrompt, ragContext) {
  let basePrompt = '';
  
  if (nomadMode === 'true' || nomadMode === true) {
    basePrompt = NOMAD_MODE_PROMPT;
  } else {
    basePrompt = PRECISION_PROMPT;
  }
  
  if (customPrompt) {
    basePrompt = customPrompt + '\n\n' + basePrompt;
  }
  
  return basePrompt;
}

// Helper function to filter conversation history
function filterConversationHistory(history) {
  if (!history) return [];
  try {
    const parsed = typeof history === 'string' ? JSON.parse(history) : history;
    return Array.isArray(parsed) ? parsed.slice(-10) : [];
  } catch {
    return [];
  }
}

// Helper function to process files
async function processFile(file) {
  if (!file) return null;
  
  try {
    const ext = path.extname(file.originalname).toLowerCase();
    
    if (['.jpg', '.jpeg', '.png', '.gif'].includes(ext)) {
      const imageBuffer = await fs.readFile(file.path);
      const base64Image = imageBuffer.toString('base64');
      const mediaType = file.mimetype;
      
      await fs.unlink(file.path);
      
      return {
        type: 'image',
        data: base64Image,
        mediaType: mediaType,
        filename: file.originalname
      };
    } else if (ext === '.pdf') {
      const dataBuffer = await fs.readFile(file.path);
      const pdfData = await pdfParse(dataBuffer);
      await fs.unlink(file.path);
      
      return {
        type: 'text',
        data: pdfData.text,
        filename: file.originalname
      };
    } else if (['.doc', '.docx'].includes(ext)) {
      const result = await mammoth.extractRawText({ path: file.path });
      await fs.unlink(file.path);
      
      return {
        type: 'text',
        data: result.value,
        filename: file.originalname
      };
    } else if (ext === '.txt') {
      const textContent = await fs.readFile(file.path, 'utf-8');
      await fs.unlink(file.path);
      
      return {
        type: 'text',
        data: textContent,
        filename: file.originalname
      };
    }
    
    await fs.unlink(file.path);
    return null;
  } catch (error) {
    console.error('File processing error:', error);
    try {
      await fs.unlink(file.path);
    } catch {}
    return null;
  }
}

// Document upload endpoint for knowledge base
app.post('/api/upload-document', upload.single('file'), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ success: false, error: 'No file uploaded' });
    }

    const file = req.file;
    const ext = path.extname(file.originalname).toLowerCase();
    let textContent = '';

    if (ext === '.pdf') {
      const dataBuffer = await fs.readFile(file.path);
      const pdfData = await pdfParse(dataBuffer);
      textContent = pdfData.text;
    } else if (['.doc', '.docx'].includes(ext)) {
      const result = await mammoth.extractRawText({ path: file.path });
      textContent = result.value;
    } else if (ext === '.txt') {
      textContent = await fs.readFile(file.path, 'utf-8');
    } else {
      await fs.unlink(file.path);
      return res.status(400).json({ success: false, error: 'Unsupported file type' });
    }

    await fs.unlink(file.path);

    const documentId = `doc-${Date.now()}-${file.originalname.replace(/[^a-z0-9]/gi, '')}`;
    const chunkCount = await storeDocument(documentId, textContent, {
      filename: file.originalname,
      uploadDate: new Date().toISOString()
    });

    res.json({
      success: true,
      message: `Document uploaded successfully! ${chunkCount} chunks stored.`,
      documentId: documentId,
      filename: file.originalname,
      chunkCount: chunkCount
    });
  } catch (error) {
    console.error('Error uploading document:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// ENHANCED: Claude endpoint with RAG and NOMAD MODE support
app.post('/api/chat/claude', upload.array('files', 5), async (req, res) => {
  try {
    const { message, systemPrompt, conversationHistory, useRAG, nomadMode } = req.body;
    const files = req.files || [];
    
    const processedFiles = await Promise.all(files.map(processFile));
    
    const messages = [
      ...filterConversationHistory(conversationHistory).map(msg => ({
        role: msg.role === 'assistant' ? 'assistant' : 'user',
        content: msg.content
      }))
    ];
    
    let content = [];
    
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
    
    let ragContext = null;
    if (useRAG !== 'false' && useRAG !== false) {
      try {
        const contextResult = await getRelevantContext(message, 3);
        if (contextResult.hasContext && contextResult.confidence > 0.5) {
          ragContext = contextResult.context;
          console.log(`🧠 RAG context added (confidence: ${(contextResult.confidence * 100).toFixed(1)}%)`);
        }
      } catch (ragError) {
        console.error('RAG error (continuing without context):', ragError);
      }
    }
    
    if (ragContext) {
      content.push({
        type: 'text',
        text: `[Relevant information from knowledge base]\n\n${ragContext}\n\n[End of knowledge base context]`
      });
    }
    
    content.push({
      type: 'text',
      text: message
    });
    
    messages.push({ role: 'user', content });
    
    // Get appropriate system prompt based on NOMAD MODE
    const finalSystemPrompt = getSystemPrompt(nomadMode, systemPrompt, ragContext);
    
    const response = await anthropic.messages.create({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 4096,
      system: finalSystemPrompt,
      messages: messages,
    });

    res.json({ 
      success: true, 
      response: response.content[0].text, 
      ai: 'claude',
      ragUsed: ragContext !== null,
      nomadMode: nomadMode === 'true' || nomadMode === true
    });
  } catch (error) {
    console.error('Claude error:', error);
    res.status(500).json({ success: false, error: error.message, ai: 'claude' });
  }
});

// Grok endpoint with NOMAD MODE support
app.post('/api/chat/grok', upload.array('files', 5), async (req, res) => {
  try {
    const { message, conversationHistory, useRAG, nomadMode } = req.body;
    const files = req.files || [];
    
    const processedFiles = await Promise.all(files.map(processFile));
    
    const messages = [
      ...filterConversationHistory(conversationHistory).map(msg => ({
        role: msg.role === 'assistant' ? 'assistant' : 'user',
        content: msg.content
      }))
    ];
    
    let ragContext = null;
    if (useRAG !== 'false' && useRAG !== false) {
      try {
        const contextResult = await getRelevantContext(message, 3);
        if (contextResult.hasContext && contextResult.confidence > 0.5) {
          ragContext = contextResult.context;
        }
      } catch (ragError) {
        console.error('RAG error:', ragError);
      }
    }
    
    let userContent = '';
    
    for (const file of processedFiles) {
      if (file && file.type === 'text') {
        userContent += `[Content from file: ${file.filename}]\n\n${file.data}\n\n[End of file content]\n\n`;
      }
    }
    
    if (ragContext) {
      userContent += `[Relevant information from knowledge base]\n\n${ragContext}\n\n[End of knowledge base context]\n\n`;
    }
    
    userContent += message;
    
    messages.push({
      role: 'user',
      content: userContent
    });
    
    // Get appropriate system prompt based on NOMAD MODE
    const systemMessage = getSystemPrompt(nomadMode, 'You are Grok, a helpful AI assistant.', ragContext);
    
    const response = await fetch('https://api.x.ai/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${process.env.XAI_API_KEY}`,
      },
      body: JSON.stringify({
        messages: [
          { role: 'system', content: systemMessage },
          ...messages
        ],
        model: 'grok-3',
        temperature: nomadMode === 'true' || nomadMode === true ? 0.9 : 0.7
      })
    });

    const data = await response.json();
    
    if (data.choices && data.choices[0]) {
      res.json({ 
        success: true, 
        response: data.choices[0].message.content, 
        ai: 'grok',
        ragUsed: ragContext !== null,
        nomadMode: nomadMode === 'true' || nomadMode === true
      });
    } else {
      throw new Error('Invalid response from Grok API');
    }
  } catch (error) {
    console.error('Grok error:', error);
    res.json({ success: true, response: `Grok error: ${error.message}`, ai: 'grok' });
  }
});

// Gemini endpoint with NOMAD MODE support
app.post('/api/chat/gemini', upload.array('files', 5), async (req, res) => {
  try {
    const { message, conversationHistory, useRAG, nomadMode } = req.body;
    const files = req.files || [];
    
    const processedFiles = await Promise.all(files.map(processFile));
    
    let ragContext = null;
    if (useRAG !== 'false' && useRAG !== false) {
      try {
        const contextResult = await getRelevantContext(message, 3);
        if (contextResult.hasContext && contextResult.confidence > 0.5) {
          ragContext = contextResult.context;
        }
      } catch (ragError) {
        console.error('RAG error:', ragError);
      }
    }
    
    let userContent = '';
    
    for (const file of processedFiles) {
      if (file && file.type === 'text') {
        userContent += `[Content from file: ${file.filename}]\n\n${file.data}\n\n[End of file content]\n\n`;
      }
    }
    
    if (ragContext) {
      userContent += `[Relevant information from knowledge base]\n\n${ragContext}\n\n[End of knowledge base context]\n\n`;
    }
    
    // Get appropriate system prompt based on NOMAD MODE
    const systemInstructions = getSystemPrompt(nomadMode, '', ragContext);
    
    userContent += `${systemInstructions}\n\nUser query: ${message}`;
    
    const geminiUrl = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${process.env.GEMINI_API_KEY}`;
    
    const response = await fetch(geminiUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        contents: [{
          parts: [{ text: userContent }],
          role: 'user'
        }],
        generationConfig: {
          temperature: nomadMode === 'true' || nomadMode === true ? 0.9 : 0.7,
          maxOutputTokens: 4096
        }
      })
    });

    const data = await response.json();
    
    if (data.candidates && data.candidates[0]) {
      res.json({ 
        success: true, 
        response: data.candidates[0].content.parts[0].text, 
        ai: 'gemini',
        ragUsed: ragContext !== null,
        nomadMode: nomadMode === 'true' || nomadMode === true
      });
    } else {
      throw new Error('Invalid response from Gemini API');
    }
  } catch (error) {
    console.error('Gemini error:', error);
    res.json({ success: true, response: `Gemini error: ${error.message}`, ai: 'gemini' });
  }
});

// API Key Test Endpoint
app.get('/api/test-keys', async (req, res) => {
  const results = {
    claude: { tested: false, working: false, response: '' },
    grok: { tested: false, working: false, response: '' },
    gemini: { tested: false, working: false, response: '' }
  };

  // Test Claude
  try {
    const response = await anthropic.messages.create({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 50,
      messages: [{ role: 'user', content: 'Say only your name' }],
    });
    results.claude.tested = true;
    results.claude.working = true;
    results.claude.response = response.content[0].text;
  } catch (error) {
    results.claude.tested = true;
    results.claude.response = error.message;
  }

  // Test Grok
  try {
    const grokResponse = await fetch('https://api.x.ai/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer ' + process.env.XAI_API_KEY,
      },
      body: JSON.stringify({
        messages: [
          { role: 'system', content: 'You are Grok.' },
          { role: 'user', content: 'Say only your name' }
        ],
        model: 'grok-3',
        temperature: 0.7
      })
    });
    const grokData = await grokResponse.json();
    results.grok.tested = true;
    if (grokData.choices && grokData.choices[0]) {
      results.grok.working = true;
      results.grok.response = grokData.choices[0].message.content;
    } else {
      results.grok.response = JSON.stringify(grokData);
    }
  } catch (error) {
    results.grok.tested = true;
    results.grok.response = error.message;
  }

  // Test Gemini
  try {
    const geminiUrl = 'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=' + process.env.GEMINI_API_KEY;
    const geminiResponse = await fetch(geminiUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        contents: [{
          parts: [{ text: 'Say only your name' }],
          role: 'user'
        }]
      })
    });
    const geminiData = await geminiResponse.json();
    results.gemini.tested = true;
    if (geminiData.candidates && geminiData.candidates[0]) {
      results.gemini.working = true;
      results.gemini.response = geminiData.candidates[0].content.parts[0].text;
    } else {
      results.gemini.response = JSON.stringify(geminiData);
    }
  } catch (error) {
    results.gemini.tested = true;
    results.gemini.response = error.message;
  }

  // Return simple JSON results
  res.json({
    claude: results.claude,
    grok: results.grok,
    gemini: results.gemini,
    summary: (results.claude.working && results.grok.working && results.gemini.working) 
      ? 'All APIs working!' 
      : 'Some APIs are failing'
  });
});

const PORT = process.env.PORT || 8000;
app.listen(PORT, '0.0.0.0', () => {
  console.log(`Server running on port ${PORT}`);
  console.log(`🧠 RAG enabled with Pinecone vector database`);
  console.log(`🌪️ NOMAD MODE ready for creative exploration`);
});
