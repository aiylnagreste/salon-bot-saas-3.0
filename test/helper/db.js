const Database = require('better-sqlite3');
const fs = require('fs');
const path = require('path');

function createInMemoryDB() {
    const db = new Database(':memory:');
    db.pragma('journal_mode = WAL');
    db.pragma('foreign_keys = ON');
    return db;
}

function createTestDBWithTenant(tenantId = 'TEST_01') {
    const db = new Database(':memory:');
    db.pragma('journal_mode = WAL');
    db.pragma('foreign_keys = ON');

    // Create minimal tenant tables for testing
    db.exec(`
        CREATE TABLE IF NOT EXISTS ${tenantId}_branches (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            number INTEGER UNIQUE NOT NULL,
            name TEXT NOT NULL,
            address TEXT NOT NULL,
            map_link TEXT NOT NULL,
            phone TEXT NOT NULL
        );
        
        CREATE TABLE IF NOT EXISTS ${tenantId}_bookings (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            customer_name TEXT NOT NULL,
            phone TEXT,
            service TEXT,
            branch TEXT,
            date TEXT,
            time TEXT,
            status TEXT NOT NULL DEFAULT 'confirmed',
            created_at TEXT DEFAULT (datetime('now'))
        );
        
        CREATE TABLE IF NOT EXISTS ${tenantId}_app_settings (
            key TEXT PRIMARY KEY,
            value TEXT NOT NULL,
            updated_at TEXT DEFAULT (datetime('now'))
        );
        
        CREATE TABLE IF NOT EXISTS ${tenantId}_business_settings (
            key TEXT PRIMARY KEY,
            value TEXT,
            description TEXT,
            updated_at TEXT DEFAULT (datetime('now'))
        );
    `);

    return db;
}

module.exports = { createInMemoryDB, createTestDBWithTenant };