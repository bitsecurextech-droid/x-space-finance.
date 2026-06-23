const express = require('express');
const router = express.Router();
const db = require('../config/database');
const bcrypt = require('bcrypt');
const multer = require('multer');
const path = require('path');
const fs = require('fs');

// ==================== MULTER CONFIG ====================

// KYC
const kycUploadDir = 'public/uploads/kyc';
if (!fs.existsSync(kycUploadDir)) fs.mkdirSync(kycUploadDir, { recursive: true });
const kycStorage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, kycUploadDir),
  filename: (req, file, cb) => {
    const unique = Date.now() + '-' + Math.round(Math.random() * 1E9);
    cb(null, 'kyc-' + unique + path.extname(file.originalname));
  }
});
const upload = multer({ storage: kycStorage, limits: { fileSize: 5 * 1024 * 1024 } });

// ===== UPDATED DEPOSIT MULTER CONFIG =====
// Support both proof and gift_card_file uploads
const depositUploadDir = 'public/uploads/deposits';
const giftcardUploadDir = 'public/uploads/giftcards';

// Create directories if they don't exist
if (!fs.existsSync(depositUploadDir)) fs.mkdirSync(depositUploadDir, { recursive: true });
if (!fs.existsSync(giftcardUploadDir)) fs.mkdirSync(giftcardUploadDir, { recursive: true });

const depositStorage = multer.diskStorage({
  destination: function (req, file, cb) {
    // Route to different folders based on field name
    if (file.fieldname === 'gift_card_file') {
      cb(null, giftcardUploadDir);
    } else {
      cb(null, depositUploadDir);
    }
  },
  filename: function (req, file, cb) {
    const unique = Date.now() + '-' + Math.round(Math.random() * 1E9);
    const prefix = file.fieldname === 'gift_card_file' ? 'giftcard-' : 'deposit-';
    cb(null, prefix + unique + path.extname(file.originalname));
  }
});

// File filter for validation
const depositFileFilter = function (req, file, cb) {
  const allowedTypes = ['image/jpeg', 'image/png', 'image/jpg', 'application/pdf'];
  if (allowedTypes.includes(file.mimetype)) {
    cb(null, true);
  } else {
    cb(new Error('Only JPG, PNG, and PDF files are allowed'), false);
  }
};

// Create multer instance with multiple field support
const depositUpload = multer({
  storage: depositStorage,
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter: depositFileFilter
});

// ==================== MIDDLEWARE ====================
router.use((req, res, next) => {
  if (!req.session.userId) {
    return res.redirect('/signin');
  }
  next();
});

