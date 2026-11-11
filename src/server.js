require('dotenv').config();
const express = require('express');
const http = require('http');
const https = require('https');
const path = require('path');
const crypto = require('crypto');
const cookieParser = require('cookie-parser');

const {
  DATA_DIR,
  getSetting,
  setSetting,
  getAllAlbums,
  getAlbumById,
  getAlbumByDiscogsId,
  addAlbum,
  updateAlbum,
  deleteAlbum
} = require('./db');
const {
  searchDiscogs,
  getReleaseDetails,
  searchItunesFallback,
  downloadCoverImage,
  getDiscogsUsername,
  addReleaseToDiscogsCollection,
  removeReleaseFromDiscogsCollection,
  fetchUserDiscogsCollection
} = require('./discogs');
const { ensureCertificates, getLocalIpAddresses } = require('./certs');

const app = express();
const PORT = parseInt(process.env.PORT || '3000', 10);
const HTTPS_PORT = parseInt(process.env.HTTPS_PORT || '3443', 10);
const SESSION_SECRET = process.env.SESSION_SECRET || 'vinyl-vault-secret-key';

app.use(express.json({ limit: '5mb' }));
app.use(cookieParser());

// Serve static frontend files
app.use(express.static(path.join(__dirname, '..', 'public')));

// Serve downloaded cover images
app.use('/data/covers', express.static(path.join(DATA_DIR, 'covers')));

// Simple HMAC session token generator/verifier
function createAuthToken() {
  const password = getSetting('APP_PASSWORD', 'vinyl123');
  return crypto
    .createHmac('sha256', SESSION_SECRET)
    .update(`authenticated:${password}`)
    .digest('hex');
}

function isAuthenticated(req) {
  const token = req.cookies?.vinyl_session || req.headers['x-auth-token'];
  if (!token) return false;
  return token === createAuthToken();
}

function requireAuth(req, res, next) {
  if (!isAuthenticated(req)) {
    return res.status(401).json({ error: 'Unauthorized. Please log in.' });
  }
  next();
}

// --- AUTH ROUTES ---

app.post('/api/auth/login', (req, res) => {
  const { password } = req.body || {};
  const expected = getSetting('APP_PASSWORD', 'vinyl123');

  if (password === expected) {
    const token = createAuthToken();
    res.cookie('vinyl_session', token, {
      httpOnly: true,
      sameSite: 'lax',
      maxAge: 30 * 24 * 60 * 60 * 1000 // 30 days
    });
    return res.json({ ok: true });
  }

  return res.status(401).json({ error: 'Invalid password' });
});

app.post('/api/auth/logout', (req, res) => {
  res.clearCookie('vinyl_session');
  res.json({ ok: true });
});

app.get('/api/auth/status', (req, res) => {
  const authenticated = isAuthenticated(req);
  const hasDiscogsToken = Boolean(getSetting('DISCOGS_TOKEN'));
  res.json({
    authenticated,
    configured: {
      discogs: hasDiscogsToken
    },
    network: {
      ips: getLocalIpAddresses(),
      httpPort: PORT,
      httpsPort: HTTPS_PORT
    }
  });
});

// --- SETTINGS ROUTES ---

app.get('/api/settings', requireAuth, async (req, res) => {
  const mask = (val) => (val ? `${val.slice(0, 4)}••••${val.slice(-3)}` : '');
  let discogsUsername = getSetting('DISCOGS_USERNAME');
  if (!discogsUsername && getSetting('DISCOGS_TOKEN')) {
    try {
      discogsUsername = await getDiscogsUsername();
    } catch (_) {}
  }

  res.json({
    DISCOGS_USERNAME: discogsUsername || '',
    DISCOGS_FOLDER_ID: getSetting('DISCOGS_FOLDER_ID', '1'),
    hasDiscogsToken: Boolean(getSetting('DISCOGS_TOKEN')),
    discogsTokenMasked: mask(getSetting('DISCOGS_TOKEN'))
  });
});

