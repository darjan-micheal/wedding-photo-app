const fastify = require('fastify')({ logger: false });
const path = require('path');
const fs = require('fs');
const util = require('util');
const { pipeline } = require('stream');
const pump = util.promisify(pipeline);

const GALLERY_PATH = process.env.GALLERY_PATH;
const GUEST_APP_PATH = process.env.GUEST_APP_PATH;
const PORT = process.env.PORT || 3000;

// Dynamically route up from 'gallery/compressed' into 'incoming_pending'
const PENDING_PATH = path.join(GALLERY_PATH, '../../incoming_pending');

// MUST KEEP: Allow Tauri to talk to this server!
fastify.register(require('@fastify/cors'), { origin: '*' });

// NEW: Allow Node to receive files from guest phones (Bumped to 50MB for raw offline uploads)
fastify.register(require('@fastify/multipart'), {
    limits: { fileSize: 50 * 1024 * 1024 } 
});
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

// --- NEW: GUEST UPLOAD RECEIVER ---
fastify.post('/api/guest-upload', async (req, reply) => {
    try {
        console.log("FASTIFY DEBUG: Incoming upload request received...");
        
        const data = await req.file();
        if (!data) {
            console.log("FASTIFY DEBUG: Request contained no file data.");
            return reply.status(400).send({ error: 'No file uploaded' });
        }

        const guestId = (data.fields && data.fields.guestId) ? data.fields.guestId.value : 'guest';
        const filename = `${guestId}_${Date.now()}.jpg`;
        const savePath = path.join(PENDING_PATH, filename);

        console.log(`FASTIFY DEBUG: Streaming file to -> ${savePath}`);
        await pump(data.file, fs.createWriteStream(savePath));

        const stats = fs.statSync(savePath);
        const sizeKb = Math.round(stats.size / 1024);

        process.stdout.write(JSON.stringify({ 
            event: 'guest_upload_received', 
            filename: filename,
            size_kb: sizeKb,
            source: guestId
        }) + '\n');

        console.log("FASTIFY DEBUG: File saved successfully!");
        return { status: 'success', filename: filename };

    } catch (err) {
        // FATAL DEBUG: Catch Fastify multipart parsing errors
        console.error("FASTIFY FATAL ERROR:", err);
        return reply.status(500).send({ error: err.message });
    }
});

// --- NEW PHASE 4: GUEST DELETION ROUTE ---
fastify.post('/api/guest-delete', async (req, reply) => {
    const { filename, guestId } = req.body;
    
    // Security check: Make sure they only delete a file that starts with their specific ID!
    if (!filename || !guestId || !filename.startsWith(guestId)) {
        return reply.code(403).send({ error: 'Unauthorized deletion' });
    }

    // 1. Instantly delete the physical file to save your SSD space
    try { fs.unlinkSync(path.join(GALLERY_PATH, filename)); } catch(e){}
    try { fs.unlinkSync(path.join(PENDING_PATH, filename)); } catch(e){}

    // 2. Shout to Rust so it removes it from the SQLite DB
    process.stdout.write(JSON.stringify({ 
        event: 'guest_delete_photo', 
        filename: filename 
    }) + '\n');

    // 3. Tell all other phones to hide the photo instantly
    fastify.io.emit('photo_removed', { filename });

    return { status: 'success' };
});

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

// THE FIX: We must explicitly tell Fastify that 'io' exists so our routes can use it!
fastify.decorate('io', io); 

require('./socket')(fastify, io);