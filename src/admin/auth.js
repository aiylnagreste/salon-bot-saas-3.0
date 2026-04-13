function requireAdminAuth(req, res, next) {
  const session = req.headers['x-admin-token'] || req.cookies?.adminToken;

  // Cookie-based session check
  if (session && session === process.env.ADMIN_SESSION_SECRET) {
    return next();
  }

  // Show login page if not authenticated
  res.status(401).send(`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Admin Login — Salon Bot</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
           background: #f8f4f0; display: flex; align-items: center;
           justify-content: center; min-height: 100vh; }
    .card { background: #fff; border-radius: 12px; padding: 40px;
            box-shadow: 0 4px 20px rgba(0,0,0,0.1); width: 100%; max-width: 380px; }
    h1 { color: #8b4a6b; margin-bottom: 8px; font-size: 1.5rem; }
    p { color: #888; margin-bottom: 24px; font-size: 0.9rem; }
    input { width: 100%; padding: 12px 16px; border: 2px solid #e8e0f0;
            border-radius: 8px; font-size: 1rem; margin-bottom: 16px;
            outline: none; transition: border-color 0.2s; }
    input:focus { border-color: #8b4a6b; }
    button { width: 100%; padding: 12px; background: #8b4a6b; color: #fff;
             border: none; border-radius: 8px; font-size: 1rem;
             cursor: pointer; font-weight: 600; transition: background 0.2s; }
    button:hover { background: #7a3f5e; }
    .error { color: #e74c3c; font-size: 0.85rem; margin-top: 8px; }
  </style>
</head>
<body>
  <div class="card">
    <h1>💅 Salon Admin</h1>
    <p>Enter your password to manage deals and services.</p>
    <form method="POST" action="/salon-admin/login">
      <input type="password" name="password" placeholder="Admin password" required autofocus>
      <button type="submit">Login</button>
    </form>
  </div>
</body>
</html>`);
}

module.exports = { requireAdminAuth };
