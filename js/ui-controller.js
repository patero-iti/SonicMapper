/**
 * UIController - Coordinates UI states, Playback Drawer, Canvas Visualizers, 
 * Add Pin Modal, Edit Pin Modal, Drag Relocation & HUD
 */
import { GeoEngine } from './geo-engine.js';

export class UIController {
  constructor({ audioEngine, mapController, storageEngine }) {
    this.audio = audioEngine;
    this.map = mapController;
    this.storage = storageEngine;
    this.selectedFeature = null;
    this.isDrawerOpen = false;
    this.pendingDropCoords = null;
    this.animationFrameId = null;

    // Canvas elements
    this.canvasWave = document.getElementById('visualizer-canvas');
    this.canvasCtx = this.canvasWave?.getContext('2d');

    // Wire up Map Pin Drop handler
    this.map.onPinDrop = (coords) => {
      this.openAddSoundModal(coords);
    };

    // Wire up Map Pin Drag / Relocate real-time listeners
    this.map.onSoundMove = (feature, coords) => {
      this.audio.updateSoundCoordinates(feature.id, coords);
      if (this.selectedFeature && this.selectedFeature.id === feature.id) {
        const coordsEl = document.getElementById('drawer-coords');
        if (coordsEl) coordsEl.innerText = GeoEngine.formatCoords(coords);
      }
      this.updateHUD();
    };

    this.map.onSoundMoved = async (feature, coords) => {
      this.audio.updateSoundCoordinates(feature.id, coords);
      await this.storage.saveSound(feature);
      if (this.selectedFeature && this.selectedFeature.id === feature.id) {
        const coordsEl = document.getElementById('drawer-coords');
        if (coordsEl) coordsEl.innerText = GeoEngine.formatCoords(coords);
      }
      this.updateHUD();
    };

    this.bindEvents();
    this.startVisualizerLoop();
  }

