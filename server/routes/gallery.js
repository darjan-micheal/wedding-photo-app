const fs = require('fs');
const path = require('path');

module.exports = async function (fastify) {
  fastify.get('/api/photos', async (request, reply) => {
    const galleryPath = process.env.GALLERY_PATH;
    try {
      const files = fs.readdirSync(galleryPath)
        .filter(f => f.toLowerCase().endsWith('.jpg') || f.toLowerCase().endsWith('.jpeg'))
        .map(filename => {
          // THE FIX: Derive the source and the specific guest ID directly from the filename!
          const isGuest = filename.startsWith('guest_');
          const guestId = isGuest ? filename.split('_').slice(0, 2).join('_') : null;
          
          return {
            id: filename, 
            filename,
            url: `/photos/${filename}`,
            source: isGuest ? 'guest' : 'pro',
            guestId: guestId
          };
        });

      files.sort((a, b) => {
        const statA = fs.statSync(path.join(galleryPath, a.filename));
        const statB = fs.statSync(path.join(galleryPath, b.filename));
        return statB.birthtimeMs - statA.birthtimeMs;
      });

      return files;
    } catch {
      return []; 
    }
  });
};