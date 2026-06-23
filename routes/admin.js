const express = require('express');
const router = express.Router();
const bcrypt = require('bcrypt');
const db = require('../config/database');
const fs = require('fs');
const path = require('path');

// ==================== ADMIN MIDDLEWARE ====================
router.use(async (req, res, next) => {
  if (!req.session.userId) {
    return res.redirect('/signin');
  }
  try {
    const user = await db.get(
      'SELECT is_admin FROM users WHERE id = $1',
      [req.session.userId]
    );
    if (!user || user.is_admin !== 1) {
      return res.status(403).send('Access denied. Admin only.');
    }
    next();
  } catch (error) {
    console.error('Admin check error:', error);
    res.status(500).send('Server error');
  }
});

// ==================== DASHBOARD ====================
router.get('/', async (req, res) => {
  try {
    const adminUser = await db.get('SELECT id, first_name, last_name, email, is_admin FROM users WHERE id = $1', [req.session.userId]);
    
    const totalUsers = await db.get('SELECT COUNT(*) as count FROM users');
    const pendingDeposits = await db.get('SELECT COUNT(*) as count, COALESCE(SUM(amount),0) as total FROM deposits WHERE status = $1', ['pending']);
    const pendingWithdrawals = await db.get('SELECT COUNT(*) as count, COALESCE(SUM(amount),0) as total FROM withdrawals WHERE status = $1', ['pending']);
    const pendingKYC = await db.get('SELECT COUNT(*) as count FROM users WHERE kyc_status = $1 AND kyc_doc IS NOT NULL', ['pending']);
    const totalInvested = await db.get('SELECT COALESCE(SUM(amount),0) as total FROM investments WHERE status = $1', ['active']);
    const totalPaid = await db.get('SELECT COALESCE(SUM(amount),0) as total FROM transactions WHERE type IN ($1, $2)', ['roi', 'profit']);
    
    const recentUsers = await db.all('SELECT id, first_name, last_name, email, balance, created_at, kyc_status, is_banned FROM users ORDER BY created_at DESC LIMIT 10');
    const recentDeposits = await db.all('SELECT d.*, u.first_name, u.last_name FROM deposits d JOIN users u ON d.user_id = u.id ORDER BY d.created_at DESC LIMIT 10');
    
    recentUsers.forEach(user => {
      user.balance = parseFloat(user.balance) || 0;
    });
    
    res.render('admin/dashboard', { 
      title: 'Admin Dashboard', 
      currentPage: 'dashboard',
      admin: adminUser,
      stats: { 
        total_users: totalUsers?.count || 0, 
        pending_deposits_count: pendingDeposits?.count || 0, 
        pending_deposits_total: parseFloat(pendingDeposits?.total) || 0, 
        pending_withdrawals_count: pendingWithdrawals?.count || 0, 
        pending_withdrawals_total: parseFloat(pendingWithdrawals?.total) || 0, 
        pending_kyc: pendingKYC?.count || 0, 
        total_invested: parseFloat(totalInvested?.total) || 0, 
        total_paid: parseFloat(totalPaid?.total) || 0 
      }, 
      recent_users: recentUsers || [], 
      recent_deposits: recentDeposits || [] 
    });
  } catch (error) { 
    console.error('Admin dashboard error:', error); 
    res.status(500).send('Error loading admin dashboard: ' + error.message); 
  }
});

// ==================== USER MANAGEMENT ====================
router.get('/users', async (req, res) => {
  try {
    const adminUser = await db.get('SELECT id, first_name, last_name, email, is_admin FROM users WHERE id = $1', [req.session.userId]);
    const users = await db.all('SELECT id, first_name, last_name, email, balance, currency, kyc_status, is_admin, is_banned, created_at FROM users ORDER BY created_at DESC');
    
    users.forEach(user => {
      user.balance = parseFloat(user.balance) || 0;
    });
    
    res.render('admin/users', { 
      title: 'Manage Users', 
      currentPage: 'users',
      admin: adminUser, 
      users: users || [] 
    });
  } catch (error) { 
    console.error('Users error:', error); 
    req.flash('error', 'Error loading users: ' + error.message);
    res.redirect('/admin');
  }
});

