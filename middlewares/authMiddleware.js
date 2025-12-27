/**
 * Authentication Middleware
 * Validates Bearer token from Authorization header
 */

export function authMiddleware(req, res, next) {
  const authHeader = req.headers.authorization;

  // Check if Authorization header is present
  if (!authHeader) {
    return res.status(401).json({
      success: false,
      error: 'Authentication required',
      message: 'Missing Authorization header'
    });
  }

  // Validate format: "Bearer <token>"
  const parts = authHeader.split(' ');
  if (parts.length !== 2 || parts[0].toLowerCase() !== 'bearer') {
    return res.status(401).json({
      success: false,
      error: 'Invalid token format',
      message: 'Expected: Authorization: Bearer <token>'
    });
  }

  const token = parts[1].trim();
  const validToken = process.env.API_TOKEN;

  // Check if API_TOKEN is configured
  if (!validToken) {
    console.error('❌ API_TOKEN not configured in environment variables');
    return res.status(503).json({
      success: false,
      error: 'Service unavailable',
      message: 'Authentication service not configured'
    });
  }

  // Validate token
  if (token !== validToken) {
    console.warn(`⚠️  Authentication failed from IP: ${req.ip}`);
    return res.status(401).json({
      success: false,
      error: 'Unauthorized',
      message: 'Invalid API token'
    });
  }

  // Token is valid, proceed
  console.log(`✅ Authenticated request from IP: ${req.ip}`);
  next();
}