  bindEvents() {
    // Master Start / Audio Unlock Splash
    const startBtn = document.getElementById('btn-start-audio');
    if (startBtn) {
      startBtn.addEventListener('click', async () => {
        await this.audio.startAllSpatialSources();
        document.getElementById('splash-overlay').classList.add('hidden');
        this.updateHUD();
      });
    }

    // Burger Navigation Menu Toggle & Backdrop
    const menuToggleBtn = document.getElementById('btn-menu-toggle');
    const menuCloseBtn = document.getElementById('btn-close-menu');
    const menuBackdrop = document.getElementById('menu-backdrop');
    const menuDrawer = document.getElementById('menu-drawer');

    const openMenu = () => {
      menuDrawer?.classList.remove('hidden');
      menuBackdrop?.classList.remove('hidden');
      menuToggleBtn?.classList.add('active');
    };

    const closeMenu = () => {
      menuDrawer?.classList.add('hidden');
      menuBackdrop?.classList.add('hidden');
      menuToggleBtn?.classList.remove('active');
    };

    if (menuToggleBtn) {
      menuToggleBtn.addEventListener('click', () => {
        if (menuDrawer?.classList.contains('hidden')) {
          openMenu();
        } else {
          closeMenu();
        }
      });
    }

    if (menuCloseBtn) menuCloseBtn.addEventListener('click', closeMenu);
    if (menuBackdrop) menuBackdrop.addEventListener('click', closeMenu);

    // Quick Add Button in Header
    const quickAddBtn = document.getElementById('btn-quick-add');
    if (quickAddBtn) {
      quickAddBtn.addEventListener('click', () => {
        closeMenu();
        this.toggleAddPinMode();
      });
    }

    // Lower-Left Master Volume Slider & Mute Toggle
    const volumeSlider = document.getElementById('master-volume');
    const volumeVal = document.getElementById('volume-val');
    const muteBtn = document.getElementById('btn-volume-mute');
    const iconVolHigh = document.getElementById('icon-vol-high');
    const iconVolMuted = document.getElementById('icon-vol-muted');
    let previousVolume = 0.85;

    const updateVolumeUI = (val) => {
      if (volumeVal) volumeVal.innerText = `${Math.round(val * 100)}%`;
      if (val === 0) {
        if (iconVolHigh) iconVolHigh.style.display = 'none';
        if (iconVolMuted) iconVolMuted.style.display = 'block';
      } else {
        if (iconVolHigh) iconVolHigh.style.display = 'block';
        if (iconVolMuted) iconVolMuted.style.display = 'none';
      }
    };

    if (volumeSlider) {
      volumeSlider.addEventListener('input', (e) => {
        const val = parseFloat(e.target.value);
        this.audio.setMasterVolume(val);
        if (val > 0) previousVolume = val;
        updateVolumeUI(val);
      });
    }

    if (muteBtn) {
      muteBtn.addEventListener('click', () => {
        if (this.audio.masterVolume > 0) {
          previousVolume = this.audio.masterVolume;
          this.audio.setMasterVolume(0);
          if (volumeSlider) volumeSlider.value = 0;
          updateVolumeUI(0);
        } else {
          const restoreVal = previousVolume > 0 ? previousVolume : 0.85;
          this.audio.setMasterVolume(restoreVal);
          if (volumeSlider) volumeSlider.value = restoreVal;
          updateVolumeUI(restoreVal);
        }
      });
    }

    // Mode Selector Buttons (inside Burger Menu)
    document.querySelectorAll('.mode-btn').forEach((btn) => {
      btn.addEventListener('click', (e) => {
        const mode = e.currentTarget.dataset.mode;
        this.setMode(mode);
        closeMenu();
      });
    });

    // Map Theme Switcher Dropdown (inside Burger Menu)
    const themeSelect = document.getElementById('select-map-theme');
    if (themeSelect) {
      themeSelect.addEventListener('change', (e) => {
        this.map.setMapTheme(e.target.value);
      });
    }

    // Diagnostics / Radar Overlay Toggle & Close
    const diagHUD = document.getElementById('diagnostics-hud');
    const toggleDiagBtn = document.getElementById('btn-toggle-diagnostics');
    const closeDiagBtn = document.getElementById('btn-close-diagnostics');

    if (toggleDiagBtn) {
      toggleDiagBtn.addEventListener('click', () => {
        diagHUD?.classList.toggle('hidden');
        closeMenu();
      });
    }
    if (closeDiagBtn) {
      closeDiagBtn.addEventListener('click', () => {
        diagHUD?.classList.add('hidden');
      });
    }

    // Drawer Close Button
    const closeDrawerBtn = document.getElementById('btn-close-drawer');
    if (closeDrawerBtn) {
      closeDrawerBtn.addEventListener('click', () => {
        this.closeDrawer();
      });
    }

    // Solo Audition Button
    const auditionBtn = document.getElementById('btn-audition-toggle');
    if (auditionBtn) {
      auditionBtn.addEventListener('click', () => {
        if (!this.selectedFeature) return;
        if (this.audio.activeAuditionId === this.selectedFeature.id) {
          this.audio.setSoloAudition(null);
          auditionBtn.classList.remove('active');
          auditionBtn.innerHTML = '<span>▶</span> Solo Audition';
        } else {
          this.audio.setSoloAudition(this.selectedFeature.id);
          auditionBtn.classList.add('active');
          auditionBtn.innerHTML = '<span>⏸</span> Stop Audition';
        }
      });
    }

    // Edit Sound Button in Drawer
    const editBtn = document.getElementById('btn-edit-pin');
    if (editBtn) {
      editBtn.addEventListener('click', () => {
        if (!this.selectedFeature) return;
        this.openEditSoundModal(this.selectedFeature);
      });
    }

    // Move / Relocate Pin Button in Drawer
    const moveBtn = document.getElementById('btn-move-pin');
    if (moveBtn) {
      moveBtn.addEventListener('click', () => {
        if (!this.selectedFeature) return;
        const featId = this.selectedFeature.id;
        this.closeDrawer();
        this.map.setRelocatingPinMode(featId);
      });
    }

    // Cancel Relocate Button in Banner
    const cancelRelocateBtn = document.getElementById('btn-cancel-relocate');
    if (cancelRelocateBtn) {
      cancelRelocateBtn.addEventListener('click', () => {
        this.map.setRelocatingPinMode(null);
      });
    }

    // Relocate Button inside Edit Modal
    const modalRepositionBtn = document.getElementById('btn-modal-reposition');
    if (modalRepositionBtn) {
      modalRepositionBtn.addEventListener('click', () => {
        const id = document.getElementById('edit-sound-id').value;
        this.closeEditSoundModal();
        this.map.setRelocatingPinMode(id);
      });
    }

    // Delete Sound Button in Drawer
    const deleteBtn = document.getElementById('btn-delete-pin');
    if (deleteBtn) {
      deleteBtn.addEventListener('click', async () => {
        if (!this.selectedFeature) return;
        const title = this.selectedFeature.properties.title || 'this recording';
        if (confirm(`Are you sure you want to delete "${title}"?`)) {
          const id = this.selectedFeature.id;
          await this.storage.deleteSound(id);
          this.audio.removeSoundSource(id);
          this.map.removeSoundFeature(id);
          this.closeDrawer();
          this.updateHUD();
        }
      });
    }

    // "+ Add Sound" Button (inside Burger Menu)
    const addSoundBtn = document.getElementById('btn-add-sound');
    if (addSoundBtn) {
      addSoundBtn.addEventListener('click', () => {
        closeMenu();
        this.toggleAddPinMode();
      });
    }

    // Banner Cancel Drop Button
    const cancelDropBtn = document.getElementById('btn-cancel-drop');
    if (cancelDropBtn) {
      cancelDropBtn.addEventListener('click', () => {
        this.map.setAddingPinMode(false);
      });
    }

    // Add Modal Close Button
    const closeAddModalBtn = document.getElementById('btn-close-add-modal');
    if (closeAddModalBtn) {
      closeAddModalBtn.addEventListener('click', () => {
        this.closeAddSoundModal();
      });
    }

    // Add Modal Radius Slider Dynamic Label
    const modalRadius = document.getElementById('field-radius');
    if (modalRadius) {
      modalRadius.addEventListener('input', (e) => {
        document.getElementById('modal-radius-val').innerText = `${e.target.value}m`;
      });
    }

    // Add Modal Form Submission
    const addForm = document.getElementById('add-sound-form');
    if (addForm) {
      addForm.addEventListener('submit', async (e) => {
        e.preventDefault();
        await this.handleSaveNewSound();
      });
    }

    // Edit Modal Close Buttons
    const closeEditModalBtn = document.getElementById('btn-close-edit-modal');
    if (closeEditModalBtn) {
      closeEditModalBtn.addEventListener('click', () => {
        this.closeEditSoundModal();
      });
    }
    const cancelEditModalBtn = document.getElementById('btn-cancel-edit-modal');
    if (cancelEditModalBtn) {
      cancelEditModalBtn.addEventListener('click', () => {
        this.closeEditSoundModal();
      });
    }

    // Edit Modal Radius Slider Dynamic Label
    const editRadius = document.getElementById('edit-field-radius');
    if (editRadius) {
      editRadius.addEventListener('input', (e) => {
        document.getElementById('edit-modal-radius-val').innerText = `${e.target.value}m`;
      });
    }

    // Edit Modal Form Submission
    const editForm = document.getElementById('edit-sound-form');
    if (editForm) {
      editForm.addEventListener('submit', async (e) => {
        e.preventDefault();
        await this.handleSaveEditedSound();
      });
    }

    // Export GeoJSON Button
    const exportBtn = document.getElementById('btn-export-geojson');
    if (exportBtn) {
      exportBtn.addEventListener('click', async () => {
        try {
          const currentFeatures = (this.map && this.map.features && this.map.features.length > 0)
            ? this.map.features
            : await this.storage.getAllFeatures();
          await this.storage.exportGeoJSON(currentFeatures);
          closeMenu();
        } catch (err) {
          console.error('Failed to export GeoJSON:', err);
          alert('Export failed: ' + err.message);
        }
      });
    }

    // Import GeoJSON File Picker
    const importInput = document.getElementById('input-import-geojson');
    if (importInput) {
      importInput.addEventListener('change', async (e) => {
        const file = e.target.files[0];
        if (!file) return;
        try {
          const text = await file.text();
          const geoData = JSON.parse(text);
          if (geoData.features && Array.isArray(geoData.features)) {
            for (const feat of geoData.features) {
              await this.storage.saveSound(feat);
              this.audio.createSoundSource(feat);
              this.map.addSoundFeature(feat);
            }
            this.updateHUD();
            alert(`Successfully imported ${geoData.features.length} soundscapes!`);
            closeMenu();
          }
        } catch (err) {
          alert('Error importing GeoJSON: ' + err.message);
        }
        e.target.value = '';
      });
    }

    // Diagnostic / Version Modal Toggle (Top Badge & Menu Footer)
    const versionBadge = document.getElementById('version-badge');
    const menuVersionBadge = document.getElementById('menu-version-badge');
    const versionModal = document.getElementById('version-modal');
    const closeVersionBtn = document.getElementById('btn-close-version');

    const showVersionModal = () => {
      closeMenu();
      versionModal?.classList.remove('hidden');
    };

    if (versionBadge) versionBadge.addEventListener('click', showVersionModal);
    if (menuVersionBadge) menuVersionBadge.addEventListener('click', showVersionModal);

    if (closeVersionBtn && versionModal) {
      closeVersionBtn.addEventListener('click', () => {
        versionModal.classList.add('hidden');
      });
    }
  }

