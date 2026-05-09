const fastify = require('fastify')({ logger: false });
const path = require('path');

const GALLERY_PATH = process.env.GALLERY_PATH;
const GUEST_APP_PATH = process.env.GUEST_APP_PATH;
const PORT = process.env.PORT || 3000;

// MUST KEEP: Allow Tauri to talk to this server!
fastify.register(require('@fastify/cors'), { origin: '*' });

// Serve the actual photos (decorateReply gives us the .sendFile() method)
fastify.register(require('@fastify/static'), {
  root: GALLERY_PATH,
  prefix: '/photos/',
  decorateReply: true, 
});

// Serve the frontend guest application
fastify.register(require('@fastify/static'), {
  root: GUEST_APP_PATH,
  prefix: '/',
  decorateReply: false, // Prevents plugin collision
});

// Register our new API routes
fastify.register(require('./routes/gallery'));
fastify.register(require('./routes/download'));
fastify.register(require('./routes/event'));

fastify.get('/ping', async () => ({ status: 'ok', message: 'Sidecar is alive' }));

// --- NEW REAL-TIME PING ROUTE ---
fastify.get('/api/refresh', async (req, reply) => {
    // 1. Allow Tauri (localhost:1420) to securely talk to this server
    reply.header('Access-Control-Allow-Origin', '*'); 
    
    // 2. Emit a socket event to every guest's phone currently connected
    fastify.io.emit('refresh_gallery'); 
    
    return { status: 'ok' };
});

// ROBUST: Catch silent crashes and report them to Rust
process.on('uncaughtException', (err) => {
  process.stdout.write(JSON.stringify({ status: 'fatal_error', error: err.message }) + '\n');
  process.exit(1);
});

// ROBUST: Listen for Tauri shutting down and close gracefully
process.on('SIGTERM', async () => {
  await fastify.close();
  process.exit(0);
});

// Change your listen command to this:
fastify.listen({ port: process.env.PORT || 3000, host: '0.0.0.0' }, (err, address) => {
    if (err) {
        console.error(err);
        process.exit(1);
    }
    console.log(`Server listening at ${address}`);
});

const { Server } = require('socket.io');
// Attach Socket.io to the Fastify server
const io = new Server(fastify.server, { cors: { origin: '*' } });
require('./socket')(fastify, io);