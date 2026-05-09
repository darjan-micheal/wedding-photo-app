import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import QRCode from 'qrcode';

const PATHS = {
  gallery: 'C:/Users/darja/Downloads/Wedding/wedding-photo-app/weddingsnap-data/gallery/compressed',
  guestApp: 'C:/Users/darja/Downloads/Wedding/wedding-photo-app/weddingsnap-data/guest-app',
  pending: 'C:/Users/darja/Downloads/Wedding/wedding-photo-app/weddingsnap-data/incoming_pending',
  rejected: 'C:/Users/darja/Downloads/Wedding/wedding-photo-app/weddingsnap-data/rejected'
};

document.addEventListener('DOMContentLoaded', () => {
  
  // Screens
  const startScreen = document.getElementById('startScreen')!;
  const dashboardScreen = document.getElementById('dashboardScreen')!;
  const reportScreen = document.getElementById('reportScreen')!;

  const autoApproveToggle = document.getElementById('autoApproveToggle') as HTMLInputElement;
  const serverStatus = document.getElementById('serverStatus')!;
  const statusText = document.getElementById('statusText')!;

  // Event Flow Controls
  const triggerStartBtn = document.getElementById('triggerStartBtn') as HTMLButtonElement;
  const eventNameInput = document.getElementById('eventNameInput') as HTMLInputElement;
  const licenseKeyInput = document.getElementById('licenseKeyInput') as HTMLInputElement;
  const startErrorText = document.getElementById('startErrorText')!;
  const endEventBtn = document.getElementById('endEventBtn') as HTMLButtonElement;
  const activeEventName = document.getElementById('activeEventName')!;

  // Dashboard Elements
  const guestCount = document.getElementById('guestCount') as HTMLElement;
  const queueCount = document.getElementById('queueCount') as HTMLElement;
  const pendingGrid = document.getElementById('pendingGrid') as HTMLElement;
  const queueEmpty = document.getElementById('queueEmpty') as HTMLElement;
  const statApproved = document.getElementById('statApproved') as HTMLElement;
  const statRejected = document.getElementById('statRejected') as HTMLElement;
  const statDownloads = document.getElementById('statDownloads') as HTMLElement;

  // FIX: When toggled ON, instantly process all photos currently sitting in the queue
  autoApproveToggle.addEventListener('change', async (e) => {
      if ((e.target as HTMLInputElement).checked) {
          // Create a copy of the list so it doesn't break while removing items
          const currentQueue = [...pendingList];
          for (const filename of currentQueue) {
              await processAction('approve', filename);
          }
      }
  });

  // --- AUTO-RESUME LOGIC ---
  (async function tryResumeEvent() {
    try {
        // FIX: Added event_id to the invoke type so TypeScript knows it exists
        const resume = await invoke<{success: boolean, event_id: string, event_name: string, server_url: string}>('resume_active_event');
        if (resume.success && resume.event_id) {
            console.log("Recovered active event:", resume.event_name);
            activeEventName.textContent = resume.event_name;
            
            // Bypass login/start screen entirely
            startScreen.classList.add('hidden');
            dashboardScreen.classList.remove('hidden');
            dashboardScreen.classList.add('flex');
            
            refreshQueue(); // Will auto-clean ghosts!
            
            // FIX: Pass the specific event_id into the timer
            startEventTimer(resume.event_id); 
        }
    } catch (e) {
        console.log("No active event found to resume. Awaiting manual start.");
    }
  })();

  // Add this near the top
const timeLeftDisplay = document.getElementById('timeLeftDisplay')!;
let eventTimer: number;

function startEventTimer(eventId: string) {
    let endTimeStr = localStorage.getItem(`timer_${eventId}`);
    let lastTickStr = localStorage.getItem(`last_tick_${eventId}`);
    
    if (!endTimeStr) {
        let newEndTime = Date.now() + (24 * 60 * 60 * 1000); // 24 hours
        localStorage.setItem(`timer_${eventId}`, newEndTime.toString());
        localStorage.setItem(`last_tick_${eventId}`, Date.now().toString());
        endTimeStr = newEndTime.toString();
        lastTickStr = Date.now().toString();
    }
    
    let endTime = parseInt(endTimeStr);
    let lastTick = parseInt(lastTickStr!);

    clearInterval(eventTimer);
    eventTimer = window.setInterval(() => {
        let now = Date.now();
        
        // ANTI-CHEAT: Did the clock go backwards?
        if (now < lastTick - 5000) { // 5-second buffer for minor OS drift
            clearInterval(eventTimer);
            timeLeftDisplay.textContent = "TAMPER DETECTED";
            timeLeftDisplay.classList.replace('text-white', 'text-red-500');
            showUIError("System clock tampering detected. Event locked.");
            return;
        }
        
        // Update the high watermark
        lastTick = now;
        localStorage.setItem(`last_tick_${eventId}`, lastTick.toString());
        
        let totalSeconds = Math.floor((endTime - now) / 1000);
        
        if (totalSeconds <= 0) {
            clearInterval(eventTimer);
            timeLeftDisplay.textContent = "EXPIRED";
            timeLeftDisplay.classList.replace('text-white', 'text-red-500');
            return;
        }
        
        const h = Math.floor(totalSeconds / 3600).toString().padStart(2, '0');
        const m = Math.floor((totalSeconds % 3600) / 60).toString().padStart(2, '0');
        const s = (totalSeconds % 60).toString().padStart(2, '0');
        timeLeftDisplay.textContent = `${h}:${m}:${s}`;
    }, 1000);
}

// MAKE SURE TO CALL startEventTimer(); inside your startBtn and resumeEvent success blocks!

// --- ROUTER & SERVER STATUS PINGER ---
  setInterval(async () => {
    try {
        const isAlive = await invoke<boolean>('ping_router');
        if (isAlive) {
            serverStatus.className = "inline-block w-2 h-2 rounded-full bg-green-500 mr-2";
            statusText.textContent = "System Active";
            statusText.classList.replace('text-red-400', 'text-gray-400');
        } else {
            serverStatus.className = "inline-block w-2 h-2 rounded-full bg-red-500 mr-2";
            statusText.textContent = "Router Disconnected";
            statusText.classList.replace('text-gray-400', 'text-red-400');
        }
    } catch (e) {
        // Failsafe if Tauri is completely unresponsive
        serverStatus.className = "inline-block w-2 h-2 rounded-full bg-red-500 mr-2";
        statusText.textContent = "System Error";
    }
  }, 5000);

  // --- CUSTOM MODALS ---
  const customAlert = document.getElementById('customAlert')!;
  const customAlertText = document.getElementById('customAlertText')!;
  document.getElementById('closeAlertBtn')!.addEventListener('click', () => customAlert.classList.replace('flex', 'hidden'));

  function showUIError(message: string) {
      customAlertText.textContent = message;
      customAlert.classList.replace('hidden', 'flex');
  }

  const customConfirm = document.getElementById('customConfirm')!;
  const customConfirmText = document.getElementById('customConfirmText')!;
  let confirmCallback: (() => void) | null = null;

  document.getElementById('cancelConfirmBtn')!.addEventListener('click', () => customConfirm.classList.replace('flex', 'hidden'));
  document.getElementById('acceptConfirmBtn')!.addEventListener('click', () => {
      customConfirm.classList.replace('flex', 'hidden');
      if (confirmCallback) confirmCallback();
  });

  function showUIConfirm(message: string, onAccept: () => void) {
      customConfirmText.textContent = message;
      confirmCallback = onAccept;
      customConfirm.classList.replace('hidden', 'flex');
  }

  // QR Modal Elements
  const qrBtn = document.getElementById('qrBtn') as HTMLButtonElement;
  const qrModal = document.getElementById('qrModal') as HTMLElement;
  const closeQrBtn = document.getElementById('closeQrBtn') as HTMLButtonElement;
  const qrCanvas = document.getElementById('qrCanvas') as HTMLCanvasElement;
  const qrUrlText = document.getElementById('qrUrlText') as HTMLElement;
  const useMdnsBtn = document.getElementById('useMdnsBtn') as HTMLButtonElement;
  const useRawIpBtn = document.getElementById('useRawIpBtn') as HTMLButtonElement;
  
  let networkUrls = { mdns: '', raw_ip: '' };
  let pendingList: string[] = [];

  // --- 1. START EVENT LOGIC ---
  triggerStartBtn.addEventListener('click', async () => {
    const name = eventNameInput.value.trim();
    const key = licenseKeyInput.value.trim();
    
    if (!name || !key) {
        startErrorText.textContent = "Please enter both name and key.";
        startErrorText.classList.remove('hidden');
        return;
    }

    triggerStartBtn.textContent = "Validating & Booting...";
    triggerStartBtn.disabled = true;

    try {
        const result = await invoke<{event_id: string, server_url: string, event_name: string}>('start_event', {
            eventName: name,
            licenseKey: key,
            photoLimit: null
        });

        activeEventName.textContent = result.event_name;
        
        // Hide Form, Show Dashboard
        startScreen.classList.add('hidden');
        dashboardScreen.classList.remove('hidden');
        dashboardScreen.classList.add('flex'); // Keep flex layout
        
        // Load any existing photos for this event
        refreshQueue();
        
        // FIX: Pass the specific event_id into the timer
        startEventTimer(result.event_id);

    } catch (e) {
        startErrorText.textContent = String(e);
        startErrorText.classList.remove('hidden');
        triggerStartBtn.textContent = "Verify & Boot System";
        triggerStartBtn.disabled = false;
    }
  }); // <-- THIS WAS THE MISSING BRACKET THAT BROKE THE COMPILER!

  // --- 2. END EVENT LOGIC ---
  endEventBtn.addEventListener('click', () => {
    // USING OUR CUSTOM CONFIRM MODAL INSTEAD OF NATIVE ALERT
    showUIConfirm("Guests will be disconnected and the gallery will lock.", async () => {
        endEventBtn.textContent = "Shutting Down...";
        endEventBtn.disabled = true;

        try {
            const report = await invoke<{
                event_name: string, duration_minutes: number, 
                photos_approved: number, photos_rejected: number, 
                total_downloads: number, archive_path: string
            }>('end_event');

            // Populate the Final Report Screen
            document.getElementById('reportEventName')!.textContent = report.event_name;
            document.getElementById('reportDuration')!.textContent = `${report.duration_minutes} min`;
            document.getElementById('reportDownloads')!.textContent = report.total_downloads.toString();
            document.getElementById('reportApproved')!.textContent = report.photos_approved.toString();
            document.getElementById('reportRejected')!.textContent = report.photos_rejected.toString();
            document.getElementById('reportArchivePath')!.textContent = report.archive_path;

            // Hide Dashboard, Show Report
            dashboardScreen.classList.add('hidden');
            dashboardScreen.classList.remove('flex');
            reportScreen.classList.remove('hidden');
            reportScreen.classList.add('flex');

        } catch (e) {
            console.error("Failed to end event:", e);
            showUIError(`Error ending event: ${e}`);
            endEventBtn.textContent = "End Event";
            endEventBtn.disabled = false;
        }
    });
  });

  // --- 3. QR CODE LOGIC ---
  async function generateQR(url: string) {
    qrUrlText.textContent = url;
    try {
      await QRCode.toCanvas(qrCanvas, url, { 
        width: 256, margin: 2, color: { dark: '#111827', light: '#ffffff' }
      });
    } catch (err) {
      console.error('Failed to generate QR', err);
    }
  }

  qrBtn.addEventListener('click', async () => {
    qrModal.classList.remove('hidden');
    qrModal.classList.add('flex');
    try {
      networkUrls = await invoke<{mdns: string, raw_ip: string}>('get_network_urls');
      generateQR(networkUrls.raw_ip); 
      useRawIpBtn.classList.replace('bg-gray-700', 'bg-[#0ABAB5]');
      useRawIpBtn.classList.replace('text-white', 'text-black');
      useMdnsBtn.classList.replace('bg-[#0ABAB5]', 'bg-gray-700');
      useMdnsBtn.classList.replace('text-black', 'text-white');
    } catch (e) {
      qrUrlText.textContent = 'Failed to fetch network info.';
    }
  });

  useMdnsBtn.addEventListener('click', () => { generateQR(networkUrls.mdns); swapQrButtons(useMdnsBtn, useRawIpBtn); });
  useRawIpBtn.addEventListener('click', () => { generateQR(networkUrls.raw_ip); swapQrButtons(useRawIpBtn, useMdnsBtn); });
  closeQrBtn.addEventListener('click', () => { qrModal.classList.add('hidden'); qrModal.classList.remove('flex'); });

  function swapQrButtons(active: HTMLButtonElement, inactive: HTMLButtonElement) {
      active.classList.replace('bg-gray-700', 'bg-[#0ABAB5]');
      active.classList.replace('text-white', 'text-black');
      inactive.classList.replace('bg-[#0ABAB5]', 'bg-gray-700');
      inactive.classList.replace('text-black', 'text-white');
  }


  // --- 4. QUEUE & STATS MANAGEMENT ---
  async function refreshQueue() {
    try {
      pendingList = await invoke<string[]>('get_pending_photos');
      renderGrid();
      refreshStats();
    } catch (e) {
      console.error("Failed to fetch pending:", e);
    }
  }

  async function refreshStats() {
    try {
      const stats = await invoke<{approved: number, rejected: number, total_downloads: number}>('get_event_stats');
      statApproved.textContent = stats.approved.toString();
      statRejected.textContent = stats.rejected.toString();
      statDownloads.textContent = stats.total_downloads.toString();
    } catch (e) {
      console.error("Failed to fetch stats:", e);
    }
  }

  function renderGrid() {
    pendingGrid.innerHTML = '';
    queueCount.textContent = pendingList.length.toString();

    if (pendingList.length === 0) {
      queueEmpty.classList.remove('hidden');
      pendingGrid.classList.add('hidden');
      return;
    }

    queueEmpty.classList.add('hidden');
    pendingGrid.classList.remove('hidden');

    pendingList.forEach(filename => {
      const card = document.createElement('div');
      card.className = 'bg-gray-800 rounded-lg overflow-hidden border border-gray-700 shadow flex flex-col group';
      
      const img = document.createElement('img');
      img.className = 'w-full aspect-square object-cover bg-gray-800 animate-pulse';
      
      invoke<number[]>('read_image_file', { path: `${PATHS.pending}/${filename}` })
        .then(bytes => {
          const blob = new Blob([new Uint8Array(bytes)], { type: 'image/jpeg' });
          img.src = URL.createObjectURL(blob);
          img.classList.remove('animate-pulse');
        })
        .catch(e => console.error("Failed to load image:", e));
      
      const btnRow = document.createElement('div');
      btnRow.className = 'flex w-full divide-x divide-gray-700 border-t border-gray-700';
      
      const rejectBtn = document.createElement('button');
      rejectBtn.textContent = 'Reject';
      rejectBtn.className = 'flex-1 py-2 text-sm font-medium text-red-400 hover:bg-gray-700 hover:text-red-300 transition-colors';
      rejectBtn.onclick = () => processAction('reject', filename);

      const approveBtn = document.createElement('button');
      approveBtn.textContent = 'Approve';
      approveBtn.className = 'flex-1 py-2 text-sm font-bold text-[#0ABAB5] hover:bg-gray-700 hover:text-[#0cddcf] transition-colors';
      approveBtn.onclick = () => processAction('approve', filename);

      btnRow.appendChild(rejectBtn);
      btnRow.appendChild(approveBtn);
      card.appendChild(img);
      card.appendChild(btnRow);
      pendingGrid.appendChild(card);
    });
  }

  async function processAction(action: 'approve' | 'reject', filename: string) {
    try {
      if (action === 'approve') {
        await invoke('approve_photo', { filename, pendingDir: PATHS.pending, galleryDir: PATHS.gallery });
        // RESTORED FEATURE: Ping the sidecar to broadcast the Socket.io update to all guest phones!
        fetch('http://localhost:3000/api/refresh').catch(() => {});
      } else {
        await invoke('reject_photo', { filename, pendingDir: PATHS.pending, rejectedDir: PATHS.rejected });
      }
      pendingList = pendingList.filter(f => f !== filename);
      renderGrid();
      refreshStats();
    } catch (e) {
      console.error(e);
      const errorMsg = String(e);
      
      // FIX: If the file is physically missing (Ghost Photo), silently remove it from UI and clean DB
      if (errorMsg.includes("Not found in pending") || errorMsg.includes("failed")) {
          pendingList = pendingList.filter(f => f !== filename);
          renderGrid();
          refreshStats();
          invoke('get_pending_photos').catch(() => {}); // Triggers Rust to prune the SQLite DB
      } else {
          showUIError(`Failed to ${action} ${filename}. Error: ${e}`);
      }
    }
  }

  // --- LISTENERS ---
  listen<number>('guest_count_update', (event) => {
    guestCount.textContent = event.payload.toString();
  });

  listen<string>('new_pending_photo', async (event) => {
    if (autoApproveToggle.checked) {
        // FAST-TRACK: Wait 500ms for Rust to release the DB lock, then approve
        setTimeout(async () => {
            await processAction('approve', event.payload);
        }, 500);
    } else {
        // NORMAL MODE: Add to queue
        if (!pendingList.includes(event.payload)) {
          pendingList.push(event.payload);
          renderGrid();
          refreshStats();
        }
    }
  });
});