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

    // --- THE FIX: RESTORE THE MISSING VARIABLES ---
    let allPhotos = []; // Master array to hold all photos for sorting
    let isZoomed = false; // Track zoom state

    // --- GHOST SESSION ENGINE ---
    let ghostId = localStorage.getItem('ws_ghost_id');
    if (!ghostId) {
        ghostId = 'guest_' + Math.random().toString(36).substr(2, 9);
        localStorage.setItem('ws_ghost_id', ghostId);
    }

    // --- TAB SWITCHING LOGIC ---
    let currentTab = 'pro'; // THE FIX: Track which tab is active!
    
    const tabGallery = document.getElementById('tabGallery');
    const tabGuestCam = document.getElementById('tabGuestCam');
    const viewGuestCam = document.getElementById('viewGuestCam');

    tabGallery.addEventListener('click', () => {
        currentTab = 'pro';
        viewGuestCam.classList.add('hidden');
        viewGuestCam.classList.remove('flex');
        
        tabGallery.classList.replace('text-yazhi-outerspace', 'text-yazhi-teal');
        tabGallery.classList.add('font-bold');
        tabGuestCam.classList.replace('text-yazhi-teal', 'text-yazhi-outerspace');
        tabGuestCam.classList.remove('font-bold');
        
        renderGallery(); // Re-render to show Pro photos
    });

    tabGuestCam.addEventListener('click', () => {
        currentTab = 'guest';
        // THE FIX: Do not hide the grid here!
        viewGuestCam.classList.remove('hidden');
        viewGuestCam.classList.add('flex');
        
        tabGuestCam.classList.replace('text-yazhi-outerspace', 'text-yazhi-teal');
        tabGuestCam.classList.add('font-bold');
        tabGallery.classList.replace('text-yazhi-teal', 'text-yazhi-outerspace');
        tabGallery.classList.remove('font-bold');
        
        renderGallery(); // Re-render to show Guest photos
    });

    // --- CLIENT-SIDE COMPRESSION & UPLOAD ---
    const guestUploadInput = document.getElementById('guestUploadInput');
    const uploadStatus = document.getElementById('uploadStatus');

    guestUploadInput.addEventListener('change', async (e) => {
        const file = e.target.files[0];
        if (!file) return;

        uploadStatus.classList.remove('hidden');
        uploadStatus.classList.replace('text-red-500', 'text-yazhi-teal');
        
        // DEBUG STEP 1: Verify file capture
        uploadStatus.innerHTML = `DEBUG 1: File grabbed (${(file.size / 1024 / 1024).toFixed(2)} MB). Starting compression...`;

        try {
            let fileToUpload = file;
            
            if (typeof imageCompression === 'function') {
                const options = { maxSizeMB: 1, maxWidthOrHeight: 1920, useWebWorker: false };
                fileToUpload = await imageCompression(file, options);
                // DEBUG STEP 2A: Compression succeeded
                uploadStatus.innerHTML = `DEBUG 2: Compressed to ${(fileToUpload.size / 1024 / 1024).toFixed(2)} MB. Uploading...`;
            } else {
                // DEBUG STEP 2B: Offline mode triggered
                uploadStatus.innerHTML = 'DEBUG 2: CDN Offline. Uploading raw file...';
            }

            const formData = new FormData();
            formData.append('guestId', ghostId); 
            formData.append('file', fileToUpload, file.name);

            const response = await fetch('/api/guest-upload', {
                method: 'POST',
                body: formData
            });

            if (response.ok) {
                // DEBUG STEP 3: Server accepted it
                uploadStatus.textContent = "DEBUG 3: Success! Server returned 200 OK.";
            } else {
                // DEBUG STEP 4: Server rejected it, let's grab the exact reason
                const errText = await response.text();
                throw new Error(`Server Status ${response.status}: ${errText}`);
            }

        } catch (error) {
            console.error("Upload error:", error);
            uploadStatus.classList.replace('text-yazhi-teal', 'text-red-500');
            // FATAL DEBUG: Print the exact Javascript or Network error to the phone screen
            uploadStatus.textContent = `FATAL ERROR: ${error.message}`;
        } finally {
            guestUploadInput.value = ''; 
        }
    });

    async function init() {
        try {
            const eventRes = await fetch('/api/event');
            const eventData = await eventRes.json();
            eventNameEl.textContent = eventData.name;

            // --- THE KILL SWITCH ---
            if (eventData.guest_cam_enabled === false) {
                document.getElementById('tabGuestCam').style.display = 'none';
            }

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
        grid.innerHTML = ''; 
        
        // THE FIX: Only show photos belonging to the current active tab
        const filteredPhotos = allPhotos.filter(p => p.source === currentTab);

        if (filteredPhotos.length === 0) {
            emptyState.classList.remove('hidden');
            grid.classList.add('hidden');
            controlsBar.classList.add('hidden');
            photoCountEl.textContent = '0';
            return;
        }

        emptyState.classList.add('hidden');
        grid.classList.remove('hidden');
        controlsBar.classList.remove('hidden');

        const sortedPhotos = [...filteredPhotos].sort((a, b) => {
            const indexA = allPhotos.indexOf(a);
            const indexB = allPhotos.indexOf(b);
            return sortOrder.value === 'newest' ? indexA - indexB : indexB - indexA;
        });

        sortedPhotos.forEach(photo => createPhotoElement(photo));
        photoCountEl.textContent = filteredPhotos.length;
    }

    function createPhotoElement(photo) {
        const wrapper = document.createElement('div');
        // Added 'group' class so we can style hover effects if needed
        wrapper.className = 'aspect-square bg-yazhi-outerspace overflow-hidden cursor-pointer animate-fade-in relative group';
        
        const img = document.createElement('img');
        img.src = photo.url;
        img.loading = 'lazy';
        img.className = 'w-full h-full object-cover';
        
        wrapper.appendChild(img);

        // --- THE MISSING TRASH CAN LOGIC ---
        // Only draw the button if the photo's Guest ID matches this phone's Ghost ID
        if (photo.guestId === ghostId) {
            const trashBtn = document.createElement('button');
            trashBtn.className = 'absolute top-2 right-2 bg-red-500/80 hover:bg-red-600 text-white p-2 rounded-full shadow-lg z-10 transition-colors opacity-90';
            trashBtn.innerHTML = '<svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16"></path></svg>';
            
            trashBtn.onclick = async (e) => {
                e.stopPropagation(); // Stop the lightbox from opening when clicking the trash can
                if(confirm("Delete this photo permanently?")) {
                    wrapper.classList.add('opacity-50');
                    try {
                        await fetch('/api/guest-delete', {
                            method: 'POST',
                            headers: { 'Content-Type': 'application/json' },
                            body: JSON.stringify({ filename: photo.filename, guestId: ghostId })
                        });
                        // Fastify will instantly broadcast the removal to update the UI
                    } catch(err) {
                        console.error("Deletion failed:", err);
                        wrapper.classList.remove('opacity-50');
                    }
                }
            };
            wrapper.appendChild(trashBtn);
        }

        wrapper.addEventListener('click', () => {
            lightboxImg.src = photo.url;
            downloadBtn.href = `/download/${photo.filename}`;
            resetZoom();
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
    
    socket.on('connect', () => {
        console.log("TRACER 3 (BROWSER): Connected to Socket.io server!");
    });

    socket.on('new_photo', (photo) => {
        console.log("TRACER 3 (BROWSER): Received new_photo event!", photo);
        if (!allPhotos.find(p => p.filename === photo.filename)) {
            
            // THE FIX: Instantly tag the live photo so the Tabs know where to put it!
            const isGuest = photo.filename.startsWith('guest_');
            photo.source = isGuest ? 'guest' : 'pro';
            photo.guestId = isGuest ? photo.filename.split('_').slice(0, 2).join('_') : null;

            allPhotos.unshift(photo);
            renderGallery(); 
        }
    });

    socket.on('photo_removed', (data) => {
        console.log("TRACER 3 (BROWSER): Received photo_removed event!", data);
        allPhotos = allPhotos.filter(photo => photo.filename !== data.filename);
        renderGallery();
    });

    socket.on('event_ended', () => {
        eventEndedOverlay.classList.remove('hidden');
        eventEndedOverlay.classList.add('flex');
    });

    init();
});