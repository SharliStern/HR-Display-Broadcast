/* HR Display Broadcast — Service Worker
   1. פתיחת האפליקציה גם בלי אינטרנט
   2. הזרמת קבצים מ-Drive למאסטר (בלי שמירה במכשיר)
   3. ./__local/<id>: סרטון ששמור במכשיר, כקובץ רגיל עם תמיכה בדילוג (Range).
      גיבוי לטלוויזיות שלא מנגנות סרטון מ-Blob */

function idbFile(id) {
  return new Promise((res, rej) => {
    const r = indexedDB.open('hr-broadcast');
    r.onerror = () => rej(r.error);
    r.onsuccess = () => {
      try {
        const db = r.result, q = db.transaction('files', 'readonly').objectStore('files').get(id);
        q.onsuccess = () => { res(q.result || null); db.close(); };
        q.onerror = () => { rej(q.error); db.close(); };
      } catch (e) { rej(e); }
    };
  });
}
async function localResponse(req, id) {
  const rec = await idbFile(id);
  if (!rec || !rec.blob) return new Response('', { status: 404 });
  const blob = rec.blob, size = blob.size, type = rec.mime || blob.type || 'application/octet-stream';
  const range = req.headers.get('Range');
  const m = range && /bytes=(\d*)-(\d*)/.exec(range);
  if (m) {
    let start = m[1] === '' ? Math.max(0, size - Number(m[2])) : Number(m[1]);
    let end = m[1] !== '' && m[2] !== '' ? Math.min(Number(m[2]), size - 1) : size - 1;
    if (start >= size) return new Response('', { status: 416, headers: { 'Content-Range': 'bytes */' + size } });
    end = Math.min(end, start + 8 * 1048576 - 1);          // מקטעים של עד 8MB
    return new Response(blob.slice(start, end + 1), { status: 206, headers: {
      'Content-Type': type, 'Content-Length': String(end - start + 1), 'Content-Range': `bytes ${start}-${end}/${size}`, 'Accept-Ranges': 'bytes', 'Cache-Control': 'no-store' } });
  }
  return new Response(blob, { status: 200, headers: { 'Content-Type': type, 'Content-Length': String(size), 'Accept-Ranges': 'bytes', 'Cache-Control': 'no-store' } });
}
const SW_VERSION = '1.4.2';
const CACHE = 'hr-shell-v6';

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.add('./')).catch(() => {}).then(() => self.skipWaiting()));
});
self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
    .then(() => self.clients.claim()));
});

self.addEventListener('fetch', e => {
  const req = e.request;
  const url = new URL(req.url);

  // סרטון שמור במכשיר
  if (url.origin === self.location.origin && url.pathname.includes('/__local/')) {
    const id = decodeURIComponent(url.pathname.split('/__local/')[1] || '');
    e.respondWith(localResponse(req, id).catch(() => new Response('', { status: 500 })));
    return;
  }

  // הזרמה מ-Drive: ./__drive/<fileId>?k=<מפתח זמני>  — לא נשמר בשום מטמון
  if (url.origin === self.location.origin && url.pathname.includes('/__drive/')) {
    const id = decodeURIComponent(url.pathname.split('/__drive/')[1] || '');
    const k = url.searchParams.get('k') || '';
    if (!/^[\w-]{10,100}$/.test(id) || !k) { e.respondWith(new Response('', { status: 400 })); return; }
    const headers = { Authorization: 'Bearer ' + k };
    const range = req.headers.get('Range');
    if (range) headers.Range = range;
    e.respondWith(fetch('https://www.googleapis.com/drive/v3/files/' + encodeURIComponent(id) + '?alt=media',
      { headers, cache: 'no-store', credentials: 'omit' }));
    return;
  }

  if (req.method !== 'GET') return;
  if (/script\.google(usercontent)?\.com$|googleapis\.com$/.test(url.hostname)) return; // שרת ו-Drive — תמיד מהרשת

  const isPage = req.mode === 'navigate' || url.pathname.endsWith('.html');
  if (isPage) {
    e.respondWith(fetch(req).then(r => { const cp = r.clone(); caches.open(CACHE).then(c => c.put(req, cp)); return r; })
      .catch(() => caches.match(req).then(r => r || caches.match('./'))));
    return;
  }
  if (url.origin !== self.location.origin && !/cdnjs\.cloudflare\.com|fonts\.(googleapis|gstatic)\.com/.test(url.hostname)) return;
  e.respondWith(caches.match(req).then(hit => {
    const net = fetch(req).then(r => { if (r.ok || r.type === 'opaque') { const cp = r.clone(); caches.open(CACHE).then(c => c.put(req, cp)); } return r; })
      .catch(() => hit);
    return hit || net;
  }));
});