  toggleAddPinMode() {
    const active = !this.map.isAddingPin;
    this.map.setAddingPinMode(active);
  }

  openAddSoundModal(coords) {
    this.pendingDropCoords = coords;
    document.getElementById('field-coords').value = `${coords[1].toFixed(5)}, ${coords[0].toFixed(5)}`;
    document.getElementById('add-sound-modal').classList.remove('hidden');
  }

  closeAddSoundModal() {
    this.pendingDropCoords = null;
    document.getElementById('add-sound-modal').classList.add('hidden');
    document.getElementById('add-sound-form').reset();
    document.getElementById('modal-radius-val').innerText = '60m';
  }

  async handleSaveNewSound() {
    const title = document.getElementById('field-title').value.trim() || 'Untitled Field Recording';
    const recordist = document.getElementById('field-recordist').value.trim() || 'Field Recordist';
    const taxonomy = document.getElementById('field-taxonomy').value;
    const format = document.getElementById('field-format')?.value || 'stereo';
    const radius = parseInt(document.getElementById('field-radius').value, 10) || 60;
    const rolloff = document.getElementById('field-rolloff').value;
    const mic = document.getElementById('field-mic').value.trim() || (format.includes('ambisonic') ? 'Tetrahedral FOA Mic' : 'Binaural Pair');
    const equipment = document.getElementById('field-equipment').value.trim() || 'Portable Field Recorder';
    const weather = document.getElementById('field-weather').value.trim() || 'Fine conditions';
    const description = document.getElementById('field-description').value.trim() || '';
    const audioFileInput = document.getElementById('field-audio-file');

    const coords = this.pendingDropCoords || this.map.initialCenter;
    const soundId = `rec_${Date.now()}_${Math.random().toString(36).substr(2, 6)}`;

    let audioBlob = null;
    let synthType = null;

    if (audioFileInput.files && audioFileInput.files[0]) {
      audioBlob = audioFileInput.files[0];
    } else {
      synthType = format.includes('ambisonic') 
        ? 'ambisonic_field'
        : taxonomy === 'biophony' ? 'birdsong' : taxonomy === 'geophony' ? 'water' : 'urban';
    }

    const channels = format.includes('ambisonic') ? 4 : format === 'mono' ? 1 : 2;

    const newFeature = {
      type: 'Feature',
      id: soundId,
      geometry: {
        type: 'Point',
        coordinates: coords
      },
      properties: {
        title,
        recordist,
        timestamp: new Date().toISOString(),
        synthType,
        audio: {
          format: audioBlob ? audioBlob.type : 'audio/synthetic',
          duration: 0,
          channels: channels,
          channelFormat: format,
          sampleRate: 48000,
          micConfiguration: mic
        },
        spatialPlayback: {
          triggerType: 'proximity',
          radiusMeters: radius,
          rolloff: rolloff,
          loop: true,
          attenuationMaxDb: -60
        },
        archival: {
          license: 'CC-BY-SA 4.0',
          taxonomies: [taxonomy],
          weather,
          equipment,
          description
        }
      }
    };

    // 1. Save to IndexedDB
    await this.storage.saveSound(newFeature, audioBlob);

    // 2. Add to Audio Engine
    this.audio.createSoundSource(newFeature, audioBlob);

    // 3. Add to Map Controller
    this.map.addSoundFeature(newFeature);

    // 4. Clean up and open drawer
    this.closeAddSoundModal();
    this.openFeatureDetails(newFeature);
    this.updateHUD();
  }

