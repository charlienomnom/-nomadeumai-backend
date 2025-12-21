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
    
    pineconeIndex = pineconeClient.index(process.env.PINECONE_INDEX_NAME, process.env.PINECONE_INDEX_HOST);
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

// Generate embeddings using Pinecone's inference API (multilingual-e5-large)
async function generateEmbedding(text) {
  try {
    const index = await initializePinecone();
    
    // Use Pinecone's built-in embedding generation
    const embedResponse = await index.inference.embed(
      'multilingual-e5-large',
      [text],
      { inputType: 'passage' }
    );
    
    return embedResponse[0].values;
  } catch (error) {
    console.error('Error generating embedding:', error);
    throw error;
  }
}

// Store document in Pinecone
async function storeDocument(documentId, documentText, metadata = {}) {
  try {
    const index = await initializePinecone();
    const chunks = chunkText(documentText);
    
    console.log(`📄 Storing document: ${documentId} (${chunks.length} chunks)`);
    
    const vectors = [];
    
    for (let i = 0; i < chunks.length; i++) {
      const chunkId = `${documentId}-chunk-${i}`;
      const embedding = await generateEmbedding(chunks[i]);
      
      vectors.push({
        id: chunkId,
        values: embedding,
        metadata: {
          text: chunks[i],
          documentId: documentId,
          chunkIndex: i,
          totalChunks: chunks.length,
          ...metadata
        }
      });
    }
    
    // Upsert vectors to Pinecone
    await index.namespace('default').upsert(vectors);
    
    console.log(`✅ Document stored: ${documentId} (${vectors.length} vectors)`);
    
    return {
      success: true,
      documentId: documentId,
      chunksStored: vectors.length
    };
  } catch (error) {
    console.error('Error storing document:', error);
    throw error;
  }
}

// Query Pinecone for relevant documents
async function queryDocuments(queryText, topK = 5) {
  try {
    const index = await initializePinecone();
    
    // Generate embedding for query
    const queryEmbedding = await generateEmbedding(queryText);
    
    // Query Pinecone
    const queryResponse = await index.namespace('default').query({
      vector: queryEmbedding,
      topK: topK,
      includeMetadata: true
    });
    
    // Extract relevant text chunks
    const results = queryResponse.matches.map(match => ({
      text: match.metadata.text,
      score: match.score,
      documentId: match.metadata.documentId,
      chunkIndex: match.metadata.chunkIndex
    }));
    
    console.log(`🔍 Query results: ${results.length} matches found`);
    
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