// ==================== DASHBOARD HOME ====================
router.get('/', async (req, res) => {
  try {
    const userId = req.session.userId;
    if (!userId) return res.redirect('/signin');

    // PostgreSQL uses boolean values: true/false, not 1/0
    const user = await db.query(
      `SELECT id, first_name, last_name, email, balance, currency, 
              kyc_status, referral_code, email_verified, created_at, is_admin,
              COALESCE(realized, 0) as realized
       FROM users WHERE id = $1`,
      [userId]
    );
    
    if (!user || !user.rows || user.rows.length === 0) {
      req.session.destroy();
      return res.redirect('/signin');
    }
    
    const userData = user.rows[0];

    // --- Active investments ---
    const activeInvestments = await db.query(`
      SELECT i.*, p.name as plan_name, p.roi_percent, p.duration_months
      FROM investments i 
      JOIN plans p ON i.plan_id = p.id
      WHERE i.user_id = $1 AND i.status = 'active'
      ORDER BY i.created_at DESC
    `, [userId]);

    // --- All investments (for total invested) ---
    const allInvestments = await db.query(`
      SELECT amount, status FROM investments WHERE user_id = $1
    `, [userId]);

    // --- Matured investments (for realized returns) ---
    const maturedInvestments = await db.query(`
      SELECT amount, total_return FROM investments 
      WHERE user_id = $1 AND status = 'matured'
    `, [userId]);

    // --- Compute stats with safe defaults ---
    let totalInvested = 0;
    let activeCount = 0;
    let totalExpectedReturn = 0;
    let availableBalance = parseFloat(userData.balance) || 0;
    let portfolioValue = availableBalance;

    if (allInvestments && allInvestments.rows) {
      allInvestments.rows.forEach(inv => {
        if (inv.status === 'active') {
          totalInvested += parseFloat(inv.amount) || 0;
          activeCount++;
        }
      });
    }

    if (activeInvestments && activeInvestments.rows) {
      activeInvestments.rows.forEach(inv => {
        const roi = parseFloat(inv.roi_percent) / 100 || 0;
        const expected = parseFloat(inv.amount) * (1 + roi);
        totalExpectedReturn += expected;
      });
    }

    // Realized returns = admin-adjusted realized + matured returns
    let maturedReturn = 0;
    if (maturedInvestments && maturedInvestments.rows) {
      maturedReturn = maturedInvestments.rows.reduce((sum, inv) => sum + parseFloat(inv.total_return || 0), 0);
    }
    const realizedReturn = parseFloat(userData.realized || 0) + maturedReturn;

    portfolioValue = availableBalance + totalInvested;

    // --- Checklist flags ---
    const hasDeposit = await db.query(`SELECT COUNT(*) as count FROM deposits WHERE user_id = $1 AND status = 'approved'`, [userId]);
    const hasInvestment = await db.query('SELECT COUNT(*) as count FROM investments WHERE user_id = $1', [userId]);
    const isEmailVerified = !!userData.email_verified;
    const isKycVerified = userData.kyc_status === 'approved';

    // --- Recent transactions (limit 5) ---
    const recentTransactions = await db.query(`
      SELECT * FROM transactions 
      WHERE user_id = $1 
      ORDER BY created_at DESC 
      LIMIT 5
    `, [userId]);

    // --- Referral earnings ---
    const referralEarnings = await db.query(`
      SELECT COALESCE(SUM(amount),0) as total FROM transactions 
      WHERE user_id = $1 AND type = 'referral'
    `, [userId]);

    // --- Pending counts (for sidebar badges) ---
    const pendingDeposits = await db.query(`SELECT COUNT(*) as count FROM deposits WHERE user_id = $1 AND status = 'pending'`, [userId]);
    const pendingWithdrawals = await db.query(`SELECT COUNT(*) as count FROM withdrawals WHERE user_id = $1 AND status = 'pending'`, [userId]);
    const unreadCount = await db.query('SELECT COUNT(*) as count FROM notifications WHERE user_id = $1 AND is_read = false', [userId]);

    res.render('dashboard/index', {
      title: 'Dashboard',
      user: userData,
      activeInvestments: activeInvestments?.rows || [],
      totalInvested,
      activeCount,
      totalExpectedReturn,
      realizedReturn,
      availableBalance,
      portfolioValue,
      recentTransactions: recentTransactions?.rows || [],
      referralEarnings: referralEarnings?.rows[0]?.total || 0,
      isEmailVerified,
      isKycVerified,
      hasDeposit: hasDeposit?.rows[0]?.count > 0,
      hasInvestment: hasInvestment?.rows[0]?.count > 0,
      pendingDeposits: pendingDeposits?.rows[0]?.count || 0,
      pendingWithdrawals: pendingWithdrawals?.rows[0]?.count || 0,
      unreadCount: unreadCount?.rows[0]?.count || 0
    });
  } catch (error) {
    console.error('Dashboard error:', error);
    res.status(500).send('Error loading dashboard: ' + error.message);
  }
});