  /**
   * Open Edit Sound Recording Modal with pre-filled feature properties
   */
  openEditSoundModal(feature) {
    this.selectedFeature = feature;
    const props = feature.properties;
    const arch = props.archival || {};
    const audio = props.audio || {};
    const spatial = props.spatialPlayback || {};
    const coords = feature.geometry.coordinates;

    document.getElementById('edit-sound-id').value = feature.id;
    document.getElementById('edit-field-coords').value = `${coords[1].toFixed(5)}, ${coords[0].toFixed(5)}`;
    document.getElementById('edit-field-title').value = props.title || '';
    document.getElementById('edit-field-recordist').value = props.recordist || '';
    document.getElementById('edit-field-taxonomy').value = arch.taxonomies?.[0] || 'biophony';
    document.getElementById('edit-field-format').value = audio.channelFormat || 'stereo';
    document.getElementById('edit-field-rolloff').value = spatial.rolloff || 'exponential';
    document.getElementById('edit-field-radius').value = spatial.radiusMeters || 60;
    document.getElementById('edit-modal-radius-val').innerText = `${spatial.radiusMeters || 60}m`;
    document.getElementById('edit-field-mic').value = audio.micConfiguration || '';
    document.getElementById('edit-field-equipment').value = arch.equipment || '';
    document.getElementById('edit-field-weather').value = arch.weather || '';
    document.getElementById('edit-field-description').value = arch.description || '';
    document.getElementById('edit-field-audio-file').value = '';

    document.getElementById('edit-sound-modal').classList.remove('hidden');
  }

