require('dotenv').config();
const fastify = require('fastify')({ logger: true });
const { Pool } = require('pg');

// We added the SSL fix here so the server can connect to Supabase securely!
const pool = new Pool({ 
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false } 
});

fastify.post('/api/keys/validate', async (req, reply) => {
    const { key } = req.body;
    const { rows } = await pool.query('SELECT * FROM license_keys WHERE key = $1', [key]);
    const row = rows[0];

    if (!row) return reply.send({ valid: false, reason: 'Key not found' });
    
    // THE FIX: We need to reject the key if it was already activated previously!
    if (row.status === 'active') return reply.send({ valid: false, reason: 'Key already active' });
    if (row.status === 'used') return reply.send({ valid: false, reason: 'Key already used' });
    if (row.status === 'expired') return reply.send({ valid: false, reason: 'Key expired' });

    // Activate the key to lock it
    await pool.query(
        `UPDATE license_keys SET status='active', activated_at=NOW(), 
         expires_at=NOW() + INTERVAL '24 hours' WHERE key=$1`, 
        [key]
    );

    return reply.send({ valid: true, plan: row.plan, photo_limit: row.photo_limit });
});

fastify.post('/api/keys/invalidate', async (req, reply) => {
    const { key } = req.body;
    await pool.query(
        `UPDATE license_keys SET status='used', used_at=NOW() WHERE key=$1`, 
        [key]
    );
    return reply.send({ success: true });
});

fastify.listen({ port: process.env.PORT || 8080, host: '0.0.0.0' }, (err) => {
    if (err) {
        fastify.log.error(err);
        process.exit(1);
    }
    console.log('Licensing server running on port', process.env.PORT || 8080);
});