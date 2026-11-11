const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
const COVERS_DIR = path.join(DATA_DIR, 'covers');

fs.mkdirSync(COVERS_DIR, { recursive: true });

const dbPath = path.join(DATA_DIR, 'collection.db');
const db = new Database(dbPath);

// Enable WAL mode for better concurrent performance
db.pragma('journal_mode = WAL');

db.exec(`
  CREATE TABLE IF NOT EXISTS albums (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    discogs_id INTEGER UNIQUE,
    master_id INTEGER,
    title TEXT NOT NULL,
    artist TEXT NOT NULL,
    year INTEGER,
    label TEXT,
    catno TEXT,
    country TEXT,
    genres TEXT,
    styles TEXT,
    formats TEXT,
    cover_url TEXT,
    local_cover TEXT,
    barcode TEXT,
    tracklist TEXT,
    discogs_url TEXT,
    notes TEXT DEFAULT '',
    rating INTEGER DEFAULT 0,
    condition TEXT DEFAULT 'VG+',
    added_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value TEXT
  );
`);

// Safe migrations for Discogs collection sync columns
try {
  db.exec('ALTER TABLE albums ADD COLUMN discogs_instance_id INTEGER');
} catch (_) {}
try {
  db.exec('ALTER TABLE albums ADD COLUMN discogs_synced INTEGER DEFAULT 0');
} catch (_) {}

const PLACEHOLDER_VALUES = new Set([
  'your_discogs_personal_access_token_here',
  'your_gemini_api_key_here',
  'your_openai_api_key_here'
]);

function getSetting(key, fallback = '') {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key);
  if (row && row.value !== undefined && row.value !== '') {
    const val = String(row.value).trim();
    if (val && !PLACEHOLDER_VALUES.has(val)) {
      return val;
    }
  }
  const envVal = (process.env[key] || '').trim();
  if (envVal && !PLACEHOLDER_VALUES.has(envVal)) {
    return envVal;
  }
  return fallback;
}

function setSetting(key, value) {
  db.prepare(`
    INSERT INTO settings (key, value) VALUES (?, ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value
  `).run(key, value);
}

function getAllAlbums({ search = '', genre = '', sort = 'added_desc' } = {}) {
  let query = 'SELECT * FROM albums WHERE 1=1';
  const params = [];

  if (search) {
    query += ' AND (title LIKE ? OR artist LIKE ? OR label LIKE ? OR catno LIKE ? OR barcode LIKE ?)';
    const term = `%${search}%`;
    params.push(term, term, term, term, term);
  }

  if (genre) {
    query += ' AND (genres LIKE ? OR styles LIKE ?)';
    params.push(`%${genre}%`, `%${genre}%`);
  }

  switch (sort) {
    case 'artist_asc':
      query += ' ORDER BY artist COLLATE NOCASE ASC, year ASC';
      break;
    case 'title_asc':
      query += ' ORDER BY title COLLATE NOCASE ASC';
      break;
    case 'year_desc':
      query += ' ORDER BY year DESC, artist ASC';
      break;
    case 'year_asc':
      query += ' ORDER BY year ASC, artist ASC';
      break;
    case 'added_desc':
    default:
      query += ' ORDER BY added_at DESC, id DESC';
      break;
  }

  const rows = db.prepare(query).all(...params);
  return rows.map(parseAlbumRow);
}

function getAlbumById(id) {
  const row = db.prepare('SELECT * FROM albums WHERE id = ?').get(id);
  return row ? parseAlbumRow(row) : null;
}

function getAlbumByDiscogsId(discogsId) {
  if (!discogsId) return null;
  const row = db.prepare('SELECT * FROM albums WHERE discogs_id = ?').get(discogsId);
  return row ? parseAlbumRow(row) : null;
}