  closeEditSoundModal() {
    document.getElementById('edit-sound-modal').classList.add('hidden');
    document.getElementById('edit-sound-form').reset();
  }

  async handleSaveEditedSound() {
    const id = document.getElementById('edit-sound-id').value;
    const feat = this.map.features.find(f => f.id === id) || this.selectedFeature;
    if (!feat) return;

    const title = document.getElementById('edit-field-title').value.trim() || 'Untitled Field Recording';
    const recordist = document.getElementById('edit-field-recordist').value.trim() || 'Field Recordist';
    const taxonomy = document.getElementById('edit-field-taxonomy').value;
    const format = document.getElementById('edit-field-format').value;
    const rolloff = document.getElementById('edit-field-rolloff').value;
    const radius = parseInt(document.getElementById('edit-field-radius').value, 10) || 60;
    const mic = document.getElementById('edit-field-mic').value.trim() || 'Microphone';
    const equipment = document.getElementById('edit-field-equipment').value.trim() || '';
    const weather = document.getElementById('edit-field-weather').value.trim() || '';
    const description = document.getElementById('edit-field-description').value.trim() || '';
    const audioFileInput = document.getElementById('edit-field-audio-file');

    let newAudioBlob = null;
    if (audioFileInput.files && audioFileInput.files[0]) {
      newAudioBlob = audioFileInput.files[0];
    }

    const channels = format.includes('ambisonic') ? 4 : format === 'mono' ? 1 : 2;

    feat.properties.title = title;
    feat.properties.recordist = recordist;
    feat.properties.archival = {
      ...(feat.properties.archival || {}),
      taxonomies: [taxonomy],
      equipment,
      weather,
      description
    };
    feat.properties.audio = {
      ...(feat.properties.audio || {}),
      channelFormat: format,
      channels: channels,
      micConfiguration: mic
    };
    if (newAudioBlob) {
      feat.properties.audio.format = newAudioBlob.type;
      feat.properties.synthType = null;
    }
    feat.properties.spatialPlayback = {
      ...(feat.properties.spatialPlayback || {}),
      radiusMeters: radius,
      rolloff: rolloff
    };

    // 1. Save to Storage (IndexedDB)
    await this.storage.saveSound(feat, newAudioBlob);

    // 2. Update Audio Engine
    this.audio.updateSoundSource(feat, newAudioBlob);

    // 3. Update Map visuals & polygons
    this.map.updateSoundFeature(feat);

    // 4. Update UI Drawer
    this.closeEditSoundModal();
    this.openFeatureDetails(feat);
    this.updateHUD();
  }