// ==================== USER DETAIL ====================
router.get('/user/:id', async (req, res) => {
  try {
    const admin = await db.get('SELECT id, first_name, last_name, email, is_admin FROM users WHERE id = $1', [req.session.userId]);
    const targetUser = await db.get('SELECT * FROM users WHERE id = $1', [req.params.id]);
    
    if (!targetUser) {
      req.flash('error', 'User not found');
      return res.redirect('/admin/users');
    }
    
    targetUser.realized = parseFloat(targetUser.realized) || 0;
    targetUser.balance = parseFloat(targetUser.balance) || 0;
    
    const investments = await db.all(`
      SELECT i.*, p.name as plan_name 
      FROM investments i 
      JOIN plans p ON i.plan_id = p.id 
      WHERE i.user_id = $1 
      ORDER BY i.created_at DESC
    `, [targetUser.id]);
    
    const transactions = await db.all(`
      SELECT * FROM transactions 
      WHERE user_id = $1 
      ORDER BY created_at DESC 
      LIMIT 50
    `, [targetUser.id]);
    
    const deposits = await db.all(`
      SELECT * FROM deposits 
      WHERE user_id = $1 
      ORDER BY created_at DESC
    `, [targetUser.id]);
    
    const withdrawals = await db.all(`
      SELECT * FROM withdrawals 
      WHERE user_id = $1 
      ORDER BY created_at DESC
    `, [targetUser.id]);
    
    const plans = await db.all(`
      SELECT * FROM plans 
      WHERE is_active = true 
      ORDER BY duration_days ASC
    `, []);
    
    res.render('admin/user-detail', { 
      title: 'User Details', 
      currentPage: 'users',
      admin: admin, 
      targetUser: targetUser, 
      investments: investments || [], 
      transactions: transactions || [],
      deposits: deposits || [],
      withdrawals: withdrawals || [],
      plans: plans || []
    });
  } catch (error) { 
    console.error('User detail error:', error); 
    req.flash('error', 'Error loading user details: ' + error.message);
    res.redirect('/admin/users');
  }
});

// ==================== UPDATE USER BALANCE ====================
router.post('/user/:id/balance', async (req, res) => {
  try {
    const { amount, reason } = req.body;
    const userId = req.params.id;
    const delta = parseFloat(amount);
    const user = await db.get('SELECT balance FROM users WHERE id = $1', [userId]);
    const newBalance = (parseFloat(user.balance) || 0) + delta;
    
    let finalReason = (reason && reason.trim()) ? reason.trim() : (delta >= 0 ? 'Credit' : 'Debit');
    let txType = delta >= 0 ? 'credit' : 'debit';
    const reasonLower = finalReason.toLowerCase();
    if (reasonLower.includes('bonus')) txType = 'bonus';
    else if (reasonLower.includes('tax')) txType = 'tax';
    else if (reasonLower.includes('investment')) txType = 'investment';
    else if (reasonLower.includes('loan')) txType = 'loan';
    else if (reasonLower.includes('deposit')) txType = 'deposit';
    else if (reasonLower.includes('withdrawal')) txType = 'withdrawal';
    else if (reasonLower.includes('fee')) txType = 'fee';
    else if (reasonLower.includes('profit')) txType = 'profit';
    else if (reasonLower.includes('referral')) txType = 'referral';
    
    await db.query('BEGIN');
    await db.query('UPDATE users SET balance = $1 WHERE id = $2', [newBalance, userId]);
    await db.query(`
      INSERT INTO transactions (user_id, type, amount, balance_after, description, created_at)
      VALUES ($1, $2, $3, $4, $5, NOW())
    `, [userId, txType, delta, newBalance, finalReason]);
    await db.query('COMMIT');
    
    req.flash('success', 'Balance updated successfully');
    res.redirect(`/admin/user/${userId}`);
  } catch (error) { 
    console.error('Balance update error:', error); 
    await db.query('ROLLBACK'); 
    req.flash('error', 'Error updating balance: ' + error.message);
    res.redirect(`/admin/user/${req.params.id}`);
  }
});