// ==================== INVESTMENTS (My Investments) ====================
router.get('/investments', async (req, res) => {
  try {
    const userId = req.session.userId;
    const user = await db.query('SELECT id, first_name, last_name, email, balance, currency FROM users WHERE id = $1', [userId]);
    const userData = user?.rows[0] || null;
    
    const investments = await db.query(`
      SELECT i.*, p.name as plan_name, p.roi_percent, p.duration_months
      FROM investments i JOIN plans p ON i.plan_id = p.id
      WHERE i.user_id = $1
      ORDER BY i.created_at DESC
    `, [userId]);

    let totalInvested = 0, activeCount = 0, totalExpectedReturn = 0, totalProfit = 0;
    if (investments && investments.rows) {
      investments.rows.forEach(inv => {
        if (inv.status === 'active') {
          totalInvested += parseFloat(inv.amount);
          activeCount++;
          const expected = parseFloat(inv.amount) * (1 + parseFloat(inv.roi_percent) / 100);
          totalExpectedReturn += expected;
          totalProfit += (expected - parseFloat(inv.amount));
        }
      });
    }

    res.render('dashboard/investments', {
      title: 'My Investments',
      user: userData,
      investments: investments?.rows || [],
      totalInvested,
      activeCount,
      totalExpectedReturn,
      totalProfit
    });
  } catch (error) {
    console.error('Investments error:', error);
    res.status(500).send('Error loading investments');
  }
});

// ==================== NEW INVESTMENT (GET) ====================
router.get('/new-investment', async (req, res) => {
  try {
    const userId = req.session.userId;
    const user = await db.query('SELECT id, first_name, last_name, email, balance, currency FROM users WHERE id = $1', [userId]);
    const plans = await db.query('SELECT * FROM plans WHERE is_active = 1 ORDER BY min_amount ASC');
    res.render('dashboard/new-investment', { 
      title: 'New Investment', 
      user: user?.rows[0] || null, 
      plans: plans?.rows || [] 
    });
  } catch (error) {
    console.error('New investment error:', error);
    res.status(500).send('Error loading new investment page');
  }
});

// ==================== NEW INVESTMENT (POST) ====================
router.post('/new-investment', async (req, res) => {
  try {
    const userId = req.session.userId;
    const { plan_id, amount } = req.body;
    if (!plan_id || !amount || amount <= 0) {
      req.flash('error', 'Invalid investment details');
      return res.redirect('/dashboard/new-investment');
    }
    const user = await db.query('SELECT id, balance FROM users WHERE id = $1', [userId]);
    if (!user || !user.rows || user.rows.length === 0) { 
      req.flash('error', 'User not found'); 
      return res.redirect('/dashboard/new-investment'); 
    }
    const plan = await db.query('SELECT * FROM plans WHERE id = $1 AND is_active = 1', [plan_id]);
    if (!plan || !plan.rows || plan.rows.length === 0) { 
      req.flash('error', 'Plan not found'); 
      return res.redirect('/dashboard/new-investment'); 
    }

    const userData = user.rows[0];
    const planData = plan.rows[0];
    const amt = parseFloat(amount);
    const min = parseFloat(planData.min_amount);
    const max = parseFloat(planData.max_amount);

    if (amt < min) { req.flash('error', `Minimum investment is $${min.toLocaleString()}`); return res.redirect('/dashboard/new-investment'); }
    if (amt > max) { req.flash('error', `Maximum investment is $${max.toLocaleString()}`); return res.redirect('/dashboard/new-investment'); }
    if (amt > parseFloat(userData.balance)) { req.flash('error', 'Insufficient balance'); return res.redirect('/dashboard/new-investment'); }

    const endDate = new Date();
    endDate.setDate(endDate.getDate() + planData.duration_months * 30);

    await db.query(
      `INSERT INTO investments (user_id, plan_id, amount, status, created_at, start_date, end_date)
       VALUES ($1, $2, $3, 'active', NOW(), NOW(), $4)`,
      [userId, plan_id, amount, endDate.toISOString()]
    );

    await db.query('UPDATE users SET balance = balance - $1 WHERE id = $2', [amount, userId]);
    await db.query(`INSERT INTO transactions (user_id, type, amount, status, description, created_at)
                    VALUES ($1, 'investment', $2, 'completed', $3, NOW())`,
                    [userId, amount, `Investment in ${planData.name}`]);
    await db.query(`INSERT INTO notifications (user_id, title, message, is_read, created_at)
                    VALUES ($1, $2, $3, 0, NOW())`,
                    [userId, 'Investment Activated', `Your investment of $${amount} in ${planData.name} has been activated.`]);
    await db.query(`INSERT INTO activity_log (user_id, action, type, description, created_at)
                    VALUES ($1, $2, $3, $4, NOW())`,
                    [userId, 'investment', 'investment', `Invested $${amount} in ${planData.name}`]);
    req.flash('success', 'Investment created successfully!');
    res.redirect('/dashboard/investments');
  } catch (error) {
    console.error('Investment error:', error);
    req.flash('error', 'Investment failed: ' + error.message);
    res.redirect('/dashboard/new-investment');
  }
});

