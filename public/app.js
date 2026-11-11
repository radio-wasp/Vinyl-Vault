// VinylVault Frontend Application — Manual Discogs Search & Two-Way Discogs Collection Sync

const state = {
  authenticated: false,
  albums: [],
  networkInfo: null,
  importingDiscogs: false
};

// DOM Elements
const els = {
  loginScreen: document.getElementById('login-screen'),
  loginForm: document.getElementById('login-form'),
  loginPassword: document.getElementById('login-password'),
  loginError: document.getElementById('login-error'),
  appShell: document.getElementById('app-shell'),
  btnLogout: document.getElementById('btn-logout'),
  btnPullDiscogsTop: document.getElementById('btn-pull-discogs-top'),
  countBadge: document.getElementById('collection-count-badge'),
  setupBanner: document.getElementById('setup-banner'),
  btnOpenSetup: document.getElementById('btn-open-setup'),

  // Collection
  collectionSearch: document.getElementById('collection-search'),
  collectionSort: document.getElementById('collection-sort'),
  collectionEmpty: document.getElementById('collection-empty'),
  btnEmptyPullDiscogs: document.getElementById('btn-empty-pull-discogs'),
  btnEmptyGoAdd: document.getElementById('btn-empty-go-add'),
  collectionGrid: document.getElementById('collection-grid'),

  // Manual Search & Add Tab
  manualSearchForm: document.getElementById('manual-search-form'),
  searchQuery: document.getElementById('search-query'),
  searchArtist: document.getElementById('search-artist'),
  searchTitle: document.getElementById('search-title'),
  searchCatno: document.getElementById('search-catno'),
  searchBarcode: document.getElementById('search-barcode'),
  btnRunSearch: document.getElementById('btn-run-search'),
  btnClearSearch: document.getElementById('btn-clear-search'),
  searchStatusReadout: document.getElementById('search-status-readout'),
  searchCandidates: document.getElementById('search-candidates'),

  // Settings & Discogs Sync
  btnImportDiscogs: document.getElementById('btn-import-discogs'),
  importFeedback: document.getElementById('import-feedback'),
  settingsForm: document.getElementById('settings-form'),
  setDiscogsToken: document.getElementById('set-discogs-token'),
  btnTestDiscogs: document.getElementById('btn-test-discogs'),
  setDiscogsUsername: document.getElementById('set-discogs-username'),
  setDiscogsFolder: document.getElementById('set-discogs-folder'),
  setAppPassword: document.getElementById('set-app-password'),
  settingsFeedback: document.getElementById('settings-feedback'),
  networkUrls: document.getElementById('network-urls'),

  // Modal & Nav
  albumModal: document.getElementById('album-modal'),
  btnCloseModal: document.getElementById('btn-close-modal'),
  modalBody: document.getElementById('modal-body'),
  toastContainer: document.getElementById('toast-container'),
  navItems: document.querySelectorAll('.nav-item')
};

// SVG Fallback Cover Placeholder
const FALLBACK_COVER = 'data:image/svg+xml;utf8,' + encodeURIComponent(`
  <svg xmlns="http://www.w3.org/2000/svg" width="300" height="300" viewBox="0 0 300 300">
    <rect width="300" height="300" fill="#14141b"/>
    <circle cx="150" cy="150" r="110" fill="#09090d" stroke="#292938" stroke-width="4"/>
    <circle cx="150" cy="150" r="80" fill="none" stroke="#1e1e2a" stroke-width="2"/>
    <circle cx="150" cy="150" r="55" fill="none" stroke="#1e1e2a" stroke-width="2"/>
    <circle cx="150" cy="150" r="34" fill="#f59e0b"/>
    <circle cx="150" cy="150" r="8" fill="#14141b"/>
  </svg>
`);

// --- INITIALIZATION ---

async function initApp() {
  bindEvents();
  await checkAuthStatus();
}

