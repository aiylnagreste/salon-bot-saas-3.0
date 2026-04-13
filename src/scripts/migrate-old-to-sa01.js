// scripts/migrate-old-to-sa01.js
const { getDb } = require('../db/database');

const db = getDb();

// Check if old tables have data
const oldBookings = db.prepare('SELECT * FROM bookings').all();
const oldServices = db.prepare('SELECT * FROM services').all();
const oldBranches = db.prepare('SELECT * FROM branches').all();

console.log(`Found ${oldBookings.length} old bookings`);
console.log(`Found ${oldServices.length} old services`);
console.log(`Found ${oldBranches.length} old branches`);

if (oldBookings.length > 0 || oldServices.length > 0) {
    console.log('\n⚠️  Old data found. You may want to migrate it to SA_01');
    console.log('Run migration script if needed');
}