// Role hierarchy: viewer < operator < admin.
// requireRole(['operator', 'admin']) allows either of those roles through.
function requireRole(allowedRoles) {
  return (req, res, next) => {
    const role = req.session && req.session.role;
    if (!role) return res.status(401).json({ error: 'Not authenticated' });
    if (!allowedRoles.includes(role)) {
      return res.status(403).json({ error: `This action requires one of these roles: ${allowedRoles.join(', ')}` });
    }
    next();
  };
}

module.exports = { requireRole };