app.post('/api/settings', requireAuth, async (req, res) => {
  const {
    DISCOGS_TOKEN,
    DISCOGS_USERNAME,
    DISCOGS_FOLDER_ID,
    APP_PASSWORD
  } = req.body || {};

  if (DISCOGS_TOKEN !== undefined && !DISCOGS_TOKEN.includes('••••')) {
    setSetting('DISCOGS_TOKEN', DISCOGS_TOKEN.trim());
    if (!DISCOGS_USERNAME) {
      setSetting('DISCOGS_USERNAME', '');
    }
  }
  if (DISCOGS_USERNAME !== undefined) {
    setSetting('DISCOGS_USERNAME', DISCOGS_USERNAME.trim());
  }
  if (DISCOGS_FOLDER_ID !== undefined) {
    setSetting('DISCOGS_FOLDER_ID', String(DISCOGS_FOLDER_ID).trim() || '1');
  }
  if (APP_PASSWORD && APP_PASSWORD.trim().length > 0) {
    setSetting('APP_PASSWORD', APP_PASSWORD.trim());
    const token = createAuthToken();
    res.cookie('vinyl_session', token, {
      httpOnly: true,
      sameSite: 'lax',
      maxAge: 30 * 24 * 60 * 60 * 1000
    });
  }

  let resolvedUsername = getSetting('DISCOGS_USERNAME');
  let discogsError = null;
  if (getSetting('DISCOGS_TOKEN')) {
    try {
      resolvedUsername = await getDiscogsUsername(true);
    } catch (err) {
      discogsError = err.message;
    }
  }

  res.json({
    ok: true,
    discogsUsername: resolvedUsername || '',
    discogsError
  });
});

app.post('/api/settings/test-discogs', requireAuth, async (req, res) => {
  try {
    const { DISCOGS_TOKEN } = req.body || {};
    if (DISCOGS_TOKEN && !DISCOGS_TOKEN.includes('••••')) {
      setSetting('DISCOGS_TOKEN', DISCOGS_TOKEN.trim());
    }
    const username = await getDiscogsUsername(true);
    if (!username) {
      return res.status(400).json({ error: 'No Discogs Personal Access Token entered.' });
    }
    res.json({ ok: true, username });
  } catch (err) {
    res.status(401).json({ error: err.message });
  }
});

// --- MANUAL DISCOGS SEARCH ROUTE ---

