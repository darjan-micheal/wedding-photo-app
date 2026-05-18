import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { open } from "@tauri-apps/plugin-dialog";
import { open as openShell } from "@tauri-apps/plugin-shell";
import QRCode from 'qrcode';
import { createClient } from '@supabase/supabase-js';

// --- INITIALIZE SUPABASE ---
const SUPABASE_URL = 'https://cpbtbymnjcnrpbsqqima.supabase.co';
const SUPABASE_ANON_KEY = 'sb_publishable_128HdzP8m1tL-yDmOnG8ww_WlCUwqdd';
const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

// --- DYNAMIC STORAGE ENGINE ---
const PATHS = {
  gallery: '',
  // The App code stays safely on the C: drive where it was installed
  guestApp: 'C:/Users/darja/Downloads/Wedding/wedding-photo-app/weddingsnap-data/guest-app',
  pending: '',
  rejected: ''
};

let MASTER_STORAGE_PATH = localStorage.getItem('weddingsnap_storage_path') || 'C:/Users/darja/Downloads/Wedding/wedding-photo-app';

function updatePaths() {
  PATHS.gallery = `${MASTER_STORAGE_PATH}/weddingsnap-data/gallery/compressed`;
  PATHS.pending = `${MASTER_STORAGE_PATH}/weddingsnap-data/incoming_pending`;
  PATHS.rejected = `${MASTER_STORAGE_PATH}/weddingsnap-data/rejected`;

  const display = document.getElementById('storagePathDisplay') as HTMLInputElement;
  if (display) display.value = MASTER_STORAGE_PATH;
}

