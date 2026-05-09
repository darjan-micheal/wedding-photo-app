// licensing-server/generate_keys.js

require('dotenv').config();
const { Pool } = require('pg');
const pool = new Pool({ 
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false } 
});

function generateKey() {
    const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // No ambiguous chars (O, 0, 1, I)
    const segment = () => Array.from({length: 4}, () => chars[Math.floor(Math.random() * chars.length)]).join('');
    return `WS-${segment()}-${segment()}-${segment()}`;
}

async function mintKeys(amount, plan, photoLimit) {
    for (let i = 0; i < amount; i++) {
        const key = generateKey();
        await pool.query(
            `INSERT INTO license_keys (key, plan, photo_limit) VALUES ($1, $2, $3)`,
            [key, plan, photoLimit]
        );
        console.log(`Minted: ${key}`);
    }
    process.exit(0);
}

// Run: node generate_keys.js 5 "standard" 300
const args = process.argv.slice(2);
mintKeys(parseInt(args[0]) || 1, args[1] || 'basic', args[2] || 100);