app.get('/api/scan/search', requireAuth, async (req, res) => {
  try {
    const { barcode, q, artist, title, catno } = req.query;
    let candidates = [];
    let source = 'discogs';
    const hasDiscogsToken = Boolean(getSetting('DISCOGS_TOKEN'));

    if (hasDiscogsToken) {
      try {
        candidates = await searchDiscogs({
          barcode,
          query: q,
          artist,
          title,
          catno
        });
      } catch (err) {
        if (!q && !artist && !title) throw err;
      }
    }

    if (candidates.length === 0 && (q || artist || title)) {
      source = 'itunes_fallback';
      candidates = await searchItunesFallback({
        artist,
        title,
        query: q
      });
    }

    const enriched = candidates.map(c => {
      const existing = getAlbumByDiscogsId(c.discogs_id);
      return {
        ...c,
        in_collection: Boolean(existing),
        collection_id: existing ? existing.id : null,
        source
      };
    });

    res.json({ results: enriched, source });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// --- COLLECTION CRUD & DISCOGS IMPORT ROUTES ---

app.get('/api/collection', requireAuth, (req, res) => {
  const { search, genre, sort } = req.query;
  const albums = getAllAlbums({ search, genre, sort });
  res.json({ albums });
});

/**
 * Pull / Import existing collection from the user's Discogs account into the local database
 */
app.post('/api/collection/import-discogs', requireAuth, async (req, res) => {
  try {
    const { username, items } = await fetchUserDiscogsCollection();
    let importedCount = 0;
    let updatedCount = 0;

    for (const item of items) {
      const existing = getAlbumByDiscogsId(item.discogs_id);
      // Download cover art locally if not already cached
      if (item.cover_url && (!existing || !existing.local_cover)) {
        const localCover = await downloadCoverImage(item.cover_url, item.discogs_id);
        if (localCover) {
          item.local_cover = localCover;
        }
      }
      addAlbum(item);
      if (existing) {
        updatedCount++;
      } else {
        importedCount++;
      }
    }

    res.json({
      ok: true,
      username,
      totalFetched: items.length,
      importedCount,
      updatedCount
    });
  } catch (err) {
    console.error('Discogs import error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/collection', requireAuth, async (req, res) => {
  try {
    let albumData = { ...req.body };
    let discogsSyncResult = { synced: false };

    // If Discogs ID is present and we have a Discogs token, fetch full release details (tracklist, high-res cover)
    // and add the release to the user's remote Discogs Collection!
    if (albumData.discogs_id && getSetting('DISCOGS_TOKEN') && albumData.source !== 'itunes_fallback') {
      try {
        const fullDetails = await getReleaseDetails(albumData.discogs_id);
        if (fullDetails) {
          albumData = {
            ...fullDetails,
            ...albumData,
            cover_url: fullDetails.cover_url || albumData.cover_url,
            tracklist: fullDetails.tracklist?.length ? fullDetails.tracklist : (albumData.tracklist || []),
            genres: fullDetails.genres?.length ? fullDetails.genres : (albumData.genres || []),
            styles: fullDetails.styles?.length ? fullDetails.styles : (albumData.styles || []),
            formats: fullDetails.formats?.length ? fullDetails.formats : (albumData.formats || [])
          };
        }
      } catch (err) {
        console.warn('Could not fetch full Discogs release details:', err.message);
      }

      // Sync to remote Discogs account collection
      try {
        discogsSyncResult = await addReleaseToDiscogsCollection(albumData.discogs_id);
        if (discogsSyncResult.synced) {
          albumData.discogs_synced = 1;
          albumData.discogs_instance_id = discogsSyncResult.instanceId;
        }
      } catch (syncErr) {
        console.warn('Could not sync release to remote Discogs collection:', syncErr.message);
        discogsSyncResult = { synced: false, error: syncErr.message };
      }
    }

    // Download cover image locally so it's stored in the database & disk permanently
    if (albumData.cover_url) {
      const localCover = await downloadCoverImage(albumData.cover_url, albumData.discogs_id);
      if (localCover) {
        albumData.local_cover = localCover;
      }
    }

    const saved = addAlbum(albumData);
    res.status(201).json({ album: saved, discogsSync: discogsSyncResult });
  } catch (err) {
    console.error('Error adding album:', err);
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/collection/:id/sync-discogs', requireAuth, async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    let album = getAlbumById(id);
    if (!album) return res.status(404).json({ error: 'Album not found' });

    const isItunesUrl = (album.discogs_url || '').includes('apple.com');
    if (!album.discogs_id || isItunesUrl) {
      const matches = await searchDiscogs({
        barcode: album.barcode,
        artist: album.artist,
        title: album.title,
        catno: album.catno
      });
      if (!matches || matches.length === 0) {
        return res.status(404).json({
          error: `Could not find a matching vinyl release on Discogs for "${album.artist} - ${album.title}".`
        });
      }
      const best = matches[0];
      album.discogs_id = best.discogs_id;
      album.discogs_url = best.discogs_url || album.discogs_url;
      album.label = album.label || best.label;
      album.catno = album.catno || best.catno;
    }

    const syncRes = await addReleaseToDiscogsCollection(album.discogs_id);
    const updated = addAlbum({
      ...album,
      discogs_synced: syncRes.synced ? 1 : 0,
      discogs_instance_id: syncRes.instanceId || album.discogs_instance_id
    });

    res.json({ album: updated, discogsSync: syncRes });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.put('/api/collection/:id', requireAuth, (req, res) => {
  const id = parseInt(req.params.id, 10);
  const updated = updateAlbum(id, req.body || {});
  if (!updated) {
    return res.status(404).json({ error: 'Album not found' });
  }
  res.json({ album: updated });
});

app.delete('/api/collection/:id', requireAuth, async (req, res) => {
  const id = parseInt(req.params.id, 10);
  const existing = getAlbumById(id);

  // Also remove from remote Discogs collection if synced
  if (existing && existing.discogs_id && existing.discogs_instance_id && getSetting('DISCOGS_TOKEN')) {
    try {
      await removeReleaseFromDiscogsCollection(existing.discogs_id, existing.discogs_instance_id);
    } catch (err) {
      console.warn('Could not remove release from remote Discogs collection:', err.message);
    }
  }

  deleteAlbum(id);
  res.json({ ok: true });
});

const httpServer = http.createServer(app);
httpServer.listen(PORT, '0.0.0.0', () => {
  console.log(`🎵 VinylVault HTTP server listening on http://localhost:${PORT}`);
});

try {
  const { key, cert, ips } = ensureCertificates();
  const httpsServer = https.createServer({ key, cert }, app);
  httpsServer.listen(HTTPS_PORT, '0.0.0.0', () => {
    console.log(`🔒 VinylVault HTTPS server listening on:`);
    ips.forEach(ip => {
      console.log(`   👉 https://${ip}:${HTTPS_PORT}`);
    });
  });
} catch (err) {
  console.error('Failed to start HTTPS server:', err.message);
}
