module.exports = async function (fastify) {
  fastify.get('/download/:filename', async (request, reply) => {
    
    // 1. ADD THIS TRACKING TRIGGER RIGHT HERE
    console.log(JSON.stringify({
        event: "download_logged", 
        photo_id: request.params.filename.replace('.jpg', ''), 
        guest_ip: request.ip 
    }));

    const { filename } = request.params;
    const galleryPath = process.env.GALLERY_PATH;
    const filepath = require('path').join(galleryPath, filename);

    if (!require('fs').existsSync(filepath)) {
      return reply.code(404).send({ error: 'Photo not found' });
    }

    // Log download via stdout to Rust (we will catch this in a later module)
    process.stdout.write(JSON.stringify({
      event: 'download_logged',
      photo_id: require('path').parse(filename).name,
      guest_ip: request.ip,
    }) + '\n');

    return reply
      .header('Content-Disposition', `attachment; filename="${filename}"`)
      .sendFile(filename);
  });
};