// ==================== ACTIVE PLANS ====================
router.get('/active-plans', async (req, res) => {
  try {
    const userId = req.session.userId;
    const user = await db.query('SELECT id, first_name, last_name, email, balance, currency FROM users WHERE id = $1', [userId]);
    const activePlans = await db.query(`
      SELECT i.*, p.name as plan_name, p.roi_percent, p.duration_months
      FROM investments i JOIN plans p ON i.plan_id = p.id
      WHERE i.user_id = $1 AND i.status = 'active'
      ORDER BY i.end_date ASC
    `, [userId]);
    res.render('dashboard/active-plans', { 
      title: 'Active Plans', 
      user: user?.rows[0] || null, 
      activePlans: activePlans?.rows || [] 
    });
  } catch (error) {
    console.error('Active plans error:', error);
    res.render('dashboard/active-plans', { title: 'Active Plans', user: null, activePlans: [] });
  }
});

// ==================== DEPOSITS (GET) ====================
router.get('/deposits', async (req, res) => {
  try {
    const userId = req.session.userId;
    const user = await db.query('SELECT id, first_name, last_name, email, balance, currency FROM users WHERE id = $1', [userId]);
    const deposits = await db.query('SELECT * FROM deposits WHERE user_id = $1 ORDER BY created_at DESC', [userId]);
    const walletAddresses = { BTC: 'bc1qtpfcvuvt2nm6dastam8rnmt1m8v7tun9aacjup', ETH: '0xf9d5388984dBE9B79c717436e1f548fD58438692', SOL: 'CVfsT2QwoJRNLrLkAvvmBEshDS2L4CrcfduYZAa5NaW6' };
    res.render('dashboard/deposits', { 
      title: 'Deposits', 
      user: user?.rows[0] || null, 
      deposits: deposits?.rows || [], 
      walletAddresses 
    });
  } catch (error) {
    console.error('Deposits error:', error);
    res.render('dashboard/deposits', { title: 'Deposits', user: null, deposits: [], walletAddresses: {} });
  }
});