async function checkAuthStatus() {
  try {
    const res = await fetch('/api/auth/status');
    const data = await res.json();
    state.networkInfo = data.network;

    if (!data.authenticated) {
      els.loginScreen.classList.remove('hidden');
      els.appShell.classList.add('hidden');
      return;
    }

    state.authenticated = true;
    els.loginScreen.classList.add('hidden');
    els.appShell.classList.remove('hidden');

    updateSetupBanner(data.configured);
    renderNetworkUrls(data.network);
    await Promise.all([loadCollection(), loadSettings()]);
  } catch (err) {
    console.error('Auth status check failed:', err);
  }
}

function updateSetupBanner(configured) {
  if (!configured?.discogs) {
    els.setupBanner.classList.remove('hidden');
  } else {
    els.setupBanner.classList.add('hidden');
  }
}

function renderNetworkUrls(network) {
  if (!network || !els.networkUrls) return;
  els.networkUrls.innerHTML = '';
  const ips = (network.ips || []).filter(ip => ip !== '127.0.0.1');
  if (ips.length === 0) ips.push('localhost');

  ips.forEach(ip => {
    const httpUrl = `http://${ip}:${network.httpPort || 3000}`;
    const li = document.createElement('li');
    li.innerHTML = `<a href="${httpUrl}" target="_blank" rel="noopener">${httpUrl}</a>`;
    els.networkUrls.appendChild(li);
  });
}

// --- EVENT BINDINGS ---

function bindEvents() {
  els.loginForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    els.loginError.classList.add('hidden');
    const password = els.loginPassword.value;
    const res = await fetch('/api/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password })
    });
    if (res.ok) {
      els.loginPassword.value = '';
      await checkAuthStatus();
    } else {
      const err = await res.json();
      els.loginError.textContent = err.error || 'Login failed';
      els.loginError.classList.remove('hidden');
    }
  });

  els.btnLogout.addEventListener('click', async () => {
    await fetch('/api/auth/logout', { method: 'POST' });
    await checkAuthStatus();
  });

  els.btnOpenSetup.addEventListener('click', () => switchTab('settings'));

  // Pull Discogs Collection buttons (Header, Empty State, and Settings)
  if (els.btnPullDiscogsTop) {
    els.btnPullDiscogsTop.addEventListener('click', pullDiscogsCollection);
  }
  if (els.btnEmptyPullDiscogs) {
    els.btnEmptyPullDiscogs.addEventListener('click', pullDiscogsCollection);
  }
  if (els.btnImportDiscogs) {
    els.btnImportDiscogs.addEventListener('click', pullDiscogsCollection);
  }
  if (els.btnEmptyGoAdd) {
    els.btnEmptyGoAdd.addEventListener('click', () => switchTab('add'));
  }

  // Bottom Navigation
  els.navItems.forEach(btn => {
    btn.addEventListener('click', () => {
      switchTab(btn.dataset.tab);
    });
  });

  // Manual search form
  els.manualSearchForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    await runManualSearch();
  });

  els.btnClearSearch.addEventListener('click', () => {
    els.searchQuery.value = '';
    els.searchArtist.value = '';
    els.searchTitle.value = '';
    els.searchCatno.value = '';
    els.searchBarcode.value = '';
    els.searchCandidates.innerHTML = '';
    els.searchStatusReadout.textContent = 'Enter an album above and press Search Discogs.';
  });

  // Collection Filter & Sort
  els.collectionSearch.addEventListener('input', () => loadCollection());
  els.collectionSort.addEventListener('change', () => loadCollection());

  // Settings Form
  els.settingsForm.addEventListener('submit', saveSettings);
  if (els.btnTestDiscogs) {
    els.btnTestDiscogs.addEventListener('click', testDiscogsConnection);
  }

  // Modal Close
  els.btnCloseModal.addEventListener('click', closeModal);
  els.albumModal.addEventListener('click', (e) => {
    if (e.target === els.albumModal) closeModal();
  });
}

function switchTab(tabName) {
  els.navItems.forEach(item => {
    item.classList.toggle('active', item.dataset.tab === tabName);
  });
  document.querySelectorAll('.tab-view').forEach(view => {
    view.classList.toggle('active', view.id === `tab-${tabName}`);
  });

  if (tabName === 'collection') {
    loadCollection();
  }
}

