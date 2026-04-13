// middleware/tenantAuth.js

const jwt = require('jsonwebtoken');
const { getTenantById, isTenantActive } = require('../db/tenantManager');

const JWT_SECRET = process.env.TENANT_JWT_SECRET || "your-super-secret-jwt-key-change-this";

const requireTenantAuth = (req, res, next) => {
    const token = req.cookies.tenantToken;

    if (!token) {
        // Check if this is an API request
        if (req.path.startsWith('/salon-admin/api/')) {
            return res.status(401).json({ error: 'Unauthorized - Please login' });
        }
        return res.redirect('/salon-admin/login');
    }

    try {
        const decoded = jwt.verify(token, JWT_SECRET);
        req.tenantId = decoded.tenantId;
        req.tenant = decoded;
        next();
    } catch (err) {
        console.error('Auth error:', err.message);
        if (req.path.startsWith('/salon-admin/api/')) {
            return res.status(401).json({ error: 'Invalid or expired session' });
        }
        res.redirect('/salon-admin/login');
    }
};
function requireSuperAdminAuth(req, res, next) {
    const token = req.cookies.superAdminSession;

    if (!token) {
        return res.redirect('/super-admin/login');
    }

    try {
        const decoded = jwt.verify(token, JWT_SECRET);
        if (decoded.role !== 'super_admin') {
            return res.status(403).send('Access denied');
        }
        req.superAdmin = decoded;
        next();
    } catch (err) {
        res.clearCookie('superAdminSession');
        return res.redirect('/super-admin/login');
    }
}

function generateTenantToken(tenant) {
    return jwt.sign(
        {
            tenantId: tenant.tenant_id,
            email: tenant.email,
            salonName: tenant.salon_name
        },
        JWT_SECRET,
        { expiresIn: '7d' }
    );
}

module.exports = {
    requireTenantAuth,
    requireSuperAdminAuth,
    generateTenantToken
};