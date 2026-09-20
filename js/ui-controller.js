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

    // Phase 2 Mobile Sensor & Field State
    this.lastGpsCoords = null;
    this.currentHeading = 0;
    this.wakeLock = null;
    this.orientationHandler = null;
    this.geoWatchId = null;

    // Phase 3 Archival & Spectrogram State
    this.visMode = 'waveform'; // 'waveform', 'fft', 'spectrogram'
    this.spectrogramHistory = []; // Historical frequency slices

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
    this.initMediaSession();
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

    // Audio Download / Export Button in Drawer
    const downloadBtn = document.getElementById('btn-download-sound');
    if (downloadBtn) {
      downloadBtn.addEventListener('click', async () => {
        if (!this.selectedFeature) return;
        await this.handleDownloadAudio(this.selectedFeature);
      });
    }

    // Visualizer Mode Switcher Pills
    document.querySelectorAll('.vis-pill').forEach((pill) => {
      pill.addEventListener('click', (e) => {
        document.querySelectorAll('.vis-pill').forEach(p => p.classList.remove('active'));
        e.currentTarget.classList.add('active');
        this.visMode = e.currentTarget.dataset.vis || 'waveform';
      });
    });

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

    // "Draw Polygon Zone" Quick Header Button & Menu Button
    const quickDrawPolyBtn = document.getElementById('btn-quick-draw-polygon');
    const drawPolyBtn = document.getElementById('btn-draw-polygon');
    if (quickDrawPolyBtn) {
      quickDrawPolyBtn.addEventListener('click', () => {
        closeMenu();
        this.startPolygonDrawMode();
      });
    }
    if (drawPolyBtn) {
      drawPolyBtn.addEventListener('click', () => {
        closeMenu();
        this.startPolygonDrawMode();
      });
    }

    // Polygon Draw Banner Actions: Finish, Undo, Cancel
    const finishPolyBtn = document.getElementById('btn-finish-polygon');
    if (finishPolyBtn) {
      finishPolyBtn.addEventListener('click', () => {
        this.map.finishDrawingPolygon();
      });
    }
    const undoPolyBtn = document.getElementById('btn-undo-polygon');
    if (undoPolyBtn) {
      undoPolyBtn.addEventListener('click', () => {
        this.map.undoPolygonDrawVertex();
      });
    }
    const cancelPolyBtn = document.getElementById('btn-cancel-polygon');
    if (cancelPolyBtn) {
      cancelPolyBtn.addEventListener('click', () => {
        this.map.cancelDrawingPolygon();
      });
    }

    // Polygon Reshaping Banner Actions: Save & Cancel
    const savePolyEditBtn = document.getElementById('btn-save-polygon-edit');
    if (savePolyEditBtn) {
      savePolyEditBtn.addEventListener('click', () => {
        this.map.saveEditingPolygon();
      });
    }
    const cancelPolyEditBtn = document.getElementById('btn-cancel-polygon-edit');
    if (cancelPolyEditBtn) {
      cancelPolyEditBtn.addEventListener('click', () => {
        this.map.cancelEditingPolygon();
      });
    }

    // Drawer "Edit Boundary" Button
    const editPolyShapeBtn = document.getElementById('btn-edit-polygon-shape');
    if (editPolyShapeBtn) {
      editPolyShapeBtn.addEventListener('click', () => {
        if (!this.selectedFeature) return;
        this.startPolygonEditMode(this.selectedFeature);
      });
    }

    // Polygon Creation Modal Buffer Slider
    const polyBufferSlider = document.getElementById('poly-field-radius');
    if (polyBufferSlider) {
      polyBufferSlider.addEventListener('input', (e) => {
        const valEl = document.getElementById('poly-modal-buffer-val');
        if (valEl) valEl.innerText = `${e.target.value}m`;
      });
    }

    // Polygon Creation Modal Close / Cancel
    const closePolyModalBtn = document.getElementById('btn-close-polygon-modal');
    const cancelPolyModalBtn = document.getElementById('btn-cancel-polygon-modal');
    if (closePolyModalBtn) closePolyModalBtn.addEventListener('click', () => this.closeAddPolygonModal());
    if (cancelPolyModalBtn) cancelPolyModalBtn.addEventListener('click', () => this.closeAddPolygonModal());

    // Polygon Creation Form Submission
    const addPolyForm = document.getElementById('add-polygon-form');
    if (addPolyForm) {
      addPolyForm.addEventListener('submit', async (e) => {
        e.preventDefault();
        await this.handleSaveNewPolygonZone();
      });
    }

    // "Draw Soundwalk Path" Quick Header Button & Menu Button
    const quickDrawSoundwalkBtn = document.getElementById('btn-quick-draw-soundwalk');
    const drawSoundwalkBtn = document.getElementById('btn-draw-soundwalk');
    if (quickDrawSoundwalkBtn) {
      quickDrawSoundwalkBtn.addEventListener('click', () => {
        closeMenu();
        this.startSoundwalkDrawMode();
      });
    }
    if (drawSoundwalkBtn) {
      drawSoundwalkBtn.addEventListener('click', () => {
        closeMenu();
        this.startSoundwalkDrawMode();
      });
    }

    // Soundwalk Draw Banner Actions: Finish, Undo, Cancel
    const finishSoundwalkBtn = document.getElementById('btn-finish-soundwalk-draw');
    if (finishSoundwalkBtn) {
      finishSoundwalkBtn.addEventListener('click', () => {
        this.map.finishDrawingSoundwalk();
      });
    }
    const undoSoundwalkBtn = document.getElementById('btn-undo-soundwalk-draw');
    if (undoSoundwalkBtn) {
      undoSoundwalkBtn.addEventListener('click', () => {
        this.map.undoSoundwalkDrawVertex();
      });
    }
    const cancelSoundwalkBtn = document.getElementById('btn-cancel-soundwalk-draw');
    if (cancelSoundwalkBtn) {
      cancelSoundwalkBtn.addEventListener('click', () => {
        this.map.cancelDrawingSoundwalk();
      });
    }

    // Soundwalk Reshaping Banner Actions: Save & Cancel
    const saveSoundwalkEditBtn = document.getElementById('btn-save-soundwalk-edit');
    if (saveSoundwalkEditBtn) {
      saveSoundwalkEditBtn.addEventListener('click', () => {
        this.map.saveEditingSoundwalk();
      });
    }
    const cancelSoundwalkEditBtn = document.getElementById('btn-cancel-soundwalk-edit');
    if (cancelSoundwalkEditBtn) {
      cancelSoundwalkEditBtn.addEventListener('click', () => {
        this.map.cancelEditingSoundwalk();
      });
    }

    // Drawer "Edit Trail" Button
    const editSoundwalkShapeBtn = document.getElementById('btn-edit-soundwalk-shape');
    if (editSoundwalkShapeBtn) {
      editSoundwalkShapeBtn.addEventListener('click', () => {
        if (!this.selectedFeature) return;
        this.startSoundwalkEditMode(this.selectedFeature);
      });
    }

    // Soundwalk Creation Modal Sliders
    const soundwalkBufferSlider = document.getElementById('soundwalk-field-radius');
    if (soundwalkBufferSlider) {
      soundwalkBufferSlider.addEventListener('input', (e) => {
        const valEl = document.getElementById('soundwalk-modal-buffer-val');
        if (valEl) valEl.innerText = `${e.target.value}m`;
      });
    }

    const soundwalkSynthVolSlider = document.getElementById('soundwalk-field-synth-vol');
    if (soundwalkSynthVolSlider) {
      soundwalkSynthVolSlider.addEventListener('input', (e) => {
        const valEl = document.getElementById('soundwalk-modal-synth-vol-val');
        if (valEl) valEl.innerText = `${e.target.value}%`;
      });
    }

    const soundwalkAudioVolSlider = document.getElementById('soundwalk-field-audio-vol');
    if (soundwalkAudioVolSlider) {
      soundwalkAudioVolSlider.addEventListener('input', (e) => {
        const valEl = document.getElementById('soundwalk-modal-audio-vol-val');
        if (valEl) valEl.innerText = `${e.target.value}%`;
      });
    }

    // Playback Drawer Soundwalk Mixer Controls
    const drawerSynthSlider = document.getElementById('drawer-soundwalk-synth-slider');
    if (drawerSynthSlider) {
      drawerSynthSlider.addEventListener('input', (e) => {
        if (!this.selectedFeature) return;
        const val = parseInt(e.target.value, 10);
        const valEl = document.getElementById('drawer-soundwalk-synth-val');
        if (valEl) valEl.innerText = `${val}%`;
        this.audio.setSoundSynthVolume(this.selectedFeature.id, val / 100);
      });
      drawerSynthSlider.addEventListener('change', async () => {
        if (this.selectedFeature) {
          await this.storage.saveSound(this.selectedFeature);
        }
      });
    }

    const drawerAudioSlider = document.getElementById('drawer-soundwalk-audio-slider');
    if (drawerAudioSlider) {
      drawerAudioSlider.addEventListener('input', (e) => {
        if (!this.selectedFeature) return;
        const val = parseInt(e.target.value, 10);
        const valEl = document.getElementById('drawer-soundwalk-audio-val');
        if (valEl) valEl.innerText = `${val}%`;
        this.audio.setSoundAudioVolume(this.selectedFeature.id, val / 100);
      });
      drawerAudioSlider.addEventListener('change', async () => {
        if (this.selectedFeature) {
          await this.storage.saveSound(this.selectedFeature);
        }
      });
    }

    const drawerAudioFileInput = document.getElementById('drawer-soundwalk-audio-file-input');
    if (drawerAudioFileInput) {
      drawerAudioFileInput.addEventListener('change', async (e) => {
        if (!this.selectedFeature) return;
        const file = e.target.files[0];
        if (file) {
          await this.storage.saveSound(this.selectedFeature, file);
          this.audio.updateSoundSource(this.selectedFeature, file);
          const audioStatusEl = document.getElementById('drawer-soundwalk-audio-status');
          if (audioStatusEl) audioStatusEl.innerText = '🎵 Master Trail Audio Active';
          e.target.value = '';
        }
      });
    }

    // Waypoints Stem Deck Accordion Toggle
    const toggleWaypointsDeckBtn = document.getElementById('btn-toggle-waypoints-deck');
    if (toggleWaypointsDeckBtn) {
      toggleWaypointsDeckBtn.addEventListener('click', () => {
        const listEl = document.getElementById('drawer-waypoints-list');
        const chevronEl = document.getElementById('waypoints-accordion-chevron');
        if (listEl) {
          listEl.classList.toggle('collapsed');
          if (chevronEl) {
            chevronEl.style.transform = listEl.classList.contains('collapsed') ? 'rotate(-90deg)' : 'rotate(0deg)';
          }
        }
      });
    }

    // Soundwalk Creation Modal Close / Cancel
    const closeSoundwalkModalBtn = document.getElementById('btn-close-soundwalk-modal');
    const cancelSoundwalkModalBtn = document.getElementById('btn-cancel-soundwalk-modal');
    if (closeSoundwalkModalBtn) closeSoundwalkModalBtn.addEventListener('click', () => this.closeAddSoundwalkModal());
    if (cancelSoundwalkModalBtn) cancelSoundwalkModalBtn.addEventListener('click', () => this.closeAddSoundwalkModal());

    // Soundwalk Creation Form Submission
    const addSoundwalkForm = document.getElementById('add-soundwalk-form');
    if (addSoundwalkForm) {
      addSoundwalkForm.addEventListener('submit', async (e) => {
        e.preventDefault();
        await this.handleSaveNewSoundwalk();
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

    // Export OACP Standalone Archival Package Button
    const exportOacpBtn = document.getElementById('btn-export-oacp');
    if (exportOacpBtn) {
      exportOacpBtn.addEventListener('click', async () => {
        try {
          const currentFeatures = (this.map && this.map.features && this.map.features.length > 0)
            ? this.map.features
            : await this.storage.getAllFeatures();
          await this.storage.exportOACPBundle(currentFeatures);
          closeMenu();
        } catch (err) {
          console.error('Failed to export OACP Package:', err);
          alert('Export failed: ' + err.message);
        }
      });
    }

    // Import GeoJSON / OACP File Picker
    const importInput = document.getElementById('input-import-geojson');
    if (importInput) {
      importInput.addEventListener('change', async (e) => {
        const file = e.target.files[0];
        if (!file) return;
        await this.handleImportFile(file);
        closeMenu();
        e.target.value = '';
      });
    }

    // Setup Global Viewport Drag & Drop Ingestion
    this.setupViewportDragAndDrop();

    // Setup Online / Offline Network Status Monitoring
    this.initNetworkStatus();

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

  /**
   * Universal file import handler (GeoJSON, OACP Bundle with base64 audio, or raw audio files)
   */
  async handleImportFile(file) {
    if (!file) return;
    try {
      if (file.name.endsWith('.geojson') || file.name.endsWith('.json') || file.type.includes('json')) {
        const text = await file.text();
        const geoData = JSON.parse(text);
        if (geoData.features && Array.isArray(geoData.features)) {
          for (const feat of geoData.features) {
            let audioBlob = null;
            if (feat.properties?.audio?.embeddedBinaryBase64) {
              audioBlob = this.storage.base64ToBlob(
                feat.properties.audio.embeddedBinaryBase64,
                feat.properties.audio.embeddedMimeType || 'audio/wav'
              );
            }
            await this.storage.saveSound(feat, audioBlob);
            this.audio.createSoundSource(feat, audioBlob);
            this.map.addSoundFeature(feat);
          }
          this.updateHUD();
          alert(`Successfully ingested ${geoData.features.length} soundscapes into session!`);
        }
      } else if (file.type.startsWith('audio/') || file.name.match(/\.(wav|mp3|ogg|flac|m4a|aac)$/i)) {
        // Direct audio file drop: Pin recording at listener position
        const coords = this.audio.listenerPosition || this.map.initialCenter;
        const soundId = `rec_${Date.now()}_${Math.random().toString(36).substr(2, 6)}`;
        const cleanName = file.name.replace(/\.[^/.]+$/, '').replace(/[_-]/g, ' ');

        const newFeature = {
          type: 'Feature',
          id: soundId,
          geometry: {
            type: 'Point',
            coordinates: coords
          },
          properties: {
            title: cleanName.charAt(0).toUpperCase() + cleanName.slice(1),
            recordist: 'Field Importer',
            timestamp: new Date().toISOString(),
            synthType: null,
            audio: {
              format: file.type || 'audio/wav',
              duration: 0,
              channels: 2,
              channelFormat: 'stereo',
              sampleRate: 48000,
              micConfiguration: 'Field Capture'
            },
            spatialPlayback: {
              triggerType: 'proximity',
              radiusMeters: 60,
              rolloff: 'exponential',
              loop: true,
              attenuationMaxDb: -60
            },
            archival: {
              license: 'CC-BY-SA 4.0',
              taxonomies: ['biophony'],
              weather: 'Imported capture',
              equipment: 'Direct File Drop',
              description: `Imported audio asset: ${file.name}`
            }
          }
        };

        await this.storage.saveSound(newFeature, file);
        this.audio.createSoundSource(newFeature, file);
        this.map.addSoundFeature(newFeature);
        this.openFeatureDetails(newFeature);
        this.updateHUD();
        alert(`Successfully imported audio asset "${file.name}"!`);
      }
    } catch (err) {
      console.error('Import error:', err);
      alert('Error importing file: ' + err.message);
    }
  }

  /**
   * Setup global window drag-and-drop listener for seamless viewport data ingestion
   */
  setupViewportDragAndDrop() {
    const overlay = document.getElementById('viewport-drop-overlay');
    let dragCounter = 0;

    if (overlay) {
      overlay.addEventListener('click', () => {
        overlay.classList.add('hidden');
        dragCounter = 0;
      });
    }

    window.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && overlay) {
        overlay.classList.add('hidden');
        dragCounter = 0;
      }
    });

    window.addEventListener('dragenter', (e) => {
      e.preventDefault();
      if (e.dataTransfer && e.dataTransfer.types && Array.from(e.dataTransfer.types).includes('Files')) {
        dragCounter++;
        if (overlay) overlay.classList.remove('hidden');
      }
    });

    window.addEventListener('dragover', (e) => {
      e.preventDefault();
    });

    window.addEventListener('dragleave', (e) => {
      e.preventDefault();
      dragCounter--;
      if (dragCounter <= 0 && overlay) {
        overlay.classList.add('hidden');
        dragCounter = 0;
      }
    });

    window.addEventListener('drop', async (e) => {
      e.preventDefault();
      dragCounter = 0;
      if (overlay) overlay.classList.add('hidden');

      if (e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files.length > 0) {
        for (let i = 0; i < e.dataTransfer.files.length; i++) {
          await this.handleImportFile(e.dataTransfer.files[i]);
        }
      }
    });
  }

  /**
   * Monitor online/offline network lifecycle and update UI badge
   */
  initNetworkStatus() {
    const badge = document.getElementById('network-status-badge');
    const updateStatus = () => {
      if (!badge) return;
      if (navigator.onLine) {
        badge.className = 'network-badge online';
        badge.innerText = '🟢 Online';
        badge.title = 'Connected to network';
      } else {
        badge.className = 'network-badge offline';
        badge.innerText = '📶 Offline Cached';
        badge.title = 'Operating offline via Service Worker cache';
      }
    };

    window.addEventListener('online', updateStatus);
    window.addEventListener('offline', updateStatus);
    updateStatus();
  }

  toggleAddPinMode() {
    const active = !this.map.isAddingPin;
    this.map.setAddingPinMode(active);
  }

  startPolygonDrawMode() {
    this.closeDrawer();
    this.map.startDrawingPolygon({
      onComplete: (coords) => {
        this.openAddPolygonModal(coords);
      }
    });
  }

  openAddPolygonModal(coordinates) {
    this.pendingPolygonCoords = coordinates;

    // Calculate metrics
    const area = Math.round(GeoEngine.calculatePolygonArea(coordinates));
    const perimeter = Math.round(GeoEngine.calculatePolygonPerimeter(coordinates));
    const vertexCount = Array.isArray(coordinates[0]) ? coordinates[0].length - 1 : coordinates.length;

    const vEl = document.getElementById('poly-modal-vertices');
    const aEl = document.getElementById('poly-modal-area');
    const pEl = document.getElementById('poly-modal-perimeter');
    if (vEl) vEl.innerText = `Vertices: ${vertexCount}`;
    if (aEl) aEl.innerText = `Area: ~${area.toLocaleString()} m²`;
    if (pEl) pEl.innerText = `Perimeter: ~${perimeter.toLocaleString()} m`;

    document.getElementById('add-polygon-modal')?.classList.remove('hidden');
  }

  closeAddPolygonModal() {
    this.pendingPolygonCoords = null;
    document.getElementById('add-polygon-modal')?.classList.add('hidden');
    document.getElementById('add-polygon-form')?.reset();
    const bufVal = document.getElementById('poly-modal-buffer-val');
    if (bufVal) bufVal.innerText = '50m';
  }

  async handleSaveNewPolygonZone() {
    if (!this.pendingPolygonCoords) return;

    const title = document.getElementById('poly-field-title').value.trim() || 'Untitled Habitat Zone';
    const recordist = document.getElementById('poly-field-recordist').value.trim() || 'Field Ecologist';
    const taxonomy = document.getElementById('poly-field-taxonomy').value || 'biophony';
    const synthType = document.getElementById('poly-field-synth').value || 'water';
    const buffer = parseInt(document.getElementById('poly-field-radius').value, 10) || 50;
    const description = document.getElementById('poly-field-description').value.trim() || '';
    const audioFileInput = document.getElementById('poly-field-audio-file');

    let audioBlob = null;
    if (audioFileInput.files && audioFileInput.files[0]) {
      audioBlob = audioFileInput.files[0];
    }

    const soundId = `zone_${Date.now()}_${Math.random().toString(36).substr(2, 6)}`;
    const newFeature = {
      type: 'Feature',
      id: soundId,
      geometry: {
        type: 'Polygon',
        coordinates: this.pendingPolygonCoords
      },
      properties: {
        title,
        recordist,
        timestamp: new Date().toISOString(),
        synthType: audioBlob ? null : synthType,
        audio: {
          format: audioBlob ? audioBlob.type : 'audio/synthetic',
          duration: 0,
          channels: 2,
          channelFormat: 'stereo',
          sampleRate: 48000,
          micConfiguration: 'Zone Ambient Habitat'
        },
        spatialPlayback: {
          triggerType: 'proximity',
          radiusMeters: buffer,
          rolloff: 'exponential',
          loop: true,
          attenuationMaxDb: -60
        },
        archival: {
          license: 'CC-BY-SA 4.0',
          taxonomies: [taxonomy],
          weather: 'Acoustic Zone Boundary',
          equipment: 'Geofence Cartography',
          description
        }
      }
    };

    // 1. Save to Storage (IndexedDB)
    await this.storage.saveSound(newFeature, audioBlob);

    // 2. Add to Audio Engine
    this.audio.createSoundSource(newFeature, audioBlob);

    // 3. Add to Map Controller
    this.map.addSoundFeature(newFeature);

    // 4. Close modal and open drawer
    this.closeAddPolygonModal();
    this.openFeatureDetails(newFeature);
    this.updateHUD();
  }

  startPolygonEditMode(feature) {
    this.closeDrawer();
    this.map.startEditingPolygon(feature, {
      onSave: async (updatedFeat) => {
        await this.storage.saveSound(updatedFeat);
        this.audio.updateSoundSource(updatedFeat);
        this.openFeatureDetails(updatedFeat);
        this.updateHUD();
      },
      onCancel: () => {
        this.openFeatureDetails(feature);
      }
    });
  }

  /* ==========================================================================
     Soundwalk Trajectory Drawing & Reshaping UI Handlers
     ========================================================================== */

  startSoundwalkDrawMode() {
    this.closeDrawer();
    this.map.startDrawingSoundwalk({
      onComplete: (coords) => {
        this.openAddSoundwalkModal(coords);
      }
    });
  }

  openAddSoundwalkModal(coordinates) {
    this.pendingSoundwalkCoords = coordinates;

    const totalDist = Math.round(GeoEngine.calculateLineLength(coordinates));
    const distText = totalDist > 1000 ? `${(totalDist / 1000).toFixed(2)} km` : `~${totalDist} m`;
    const waypointsCount = coordinates.length;

    const wpEl = document.getElementById('soundwalk-modal-waypoints');
    const dEl = document.getElementById('soundwalk-modal-distance');
    if (wpEl) wpEl.innerText = `Waypoints: ${waypointsCount}`;
    if (dEl) dEl.innerText = `Total Length: ${distText}`;

    // Render dynamic per-waypoint stem attachment rows
    const container = document.getElementById('soundwalk-modal-waypoints-list');
    if (container) {
      container.innerHTML = coordinates.map((c, i) => `
        <div class="modal-waypoint-card" data-wp-index="${i}">
          <div class="modal-wp-header">
            <span class="modal-wp-badge">${i === 0 ? '⚑ Trailhead' : (i + 1)}</span>
            <input type="text" class="modal-wp-name-input form-input" value="${i === 0 ? 'Trailhead' : 'Waypoint ' + (i + 1)}" placeholder="Waypoint Name">
          </div>
          <div class="modal-wp-body">
            <div class="modal-wp-col">
              <label>Acoustic Preset</label>
              <select class="modal-wp-synth-select form-select">
                <option value="" selected>None / Inherit Bed</option>
                <option value="birdsong">Birdsong / Canopy</option>
                <option value="water">Water / Shoreline</option>
                <option value="wind">Wind / Rustle</option>
              </select>
            </div>
            <div class="modal-wp-col">
              <label>Stem Audio File (Optional)</label>
              <input type="file" class="modal-wp-file-input" accept="audio/*">
            </div>
            <div class="modal-wp-col">
              <label>Trigger Radius: <span class="wp-radius-val">30m</span></label>
              <input type="range" class="modal-wp-radius-slider volume-slider" min="10" max="100" step="5" value="30">
            </div>
            <div class="modal-wp-col">
              <label>Stem Volume: <span class="wp-vol-val">85%</span></label>
              <input type="range" class="modal-wp-vol-slider volume-slider" min="0" max="100" step="1" value="85">
            </div>
          </div>
        </div>
      `).join('');

      // Wire radius and volume slider text updates in modal
      container.querySelectorAll('.modal-waypoint-card').forEach(card => {
        const rSlider = card.querySelector('.modal-wp-radius-slider');
        const rVal = card.querySelector('.wp-radius-val');
        if (rSlider && rVal) {
          rSlider.addEventListener('input', (e) => { rVal.innerText = `${e.target.value}m`; });
        }
        const vSlider = card.querySelector('.modal-wp-vol-slider');
        const vVal = card.querySelector('.wp-vol-val');
        if (vSlider && vVal) {
          vSlider.addEventListener('input', (e) => { vVal.innerText = `${e.target.value}%`; });
        }
      });
    }

    document.getElementById('add-soundwalk-modal')?.classList.remove('hidden');
  }

  closeAddSoundwalkModal() {
    this.pendingSoundwalkCoords = null;
    document.getElementById('add-soundwalk-modal')?.classList.add('hidden');
    document.getElementById('add-soundwalk-form')?.reset();
    const bufVal = document.getElementById('soundwalk-modal-buffer-val');
    if (bufVal) bufVal.innerText = '40m';
    const synthVal = document.getElementById('soundwalk-modal-synth-vol-val');
    if (synthVal) synthVal.innerText = '35%';
    const audioVal = document.getElementById('soundwalk-modal-audio-vol-val');
    if (audioVal) audioVal.innerText = '85%';
    const container = document.getElementById('soundwalk-modal-waypoints-list');
    if (container) container.innerHTML = '';
  }

  async handleSaveNewSoundwalk() {
    if (!this.pendingSoundwalkCoords) return;

    const title = document.getElementById('soundwalk-field-title').value.trim() || 'Untitled Soundwalk Trail';
    const recordist = document.getElementById('soundwalk-field-recordist').value.trim() || 'Acoustic Cartography Collective';
    const taxonomy = document.getElementById('soundwalk-field-taxonomy').value || 'biophony';
    const synthType = document.getElementById('soundwalk-field-synth').value || 'wind';
    const synthVolume = (parseFloat(document.getElementById('soundwalk-field-synth-vol')?.value) || 35) / 100;
    const audioVolume = (parseFloat(document.getElementById('soundwalk-field-audio-vol')?.value) || 85) / 100;
    const radiusMeters = parseInt(document.getElementById('soundwalk-field-radius').value, 10) || 40;
    const description = document.getElementById('soundwalk-field-description').value.trim() || '';
    const audioFileInput = document.getElementById('soundwalk-field-audio-file');

    let audioBlob = null;
    if (audioFileInput.files && audioFileInput.files[0]) {
      audioBlob = audioFileInput.files[0];
    }

    const soundId = `walk_${Date.now()}_${Math.random().toString(36).substr(2, 6)}`;
    
    // Parse waypoints and collect any uploaded files per waypoint
    const waypointCards = document.querySelectorAll('.modal-waypoint-card');
    const waypoints = [];
    const waypointBlobsMap = new Map();

    for (let i = 0; i < this.pendingSoundwalkCoords.length; i++) {
      const card = waypointCards[i];
      let wpName = i === 0 ? 'Trailhead' : `Waypoint ${i + 1}`;
      let wpSynth = null;
      let wpRadius = 30;
      let wpVol = 0.85;
      let wpBlob = null;

      if (card) {
        const nameIn = card.querySelector('.modal-wp-name-input');
        if (nameIn && nameIn.value.trim()) wpName = nameIn.value.trim();
        const synthSel = card.querySelector('.modal-wp-synth-select');
        if (synthSel && synthSel.value) wpSynth = synthSel.value;
        const radIn = card.querySelector('.modal-wp-radius-slider');
        if (radIn) wpRadius = parseInt(radIn.value, 10) || 30;
        const volIn = card.querySelector('.modal-wp-vol-slider');
        if (volIn) wpVol = (parseFloat(volIn.value) || 85) / 100;
        const fileIn = card.querySelector('.modal-wp-file-input');
        if (fileIn && fileIn.files && fileIn.files[0]) {
          wpBlob = fileIn.files[0];
        }
      }

      waypoints.push({
        index: i,
        name: wpName,
        coords: this.pendingSoundwalkCoords[i],
        radiusMeters: wpRadius,
        volume: wpVol,
        synthType: wpSynth
      });

      if (wpBlob) {
        waypointBlobsMap.set(i, wpBlob);
      }
    }

    const newFeature = {
      type: 'Feature',
      id: soundId,
      geometry: {
        type: 'LineString',
        coordinates: this.pendingSoundwalkCoords
      },
      properties: {
        title,
        recordist,
        timestamp: new Date().toISOString(),
        synthType: synthType,
        audio: {
          format: audioBlob ? audioBlob.type : 'audio/synthetic',
          duration: 0,
          channels: 2,
          channelFormat: 'binaural',
          sampleRate: 48000,
          micConfiguration: 'Guided Trail Acoustic Path'
        },
        spatialPlayback: {
          triggerType: 'soundwalk_path',
          radiusMeters,
          synthVolume,
          audioVolume,
          rolloff: 'linear',
          loop: true,
          attenuationMaxDb: -45,
          waypoints
        },
        archival: {
          license: 'CC-BY-SA 4.0',
          taxonomies: [taxonomy],
          weather: 'Soundwalk Trajectory Route',
          equipment: 'Polyline Acoustic Cartography',
          description
        }
      }
    };

    // 1. Save sound feature & primary audio blob to Storage (IndexedDB)
    await this.storage.saveSound(newFeature, audioBlob);

    // 2. Save any waypoint audio blobs to IndexedDB
    for (const [wpIdx, wpBlob] of waypointBlobsMap) {
      await this.storage.saveWaypointAudioBlob(soundId, wpIdx, wpBlob);
    }

    // 3. Add to Audio Engine with both primary and waypoint audio blobs
    this.audio.createSoundSource(newFeature, audioBlob, waypointBlobsMap);

    // 4. Add to Map Controller
    this.map.addSoundFeature(newFeature);

    // 5. Close modal and open drawer
    this.closeAddSoundwalkModal();
    this.openFeatureDetails(newFeature);
    this.updateHUD();
  }

  startSoundwalkEditMode(feature) {
    this.closeDrawer();
    this.map.startEditingSoundwalk(feature, {
      onSave: async (updatedFeat) => {
        await this.storage.saveSound(updatedFeat);
        this.audio.updateSoundSource(updatedFeat);
        this.openFeatureDetails(updatedFeat);
        this.updateHUD();
      },
      onCancel: () => {
        this.openFeatureDetails(feature);
      }
    });
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
    document.getElementById('edit-field-coords').value = GeoEngine.formatCoords(coords);
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
   * Browser Geolocation API watchPosition with adaptive jitter filtering and compass binding
   */
  startGeolocationTracking() {
    if (!navigator.geolocation) {
      alert('Geolocation is not supported by your browser.');
      this.setMode('mock-gps');
      return;
    }

    this.startOrientationTracking();
    this.requestWakeLock();

    this.geoWatchId = navigator.geolocation.watchPosition(
      (pos) => {
        const rawCoords = [pos.coords.longitude, pos.coords.latitude];
        const smoothedCoords = GeoEngine.smoothCoordinates(this.lastGpsCoords, rawCoords);
        this.lastGpsCoords = smoothedCoords;

        const heading = (pos.coords.heading !== null && !isNaN(pos.coords.heading) && pos.coords.heading >= 0)
          ? pos.coords.heading
          : this.currentHeading;

        this.audio.updateListenerPosition(smoothedCoords, heading);
        this.map.setListenerCoordinates(smoothedCoords, true);
        if (heading) {
          this.map.setListenerHeading(heading);
          this.updateHUDHeading(heading);
        }
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
    this.stopOrientationTracking();
    this.releaseWakeLock();
  }

  /**
   * Device Orientation Magnetometer & Compass Heading Tracking
   */
  async startOrientationTracking() {
    if (this.orientationHandler) return;

    const handleOrientation = (e) => {
      let rawHeading = null;
      if (e.webkitCompassHeading !== undefined && e.webkitCompassHeading !== null) {
        // iOS Safari provides absolute north heading
        rawHeading = e.webkitCompassHeading;
      } else if (e.alpha !== null && !isNaN(e.alpha)) {
        // Android / Chrome provides alpha degrees
        rawHeading = (360 - e.alpha) % 360;
      }

      if (rawHeading !== null && !isNaN(rawHeading)) {
        const smoothedHeading = GeoEngine.smoothHeading(this.currentHeading, rawHeading, 0.25);
        this.currentHeading = smoothedHeading;
        this.audio.updateListenerHeading(smoothedHeading);
        this.map.setListenerHeading(smoothedHeading);
        this.updateHUDHeading(smoothedHeading);
      }
    };

    // Check for iOS 13+ permission requirement
    if (typeof DeviceOrientationEvent !== 'undefined' && typeof DeviceOrientationEvent.requestPermission === 'function') {
      try {
        const permission = await DeviceOrientationEvent.requestPermission();
        if (permission === 'granted') {
          window.addEventListener('deviceorientation', handleOrientation, true);
          this.orientationHandler = handleOrientation;
        }
      } catch (err) {
        console.warn('Device orientation permission dismissed:', err);
      }
    } else if ('ondeviceorientationabsolute' in window) {
      window.addEventListener('deviceorientationabsolute', handleOrientation, true);
      this.orientationHandler = handleOrientation;
    } else if ('ondeviceorientation' in window) {
      window.addEventListener('deviceorientation', handleOrientation, true);
      this.orientationHandler = handleOrientation;
    }
  }

  stopOrientationTracking() {
    if (this.orientationHandler) {
      window.removeEventListener('deviceorientationabsolute', this.orientationHandler, true);
      window.removeEventListener('deviceorientation', this.orientationHandler, true);
      this.orientationHandler = null;
    }
  }

  /**
   * Screen Wake Lock API to keep screen on during outdoor field soundwalks
   */
  async requestWakeLock() {
    if ('wakeLock' in navigator) {
      try {
        this.wakeLock = await navigator.wakeLock.request('screen');
        document.addEventListener('visibilitychange', this.handleVisibilityChange);
      } catch (err) {
        console.warn('Screen WakeLock error:', err.message);
      }
    }
  }

  async releaseWakeLock() {
    if (this.wakeLock) {
      try {
        await this.wakeLock.release();
        this.wakeLock = null;
      } catch (e) {}
    }
    document.removeEventListener('visibilitychange', this.handleVisibilityChange);
  }

  handleVisibilityChange = async () => {
    if (document.visibilityState === 'visible' && this.map.mode === 'location' && !this.wakeLock) {
      await this.requestWakeLock();
    }
  };

  /**
   * Media Session API for mobile lock screen metadata and background spatial audio controls
   */
  initMediaSession() {
    if ('mediaSession' in navigator) {
      navigator.mediaSession.metadata = new MediaMetadata({
        title: 'SonicMapper Spatial Field Soundscape',
        artist: 'Radio DADAA Sound Art Cartography',
        album: 'Binaural FOA Acoustic Ecology',
        artwork: [
          { src: 'data:image/svg+xml,%3Csvg xmlns="http://www.w3.org/2000/svg" width="96" height="96" viewBox="0 0 100 100"%3E%3Crect width="100" height="100" rx="20" fill="%23231218"/%3E%3Ccircle cx="50" cy="50" r="30" fill="none" stroke="%23e83bb2" stroke-width="8"/%3E%3C/svg%3E', sizes: '96x96', type: 'image/svg+xml' }
        ]
      });

      navigator.mediaSession.setActionHandler('play', async () => {
        await this.audio.unlock();
      });
      navigator.mediaSession.setActionHandler('pause', () => {
        this.audio.setMasterVolume(0);
      });
    }
  }

  /**
   * Helper to format degrees into cardinal direction (N, NE, E, SE, S, SW, W, NW)
   */
  getCardinalDirection(deg) {
    const directions = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'];
    const index = Math.round(((deg % 360) + 360) % 360 / 45) % 8;
    return directions[index];
  }

  /**
   * Updates Heading indicator in diagnostics HUD
   */
  updateHUDHeading(heading) {
    const headingEl = document.getElementById('hud-heading');
    if (headingEl) {
      const card = this.getCardinalDirection(heading);
      headingEl.innerText = `🧭 ${Math.round(heading)}° ${card}`;
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

    // Toggle Polygon Reshape Button vs Soundwalk Edit Button vs Point Move Button
    const geomType = feature.geometry?.type || 'Point';
    const isPolygon = geomType === 'Polygon' || geomType === 'MultiPolygon';
    const isLineString = geomType === 'LineString' || geomType === 'MultiLineString';

    const editPolyBtn = document.getElementById('btn-edit-polygon-shape');
    const editSoundwalkBtn = document.getElementById('btn-edit-soundwalk-shape');
    const movePinBtn = document.getElementById('btn-move-pin');
    if (editPolyBtn) {
      editPolyBtn.style.display = isPolygon ? 'inline-flex' : 'none';
    }
    if (editSoundwalkBtn) {
      editSoundwalkBtn.style.display = isLineString ? 'inline-flex' : 'none';
    }
    if (movePinBtn) {
      movePinBtn.style.display = (!isPolygon && !isLineString) ? 'inline-flex' : 'none';
    }

    // Toggle Soundwalk Multi-Track Mixer Deck
    const soundwalkDeck = document.getElementById('soundwalk-drawer-deck');
    if (soundwalkDeck) {
      if (isLineString) {
        soundwalkDeck.style.display = 'block';

        const synthVol = props.spatialPlayback?.synthVolume !== undefined ? Math.round(props.spatialPlayback.synthVolume * 100) : 35;
        const audioVol = props.spatialPlayback?.audioVolume !== undefined ? Math.round(props.spatialPlayback.audioVolume * 100) : 85;
        const synthType = props.synthType || 'wind';
        const synthNameMap = {
          wind: 'Wind / Canopy Rustle',
          water: 'Water / Shoreline Lapping',
          birdsong: 'Birdsong / Forest Chorus',
          urban: 'Urban / City Ambience'
        };

        const synthNameEl = document.getElementById('drawer-soundwalk-synth-name');
        const synthSlider = document.getElementById('drawer-soundwalk-synth-slider');
        const synthValEl = document.getElementById('drawer-soundwalk-synth-val');
        if (synthNameEl) synthNameEl.innerText = synthNameMap[synthType] || synthType;
        if (synthSlider) synthSlider.value = synthVol;
        if (synthValEl) synthValEl.innerText = `${synthVol}%`;

        const audioStatusEl = document.getElementById('drawer-soundwalk-audio-status');
        const audioSlider = document.getElementById('drawer-soundwalk-audio-slider');
        const audioValEl = document.getElementById('drawer-soundwalk-audio-val');
        if (audioSlider) audioSlider.value = audioVol;
        if (audioValEl) audioValEl.innerText = `${audioVol}%`;

        const soundNode = this.audio.soundNodes.get(feature.id);
        const hasAudioTrack = !!(soundNode?.audioBlob || (props.audio?.url && props.audio.url.startsWith('http')));
        if (audioStatusEl) {
          audioStatusEl.innerText = hasAudioTrack ? '🎵 Master Trail Audio Active' : 'No Audio File Pinned';
        }

        this.renderDrawerWaypoints(feature);
      } else {
        soundwalkDeck.style.display = 'none';
      }
    }

    // Reset Audition button state
    const auditionBtn = document.getElementById('btn-audition-toggle');
    if (auditionBtn) {
      if (this.audio.activeAuditionId === feature.id && this.audio.activeAuditionWaypoint === null) {
        auditionBtn.classList.add('active');
        auditionBtn.innerHTML = '<span>⏸</span> Stop Audition';
      } else {
        auditionBtn.classList.remove('active');
        auditionBtn.innerHTML = '<span>▶</span> Solo Audition';
      }
    }
  }

  /**
   * Renders the dynamic Waypoint Stem Deck cards in the Playback Drawer
   */
  async renderDrawerWaypoints(feature) {
    const listEl = document.getElementById('drawer-waypoints-list');
    const countEl = document.getElementById('drawer-waypoints-count');
    if (!listEl) return;

    const waypoints = feature.properties?.spatialPlayback?.waypoints || [];
    if (countEl) countEl.innerText = waypoints.length;

    if (waypoints.length === 0) {
      listEl.innerHTML = '<div class="empty-waypoints-hint">No waypoints defined for this trail.</div>';
      return;
    }

    const soundNode = this.audio.soundNodes.get(feature.id);
    const htmlCards = [];

    for (let i = 0; i < waypoints.length; i++) {
      const wp = waypoints[i];
      const wpIdx = wp.index !== undefined ? wp.index : i;
      const wpCoords = GeoEngine.toCoordPair(wp.coords);
      const dist = wpCoords ? Math.round(GeoEngine.getDistance(this.audio.listenerPosition, wpCoords)) : 0;
      const vol = wp.volume !== undefined ? Math.round(wp.volume * 100) : 85;
      const radius = wp.radiusMeters || wp.radius || 30;
      const synthType = wp.synthType || null;
      const hasBlob = soundNode?.waypointNodes?.get(wpIdx)?.audioBlob || (wp.audio?.url && wp.audio.url.startsWith('http'));

      let statusBadge = '';
      if (hasBlob) {
        statusBadge = '<span class="wp-stem-badge file-active">🎵 Audio Stem Attached</span>';
      } else if (synthType) {
        statusBadge = `<span class="wp-stem-badge synth-active">✨ Procedural: ${synthType}</span>`;
      } else {
        statusBadge = '<span class="wp-stem-badge none">Inherits Trail Bed</span>';
      }

      const isAuditioning = this.audio.activeAuditionId === feature.id && this.audio.activeAuditionWaypoint === wpIdx;

      htmlCards.push(`
        <div class="drawer-waypoint-card ${isAuditioning ? 'auditioning' : ''}" data-wp-index="${wpIdx}">
          <div class="drawer-wp-top">
            <div class="drawer-wp-identity">
              <span class="drawer-wp-badge">${wpIdx === 0 ? '⚑ Trailhead' : (wpIdx + 1)}</span>
              <span class="drawer-wp-title">${wp.name || `Waypoint ${wpIdx + 1}`}</span>
            </div>
            <div class="drawer-wp-telemetry">
              <span class="drawer-wp-dist" id="drawer-wp-dist-${feature.id}-${wpIdx}">${dist}m</span>
              <button class="btn-wp-audition ${isAuditioning ? 'active' : ''}" data-sound-id="${feature.id}" data-wp-index="${wpIdx}" title="Solo Audition this Waypoint Stem">
                ${isAuditioning ? '⏸ Solo' : '▶ Solo'}
              </button>
            </div>
          </div>

          <div class="drawer-wp-mid">
            ${statusBadge}
            <span class="drawer-wp-radius-tag">Radius: ${radius}m</span>
          </div>

          <div class="drawer-wp-controls">
            <div class="drawer-wp-vol-group">
              <label>Stem Volume: <span class="drawer-wp-vol-val">${vol}%</span></label>
              <input type="range" class="drawer-wp-vol-slider volume-slider" min="0" max="100" step="1" value="${vol}" data-sound-id="${feature.id}" data-wp-index="${wpIdx}">
            </div>
            <div class="drawer-wp-actions">
              <label class="btn-wp-upload" title="Attach Audio File to Waypoint">
                📁 File
                <input type="file" class="drawer-wp-file-input" accept="audio/*" data-sound-id="${feature.id}" data-wp-index="${wpIdx}" style="display: none;">
              </label>
              <select class="drawer-wp-synth-select form-select" data-sound-id="${feature.id}" data-wp-index="${wpIdx}">
                <option value="" ${!synthType ? 'selected' : ''}>Bed Only</option>
                <option value="birdsong" ${synthType === 'birdsong' ? 'selected' : ''}>Birdsong</option>
                <option value="water" ${synthType === 'water' ? 'selected' : ''}>Water</option>
                <option value="wind" ${synthType === 'wind' ? 'selected' : ''}>Wind</option>
              </select>
            </div>
          </div>
        </div>
      `);
    }

    listEl.innerHTML = htmlCards.join('');

    // Wire events inside waypoint cards
    listEl.querySelectorAll('.drawer-wp-vol-slider').forEach(slider => {
      slider.addEventListener('input', (e) => {
        const soundId = e.target.dataset.soundId;
        const wpIdx = parseInt(e.target.dataset.wpIndex, 10);
        const val = parseInt(e.target.value, 10);
        const card = e.target.closest('.drawer-waypoint-card');
        if (card) {
          const valSpan = card.querySelector('.drawer-wp-vol-val');
          if (valSpan) valSpan.innerText = `${val}%`;
        }
        this.audio.setWaypointVolume(soundId, wpIdx, val / 100);
      });

      slider.addEventListener('change', async (e) => {
        const soundId = e.target.dataset.soundId;
        const feat = this.selectedFeature;
        if (feat && feat.id === soundId) {
          await this.storage.saveSound(feat);
        }
      });
    });

    listEl.querySelectorAll('.btn-wp-audition').forEach(btn => {
      btn.addEventListener('click', (e) => {
        const soundId = e.currentTarget.dataset.soundId;
        const wpIdx = parseInt(e.currentTarget.dataset.wpIndex, 10);
        if (this.audio.activeAuditionId === soundId && this.audio.activeAuditionWaypoint === wpIdx) {
          this.audio.setSoloAudition(null);
        } else {
          this.audio.setSoloAudition(soundId, wpIdx);
        }
        this.renderDrawerWaypoints(feature);
      });
    });

    listEl.querySelectorAll('.drawer-wp-file-input').forEach(input => {
      input.addEventListener('change', async (e) => {
        const soundId = e.target.dataset.soundId;
        const wpIdx = parseInt(e.target.dataset.wpIndex, 10);
        const file = e.target.files[0];
        if (file && feature) {
          await this.storage.saveWaypointAudioBlob(soundId, wpIdx, file);
          this.audio.setWaypointAudio(soundId, wpIdx, file);
          this.renderDrawerWaypoints(feature);
        }
      });
    });

    listEl.querySelectorAll('.drawer-wp-synth-select').forEach(sel => {
      sel.addEventListener('change', async (e) => {
        const soundId = e.target.dataset.soundId;
        const wpIdx = parseInt(e.target.dataset.wpIndex, 10);
        const val = e.target.value || null;
        if (feature.properties?.spatialPlayback?.waypoints?.[wpIdx]) {
          feature.properties.spatialPlayback.waypoints[wpIdx].synthType = val;
          await this.storage.saveSound(feature);
          const sound = this.audio.soundNodes.get(soundId);
          if (sound) {
            const wpNode = sound.waypointNodes.get(wpIdx);
            if (wpNode) {
              wpNode.synthType = val;
              if (val) this.audio.attachWaypointProceduralAudio(wpNode);
            }
          }
          this.renderDrawerWaypoints(feature);
        }
      });
    });
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
    this.updateHUDHeading(this.currentHeading);

    // Live update waypoint distances in drawer if soundwalk is selected
    if (this.isDrawerOpen && this.selectedFeature && (this.selectedFeature.geometry?.type === 'LineString' || this.selectedFeature.geometry?.type === 'MultiLineString')) {
      const waypoints = this.selectedFeature.properties?.spatialPlayback?.waypoints || [];
      waypoints.forEach((wp, idx) => {
        const wpIdx = wp.index !== undefined ? wp.index : idx;
        const wpDistEl = document.getElementById(`drawer-wp-dist-${this.selectedFeature.id}-${wpIdx}`);
        if (wpDistEl) {
          const wpCoords = GeoEngine.toCoordPair(wp.coords);
          if (wpCoords) {
            const d = Math.round(GeoEngine.getDistance(this.audio.listenerPosition, wpCoords));
            wpDistEl.innerText = `${d}m`;
          }
        }
      });
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
   * Generates and triggers audio asset download for a feature (Uploaded Blob, URL, or Procedural WAV bounce)
   */
  async handleDownloadAudio(feature) {
    const title = feature.properties.title || 'soundscape_recording';
    const cleanTitle = title.toLowerCase().replace(/[^a-z0-9]/gi, '_').replace(/_+/g, '_');

    try {
      // 1. Check if user-uploaded blob exists in IndexedDB
      const storedBlob = await this.storage.getAudioBlob(feature.id);
      if (storedBlob) {
        const ext = storedBlob.type.includes('ogg') ? 'ogg' : storedBlob.type.includes('mp3') ? 'mp3' : 'wav';
        this.triggerBlobDownload(storedBlob, `${cleanTitle}.${ext}`);
        return;
      }

      // 2. Check if remote URL exists
      if (feature.properties.audio?.url && feature.properties.audio.url.startsWith('http')) {
        const resp = await fetch(feature.properties.audio.url);
        if (resp.ok) {
          const remoteBlob = await resp.blob();
          const ext = feature.properties.audio.format?.includes('ogg') ? 'ogg' : 'wav';
          this.triggerBlobDownload(remoteBlob, `${cleanTitle}.${ext}`);
          return;
        }
      }

      // 3. Procedural Synthetic Sound -> Synthesize high-quality uncompressed 16-bit 48kHz WAV bounce via OfflineAudioContext
      const wavBlob = await this.renderProceduralWav(feature);
      this.triggerBlobDownload(wavBlob, `${cleanTitle}_archival_synth.wav`);
    } catch (err) {
      console.error('Audio download error:', err);
      alert('Could not download audio: ' + err.message);
    }
  }

  triggerBlobDownload(blob, filename) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  /**
   * Offline audio render helper to export procedural sound synthesis to WAV Blob
   */
  async renderProceduralWav(feature) {
    const sampleRate = 48000;
    const duration = 6.0; // 6 seconds loop
    const OfflineCtx = window.OfflineAudioContext || window.webkitOfflineAudioContext;
    const offlineCtx = new OfflineCtx(2, Math.floor(sampleRate * duration), sampleRate);

    const type = feature.properties.synthType || 
      (feature.properties.archival?.taxonomies?.[0] === 'geophony' ? 'water' : 
       feature.properties.archival?.taxonomies?.[0] === 'biophony' ? 'birdsong' : 'urban');

    if (type === 'birdsong') {
      const osc = offlineCtx.createOscillator();
      const lfo = offlineCtx.createOscillator();
      const lfoGain = offlineCtx.createGain();
      osc.type = 'sine';
      osc.frequency.setValueAtTime(2400, 0);
      lfo.type = 'triangle';
      lfo.frequency.setValueAtTime(4.5, 0);
      lfoGain.gain.setValueAtTime(600, 0);
      lfo.connect(lfoGain);
      lfoGain.connect(osc.frequency);
      const filter = offlineCtx.createBiquadFilter();
      filter.type = 'bandpass';
      filter.frequency.setValueAtTime(2800, 0);
      filter.Q.setValueAtTime(3, 0);
      osc.connect(filter);
      filter.connect(offlineCtx.destination);
      osc.start(0);
      lfo.start(0);
    } else if (type === 'water') {
      const bufferSize = Math.floor(sampleRate * duration);
      const noiseBuffer = offlineCtx.createBuffer(1, bufferSize, sampleRate);
      const data = noiseBuffer.getChannelData(0);
      let b0 = 0, b1 = 0, b2 = 0;
      for (let i = 0; i < bufferSize; i++) {
        const white = Math.random() * 2 - 1;
        b0 = 0.99886 * b0 + white * 0.0555179;
        b1 = 0.99332 * b1 + white * 0.0750759;
        b2 = 0.96900 * b2 + white * 0.1538520;
        data[i] = (b0 + b1 + b2) * 0.15;
      }
      const noiseSource = offlineCtx.createBufferSource();
      noiseSource.buffer = noiseBuffer;
      const filter = offlineCtx.createBiquadFilter();
      filter.type = 'lowpass';
      filter.frequency.setValueAtTime(450, 0);
      noiseSource.connect(filter);
      filter.connect(offlineCtx.destination);
      noiseSource.start(0);
    } else {
      const osc1 = offlineCtx.createOscillator();
      osc1.type = 'sawtooth';
      osc1.frequency.setValueAtTime(65, 0);
      const filter = offlineCtx.createBiquadFilter();
      filter.type = 'lowpass';
      filter.frequency.setValueAtTime(240, 0);
      osc1.connect(filter);
      filter.connect(offlineCtx.destination);
      osc1.start(0);
    }

    const renderedBuffer = await offlineCtx.startRendering();
    return this.audioBufferToWavBlob(renderedBuffer);
  }

  /**
   * Encodes standard PCM 16-bit stereo WAV binary from AudioBuffer
   */
  audioBufferToWavBlob(audioBuffer) {
    const numChannels = audioBuffer.numberOfChannels;
    const sampleRate = audioBuffer.sampleRate;
    const format = 1; // PCM
    const bitDepth = 16;
    const numSamples = audioBuffer.length * numChannels;
    const buffer = new ArrayBuffer(44 + numSamples * 2);
    const view = new DataView(buffer);

    const writeString = (offset, string) => {
      for (let i = 0; i < string.length; i++) {
        view.setUint8(offset + i, string.charCodeAt(i));
      }
    };

    /* RIFF identifier */
    writeString(0, 'RIFF');
    /* file length */
    view.setUint32(4, 36 + numSamples * 2, true);
    /* RIFF type */
    writeString(8, 'WAVE');
    /* format chunk identifier */
    writeString(12, 'fmt ');
    /* format chunk length */
    view.setUint32(16, 16, true);
    /* sample format (raw) */
    view.setUint16(20, format, true);
    /* channel count */
    view.setUint16(22, numChannels, true);
    /* sample rate */
    view.setUint32(24, sampleRate, true);
    /* byte rate (sample rate * block align) */
    view.setUint32(28, sampleRate * numChannels * (bitDepth / 8), true);
    /* block align (channel count * bytes per sample) */
    view.setUint16(32, numChannels * (bitDepth / 8), true);
    /* bits per sample */
    view.setUint16(34, bitDepth, true);
    /* data chunk identifier */
    writeString(36, 'data');
    /* data chunk length */
    view.setUint32(40, numSamples * 2, true);

    const channels = [];
    for (let i = 0; i < numChannels; i++) {
      channels.push(audioBuffer.getChannelData(i));
    }

    let offset = 44;
    for (let i = 0; i < audioBuffer.length; i++) {
      for (let ch = 0; ch < numChannels; ch++) {
        const sample = Math.max(-1, Math.min(1, channels[ch][i]));
        view.setInt16(offset, sample < 0 ? sample * 0x8000 : sample * 0x7FFF, true);
        offset += 2;
      }
    }

    return new Blob([view], { type: 'audio/wav' });
  }

  /**
   * High-Performance Real-Time Multi-Mode Canvas Visualizer
   * Supports: 'waveform' (Oscilloscope), 'fft' (Spectral Bars), 'spectrogram' (2D Waterfall Heatmap)
   */
  startVisualizerLoop() {
    const offscreenCanvas = document.createElement('canvas');
    const offscreenCtx = offscreenCanvas.getContext('2d', { willReadFrequently: true });
    let lastWidth = 0;
    let lastHeight = 0;

    // Helper colormap for Spectrogram: 0.0 -> #180c12, 0.35 -> #8b2668, 0.7 -> #e83bb2, 1.0 -> #ffffff
    const getSpectrogramColor = (val) => {
      const norm = Math.max(0, Math.min(1, val / 255));
      if (norm < 0.3) {
        const t = norm / 0.3;
        const r = Math.round(24 + (99 - 24) * t);
        const g = Math.round(12 + (25 - 12) * t);
        const b = Math.round(18 + (68 - 18) * t);
        return `rgb(${r},${g},${b})`;
      } else if (norm < 0.7) {
        const t = (norm - 0.3) / 0.4;
        const r = Math.round(99 + (232 - 99) * t);
        const g = Math.round(25 + (59 - 25) * t);
        const b = Math.round(68 + (178 - 68) * t);
        return `rgb(${r},${g},${b})`;
      } else {
        const t = (norm - 0.7) / 0.3;
        const r = Math.round(232 + (255 - 232) * t);
        const g = Math.round(59 + (255 - 59) * t);
        const b = Math.round(178 + (255 - 178) * t);
        return `rgb(${r},${g},${b})`;
      }
    };

    const render = () => {
      if (this.canvasWave && this.canvasCtx) {
        const parentWidth = this.canvasWave.parentElement.clientWidth || 300;
        const parentHeight = this.canvasWave.parentElement.clientHeight || 85;

        if (this.canvasWave.width !== parentWidth || this.canvasWave.height !== parentHeight) {
          this.canvasWave.width = parentWidth;
          this.canvasWave.height = parentHeight;
        }

        const width = this.canvasWave.width;
        const height = this.canvasWave.height;
        const ctx = this.canvasCtx;

        if (lastWidth !== width || lastHeight !== height) {
          offscreenCanvas.width = width;
          offscreenCanvas.height = height;
          offscreenCtx.fillStyle = '#180c12';
          offscreenCtx.fillRect(0, 0, width, height);
          lastWidth = width;
          lastHeight = height;
        }

        const { freqData, waveData } = this.audio.getVisualizerData();

        if (this.visMode === 'spectrogram') {
          // Shift existing spectrogram image 2px to the left
          offscreenCtx.drawImage(offscreenCanvas, 2, 0, width - 2, height, 0, 0, width - 2, height);

          // Draw latest vertical frequency slice on rightmost 2px
          const numBins = Math.min(freqData.length, 64);
          const sliceHeight = height / numBins;

          for (let i = 0; i < numBins; i++) {
            const val = freqData ? freqData[i] : 0;
            offscreenCtx.fillStyle = getSpectrogramColor(val);
            // Invert Y so low frequencies are at bottom and high at top
            const y = height - (i + 1) * sliceHeight;
            offscreenCtx.fillRect(width - 2, y, 2, sliceHeight + 1);
          }

          // Transfer offscreen canvas to main visualizer canvas
          ctx.drawImage(offscreenCanvas, 0, 0);

          // Subtle frequency axis markings
          ctx.fillStyle = 'rgba(252, 235, 247, 0.4)';
          ctx.font = '9px monospace';
          ctx.fillText('8kHz', 6, 12);
          ctx.fillText('100Hz', 6, height - 6);

        } else if (this.visMode === 'fft') {
          ctx.clearRect(0, 0, width, height);

          // Background grid
          ctx.strokeStyle = 'rgba(232, 59, 178, 0.1)';
          ctx.lineWidth = 1;
          for (let y = 15; y < height; y += 20) {
            ctx.beginPath();
            ctx.moveTo(0, y);
            ctx.lineTo(width, y);
            ctx.stroke();
          }

          if (freqData.length > 0) {
            const barCount = Math.min(freqData.length, 48);
            const barSpacing = 2;
            const barWidth = (width - barSpacing * (barCount - 1)) / barCount;

            for (let i = 0; i < barCount; i++) {
              const val = freqData[i];
              const barHeight = (val / 255) * (height - 8);
              const x = i * (barWidth + barSpacing);
              const y = height - barHeight;

              // Vertical pink gradient
              const grad = ctx.createLinearGradient(0, height, 0, y);
              grad.addColorStop(0, 'rgba(139, 38, 104, 0.8)');
              grad.addColorStop(0.7, '#e83bb2');
              grad.addColorStop(1, '#ffffff');

              ctx.fillStyle = grad;
              ctx.fillRect(x, y, barWidth, barHeight);

              // Top highlight cap
              ctx.fillStyle = '#ffffff';
              ctx.fillRect(x, Math.max(0, y - 2), barWidth, 2);
            }
          }
        } else {
          // Default: 'waveform' Oscilloscope
          ctx.clearRect(0, 0, width, height);

          // Background ambient glow FFT in subtle opacity
          if (freqData.length > 0) {
            const barWidth = (width / freqData.length) * 2.5;
            let barX = 0;
            for (let i = 0; i < freqData.length; i++) {
              const barHeight = (freqData[i] / 255) * height;
              ctx.fillStyle = `rgba(232, 59, 178, ${0.08 + (freqData[i] / 255) * 0.25})`;
              ctx.fillRect(barX, height - barHeight, barWidth, barHeight);
              barX += barWidth + 1;
            }
          }

          // Oscilloscope Time-Domain Waveform with Pink Glow
          if (waveData.length > 0) {
            ctx.lineWidth = 2.5;
            ctx.strokeStyle = '#e83bb2';
            ctx.shadowColor = 'rgba(232, 59, 178, 0.8)';
            ctx.shadowBlur = 8;
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

            ctx.shadowBlur = 0;
          }
        }
      }

      this.animationFrameId = requestAnimationFrame(render);
    };

    render();
  }
}
