require('dotenv').config();
const express = require('express');
const session = require('express-session');
const SQLiteStore = require('connect-sqlite3')(session);
const path = require('path');
const bcrypt = require('bcrypt');
const crypto = require('crypto');
const helmet = require('helmet');
const flash = require('connect-flash');
const db = require('./config/database');

// ==================== DATABASE MIGRATIONS ====================
(async () => {
  try {
    // Add missing columns to users table
    const columns = [
      { name: 'realized', type: 'DECIMAL(15,2) DEFAULT 0' },
      { name: 'kyc_doc', type: 'TEXT' },
      { name: 'reset_token', type: 'TEXT' },
      { name: 'reset_token_expiry', type: 'TIMESTAMP' },
      { name: 'email_verify_token', type: 'TEXT' },
      { name: 'last_login', type: 'TIMESTAMP' },
      { name: 'is_banned', type: 'INTEGER DEFAULT 0' },
      { name: 'email_verified', type: 'INTEGER DEFAULT 0' }
    ];
    
    for (const col of columns) {
      try {
        await db.query(`ALTER TABLE users ADD COLUMN ${col.name} ${col.type}`);
        console.log(`✅ Added column: ${col.name}`);
      } catch (e) {
        // Ignore if column already exists
        if (e.message && (e.message.includes('already exists') || e.message.includes('42701'))) {
          // Column already exists - do nothing
        } else {
          console.log(`⚠️ Could not add ${col.name}: ${e.message}`);
        }
      }
    }

    // Add missing columns to deposits table
    const depositColumns = [
      { name: 'proof_path', type: 'TEXT' },
      { name: 'gift_card_code', type: 'TEXT' },
      { name: 'gift_card_file', type: 'TEXT' },
      { name: 'deposit_type', type: 'TEXT DEFAULT \'deposit\'' },
      { name: 'tx_hash', type: 'TEXT' },
      { name: 'processed_at', type: 'TIMESTAMP' }
    ];
    
    for (const col of depositColumns) {
      try {
        await db.query(`ALTER TABLE deposits ADD COLUMN ${col.name} ${col.type}`);
        console.log(`✅ Added column to deposits: ${col.name}`);
      } catch (e) {
        // Ignore if column already exists
        if (e.message && (e.message.includes('already exists') || e.message.includes('42701'))) {
          // Column already exists - do nothing
        } else {
          console.log(`⚠️ Could not add ${col.name} to deposits: ${e.message}`);
        }
      }
    }

    // Create activity_log table if it doesn't exist
    try {
      await db.query(`
        CREATE TABLE IF NOT EXISTS activity_log (
          id SERIAL PRIMARY KEY,
          user_id INTEGER NOT NULL,
          action TEXT,
          type TEXT,
          description TEXT,
          created_at TIMESTAMP DEFAULT NOW()
        )
      `);
      console.log('✅ Activity_log table ready');
    } catch (e) {
      console.log('⚠️ Activity_log table check:', e.message);
    }

    // Create chat_messages table if it doesn't exist
    try {
      await db.query(`
        CREATE TABLE IF NOT EXISTS chat_messages (
          id SERIAL PRIMARY KEY,
          user_id INTEGER NOT NULL,
          message TEXT,
          is_admin INTEGER DEFAULT 0,
          created_at TIMESTAMP DEFAULT NOW()
        )
      `);
      console.log('✅ Chat_messages table ready');
    } catch (e) {
      console.log('⚠️ Chat_messages table check:', e.message);
    }

    // Create gift_card_submissions table if it doesn't exist
    try {
      await db.query(`
        CREATE TABLE IF NOT EXISTS gift_card_submissions (
          id SERIAL PRIMARY KEY,
          user_id INTEGER NOT NULL,
          deposit_id INTEGER,
          code TEXT,
          file_path TEXT,
          status TEXT DEFAULT 'pending',
          created_at TIMESTAMP DEFAULT NOW()
        )
      `);
      console.log('✅ Gift_card_submissions table ready');
    } catch (e) {
      console.log('⚠️ Gift_card_submissions table check:', e.message);
    }

    console.log('✅ Database migrations completed');
  } catch (error) {
    console.error('❌ Migration error:', error);
  }
})();

