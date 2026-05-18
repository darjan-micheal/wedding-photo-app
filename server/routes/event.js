module.exports = async function (fastify) {
  fastify.get('/api/event', async () => ({
    name: process.env.EVENT_NAME || 'Wedding Gallery',
  }));
};
// Ensure your SQL query or return object passes the flag:
return { 
    name: event.name, 
    // Convert SQLite 1/0 to a true/false boolean
    guest_cam_enabled: event.guest_cam_enabled === 1 
};