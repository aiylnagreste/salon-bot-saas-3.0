// scripts/check-db.js
const { getDb } = require('../db/database');

const db = getDb();
const tables = db.prepare(`
    SELECT name FROM sqlite_master 
    WHERE type='table' 
    ORDER BY name
`).all();

console.log('Existing tables in database:');
tables.forEach(table => {
    console.log(`  - ${table.name}`);
});

// Check if bookings table exists and has data
const hasBookings = db.prepare(`
    SELECT name FROM sqlite_master 
    WHERE type='table' AND name='bookings'
`).get();

if (hasBookings) {
    const count = db.prepare('SELECT COUNT(*) as c FROM bookings').get();
    console.log(`\nBookings table has ${count.c} records`);
} else {
    console.log('\nNo bookings table found');
}