document.addEventListener('DOMContentLoaded', async () => {
  
  const startScreen = document.getElementById('startScreen')!;
  const dashboardScreen = document.getElementById('dashboardScreen')!;
  const reportScreen = document.getElementById('reportScreen')!;
  const accountHubScreen = document.getElementById('accountHubScreen')!;
  const googleLoginBtn = document.getElementById('googleLoginBtn') as HTMLButtonElement;

  updatePaths(); // Set paths instantly on boot

  // --- ONBOARDING WIZARD ENGINE ---
  async function triggerOnboardingOrHub() {
      if (!localStorage.getItem('ws_setup_complete')) {
          // Hide Dashboard, Show Wizard!
          const wizard = document.getElementById('onboardingWizard')!;
          wizard.classList.remove('hidden');
          wizard.classList.add('flex');
          
          // Step 1 -> Step 2
          document.getElementById('wizardNext1')!.onclick = () => {
              document.getElementById('wizardStep1')!.classList.add('hidden');
              document.getElementById('wizardStep2')!.classList.remove('hidden');
              document.getElementById('wizardProgress')!.style.width = '66%';
          };

          // Handle Directory Selection in Step 2
          const next2Btn = document.getElementById('wizardNext2') as HTMLButtonElement;
          document.getElementById('wizardSelectStorageBtn')!.onclick = async () => {
              const selected = await open({ directory: true, multiple: false, title: "Select Master Storage Folder" });
              if (selected && typeof selected === 'string') {
                  MASTER_STORAGE_PATH = selected;
                  localStorage.setItem('weddingsnap_storage_path', MASTER_STORAGE_PATH);
                  updatePaths(); // Update backend targeting
                  
                  const display = document.getElementById('wizardStorageDisplay')!;
                  display.textContent = selected;
                  display.classList.remove('hidden');
                  
                  // Unlock the "Next" button!
                  next2Btn.disabled = false;
                  next2Btn.className = "w-full py-3 bg-[#0ABAB5] hover:bg-[#099a95] text-black font-bold rounded-lg transition-colors shadow-lg";
                  next2Btn.textContent = "Continue";
              }
          };

          // Step 2 -> Step 3
          next2Btn.onclick = () => {
              document.getElementById('wizardStep2')!.classList.add('hidden');
              document.getElementById('wizardStep3')!.classList.remove('hidden');
              document.getElementById('wizardProgress')!.style.width = '100%';
          };

          // Finish Wizard -> Enter Command Center
          document.getElementById('wizardFinishBtn')!.onclick = () => {
              localStorage.setItem('ws_setup_complete', 'true');
              wizard.classList.add('hidden');
              wizard.classList.remove('flex');
              
              accountHubScreen.classList.remove('hidden');
              accountHubScreen.classList.add('flex');
          };
      } else {
          // If setup is already done, proceed normally to the Command Center
          accountHubScreen.classList.remove('hidden');
          accountHubScreen.classList.add('flex');
      }
  }

  const changeStorageBtn = document.getElementById('changeStorageBtn');
  if (changeStorageBtn) {
      changeStorageBtn.addEventListener('click', async () => {
          const selected = await open({
              directory: true,
              multiple: false,
              title: "Select Master Storage Folder"
          });

          if (selected && typeof selected === 'string') {
              MASTER_STORAGE_PATH = selected;
              localStorage.setItem('weddingsnap_storage_path', MASTER_STORAGE_PATH);
              updatePaths();
              
              document.getElementById('customAlertText')!.textContent = "Storage path updated successfully! All future events and heavy media will be routed to this drive.";
              document.getElementById('customAlert')!.classList.remove('hidden');
              document.getElementById('customAlert')!.classList.add('flex');
          }
      });
  }

  // --- PHASE 2: CLOUD LICENSE ENGINE ---
  let activeUserId = ''; // Track the user globally for the Burner

  async function fetchAndPopulateLicenses(userId: string) {
      activeUserId = userId; 
      try {
          // Based on your advanced schema, we use 'owner_id' and 'status = unused'
          const { data, error } = await supabase
              .from('license_keys')
              .select('*')
              .eq('owner_id', userId)
              .eq('status', 'unused');

          if (error) throw error;

          // 1. Update Dashboard Number
          const activeLicensesCount = document.getElementById('activeLicensesCount');
          if (activeLicensesCount) activeLicensesCount.textContent = (data?.length || 0).toString();

          // NEW: Update Settings Number
          const settingsActiveLicenses = document.getElementById('settingsActiveLicenses');
          if (settingsActiveLicenses) settingsActiveLicenses.textContent = (data?.length || 0).toString();

          // 2. Populate Dropdown Menu
          const cloudKeySelect = document.getElementById('cloudKeySelect') as HTMLSelectElement;
          if (cloudKeySelect) {
              cloudKeySelect.innerHTML = '<option value="">-- Choose an available key --</option>';
              if (data && data.length > 0) {
                  data.forEach(k => {
                      const opt = document.createElement('option');
                      opt.value = k.key;
                      // THE FIX: Now it just displays the key itself!
                      opt.textContent = k.key; 
                      cloudKeySelect.appendChild(opt);
                  });
              }
          }
      } catch (err) {
          console.error("Failed to fetch cloud licenses:", err);
      }
  }
  // -------------------------------------
  // --- PHASE 3: SYNC ENGINE & DYNAMIC AGGREGATION ---
  async function fetchDashboardMetrics(userId: string) {
      try {
          // 1. Process the Offline Queue first
          const pendingSyncs = await invoke<any[]>('get_pending_sync_events', { storagePath: MASTER_STORAGE_PATH });
          for (const ev of pendingSyncs) {
              const { error } = await supabase.from('events_history').insert({
                  owner_id: ev.owner_id, event_name: ev.event_name, started_at: ev.started_at,
                  ended_at: ev.ended_at, total_photos: ev.total_photos,
                  archive_path: ev.archive_path
              });
              if (!error) {
                  await invoke('mark_event_synced', { eventId: ev.event_id });
                  console.log(`Successfully synced offline event: ${ev.event_name}`);
              }
          }

          // 2. Dynamically calculate Lifetime Metrics from the Cloud Mirror
          const { data, error } = await supabase
              .from('events_history')
              .select('total_photos')
              .eq('owner_id', userId);
          
          if (error) throw error;
          
          const totalEvents = data.length;
          const lifetimePhotos = data.reduce((sum, row) => sum + (row.total_photos || 0), 0);
          
          document.getElementById('totalEventsCount')!.textContent = totalEvents.toString();
          document.getElementById('lifetimePhotosCount')!.textContent = lifetimePhotos.toString();
          
      } catch (err) {
          console.error("Dashboard Metrics Sync Failed (Offline Mode Active):", err);
      }
  }

  // --- PHASE 1: THE SECURE OFFLINE VAULT CHECK ---
  // When the app boots, instantly check local storage for a valid Supabase session
  const { data: sessionData } = await supabase.auth.getSession();
  
  if (sessionData.session) {
      console.log("Valid offline session found! Bypassing login.");
      const user = sessionData.session.user;
      
      // Perform the Identity Handshake with Rust!
      await invoke('sync_user_session', {
          userId: user.id,
          email: user.email || '',
          name: user.user_metadata?.full_name || 'Photographer'
      });
      await fetchAndPopulateLicenses(user.id);
      await fetchDashboardMetrics(user.id);
      await fetchEventHistory(user.id);

      // Bypass the login screen immediately
      startScreen.classList.add('hidden');
      startScreen.classList.remove('flex');
      await triggerOnboardingOrHub(); // <--- INTERCEPT HERE

      document.getElementById('userName')!.textContent = user.user_metadata?.full_name || 'Photographer';
      document.getElementById('userEmail')!.textContent = user.email || '';
      const avatarEl = document.getElementById('userAvatar') as HTMLImageElement;
      if (user.user_metadata?.avatar_url) {
          avatarEl.src = user.user_metadata.avatar_url;
      }
      // --- POPULATE SETTINGS CARD ---
                  document.getElementById('settingsName')!.textContent = user.user_metadata?.full_name || 'Photographer';
                  document.getElementById('settingsEmail')!.textContent = user.email || '';
                  const settingsAvatar = document.getElementById('settingsAvatar') as HTMLImageElement;
                  if (user.user_metadata?.avatar_url) {
                      settingsAvatar.src = user.user_metadata.avatar_url;
                  }
  } else {
      console.log("No valid session found. Awaiting Google Login.");
  }
  // ------------------------------------------------

// --- PHASE 3: EVENT HISTORY ENGINE ---
  async function fetchEventHistory(userId: string) {
      const historyList = document.getElementById('historyList');
      if (!historyList) return;

      try {
          // Fetch from Supabase, ordering by newest first!
          const { data, error } = await supabase
              .from('events_history')
              .select('*')
              .eq('owner_id', userId)
              .order('ended_at', { ascending: false });

          if (error) throw error;

          if (!data || data.length === 0) {
              historyList.innerHTML = `
                  <div class="flex flex-col items-center justify-center text-gray-500 mt-20">
                      <svg class="w-16 h-16 mb-4 opacity-50" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="1.5" d="M19 11H5m14 0a2 2 0 012 2v6a2 2 0 01-2 2H5a2 2 0 01-2-2v-6a2 2 0 012-2m14 0V9a2 2 0 00-2-2M5 11V9a2 2 0 012-2m0 0V5a2 2 0 012-2h6a2 2 0 012 2v2M7 7h10"></path></svg>
                      <p>No events found. Start your first wedding to see it here!</p>
                  </div>`;
              return;
          }

          historyList.innerHTML = ''; // Clear the loading state

          // Generate a beautiful UI card for each event
          data.forEach(event => {
              const date = new Date(event.started_at).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
              
              const card = document.createElement('div');
              card.className = "bg-gray-800 p-6 rounded-xl border border-gray-700 shadow-sm flex flex-col md:flex-row justify-between items-start md:items-center gap-4 hover:border-[#0ABAB5] transition-colors shrink-0";
              
              card.innerHTML = `
                  <div class="overflow-hidden w-full md:w-auto">
                      <h3 class="text-xl font-bold text-white mb-1 truncate">${event.event_name}</h3>
                      <p class="text-sm text-gray-400">Date: ${date}</p>
                      <p class="text-xs text-gray-500 font-mono mt-2 truncate w-full md:max-w-md bg-gray-900 px-2 py-1 rounded border border-gray-700" title="${event.archive_path}">💾 ${event.archive_path}</p>
                  </div>
                  <div class="flex items-center gap-6 bg-gray-900 px-5 py-3 rounded-lg border border-gray-700 shrink-0 w-full md:w-auto justify-center">
                      <div class="text-center">
                          <p class="text-xs text-gray-400 uppercase tracking-wider mb-1">Photos</p>
                          <p class="text-xl font-black text-[#0ABAB5]">${event.total_photos || 0}</p>
                      </div>
                  </div>
              `;
              historyList.appendChild(card);
          });

      } catch (err) {
          console.error("Failed to fetch event history:", err);
          historyList.innerHTML = `<p class="text-red-400 text-center mt-10 font-bold">Error loading history from Cloud Mirror.</p>`;
      }
  }
  // -------------------------------------

  // --- SIDEBAR TAB LOGIC ---
  const navDashboardBtn = document.getElementById('navDashboardBtn')!;
  const navHistoryBtn = document.getElementById('navHistoryBtn')!;
  const navSettingsBtn = document.getElementById('navSettingsBtn')!;
  
  const tabDashboard = document.getElementById('tabDashboard')!;
  const tabHistory = document.getElementById('tabHistory')!;
  const tabSettings = document.getElementById('tabSettings')!;

  const allNavBtns = [navDashboardBtn, navHistoryBtn, navSettingsBtn];
  const allTabs = [tabDashboard, tabHistory, tabSettings];

  function switchTab(activeBtn: HTMLElement, activeTab: HTMLElement) {
      // Reset all buttons to inactive styling
      allNavBtns.forEach(btn => {
          btn.className = "w-full text-left px-4 py-3 text-gray-400 hover:bg-gray-700 hover:text-white rounded-lg transition-colors flex items-center gap-3";
          const svg = btn.querySelector('svg');
          if (svg) svg.classList.remove('text-[#0ABAB5]');
      });
      // Hide all tabs
      allTabs.forEach(tab => {
          tab.classList.add('hidden');
          tab.classList.remove('flex');
      });

      // Activate clicked button
      activeBtn.className = "w-full text-left px-4 py-3 bg-gray-700 text-white rounded-lg font-medium shadow-inner flex items-center gap-3 transition-colors";
      const activeSvg = activeBtn.querySelector('svg');
      if (activeSvg) activeSvg.classList.add('text-[#0ABAB5]');
      
      // Show clicked tab
      activeTab.classList.remove('hidden');
      activeTab.classList.add('flex');
  }

  navDashboardBtn.addEventListener('click', () => switchTab(navDashboardBtn, tabDashboard));
  navHistoryBtn.addEventListener('click', () => switchTab(navHistoryBtn, tabHistory));
  navSettingsBtn.addEventListener('click', () => switchTab(navSettingsBtn, tabSettings));
  // -------------------------
  // --- SETTINGS: WORKFLOW STATE ENGINE ---
  const settingAutoApprove = document.getElementById('settingDefaultAutoApprove') as HTMLInputElement;
  const settingCompression = document.getElementById('settingCompressionQuality') as HTMLSelectElement;

  // 1. Load saved preferences on boot
  settingAutoApprove.checked = localStorage.getItem('ws_default_auto_approve') === 'true';
  settingCompression.value = localStorage.getItem('ws_compression_quality') || 'balanced';

  // 2. Save preferences when changed
  settingAutoApprove.addEventListener('change', (e) => {
      localStorage.setItem('ws_default_auto_approve', (e.target as HTMLInputElement).checked.toString());
  });
  settingCompression.addEventListener('change', (e) => {
      localStorage.setItem('ws_compression_quality', (e.target as HTMLSelectElement).value);
  });

  const autoApproveToggle = document.getElementById('autoApproveToggle') as HTMLInputElement;
  const serverStatus = document.getElementById('serverStatus')!;
  const statusText = document.getElementById('statusText')!;

  const openNewEventModalBtn = document.getElementById('openNewEventModalBtn') as HTMLButtonElement;
  const newEventModal = document.getElementById('newEventModal')!;
  const closeModalBtn = document.getElementById('closeModalBtn') as HTMLButtonElement;
  const modalLaunchBtn = document.getElementById('modalLaunchBtn') as HTMLButtonElement;

  const eventNameInput = document.getElementById('eventNameInput') as HTMLInputElement;
  const licenseKeyInput = document.getElementById('licenseKeyInput') as HTMLInputElement;
  const endEventBtn = document.getElementById('endEventBtn') as HTMLButtonElement;
  const activeEventName = document.getElementById('activeEventName')!;

  // --- GOOGLE OAUTH FLOW ---
  googleLoginBtn.addEventListener('click', async () => {
      googleLoginBtn.textContent = "Opening Browser...";
      googleLoginBtn.disabled = true;

      try {
          const { data, error } = await supabase.auth.signInWithOAuth({
              provider: 'google',
              options: {
                  redirectTo: 'weddingsnap://auth',
                  skipBrowserRedirect: true
              }
          });

          if (error) throw new Error(error.message);

          if (data?.url) {
              await openShell(data.url);
              googleLoginBtn.textContent = "Waiting for Google...";
          } else {
              throw new Error("No URL returned from Supabase.");
          }
      } catch (err) {
          console.error("Login Error:", err);
          showUIError(`Browser Error: ${String(err)}`);
          googleLoginBtn.textContent = "Continue with Google";
          googleLoginBtn.disabled = false;
      }
  });

  // CATCH THE DEEP LINK FROM RUST
  listen<string>('google_auth_received', async (event) => {
      const url = event.payload; 
      
      if (url.includes('error=')) {
          showUIError("Supabase Error: " + url);
          googleLoginBtn.textContent = "Continue with Google";
          googleLoginBtn.disabled = false;
          return;
      }

      const hash = url.split('#')[1];
      if (!hash) {
          showUIError("Received link, but no authentication token was found: " + url);
          googleLoginBtn.textContent = "Continue with Google";
          googleLoginBtn.disabled = false;
          return;
      }
      
      const params = new URLSearchParams(hash);
      const access_token = params.get('access_token');
      const refresh_token = params.get('refresh_token');

      if (access_token && refresh_token) {
          try {
              const { data, error } = await supabase.auth.setSession({ access_token, refresh_token });
              if (error) throw error;

              if (data.user) {
                  // NEW: Perform the Identity Handshake instantly after a fresh login
                  await invoke('sync_user_session', {
                      userId: data.user.id,
                      email: data.user.email || '',
                      name: data.user.user_metadata?.full_name || 'Photographer'
                  });
                  await fetchAndPopulateLicenses(data.user.id);
                  await fetchDashboardMetrics(data.user.id);
                  fetchEventHistory(data.user.id);
                  

                  startScreen.classList.add('hidden');
                  startScreen.classList.remove('flex');
                  await triggerOnboardingOrHub(); // <--- INTERCEPT HERE

                  document.getElementById('userName')!.textContent = data.user.user_metadata.full_name || 'Photographer';
                  document.getElementById('userEmail')!.textContent = data.user.email || '';
                  
                  const avatarEl = document.getElementById('userAvatar') as HTMLImageElement;
                  if (data.user.user_metadata.avatar_url) {
                      avatarEl.src = data.user.user_metadata.avatar_url;
                  }
                  // --- POPULATE SETTINGS CARD ---
                  document.getElementById('settingsName')!.textContent = data.user.user_metadata.full_name || 'Photographer';
                  document.getElementById('settingsEmail')!.textContent = data.user.email || '';
                  const settingsAvatar = document.getElementById('settingsAvatar') as HTMLImageElement;
                  if (data.user.user_metadata.avatar_url) {
                      settingsAvatar.src = data.user.user_metadata.avatar_url;
                  }
              }
          } catch (err) {
              showUIError("Session Error: " + String(err));
              googleLoginBtn.textContent = "Continue with Google";
              googleLoginBtn.disabled = false;
          }
      }
  });

  const guestCount = document.getElementById('guestCount') as HTMLElement;
  const queueCount = document.getElementById('queueCount') as HTMLElement;
  const pendingGrid = document.getElementById('pendingGrid') as HTMLElement;
  const queueEmpty = document.getElementById('queueEmpty') as HTMLElement;
  const statApproved = document.getElementById('statApproved') as HTMLElement;
  const statRejected = document.getElementById('statRejected') as HTMLElement;

  // --- DASHBOARD INNER TABS LOGIC ---
  const tabBtnPending = document.getElementById('tabBtnPending') as HTMLButtonElement;
  const tabBtnApproved = document.getElementById('tabBtnApproved') as HTMLButtonElement;
  const tabBtnRejected = document.getElementById('tabBtnRejected') as HTMLButtonElement;
  
  const viewPending = document.getElementById('viewPending') as HTMLElement;
  const viewApproved = document.getElementById('viewApproved') as HTMLElement;
  const viewRejected = document.getElementById('viewRejected') as HTMLElement;
  
  // We need to mirror the stats to the new tab headers
  const statApprovedTab = document.getElementById('statApprovedTab') as HTMLElement;
  const statRejectedTab = document.getElementById('statRejectedTab') as HTMLElement;

  const allInnerTabBtns = [tabBtnPending, tabBtnApproved, tabBtnRejected];
  const allInnerViews = [viewPending, viewApproved, viewRejected];

  function switchInnerTab(activeBtn: HTMLButtonElement, activeView: HTMLElement) {
      // Reset all buttons to gray text, no background
      allInnerTabBtns.forEach(btn => {
          btn.className = "px-4 py-2 text-sm font-bold text-gray-400 hover:text-white transition-colors";
      });
      // Hide all views
      allInnerViews.forEach(view => {
          view.classList.add('hidden');
      });

      // Highlight active button (with your brand color)
      activeBtn.className = "px-4 py-2 text-sm font-bold text-black bg-[#0ABAB5] rounded-t-lg transition-colors";
      
      // Show active view
      activeView.classList.remove('hidden');
  }

  tabBtnPending.addEventListener('click', () => switchInnerTab(tabBtnPending, viewPending));
  tabBtnApproved.addEventListener('click', () => switchInnerTab(tabBtnApproved, viewApproved));
  tabBtnRejected.addEventListener('click', () => switchInnerTab(tabBtnRejected, viewRejected));
  // ----------------------------------

  autoApproveToggle.addEventListener('change', async (e) => {
      if ((e.target as HTMLInputElement).checked) {
          const currentQueue = [...pendingList];
          for (const filename of currentQueue) {
              await processAction('approve', filename, PATHS.pending); // Added PATHS.pending
          }
      }
  });

  // --- AUTO-RESUME LOGIC ---
  (async function tryResumeEvent() {
    try {
        const quality = localStorage.getItem('ws_compression_quality') || 'balanced';
        const resume = await invoke<{success: boolean, event_id: string, event_name: string, server_url: string}>('resume_active_event', { 
            storagePath: MASTER_STORAGE_PATH,
            compressionQuality: quality 
        });
        if (resume.success && resume.event_id) {
            console.log("Recovered active event:", resume.event_name);
            activeEventName.textContent = resume.event_name;
            
            startScreen.classList.add('hidden');
            accountHubScreen.classList.add('hidden'); // Also hide the account hub
            dashboardScreen.classList.remove('hidden');
            dashboardScreen.classList.add('flex');
            
            refreshQueue(); 
            startEventTimer(resume.event_id); 
        }
    } catch (e) {
        console.log("No active event found to resume.");
    }
  })();

  const timeLeftDisplay = document.getElementById('timeLeftDisplay')!;
  let eventTimer: number;

  function startEventTimer(eventId: string, cloudExpiresAt?: string) {
      if (cloudExpiresAt) {
          localStorage.setItem(`expires_at_${eventId}`, cloudExpiresAt);
      }

      let savedExpiresAtStr = localStorage.getItem(`expires_at_${eventId}`);
      if (!savedExpiresAtStr) return; 

      let endTime = new Date(savedExpiresAtStr).getTime();
      let lastTickStr = localStorage.getItem(`last_tick_${eventId}`);
      
      if (!lastTickStr) {
          localStorage.setItem(`last_tick_${eventId}`, Date.now().toString());
          lastTickStr = Date.now().toString();
      }
      
      let lastTick = parseInt(lastTickStr);

      clearInterval(eventTimer);
      eventTimer = window.setInterval(() => {
          let now = Date.now();
          
          if (now < lastTick - 5000) { 
              clearInterval(eventTimer);
              timeLeftDisplay.textContent = "TAMPER DETECTED";
              timeLeftDisplay.classList.replace('text-white', 'text-red-500');
              showUIError("System clock tampering detected. Event locked.");
              return;
          }
          
          lastTick = now;
          localStorage.setItem(`last_tick_${eventId}`, lastTick.toString());
          
          let totalSeconds = Math.floor((endTime - now) / 1000);
          
          if (totalSeconds <= 0) {
              clearInterval(eventTimer);
              timeLeftDisplay.textContent = "EXPIRED";
              timeLeftDisplay.classList.replace('text-white', 'text-red-500');
              
              // THE FIX: Actually lock the UI when the timer hits zero!
              document.getElementById('dashboardScreen')!.classList.add('hidden');
              document.getElementById('dashboardScreen')!.classList.remove('flex');
              
              showUIError("LICENSE EXPIRED: The time window for this event has closed. The local server and image processor have been terminated. Please purchase a new license to start a new event.");
              
              document.getElementById('closeAlertBtn')!.style.display = 'none';

              const alertBox = document.getElementById('customAlertText')!.parentElement;
              if (alertBox && !document.getElementById('fatalResetBtn')) {
                  const resetBtn = document.createElement('button');
                  resetBtn.id = 'fatalResetBtn';
                  resetBtn.textContent = "Return to Start Screen";
                  resetBtn.className = "mt-6 w-full py-3 bg-[#0ABAB5] hover:bg-[#099a95] text-black font-bold rounded-lg transition-colors shadow-lg";
                  resetBtn.onclick = () => window.location.reload(); 
                  alertBox.appendChild(resetBtn);
              }
              return;
          }
          
          const h = Math.floor(totalSeconds / 3600).toString().padStart(2, '0');
          const m = Math.floor((totalSeconds % 3600) / 60).toString().padStart(2, '0');
          const s = (totalSeconds % 60).toString().padStart(2, '0');
          timeLeftDisplay.textContent = `${h}:${m}:${s}`;
      }, 1000);
  }

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
        serverStatus.className = "inline-block w-2 h-2 rounded-full bg-red-500 mr-2";
        statusText.textContent = "System Error";
    }
  }, 5000);

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

  function showUIConfirm(message: string, buttonText: string, onAccept: () => void) {
      customConfirmText.textContent = message;
      document.getElementById('acceptConfirmBtn')!.textContent = buttonText; // Make text dynamic!
      confirmCallback = onAccept;
      customConfirm.classList.replace('hidden', 'flex');
  }

  const qrBtn = document.getElementById('qrBtn') as HTMLButtonElement;
  const qrModal = document.getElementById('qrModal') as HTMLElement;
  const closeQrBtn = document.getElementById('closeQrBtn') as HTMLButtonElement;
  const qrCanvas = document.getElementById('qrCanvas') as HTMLCanvasElement;
  const qrUrlText = document.getElementById('qrUrlText') as HTMLElement;
  const useMdnsBtn = document.getElementById('useMdnsBtn') as HTMLButtonElement;
  const useRawIpBtn = document.getElementById('useRawIpBtn') as HTMLButtonElement;
  
  let networkUrls = { mdns: '', raw_ip: '' };
  let pendingList: string[] = [];

  openNewEventModalBtn.addEventListener('click', () => {
      newEventModal.classList.remove('hidden');
      newEventModal.classList.add('flex');
  });

  closeModalBtn.addEventListener('click', () => {
      newEventModal.classList.add('hidden');
      newEventModal.classList.remove('flex');
  });

  const cloudKeySelect = document.getElementById('cloudKeySelect') as HTMLSelectElement;

  // UX TOUCH: If they select a cloud key, disable the manual box. Vice versa.
  cloudKeySelect.addEventListener('change', () => {
      licenseKeyInput.disabled = !!cloudKeySelect.value;
      if (cloudKeySelect.value) { licenseKeyInput.value = ''; licenseKeyInput.classList.add('opacity-50'); }
      else { licenseKeyInput.classList.remove('opacity-50'); }
  });

  licenseKeyInput.addEventListener('input', () => {
      cloudKeySelect.disabled = !!licenseKeyInput.value.trim();
      if (licenseKeyInput.value.trim()) { cloudKeySelect.value = ''; cloudKeySelect.classList.add('opacity-50'); }
      else { cloudKeySelect.classList.remove('opacity-50'); }
  });

  modalLaunchBtn.addEventListener('click', async () => {
    const name = eventNameInput.value.trim();
    const cloudKey = cloudKeySelect.value;
    const manualKey = licenseKeyInput.value.trim();
    const key = cloudKey || manualKey; // Use whichever one they provided
    
    if (!name) return showUIError("Please enter an Event Name.");
    if (!key) return showUIError("Please select or enter a License Key.");

    modalLaunchBtn.textContent = "Validating Key...";
    modalLaunchBtn.disabled = true;

    try {
        const fakeExpiresAt = new Date(Date.now() + 12 * 60 * 60 * 1000).toISOString();

        const quality = localStorage.getItem('ws_compression_quality') || 'balanced';
        const guestCamToggle = document.getElementById('guestCamToggle') as HTMLInputElement;
        const isGuestCamEnabled = guestCamToggle ? guestCamToggle.checked : true;

        const result = await invoke<{event_id: string, server_url: string, event_name: string}>('start_event', {
            eventName: name,
            licenseKey: key, 
            photoLimit: null,
            expiresAt: fakeExpiresAt,
            storagePath: MASTER_STORAGE_PATH,
            compressionQuality: quality,
            guestCamEnabled: isGuestCamEnabled // <--- SEND TOGGLE STATE TO RUST
        });

        // --- PHASE 2: THE CLOUD BURNER ---
        if (cloudKey) {
            // If they used a cloud key, update Supabase to mark it as permanently used
            const { error: burnError } = await supabase
                .from('license_keys')
                .update({ status: 'used', used_at: new Date().toISOString() })
                .eq('key', cloudKey);
            
            if (burnError) console.error("Failed to mark key as used:", burnError);
            
            // Refresh the dashboard list so the burned key disappears from the UI
            await fetchAndPopulateLicenses(activeUserId);
            
        }
        // ---------------------------------

        activeEventName.textContent = result.event_name;
        
        newEventModal.classList.add('hidden');
        newEventModal.classList.remove('flex');
        accountHubScreen.classList.add('hidden');
        accountHubScreen.classList.remove('flex');
        dashboardScreen.classList.remove('hidden');
        dashboardScreen.classList.add('flex');
        
        refreshQueue();
        // Apply Default Auto-Approve preference
        autoApproveToggle.checked = localStorage.getItem('ws_default_auto_approve') === 'true';
        startEventTimer(result.event_id, fakeExpiresAt);

    } catch (e) {
        showUIError(String(e));
        modalLaunchBtn.textContent = "Validate & Launch";
        modalLaunchBtn.disabled = false;
    }
  });

  endEventBtn.addEventListener('click', () => {
    showUIConfirm("Guests will be disconnected and the gallery will lock.", "Yes, End Event", async () => {
        endEventBtn.textContent = "Shutting Down...";
        endEventBtn.disabled = true;

        try {
            const report = await invoke<{
                event_id: string, owner_id: string | null, event_name: string, duration_minutes: number, 
                started_at: string, ended_at: string, total_photos: number,
                photos_approved: number, photos_rejected: number, archive_path: string
            }>('end_event', { storagePath: MASTER_STORAGE_PATH });

            // --- PHASE 3: INSTANT CLOUD SYNC ---
            if (report.owner_id) {
                const { error } = await supabase.from('events_history').insert({
                    owner_id: report.owner_id, event_name: report.event_name, started_at: report.started_at,
                    ended_at: report.ended_at, total_photos: report.total_photos, 
                    archive_path: report.archive_path
                });
                // If it uploads successfully, tell SQLite to remove it from the pending queue!
                if (!error) {
                    await invoke('mark_event_synced', { eventId: report.event_id });
                }
            }
            // Refresh Dashboard numbers!
            await fetchDashboardMetrics(activeUserId);
            // -----------------------------------

            document.getElementById('reportEventName')!.textContent = report.event_name;
            document.getElementById('reportDuration')!.textContent = `${report.duration_minutes} min`;
            document.getElementById('reportApproved')!.textContent = report.photos_approved.toString();
            document.getElementById('reportRejected')!.textContent = report.photos_rejected.toString();
            document.getElementById('reportArchivePath')!.textContent = report.archive_path;

            dashboardScreen.classList.add('hidden');
            dashboardScreen.classList.remove('flex');
            reportScreen.classList.remove('hidden');
            reportScreen.classList.add('flex');

            let resetBtn = document.getElementById('resetAppBtn');
            if (!resetBtn) {
                resetBtn = document.createElement('button');
                resetBtn.id = 'resetAppBtn';
                resetBtn.textContent = "Close & Return to Home";
                resetBtn.className = "mt-8 w-full py-3 bg-[#0ABAB5] hover:bg-[#099a95] text-black font-bold rounded-lg transition-colors shadow-lg";
                resetBtn.onclick = () => window.location.reload(); 
                reportScreen.appendChild(resetBtn);
            }

        } catch (e) {
            console.error("Failed to end event:", e);
            showUIError(`Error ending event: ${e}`);
            endEventBtn.textContent = "End Event";
            endEventBtn.disabled = false;
        }
    });
  });

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

  async function refreshStats() {
    try {
      const stats = await invoke<{approved: number, rejected: number}>('get_event_stats');
      // Update both the hidden old stats and the new tab headers
      if (statApproved) statApproved.textContent = stats.approved.toString();
      if (statRejected) statRejected.textContent = stats.rejected.toString();
      statApprovedTab.textContent = stats.approved.toString();
      statRejectedTab.textContent = stats.rejected.toString();
    } catch (e) {
      console.error("Failed to fetch stats:", e);
    }
  }


  // --- MULTI-STATE QUEUE ENGINE ---
  const approvedGrid = document.getElementById('approvedGrid') as HTMLElement;
  const approvedEmpty = document.getElementById('approvedEmpty') as HTMLElement;
  const rejectedGrid = document.getElementById('rejectedGrid') as HTMLElement;
  const rejectedEmpty = document.getElementById('rejectedEmpty') as HTMLElement;

  let approvedList: string[] = [];
  let rejectedList: string[] = [];

  // The Master Fetcher (Resolves your 'refreshQueue' error!)
  async function refreshQueue() {
      try {
          // Fetch all three arrays from the SSD / SQLite
          pendingList = await invoke<string[]>('get_pending_photos', { targetDir: PATHS.pending });
          approvedList = await invoke<string[]>('get_approved_photos', { targetDir: PATHS.gallery });
          rejectedList = await invoke<string[]>('get_rejected_photos', { targetDir: PATHS.rejected });
          
          renderAllGrids();
          refreshStats();
      } catch (e) {
          console.error("Failed to refresh queues:", e);
      }
  }

  // The Master UI Renderer
  function renderAllGrids() {
      queueCount.textContent = pendingList.length.toString();
      renderSpecificGrid(pendingList, pendingGrid, queueEmpty, 'pending');
      renderSpecificGrid(approvedList, approvedGrid, approvedEmpty, 'approved');
      renderSpecificGrid(rejectedList, rejectedGrid, rejectedEmpty, 'rejected');
  }

  // Dynamic Card Generator
  function renderSpecificGrid(list: string[], gridElement: HTMLElement, emptyElement: HTMLElement, type: 'pending' | 'approved' | 'rejected') {
      gridElement.innerHTML = '';
      
      if (list.length === 0) {
          emptyElement.classList.remove('hidden');
          gridElement.classList.add('hidden');
          return;
      }

      emptyElement.classList.add('hidden');
      gridElement.classList.remove('hidden');

      // Determine where the image currently lives on the SSD
      let folderPath = PATHS.pending;
      if (type === 'approved') folderPath = PATHS.gallery;
      if (type === 'rejected') folderPath = PATHS.rejected;

      list.forEach(filename => {
          // THE FIX: Instantly identify if the photo came from a guest phone!
          const isGuest = filename.startsWith('guest_');

          const card = document.createElement('div');
          card.className = 'bg-gray-800 rounded-lg overflow-hidden border border-gray-700 shadow flex flex-col group relative';
          
          // THE FIX: Add the Visual Badge requested in Phase 4
          if (isGuest) {
              const badge = document.createElement('div');
              badge.className = 'absolute top-2 left-2 bg-[#0ABAB5] text-black text-[10px] font-black px-2 py-1 rounded shadow-md uppercase tracking-wider z-10';
              badge.textContent = 'Guest Cam';
              card.appendChild(badge);
          }

          const img = document.createElement('img');
          img.className = 'w-full aspect-square object-cover bg-gray-800 animate-pulse';
          
          invoke<number[]>('read_image_file', { path: `${folderPath}/${filename}` })
            .then(bytes => {
              const blob = new Blob([new Uint8Array(bytes)], { type: 'image/jpeg' });
              img.src = URL.createObjectURL(blob);
              img.classList.remove('animate-pulse');
            })
            .catch(e => console.error("Failed to load image:", e));
          
          const btnRow = document.createElement('div');
          btnRow.className = 'flex w-full border-t border-gray-700';

          // Inject specific buttons based on which tab we are looking at!
          if (type === 'pending') {
              btnRow.className += ' divide-x divide-gray-700';
              
              const rejectBtn = document.createElement('button');
              rejectBtn.textContent = 'Reject';
              rejectBtn.className = 'flex-1 py-2 text-sm font-medium text-red-400 hover:bg-gray-700 hover:text-red-300 transition-colors';
              rejectBtn.onclick = () => processAction('reject', filename, PATHS.pending);

              const approveBtn = document.createElement('button');
              approveBtn.textContent = 'Approve';
              approveBtn.className = 'flex-1 py-2 text-sm font-bold text-[#0ABAB5] hover:bg-gray-700 hover:text-[#0cddcf] transition-colors';
              approveBtn.onclick = () => processAction('approve', filename, PATHS.pending);

              btnRow.appendChild(rejectBtn);
              btnRow.appendChild(approveBtn);
          } 
          else if (type === 'approved') {
              const rejectBtn = document.createElement('button');
              rejectBtn.textContent = 'Reject & Remove from Gallery';
              rejectBtn.className = 'flex-1 py-2 text-sm font-medium text-red-400 hover:bg-red-500/10 transition-colors';
              rejectBtn.onclick = () => processAction('reject', filename, PATHS.gallery);
              btnRow.appendChild(rejectBtn);
          }
          else if (type === 'rejected') {
              const approveBtn = document.createElement('button');
              approveBtn.textContent = 'Approve & Publish';
              approveBtn.className = 'flex-1 py-2 text-sm font-medium text-[#0ABAB5] hover:bg-[#0ABAB5]/10 transition-colors';
              approveBtn.onclick = () => processAction('approve', filename, PATHS.rejected);
              btnRow.appendChild(approveBtn);
          }

          card.appendChild(img);
          card.appendChild(btnRow);
          gridElement.appendChild(card);
      });
  }

  // The Master File Router
  async function processAction(action: 'approve' | 'reject', filename: string, sourceDir: string) {
      try {
          if (action === 'approve') {
              await invoke('approve_photo', { filename, sourceDir: sourceDir, galleryDir: PATHS.gallery });
          } else {
              await invoke('reject_photo', { filename, sourceDir: sourceDir, rejectedDir: PATHS.rejected });
          }
          
          
          
          // Re-fetch everything from SQLite to ensure perfect UI sync
          await refreshQueue();
      } catch (e) {
          console.error(e);
          showUIError(`Failed to ${action} ${filename}. Error: ${e}`);
          refreshQueue(); 
      }
  }

  // Background Watcher Listener
  listen<string>('new_pending_photo', async (event) => {
      const filename = event.payload;
      const isGuest = filename.startsWith('guest_');

      // THE FIX: Auto-Approve only triggers if it is NOT a guest photo!
      if (autoApproveToggle.checked && !isGuest) {
          setTimeout(async () => {
              await processAction('approve', filename, PATHS.pending);
          }, 500);
      } else {
          refreshQueue(); // Guest photos stay here manually waiting for you!
      }
  });

  // Restore the live guest counter!
  listen<number>('guest_count_update', (e) => {
      if (guestCount) guestCount.textContent = e.payload.toString();
  });

  // Removed the unused 'event' parameter
  listen<string>('force_lock_ui', () => {
      document.getElementById('dashboardScreen')!.classList.add('hidden');
      document.getElementById('dashboardScreen')!.classList.remove('flex');
      
      showUIError("LICENSE EXPIRED: The time window for this event has closed. The local server and image processor have been terminated. Please purchase a new license to start a new event.");
      
      document.getElementById('closeAlertBtn')!.style.display = 'none';

      const alertBox = document.getElementById('customAlertText')!.parentElement;
      if (alertBox && !document.getElementById('fatalResetBtn')) {
          const resetBtn = document.createElement('button');
          resetBtn.id = 'fatalResetBtn';
          resetBtn.textContent = "Return to Start Screen";
          resetBtn.className = "mt-6 w-full py-3 bg-[#0ABAB5] hover:bg-[#099a95] text-black font-bold rounded-lg transition-colors shadow-lg";
          resetBtn.onclick = () => window.location.reload(); 
          alertBox.appendChild(resetBtn);
      }
  });
  // --- SETTINGS: ACTION BUTTONS ---
  const signOutBtn = document.getElementById('signOutBtn');
  if (signOutBtn) {
      signOutBtn.addEventListener('click', async () => {
          showUIConfirm("Are you sure you want to sign out? You will need internet access to log back in.", "Sign Out", async () => {
              signOutBtn.textContent = "Signing Out...";
              await supabase.auth.signOut();
              try {
                  await invoke('sign_out_user'); // We will build this in Rust next!
              } catch (e) {
                  console.error("Rust sign out failed:", e);
              }
              window.location.reload(); // Instantly reboot the app to the Start Screen
          });
      });
  }

  const clearCacheBtn = document.getElementById('clearCacheBtn');
  if (clearCacheBtn) {
      clearCacheBtn.addEventListener('click', () => {
          showUIConfirm("This will permanently delete all un-archived photos in the pending and rejected queues. Proceed?", "Clear Cache", async () => {
              try {
                  await invoke('clear_storage_cache', { storagePath: MASTER_STORAGE_PATH }); // We will build this in Rust next!
                  showUIError("Local data cache cleared successfully!"); // Reusing your alert UI for a success message
              } catch (e) {
                  showUIError("Failed to clear cache: " + e);
              }
          });
      });
  }
});