// ==================== DEPOSITS (POST) - FULLY WORKING ====================
router.post('/deposits', 
  depositUpload.fields([
    { name: 'proof', maxCount: 1 },
    { name: 'gift_card_file', maxCount: 1 }
  ]),
  async (req, res) => {
    try {
      const userId = req.session.userId;
      const { amount, method, notes, gift_card_code, crypto_address, deposit_type } = req.body;
      
      console.log('=== DEPOSIT SUBMISSION ===');
      console.log('Files received:', req.files);
      console.log('Body received:', req.body);

      const amt = parseFloat(amount);
      if (!amt || amt <= 0) {
        req.flash('error', 'Please enter a valid amount');
        return res.redirect('/dashboard/deposits');
      }

      let proofFile = null;
      let giftCardFile = null;
      
      if (req.files) {
        if (req.files.proof && req.files.proof[0]) {
          proofFile = req.files.proof[0].filename;
        }
        if (req.files.gift_card_file && req.files.gift_card_file[0]) {
          giftCardFile = req.files.gift_card_file[0].filename;
        }
      }

      const isGiftCard = method === 'gift_card' || deposit_type === 'giftcard';

      // Insert with all columns - PostgreSQL syntax
      await db.query(
        `INSERT INTO deposits 
         (user_id, amount, method, proof_path, gift_card_code, gift_card_file, 
          deposit_type, notes, status, created_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'pending', NOW())`,
        [
          userId, 
          amt, 
          method || 'bank_transfer', 
          proofFile || giftCardFile,
          isGiftCard ? gift_card_code : null,
          giftCardFile,
          isGiftCard ? 'giftcard' : 'deposit',
          notes || ''
        ]
      );

      // Create notification
      await db.query(
        `INSERT INTO notifications (user_id, title, message, is_read, created_at)
         VALUES ($1, $2, $3, $4, NOW())`,
        [userId, 'Deposit Requested', `Your ${isGiftCard ? 'gift card' : 'deposit'} of $${amt} is pending confirmation.`, 0]
      );

      // Log activity
      await db.query(
        `INSERT INTO activity_log (user_id, action, type, description, created_at)
         VALUES ($1, $2, $3, $4, NOW())`,
        [userId, 'deposit_request', 'deposit', `Requested ${isGiftCard ? 'gift card' : 'deposit'} of $${amt}`]
      );

      req.flash('success', 'Deposit request submitted successfully!');
      res.redirect('/dashboard/deposits');

    } catch (error) {
      console.error('Deposit error:', error);
      
      // Clean up uploaded files if database insert fails
      if (req.files) {
        Object.keys(req.files).forEach(key => {
          req.files[key].forEach(file => {
            try {
              fs.unlinkSync(file.path);
            } catch (e) {
              console.error('Error deleting file:', e);
            }
          });
        });
      }
      
      req.flash('error', 'Failed to submit deposit: ' + error.message);
      res.redirect('/dashboard/deposits');
    }
  }
);

// ===== MULTER ERROR HANDLING =====
router.use((err, req, res, next) => {
  if (err instanceof multer.MulterError) {
    console.error('Multer error:', err);
    
    if (err.code === 'LIMIT_FILE_SIZE') {
      req.flash('error', 'File is too large. Maximum size is 5MB.');
    } else if (err.code === 'LIMIT_UNEXPECTED_FILE') {
      req.flash('error', 'Unexpected file field. Please use the correct upload field.');
    } else if (err.code === 'LIMIT_FILE_COUNT') {
      req.flash('error', 'Too many files. Only one file per field is allowed.');
    } else {
      req.flash('error', 'File upload error: ' + err.message);
    }
    return res.redirect('/dashboard/deposits');
  }
  
  if (err) {
    console.error('General error:', err);
    req.flash('error', err.message || 'Something went wrong.');
    return res.redirect('/dashboard/deposits');
  }
  
  next();
});

// ==================== WITHDRAWALS ====================
router.get('/withdrawals', async (req, res) => {
  try {
    const userId = req.session.userId;
    const user = await db.query('SELECT id, first_name, last_name, email, balance, currency FROM users WHERE id = $1', [userId]);
    const withdrawals = await db.query('SELECT * FROM withdrawals WHERE user_id = $1 ORDER BY created_at DESC', [userId]);
    res.render('dashboard/withdrawals', { 
      title: 'Withdrawals', 
      user: user?.rows[0] || null, 
      withdrawals: withdrawals?.rows || [] 
    });
  } catch (error) {
    console.error('Withdrawals error:', error);
    res.status(500).send('Error loading withdrawals');
  }
});

