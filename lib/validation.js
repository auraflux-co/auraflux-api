/**
 * Input Validation Middleware
 * 
 * Provides reusable validation functions for common request patterns.
 * Use these to validate and sanitize user input before processing.
 */

const { logError } = require('./error_logger');

/**
 * Validate required fields are present in request body
 * @param {string[]} fields - Array of required field names
 * @returns {Function} Express middleware
 */
function requireFields(...fields) {
  return (req, res, next) => {
    const missing = fields.filter(f => !req.body[f]);
    if (missing.length > 0) {
      logError('VALIDATION_MISSING_FIELDS', `Missing required fields: ${missing.join(', ')}`, {
        endpoint: req.path,
        missing
      });
      return res.status(400).json({
        error: `Missing required fields: ${missing.join(', ')}`,
        required: fields,
        missing
      });
    }
    next();
  };
}

/**
 * Validate content type is one of allowed values
 * @param {string[]} allowed - Array of allowed content types
 * @returns {Function} Express middleware
 */
function validateContentType(allowed = ['twitch', 'nba', 'news']) {
  return (req, res, next) => {
    const contentType = req.body.contentType || req.query.contentType;
    if (contentType && !allowed.includes(contentType)) {
      logError('VALIDATION_INVALID_CONTENT_TYPE', `Invalid contentType: ${contentType}`, {
        endpoint: req.path,
        contentType,
        allowed
      });
      return res.status(400).json({
        error: `Invalid contentType. Must be one of: ${allowed.join(', ')}`,
        received: contentType,
        allowed
      });
    }
    next();
  };
}

/**
 * Validate array field has minimum length
 * @param {string} fieldName - Name of array field
 * @param {number} minLength - Minimum required length
 * @returns {Function} Express middleware
 */
function validateArrayLength(fieldName, minLength = 1) {
  return (req, res, next) => {
    const arr = req.body[fieldName];
    if (!Array.isArray(arr) || arr.length < minLength) {
      logError('VALIDATION_ARRAY_LENGTH', `${fieldName} must have at least ${minLength} items`, {
        endpoint: req.path,
        fieldName,
        minLength,
        received: arr ? arr.length : 0
      });
      return res.status(400).json({
        error: `${fieldName} must be an array with at least ${minLength} item(s)`,
        minLength,
        received: arr ? arr.length : 0
      });
    }
    next();
  };
}

/**
 * Validate URL format
 * @param {string} fieldName - Name of URL field
 * @param {boolean} required - Whether field is required
 * @returns {Function} Express middleware
 */
function validateUrl(fieldName, required = true) {
  return (req, res, next) => {
    const url = req.body[fieldName];
    
    if (!url) {
      if (required) {
        return res.status(400).json({ error: `${fieldName} is required` });
      }
      return next();
    }

    try {
      new URL(url);
      next();
    } catch (e) {
      logError('VALIDATION_INVALID_URL', `Invalid URL format for ${fieldName}`, {
        endpoint: req.path,
        fieldName,
        url: url.substring(0, 100)
      });
      return res.status(400).json({
        error: `${fieldName} must be a valid URL`,
        received: url.substring(0, 100)
      });
    }
  };
}

/**
 * Sanitize string input (remove dangerous characters)
 * @param {string[]} fields - Fields to sanitize
 * @returns {Function} Express middleware
 */
function sanitizeStrings(...fields) {
  return (req, res, next) => {
    fields.forEach(field => {
      if (req.body[field] && typeof req.body[field] === 'string') {
        // Remove null bytes, control characters
        req.body[field] = req.body[field]
          .replace(/\0/g, '')
          .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, '')
          .trim();
      }
    });
    next();
  };
}

/**
 * Validate numeric range
 * @param {string} fieldName - Name of numeric field
 * @param {number} min - Minimum value
 * @param {number} max - Maximum value
 * @returns {Function} Express middleware
 */
function validateRange(fieldName, min, max) {
  return (req, res, next) => {
    const value = req.body[fieldName];
    if (value !== undefined) {
      const num = Number(value);
      if (isNaN(num) || num < min || num > max) {
        return res.status(400).json({
          error: `${fieldName} must be a number between ${min} and ${max}`,
          received: value
        });
      }
    }
    next();
  };
}

module.exports = {
  requireFields,
  validateContentType,
  validateArrayLength,
  validateUrl,
  sanitizeStrings,
  validateRange
};
