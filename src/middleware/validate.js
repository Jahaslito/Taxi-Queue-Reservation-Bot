const { validationResult } = require('express-validator');

/**
 * Reads the result of express-validator checks that ran before this middleware.
 * On failure, forwards the first error message to the centralised error handler.
 */
function validate(req, res, next) {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    const err = new Error(errors.array()[0].msg);
    err.statusCode = 400;
    return next(err);
  }
  next();
}

module.exports = validate;
