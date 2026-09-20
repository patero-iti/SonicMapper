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
   * Save audio blob for a specific soundwalk waypoint
   */
  async saveWaypointAudioBlob(featureId, wpIndex, audioBlob) {
    if (!this.db) await this.init();

    const key = `${featureId}_wp_${wpIndex}`;
    return new Promise((resolve, reject) => {
      const tx = this.db.transaction('audio_blobs', 'readwrite');
      const store = tx.objectStore('audio_blobs');
      if (audioBlob) {
        store.put({ id: key, blob: audioBlob });
      } else {
        store.delete(key);
      }
      tx.oncomplete = () => resolve(true);
      tx.onerror = (e) => reject(e.target.error);
    });
  }

  /**
   * Get audio blob for a specific soundwalk waypoint
   */
  async getWaypointAudioBlob(featureId, wpIndex) {
    if (!this.db) await this.init();

    const key = `${featureId}_wp_${wpIndex}`;
    return new Promise((resolve, reject) => {
      const tx = this.db.transaction('audio_blobs', 'readonly');
      const store = tx.objectStore('audio_blobs');
      const req = store.get(key);

      req.onsuccess = () => resolve(req.result ? req.result.blob : null);
      req.onerror = (e) => reject(e.target.error);
    });
  }

  /**
   * Get all waypoint audio blobs for a soundwalk feature
   */
  async getAllWaypointAudioBlobs(featureId) {
    if (!this.db) await this.init();

    return new Promise((resolve, reject) => {
      const tx = this.db.transaction('audio_blobs', 'readonly');
      const store = tx.objectStore('audio_blobs');
      const req = store.getAll();

      req.onsuccess = () => {
        const results = req.result || [];
        const wpMap = new Map();
        const prefix = `${featureId}_wp_`;
        for (const item of results) {
          if (item.id && item.id.startsWith(prefix)) {
            const idxStr = item.id.substring(prefix.length);
            const idx = parseInt(idxStr, 10);
            if (!isNaN(idx)) {
              wpMap.set(idx, item.blob);
            }
          }
        }
        resolve(wpMap);
      };
      req.onerror = (e) => reject(e.target.error);
    });
  }

  /**
   * Delete a sound feature and its associated primary audio blob and all waypoint blobs
   */
  async deleteSound(id) {
    if (!this.db) await this.init();

    return new Promise((resolve, reject) => {
      const tx = this.db.transaction(['features', 'audio_blobs'], 'readwrite');
      const featureStore = tx.objectStore('features');
      const blobStore = tx.objectStore('audio_blobs');

      featureStore.delete(id);
      blobStore.delete(id);

      // Clean up any waypoint blobs for this feature
      const req = blobStore.getAllKeys();
      req.onsuccess = () => {
        const keys = req.result || [];
        const prefix = `${id}_wp_`;
        for (const k of keys) {
          if (typeof k === 'string' && k.startsWith(prefix)) {
            blobStore.delete(k);
          }
        }
      };

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

  /**
   * Helper to convert Blob to Base64 data URL
   */
  async blobToBase64(blob) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onloadend = () => resolve(reader.result);
      reader.onerror = reject;
      reader.readAsDataURL(blob);
    });
  }

  /**
   * Helper to convert Base64 data URL to Blob
   */
  base64ToBlob(base64Data, mimeType = 'audio/wav') {
    const parts = base64Data.split(';base64,');
    const contentType = parts.length > 1 ? parts[0].replace('data:', '') : mimeType;
    const raw = window.atob(parts.length > 1 ? parts[1] : parts[0]);
    const rawLength = raw.length;
    const uInt8Array = new Uint8Array(rawLength);

    for (let i = 0; i < rawLength; ++i) {
      uInt8Array[i] = raw.charCodeAt(i);
    }

    return new Blob([uInt8Array], { type: contentType });
  }

  /**
   * Exports an Open Audio Cartography Protocol (OACP) Archival Bundle
   * Embeds spatial GeoJSON metadata + base64 binary audio payloads into a standalone portable JSON package.
   */
  async exportOACPBundle(features = null) {
    if (!this.db) await this.init();

    let allFeatures = features;
    if (!allFeatures || !Array.isArray(allFeatures) || allFeatures.length === 0) {
      allFeatures = await this.getAllFeatures();
    }
    if (!Array.isArray(allFeatures)) {
      allFeatures = [];
    }

    const embeddedFeatures = [];
    for (const feat of allFeatures) {
      const clone = JSON.parse(JSON.stringify(feat));
      const audioBlob = await this.getAudioBlob(feat.id);
      if (audioBlob) {
        const base64Data = await this.blobToBase64(audioBlob);
        clone.properties.audio = {
          ...(clone.properties.audio || {}),
          embeddedBinaryBase64: base64Data,
          embeddedMimeType: audioBlob.type
        };
      }

      // Check for waypoint audio blobs if feature is a soundwalk
      if (clone.properties?.spatialPlayback?.waypoints && Array.isArray(clone.properties.spatialPlayback.waypoints)) {
        for (let i = 0; i < clone.properties.spatialPlayback.waypoints.length; i++) {
          const wpBlob = await this.getWaypointAudioBlob(feat.id, i);
          if (wpBlob) {
            const wpBase64 = await this.blobToBase64(wpBlob);
            clone.properties.spatialPlayback.waypoints[i].audio = {
              ...(clone.properties.spatialPlayback.waypoints[i].audio || {}),
              embeddedBinaryBase64: wpBase64,
              embeddedMimeType: wpBlob.type
            };
          }
        }
      }

      embeddedFeatures.push(clone);
    }

    const bundle = {
      protocol: 'OpenAudioCartographyProtocol/1.0',
      type: 'FeatureCollection',
      metadata: {
        title: 'SonicMapper Complete Archival Soundscape Package (OACP Bundle)',
        exportedAt: new Date().toISOString(),
        featureCount: embeddedFeatures.length,
        hasEmbeddedBinaries: true
      },
      features: embeddedFeatures
    };

    const jsonStr = JSON.stringify(bundle, null, 2);
    const blob = new Blob([jsonStr], { type: 'application/json' });
    const url = URL.createObjectURL(blob);

    const a = document.createElement('a');
    a.href = url;
    a.download = `sonicmapper_oacp_bundle_${new Date().toISOString().slice(0, 10)}.oacp.json`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);

    return bundle;
  }
}
