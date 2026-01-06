const sqlite3 = require('sqlite3').verbose();

class FeedbackDB {
  constructor() {
    this.db = new sqlite3.Database('./feedback.db', (err) => {
      if (err) {
        console.error('Database connection error:', err);
      } else {
        console.log('Connected to SQLite database');
        this.init();
      }
    });
  }

  init() {
    const createTable = `
      CREATE TABLE IF NOT EXISTS feedback (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        rating INTEGER NOT NULL CHECK(rating >= 1 AND rating <= 5),
        review TEXT DEFAULT '',
        ai_response TEXT,
        ai_summary TEXT,
        ai_actions TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      )
    `;
    
    this.db.run(createTable);
  }

  insert(feedback) {
    return new Promise((resolve, reject) => {
      const sql = `
        INSERT INTO feedback (rating, review, ai_response, ai_summary, ai_actions)
        VALUES (?, ?, ?, ?, ?)
      `;
      
      this.db.run(sql, [
        feedback.rating,
        feedback.review || '',
        feedback.ai_response,
        feedback.ai_summary,
        feedback.ai_actions
      ], function(err) {
        if (err) reject(err);
        else resolve({ id: this.lastID });
      });
    });
  }

  getAll() {
    return new Promise((resolve, reject) => {
      const sql = `SELECT * FROM feedback ORDER BY created_at DESC`;
      this.db.all(sql, [], (err, rows) => {
        if (err) reject(err);
        else resolve(rows);
      });
    });
  }

  getAnalytics() {
    return new Promise((resolve, reject) => {
      const analytics = {};
      
      // Get total count
      this.db.get('SELECT COUNT(*) as count FROM feedback', [], (err, row) => {
        if (err) return reject(err);
        analytics.total = row.count;
        
        // Get average rating
        this.db.get('SELECT AVG(rating) as avg FROM feedback', [], (err, row) => {
          if (err) return reject(err);
          analytics.avgRating = row.avg || 0;
          
          // Get rating distribution
          this.db.all(
            'SELECT rating, COUNT(*) as count FROM feedback GROUP BY rating ORDER BY rating DESC',
            [],
            (err, rows) => {
              if (err) return reject(err);
              analytics.byRating = rows;
              
              // Get recent count
              this.db.get(
                `SELECT COUNT(*) as count FROM feedback 
                 WHERE created_at > datetime('now', '-1 day')`,
                [],
                (err, row) => {
                  if (err) return reject(err);
                  analytics.recent = row.count;
                  resolve(analytics);
                }
              );
            }
          );
        });
      });
    });
  }

  close() {
    this.db.close();
  }
}

module.exports = FeedbackDB;