const readline = require('readline');

module.exports = function setupSocket(fastify, io) {
  // Track connections and report to Rust via stdout
  io.on('connection', (socket) => {
    process.stdout.write(JSON.stringify({ 
      event: 'guest_count', 
      count: io.engine.clientsCount 
    }) + '\n');
    
    socket.on('disconnect', () => {
      process.stdout.write(JSON.stringify({ 
        event: 'guest_count', 
        count: io.engine.clientsCount 
      }) + '\n');
    });
  });

  // Listen for instructions from Tauri (Rust) via stdin
  const rl = readline.createInterface({ input: process.stdin });
  rl.on('line', (line) => {
    try {
      const msg = JSON.parse(line);
      if (msg.event === 'new_photo') io.emit('new_photo', msg.data);
      if (msg.event === 'event_ended') io.emit('event_ended', {});
    } catch {
        // Ignore malformed JSON or other logs silently
    }
  });
};