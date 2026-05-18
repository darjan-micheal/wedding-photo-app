module.exports = async function (fastify) {
  fastify.get('/download/:filename', async (request, reply) => {
    const { filename } = request.params;
    const galleryPath = process.env.GALLERY_PATH;
    const filepath = require('path').join(galleryPath, filename);

    if (!require('fs').existsSync(filepath)) {
      return reply.code(404).send({ error: 'Photo not found' });
    }

    // Tracker fully removed. Now it just instantly serves the file.
    return reply
      .header('Content-Disposition', `attachment; filename="${filename}"`)
      .sendFile(filename);
  });
};