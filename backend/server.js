const express = require('express');
const cors = require('cors');
const sqlite3 = require('sqlite3').verbose();
const app = express();
const path = require('path');

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, '../user_dashboard')));
app.use('/admin', express.static(path.join(__dirname, '../admin-dashboard')));

// Serve HTML pages
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, '../user-dashboard/index.html'));
});

app.get('/admin', (req, res) => {
    res.sendFile(path.join(__dirname, '../admin-dashboard/index.html'));
});

// Database setup
const db = new sqlite3.Database('./feedback.db', (err) => {
  if (err) console.error('Database error:', err);
  else console.log('Database connected');
});

// Initialize database
db.serialize(() => {
  db.run(`CREATE TABLE IF NOT EXISTS feedback (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    rating INTEGER CHECK(rating >= 1 AND rating <= 5),
    review TEXT,
    ai_response TEXT,
    ai_summary TEXT,
    ai_actions TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )`);
});

// Enhanced LLM function with better prompts
async function callLLM(prompt, taskType) {
  const fallbacks = {
    response: 'Thank you for your valuable feedback! We appreciate you taking the time to share your experience with us.',
    summary: 'Feedback submitted with rating.',
    actions: 'Review this feedback for insights and potential improvements.'
  };
  
  const prompts = {
    response: `You are a customer service AI. Respond professionally to this ${prompt.rating}-star feedback: "${prompt.review || 'No comment provided'}". 
               Keep response under 40 words. Be appreciative for positive feedback, empathetic for negative.`,
    
    summary: `Summarize this customer feedback in ONE concise sentence (max 15 words): 
              "${prompt.review || 'No text provided'}" 
              Rating: ${prompt.rating}/5 stars. Focus on the core sentiment.`,
    
    actions: `Based on this ${prompt.rating}-star feedback: "${prompt.review || 'No specific comments provided'}", 
              suggest 1-2 specific, actionable recommendations. Be practical and brief.`
  };
  
  try {
    const response = await fetch('https://openrouter.ai/api/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Authorization': 'Bearer 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',
        'Content-Type': 'application/json',
        'HTTP-Referer': 'http://localhost:3000',
        'X-Title': 'Feedback AI System'
      },
      body: JSON.stringify({
        model: 'mistralai/devstral-2512:free',
        messages: [{ role: 'user', content: prompts[taskType] }],
        max_tokens: 150,
        temperature: 0.7
      })
    });
    
    if (!response.ok) {
      throw new Error(`API response: ${response.status}`);
    }
    
    const data = await response.json();
    const result = data.choices?.[0]?.message?.content?.trim();
    
    if (!result || result.length < 5) {
      throw new Error('Empty AI response');
    }
    
    console.log(`AI ${taskType} generated:`, result.substring(0, 100));
    return result;
    
  } catch (error) {
    console.log(`Using fallback for ${taskType}:`, error.message);
    return fallbacks[taskType];
  }
}

// API: Submit feedback with parallel AI processing
app.post('/api/feedback', async (req, res) => {
  console.log('📥 Received feedback:', req.body);
  
  try {
    const { rating, review } = req.body;
    
    // Validation
    if (!rating || rating < 1 || rating > 5) {
      return res.status(400).json({ 
        success: false, 
        error: 'Rating must be between 1 and 5' 
      });
    }
    
    const feedbackData = { rating, review: review || '' };
    
    // Generate ALL AI responses in parallel for better performance
    const [aiResponse, aiSummary, aiActions] = await Promise.allSettled([
      callLLM(feedbackData, 'response'),
      callLLM(feedbackData, 'summary'),
      callLLM(feedbackData, 'actions')
    ]);
    
    // Prepare data for database
    const aiResults = {
      response: aiResponse.status === 'fulfilled' ? aiResponse.value : 'Thank you for your feedback!',
      summary: aiSummary.status === 'fulfilled' ? aiSummary.value : `${rating}-star feedback received`,
      actions: aiActions.status === 'fulfilled' ? aiActions.value : 'Review feedback for insights'
    };
    
    console.log('🤖 AI Generated:', {
      summary: aiResults.summary.substring(0, 50),
      actions: aiResults.actions.substring(0, 50)
    });
    
    // Save to database
    await new Promise((resolve, reject) => {
      db.run(
        `INSERT INTO feedback (rating, review, ai_response, ai_summary, ai_actions) 
         VALUES (?, ?, ?, ?, ?)`,
        [rating, review || '', aiResults.response, aiResults.summary, aiResults.actions],
        function(err) {
          if (err) reject(err);
          else resolve({ id: this.lastID });
        }
      );
    });
    
    res.json({ 
      success: true, 
      aiResponse: aiResults.response,
      message: 'Feedback submitted with AI analysis!'
    });
    
  } catch (error) {
    console.error('❌ Server error:', error);
    res.status(500).json({ 
      success: false, 
      error: 'Failed to process feedback. Please try again.' 
    });
  }
});

