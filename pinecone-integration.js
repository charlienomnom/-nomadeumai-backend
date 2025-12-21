// Pinecone Integration for NomadeumAI
// This module handles vector storage and RAG (Retrieval-Augmented Generation)

const { Pinecone } = require('@pinecone-database/pinecone');

// Initialize Pinecone client
let pineconeClient = null;
let pineconeIndex = null;

async function initializePinecone() {
  if (!pineconeClient) {
    pineconeClient = new Pinecone({
      apiKey: process.env.PINECONE_API_KEY,
    });
    
    pineconeIndex = pineconeClient.index(process.env.PINECONE_INDEX_NAME);
    console.log('✅ Pinecone initialized successfully');
  }
  return pineconeIndex;
}

// Chunk text into smaller pieces for embedding
function chunkText(text, maxChunkSize = 400) {
  const sentences = text.match(/[^.!?]+[.!?]+/g) || [text];
  const chunks = [];
  let currentChunk = '';
  
  for (const sentence of sentences) {
    if ((currentChunk + sentence).length > maxChunkSize && currentChunk.length > 0) {
      chunks.push(currentChunk.trim());
      currentChunk = sentence;
    } else {
      currentChunk += sentence;
    }
  }
  
  if (currentChunk.trim().length > 0) {
    chunks.push(currentChunk.trim());
  }
  
  return chunks;
}

// Generate embeddings using Pinecone's inference API
async function generateEmbedding(text) {
  try {
    const pc = new Pinecone({
      apiKey: process.env.PINECONE_API_KEY,
    });
    
    const model = 'multilingual-e5-large';
    const embeddings = await pc.inference.embed(
      model,
      [text],
      { inputType: 'passage', truncate: 'END' }
    );
    
    return embeddings[0].values;
  } catch (error) {
    console.error('Error generating embedding:', error);
    throw error;
  }
}

// Store document in Pinecone
async function storeDocument(documentId, text, metadata = {}) {
  try {
    await initializePinecone();
    
    // Chunk the document
    const chunks = chunkText(text);
    console.log(`📄 Storing document: ${documentId} (${chunks.length} chunks)`);
    
    // Generate embeddings and prepare vectors
    const vectors = [];
    for (let i = 0; i < chunks.length; i++) {
      const chunkId = `${documentId}-chunk-${i}`;
      const embedding = await generateEmbedding(chunks[i]);
      
      vectors.push({
        id: chunkId,
        values: embedding,
        metadata: {
          ...metadata,
          documentId: documentId,
          chunkIndex: i,
          text: chunks[i],
          totalChunks: chunks.length
        }
      });
    }
    
    // Upsert vectors to Pinecone
    await pineconeIndex.upsert(vectors);
    
    console.log(`✅ Document stored successfully: ${documentId}`);
    return {
      success: true,
      documentId: documentId,
      chunksStored: chunks.length
    };
  } catch (error) {
    console.error('Error storing document:', error);
    throw error;
  }
}

// Query documents from Pinecone
async function queryDocuments(query, topK = 3) {
  try {
    await initializePinecone();
    
    // Generate embedding for the query
    const queryEmbedding = await generateEmbedding(query);
    
    // Query Pinecone
    const queryResponse = await pineconeIndex.query({
      vector: queryEmbedding,
      topK: topK,
      includeMetadata: true
    });
    
    // Extract and format results
    const results = queryResponse.matches.map(match => ({
      id: match.id,
      score: match.score,
      text: match.metadata.text,
      documentId: match.metadata.documentId,
      filename: match.metadata.filename
    }));
    
    return results;
  } catch (error) {
    console.error('Error querying documents:', error);
    throw error;
  }
}

// Build context from query results
function buildContext(queryResults) {
  if (!queryResults || queryResults.length === 0) {
    return null;
  }
  
  const contextParts = queryResults.map((result, index) => 
    `[Document ${index + 1} - Relevance: ${(result.score * 100).toFixed(1)}%]\n${result.text}`
  );
  
  return contextParts.join('\n\n---\n\n');
}

// Main RAG function: Query and get context
async function getRelevantContext(userMessage, topK = 3) {
  try {
    const results = await queryDocuments(userMessage, topK);
    
    if (results.length === 0) {
      return {
        hasContext: false,
        context: null,
        confidence: 0
      };
    }
    
    // Calculate average confidence
    const avgConfidence = results.reduce((sum, r) => sum + r.score, 0) / results.length;
    
    return {
      hasContext: true,
      context: buildContext(results),
      confidence: avgConfidence,
      resultsCount: results.length
    };
  } catch (error) {
    console.error('Error getting relevant context:', error);
    return {
      hasContext: false,
      context: null,
      confidence: 0,
      error: error.message
    };
  }
}

module.exports = {
  initializePinecone,
  storeDocument,
  queryDocuments,
  getRelevantContext,
  buildContext
};
