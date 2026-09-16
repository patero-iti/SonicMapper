/**
 * StorageEngine - IndexedDB & GeoJSON Persistence
 * Handles local client-side storage for audio binary blobs and spatial metadata.
 */
export class StorageEngine {
  constructor() {
    this.dbName = 'SonicMapperDB';
    this.dbVersion = 1;
    this.db = null;
  }

  /**
   * Initializes IndexedDB instance
   */
  async init() {
    return new Promise((resolve, reject) => {
      const request = indexedDB.open(this.dbName, this.dbVersion);

      request.onupgradeneeded = (event) => {
        const db = event.target.result;
        if (!db.objectStoreNames.contains('features')) {
          db.createObjectStore('features', { keyPath: 'id' });
        }
        if (!db.objectStoreNames.contains('audio_blobs')) {
          db.createObjectStore('audio_blobs', { keyPath: 'id' });
        }
      };

      request.onsuccess = (event) => {
        this.db = event.target.result;
        resolve(this.db);
      };

      request.onerror = (event) => {
        console.error('IndexedDB init error:', event.target.error);
        reject(event.target.error);
      };
    });
  }

  /**
   * Save a feature metadata and optional audio Blob
   */
  async saveSound(feature, audioBlob = null) {
    if (!this.db) await this.init();

    return new Promise((resolve, reject) => {
      const tx = this.db.transaction(['features', 'audio_blobs'], 'readwrite');
      const featureStore = tx.objectStore('features');
      const blobStore = tx.objectStore('audio_blobs');

      featureStore.put(feature);

      if (audioBlob) {
        blobStore.put({ id: feature.id, blob: audioBlob });
      }

      tx.oncomplete = () => resolve(true);
      tx.onerror = (e) => reject(e.target.error);
    });
  }

  /**
   * Load all saved features from IndexedDB
   */
  async getAllFeatures() {
    if (!this.db) await this.init();

    return new Promise((resolve, reject) => {
      const tx = this.db.transaction('features', 'readonly');
      const store = tx.objectStore('features');
      const req = store.getAll();

      req.onsuccess = () => resolve(req.result || []);
      req.onerror = (e) => reject(e.target.error);
    });
  }

  /**
   * Get audio blob for a specific sound ID
   */
  async getAudioBlob(id) {
    if (!this.db) await this.init();

    return new Promise((resolve, reject) => {
      const tx = this.db.transaction('audio_blobs', 'readonly');
      const store = tx.objectStore('audio_blobs');
      const req = store.get(id);

      req.onsuccess = () => resolve(req.result ? req.result.blob : null);
      req.onerror = (e) => reject(e.target.error);
    });
  }

  /**
   * Delete a sound feature and its associated audio blob
   */
  async deleteSound(id) {
    if (!this.db) await this.init();

    return new Promise((resolve, reject) => {
      const tx = this.db.transaction(['features', 'audio_blobs'], 'readwrite');
      tx.objectStore('features').delete(id);
      tx.objectStore('audio_blobs').delete(id);

      tx.oncomplete = () => resolve(true);
      tx.onerror = (e) => reject(e.target.error);
    });
  }

  /**
   * Export all features as a downloadable GeoJSON file
   */
  async exportGeoJSON(features = null) {
    if (!this.db) await this.init();

    let allFeatures = features;
    if (!allFeatures || !Array.isArray(allFeatures) || allFeatures.length === 0) {
      allFeatures = await this.getAllFeatures();
    }
    if (!Array.isArray(allFeatures)) {
      allFeatures = [];
    }

    const data = {
      type: 'FeatureCollection',
      metadata: {
        title: 'SonicMapper Exported Soundscape',
        exportedAt: new Date().toISOString(),
        featureCount: allFeatures.length
      },
      features: allFeatures
    };

    const jsonStr = JSON.stringify(data, null, 2);
    const blob = new Blob([jsonStr], { type: 'application/geo+json' });
    const url = URL.createObjectURL(blob);

    const a = document.createElement('a');
    a.href = url;
    a.download = `sonicmapper_export_${new Date().toISOString().slice(0, 10)}.geojson`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);

    return data;
  }
}