router.post('/withdrawals', async (req, res) => {
  try {
    const userId = req.session.userId;
    const { amount, method, address } = req.body;
    if (!amount || amount <= 0) { req.flash('error', 'Invalid amount'); return res.redirect('/dashboard/withdrawals'); }
    if (!address) { req.flash('error', 'Wallet address required'); return res.redirect('/dashboard/withdrawals'); }

    const user = await db.query('SELECT balance FROM users WHERE id = $1', [userId]);
    if (!user || !user.rows || user.rows.length === 0) {
      req.flash('error', 'User not found');
      return res.redirect('/dashboard/withdrawals');
    }
    
    if (parseFloat(user.rows[0].balance) < parseFloat(amount)) { 
      req.flash('error', 'Insufficient balance'); 
      return res.redirect('/dashboard/withdrawals'); 
    }

    await db.query(`INSERT INTO withdrawals (user_id, amount, method, address, status, created_at)
                    VALUES ($1, $2, $3, $4, 'pending', NOW())`,
                    [userId, amount, method, address]);
    await db.query(`INSERT INTO notifications (user_id, title, message, is_read, created_at)
                    VALUES ($1, $2, $3, $4, NOW())`,
                    [userId, 'Withdrawal Request', `Your withdrawal request of $${amount} is pending approval.`, 0]);
    await db.query(`INSERT INTO activity_log (user_id, action, type, description, created_at)
                    VALUES ($1, $2, $3, $4, NOW())`,
                    [userId, 'withdrawal_request', 'withdrawal', `Requested withdrawal of $${amount} via ${method}`]);
    req.flash('success', 'Withdrawal request submitted successfully!');
    res.redirect('/dashboard/withdrawals');
  } catch (error) {
    console.error('Withdrawal error:', error);
    req.flash('error', 'Failed to request withdrawal: ' + error.message);
    res.redirect('/dashboard/withdrawals');
  }
});

// ==================== TRANSACTIONS ====================
router.get('/transactions', async (req, res) => {
  try {
    const userId = req.session.userId;
    const user = await db.query('SELECT id, first_name, last_name, email, balance, currency FROM users WHERE id = $1', [userId]);
    const transactions = await db.query('SELECT * FROM transactions WHERE user_id = $1 ORDER BY created_at DESC', [userId]);
    res.render('dashboard/transactions', { 
      title: 'Transactions', 
      user: user?.rows[0] || null, 
      transactions: transactions?.rows || [] 
    });
  } catch (error) {
    console.error('Transactions error:', error);
    res.status(500).send('Error loading transactions');
  }
});

// ==================== PROFILE ====================
router.get('/profile', async (req, res) => {
  try {
    const userId = req.session.userId;
    const user = await db.query(
      'SELECT id, first_name, last_name, email, balance, currency, created_at, phone, dob, address, address2, city, state, postal_code, country, kyc_status, referral_code FROM users WHERE id = $1',
      [userId]
    );
    res.render('dashboard/profile', { title: 'Profile', user: user?.rows[0] || null });
  } catch (error) {
    console.error('Profile error:', error);
    res.status(500).send('Error loading profile');
  }
});

// ==================== PROFILE UPDATE (POST) ====================
router.post('/profile/update', async (req, res) => {
  try {
    const userId = req.session.userId;
    const { first_name, last_name, phone, dob, address, address2, city, state, postal_code, country } = req.body;

    await db.query(`
      UPDATE users SET
        first_name = $1, last_name = $2, phone = $3, dob = $4,
        address = $5, address2 = $6, city = $7, state = $8,
        postal_code = $9, country = $10
      WHERE id = $11
    `, [first_name, last_name, phone, dob, address, address2, city, state, postal_code, country, userId]);

    req.flash('success', 'Profile updated successfully');
    res.redirect('/dashboard/profile');
  } catch (error) {
    console.error('Profile update error:', error);
    req.flash('error', 'Failed to update profile: ' + error.message);
    res.redirect('/dashboard/profile');
  }
});

