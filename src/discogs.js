const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { COVERS_DIR, getSetting, setSetting } = require('./db');

const USER_AGENT = 'VinylVaultManager/2.0 +https://github.com/local/vinyl-scanner';

function getCleanDiscogsToken() {
  let token = (getSetting('DISCOGS_TOKEN') || '').trim();
  if (!token) return '';
  // Strip accidental "Discogs token=", "Bearer ", or surrounding quotes if pasted by user
  token = token
    .replace(/^['"]+|['"]+$/g, '')
    .replace(/^Discogs\s+token\s*=\s*/i, '')
    .replace(/^Bearer\s+/i, '')
    .trim();
  return token;
}

function getDiscogsHeaders() {
  const token = getCleanDiscogsToken();
  const headers = {
    'User-Agent': USER_AGENT,
    'Accept': 'application/vnd.discogs.v2.plaintext+json'
  };
  if (token) {
    headers['Authorization'] = `Discogs token=${token}`;
  }
  return headers;
}

function withTokenParam(url) {
  const token = getCleanDiscogsToken();
  if (!token) return url;
  const sep = url.includes('?') ? '&' : '?';
  return `${url}${sep}token=${encodeURIComponent(token)}`;
}

/**
 * Search Discogs database by barcode, query, artist/title, or catalog number.
 */
async function searchDiscogs({ barcode, artist, title, catno, query }) {
  const results = [];

  async function runQuery(paramsObj) {
    const params = new URLSearchParams({
      per_page: '15',
      ...paramsObj
    });
    const url = withTokenParam(`https://api.discogs.com/database/search?${params.toString()}`);
    const res = await fetch(url, { headers: getDiscogsHeaders() });
    if (!res.ok) {
      const errText = await res.text();
      if (res.status === 401) {
        throw new Error(
          'Discogs authentication required or invalid DISCOGS_TOKEN. Please add your Discogs Personal Access Token in Settings.'
        );
      }
      throw new Error(`Discogs API error (${res.status}): ${errText}`);
    }
    const data = await res.json();
    return data.results || [];
  }

  // 1. If barcode is provided, search by barcode first
  if (barcode) {
    const cleanBarcode = barcode.replace(/[^0-9A-Za-z]/g, '');
    let items = await runQuery({ barcode: cleanBarcode, type: 'release' });
    if (items.length === 0) {
      items = await runQuery({ q: cleanBarcode, type: 'release' });
    }
    results.push(...items);
  }

  // 2. If catalog number is provided and we don't have results yet
  if (results.length === 0 && catno) {
    const items = await runQuery({ catno, format: 'Vinyl', type: 'release' });
    if (items.length === 0) {
      const allFormats = await runQuery({ catno, type: 'release' });
      results.push(...allFormats);
    } else {
      results.push(...items);
    }
  }

  // 3. If artist & title are provided
  if (results.length === 0 && (artist || title)) {
    const qParams = { type: 'release', format: 'Vinyl' };
    if (artist) qParams.artist = artist;
    if (title) qParams.release_title = title;
    if (catno) qParams.catno = catno;
    let items = await runQuery(qParams);

    if (items.length === 0) {
      const combined = [artist, title, catno].filter(Boolean).join(' ');
      items = await runQuery({ q: combined, format: 'Vinyl', type: 'release' });
    }
    if (items.length === 0) {
      const combined = [artist, title, catno].filter(Boolean).join(' ');
      items = await runQuery({ q: combined, type: 'release' });
    }
    results.push(...items);
  }

  // 4. General free-text query
  if (results.length === 0 && query) {
    let items = await runQuery({ q: query, format: 'Vinyl', type: 'release' });
    if (items.length === 0) {
      items = await runQuery({ q: query, type: 'release' });
    }
    results.push(...items);
  }

  return results.map(normalizeSearchResult);
}

/**
 * Normalize a Discogs search result item into a clean album object.
 */
function normalizeSearchResult(item) {
  let artist = 'Unknown Artist';
  let albumTitle = item.title || 'Unknown Title';
  if (item.title && item.title.includes(' - ')) {
    const parts = item.title.split(' - ');
    artist = parts[0].trim();
    albumTitle = parts.slice(1).join(' - ').trim();
  }
  artist = artist.replace(/\s+\(\d+\)$/, '');

  const coverUrl = (item.cover_image && !item.cover_image.endsWith('spacer.gif'))
    ? item.cover_image
    : (item.thumb || '');

  return {
    discogs_id: item.id,
    master_id: item.master_id || null,
    title: albumTitle,
    artist,
    year: item.year ? parseInt(item.year, 10) || null : null,
    label: Array.isArray(item.label) && item.label.length > 0 ? item.label[0] : '',
    catno: item.catno || '',
    country: item.country || '',
    genres: Array.isArray(item.genre) ? item.genre : [],
    styles: Array.isArray(item.style) ? item.style : [],
    formats: Array.isArray(item.format) ? item.format : [],
    cover_url: coverUrl,
    barcode: Array.isArray(item.barcode) && item.barcode.length > 0 ? item.barcode[0] : '',
    discogs_url: item.uri ? `https://www.discogs.com${item.uri}` : `https://www.discogs.com/release/${item.id}`
  };
}

/**
 * Fetch full release details (including tracklist and high-res artwork) from Discogs.
 */
async function getReleaseDetails(releaseId) {
  const url = withTokenParam(`https://api.discogs.com/releases/${releaseId}`);
  const res = await fetch(url, { headers: getDiscogsHeaders() });
  if (!res.ok) {
    return null;
  }
  const data = await res.json();

  const artists = Array.isArray(data.artists)
    ? data.artists.map(a => a.name.replace(/\s+\(\d+\)$/, '')).join(', ')
    : 'Unknown Artist';

  const primaryImage = Array.isArray(data.images) && data.images.length > 0
    ? (data.images.find(img => img.type === 'primary') || data.images[0]).uri
    : (data.thumb || '');

  const labelObj = Array.isArray(data.labels) && data.labels.length > 0 ? data.labels[0] : {};
  const barcodeIds = Array.isArray(data.identifiers)
    ? data.identifiers.filter(i => i.type === 'Barcode').map(i => i.value)
    : [];

  const formats = Array.isArray(data.formats)
    ? data.formats.map(f => [f.name, ...(f.descriptions || [])].join(', '))
    : [];

  const tracklist = Array.isArray(data.tracklist)
    ? data.tracklist
        .filter(t => t.type_ === 'track' || t.title)
        .map(t => ({
          position: t.position || '',
          title: t.title || '',
          duration: t.duration || ''
        }))
    : [];

  return {
    discogs_id: data.id,
    master_id: data.master_id || null,
    title: data.title || 'Unknown Title',
    artist: artists,
    year: data.year || null,
    label: labelObj.name || '',
    catno: labelObj.catno || '',
    country: data.country || '',
    genres: Array.isArray(data.genres) ? data.genres : [],
    styles: Array.isArray(data.styles) ? data.styles : [],
    formats,
    cover_url: primaryImage,
    barcode: barcodeIds[0] || '',
    tracklist,
    discogs_url: data.uri || `https://www.discogs.com/release/${data.id}`
  };
}

/**
 * Fallback to iTunes Search API if Discogs token is not yet configured.
 */
async function searchItunesFallback({ artist, title, query }) {
  const term = [artist, title, query].filter(Boolean).join(' ').trim();
  if (!term) return [];

  const params = new URLSearchParams({
    term,
    entity: 'album',
    limit: '10'
  });
  const res = await fetch(`https://itunes.apple.com/search?${params.toString()}`);
  if (!res.ok) return [];
  const data = await res.json();

  return (data.results || []).map(item => {
    const highResCover = item.artworkUrl100
      ? item.artworkUrl100.replace('100x100bb', '600x600bb')
      : '';
    return {
      discogs_id: null,
      itunes_id: item.collectionId,
      source: 'itunes_fallback',
      master_id: null,
      title: item.collectionName || 'Unknown Title',
      artist: item.artistName || 'Unknown Artist',
      year: item.releaseDate ? new Date(item.releaseDate).getFullYear() : null,
      label: item.copyright || '',
      catno: '',
      country: item.country || '',
      genres: item.primaryGenreName ? [item.primaryGenreName] : [],
      styles: [],
      formats: ['Vinyl LP'],
      cover_url: highResCover,
      barcode: '',
      tracklist: [],
      discogs_url: item.collectionViewUrl || ''
    };
  });
}

/**
 * Download remote cover image from Discogs/source and store locally in /data/covers
 */
async function downloadCoverImage(imageUrl, discogsId) {
  if (!imageUrl || imageUrl.endsWith('spacer.gif')) return '';
  try {
    const res = await fetch(imageUrl, {
      headers: {
        'User-Agent': USER_AGENT
      }
    });
    if (!res.ok) return '';

    const contentType = res.headers.get('content-type') || 'image/jpeg';
    let ext = '.jpg';
    if (contentType.includes('png')) ext = '.png';
    else if (contentType.includes('webp')) ext = '.webp';

    const filename = `cover_${discogsId || crypto.randomBytes(6).toString('hex')}${ext}`;
    const filePath = path.join(COVERS_DIR, filename);

    const arrayBuffer = await res.arrayBuffer();
    fs.writeFileSync(filePath, Buffer.from(arrayBuffer));

    return `/data/covers/${filename}`;
  } catch (err) {
    console.warn('Could not download cover image locally:', err.message);
    return '';
  }
}

/**
 * Resolve the authenticated Discogs username from the configured Personal Access Token
 * via GET /oauth/identity (always verifies against the token when forceVerify = true).
 */
async function getDiscogsUsername(forceVerify = false) {
  const token = getCleanDiscogsToken();
  if (!token) return '';

  if (!forceVerify) {
    const cached = getSetting('DISCOGS_USERNAME');
    if (cached) return cached;
  }

  const res = await fetch(withTokenParam('https://api.discogs.com/oauth/identity'), {
    headers: getDiscogsHeaders()
  });

  if (!res.ok) {
    const errText = await res.text();
    if (res.status === 401) {
      throw new Error(
        'Discogs returned 401 Unauthorized: Your Personal Access Token is missing or invalid. Generate a Personal Access Token at https://www.discogs.com/settings/developers ("Generate new token" button) and save it in Settings.'
      );
    }
    throw new Error(`Discogs identity check failed (${res.status}): ${errText}`);
  }

  const data = await res.json();
  if (data && data.username) {
    setSetting('DISCOGS_USERNAME', data.username);
    return data.username;
  }
  return '';
}

/**
 * Add a release to the user's remote Discogs Collection folder
 * (Folder 1 = "Uncategorized", the standard writable default collection folder in Discogs API).
 */
async function addReleaseToDiscogsCollection(releaseId, folderId = null) {
  const token = getCleanDiscogsToken();
  if (!token) {
    throw new Error('No Discogs Personal Access Token configured in Settings.');
  }
  if (!releaseId) {
    return { synced: false, reason: 'No Discogs releaseId' };
  }

  const username = await getDiscogsUsername(true);
  if (!username) {
    throw new Error('Could not resolve your Discogs username from the token.');
  }

  const targetFolder = folderId || parseInt(getSetting('DISCOGS_FOLDER_ID', '1'), 10) || 1;
  const baseUrl = `https://api.discogs.com/users/${encodeURIComponent(username)}/collection/folders/${targetFolder}/releases/${encodeURIComponent(releaseId)}`;
  const url = withTokenParam(baseUrl);

  const res = await fetch(url, {
    method: 'POST',
    headers: getDiscogsHeaders()
  });

  if (!res.ok) {
    const errText = await res.text();
    if (res.status === 401 || res.status === 403) {
      throw new Error(
        `Discogs collection sync error (${res.status}): Ensure your token was generated via "Generate new token" at discogs.com/settings/developers for user @${username}. Details: ${errText}`
      );
    }
    throw new Error(`Discogs collection sync error (${res.status}): ${errText}`);
  }

  const data = await res.json();
  return {
    synced: true,
    username,
    folderId: targetFolder,
    instanceId: data.instance_id || null,
    resourceUrl: data.resource_url || ''
  };
}

/**
 * Remove a release instance from the user's remote Discogs Collection folder
 */
async function removeReleaseFromDiscogsCollection(releaseId, instanceId, folderId = null) {
  const token = getCleanDiscogsToken();
  if (!token || !releaseId || !instanceId) {
    return { removed: false };
  }

  const username = await getDiscogsUsername();
  if (!username) return { removed: false };

  const targetFolder = folderId || parseInt(getSetting('DISCOGS_FOLDER_ID', '1'), 10) || 1;
  const baseUrl = `https://api.discogs.com/users/${encodeURIComponent(username)}/collection/folders/${targetFolder}/releases/${encodeURIComponent(releaseId)}/instances/${encodeURIComponent(instanceId)}`;
  const url = withTokenParam(baseUrl);

  const res = await fetch(url, {
    method: 'DELETE',
    headers: getDiscogsHeaders()
  });

  return { removed: res.ok || res.status === 204 };
}

/**
 * Pull the user's entire existing collection from Discogs (Folder 0 = All folders)
 * Supports pagination up to all items in the user's Discogs collection.
 */
async function fetchUserDiscogsCollection() {
  const token = getCleanDiscogsToken();
  if (!token) {
    throw new Error('No Discogs Personal Access Token configured. Please add your token in Settings first.');
  }

  const username = await getDiscogsUsername(true);
  if (!username) {
    throw new Error('Could not determine Discogs username from token.');
  }

  const allItems = [];
  let page = 1;
  let totalPages = 1;

  do {
    const baseUrl = `https://api.discogs.com/users/${encodeURIComponent(username)}/collection/folders/0/releases?page=${page}&per_page=100&sort=added&sort_order=desc`;
    const url = withTokenParam(baseUrl);
    const res = await fetch(url, { headers: getDiscogsHeaders() });

    if (!res.ok) {
      const errText = await res.text();
      throw new Error(`Failed to fetch Discogs collection (${res.status}): ${errText}`);
    }

    const data = await res.json();
    const releases = data.releases || [];
    totalPages = data.pagination?.pages || 1;

    for (const item of releases) {
      const info = item.basic_information || {};
      const artists = Array.isArray(info.artists) && info.artists.length > 0
        ? info.artists.map(a => (a.name || '').replace(/\s+\(\d+\)$/, '')).join(', ')
        : 'Unknown Artist';
      const labelObj = Array.isArray(info.labels) && info.labels.length > 0 ? info.labels[0] : {};
      const formats = Array.isArray(info.formats)
        ? info.formats.map(f => [f.name, ...(f.descriptions || [])].join(', '))
        : [];
      const coverUrl = (info.cover_image && !info.cover_image.endsWith('spacer.gif'))
        ? info.cover_image
        : (info.thumb || '');

      allItems.push({
        discogs_id: info.id || item.id,
        master_id: info.master_id || null,
        title: info.title || 'Unknown Title',
        artist: artists,
        year: info.year && info.year > 0 ? info.year : null,
        label: labelObj.name || '',
        catno: labelObj.catno || '',
        country: '',
        genres: Array.isArray(info.genres) ? info.genres : [],
        styles: Array.isArray(info.styles) ? info.styles : [],
        formats,
        cover_url: coverUrl,
        barcode: '',
        tracklist: [],
        discogs_url: `https://www.discogs.com/release/${info.id || item.id}`,
        rating: item.rating || 0,
        discogs_instance_id: item.instance_id || null,
        discogs_synced: 1
      });
    }

    page++;
  } while (page <= totalPages && page <= 25); // Up to 2,500 records per import

  return {
    username,
    items: allItems
  };
}

module.exports = {
  searchDiscogs,
  getReleaseDetails,
  searchItunesFallback,
  downloadCoverImage,
  getDiscogsUsername,
  addReleaseToDiscogsCollection,
  removeReleaseFromDiscogsCollection,
  fetchUserDiscogsCollection
};