  /**
   * Set Application Mode: 'mock-gps' | 'location' | 'static'
   */
  setMode(mode) {
    this.audio.mode = mode;
    this.map.mode = mode;

    document.querySelectorAll('.mode-btn').forEach((btn) => {
      btn.classList.toggle('active', btn.dataset.mode === mode);
    });

    const hudModeEl = document.getElementById('hud-mode-text');
    if (hudModeEl) {
      hudModeEl.innerText = mode.toUpperCase().replace('-', ' ');
    }

    if (mode === 'location') {
      this.startGeolocationTracking();
    } else {
      this.stopGeolocationTracking();
    }

    this.audio.updateProximityMix();
    this.updateHUD();
  }

  /**
   * Browser Geolocation API watchPosition
   */
  startGeolocationTracking() {
    if (!navigator.geolocation) {
      alert('Geolocation is not supported by your browser.');
      this.setMode('mock-gps');
      return;
    }

    this.geoWatchId = navigator.geolocation.watchPosition(
      (pos) => {
        const coords = [pos.coords.longitude, pos.coords.latitude];
        const heading = pos.coords.heading || 0;
        this.audio.updateListenerPosition(coords, heading);
        this.map.setListenerCoordinates(coords, true);
        this.updateHUD();
      },
      (err) => {
        console.warn('GPS Error:', err.message);
      },
      {
        enableHighAccuracy: true,
        maximumAge: 1000,
        timeout: 10000
      }
    );
  }

  stopGeolocationTracking() {
    if (this.geoWatchId) {
      navigator.geolocation.clearWatch(this.geoWatchId);
      this.geoWatchId = null;
    }
  }

  /**
   * Open Drawer with feature metadata and visualization
   */
  openFeatureDetails(feature) {
    this.selectedFeature = feature;
    this.isDrawerOpen = true;
    document.body.classList.add('drawer-open');

    const drawer = document.getElementById('playback-drawer');
    drawer.classList.remove('collapsed');

    const props = feature.properties;
    const arch = props.archival || {};
    const audio = props.audio || {};
    const format = audio.channelFormat || (audio.channels === 4 ? 'ambisonic_ambix' : 'stereo');

    document.getElementById('drawer-title').innerText = props.title || 'Untitled Recording';
    document.getElementById('drawer-recordist').innerText = props.recordist || 'Unknown';
    document.getElementById('drawer-date').innerText = props.timestamp ? new Date(props.timestamp).toLocaleDateString() : 'N/A';
    document.getElementById('drawer-coords').innerText = GeoEngine.formatCoords(feature.geometry.coordinates);
    document.getElementById('drawer-mic').innerText = audio.micConfiguration || 'Standard';
    document.getElementById('drawer-equipment').innerText = arch.equipment || 'N/A';
    document.getElementById('drawer-weather').innerText = arch.weather || 'N/A';
    document.getElementById('drawer-description').innerText = arch.description || 'No description provided.';
    document.getElementById('drawer-taxonomy-tag').innerText = (arch.taxonomies?.[0] || 'Acoustic').toUpperCase();
    document.getElementById('drawer-taxonomy-tag').className = `tax-badge tax-${arch.taxonomies?.[0] || 'biophony'}`;

    // Format Tag and Card
    const formatTag = document.getElementById('drawer-format-tag');
    const formatValue = document.getElementById('drawer-format');
    if (formatTag) {
      if (format.includes('ambisonic')) {
        formatTag.innerText = 'Ambisonic FOA (360°)';
        formatTag.style.background = 'rgba(14, 165, 233, 0.18)';
        formatTag.style.color = '#38bdf8';
        formatTag.style.border = '1px solid rgba(56, 189, 248, 0.4)';
      } else if (format === 'binaural') {
        formatTag.innerText = 'Binaural Stereo';
        formatTag.style.background = 'rgba(168, 85, 247, 0.18)';
        formatTag.style.color = '#c084fc';
        formatTag.style.border = '1px solid rgba(192, 132, 252, 0.4)';
      } else {
        formatTag.innerText = format.toUpperCase();
        formatTag.style.background = 'rgba(100, 116, 139, 0.18)';
        formatTag.style.color = '#94a3b8';
        formatTag.style.border = '1px solid rgba(148, 163, 184, 0.4)';
      }
    }
    if (formatValue) {
      formatValue.innerText = format === 'ambisonic_ambix' 
        ? 'First-Order Ambisonics (AmbiX 4-Ch)' 
        : format === 'ambisonic_fuma'
        ? 'First-Order Ambisonics (FuMa 4-Ch)'
        : format === 'binaural'
        ? 'In-Ear Binaural Pair (Stereo)'
        : format === 'mono'
        ? 'Monophonic (1-Ch)'
        : 'Stereo (2-Ch)';
    }

    // Reset Audition button state
    const auditionBtn = document.getElementById('btn-audition-toggle');
    if (auditionBtn) {
      if (this.audio.activeAuditionId === feature.id) {
        auditionBtn.classList.add('active');
        auditionBtn.innerHTML = '<span>⏸</span> Stop Audition';
      } else {
        auditionBtn.classList.remove('active');
        auditionBtn.innerHTML = '<span>▶</span> Solo Audition';
      }
    }
  }