// ==================== CHANGE PASSWORD ====================
router.post('/change-password', async (req, res) => {
  try {
    const userId = req.session.userId;
    const { current_password, new_password, confirm_password } = req.body;

    if (new_password !== confirm_password) {
      req.flash('error', 'New passwords do not match');
      return res.redirect('/dashboard/profile');
    }
    if (new_password.length < 8) {
      req.flash('error', 'Password must be at least 8 characters');
      return res.redirect('/dashboard/profile');
    }

    const user = await db.query('SELECT password FROM users WHERE id = $1', [userId]);
    if (!user || !user.rows || user.rows.length === 0) {
      req.flash('error', 'User not found');
      return res.redirect('/dashboard/profile');
    }

    const valid = await bcrypt.compare(current_password, user.rows[0].password);
    if (!valid) {
      req.flash('error', 'Current password is incorrect');
      return res.redirect('/dashboard/profile');
    }

    const hashed = await bcrypt.hash(new_password, 10);
    await db.query('UPDATE users SET password = $1 WHERE id = $2', [hashed, userId]);

    try {
      await db.query(`
        INSERT INTO activity_log (user_id, action, type, description, created_at)
        VALUES ($1, $2, $3, $4, NOW())
      `, [userId, 'password_change', 'security', 'Changed password']);
    } catch (e) {}

    req.flash('success', 'Password changed successfully');
    res.redirect('/dashboard/profile');
  } catch (error) {
    console.error('Change password error:', error);
    req.flash('error', 'Failed to change password: ' + error.message);
    res.redirect('/dashboard/profile');
  }
});

// ==================== NOTIFICATIONS ====================
router.get('/notifications', async (req, res) => {
  try {
    const userId = req.session.userId;
    if (!userId) return res.redirect('/signin');
    
    const user = await db.query('SELECT id, first_name, last_name, email FROM users WHERE id = $1', [userId]);
    const notifications = await db.query(
      'SELECT * FROM notifications WHERE user_id = $1 ORDER BY created_at DESC',
      [userId]
    );
    res.render('dashboard/notifications', {
      title: 'Notifications',
      user: user?.rows[0] || null,
      notifications: notifications?.rows || []
    });
  } catch (error) {
    console.error('Notifications error:', error);
    res.status(500).send('Error loading notifications');
  }
});

// ==================== MARK ALL AS READ ====================
router.post('/notifications/mark-all-read', async (req, res) => {
  try {
    const userId = req.session.userId;
    if (!userId) {
      return res.status(401).json({ error: 'Not authenticated' });
    }
    
    await db.query(
      'UPDATE notifications SET is_read = 1 WHERE user_id = $1 AND is_read = 0',
      [userId]
    );
    
    res.json({
      success: true,
      message: 'All notifications marked as read'
    });
  } catch (error) {
    console.error('Mark all read error:', error);
    res.status(500).json({
      error: 'Failed to mark all as read: ' + error.message
    });
  }
});

// ==================== LOAD MORE (PAGINATION) ====================
router.get('/notifications/load', async (req, res) => {
  try {
    const userId = req.session.userId;
    if (!userId) {
      return res.status(401).json({ error: 'Not authenticated' });
    }
    
    const page = parseInt(req.query.page) || 1;
    const limit = 20;
    const offset = (page - 1) * limit;
    
    const notifications = await db.query(
      'SELECT * FROM notifications WHERE user_id = $1 ORDER BY created_at DESC LIMIT $2 OFFSET $3',
      [userId, limit, offset]
    );
    
    const total = await db.query(
      'SELECT COUNT(*) as count FROM notifications WHERE user_id = $1',
      [userId]
    );
    
    res.json({
      notifications: notifications?.rows || [],
      total: total?.rows[0]?.count || 0,
      page,
      limit,
      hasMore: (offset + (notifications?.rows?.length || 0)) < (total?.rows[0]?.count || 0)
    });
  } catch (error) {
    console.error('Load notifications error:', error);
    res.status(500).json({ error: 'Failed to load notifications' });
  }
});

// ==================== ACTIVITY LOG ====================
router.get('/activity-log', async (req, res) => {
  try {
    const userId = req.session.userId;
    const user = await db.query('SELECT id, first_name, last_name, email FROM users WHERE id = $1', [userId]);
    const activities = await db.query('SELECT * FROM activity_log WHERE user_id = $1 ORDER BY created_at DESC LIMIT 50', [userId]);
    res.render('dashboard/activity-log', { 
      title: 'Activity Log', 
      user: user?.rows[0] || null, 
      activities: activities?.rows || [] 
    });
  } catch (error) {
    console.error('Activity log error:', error);
    res.status(500).send('Error loading activity log');
  }
});