// --- MANUAL DISCOGS SEARCH & ADD ---

async function runManualSearch() {
  const q = els.searchQuery.value.trim();
  const artist = els.searchArtist.value.trim();
  const title = els.searchTitle.value.trim();
  const catno = els.searchCatno.value.trim();
  const barcode = els.searchBarcode.value.trim();

  if (!q && !artist && !title && !catno && !barcode) {
    showToast('Please enter at least one search field (Artist, Title, Catalog #, Barcode, or Quick Search).');
    return;
  }

  els.btnRunSearch.disabled = true;
  els.btnRunSearch.textContent = 'Searching...';
  els.searchStatusReadout.textContent = 'Querying Discogs database...';

  try {
    const params = new URLSearchParams();
    if (q) params.set('q', q);
    if (artist) params.set('artist', artist);
    if (title) params.set('title', title);
    if (catno) params.set('catno', catno);
    if (barcode) params.set('barcode', barcode);

    const res = await fetch(`/api/scan/search?${params.toString()}`);
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Search failed');

    const count = data.results?.length || 0;
    els.searchStatusReadout.textContent = `Found ${count} matching vinyl release${count === 1 ? '' : 's'}`;
    renderCandidates(data.results || []);
  } catch (err) {
    els.searchStatusReadout.textContent = `Error: ${err.message}`;
  } finally {
    els.btnRunSearch.disabled = false;
    els.btnRunSearch.textContent = '🔍 Search Discogs';
  }
}

function renderCandidates(candidates) {
  els.searchCandidates.innerHTML = '';
  if (!candidates || candidates.length === 0) {
    els.searchCandidates.innerHTML = `<div style="color:var(--text-muted);font-size:0.84rem;">No matching vinyl releases found on Discogs.</div>`;
    return;
  }

  candidates.forEach((item, index) => {
    const card = document.createElement('div');
    card.className = 'candidate-card';

    const coverSrc = item.cover_url || FALLBACK_COVER;
    const metaParts = [item.year, item.label, item.catno, item.country].filter(Boolean).join(' • ');

    card.innerHTML = `
      <img class="candidate-cover" src="${escapeHtml(coverSrc)}" alt="Cover" onerror="this.src='${FALLBACK_COVER}'" />
      <div class="candidate-info">
        <div class="candidate-title">${escapeHtml(item.title)}</div>
        <div class="candidate-artist">${escapeHtml(item.artist)}</div>
        <div class="candidate-meta">${escapeHtml(metaParts || 'Vinyl LP')}</div>
      </div>
      <div>
        ${
          item.in_collection
            ? `<button class="btn btn-success btn-xs" disabled>✓ In Crate</button>`
            : `<button class="btn btn-primary btn-xs" data-add-idx="${index}">+ Add &amp; Sync</button>`
        }
      </div>
    `;

    const addBtn = card.querySelector('[data-add-idx]');
    if (addBtn) {
      addBtn.addEventListener('click', async () => {
        addBtn.disabled = true;
        addBtn.textContent = 'Syncing...';
        await addCandidateToCollection(item);
        item.in_collection = true;
        renderCandidates(candidates);
      });
    }

    els.searchCandidates.appendChild(card);
  });
}

