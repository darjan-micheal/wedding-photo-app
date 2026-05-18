require('dotenv').config();
const fastify = require('fastify')({ logger: true });
const { Pool } = require('pg');

// We added the SSL fix here so the server can connect to Supabase securely!
const pool = new Pool({ 
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false } 
});

fastify.post('/api/keys/validate', async (req, reply) => {
    const { key, machineId } = req.body;
    const { rows } = await pool.query('SELECT * FROM license_keys WHERE key = $1', [key]);
    const row = rows[0];

    if (!row) return reply.send({ valid: false, reason: 'Key not found' });
    if (!machineId) return reply.send({ valid: false, reason: 'Machine ID missing' });
    
    if (row.status === 'used') return reply.send({ valid: false, reason: 'Key already used' });
    if (row.status === 'expired') return reply.send({ valid: false, reason: 'Key expired' });

    // PILLAR 2: Returning User - Send back their original expiration time!
    if (row.status === 'active') {
        if (row.machine_id === machineId) {
            return reply.send({ 
                valid: true, 
                plan: row.plan, 
                photo_limit: row.photo_limit, 
                expires_at: row.expires_at // <-- THE ABSOLUTE TIME
            });
        } else {
            return reply.send({ valid: false, reason: 'Key is already active on another computer' });
        }
    }

    // PILLAR 2: Fresh Key - Activate it and fetch the newly generated expiration time
    const { rows: updateRows } = await pool.query(
        `UPDATE license_keys SET status='active', machine_id=$1, activated_at=NOW(), 
         expires_at=NOW() + INTERVAL '24 hours' WHERE key=$2 RETURNING expires_at`, 
        [machineId, key]
    );

    return reply.send({ 
        valid: true, 
        plan: row.plan, 
        photo_limit: row.photo_limit, 
        expires_at: updateRows[0].expires_at // <-- THE NEW ABSOLUTE TIME
    });
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