// ==================== UPDATE REALIZED BALANCE ====================
router.post('/user/:id/realized', async (req, res) => {
  try {
    const userId = req.params.id;
    const { amount, reason } = req.body;
    const delta = parseFloat(amount);
    
    if (isNaN(delta)) {
      return res.status(400).json({ success: false, error: 'Invalid amount' });
    }
    
    const user = await db.get('SELECT realized FROM users WHERE id = $1', [userId]);
    const currentRealized = parseFloat(user.realized) || 0;
    const newRealized = currentRealized + delta;
    
    await db.query('UPDATE users SET realized = $1 WHERE id = $2', [newRealized, userId]);
    await db.query(`
      INSERT INTO transactions (user_id, type, amount, description, created_at)
      VALUES ($1, 'realized', $2, $3, NOW())
    `, [userId, delta, reason || 'Admin adjusted realized']);
    
    const sign = delta >= 0 ? '+' : '';
    await db.query(`
      INSERT INTO notifications (user_id, title, message, is_read, type, created_at)
      VALUES ($1, 'Realized Updated', $2, false, 'realized', NOW())
    `, [userId, `Your realized balance has been adjusted by ${sign}$${Math.abs(delta).toFixed(2)}. Reason: ${reason || 'Admin adjustment'}`]);
    
    res.json({ success: true, newRealized });
  } catch (error) {
    console.error('Update realized error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// ==================== TOGGLE USER BAN ====================
router.post('/user/:id/toggle-ban', async (req, res) => {
  try {
    const userId = req.params.id;
    const user = await db.get('SELECT is_banned FROM users WHERE id = $1', [userId]);
    const newStatus = user.is_banned ? 0 : 1;
    await db.query('UPDATE users SET is_banned = $1 WHERE id = $2', [newStatus, userId]);
    
    req.flash('success', user.is_banned ? 'User unbanned' : 'User banned');
    res.redirect(`/admin/user/${userId}`);
  } catch (error) { 
    console.error('Toggle ban error:', error); 
    req.flash('error', 'Error toggling ban: ' + error.message);
    res.redirect(`/admin/user/${req.params.id}`);
  }
});

// ==================== TOGGLE ADMIN ROLE ====================
router.post('/user/:id/toggle-admin', async (req, res) => {
  try {
    const userId = req.params.id;
    if (parseInt(userId) === req.session.userId) {
      req.flash('error', 'Cannot change your own admin status');
      return res.redirect(`/admin/user/${userId}`);
    }
    const user = await db.get('SELECT is_admin FROM users WHERE id = $1', [userId]);
    const newStatus = user.is_admin ? 0 : 1;
    await db.query('UPDATE users SET is_admin = $1 WHERE id = $2', [newStatus, userId]);
    
    req.flash('success', user.is_admin ? 'Admin rights removed' : 'Admin rights granted');
    res.redirect(`/admin/user/${userId}`);
  } catch (error) { 
    console.error('Toggle admin error:', error); 
    req.flash('error', 'Error toggling admin: ' + error.message);
    res.redirect(`/admin/user/${req.params.id}`);
  }
});

// ==================== APPROVE USER KYC ====================
router.post('/user/:id/kyc-approve', async (req, res) => {
  try {
    await db.query('UPDATE users SET kyc_status = $1 WHERE id = $2', ['approved', req.params.id]);
    req.flash('success', 'KYC approved');
    res.redirect(`/admin/user/${req.params.id}`);
  } catch (error) { 
    console.error('KYC approve error:', error); 
    req.flash('error', 'Error approving KYC: ' + error.message);
    res.redirect(`/admin/user/${req.params.id}`);
  }
});

// ==================== REVERSE TRANSACTION ====================
router.post('/user/:id/reverse-transaction', async (req, res) => {
  try {
    const { tx_id, amount } = req.body;
    const userId = req.params.id;
    const user = await db.get('SELECT balance FROM users WHERE id = $1', [userId]);
    const newBalance = (parseFloat(user.balance) || 0) + (amount > 0 ? -amount : Math.abs(amount));
    await db.query('UPDATE users SET balance = $1 WHERE id = $2', [newBalance, userId]);
    await db.query('INSERT INTO transactions (user_id, type, amount, balance_after, description, created_at) VALUES ($1, $2, $3, $4, $5, NOW())', [userId, 'reversal', amount > 0 ? -amount : Math.abs(amount), newBalance, 'Transaction reversal']);
    res.json({ success: true });
  } catch (error) { 
    res.status(500).json({ error: error.message }); 
  }
});

// ==================== MANUAL DEPOSIT ====================
router.post('/user/:id/manual-deposit', async (req, res) => {
  try {
    const { amount, method, tx_hash } = req.body;
    const userId = req.params.id;
    const user = await db.get('SELECT balance FROM users WHERE id = $1', [userId]);
    const newBalance = (parseFloat(user.balance) || 0) + parseFloat(amount);
    await db.query('INSERT INTO deposits (user_id, amount, method, tx_hash, status, created_at) VALUES ($1, $2, $3, $4, $5, NOW())', [userId, amount, method, tx_hash, 'approved']);
    await db.query('UPDATE users SET balance = $1 WHERE id = $2', [newBalance, userId]);
    await db.query('INSERT INTO transactions (user_id, type, amount, balance_after, description, created_at) VALUES ($1, $2, $3, $4, $5, NOW())', [userId, 'deposit', amount, newBalance, `Manual deposit via ${method}`]);
    res.json({ success: true });
  } catch (error) { 
    res.status(500).json({ error: error.message }); 
  }
});

// ==================== MANUAL WITHDRAWAL ====================
router.post('/user/:id/manual-withdrawal', async (req, res) => {
  try {
    const { amount, method, address } = req.body;
    const userId = req.params.id;
    const user = await db.get('SELECT balance FROM users WHERE id = $1', [userId]);
    if ((parseFloat(user.balance) || 0) < amount) return res.status(400).json({ error: 'Insufficient balance' });
    const newBalance = (parseFloat(user.balance) || 0) - parseFloat(amount);
    await db.query('INSERT INTO withdrawals (user_id, amount, method, address, status, created_at) VALUES ($1, $2, $3, $4, $5, NOW())', [userId, amount, method, address, 'completed']);
    await db.query('UPDATE users SET balance = $1 WHERE id = $2', [newBalance, userId]);
    await db.query('INSERT INTO transactions (user_id, type, amount, balance_after, description, created_at) VALUES ($1, $2, $3, $4, $5, NOW())', [userId, 'withdrawal', -amount, newBalance, `Manual withdrawal via ${method}`]);
    res.json({ success: true });
  } catch (error) { 
    res.status(500).json({ error: error.message }); 
  }
});

// ==================== MANUAL INVESTMENT ====================
router.post('/user/:id/manual-investment', async (req, res) => {
  try {
    const { plan_id, amount } = req.body;
    const userId = req.params.id;
    const plan = await db.get('SELECT * FROM plans WHERE id = $1', [plan_id]);
    const user = await db.get('SELECT balance FROM users WHERE id = $1', [userId]);
    if ((parseFloat(user.balance) || 0) < amount) return res.status(400).json({ error: 'Insufficient balance' });
    const startDate = new Date();
    const endDate = new Date(startDate.getTime() + plan.duration_days * 86400000);
    const newBalance = (parseFloat(user.balance) || 0) - parseFloat(amount);
    await db.query('INSERT INTO investments (user_id, plan_id, amount, current_value, start_date, end_date, status, created_at) VALUES ($1, $2, $3, $4, $5, $6, $7, NOW())', [userId, plan_id, amount, amount, startDate.toISOString(), endDate.toISOString(), 'active']);
    await db.query('UPDATE users SET balance = $1 WHERE id = $2', [newBalance, userId]);
    await db.query('INSERT INTO transactions (user_id, type, amount, balance_after, description, created_at) VALUES ($1, $2, $3, $4, $5, NOW())', [userId, 'investment', -amount, newBalance, `Manual investment in ${plan.name}`]);
    res.json({ success: true });
  } catch (error) { 
    res.status(500).json({ error: error.message }); 
  }
});

// ==================== MATURE INVESTMENT ====================
router.post('/investment/:id/mature', async (req, res) => {
  try {
    await db.query('UPDATE investments SET status = $1 WHERE id = $2', ['matured', req.params.id]);
    res.json({ success: true });
  } catch (error) { 
    res.status(500).json({ error: error.message }); 
  }
});

// ==================== DELETE INVESTMENT ====================
router.post('/investment/:id/delete', async (req, res) => {
  try {
    await db.query('DELETE FROM investments WHERE id = $1', [req.params.id]);
    res.json({ success: true });
  } catch (error) { 
    res.status(500).json({ error: error.message }); 
  }
});

// ==================== UPDATE PROFILE ====================
router.post('/user/:id/update-profile', async (req, res) => {
  try {
    const { first_name, last_name, email, country, currency, phone } = req.body;
    await db.query('UPDATE users SET first_name = $1, last_name = $2, email = $3, country = $4, currency = $5, phone = $6 WHERE id = $7', [first_name, last_name, email, country, currency, phone, req.params.id]);
    res.json({ success: true });
  } catch (error) { 
    res.status(500).json({ error: error.message }); 
  }
});

// ==================== RESET PASSWORD ====================
router.post('/user/:id/reset-password', async (req, res) => {
  try {
    const { password } = req.body;
    const hashedPassword = await bcrypt.hash(password, 10);
    await db.query('UPDATE users SET password = $1 WHERE id = $2', [hashedPassword, req.params.id]);
    res.json({ success: true });
  } catch (error) { 
    res.status(500).json({ error: error.message }); 
  }
});

// ==================== DELETE USER ====================
router.post('/user/:id/delete', async (req, res) => {
  try {
    const userId = req.params.id;
    if (parseInt(userId) === req.session.userId) {
      req.flash('error', 'Cannot delete your own account');
      return res.redirect('/admin/users');
    }
    await db.query('DELETE FROM users WHERE id = $1', [userId]);
    req.flash('success', 'User deleted successfully');
    res.redirect('/admin/users');
  } catch (error) { 
    console.error('User delete error:', error);
    req.flash('error', 'Failed to delete user');
    res.redirect('/admin/users');
  }
});

// ==================== EXPORT USER TRANSACTIONS ====================
router.get('/user/:id/export-transactions', async (req, res) => {
  try {
    const transactions = await db.all('SELECT * FROM transactions WHERE user_id = $1 ORDER BY created_at DESC', [req.params.id]);
    let csv = 'Date,Type,Amount,Balance After,Description\n';
    transactions.forEach(t => { 
      csv += `${t.created_at},${t.type},${t.amount},${t.balance_after || ''},"${t.description || ''}"\n`; 
    });
    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', `attachment; filename=user_${req.params.id}_transactions.csv`);
    res.send(csv);
  } catch (error) { 
    res.status(500).send('Error exporting transactions'); 
  }
});

// ==================== DEPOSIT MANAGEMENT ====================
router.get('/deposits', async (req, res) => {
  try {
    const adminUser = await db.get('SELECT id, first_name, last_name, email, is_admin FROM users WHERE id = $1', [req.session.userId]);
    const deposits = await db.all('SELECT d.*, u.first_name, u.last_name, u.email FROM deposits d JOIN users u ON d.user_id = u.id ORDER BY d.created_at DESC');
    res.render('admin/deposits', { 
      title: 'Manage Deposits', 
      currentPage: 'deposits',
      admin: adminUser, 
      deposits: deposits || [] 
    });
  } catch (error) { 
    console.error('Deposits error:', error); 
    req.flash('error', 'Error loading deposits: ' + error.message);
    res.redirect('/admin');
  }
});

// ==================== DEPOSIT APPROVE - FIXED ====================
router.post('/deposit/:id/approve', async (req, res) => {
  try {
    const depositId = req.params.id;
    const deposit = await db.get('SELECT * FROM deposits WHERE id = $1', [depositId]);
    
    if (!deposit) {
      req.flash('error', 'Deposit not found');
      return res.redirect('/admin/deposits');
    }
    
    if (deposit.status !== 'pending') {
      req.flash('error', 'Deposit already processed');
      return res.redirect('/admin/deposits');
    }
    
    const user = await db.get('SELECT balance FROM users WHERE id = $1', [deposit.user_id]);
    const currentBalance = parseFloat(user.balance) || 0;
    const newBalance = currentBalance + parseFloat(deposit.amount);
    
    await db.query('BEGIN');
    
    // Update deposit status
    await db.query(
      'UPDATE deposits SET status = $1, processed_at = NOW() WHERE id = $2',
      ['approved', depositId]
    );
    
    // Update user balance
    await db.query(
      'UPDATE users SET balance = $1 WHERE id = $2',
      [newBalance, deposit.user_id]
    );
    
    // Insert transaction with balance_after
    await db.query(`
      INSERT INTO transactions 
      (user_id, type, amount, balance_after, description, status, created_at)
      VALUES ($1, $2, $3, $4, $5, $6, NOW())
    `, [
      deposit.user_id,
      'deposit',
      deposit.amount,
      newBalance,
      `Deposit approved - $${deposit.amount} credited`,
      'completed'
    ]);
    
    // Send notification
    await db.query(`
      INSERT INTO notifications (user_id, title, message, is_read, type, created_at)
      VALUES ($1, $2, $3, false, 'deposit', NOW())
    `, [
      deposit.user_id,
      'Deposit Approved',
      `Your deposit of $${deposit.amount} has been approved and credited to your wallet. New balance: $${newBalance.toFixed(2)}`
    ]);
    
    // Log activity
    await db.query(`
      INSERT INTO activity_log (user_id, action, type, description, created_at)
      VALUES ($1, $2, $3, $4, NOW())
    `, [
      deposit.user_id,
      'deposit_approved',
      'deposit',
      `Deposit of $${deposit.amount} approved by admin`
    ]);
    
    await db.query('COMMIT');
    
    req.flash('success', `Deposit of $${deposit.amount} approved and credited to user`);
    res.redirect('/admin/deposits');
    
  } catch (error) { 
    console.error('Approve deposit error:', error); 
    await db.query('ROLLBACK'); 
    req.flash('error', 'Error approving deposit: ' + error.message);
    res.redirect('/admin/deposits');
  }
});

router.post('/deposit/:id/reject', async (req, res) => {
  try {
    await db.query('UPDATE deposits SET status = $1, processed_at = NOW() WHERE id = $2', ['rejected', req.params.id]);
    req.flash('info', 'Deposit rejected');
    res.redirect('/admin/deposits');
  } catch (error) { 
    console.error('Reject deposit error:', error); 
    req.flash('error', 'Error rejecting deposit: ' + error.message);
    res.redirect('/admin/deposits');
  }
});

router.post('/deposit/:id/delete', async (req, res) => {
  try {
    await db.query('DELETE FROM deposits WHERE id = $1', [req.params.id]);
    res.json({ success: true });
  } catch (error) { 
    res.status(500).json({ error: error.message }); 
  }
});

// ==================== WITHDRAWAL MANAGEMENT ====================
router.get('/withdrawals', async (req, res) => {
  try {
    const adminUser = await db.get('SELECT id, first_name, last_name, email, is_admin FROM users WHERE id = $1', [req.session.userId]);
    const withdrawals = await db.all('SELECT w.*, u.first_name, u.last_name, u.email FROM withdrawals w JOIN users u ON w.user_id = u.id ORDER BY w.created_at DESC');
    res.render('admin/withdrawals', { 
      title: 'Manage Withdrawals', 
      currentPage: 'withdrawals',
      admin: adminUser, 
      withdrawals: withdrawals || [] 
    });
  } catch (error) { 
    console.error('Withdrawals error:', error); 
    req.flash('error', 'Error loading withdrawals: ' + error.message);
    res.redirect('/admin');
  }
});

// ==================== WITHDRAWAL APPROVE - FIXED ====================
router.post('/withdrawal/:id/approve', async (req, res) => {
  try {
    const withdrawalId = req.params.id;
    const withdrawal = await db.get('SELECT * FROM withdrawals WHERE id = $1', [withdrawalId]);
    
    if (!withdrawal) {
      req.flash('error', 'Withdrawal not found');
      return res.redirect('/admin/withdrawals');
    }
    
    if (withdrawal.status !== 'pending') {
      req.flash('error', 'Withdrawal already processed');
      return res.redirect('/admin/withdrawals');
    }
    
    const user = await db.get('SELECT balance FROM users WHERE id = $1', [withdrawal.user_id]);
    const currentBalance = parseFloat(user.balance) || 0;
    
    if (currentBalance < withdrawal.amount) {
      req.flash('error', 'Insufficient balance');
      return res.redirect('/admin/withdrawals');
    }
    
    const newBalance = currentBalance - parseFloat(withdrawal.amount);
    
    await db.query('BEGIN');
    
    // Update withdrawal status
    await db.query(
      'UPDATE withdrawals SET status = $1, processed_at = NOW() WHERE id = $2',
      ['completed', withdrawalId]
    );
    
    // Update user balance
    await db.query(
      'UPDATE users SET balance = $1 WHERE id = $2',
      [newBalance, withdrawal.user_id]
    );
    
    // Insert transaction with balance_after
    await db.query(`
      INSERT INTO transactions 
      (user_id, type, amount, balance_after, description, status, created_at)
      VALUES ($1, $2, $3, $4, $5, $6, NOW())
    `, [
      withdrawal.user_id,
      'withdrawal',
      -withdrawal.amount,
      newBalance,
      `Withdrawal processed - $${withdrawal.amount} debited`,
      'completed'
    ]);
    
    // Send notification
    await db.query(`
      INSERT INTO notifications (user_id, title, message, is_read, type, created_at)
      VALUES ($1, $2, $3, false, 'withdrawal', NOW())
    `, [
      withdrawal.user_id,
      'Withdrawal Processed',
      `Your withdrawal of $${withdrawal.amount} has been processed. New balance: $${newBalance.toFixed(2)}`
    ]);
    
    // Log activity
    await db.query(`
      INSERT INTO activity_log (user_id, action, type, description, created_at)
      VALUES ($1, $2, $3, $4, NOW())
    `, [
      withdrawal.user_id,
      'withdrawal_approved',
      'withdrawal',
      `Withdrawal of $${withdrawal.amount} approved by admin`
    ]);
    
    await db.query('COMMIT');
    
    req.flash('success', `Withdrawal of $${withdrawal.amount} approved`);
    res.redirect('/admin/withdrawals');
    
  } catch (error) { 
    console.error('Approve withdrawal error:', error); 
    await db.query('ROLLBACK'); 
    req.flash('error', 'Error approving withdrawal: ' + error.message);
    res.redirect('/admin/withdrawals');
  }
});

router.post('/withdrawal/:id/reject', async (req, res) => {
  try {
    await db.query('UPDATE withdrawals SET status = $1, processed_at = NOW() WHERE id = $2', ['rejected', req.params.id]);
    req.flash('info', 'Withdrawal rejected');
    res.redirect('/admin/withdrawals');
  } catch (error) { 
    console.error('Reject withdrawal error:', error); 
    req.flash('error', 'Error rejecting withdrawal: ' + error.message);
    res.redirect('/admin/withdrawals');
  }
});

router.post('/withdrawal/:id/delete', async (req, res) => {
  try {
    await db.query('DELETE FROM withdrawals WHERE id = $1', [req.params.id]);
    res.json({ success: true });
  } catch (error) { 
    res.status(500).json({ error: error.message }); 
  }
});

// ==================== PLAN MANAGEMENT ====================
router.get('/plans', async (req, res) => {
  try {
    const adminUser = await db.get('SELECT id, first_name, last_name, email, is_admin FROM users WHERE id = $1', [req.session.userId]);
    const plans = await db.all('SELECT * FROM plans ORDER BY duration_days ASC');
    res.render('admin/plans', { 
      title: 'Manage Plans', 
      currentPage: 'plans',
      admin: adminUser, 
      plans: plans || [] 
    });
  } catch (error) { 
    console.error('Plans error:', error); 
    req.flash('error', 'Error loading plans: ' + error.message);
    res.redirect('/admin');
  }
});

router.post('/plans/create', async (req, res) => {
  try {
    const { name, duration_days, roi_percent, min_amount, max_amount, is_active } = req.body;
    await db.query('INSERT INTO plans (name, duration_days, roi_percent, min_amount, max_amount, is_active) VALUES ($1, $2, $3, $4, $5, $6)', [name, duration_days, roi_percent, min_amount, max_amount, is_active ? 1 : 0]);
    req.flash('success', 'Plan created');
    res.redirect('/admin/plans');
  } catch (error) { 
    console.error('Create plan error:', error); 
    req.flash('error', 'Error creating plan: ' + error.message);
    res.redirect('/admin/plans');
  }
});

router.post('/plans/update', async (req, res) => {
  try {
    const { id, name, duration_days, roi_percent, min_amount, max_amount, is_active } = req.body;
    await db.query('UPDATE plans SET name = $1, duration_days = $2, roi_percent = $3, min_amount = $4, max_amount = $5, is_active = $6 WHERE id = $7', [name, duration_days, roi_percent, min_amount, max_amount, is_active ? 1 : 0, id]);
    req.flash('success', 'Plan updated');
    res.redirect('/admin/plans');
  } catch (error) { 
    console.error('Update plan error:', error); 
    req.flash('error', 'Error updating plan: ' + error.message);
    res.redirect('/admin/plans');
  }
});

// Toggle plan active status
router.post('/plans/:id/toggle', async (req, res) => {
  try {
    const planId = req.params.id;
    const plan = await db.get('SELECT is_active FROM plans WHERE id = $1', [planId]);
    const newStatus = plan.is_active ? 0 : 1;
    await db.query('UPDATE plans SET is_active = $1 WHERE id = $2', [newStatus, planId]);
    req.flash('success', plan.is_active ? 'Plan deactivated' : 'Plan reactivated');
    res.redirect('/admin/plans');
  } catch (error) {
    console.error('Toggle plan error:', error);
    req.flash('error', 'Failed to toggle plan');
    res.redirect('/admin/plans');
  }
});

// ==================== KYC MANAGEMENT ====================
router.get('/kyc', async (req, res) => {
  try {
    const adminUser = await db.get('SELECT id, first_name, last_name, email, is_admin FROM users WHERE id = $1', [req.session.userId]);
    const submissions = await db.all(`
      SELECT id, first_name, last_name, email, kyc_status, kyc_doc, created_at
      FROM users
      WHERE kyc_status IN ('pending', 'approved', 'rejected') OR kyc_doc IS NOT NULL
      ORDER BY created_at DESC
    `);

    res.render('admin/kyc', {
      title: 'KYC Verification',
      currentPage: 'kyc',
      admin: adminUser,
      submissions: submissions || []
    });
  } catch (error) {
    console.error('KYC admin error:', error);
    req.flash('error', 'Error loading KYC: ' + error.message);
    res.redirect('/admin');
  }
});

router.post('/kyc/:id/approve', async (req, res) => {
  try {
    await db.query('UPDATE users SET kyc_status = $1 WHERE id = $2', ['approved', req.params.id]);
    req.flash('success', 'KYC approved');
    res.redirect('/admin/kyc');
  } catch (error) { 
    console.error('KYC approve error:', error); 
    req.flash('error', 'Error approving KYC: ' + error.message);
    res.redirect('/admin/kyc');
  }
});

router.post('/kyc/:id/reject', async (req, res) => {
  try {
    await db.query('UPDATE users SET kyc_status = $1 WHERE id = $2', ['rejected', req.params.id]);
    req.flash('info', 'KYC rejected');
    res.redirect('/admin/kyc');
  } catch (error) { 
    console.error('KYC reject error:', error); 
    req.flash('error', 'Error rejecting KYC: ' + error.message);
    res.redirect('/admin/kyc');
  }
});

router.post('/user/:id/kyc-update', async (req, res) => {
  try {
    const { status } = req.body;
    await db.query('UPDATE users SET kyc_status = $1 WHERE id = $2', [status, req.params.id]);
    res.json({ success: true });
  } catch (error) { 
    res.status(500).json({ error: error.message }); 
  }
});

// ==================== SETTINGS & LOGS ====================
router.get('/settings', async (req, res) => {
  try {
    const adminUser = await db.get('SELECT id, first_name, last_name, email, is_admin FROM users WHERE id = $1', [req.session.userId]);
    res.render('admin/settings', { 
      title: 'Settings', 
      currentPage: 'settings',
      admin: adminUser 
    });
  } catch (error) { 
    console.error('Settings error:', error); 
    req.flash('error', 'Error loading settings: ' + error.message);
    res.redirect('/admin');
  }
});

router.get('/logs', async (req, res) => {
  try {
    const adminUser = await db.get('SELECT id, first_name, last_name, email, is_admin FROM users WHERE id = $1', [req.session.userId]);
    const logs = await db.all('SELECT al.*, u.first_name, u.last_name, u.email FROM activity_log al JOIN users u ON al.user_id = u.id ORDER BY al.created_at DESC LIMIT 100');
    res.render('admin/logs', { 
      title: 'Activity Logs', 
      currentPage: 'logs',
      admin: adminUser, 
      logs: logs || [] 
    });
  } catch (error) { 
    console.error('Logs error:', error); 
    req.flash('error', 'Error loading logs: ' + error.message);
    res.redirect('/admin');
  }
});

// ==================== CLEAR LOGS ====================
router.post('/logs/clear', async (req, res) => {
  try {
    await db.query('DELETE FROM activity_log');
    req.flash('success', 'All logs cleared successfully');
    res.redirect('/admin/logs');
  } catch (error) {
    console.error('Clear logs error:', error);
    req.flash('error', 'Failed to clear logs');
    res.redirect('/admin/logs');
  }
});

// ==================== UPLOADED FILES ====================
router.get('/files', async (req, res) => {
  try {
    const adminUser = await db.get('SELECT id, first_name, last_name, email, is_admin FROM users WHERE id = $1', [req.session.userId]);

    const kycDir = path.join(__dirname, '../public/uploads/kyc');
    const depositDir = path.join(__dirname, '../public/uploads/deposits');
    const giftcardDir = path.join(__dirname, '../public/uploads/giftcards');
    
    const kycFiles = fs.existsSync(kycDir) ? fs.readdirSync(kycDir).map(f => ({ name: f, type: 'kyc', path: '/uploads/kyc/' + f })) : [];
    const depositFiles = fs.existsSync(depositDir) ? fs.readdirSync(depositDir).map(f => ({ name: f, type: 'deposit', path: '/uploads/deposits/' + f })) : [];
    const giftcardFiles = fs.existsSync(giftcardDir) ? fs.readdirSync(giftcardDir).map(f => ({ name: f, type: 'giftcard', path: '/uploads/giftcards/' + f })) : [];

    res.render('admin/files', {
      title: 'Uploaded Files',
      currentPage: 'files',
      admin: adminUser,
      files: [...kycFiles, ...depositFiles, ...giftcardFiles]
    });
  } catch (error) {
    console.error('Files error:', error);
    req.flash('error', 'Error loading files: ' + error.message);
    res.redirect('/admin');
  }
});

// ==================== GIFT CARDS MANAGEMENT ====================
router.get('/giftcards', async (req, res) => {
  try {
    const adminUser = await db.get('SELECT id, first_name, last_name, email, is_admin FROM users WHERE id = $1', [req.session.userId]);
    const giftCards = await db.all(`
      SELECT d.*, u.first_name, u.last_name, u.email 
      FROM deposits d
      JOIN users u ON d.user_id = u.id
      WHERE d.method = 'gift_card' OR d.deposit_type = 'giftcard'
      ORDER BY d.created_at DESC
    `);
    
    res.render('admin/giftcards', { 
      title: 'Gift Cards', 
      currentPage: 'giftcards',
      admin: adminUser, 
      giftCards: giftCards || [] 
    });
  } catch (error) { 
    console.error('Gift cards error:', error); 
    req.flash('error', 'Error loading gift cards: ' + error.message);
    res.redirect('/admin');
  }
});

// ==================== DELETE FILE ====================
router.post('/files/delete', async (req, res) => {
  try {
    const { filePath, fileName, type } = req.body;
    
    if (!filePath || !fileName) {
      return res.status(400).json({ success: false, error: 'Missing file path or name' });
    }

    const fullPath = path.join(__dirname, '..', 'public', filePath);
    
    if (fs.existsSync(fullPath)) {
      fs.unlinkSync(fullPath);
    }

    if (type === 'kyc') {
      await db.query('UPDATE users SET kyc_doc = NULL WHERE kyc_doc = $1', [fileName]);
    }

    res.json({ success: true, message: 'File deleted successfully' });
  } catch (error) {
    console.error('File delete error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// ==================== CHAT MESSAGES ====================
router.get('/chat-messages', async (req, res) => {
  try {
    const adminUser = await db.get('SELECT id, first_name, last_name, email, is_admin FROM users WHERE id = $1', [req.session.userId]);
    const messages = await db.all('SELECT * FROM chat_messages ORDER BY created_at DESC');

    res.render('admin/chat-messages', {
      messages,
      currentPage: 'chat-messages',
      admin: adminUser
    });
  } catch (error) {
    console.error('Chat messages error:', error);
    req.flash('error', 'Error loading chat messages: ' + error.message);
    res.redirect('/admin');
  }
});

module.exports = router;