const app = express();
const PORT = process.env.PORT || 3000;

const publicRoutes = require('./routes/public');
const authRoutes = require('./routes/auth');
const userRoutes = require('./routes/user');
const adminRoutes = require('./routes/admin');
const apiRoutes = require('./routes/api');

// --- App config ---
app.set('trust proxy', 1);
app.use(helmet({ contentSecurityPolicy: false }));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public')));

// Ensure upload directories exist
const fs = require('fs');
const uploadDirs = [
  'public/uploads',
  'public/uploads/deposits',
  'public/uploads/giftcards',
  'public/uploads/kyc'
];
uploadDirs.forEach(dir => {
  const fullPath = path.join(__dirname, dir);
  if (!fs.existsSync(fullPath)) fs.mkdirSync(fullPath, { recursive: true });
});

// =============================================
// SESSION STORE – SQLite (works everywhere)
// =============================================
const sessionStore = new SQLiteStore({ db: 'sessions.db', concurrentDB: true });

app.use(session({
  store: sessionStore,
  secret: process.env.SESSION_SECRET || crypto.randomBytes(32).toString('hex'),
  resave: false,
  saveUninitialized: false,
  cookie: {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production' ? true : false,
    sameSite: 'lax',
    maxAge: 30 * 24 * 60 * 60 * 1000
  }
}));

app.use(flash());

// --- Global user middleware - FIXED PostgreSQL syntax ---
app.use(async (req, res, next) => {
  res.locals.isLoggedIn = false;
  res.locals.user = null;
  res.locals.isAdmin = false;
  res.locals.messages = req.flash();

  if (req.session && req.session.userId) {
    try {
      // PostgreSQL uses $1 instead of ?
      const user = await db.get(
        'SELECT id, first_name, last_name, email, balance, currency, is_admin, kyc_status, referral_code, is_banned, email_verified FROM users WHERE id = $1',
        [req.session.userId]
      );
      
      if (user) {
        // Check if user is banned
        if (user.is_banned === 1) {
          // User is banned - destroy session
          req.session.destroy();
          return res.redirect('/signin?banned=true');
        }
        
        res.locals.user = user;
        res.locals.isLoggedIn = true;
        // is_admin is INTEGER (0 or 1) in PostgreSQL
        res.locals.isAdmin = user.is_admin === 1;
        
        // Also set req.user for convenience
        req.user = user;
      }
    } catch (error) {
      console.error('Session user error:', error);
      // Don't crash on session error
    }
  }
  next();
});

// --- Views and routes ---
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));

// Public routes (home, about, plans, etc.)
app.use('/', publicRoutes);

// Auth routes (signin, register, logout, etc.)
app.use('/', authRoutes);

// API routes
app.use('/api', apiRoutes);

// User routes (dashboard, deposits, investments, etc.)
app.use('/dashboard', userRoutes);

// Admin routes (admin panel)
app.use('/admin', adminRoutes);

// --- Error handling ---
app.use((err, req, res, next) => {
  console.error('Server error:', err);
  res.status(500).render('error', {
    message: 'Something went wrong. Please try again later.',
    error: process.env.NODE_ENV === 'production' ? {} : err
  });
});

// --- 404 handler ---
app.use((req, res) => {
  res.status(404).render('error', { 
    message: 'Page not found', 
    error: { status: 404 } 
  });
});

// --- Start server ---
app.listen(PORT, () => {
  console.log(`
╔══════════════════════════════════════════════════════════╗
║                                                          ║
║   🚀 XSpaceFinance Server is running!                    ║
║                                                          ║
║   📡 Port: ${PORT}                                          ║
║   🌍 URL: http://localhost:${PORT}                         ║
║                                                          ║
╚══════════════════════════════════════════════════════════╝
  `);
});

// --- Currency helper ---
app.locals.formatCurrency = function(amount, currency) {
  if (!currency) currency = 'GBP';
  if (!amount) amount = 0;
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: currency
  }).format(amount);
};

// --- Graceful shutdown ---
process.on('SIGINT', () => { 
  console.log('🛑 Shutting down...'); 
  process.exit(0); 
});
process.on('SIGTERM', () => { 
  console.log('🛑 Shutting down...'); 
  process.exit(0); 
});
