const bcrypt = require('bcrypt');
const Database = require('better-sqlite3');

const db = new Database('./super.db');

// Create tables if not exist
db.exec(`
    CREATE TABLE IF NOT EXISTS super_admin (
        id INTEGER PRIMARY KEY,
        username TEXT UNIQUE NOT NULL,
        password_hash TEXT NOT NULL,
        email TEXT NOT NULL,
        created_at TEXT DEFAULT (datetime('now'))
    )
`);

// Check if super admin exists
const existing = db.prepare('SELECT * FROM super_admin WHERE username = ?').get('superadmin');

if (!existing) {
    const hash = bcrypt.hashSync('admin123', 10);
    db.prepare('INSERT INTO super_admin (id, username, password_hash, email) VALUES (1, ?, ?, ?)')
        .run('superadmin', hash, 'super@salon.com');
    console.log('✅ Super admin created!');
} else {
    // Update password to be sure
    const hash = bcrypt.hashSync('admin123', 10);
    db.prepare('UPDATE super_admin SET password_hash = ? WHERE username = ?').run(hash, 'superadmin');
    console.log('✅ Super admin password updated!');
}

// Verify
const verify = db.prepare('SELECT * FROM super_admin WHERE username = ?').get('superadmin');
console.log('\n📋 Super Admin Credentials:');
console.log('   Username: superadmin');
console.log('   Password: admin123');
console.log('   Email:', verify.email);
console.log('\n🔐 Password match:', bcrypt.compareSync('admin123', verify.password_hash));

db.close();