// Public health responses must not disclose database hosts, schema names, or provider errors.
function safeHealthDiagnostic(error, reachable, configured) {
  if (!configured) return 'Backend is not configured';
  if (reachable && !error) return null;
  return 'Database connectivity check failed';
}

module.exports = { safeHealthDiagnostic };
