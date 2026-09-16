/**
 * SonicMapper - Main Application Bootstrap
 */
import { AudioEngine } from './audio-engine.js';
import { MapController } from './map-controller.js';
import { UIController } from './ui-controller.js';
import { StorageEngine } from './storage-engine.js';

class App {
  constructor() {
    this.storageEngine = new StorageEngine();
    this.audioEngine = new AudioEngine();
    this.mapController = new MapController({
      containerId: 'map-container',
      initialCenter: [115.8605, -31.9505], // Perth Wetlands
      initialZoom: 15.5
    });
    this.uiController = null;
  }

  async init() {
    console.log('Initializing SonicMapper v0.5.0...');

    // 1. Initialize Storage & Map Engines
    await this.storageEngine.init();
    await this.mapController.init();

    // 2. Fetch Sample GeoJSON Manifest
    let defaultData = { features: [] };
    try {
      const resp = await fetch('./data/sample-soundscape.json');
      defaultData = await resp.json();
    } catch (e) {
      console.warn('Could not load sample GeoJSON:', e);
    }

    // 3. Load Persistent Custom Features from IndexedDB
    const savedFeatures = await this.storageEngine.getAllFeatures();

    // Merge default features with saved features (avoiding duplicate IDs)
    const savedIds = new Set(savedFeatures.map(f => f.id));
    const mergedFeatures = [
      ...defaultData.features.filter(f => !savedIds.has(f.id)),
      ...savedFeatures
    ];

    const fullSoundData = {
      type: 'FeatureCollection',
      features: mergedFeatures
    };

    // 4. Register Sound Nodes (with Blob loading from IndexedDB)
    for (const feat of mergedFeatures) {
      const audioBlob = await this.storageEngine.getAudioBlob(feat.id);
      this.audioEngine.createSoundSource(feat, audioBlob);
    }

    // 5. Render Sound Markers and Zones on Map
    this.mapController.renderSoundscapeFeatures(fullSoundData);

    // 6. Initialize UI Coordinator
    this.uiController = new UIController({
      audioEngine: this.audioEngine,
      mapController: this.mapController,
      storageEngine: this.storageEngine
    });

    // 7. Connect Map Listener to Audio Engine
    this.mapController.onListenerMove = (coords) => {
      this.audioEngine.updateListenerPosition(coords);
      this.uiController.updateHUD();
    };

    // 8. Connect Pin Click to Drawer & Pin Drop to Modal
    this.mapController.onSoundSelect = (feature) => {
      this.uiController.openFeatureDetails(feature);
      this.mapController.focusOnPin(feature.geometry.coordinates);
    };

    this.mapController.onPinDrop = (coords) => {
      this.uiController.openAddSoundModal(coords);
    };

    // 9. Load Version Info into Modal and Badges
    try {
      const vResp = await fetch('./version.json');
      const vData = await vResp.json();
      const versionStr = `v${vData.version}`;
      const vBadge = document.getElementById('version-badge');
      const menuVBadge = document.getElementById('menu-version-badge');
      const vText = document.getElementById('version-text');
      if (vBadge) vBadge.innerText = versionStr;
      if (menuVBadge) menuVBadge.innerText = versionStr;
      if (vText) vText.innerText = versionStr;
      document.getElementById('build-stage').innerText = vData.stage;
      document.getElementById('build-date').innerText = vData.buildDate;
      const featList = document.getElementById('build-features');
      if (featList && vData.features) {
        featList.innerHTML = vData.features.map(f => `<li>${f}</li>`).join('');
      }
    } catch (err) {
      console.warn('Version info load warning:', err);
    }

    console.log('SonicMapper ready.');
  }
}

// Bootstrap on DOMContentLoaded
window.addEventListener('DOMContentLoaded', () => {
  const app = new App();
  app.init();
});
