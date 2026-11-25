// ============================================================================
// db.js — IndexedDB NoSQL Store for LedgerUI (LedgerUI_NoSQL_v1)
// ============================================================================
(() => {
  const DB_NAME = 'LedgerUI_NoSQL_v1';
  const DB_VERSION = 1;

  function openDB() {
    return new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = (evt) => {
        const db = evt.target.result;
        if (!db.objectStoreNames.contains('handles')) {
          db.createObjectStore('handles', { keyPath: 'key' });
        }
        if (!db.objectStoreNames.contains('syncMeta')) {
          db.createObjectStore('syncMeta', { keyPath: 'fileName' });
        }
        if (!db.objectStoreNames.contains('records')) {
          const recStore = db.createObjectStore('records', { keyPath: 'compositeId' });
          recStore.createIndex('trackingUuid', 'trackingUuid', { unique: false });
          recStore.createIndex('ledgerId', 'ledgerId', { unique: false });
          recStore.createIndex('agentUuid', 'agentUuid', { unique: false });
          recStore.createIndex('status', 'status', { unique: false });
          recStore.createIndex('actionCategory', 'actionCategory', { unique: false });
          recStore.createIndex('sourceFile', 'sourceFile', { unique: false });
        }
        if (!db.objectStoreNames.contains('overlays')) {
          db.createObjectStore('overlays', { keyPath: 'trackingUuid' });
        }
        if (!db.objectStoreNames.contains('queueItems')) {
          db.createObjectStore('queueItems', { keyPath: 'trackingUuid' });
        }
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }

  async function withStore(storeName, mode, fn) {
    const db = await openDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(storeName, mode);
      const store = tx.objectStore(storeName);
      const res = fn(store, tx);
      tx.oncomplete = () => resolve(res && res.result !== undefined ? res.result : res);
      tx.onerror = () => reject(tx.error);
    });
  }

  async function getAll(storeName) {
    const db = await openDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(storeName, 'readonly');
      const req = tx.objectStore(storeName).getAll();
      req.onsuccess = () => resolve(req.result || []);
      req.onerror = () => reject(req.error);
    });
  }

  async function getHandle(key) {
    const db = await openDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction('handles', 'readonly');
      const req = tx.objectStore('handles').get(key);
      req.onsuccess = () => resolve(req.result ? req.result.value : null);
      req.onerror = () => reject(req.error);
    });
  }

  async function setHandle(key, value) {
    return withStore('handles', 'readwrite', (store) => store.put({ key, value }));
  }

  async function putRecordsBatch(docs) {
    if (!Array.isArray(docs) || docs.length === 0) return;
    const db = await openDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction('records', 'readwrite');
      const store = tx.objectStore('records');
      docs.forEach((doc) => store.put(doc));
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  }

  async function deleteRecordsBySourceFile(fileName) {
    const db = await openDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction('records', 'readwrite');
      const store = tx.objectStore('records');
      const idx = store.index('sourceFile');
      const req = idx.openCursor(IDBKeyRange.only(fileName));
      req.onsuccess = (evt) => {
        const cursor = evt.target.result;
        if (cursor) {
          cursor.delete();
          cursor.continue();
        }
      };
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  }

  async function putOverlaysBatch(docs) {
    const db = await openDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction('overlays', 'readwrite');
      const store = tx.objectStore('overlays');
      store.clear();
      (docs || []).forEach((doc) => store.put(doc));
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  }

  async function replaceAllQueueItems(docs) {
    const db = await openDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction('queueItems', 'readwrite');
      const store = tx.objectStore('queueItems');
      store.clear();
      (docs || []).forEach((doc) => store.put(doc));
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  }

  async function clearCacheStores() {
    const db = await openDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(['syncMeta', 'records', 'overlays', 'queueItems'], 'readwrite');
      tx.objectStore('syncMeta').clear();
      tx.objectStore('records').clear();
      tx.objectStore('overlays').clear();
      tx.objectStore('queueItems').clear();
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  }

  window.LedgerDB = {
    getHandle,
    setHandle,
    getAllSyncMeta: () => getAll('syncMeta'),
    putSyncMeta: (doc) => withStore('syncMeta', 'readwrite', (s) => s.put(doc)),
    deleteSyncMeta: (fileName) => withStore('syncMeta', 'readwrite', (s) => s.delete(fileName)),
    getAllRecords: () => getAll('records'),
    putRecordsBatch,
    deleteRecordsBySourceFile,
    getAllOverlays: () => getAll('overlays'),
    putOverlay: (doc) => withStore('overlays', 'readwrite', (s) => s.put(doc)),
    putOverlaysBatch,
    getAllQueueItems: () => getAll('queueItems'),
    replaceAllQueueItems,
    clearCacheStores
  };
})();
