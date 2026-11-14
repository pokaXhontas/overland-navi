/* Lädt Kartendateien in den privaten App-Speicher (Origin Private File System). */
'use strict';

self.onmessage = async (e) => {
  const files = e.data.files || [];
  let before = 0;
  let lastPost = 0;
  try {
    const root = await navigator.storage.getDirectory();
    for (const f of files) {
      try { await root.removeEntry(f.name + '.ok'); } catch (err) { /* gab es noch nicht */ }
      const handle = await root.getFileHandle(f.name, { create: true });
      const access = await handle.createSyncAccessHandle();
      try {
        access.truncate(0);
        const resp = await fetch(f.url, { cache: 'no-store' });
        if (!resp.ok || !resp.body) throw new Error('Server antwortet mit ' + resp.status);
        const reader = resp.body.getReader();
        let pos = 0;
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          access.write(value, { at: pos });
          pos += value.byteLength;
          const now = Date.now();
          if (now - lastPost > 250) {
            lastPost = now;
            self.postMessage({ type: 'progress', loaded: before + pos });
          }
        }
        access.flush();
        if (f.size && pos !== f.size) throw new Error('Datei unvollständig (' + pos + ' von ' + f.size + ' Bytes)');
        before += pos;
      } finally {
        access.close();
      }
      await root.getFileHandle(f.name + '.ok', { create: true });
      self.postMessage({ type: 'progress', loaded: before });
    }
    self.postMessage({ type: 'done' });
  } catch (err) {
    self.postMessage({ type: 'error', message: err && err.message ? err.message : String(err) });
  }
};
