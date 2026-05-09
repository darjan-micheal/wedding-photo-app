document.addEventListener('DOMContentLoaded', () => {
    const grid = document.getElementById('galleryGrid');
    const emptyState = document.getElementById('emptyState');
    const photoCountEl = document.getElementById('photoCount');
    const eventNameEl = document.getElementById('eventName');
    const controlsBar = document.getElementById('controlsBar');
    const sortOrder = document.getElementById('sortOrder');
    
    const lightbox = document.getElementById('lightbox');
    const lightboxImg = document.getElementById('lightboxImg');
    const downloadBtn = document.getElementById('downloadBtn');
    const closeLightboxBtn = document.getElementById('closeLightbox');
    const eventEndedOverlay = document.getElementById('eventEndedOverlay');

    let allPhotos = []; // Master array to hold all photos for sorting
    let isZoomed = false; // Track zoom state

    // Register Service Worker
    if ('serviceWorker' in navigator) {
        navigator.serviceWorker.register('/sw.js').catch(console.error);
    }

    async function init() {
        try {
            const eventRes = await fetch('/api/event');
            const eventData = await eventRes.json();
            eventNameEl.textContent = eventData.name;

            const photoRes = await fetch('/api/photos');
            allPhotos = await photoRes.json();
            
            renderGallery();
        } catch (err) {
            console.error('Failed to load initial data:', err);
        }
    }

    // --- SORTING LOGIC ---
    sortOrder.addEventListener('change', renderGallery);

    function renderGallery() {
        grid.innerHTML = ''; // Clear the grid
        
        if (allPhotos.length === 0) {
            emptyState.classList.remove('hidden');
            grid.classList.add('hidden');
            controlsBar.classList.add('hidden');
            photoCountEl.textContent = '0';
            return;
        }

        emptyState.classList.add('hidden');
        grid.classList.remove('hidden');
        controlsBar.classList.remove('hidden');

        // Create a copy of the array and sort it
        const sortedPhotos = [...allPhotos].sort((a, b) => {
            // Assuming the API returns them chronologically (oldest first)
            // We compare their index in the original array to sort them
            const indexA = allPhotos.indexOf(a);
            const indexB = allPhotos.indexOf(b);
            return sortOrder.value === 'newest' ? indexA - indexB : indexB - indexA;
        });

        sortedPhotos.forEach(photo => createPhotoElement(photo));
        photoCountEl.textContent = allPhotos.length;
    }

    function createPhotoElement(photo) {
        const wrapper = document.createElement('div');
        wrapper.className = 'aspect-square bg-yazhi-outerspace overflow-hidden cursor-pointer animate-fade-in relative';
        
        const img = document.createElement('img');
        img.src = photo.url;
        img.loading = 'lazy';
        img.className = 'w-full h-full object-cover';
        
        wrapper.appendChild(img);

        wrapper.addEventListener('click', () => {
            lightboxImg.src = photo.url;
            downloadBtn.href = `/download/${photo.filename}`;
            resetZoom(); // Ensure it starts un-zoomed
            lightbox.classList.remove('hidden');
            setTimeout(() => lightbox.classList.remove('opacity-0'), 10);
        });

        grid.appendChild(wrapper);
    }

    // --- ZOOM LOGIC ---
    function toggleZoom() {
        isZoomed = !isZoomed;
        if (isZoomed) {
            lightboxImg.style.transform = 'scale(2)';
            lightboxImg.style.cursor = 'zoom-out';
        } else {
            resetZoom();
        }
    }

    function resetZoom() {
        isZoomed = false;
        lightboxImg.style.transform = 'scale(1)';
        lightboxImg.style.cursor = 'zoom-in';
        // Reset scroll positions
        lightbox.scrollTop = 0;
        lightbox.scrollLeft = 0;
    }

    // Desktop Double Click
    lightboxImg.addEventListener('dblclick', toggleZoom);

    // Mobile Double Tap
    let lastTap = 0;
    lightboxImg.addEventListener('touchend', (e) => {
        const currentTime = new Date().getTime();
        const tapLength = currentTime - lastTap;
        if (tapLength < 500 && tapLength > 0) {
            toggleZoom();
            e.preventDefault(); // Stop native zoom from fighting our JS zoom
        }
        lastTap = currentTime;
    });

    // Lightbox Close Handlers
    closeLightboxBtn.addEventListener('click', closeLightbox);
    lightbox.addEventListener('click', (e) => {
        if (e.target === lightbox) closeLightbox();
    });

    function closeLightbox() {
        lightbox.classList.add('opacity-0');
        setTimeout(() => lightbox.classList.add('hidden'), 300);
    }

    // Socket.io Integration
    const socket = io();
    
    socket.on('new_photo', (photo) => {
        allPhotos.push(photo);
        renderGallery(); // Re-sort and render
    });

    socket.on('event_ended', () => {
        eventEndedOverlay.classList.remove('hidden');
        eventEndedOverlay.classList.add('flex');
    });

    init();
});