// API: Get feedback with filtering
app.get('/api/feedback', async (req, res) => {
  try {
    const { rating, limit, sort = 'desc' } = req.query;
    
    let query = 'SELECT * FROM feedback';
    const params = [];
    
    if (rating && !isNaN(rating)) {
      query += ' WHERE rating = ?';
      params.push(parseInt(rating));
    }
    
    query += ` ORDER BY created_at ${sort === 'asc' ? 'ASC' : 'DESC'}`;
    
    if (limit && !isNaN(limit)) {
      query += ' LIMIT ?';
      params.push(parseInt(limit));
    }
    
    const feedback = await new Promise((resolve, reject) => {
      db.all(query, params, (err, rows) => {
        if (err) reject(err);
        else resolve(rows);
      });
    });
    
    res.json({ 
      success: true, 
      data: feedback,
      count: feedback.length
    });
    
  } catch (error) {
    console.error('Fetch error:', error);
    res.status(500).json({ success: false, error: 'Failed to fetch feedback' });
  }
});

// API: Get analytics with filtering
app.get('/api/analytics', async (req, res) => {
  try {
    const { rating } = req.query;
    
    let whereClause = '';
    const params = [];
    
    if (rating && !isNaN(rating)) {
      whereClause = ' WHERE rating = ?';
      params.push(parseInt(rating));
    }
    
    // Get analytics with optional filter
    const queries = {
      total: `SELECT COUNT(*) as count FROM feedback${whereClause}`,
      avgRating: `SELECT AVG(rating) as avg FROM feedback${whereClause}`,
      byRating: `SELECT rating, COUNT(*) as count FROM feedback GROUP BY rating ORDER BY rating DESC`,
      recent: `SELECT COUNT(*) as count FROM feedback WHERE created_at > datetime('now', '-1 day')${whereClause.replace('WHERE', 'AND')}`
    };
    
    const [total, avgRating, byRating, recent] = await Promise.all([
      dbGet(queries.total, params),
      dbGet(queries.avgRating, params),
      dbAll(queries.byRating, []),
      dbGet(rating ? queries.recent : queries.recent.replace(whereClause, ''), rating ? params : [])
    ]);
    
    res.json({
      success: true,
      data: {
        total: total.count,
        avgRating: avgRating.avg ? Number(avgRating.avg.toFixed(2)) : 0,
        byRating,
        recent: recent.count
      }
    });
    
  } catch (error) {
    console.error('Analytics error:', error);
    res.status(500).json({ success: false, error: 'Failed to fetch analytics' });
  }
});

// Helper functions
function dbAll(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.all(sql, params, (err, rows) => {
      if (err) reject(err);
      else resolve(rows);
    });
  });
}

function dbGet(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.get(sql, params, (err, row) => {
      if (err) reject(err);
      else resolve(row);
    });
  });
}

// Health check
app.get('/api/health', (req, res) => {
  res.json({ 
    status: 'OK', 
    timestamp: new Date().toISOString(),
    ai: 'Mistral Devstral 2512 (Free via OpenRouter)'
  });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🚀 Backend running: http://localhost:${PORT}`);
  console.log(`📊 Health check: http://localhost:${PORT}/api/health`);
  console.log(`🤖 AI Model: Mistral 7B Instruct (Free via OpenRouter)`);
});