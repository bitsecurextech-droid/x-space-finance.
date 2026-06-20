const rateLimit = require('express-rate-limit');
const helmet = require('helmet');
const csrf = require('csurf');
const { body, validationResult } = require('express-validator');

// Rate limiters
const createRateLimiter = (windowMs, max, message) => rateLimit({
  windowMs,
  max,
  message: { error: message },
  standardHeaders: true,
  legacyHeaders: false,
});

// Login limiter: 5 attempts per 15 minutes
const loginLimiter = createRateLimiter(
  15 * 60 * 1000,
  5,
  'Too many login attempts. Please try again after 15 minutes.'
);

// Registration limiter: 3 attempts per hour
const registerLimiter = createRateLimiter(
  60 * 60 * 1000,
  3,
  'Too many registration attempts. Please try again after an hour.'
);

// Withdrawal limiter: 3 attempts per hour
const withdrawalLimiter = createRateLimiter(
  60 * 60 * 1000,
  3,
  'Too many withdrawal requests. Please try again later.'
);

// Deposit limiter: 5 attempts per hour
const depositLimiter = createRateLimiter(
  60 * 60 * 1000,
  5,
  'Too many deposit requests. Please wait before submitting more.'
);

// Global API limiter: 100 requests per minute
const apiLimiter = createRateLimiter(
  60 * 1000,
  100,
  'Too many requests. Please slow down.'
);

// Helmet configuration for production
const securityHeaders = helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      styleSrc: ["'self'", "'unsafe-inline'", 'https://fonts.googleapis.com', 'https://cdn.jsdelivr.net', 'https://cdnjs.cloudflare.com'],
      scriptSrc: ["'self'", "'unsafe-inline'", "'unsafe-eval'", 'https://cdn.jsdelivr.net', 'https://cdnjs.cloudflare.com', 'https://code.jquery.com'],
      fontSrc: ["'self'", 'https://fonts.gstatic.com', 'https://cdnjs.cloudflare.com'],
      imgSrc: ["'self'", 'data:', 'https://api.qrserver.com', 'https://res.cloudinary.com', 'https://*.supabase.co'],
      connectSrc: ["'self'", 'https://api.frankfurter.app', 'https://*.supabase.co'],
      frameSrc: ["'none'"],
      objectSrc: ["'none'"],
      upgradeInsecureRequests: [],
    },
  },
  crossOriginEmbedderPolicy: false,
  crossOriginResourcePolicy: { policy: "cross-origin" },
});

// CSRF protection (exclude API endpoints)
const csrfProtection = csrf({
  cookie: {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'strict',
  },
});

// Validation rules
const validateRegistration = [
  body('first_name').trim().isLength({ min: 2, max: 50 }).withMessage('First name must be 2-50 characters'),
  body('last_name').trim().isLength({ min: 2, max: 50 }).withMessage('Last name must be 2-50 characters'),
  body('email').isEmail().normalizeEmail().withMessage('Valid email is required'),
  body('password').isLength({ min: 8 }).matches(/^(?=.*[a-z])(?=.*[A-Z])(?=.*\d)(?=.*[@$!%*?&])[A-Za-z\d@$!%*?&]{8,}$/)
    .withMessage('Password must have uppercase, lowercase, number, and special character'),
  body('country').isIn(['US', 'UK', 'CA']).withMessage('Valid country required'),
];

const validateDeposit = [
  body('amount').isFloat({ min: 50, max: 100000 }).withMessage('Amount must be between $50 and $100,000'),
  body('method').isIn(['BTC', 'ETH', 'SOL', 'USDT']).withMessage('Valid payment method required'),
];

const validateWithdrawal = [
  body('amount').isFloat({ min: 100 }).withMessage('Minimum withdrawal is $100'),
  body('method').isIn(['BTC', 'ETH', 'SOL', 'USDT', 'bank_transfer']).withMessage('Valid withdrawal method required'),
  body('address').isLength({ min: 10, max: 200 }).withMessage('Valid wallet address required'),
];

const validateInvestment = [
  body('plan_id').isInt().withMessage('Valid plan required'),
  body('amount').isFloat({ min: 100 }).withMessage('Minimum investment is $100'),
];