  closeDrawer() {
    this.isDrawerOpen = false;
    document.body.classList.remove('drawer-open');
    document.getElementById('playback-drawer').classList.add('collapsed');
  }

  /**
   * Updates Diagnostic HUD (Coordinates, active sound levels)
   */
  updateHUD() {
    const coordsEl = document.getElementById('hud-coords');
    if (coordsEl && this.audio.listenerPosition) {
      coordsEl.innerText = GeoEngine.formatCoords(this.audio.listenerPosition);
    }

    const listEl = document.getElementById('active-sounds-list');
    if (listEl) {
      const active = this.audio.getActiveAudibleSounds();
      if (active.length === 0) {
        listEl.innerHTML = '<div class="sound-row empty">Out of proximity radius</div>';
      } else {
        listEl.innerHTML = active
          .map(
            (s) => `
          <div class="sound-row">
            <span class="sound-dot dot-${s.taxonomy}"></span>
            <span class="sound-name">${s.title} ${s.isAmbisonic ? '<span style="font-size:9px; background:rgba(14,165,233,0.25); color:#38bdf8; padding:1px 4px; border-radius:3px; margin-left:4px;">FOA</span>' : ''}</span>
            <span class="sound-dist">${s.distance}m</span>
            <span class="sound-gain">${s.gain}%</span>
          </div>
        `
          )
          .join('');
      }
    }
  }

  /**
   * High-Performance Real-Time Canvas Visualizer
   */
  startVisualizerLoop() {
    const render = () => {
      if (this.canvasWave && this.canvasCtx) {
        const { freqData, waveData } = this.audio.getVisualizerData();
        const width = this.canvasWave.width = this.canvasWave.parentElement.clientWidth || 300;
        const height = this.canvasWave.height = 70;
        const ctx = this.canvasCtx;

        ctx.clearRect(0, 0, width, height);

        // Render FFT Frequency Bars in background
        if (freqData.length > 0) {
          const barWidth = (width / freqData.length) * 2.5;
          let barX = 0;
          for (let i = 0; i < freqData.length; i++) {
            const barHeight = (freqData[i] / 255) * height;
            ctx.fillStyle = `rgba(232, 59, 178, ${0.15 + (freqData[i] / 255) * 0.45})`;
            ctx.fillRect(barX, height - barHeight, barWidth, barHeight);
            barX += barWidth + 1;
          }
        }

        // Render Oscilloscope Time-Domain Waveform in foreground
        if (waveData.length > 0) {
          ctx.lineWidth = 2.5;
          ctx.strokeStyle = '#e83bb2';
          ctx.beginPath();

          const sliceWidth = (width * 1.0) / waveData.length;
          let x = 0;

          for (let i = 0; i < waveData.length; i++) {
            const v = waveData[i] / 128.0;
            const y = (v * height) / 2;

            if (i === 0) {
              ctx.moveTo(x, y);
            } else {
              ctx.lineTo(x, y);
            }
            x += sliceWidth;
          }

          ctx.lineTo(width, height / 2);
          ctx.stroke();
        }
      }

      this.animationFrameId = requestAnimationFrame(render);
    };

    render();
  }
}
