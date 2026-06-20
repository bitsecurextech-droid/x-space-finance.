const rateLimit = require('express-rate-limit');

const createLimiter = (windowMs, max, message, skipSuccessful = false) => {
  return rateLimit({
    windowMs,
    max,
    message: { success: false, error: message },
    standardHeaders: true,
    legacyHeaders: false,
    skipSuccessfulRequests: skipSuccessful,
    keyGenerator: (req) => {
      return req.session?.userId || req.ip;
    },
    handler: (req, res, next, options) => {
      res.status(429).json({
        success: false,
        error: options.message.error,
        retryAfter: Math.ceil(options.windowMs / 1000)
      });
    }
  });
};

const rateLimits = {
  extreme: createLimiter(60 * 1000, 5, 'Too many attempts. Please wait 1 minute.', true),
  strict: createLimiter(60 * 1000, 15, 'Rate limit exceeded. Please slow down.', false),
  moderate: createLimiter(60 * 1000, 30, 'Too many requests. Please wait a moment.', false),
  generous: createLimiter(60 * 1000, 100, 'Request limit reached. Try again shortly.', false),
  public: createLimiter(60 * 1000, 300, 'Please reduce request frequency.', false),
  login: createLimiter(15 * 60 * 1000, 5, 'Too many login attempts. Try again after 15 minutes.', true),
  registration: createLimiter(60 * 60 * 1000, 3, 'Too many registration attempts. Try again after an hour.', true),
  withdrawal: createLimiter(60 * 60 * 1000, 3, 'Withdrawal limit reached. Please try again later.', false),
  deposit: createLimiter(60 * 60 * 1000, 5, 'Deposit limit reached. Please wait.', false),
};

module.exports = { rateLimits, createLimiter };