// Input sanitization middleware
const sanitizeInput = (req, res, next) => {
  if (req.body) {
    for (let key in req.body) {
      if (typeof req.body[key] === 'string') {
        // Remove HTML tags
        req.body[key] = req.body[key].replace(/<[^>]*>/g, '');
        // Trim whitespace
        req.body[key] = req.body[key].trim();
        // Limit length
        if (req.body[key].length > 1000) {
          req.body[key] = req.body[key].substring(0, 1000);
        }
      }
    }
  }
  next();
};

// Check if user is authenticated
const isAuthenticated = (req, res, next) => {
  if (!req.session || !req.session.userId) {
    return res.redirect('/signin');
  }
  next();
};

// Check if user is admin
const isAdmin = async (req, res, next) => {
  if (!req.session || !req.session.userId) {
    return res.redirect('/signin');
  }
  
  try {
    const db = require('../config/database');
    const user = await db.get('SELECT is_admin FROM users WHERE id = ?', [req.session.userId]);
    
    if (!user || !user.is_admin) {
      return res.status(403).render('error', { 
        message: 'Access denied. Admin privileges required.',
        error: { status: 403 }
      });
    }
    next();
  } catch (error) {
    console.error('Admin check error:', error);
    res.status(500).render('error', { message: 'Server error', error: { status: 500 } });
  }
};

// Check if user is banned
const isNotBanned = async (req, res, next) => {
  if (!req.session || !req.session.userId) {
    return next();
  }
  
  try {
    const db = require('../config/database');
    const user = await db.get('SELECT is_banned FROM users WHERE id = ?', [req.session.userId]);
    
    if (user && user.is_banned) {
      req.session.destroy();
      return res.redirect('/signin?banned=true');
    }
    next();
  } catch (error) {
    console.error('Ban check error:', error);
    next();
  }
};

// Check if email is verified
const isEmailVerified = async (req, res, next) => {
  if (!req.session || !req.session.userId) {
    return next();
  }
  
  try {
    const db = require('../config/database');
    const user = await db.get('SELECT email_verified FROM users WHERE id = ?', [req.session.userId]);
    
    if (user && !user.email_verified) {
      return res.render('verify-email-required', {
        email: req.session.email,
        csrfToken: req.csrfToken ? req.csrfToken() : null
      });
    }
    next();
  } catch (error) {
    console.error('Email verification check error:', error);
    next();
  }
};

// Log user activity
const logActivity = async (req, action, details = null) => {
  if (!req.session || !req.session.userId) return;
  
  try {
    const db = require('../config/database');
    const ip = req.ip || req.connection.remoteAddress;
    
    await db.run(`
      INSERT INTO activity_log (user_id, action, ip, details, created_at)
      VALUES (?, ?, ?, ?, datetime('now'))
    `, [req.session.userId, action, ip, details]);
  } catch (error) {
    console.error('Activity logging error:', error);
  }
};

// Middleware to add user data to res.locals
const addUserToLocals = async (req, res, next) => {
  if (req.session && req.session.userId) {
    try {
      const db = require('../config/database');
      const user = await db.get(`
        SELECT id, first_name, last_name, email, balance, currency, is_admin, kyc_status, referral_code
        FROM users WHERE id = ?
      `, [req.session.userId]);
      
      if (user) {
        res.locals.user = user;
        res.locals.isLoggedIn = true;
        res.locals.isAdmin = user.is_admin === 1;
      } else {
        res.locals.isLoggedIn = false;
      }
    } catch (error) {
      console.error('User to locals error:', error);
      res.locals.isLoggedIn = false;
    }
  } else {
    res.locals.isLoggedIn = false;
  }
  next();
};

// CSRF error handler
const csrfErrorHandler = (err, req, res, next) => {
  if (err.code === 'EBADCSRFTOKEN') {
    return res.status(403).render('error', {
      message: 'Invalid security token. Please refresh the page and try again.',
      error: { status: 403 }
    });
  }
  next(err);
};

module.exports = {
  loginLimiter,
  registerLimiter,
  withdrawalLimiter,
  depositLimiter,
  apiLimiter,
  securityHeaders,
  csrfProtection,
  validateRegistration,
  validateDeposit,
  validateWithdrawal,
  validateInvestment,
  sanitizeInput,
  isAuthenticated,
  isAdmin,
  isNotBanned,
  isEmailVerified,
  logActivity,
  addUserToLocals,
  csrfErrorHandler,
  validationResult,
};