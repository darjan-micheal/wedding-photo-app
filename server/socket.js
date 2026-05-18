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
    console.log("TRACER 2 (NODE): Heard line on STDIN ->", line);
    try {
      const msg = JSON.parse(line);
      
      if (msg.event === 'new_photo') {
          console.log("TRACER 2 (NODE): Broadcasting new_photo to sockets!");
          io.emit('new_photo', msg.data);
      }
      
      if (msg.event === 'photo_removed') {
          console.log("TRACER 2 (NODE): Broadcasting photo_removed to sockets!");
          io.emit('photo_removed', msg.data);
      }
      
      if (msg.event === 'event_ended') io.emit('event_ended', {});
    } catch (err) {
        console.error("TRACER 2 ERROR (NODE): Failed to parse JSON ->", err.message);
    }
  });
};