async function addCandidateToCollection(candidate) {
  try {
    const res = await fetch('/api/collection', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(candidate)
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Failed to add album');

    candidate.in_collection = true;
    if (data.discogsSync?.synced) {
      showToast(`✅ Added: ${candidate.artist} — ${candidate.title} (+ Synced to Discogs @${data.discogsSync.username}!)`);
    } else if (data.discogsSync?.error) {
      showToast(`⚠️ Saved locally, but Discogs Sync failed: ${data.discogsSync.error}`);
    } else {
      showToast(`✅ Added: ${candidate.artist} — ${candidate.title}`);
    }
    await loadCollection();
  } catch (err) {
    showToast(`❌ Error: ${err.message}`);
  }
}

// --- PULL EXISTING DISCOGS COLLECTION ---

async function pullDiscogsCollection() {
  if (state.importingDiscogs) return;
  state.importingDiscogs = true;

  const btns = [els.btnPullDiscogsTop, els.btnEmptyPullDiscogs, els.btnImportDiscogs].filter(Boolean);
  btns.forEach(b => {
    b.disabled = true;
    b.dataset.origText = b.textContent;
    b.textContent = '⏳ Pulling from Discogs...';
  });

  if (els.importFeedback) {
    els.importFeedback.classList.add('hidden');
  }

  showToast('🔄 Pulling your existing collection from Discogs (and caching cover art)...');

  try {
    const res = await fetch('/api/collection/import-discogs', {
      method: 'POST'
    });
    const data = await res.json();
    if (!res.ok) {
      throw new Error(data.error || 'Failed to pull Discogs collection');
    }

    const msg = `✅ Pulled ${data.totalFetched} records from @${data.username}'s Discogs Collection (${data.importedCount} new, ${data.updatedCount} updated)!`;
    showToast(msg);

    if (els.importFeedback) {
      els.importFeedback.style.background = 'rgba(16, 185, 129, 0.16)';
      els.importFeedback.style.color = '#6ee7b7';
      els.importFeedback.textContent = msg;
      els.importFeedback.classList.remove('hidden');
    }

    await loadCollection();
  } catch (err) {
    showToast(`❌ ${err.message}`);
    if (els.importFeedback) {
      els.importFeedback.style.background = 'rgba(239, 68, 68, 0.18)';
      els.importFeedback.style.color = '#fca5a5';
      els.importFeedback.textContent = `❌ ${err.message}`;
      els.importFeedback.classList.remove('hidden');
    }
  } finally {
    state.importingDiscogs = false;
    btns.forEach(b => {
      b.disabled = false;
      b.textContent = b.dataset.origText || '⬇ Pull Discogs Collection';
    });
  }
}

// --- COLLECTION MANAGEMENT ---

async function loadCollection() {
  const search = els.collectionSearch.value.trim();
  const sort = els.collectionSort.value;

  const params = new URLSearchParams({ search, sort });
  const res = await fetch(`/api/collection?${params.toString()}`);
  if (!res.ok) return;
  const data = await res.json();

  state.albums = data.albums || [];
  els.countBadge.textContent = `${state.albums.length} ${state.albums.length === 1 ? 'LP' : 'LPs'}`;

  if (state.albums.length === 0) {
    els.collectionEmpty.classList.remove('hidden');
    els.collectionGrid.innerHTML = '';
    return;
  }

  els.collectionEmpty.classList.add('hidden');
  els.collectionGrid.innerHTML = '';

  state.albums.forEach(album => {
    const card = document.createElement('div');
    card.className = 'album-card';
    const coverSrc = album.local_cover || album.cover_url || FALLBACK_COVER;
    const labelInfo = [album.label, album.catno].filter(Boolean).join(' • ');

    card.innerHTML = `
      <div class="album-art-wrap">
        <img src="${escapeHtml(coverSrc)}" alt="${escapeHtml(album.title)}" loading="lazy" onerror="this.src='${FALLBACK_COVER}'" />
        ${album.discogs_synced ? `<span class="discogs-sync-badge" title="Synced with your Discogs Collection">✓ Discogs</span>` : ''}
        ${album.year ? `<span class="album-year-badge">${album.year}</span>` : ''}
      </div>
      <div class="album-card-body">
        <div class="album-card-title">${escapeHtml(album.title)}</div>
        <div class="album-card-artist">${escapeHtml(album.artist)}</div>
        ${labelInfo ? `<div class="album-card-label">${escapeHtml(labelInfo)}</div>` : ''}
      </div>
    `;

    card.addEventListener('click', () => openAlbumModal(album));
    els.collectionGrid.appendChild(card);
  });
}

function openAlbumModal(album) {
  const coverSrc = album.local_cover || album.cover_url || FALLBACK_COVER;
  const genres = [...(album.genres || []), ...(album.styles || [])].join(', ');
  const metaLine = [album.year, album.country, album.label, album.catno].filter(Boolean).join(' • ');

  const trackRows = (album.tracklist || [])
    .map(t => `
      <tr>
        <td class="track-pos">${escapeHtml(t.position || '-')}</td>
        <td>${escapeHtml(t.title || '')}</td>
        <td class="track-dur">${escapeHtml(t.duration || '')}</td>
      </tr>
    `)
    .join('');

  els.modalBody.innerHTML = `
    <div class="modal-header-detail">
      <img class="modal-cover-lg" src="${escapeHtml(coverSrc)}" alt="Cover" onerror="this.src='${FALLBACK_COVER}'" />
      <div>
        <h2 style="font-size:1.25rem;margin-bottom:4px;">${escapeHtml(album.title)}</h2>
        <div style="color:var(--accent);font-weight:600;margin-bottom:6px;">${escapeHtml(album.artist)}</div>
        <div style="color:var(--text-muted);font-size:0.8rem;margin-bottom:6px;">${escapeHtml(metaLine)}</div>
        ${genres ? `<div style="font-size:0.76rem;color:var(--text-muted);">${escapeHtml(genres)}</div>` : ''}
        <div style="display:flex;align-items:center;gap:10px;margin-top:8px;flex-wrap:wrap;">
          ${
            album.discogs_url
              ? `<a href="${escapeHtml(album.discogs_url)}" target="_blank" rel="noopener" style="font-size:0.78rem;color:var(--accent);">View on Discogs ↗</a>`
              : ''
          }
          ${
            album.discogs_synced
              ? `<span style="font-size:0.75rem;color:var(--success);font-weight:600;">✓ Synced to Discogs Collection</span>`
              : `<button type="button" id="btn-sync-discogs-now" class="btn btn-xs">Sync to Discogs Now</button>`
          }
        </div>
      </div>
    </div>

    ${
      trackRows
        ? `<h4 style="font-size:0.86rem;color:var(--text-muted);text-transform:uppercase;letter-spacing:0.04em;">Tracklist</h4>
           <table class="tracklist-table"><tbody>${trackRows}</tbody></table>`
        : ''
    }

    <form id="modal-edit-form">
      <div class="input-group">
        <label>Sleeve / Media Condition</label>
        <select id="edit-condition">
          ${['M (Mint)', 'NM (Near Mint)', 'VG+ (Very Good Plus)', 'VG (Very Good)', 'G+ (Good Plus)'].map(
            c => `<option value="${c}" ${album.condition === c ? 'selected' : ''}>${c}</option>`
          ).join('')}
        </select>
      </div>
      <div class="input-group">
        <label>Personal Notes / Pressing Details</label>
        <textarea id="edit-notes" rows="2" placeholder="e.g. 180g audiophile pressing, gatefold sleeve...">${escapeHtml(album.notes || '')}</textarea>
      </div>
      <div style="display:flex;gap:10px;margin-top:14px;">
        <button type="submit" class="btn btn-primary" style="flex:1;">Save Notes</button>
        <button type="button" id="btn-delete-album" class="btn btn-danger">Remove LP</button>
      </div>
    </form>
  `;

  const syncNowBtn = document.getElementById('btn-sync-discogs-now');
  if (syncNowBtn) {
    syncNowBtn.addEventListener('click', async () => {
      syncNowBtn.disabled = true;
      syncNowBtn.textContent = 'Syncing...';
      try {
        const res = await fetch(`/api/collection/${album.id}/sync-discogs`, { method: 'POST' });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || 'Sync failed');
        showToast('✅ Synced album to your Discogs Collection!');
        await loadCollection();
        openAlbumModal(data.album);
      } catch (err) {
        showToast(`❌ Discogs Sync Error: ${err.message}`);
        syncNowBtn.disabled = false;
        syncNowBtn.textContent = 'Sync to Discogs Now';
      }
    });
  }

  document.getElementById('modal-edit-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const condition = document.getElementById('edit-condition').value;
    const notes = document.getElementById('edit-notes').value;
    await fetch(`/api/collection/${album.id}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ condition, notes })
    });
    showToast('Saved album notes');
    closeModal();
    await loadCollection();
  });

  document.getElementById('btn-delete-album').addEventListener('click', async () => {
    await fetch(`/api/collection/${album.id}`, { method: 'DELETE' });
    showToast(`Removed "${album.title}" from collection`);
    closeModal();
    await loadCollection();
  });

  els.albumModal.classList.remove('hidden');
}

function closeModal() {
  els.albumModal.classList.add('hidden');
}

// --- SETTINGS ---

async function loadSettings() {
  const res = await fetch('/api/settings');
  if (!res.ok) return;
  const s = await res.json();

  els.setDiscogsUsername.value = s.DISCOGS_USERNAME || '';
  els.setDiscogsFolder.value = s.DISCOGS_FOLDER_ID || '1';
  if (s.discogsTokenMasked) els.setDiscogsToken.value = s.discogsTokenMasked;
}

async function saveSettings(e) {
  e.preventDefault();
  els.settingsFeedback.classList.add('hidden');

  const payload = {
    DISCOGS_TOKEN: els.setDiscogsToken.value,
    DISCOGS_USERNAME: els.setDiscogsUsername.value,
    DISCOGS_FOLDER_ID: els.setDiscogsFolder.value,
    APP_PASSWORD: els.setAppPassword.value
  };

  const res = await fetch('/api/settings', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload)
  });

  if (res.ok) {
    const data = await res.json();
    if (data.discogsUsername) {
      els.setDiscogsUsername.value = data.discogsUsername;
    }
    els.setAppPassword.value = '';
    if (data.discogsError) {
      els.settingsFeedback.style.background = 'rgba(239, 68, 68, 0.18)';
      els.settingsFeedback.style.color = '#fca5a5';
      els.settingsFeedback.textContent = `⚠️ Settings saved, but Discogs token failed: ${data.discogsError}`;
    } else {
      els.settingsFeedback.style.background = 'rgba(16, 185, 129, 0.16)';
      els.settingsFeedback.style.color = '#6ee7b7';
      els.settingsFeedback.textContent = `✅ Configuration saved!${data.discogsUsername ? ` Connected to Discogs as @${data.discogsUsername}.` : ''}`;
    }
    els.settingsFeedback.classList.remove('hidden');
    await checkAuthStatus();
  }
}

async function testDiscogsConnection() {
  els.settingsFeedback.classList.add('hidden');
  els.btnTestDiscogs.disabled = true;
  els.btnTestDiscogs.textContent = 'Testing...';
  try {
    const res = await fetch('/api/settings/test-discogs', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ DISCOGS_TOKEN: els.setDiscogsToken.value })
    });
    const data = await res.json();
    if (!res.ok) {
      throw new Error(data.error || 'Discogs token verification failed');
    }
    els.setDiscogsUsername.value = data.username;
    els.settingsFeedback.style.background = 'rgba(16, 185, 129, 0.16)';
    els.settingsFeedback.style.color = '#6ee7b7';
    els.settingsFeedback.textContent = `✅ Connected to Discogs as @${data.username}! Collection sync is ready.`;
    els.settingsFeedback.classList.remove('hidden');
    await checkAuthStatus();
  } catch (err) {
    els.settingsFeedback.style.background = 'rgba(239, 68, 68, 0.18)';
    els.settingsFeedback.style.color = '#fca5a5';
    els.settingsFeedback.textContent = `❌ ${err.message}`;
    els.settingsFeedback.classList.remove('hidden');
  } finally {
    els.btnTestDiscogs.disabled = false;
    els.btnTestDiscogs.textContent = 'Test Token';
  }
}

// --- UTILITIES ---

function showToast(msg) {
  const t = document.createElement('div');
  t.className = 'toast';
  t.textContent = msg;
  els.toastContainer.appendChild(t);
  setTimeout(() => {
    t.remove();
  }, 4000);
}

function escapeHtml(str) {
  return String(str || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

document.addEventListener('DOMContentLoaded', initApp);
