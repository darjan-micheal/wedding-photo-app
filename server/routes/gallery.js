const fs = require('fs');
const path = require('path');

module.exports = async function (fastify) {
  fastify.get('/api/photos', async (request, reply) => {
    const galleryPath = process.env.GALLERY_PATH;
    try {
      const files = fs.readdirSync(galleryPath)
        .filter(f => f.endsWith('.jpg') || f.endsWith('.jpeg'))
        .map(filename => ({
          id: path.parse(filename).name,
          filename,
          url: `/photos/${filename}`,
        }));

      // Sort newest first based on file creation time
      files.sort((a, b) => {
        const statA = fs.statSync(path.join(galleryPath, a.filename));
        const statB = fs.statSync(path.join(galleryPath, b.filename));
        return statB.birthtimeMs - statA.birthtimeMs;
      });

      return files;
    } catch {
      return []; // Return empty array if folder is missing or empty
    }
  });
};