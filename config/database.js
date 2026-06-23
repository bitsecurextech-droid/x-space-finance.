// config/database.js - PostgreSQL with Supabase
const { Pool } = require('pg');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: {
    rejectUnauthorized: false
  }
});

// Export query methods that work with PostgreSQL
module.exports = {
  // Main query method for SELECT, INSERT, UPDATE, DELETE
  query: (text, params) => pool.query(text, params),
  
  // Get single row (returns first row)
  get: async (text, params) => {
    const res = await pool.query(text, params);
    return res.rows[0];
  },
  
  // Get all rows
  all: async (text, params) => {
    const res = await pool.query(text, params);
    return res.rows;
  },
  
  // Run query (for INSERT, UPDATE, DELETE)
  run: async (text, params) => {
    const res = await pool.query(text, params);
    return res;
  },
  
  // Transaction helpers
  begin: () => pool.query('BEGIN'),
  commit: () => pool.query('COMMIT'),
  rollback: () => pool.query('ROLLBACK'),
  
  // Pool for raw access if needed
  pool: pool
};