// ==================== KYC ====================
router.get('/kyc', async (req, res) => {
  try {
    const userId = req.session.userId;
    const user = await db.query('SELECT id, first_name, last_name, email, kyc_status FROM users WHERE id = $1', [userId]);
    res.render('dashboard/kyc', { title: 'KYC Verification', user: user?.rows[0] || null });
  } catch (error) {
    console.error('KYC error:', error);
    res.render('dashboard/kyc', { title: 'KYC Verification', user: null });
  }
});

// KYC SUBMIT (with file upload)
router.post('/kyc/submit', upload.single('front_document'), async (req, res) => {
  try {
    const userId = req.session.userId;
    if (!req.file) {
      req.flash('error', 'Please upload a document');
      return res.redirect('/dashboard/kyc');
    }
    await db.query('UPDATE users SET kyc_status = $1, kyc_doc = $2 WHERE id = $3', ['pending', req.file.filename, userId]);
    req.flash('success', 'KYC submitted for review');
    res.redirect('/dashboard/kyc');
  } catch (error) {
    console.error('KYC submit error:', error);
    req.flash('error', 'Failed to submit KYC: ' + error.message);
    res.redirect('/dashboard/kyc');
  }
});

// ==================== CALCULATOR ====================
router.get('/calculator', async (req, res) => {
  try {
    const userId = req.session.userId;
    const user = await db.query('SELECT id, first_name, last_name, email, balance, currency FROM users WHERE id = $1', [userId]);
    const plans = await db.query('SELECT * FROM plans WHERE is_active = 1 ORDER BY min_amount ASC');
    res.render('dashboard/calculator', { 
      title: 'Investment Calculator', 
      user: user?.rows[0] || null, 
      plans: plans?.rows || [] 
    });
  } catch (error) {
    console.error('Calculator error:', error);
    res.render('dashboard/calculator', { title: 'Investment Calculator', user: null, plans: [] });
  }
});

// ==================== API ROUTES ====================
router.put('/api/user/profile', async (req, res) => {
  try {
    const userId = req.session.userId;
    const { first_name, last_name } = req.body;
    await db.query('UPDATE users SET first_name = $1, last_name = $2 WHERE id = $3', [first_name, last_name, userId]);
    await db.query('INSERT INTO activity_log (user_id, action, type, description, created_at) VALUES ($1, $2, $3, $4, NOW())', [userId, 'profile_update', 'profile', 'Updated profile information']);
    res.json({ success: true });
  } catch (error) {
    console.error('Profile update error:', error);
    res.status(500).json({ error: 'Failed to update profile' });
  }
});

router.post('/api/user/change-password', async (req, res) => {
  try {
    const userId = req.session.userId;
    const { current_password, new_password } = req.body;
    const user = await db.query('SELECT password FROM users WHERE id = $1', [userId]);
    if (!user || !user.rows || user.rows.length === 0) return res.status(404).json({ message: 'User not found' });
    const validPassword = await bcrypt.compare(current_password, user.rows[0].password);
    if (!validPassword) return res.status(400).json({ message: 'Current password is incorrect' });
    const hashedPassword = await bcrypt.hash(new_password, 10);
    await db.query('UPDATE users SET password = $1 WHERE id = $2', [hashedPassword, userId]);
    await db.query('INSERT INTO activity_log (user_id, action, type, description, created_at) VALUES ($1, $2, $3, $4, NOW())', [userId, 'password_change', 'security', 'Changed password']);
    res.json({ success: true, message: 'Password changed successfully' });
  } catch (error) {
    console.error('Password change error:', error);
    res.status(500).json({ error: 'Failed to change password' });
  }
});

router.post('/notifications/:id/read', async (req, res) => {
  try {
    const notificationId = req.params.id;
    const userId = req.session.userId;
    await db.query('UPDATE notifications SET is_read = 1 WHERE id = $1 AND user_id = $2', [notificationId, userId]);
    res.json({ success: true });
  } catch (error) {
    console.error('Mark read error:', error);
    res.status(500).json({ error: 'Failed to mark notification as read' });
  }
});

module.exports = router;
