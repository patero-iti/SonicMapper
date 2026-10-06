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
   * Helper to stream/chunk a Blob to Base64 parts into an array without exceeding V8 string limits
   */
  async appendBlobBase64Chunks(blob, partsArray) {
    if (!blob) {
      partsArray.push('null');
      return;
    }

    const mimeType = blob.type || 'audio/wav';
    partsArray.push(`"data:${mimeType};base64,`);

    // 3MB chunks: exact multiple of 3 ensures no Base64 padding '=' characters between intermediate chunk boundaries
    const CHUNK_SIZE = 3 * 1024 * 1024;
    let offset = 0;

    while (offset < blob.size) {
      const slice = blob.slice(offset, Math.min(offset + CHUNK_SIZE, blob.size));
      const buffer = await slice.arrayBuffer();
      const bytes = new Uint8Array(buffer);

      let binary = '';
      const subChunk = 16384;
      for (let i = 0; i < bytes.byteLength; i += subChunk) {
        const sub = bytes.subarray(i, Math.min(i + subChunk, bytes.byteLength));
        binary += String.fromCharCode.apply(null, sub);
      }
      
      const base64Chunk = window.btoa(binary);
      partsArray.push(base64Chunk);
      offset += CHUNK_SIZE;
    }

    partsArray.push('"');
  }

  /**
   * Helper to convert Blob to Base64 data URL (for small Blobs or fallback)
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
   * Helper to convert Base64 data URL to Blob safely in chunks to avoid memory & stack limits
   */
  base64ToBlob(base64Data, mimeType = 'audio/wav') {
    if (!base64Data || typeof base64Data !== 'string') return null;
    try {
      const parts = base64Data.split(';base64,');
      const contentType = parts.length > 1 ? parts[0].replace('data:', '') : mimeType;
      const rawBase64 = parts.length > 1 ? parts[1] : parts[0];

      // Decode Base64 in 65536 char chunks (must be a multiple of 4)
      const b64ChunkSize = 65536;
      const byteChunks = [];

      for (let i = 0; i < rawBase64.length; i += b64ChunkSize) {
        const b64Slice = rawBase64.slice(i, i + b64ChunkSize);
        const binaryChunk = window.atob(b64Slice);
        const u8 = new Uint8Array(binaryChunk.length);
        for (let j = 0; j < binaryChunk.length; j++) {
          u8[j] = binaryChunk.charCodeAt(j);
        }
        byteChunks.push(u8);
      }

      return new Blob(byteChunks, { type: contentType });
    } catch (err) {
      console.error('Error converting base64 to Blob:', err);
      return null;
    }
  }

  /**
   * Exports an Open Audio Cartography Protocol (OACP) Archival Bundle
   * Embeds spatial GeoJSON metadata + chunked base64 binary audio payloads into a standalone portable JSON package.
   * Uses chunked Blob part streaming to completely eliminate V8 string length and memory exhaustion limits.
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

    const blobParts = [];
    blobParts.push('{\n  "protocol": "OpenAudioCartographyProtocol/1.0",\n  "type": "FeatureCollection",\n  "metadata": {\n');
    blobParts.push(`    "title": "SonicMapper Complete Archival Soundscape Package (OACP Bundle)",\n`);
    blobParts.push(`    "exportedAt": ${JSON.stringify(new Date().toISOString())},\n`);
    blobParts.push(`    "featureCount": ${allFeatures.length},\n`);
    blobParts.push(`    "hasEmbeddedBinaries": true\n`);
    blobParts.push('  },\n  "features": [\n');

    for (let featIdx = 0; featIdx < allFeatures.length; featIdx++) {
      const feat = allFeatures[featIdx];
      // Clone feature without binary payloads to maintain clean metadata
      const featClone = JSON.parse(JSON.stringify(feat));

      const primaryAudioBlob = await this.getAudioBlob(feat.id);
      const waypoints = featClone.properties?.spatialPlayback?.waypoints;
      const waypointBlobs = [];
      if (Array.isArray(waypoints)) {
        for (let w = 0; w < waypoints.length; w++) {
          const wpBlob = await this.getWaypointAudioBlob(feat.id, w);
          waypointBlobs.push(wpBlob);
        }
      }

      const hasPrimary = !!primaryAudioBlob;
      const hasWaypoints = waypointBlobs.some(b => !!b);

      // If no binary audio for this feature, serialize metadata directly
      if (!hasPrimary && !hasWaypoints) {
        const featureStr = JSON.stringify(featClone, null, 2).replace(/\n/g, '\n    ');
        blobParts.push('    ' + featureStr);
        if (featIdx < allFeatures.length - 1) blobParts.push(',\n');
        else blobParts.push('\n');
        continue;
      }

      // Generate unique token placeholders for audio binaries
      const PRIMARY_AUDIO_TOKEN = `__OACP_PRIMARY_AUDIO_TOKEN_${Date.now()}_${Math.random().toString(36).slice(2)}__`;
      const WAYPOINT_TOKEN_PREFIX = `__OACP_WAYPOINT_TOKEN_${Date.now()}_${Math.random().toString(36).slice(2)}_`;

      if (hasPrimary) {
        featClone.properties.audio = {
          ...(featClone.properties.audio || {}),
          embeddedBinaryBase64: PRIMARY_AUDIO_TOKEN,
          embeddedMimeType: primaryAudioBlob.type || 'audio/wav'
        };
      }

      if (Array.isArray(waypoints)) {
        for (let w = 0; w < waypoints.length; w++) {
          if (waypointBlobs[w]) {
            waypoints[w].audio = {
              ...(waypoints[w].audio || {}),
              embeddedBinaryBase64: `${WAYPOINT_TOKEN_PREFIX}${w}__`,
              embeddedMimeType: waypointBlobs[w].type || 'audio/wav'
            };
          }
        }
      }

      // Stringify the skeleton with formatted indentation
      const featureSkeleton = '    ' + JSON.stringify(featClone, null, 2).replace(/\n/g, '\n    ');

      // Match quoted tokens: "__OACP_..."
      const tokenRegex = new RegExp(`"(${PRIMARY_AUDIO_TOKEN}|${WAYPOINT_TOKEN_PREFIX}(\\d+)__)"`, 'g');
      let cursor = 0;
      let match;

      while ((match = tokenRegex.exec(featureSkeleton)) !== null) {
        const matchStart = match.index;
        const matchEnd = tokenRegex.lastIndex;

        // Push text preceding the token
        blobParts.push(featureSkeleton.substring(cursor, matchStart));

        const matchedToken = match[1];
        if (matchedToken === PRIMARY_AUDIO_TOKEN && primaryAudioBlob) {
          await this.appendBlobBase64Chunks(primaryAudioBlob, blobParts);
        } else if (matchedToken.startsWith(WAYPOINT_TOKEN_PREFIX)) {
          const wpIdx = parseInt(match[2], 10);
          const wpBlob = waypointBlobs[wpIdx];
          if (wpBlob) {
            await this.appendBlobBase64Chunks(wpBlob, blobParts);
          } else {
            blobParts.push('null');
          }
        }

        cursor = matchEnd;
      }

      // Push remaining portion of the feature JSON
      blobParts.push(featureSkeleton.substring(cursor));

      if (featIdx < allFeatures.length - 1) {
        blobParts.push(',\n');
      } else {
        blobParts.push('\n');
      }
    }

    blobParts.push('  ]\n}\n');

    const blob = new Blob(blobParts, { type: 'application/json' });
    const url = URL.createObjectURL(blob);

    const a = document.createElement('a');
    a.href = url;
    a.download = `sonicmapper_oacp_bundle_${new Date().toISOString().slice(0, 10)}.oacp.json`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);

    return true;
  }
}