function addAlbum(album) {
  const stmt = db.prepare(`
    INSERT INTO albums (
      discogs_id, master_id, title, artist, year, label, catno, country,
      genres, styles, formats, cover_url, local_cover, barcode, tracklist,
      discogs_url, notes, rating, condition, discogs_instance_id, discogs_synced
    ) VALUES (
      @discogs_id, @master_id, @title, @artist, @year, @label, @catno, @country,
      @genres, @styles, @formats, @cover_url, @local_cover, @barcode, @tracklist,
      @discogs_url, @notes, @rating, @condition, @discogs_instance_id, @discogs_synced
    )
    ON CONFLICT(discogs_id) DO UPDATE SET
      title = excluded.title,
      artist = excluded.artist,
      year = excluded.year,
      label = excluded.label,
      catno = excluded.catno,
      country = excluded.country,
      genres = excluded.genres,
      styles = excluded.styles,
      formats = excluded.formats,
      cover_url = excluded.cover_url,
      local_cover = COALESCE(excluded.local_cover, albums.local_cover),
      barcode = COALESCE(excluded.barcode, albums.barcode),
      tracklist = excluded.tracklist,
      discogs_url = excluded.discogs_url,
      discogs_instance_id = COALESCE(excluded.discogs_instance_id, albums.discogs_instance_id),
      discogs_synced = CASE WHEN excluded.discogs_synced = 1 THEN 1 ELSE albums.discogs_synced END
  `);

  const payload = {
    discogs_id: album.discogs_id || null,
    master_id: album.master_id || null,
    title: album.title || 'Unknown Title',
    artist: album.artist || 'Unknown Artist',
    year: album.year ? parseInt(album.year, 10) || null : null,
    label: album.label || '',
    catno: album.catno || '',
    country: album.country || '',
    genres: JSON.stringify(Array.isArray(album.genres) ? album.genres : []),
    styles: JSON.stringify(Array.isArray(album.styles) ? album.styles : []),
    formats: JSON.stringify(Array.isArray(album.formats) ? album.formats : []),
    cover_url: album.cover_url || '',
    local_cover: album.local_cover || '',
    barcode: album.barcode || '',
    tracklist: JSON.stringify(Array.isArray(album.tracklist) ? album.tracklist : []),
    discogs_url: album.discogs_url || '',
    notes: album.notes || '',
    rating: album.rating || 0,
    condition: album.condition || 'VG+',
    discogs_instance_id: album.discogs_instance_id || null,
    discogs_synced: album.discogs_synced ? 1 : 0
  };

  const info = stmt.run(payload);
  if (payload.discogs_id) {
    return getAlbumByDiscogsId(payload.discogs_id);
  }
  return getAlbumById(info.lastInsertRowid);
}

function updateAlbum(id, updates) {
  const existing = getAlbumById(id);
  if (!existing) return null;

  const stmt = db.prepare(`
    UPDATE albums SET
      notes = @notes,
      rating = @rating,
      condition = @condition,
      title = @title,
      artist = @artist,
      year = @year
    WHERE id = @id
  `);

  stmt.run({
    id,
    notes: updates.notes !== undefined ? updates.notes : existing.notes,
    rating: updates.rating !== undefined ? updates.rating : existing.rating,
    condition: updates.condition !== undefined ? updates.condition : existing.condition,
    title: updates.title !== undefined ? updates.title : existing.title,
    artist: updates.artist !== undefined ? updates.artist : existing.artist,
    year: updates.year !== undefined ? updates.year : existing.year
  });

  return getAlbumById(id);
}

function deleteAlbum(id) {
  const existing = getAlbumById(id);
  if (existing && existing.local_cover) {
    const filePath = path.join(DATA_DIR, existing.local_cover.replace(/^\/data\//, ''));
    if (fs.existsSync(filePath)) {
      try { fs.unlinkSync(filePath); } catch (_) {}
    }
  }
  return db.prepare('DELETE FROM albums WHERE id = ?').run(id);
}

function parseAlbumRow(row) {
  return {
    ...row,
    genres: safeJsonParse(row.genres, []),
    styles: safeJsonParse(row.styles, []),
    formats: safeJsonParse(row.formats, []),
    tracklist: safeJsonParse(row.tracklist, [])
  };
}

function safeJsonParse(str, fallback) {
  if (!str) return fallback;
  try {
    return JSON.parse(str);
  } catch (_) {
    return fallback;
  }
}

module.exports = {
  db,
  DATA_DIR,
  COVERS_DIR,
  getSetting,
  setSetting,
  getAllAlbums,
  getAlbumById,
  getAlbumByDiscogsId,
  addAlbum,
  updateAlbum,
  deleteAlbum
};
