module.exports = async function (fastify) {
  fastify.get('/api/event', async () => ({
    name: process.env.EVENT_NAME || 'Wedding Gallery',
  }));
};