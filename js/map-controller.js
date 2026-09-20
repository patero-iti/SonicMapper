/**
 * MapController - MapLibre GL JS Cartographic Controller
 * Renders acoustic radius rings, categorized draggable pins, draggable mock listener node, 
 * interactive pin placement, dynamic pin relocation, and Map Theme switching.
 */
import { GeoEngine } from './geo-engine.js';

export class MapController {
  constructor({ containerId, initialCenter = [115.8605, -31.9505], initialZoom = 15.5 }) {
    this.containerId = containerId;
    this.initialCenter = initialCenter;
    this.initialZoom = initialZoom;
    this.map = null;
    this.listenerMarker = null;
    this.soundMarkers = new Map(); // id -> Marker
    this.features = []; // Array of active Feature objects
    this.onListenerMove = null;
    this.onSoundSelect = null;
    this.onPinDrop = null;
    this.onSoundMove = null; // Fired during pin drag
    this.onSoundMoved = null; // Fired when pin drag ends / relocated
    this.mode = 'mock-gps'; // 'mock-gps', 'location', 'static'
    this.isAddingPin = false;
    this.relocatingFeatureId = null;
    this.currentTheme = 'positron'; // 'positron' (default), 'dadaa_noir', 'dark', 'liberty', 'bright'
    this.currentHeading = 0;

    // Polygon Geofence Drawing State
    this.isDrawingPolygon = false;
    this.polygonDrawVertices = [];
    this.polygonDrawMarkers = [];
    this.polygonDrawHoverCoord = null;
    this.onPolygonDrawVertexAdded = null;
    this.onPolygonDrawComplete = null;
    this.onPolygonDrawCancel = null;

    // Polygon Geofence Reshaping / Vertex Edit State
    this.isEditingPolygon = false;
    this.editingPolygonFeature = null;
    this.editingPolygonBackupCoords = null;
    this.polygonEditVertexMarkers = [];
    this.polygonEditMidpointMarkers = [];
    this.onPolygonEditSave = null;
    this.onPolygonEditCancel = null;

    // Soundwalk Trajectory Drawing State
    this.isDrawingSoundwalk = false;
    this.soundwalkDrawCoords = [];
    this.soundwalkDrawMarkers = [];
    this.soundwalkDrawHoverCoord = null;
    this.onSoundwalkDrawVertexAdded = null;
    this.onSoundwalkDrawComplete = null;
    this.onSoundwalkDrawCancel = null;

    // Soundwalk Trajectory Reshaping / Waypoint Edit State
    this.isEditingSoundwalk = false;
    this.editingSoundwalkFeature = null;
    this.editingSoundwalkBackupCoords = null;
    this.soundwalkEditWaypointMarkers = [];
    this.soundwalkEditMidpointMarkers = [];
    this.onSoundwalkEditSave = null;
    this.onSoundwalkEditCancel = null;
  }

  /**
   * Recursively sanitizes vector style filter expressions to prevent MapLibre v4 worker null type warnings
   */
  sanitizeStyleExpressions(obj) {
    if (Array.isArray(obj)) {
      if (obj.length >= 3 && ['<', '<=', '>', '>='].includes(obj[0])) {
        const op = obj[0];
        const newObj = [...obj];
        if (Array.isArray(newObj[1]) && newObj[1][0] === 'get') {
          const fallback = (op === '<' || op === '<=') ? 999999 : -999999;
          newObj[1] = ['to-number', newObj[1], fallback];
        }
        if (Array.isArray(newObj[2]) && newObj[2][0] === 'get') {
          const fallback = (op === '<' || op === '<=') ? -999999 : 999999;
          newObj[2] = ['to-number', newObj[2], fallback];
        }
        return newObj.map(item => this.sanitizeStyleExpressions(item));
      }
      return obj.map(item => this.sanitizeStyleExpressions(item));
    } else if (obj !== null && typeof obj === 'object') {
      const copy = {};
      for (const key of Object.keys(obj)) {
        copy[key] = this.sanitizeStyleExpressions(obj[key]);
      }
      return copy;
    }
    return obj;
  }

  /**
   * Minimal fallback style for completely offline or disconnected environments
   */
  getOfflineFallbackStyle() {
    return {
      version: 8,
      name: 'SonicMapper Offline Grid',
      sources: {},
      layers: [
        {
          id: 'background',
          type: 'background',
          paint: {
            'background-color': '#12141a'
          }
        }
      ]
    };
  }

  /**
   * Fetches OpenFreeMap vector style JSON and applies strict type sanitization
   */
  async fetchSanitizedStyle(url) {
    try {
      const res = await fetch(url);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const rawStyle = await res.json();
      return this.sanitizeStyleExpressions(rawStyle);
    } catch (e) {
      console.warn('Could not fetch online vector style JSON, using offline canvas fallback:', e.message);
      return this.getOfflineFallbackStyle();
    }
  }

  /**
   * Initializes the MapLibre GL instance with high-performance OpenFreeMap vector tiles.
   */
  async init() {
    if (typeof maplibregl === 'undefined') {
      console.warn('MapLibre GL library not immediately found, checking script availability...');
      for (let i = 0; i < 10; i++) {
        await new Promise(r => setTimeout(r, 100));
        if (typeof maplibregl !== 'undefined') break;
      }
      if (typeof maplibregl === 'undefined') {
        throw new Error('MapLibre GL library is not defined. Ensure js/maplibre-gl.js is loaded.');
      }
    }

    const defaultStyleUrl = 'https://tiles.openfreemap.org/styles/positron';
    const initialStyle = await this.fetchSanitizedStyle(defaultStyleUrl);

    this.map = new maplibregl.Map({
      container: this.containerId,
      style: initialStyle, // Sanitized style or offline fallback
      center: this.initialCenter,
      zoom: this.initialZoom,
      pitch: 35, // Dynamic angle for spatial immersion
      bearing: 0
    });

    this.map.addControl(new maplibregl.NavigationControl({ visualizePitch: true }), 'top-right');
    this.map.addControl(new maplibregl.ScaleControl({ unit: 'metric' }), 'bottom-right');

    // Handle missing sprite patterns gracefully (e.g. wood-pattern)
    this.map.on('styleimagemissing', (e) => {
      const id = e.id;
      if (!this.map.hasImage(id)) {
        const width = 1;
        const height = 1;
        const data = new Uint8Array([0, 0, 0, 0]);
        this.map.addImage(id, { width, height, data });
      }
    });

    return new Promise((resolve) => {
      this.map.on('load', () => {
        if (this.currentTheme === 'dadaa_noir') {
          this.applyRadioDadaaTheme();
        }
        this.setupListenerMarker();
        this.setupMapClick();
        this.setupMapMove();
        resolve();
      });
    });
  }

  /**
   * Applies the custom Radio DADAA Dark / Noir colorway across vector map layers
   */
  applyRadioDadaaTheme() {
    if (!this.map || !this.map.isStyleLoaded()) return;
    const style = this.map.getStyle();
    if (!style || !style.layers) return;

    style.layers.forEach((layer) => {
      const id = layer.id.toLowerCase();
      const type = layer.type;

      try {
        if (type === 'background') {
          this.map.setPaintProperty(layer.id, 'background-color', '#180c12');
        } else if (type === 'fill') {
          if (id.includes('water')) {
            this.map.setPaintProperty(layer.id, 'fill-color', '#10050c');
          } else if (id.includes('building')) {
            this.map.setPaintProperty(layer.id, 'fill-color', '#29121f');
          } else if (id.includes('park') || id.includes('wood') || id.includes('green') || id.includes('landcover') || id.includes('landuse')) {
            this.map.setPaintProperty(layer.id, 'fill-color', '#1e0e18');
          }
        } else if (type === 'line') {
          if (id.includes('water')) {
            this.map.setPaintProperty(layer.id, 'line-color', '#240a1c');
          } else if (id.includes('motorway') || id.includes('trunk') || id.includes('primary')) {
            this.map.setPaintProperty(layer.id, 'line-color', '#5e1d45');
          } else if (id.includes('road') || id.includes('transport') || id.includes('street') || id.includes('highway') || id.includes('path') || id.includes('track')) {
            this.map.setPaintProperty(layer.id, 'line-color', '#2c1223');
          } else if (id.includes('boundary') || id.includes('admin')) {
            this.map.setPaintProperty(layer.id, 'line-color', '#592344');
          }
        } else if (type === 'symbol') {
          this.map.setPaintProperty(layer.id, 'text-color', '#fcebf7');
          this.map.setPaintProperty(layer.id, 'text-halo-color', '#231218');
        }
      } catch (e) {
        // Silently skip non-applicable properties
      }
    });
  }

  /**
   * Switches map visual style theme on the fly
   */
  async setMapTheme(themeName) {
    this.currentTheme = themeName;
    const styleUrls = {
      dadaa_noir: 'https://tiles.openfreemap.org/styles/dark',
      dark: 'https://tiles.openfreemap.org/styles/dark',
      positron: 'https://tiles.openfreemap.org/styles/positron',
      liberty: 'https://tiles.openfreemap.org/styles/liberty',
      bright: 'https://tiles.openfreemap.org/styles/bright'
    };

    const targetUrl = styleUrls[themeName] || styleUrls.positron;
    const sanitizedStyle = await this.fetchSanitizedStyle(targetUrl);

    this.map.once('style.load', () => {
      if (themeName === 'dadaa_noir') {
        this.applyRadioDadaaTheme();
      }
      this.updateAcousticZonePolygons();
    });

    this.map.setStyle(sanitizedStyle);
  }

  /**
   * Set up draggable Listener Node (with pulsing radar ring & heading direction cone)
   */
  setupListenerMarker() {
    const el = document.createElement('div');
    el.className = 'listener-marker-container';
    el.innerHTML = `
      <div class="listener-heading-cone"></div>
      <div class="listener-pulse"></div>
      <div class="listener-pin">
        <div class="listener-arrow"></div>
        <div class="listener-dot"></div>
      </div>
      <div class="listener-label">LISTENER</div>
    `;

    this.listenerMarker = new maplibregl.Marker({
      element: el,
      draggable: true
    })
      .setLngLat(this.initialCenter)
      .addTo(this.map);

    this.listenerMarker.on('drag', () => {
      const lngLat = this.listenerMarker.getLngLat();
      if (this.onListenerMove) {
        this.onListenerMove([lngLat.lng, lngLat.lat]);
      }
    });

    this.listenerMarker.on('dragend', () => {
      const lngLat = this.listenerMarker.getLngLat();
      if (this.onListenerMove) {
        this.onListenerMove([lngLat.lng, lngLat.lat]);
      }
    });
  }

  /**
   * Updates listener visual orientation / compass heading cone on map
   */
  setListenerHeading(headingDegrees) {
    if (headingDegrees === null || isNaN(headingDegrees)) return;
    this.currentHeading = headingDegrees;
    const el = this.listenerMarker?.getElement();
    if (!el) return;

    const cone = el.querySelector('.listener-heading-cone');
    const pin = el.querySelector('.listener-pin');
    if (cone) {
      cone.style.transform = `translate(-50%, -50%) rotate(${headingDegrees}deg)`;
    }
    if (pin) {
      pin.style.transform = `translate(-50%, -50%) rotate(${headingDegrees}deg)`;
    }
  }

  /**
   * Map click handler for listener relocation, pin adding, pin relocation, and polygon drawing
   */
  setupMapClick() {
    this.map.on('click', (e) => {
      const coords = [e.lngLat.lng, e.lngLat.lat];

      // 1. Polygon Drawing Mode
      if (this.isDrawingPolygon) {
        this.addPolygonDrawVertex(coords);
        return;
      }

      // 2. Soundwalk Drawing Mode
      if (this.isDrawingSoundwalk) {
        this.addSoundwalkDrawVertex(coords);
        return;
      }

      // 3. Polygon & Soundwalk Editing Modes
      if (this.isEditingPolygon || this.isEditingSoundwalk) {
        return;
      }

      // 4. Adding New Pin Mode
      if (this.isAddingPin) {
        this.setAddingPinMode(false);
        if (this.onPinDrop) {
          this.onPinDrop(coords);
        }
        return;
      }

      // 5. Relocating Existing Pin Mode
      if (this.relocatingFeatureId) {
        const feat = this.features.find(f => f.id === this.relocatingFeatureId);
        const featureId = this.relocatingFeatureId;
        this.setRelocatingPinMode(null);
        if (feat) {
          feat.geometry.coordinates = coords;
          const marker = this.soundMarkers.get(featureId);
          if (marker) marker.setLngLat(coords);
          this.updateAcousticZonePolygons();
          if (this.onSoundMoved) {
            this.onSoundMoved(feat, coords);
          }
        }
        return;
      }

      // 6. Move listener in Mock GPS mode
      if (this.mode === 'mock-gps') {
        this.setListenerCoordinates(coords);
        if (this.onListenerMove) {
          this.onListenerMove(coords);
        }
      }
    });

    // Double-click to finish polygon drawing (>= 3 points) or soundwalk drawing (>= 2 points)
    this.map.on('dblclick', (e) => {
      if (this.isDrawingPolygon && this.polygonDrawVertices.length >= 3) {
        e.preventDefault();
        this.finishDrawingPolygon();
      } else if (this.isDrawingSoundwalk && this.soundwalkDrawCoords.length >= 2) {
        e.preventDefault();
        this.finishDrawingSoundwalk();
      }
    });
  }

  /**
   * Pointer movement tracking for rubber-band polygon & soundwalk preview
   */
  setupMapMove() {
    this.map.on('mousemove', (e) => {
      if (this.isDrawingPolygon) {
        this.polygonDrawHoverCoord = [e.lngLat.lng, e.lngLat.lat];
        this.updatePolygonDrawPreview();
      } else if (this.isDrawingSoundwalk) {
        this.soundwalkDrawHoverCoord = [e.lngLat.lng, e.lngLat.lat];
        this.updateSoundwalkDrawPreview();
      }
    });
  }

  /**
   * Starts interactive polygon drawing mode on the map
   */
  startDrawingPolygon({ onVertexAdded, onComplete, onCancel } = {}) {
    this.stopDrawingPolygon();
    this.cancelEditingPolygon();
    this.setAddingPinMode(false);
    this.setRelocatingPinMode(null);

    this.isDrawingPolygon = true;
    this.polygonDrawVertices = [];
    this.polygonDrawMarkers = [];
    this.polygonDrawHoverCoord = null;
    this.onPolygonDrawVertexAdded = onVertexAdded || null;
    this.onPolygonDrawComplete = onComplete || null;
    this.onPolygonDrawCancel = onCancel || null;

    const canvas = this.map.getCanvas();
    canvas.style.cursor = 'crosshair';
    document.body.classList.add('polygon-draw-mode');

    const banner = document.getElementById('polygon-draw-banner');
    const pointCountEl = document.getElementById('draw-point-count');
    const finishBtn = document.getElementById('btn-finish-polygon');
    if (banner) banner.style.display = 'flex';
    if (pointCountEl) pointCountEl.innerText = '0';
    if (finishBtn) finishBtn.disabled = true;

    this.ensurePolygonDrawLayers();
    this.updatePolygonDrawPreview();
  }

  /**
   * Adds a vertex to the actively drawn polygon
   */
  addPolygonDrawVertex(coords) {
    if (!this.isDrawingPolygon) return;
    this.polygonDrawVertices.push(coords);
    const vIndex = this.polygonDrawVertices.length;

    // Create marker dot for placed vertex
    const el = document.createElement('div');
    el.className = 'polygon-draw-node-marker';
    el.innerText = vIndex;
    el.title = `Vertex ${vIndex} (Click first point or double-click to close)`;

    // Clicking the first vertex when >= 3 points closes the polygon
    if (vIndex === 1) {
      el.addEventListener('click', (e) => {
        e.stopPropagation();
        if (this.polygonDrawVertices.length >= 3) {
          this.finishDrawingPolygon();
        }
      });
    }

    const marker = new maplibregl.Marker({ element: el })
      .setLngLat(coords)
      .addTo(this.map);
    this.polygonDrawMarkers.push(marker);

    const pointCountEl = document.getElementById('draw-point-count');
    const finishBtn = document.getElementById('btn-finish-polygon');
    if (pointCountEl) pointCountEl.innerText = this.polygonDrawVertices.length;
    if (finishBtn) finishBtn.disabled = this.polygonDrawVertices.length < 3;

    if (this.onPolygonDrawVertexAdded) {
      this.onPolygonDrawVertexAdded(this.polygonDrawVertices.length, this.polygonDrawVertices);
    }

    this.updatePolygonDrawPreview();
  }

  /**
   * Undo last vertex in polygon drawing
   */
  undoPolygonDrawVertex() {
    if (!this.isDrawingPolygon || this.polygonDrawVertices.length === 0) return;
    this.polygonDrawVertices.pop();
    const lastMarker = this.polygonDrawMarkers.pop();
    if (lastMarker) lastMarker.remove();

    const pointCountEl = document.getElementById('draw-point-count');
    const finishBtn = document.getElementById('btn-finish-polygon');
    if (pointCountEl) pointCountEl.innerText = this.polygonDrawVertices.length;
    if (finishBtn) finishBtn.disabled = this.polygonDrawVertices.length < 3;

    if (this.onPolygonDrawVertexAdded) {
      this.onPolygonDrawVertexAdded(this.polygonDrawVertices.length, this.polygonDrawVertices);
    }

    this.updatePolygonDrawPreview();
  }

  /**
   * Completes polygon drawing and returns closed ring coordinate array
   */
  finishDrawingPolygon() {
    if (!this.isDrawingPolygon || this.polygonDrawVertices.length < 3) return;

    // Close the polygon ring (first vertex == last vertex)
    const ring = [...this.polygonDrawVertices, this.polygonDrawVertices[0]];
    const completedCoords = [ring];
    const callback = this.onPolygonDrawComplete;

    this.stopDrawingPolygon();

    if (callback) {
      callback(completedCoords);
    }
  }

  /**
   * Cancels polygon drawing mode
   */
  cancelDrawingPolygon() {
    const callback = this.onPolygonDrawCancel;
    this.stopDrawingPolygon();
    if (callback) callback();
  }

  /**
   * Cleanup drawing state, markers, and preview layers
   */
  stopDrawingPolygon() {
    this.isDrawingPolygon = false;
    this.polygonDrawHoverCoord = null;

    this.polygonDrawMarkers.forEach(m => m.remove());
    this.polygonDrawMarkers = [];
    this.polygonDrawVertices = [];

    const canvas = this.map.getCanvas();
    canvas.style.cursor = '';
    document.body.classList.remove('polygon-draw-mode');

    const banner = document.getElementById('polygon-draw-banner');
    if (banner) banner.style.display = 'none';

    if (this.map.getSource('polygon-draw-source')) {
      this.map.getSource('polygon-draw-source').setData({
        type: 'FeatureCollection',
        features: []
      });
    }
  }

  /**
   * Ensures preview layers exist for polygon drawing
   */
  ensurePolygonDrawLayers() {
    if (!this.map.getSource('polygon-draw-source')) {
      this.map.addSource('polygon-draw-source', {
        type: 'geojson',
        data: { type: 'FeatureCollection', features: [] }
      });

      this.map.addLayer({
        id: 'polygon-draw-fill',
        type: 'fill',
        source: 'polygon-draw-source',
        filter: ['==', '$type', 'Polygon'],
        paint: {
          'fill-color': '#e83bb2',
          'fill-opacity': 0.35
        }
      });

      this.map.addLayer({
        id: 'polygon-draw-line',
        type: 'line',
        source: 'polygon-draw-source',
        paint: {
          'line-color': '#e83bb2',
          'line-width': 3,
          'line-dasharray': [2, 2],
          'line-opacity': 0.95
        }
      });

      this.map.addLayer({
        id: 'polygon-draw-guideline',
        type: 'line',
        source: 'polygon-draw-source',
        paint: {
          'line-color': '#ffffff',
          'line-width': 2,
          'line-dasharray': [1, 2],
          'line-opacity': 0.8
        }
      });
    }
  }

  /**
   * Updates real-time preview GeoJSON while drawing polygon
   */
  updatePolygonDrawPreview() {
    if (!this.map || !this.map.getSource('polygon-draw-source')) return;

    const features = [];
    const pts = this.polygonDrawVertices;

    if (pts.length >= 3) {
      // Preview filled polygon
      features.push({
        type: 'Feature',
        geometry: {
          type: 'Polygon',
          coordinates: [[...pts, pts[0]]]
        }
      });
    }

    if (pts.length >= 2) {
      // Drawn perimeter lines
      features.push({
        type: 'Feature',
        geometry: {
          type: 'LineString',
          coordinates: pts
        }
      });
    }

    if (pts.length >= 1 && this.polygonDrawHoverCoord) {
      // Rubber-band line to pointer
      features.push({
        type: 'Feature',
        geometry: {
          type: 'LineString',
          coordinates: [pts[pts.length - 1], this.polygonDrawHoverCoord]
        }
      });
    }

    this.map.getSource('polygon-draw-source').setData({
      type: 'FeatureCollection',
      features
    });
  }

  /**
   * Starts interactive vertex reshaping mode for an existing Polygon Zone
   */
  startEditingPolygon(feature, { onSave, onCancel } = {}) {
    this.stopDrawingPolygon();
    this.cancelEditingPolygon();
    this.setAddingPinMode(false);
    this.setRelocatingPinMode(null);

    this.isEditingPolygon = true;
    this.editingPolygonFeature = feature;
    this.editingPolygonBackupCoords = JSON.parse(JSON.stringify(feature.geometry.coordinates));
    this.onPolygonEditSave = onSave || null;
    this.onPolygonEditCancel = onCancel || null;

    // Hide static centroid marker while editing handles are active
    const marker = this.soundMarkers.get(feature.id);
    if (marker) {
      marker.getElement().style.display = 'none';
    }

    // Extract outer ring vertices (without duplicate closing vertex)
    let ring = feature.geometry.coordinates;
    while (Array.isArray(ring[0]) && Array.isArray(ring[0][0])) {
      ring = ring[0];
    }
    const vertices = (ring.length > 3 && ring[0][0] === ring[ring.length - 1][0] && ring[0][1] === ring[ring.length - 1][1])
      ? ring.slice(0, -1).map(pt => [pt[0], pt[1]])
      : ring.map(pt => [pt[0], pt[1]]);

    const banner = document.getElementById('polygon-edit-banner');
    const titleEl = document.getElementById('edit-polygon-title');
    if (banner) banner.style.display = 'flex';
    if (titleEl) titleEl.innerText = feature.properties?.title || 'Zone';
    document.body.classList.add('polygon-edit-mode');

    this.refreshPolygonEditHandles(vertices);
    this.focusOnPin(feature);
  }

  /**
   * Refreshes draggable vertex handle markers and midpoint insert handles (+)
   */
  refreshPolygonEditHandles(vertices) {
    // Clear existing edit markers
    this.polygonEditVertexMarkers.forEach(m => m.remove());
    this.polygonEditVertexMarkers = [];
    this.polygonEditMidpointMarkers.forEach(item => item.marker.remove());
    this.polygonEditMidpointMarkers = [];

    if (!this.isEditingPolygon || !this.editingPolygonFeature) return;

    // 1. Create Draggable Vertex Handle Markers
    vertices.forEach((coord, idx) => {
      const el = document.createElement('div');
      el.className = 'polygon-edit-vertex-handle';
      el.innerHTML = `<span>${idx + 1}</span><div class="vertex-handle-tooltip">Vertex ${idx + 1} • Drag to move (Right-click to delete)</div>`;

      // Right-click or long press to delete vertex (if > 3 vertices)
      el.addEventListener('contextmenu', (e) => {
        e.preventDefault();
        e.stopPropagation();
        if (vertices.length > 3) {
          vertices.splice(idx, 1);
          this.editingPolygonFeature.geometry.coordinates = [[...vertices, vertices[0]]];
          this.updateAcousticZonePolygons();
          this.refreshPolygonEditHandles(vertices);
        } else {
          alert('A polygon zone must have at least 3 vertices.');
        }
      });

      const marker = new maplibregl.Marker({
        element: el,
        draggable: true
      })
        .setLngLat(coord)
        .addTo(this.map);

      marker.on('drag', () => {
        const lngLat = marker.getLngLat();
        vertices[idx] = [lngLat.lng, lngLat.lat];
        this.editingPolygonFeature.geometry.coordinates = [[...vertices, vertices[0]]];
        this.updateAcousticZonePolygons();
        this.updateMidpointPositions(vertices);
      });

      marker.on('dragend', () => {
        const lngLat = marker.getLngLat();
        vertices[idx] = [lngLat.lng, lngLat.lat];
        this.editingPolygonFeature.geometry.coordinates = [[...vertices, vertices[0]]];
        this.updateAcousticZonePolygons();
        this.refreshPolygonEditHandles(vertices);
      });

      this.polygonEditVertexMarkers.push(marker);
    });

    // 2. Create Midpoint Insert Handles (+)
    for (let i = 0; i < vertices.length; i++) {
      const nextIdx = (i + 1) % vertices.length;
      const p1 = vertices[i];
      const p2 = vertices[nextIdx];
      const midCoord = [(p1[0] + p2[0]) / 2, (p1[1] + p2[1]) / 2];

      const midEl = document.createElement('div');
      midEl.className = 'polygon-edit-midpoint-handle';
      midEl.innerHTML = `+`;
      midEl.title = 'Click to insert vertex here';

      midEl.addEventListener('click', (e) => {
        e.stopPropagation();
        vertices.splice(i + 1, 0, midCoord);
        this.editingPolygonFeature.geometry.coordinates = [[...vertices, vertices[0]]];
        this.updateAcousticZonePolygons();
        this.refreshPolygonEditHandles(vertices);
      });

      const midMarker = new maplibregl.Marker({
        element: midEl,
        draggable: false
      })
        .setLngLat(midCoord)
        .addTo(this.map);

      this.polygonEditMidpointMarkers.push({ marker: midMarker, index: i });
    }
  }

  /**
   * Updates midpoint handles while dragging a vertex
   */
  updateMidpointPositions(vertices) {
    this.polygonEditMidpointMarkers.forEach(({ marker, index }) => {
      const nextIdx = (index + 1) % vertices.length;
      const p1 = vertices[index];
      const p2 = vertices[nextIdx];
      const midCoord = [(p1[0] + p2[0]) / 2, (p1[1] + p2[1]) / 2];
      marker.setLngLat(midCoord);
    });
  }

  /**
   * Save polygon boundary reshapes
   */
  saveEditingPolygon() {
    if (!this.isEditingPolygon || !this.editingPolygonFeature) return;
    const feat = this.editingPolygonFeature;
    const callback = this.onPolygonEditSave;

    this.stopEditingPolygon();

    if (callback) {
      callback(feat);
    }
  }

  /**
   * Cancel polygon boundary reshapes and restore original geometry
   */
  cancelEditingPolygon() {
    if (!this.isEditingPolygon || !this.editingPolygonFeature) return;
    if (this.editingPolygonBackupCoords) {
      this.editingPolygonFeature.geometry.coordinates = this.editingPolygonBackupCoords;
      this.updateAcousticZonePolygons();
    }
    const callback = this.onPolygonEditCancel;
    this.stopEditingPolygon();
    if (callback) callback();
  }

  /**
   * Stop editing mode and cleanup markers
   */
  stopEditingPolygon() {
    this.isEditingPolygon = false;
    const feat = this.editingPolygonFeature;
    this.editingPolygonFeature = null;
    this.editingPolygonBackupCoords = null;

    this.polygonEditVertexMarkers.forEach(m => m.remove());
    this.polygonEditVertexMarkers = [];
    this.polygonEditMidpointMarkers.forEach(item => item.marker.remove());
    this.polygonEditMidpointMarkers = [];

    const banner = document.getElementById('polygon-edit-banner');
    if (banner) banner.style.display = 'none';
    document.body.classList.remove('polygon-edit-mode');

    // Restore centroid marker
    if (feat) {
      this.createPinMarker(feat);
    }
  }

  /* ==========================================================================
     Soundwalk Path Trajectory Drawing Engine
     ========================================================================== */

  /**
   * Starts interactive on-map drawing mode for a new Soundwalk Path
   */
  startDrawingSoundwalk({ onVertexAdded, onComplete, onCancel } = {}) {
    this.stopDrawingSoundwalk();
    this.stopDrawingPolygon();
    this.cancelEditingPolygon();
    this.cancelEditingSoundwalk();
    this.setAddingPinMode(false);
    this.setRelocatingPinMode(null);

    this.isDrawingSoundwalk = true;
    this.soundwalkDrawCoords = [];
    this.soundwalkDrawMarkers = [];
    this.soundwalkDrawHoverCoord = null;
    this.onSoundwalkDrawVertexAdded = onVertexAdded || null;
    this.onSoundwalkDrawComplete = onComplete || null;
    this.onSoundwalkDrawCancel = onCancel || null;

    const banner = document.getElementById('soundwalk-draw-banner');
    const finishBtn = document.getElementById('btn-finish-soundwalk-draw');
    const countEl = document.getElementById('draw-soundwalk-point-count');
    const distEl = document.getElementById('draw-soundwalk-distance');
    if (banner) banner.style.display = 'flex';
    if (finishBtn) finishBtn.disabled = true;
    if (countEl) countEl.innerText = '0';
    if (distEl) distEl.innerText = '0.0 m';

    document.body.classList.add('soundwalk-draw-mode');
    this.map.getCanvas().style.cursor = 'crosshair';

    this.ensureSoundwalkDrawSource();
    this.updateSoundwalkDrawPreview();
  }

  ensureSoundwalkDrawSource() {
    if (!this.map.getSource('soundwalk-draw-source')) {
      this.map.addSource('soundwalk-draw-source', {
        type: 'geojson',
        data: { type: 'FeatureCollection', features: [] }
      });

      this.map.addLayer({
        id: 'soundwalk-draw-glow',
        type: 'line',
        source: 'soundwalk-draw-source',
        paint: {
          'line-color': '#06b6d4',
          'line-width': 8,
          'line-opacity': 0.45,
          'line-blur': 3
        }
      });

      this.map.addLayer({
        id: 'soundwalk-draw-line',
        type: 'line',
        source: 'soundwalk-draw-source',
        paint: {
          'line-color': '#ffffff',
          'line-width': 3,
          'line-dasharray': [1, 2],
          'line-opacity': 0.95
        }
      });
    }
  }

  addSoundwalkDrawVertex(coord) {
    if (!this.isDrawingSoundwalk || !coord) return;
    this.soundwalkDrawCoords.push(coord);

    const idx = this.soundwalkDrawCoords.length;
    const el = document.createElement('div');
    el.className = 'soundwalk-draw-node-marker';
    el.innerText = idx === 1 ? '⚑' : `${idx}`;
    el.title = idx === 1 ? 'Trailhead' : `Waypoint ${idx}`;

    const marker = new maplibregl.Marker({ element: el })
      .setLngLat(coord)
      .addTo(this.map);
    this.soundwalkDrawMarkers.push(marker);

    const finishBtn = document.getElementById('btn-finish-soundwalk-draw');
    const countEl = document.getElementById('draw-soundwalk-point-count');
    const distEl = document.getElementById('draw-soundwalk-distance');
    if (countEl) countEl.innerText = `${idx}`;
    if (finishBtn) finishBtn.disabled = idx < 2;

    const totalDist = GeoEngine.calculateLineLength(this.soundwalkDrawCoords);
    if (distEl) {
      distEl.innerText = totalDist > 1000 ? `${(totalDist / 1000).toFixed(2)} km` : `${Math.round(totalDist)} m`;
    }

    this.updateSoundwalkDrawPreview();
    if (this.onSoundwalkDrawVertexAdded) {
      this.onSoundwalkDrawVertexAdded(coord, idx, this.soundwalkDrawCoords);
    }
  }

  undoSoundwalkDrawVertex() {
    if (!this.isDrawingSoundwalk || this.soundwalkDrawCoords.length === 0) return;
    this.soundwalkDrawCoords.pop();
    const marker = this.soundwalkDrawMarkers.pop();
    if (marker) marker.remove();

    const idx = this.soundwalkDrawCoords.length;
    const finishBtn = document.getElementById('btn-finish-soundwalk-draw');
    const countEl = document.getElementById('draw-soundwalk-point-count');
    const distEl = document.getElementById('draw-soundwalk-distance');
    if (countEl) countEl.innerText = `${idx}`;
    if (finishBtn) finishBtn.disabled = idx < 2;

    const totalDist = GeoEngine.calculateLineLength(this.soundwalkDrawCoords);
    if (distEl) {
      distEl.innerText = totalDist > 1000 ? `${(totalDist / 1000).toFixed(2)} km` : `${Math.round(totalDist)} m`;
    }

    this.updateSoundwalkDrawPreview();
  }

  finishDrawingSoundwalk() {
    if (!this.isDrawingSoundwalk || this.soundwalkDrawCoords.length < 2) {
      alert('A soundwalk trail must have at least 2 waypoints.');
      return;
    }

    const coords = [...this.soundwalkDrawCoords];
    const callback = this.onSoundwalkDrawComplete;
    this.stopDrawingSoundwalk();

    if (callback) {
      callback(coords);
    }
  }

  cancelDrawingSoundwalk() {
    const callback = this.onSoundwalkDrawCancel;
    this.stopDrawingSoundwalk();
    if (callback) callback();
  }

  stopDrawingSoundwalk() {
    this.isDrawingSoundwalk = false;
    this.soundwalkDrawCoords = [];
    this.soundwalkDrawHoverCoord = null;

    this.soundwalkDrawMarkers.forEach(m => m.remove());
    this.soundwalkDrawMarkers = [];

    const banner = document.getElementById('soundwalk-draw-banner');
    if (banner) banner.style.display = 'none';

    document.body.classList.remove('soundwalk-draw-mode');
    this.map.getCanvas().style.cursor = '';

    if (this.map.getSource('soundwalk-draw-source')) {
      this.map.getSource('soundwalk-draw-source').setData({
        type: 'FeatureCollection',
        features: []
      });
    }
  }

  updateSoundwalkDrawPreview() {
    if (!this.map || !this.map.getSource('soundwalk-draw-source')) return;

    const features = [];
    const pts = this.soundwalkDrawCoords;

    if (pts.length >= 2) {
      features.push({
        type: 'Feature',
        geometry: {
          type: 'LineString',
          coordinates: pts
        }
      });
    }

    if (pts.length >= 1 && this.soundwalkDrawHoverCoord) {
      features.push({
        type: 'Feature',
        geometry: {
          type: 'LineString',
          coordinates: [pts[pts.length - 1], this.soundwalkDrawHoverCoord]
        }
      });
    }

    this.map.getSource('soundwalk-draw-source').setData({
      type: 'FeatureCollection',
      features
    });
  }

  /* ==========================================================================
     Soundwalk Path Trajectory Reshaping & Waypoint Editing Engine
     ========================================================================== */

  /**
   * Starts interactive waypoint reshaping mode for an existing Soundwalk Path
   */
  startEditingSoundwalk(feature, { onSave, onCancel } = {}) {
    this.stopDrawingSoundwalk();
    this.stopDrawingPolygon();
    this.cancelEditingPolygon();
    this.cancelEditingSoundwalk();
    this.setAddingPinMode(false);
    this.setRelocatingPinMode(null);

    this.isEditingSoundwalk = true;
    this.editingSoundwalkFeature = feature;
    this.editingSoundwalkBackupCoords = JSON.parse(JSON.stringify(feature.geometry.coordinates));
    this.onSoundwalkEditSave = onSave || null;
    this.onSoundwalkEditCancel = onCancel || null;

    // Hide static trailhead pin & waypoints while editing handles are active
    const marker = this.soundMarkers.get(feature.id);
    if (marker) marker.getElement().style.display = 'none';
    const wpMarkers = this.waypointMarkers?.get(feature.id);
    if (wpMarkers) wpMarkers.forEach(m => m.getElement().style.display = 'none');

    const vertices = GeoEngine.extractLineVertices(feature.geometry.coordinates);

    const banner = document.getElementById('soundwalk-edit-banner');
    const titleEl = document.getElementById('edit-soundwalk-title');
    if (banner) banner.style.display = 'flex';
    if (titleEl) titleEl.innerText = feature.properties?.title || 'Trail';
    document.body.classList.add('soundwalk-edit-mode');

    this.refreshSoundwalkEditHandles(vertices);
    this.focusOnPin(feature);
  }

  refreshSoundwalkEditHandles(vertices) {
    this.soundwalkEditWaypointMarkers.forEach(m => m.remove());
    this.soundwalkEditWaypointMarkers = [];
    this.soundwalkEditMidpointMarkers.forEach(item => item.marker.remove());
    this.soundwalkEditMidpointMarkers = [];

    if (!this.isEditingSoundwalk || !this.editingSoundwalkFeature) return;

    // 1. Create Draggable Waypoint Markers
    vertices.forEach((coord, idx) => {
      const el = document.createElement('div');
      el.className = 'soundwalk-edit-waypoint-handle';
      const label = idx === 0 ? '⚑' : `${idx + 1}`;
      const name = idx === 0 ? 'Trailhead' : `Waypoint ${idx + 1}`;
      el.innerHTML = `<span>${label}</span><div class="waypoint-handle-tooltip">${name} • Drag to move (Right-click to delete)</div>`;

      el.addEventListener('contextmenu', (e) => {
        e.preventDefault();
        e.stopPropagation();
        if (vertices.length > 2) {
          vertices.splice(idx, 1);
          this.editingSoundwalkFeature.geometry.coordinates = vertices;
          this.updateAcousticZonePolygons();
          this.refreshSoundwalkEditHandles(vertices);
        } else {
          alert('A soundwalk trail must have at least 2 waypoints.');
        }
      });

      const marker = new maplibregl.Marker({
        element: el,
        draggable: true
      })
        .setLngLat(coord)
        .addTo(this.map);

      marker.on('drag', () => {
        const lngLat = marker.getLngLat();
        vertices[idx] = [lngLat.lng, lngLat.lat];
        this.editingSoundwalkFeature.geometry.coordinates = vertices;
        this.updateAcousticZonePolygons();
        this.updateSoundwalkMidpointPositions(vertices);
      });

      marker.on('dragend', () => {
        const lngLat = marker.getLngLat();
        vertices[idx] = [lngLat.lng, lngLat.lat];
        this.editingSoundwalkFeature.geometry.coordinates = vertices;
        this.updateAcousticZonePolygons();
        this.refreshSoundwalkEditHandles(vertices);
      });

      this.soundwalkEditWaypointMarkers.push(marker);
    });

    // 2. Create Midpoint Insert Handles (+)
    for (let i = 0; i < vertices.length - 1; i++) {
      const p1 = vertices[i];
      const p2 = vertices[i + 1];
      const midCoord = [(p1[0] + p2[0]) / 2, (p1[1] + p2[1]) / 2];

      const midEl = document.createElement('div');
      midEl.className = 'soundwalk-edit-midpoint-handle';
      midEl.innerHTML = `+`;
      midEl.title = 'Click to insert waypoint here';

      midEl.addEventListener('click', (e) => {
        e.stopPropagation();
        vertices.splice(i + 1, 0, midCoord);
        this.editingSoundwalkFeature.geometry.coordinates = vertices;
        this.updateAcousticZonePolygons();
        this.refreshSoundwalkEditHandles(vertices);
      });

      const midMarker = new maplibregl.Marker({
        element: midEl,
        draggable: false
      })
        .setLngLat(midCoord)
        .addTo(this.map);

      this.soundwalkEditMidpointMarkers.push({ marker: midMarker, index: i });
    }
  }

  updateSoundwalkMidpointPositions(vertices) {
    this.soundwalkEditMidpointMarkers.forEach(({ marker, index }) => {
      if (index < vertices.length - 1) {
        const p1 = vertices[index];
        const p2 = vertices[index + 1];
        const midCoord = [(p1[0] + p2[0]) / 2, (p1[1] + p2[1]) / 2];
        marker.setLngLat(midCoord);
      }
    });
  }

  saveEditingSoundwalk() {
    if (!this.isEditingSoundwalk || !this.editingSoundwalkFeature) return;
    const feat = this.editingSoundwalkFeature;
    const vertices = GeoEngine.extractLineVertices(feat.geometry.coordinates);

    // Synchronize spatialPlayback waypoints array with updated coordinates
    const existingWaypoints = feat.properties?.spatialPlayback?.waypoints || [];
    const updatedWaypoints = vertices.map((v, i) => {
      const oldName = existingWaypoints[i]?.name;
      return {
        index: i,
        name: oldName || (i === 0 ? 'Trailhead' : `Waypoint ${i + 1}`),
        coords: v
      };
    });

    if (!feat.properties) feat.properties = {};
    if (!feat.properties.spatialPlayback) feat.properties.spatialPlayback = {};
    feat.properties.spatialPlayback.waypoints = updatedWaypoints;

    const callback = this.onSoundwalkEditSave;
    this.stopEditingSoundwalk();
    if (callback) callback(feat);
  }

  cancelEditingSoundwalk() {
    if (this.editingSoundwalkFeature && this.editingSoundwalkBackupCoords) {
      this.editingSoundwalkFeature.geometry.coordinates = this.editingSoundwalkBackupCoords;
      this.updateAcousticZonePolygons();
    }
    const callback = this.onSoundwalkEditCancel;
    this.stopEditingSoundwalk();
    if (callback) callback();
  }

  stopEditingSoundwalk() {
    this.isEditingSoundwalk = false;
    const feat = this.editingSoundwalkFeature;
    this.editingSoundwalkFeature = null;
    this.editingSoundwalkBackupCoords = null;

    this.soundwalkEditWaypointMarkers.forEach(m => m.remove());
    this.soundwalkEditWaypointMarkers = [];
    this.soundwalkEditMidpointMarkers.forEach(item => item.marker.remove());
    this.soundwalkEditMidpointMarkers = [];

    const banner = document.getElementById('soundwalk-edit-banner');
    if (banner) banner.style.display = 'none';
    document.body.classList.remove('soundwalk-edit-mode');

    // Recreate markers & waypoints
    if (feat) {
      this.createPinMarker(feat);
    }
  }

  /**
   * Toggle Pin Dropping placement mode
   */
  setAddingPinMode(active) {
    this.isAddingPin = active;
    if (active) {
      this.stopDrawingPolygon();
      this.cancelEditingPolygon();
      this.stopDrawingSoundwalk();
      this.cancelEditingSoundwalk();
    }
    const canvas = this.map.getCanvas();
    if (active) {
      canvas.style.cursor = 'crosshair';
      document.body.classList.add('pin-drop-mode');
    } else {
      canvas.style.cursor = '';
      document.body.classList.remove('pin-drop-mode');
    }
  }

  /**
   * Toggle Pin Relocation Mode for an existing marker
   */
  setRelocatingPinMode(featureId) {
    this.relocatingFeatureId = featureId;
    if (featureId) {
      this.stopDrawingPolygon();
      this.cancelEditingPolygon();
      this.stopDrawingSoundwalk();
      this.cancelEditingSoundwalk();
    }
    const canvas = this.map.getCanvas();
    const relocateBanner = document.getElementById('pin-relocate-banner');
    const relocateTitle = document.getElementById('relocate-pin-title');

    if (featureId) {
      const feat = this.features.find(f => f.id === featureId);
      if (relocateTitle) {
        relocateTitle.innerText = feat?.properties?.title || 'Recording';
      }
      canvas.style.cursor = 'crosshair';
      if (relocateBanner) relocateBanner.style.display = 'flex';
      document.body.classList.add('pin-relocate-mode');
    } else {
      canvas.style.cursor = '';
      if (relocateBanner) relocateBanner.style.display = 'none';
      document.body.classList.remove('pin-relocate-mode');
    }
  }

  /**
   * Programmatically update listener marker position
   */
  setListenerCoordinates(coords, panTo = false) {
    if (!coords || !Array.isArray(coords) || coords.length < 2 || isNaN(coords[0]) || isNaN(coords[1])) {
      return;
    }
    const safeCoords = [Number(coords[0]), Number(coords[1])];
    if (this.listenerMarker) {
      this.listenerMarker.setLngLat(safeCoords);
    }
    if (panTo && this.map) {
      this.map.easeTo({ center: safeCoords, duration: 600 });
    }
  }

  /**
   * Initial render of Sound Markers and Proximity Radius Polygons
   */
  renderSoundscapeFeatures(geoJsonData) {
    this.features = [...(geoJsonData?.features || [])];
    this.updateAcousticZonePolygons();

    // Render Pin Markers
    this.features.forEach((feature) => {
      this.createPinMarker(feature);
    });
  }

  /**
   * Dynamically add a single new sound feature
   */
  addSoundFeature(feature) {
    this.removeSoundFeature(feature.id);
    this.features.push(feature);
    this.createPinMarker(feature);
    this.updateAcousticZonePolygons();
    this.focusOnPin(feature);
  }

  /**
   * Dynamically update an existing sound feature's visual pin and polygons
   */
  updateSoundFeature(feature) {
    const idx = this.features.findIndex(f => f.id === feature.id);
    if (idx !== -1) {
      this.features[idx] = feature;
    } else {
      this.features.push(feature);
    }

    const coords = this.getFeatureCoordinates(feature);
    const props = feature.properties || {};
    const tax = props.archival?.taxonomies?.[0] || 'biophony';

    const marker = this.soundMarkers.get(feature.id);
    if (marker) {
      marker.setLngLat(coords);
      const el = marker.getElement();
      if (el) {
        const geomType = feature.geometry?.type || 'Point';
        const isPolygon = geomType === 'Polygon' || geomType === 'MultiPolygon';
        const isLineString = geomType === 'LineString' || geomType === 'MultiLineString';
        const badgeClass = isPolygon ? 'pin-habitat-zone' : isLineString ? 'pin-soundwalk-path' : '';
        el.className = `sound-pin-marker pin-${tax} ${badgeClass}`;
        const tooltip = el.querySelector('.pin-tooltip');
        if (tooltip) {
          tooltip.innerText = isPolygon
            ? `🌲 ${props.title}`
            : isLineString
            ? `🚶 ${props.title}`
            : props.title;
        }
      }
    } else {
      this.createPinMarker(feature);
    }

    this.updateAcousticZonePolygons();
  }

  /**
   * Remove a sound feature by ID
   */
  removeSoundFeature(id) {
    const marker = this.soundMarkers.get(id);
    if (marker) {
      marker.remove();
      this.soundMarkers.delete(id);
    }

    this.features = this.features.filter((f) => f.id !== id);
    if (this.waypointMarkers) {
      const markers = this.waypointMarkers.get(id) || [];
      markers.forEach(m => m.remove());
      this.waypointMarkers.delete(id);
    }
    this.updateAcousticZonePolygons();
  }

  /**
   * Re-calculates and updates the GeoJSON polygon and soundwalk path layers on the map
   */
  updateAcousticZonePolygons() {
    if (!this.map || !this.map.isStyleLoaded()) return;

    const polygonFeatures = [];
    const lineFeatures = [];

    (this.features || []).forEach((f, index) => {
      const geomType = f.geometry?.type || 'Point';
      const isPolygon = geomType === 'Polygon' || geomType === 'MultiPolygon';
      const isLineString = geomType === 'LineString' || geomType === 'MultiLineString';
      const tax = String(f.properties?.archival?.taxonomies?.[0] || 'biophony');

      if (isLineString) {
        lineFeatures.push({
          type: 'Feature',
          id: index + 1,
          geometry: f.geometry,
          properties: {
            featureId: String(f.id || index),
            title: String(f.properties?.title || 'Soundwalk'),
            taxonomy: tax
          }
        });
      } else {
        let polyGeom;
        if (isPolygon) {
          polyGeom = f.geometry;
        } else {
          const radius = Number(f.properties?.spatialPlayback?.radiusMeters) || 60;
          const coords = f.geometry?.coordinates || [115.8605, -31.9505];
          polyGeom = GeoEngine.createCirclePolygon(coords, radius);
        }

        polygonFeatures.push({
          type: 'Feature',
          id: index + 1,
          geometry: polyGeom,
          properties: {
            featureId: String(f.id || index),
            title: String(f.properties?.title || 'Sound'),
            taxonomy: tax,
            isPolygon: isPolygon
          }
        });
      }
    });

    // 1. Update Polygon & Point Proximity Zones
    const circleGeoJson = {
      type: 'FeatureCollection',
      features: polygonFeatures
    };

    if (this.map.getSource('acoustic-zones')) {
      this.map.getSource('acoustic-zones').setData(circleGeoJson);
    } else {
      this.map.addSource('acoustic-zones', {
        type: 'geojson',
        data: circleGeoJson
      });

      this.map.addLayer({
        id: 'acoustic-zones-fill',
        type: 'fill',
        source: 'acoustic-zones',
        paint: {
          'fill-color': [
            'match',
            ['coalesce', ['get', 'taxonomy'], 'biophony'],
            'biophony', '#e83bb2',
            'geophony', '#d946ef',
            'anthropophony', '#f43f5e',
            '#c084fc'
          ],
          'fill-opacity': [
            'case',
            ['boolean', ['get', 'isPolygon'], false], 0.28,
            0.20
          ]
        }
      });

      this.map.addLayer({
        id: 'acoustic-zones-stroke',
        type: 'line',
        source: 'acoustic-zones',
        paint: {
          'line-color': [
            'match',
            ['coalesce', ['get', 'taxonomy'], 'biophony'],
            'biophony', '#e83bb2',
            'geophony', '#d946ef',
            'anthropophony', '#f43f5e',
            '#c084fc'
          ],
          'line-width': [
            'case',
            ['boolean', ['get', 'isPolygon'], false], 3,
            2
          ],
          'line-dasharray': [2, 2],
          'line-opacity': 0.85
        }
      });

      // Interactive zone selection on click
      this.map.on('click', 'acoustic-zones-fill', (e) => {
        if (this.isDrawingPolygon || this.isEditingPolygon || this.isAddingPin || this.relocatingFeatureId) return;
        const featId = e.features?.[0]?.properties?.featureId;
        if (featId && this.onSoundSelect) {
          const feat = this.features.find(f => String(f.id) === String(featId));
          if (feat) {
            this.onSoundSelect(feat);
          }
        }
      });

      this.map.on('mouseenter', 'acoustic-zones-fill', () => {
        if (!this.isDrawingPolygon && !this.isEditingPolygon && !this.isAddingPin && !this.relocatingFeatureId) {
          this.map.getCanvas().style.cursor = 'pointer';
        }
      });

      this.map.on('mouseleave', 'acoustic-zones-fill', () => {
        if (!this.isDrawingPolygon && !this.isEditingPolygon && !this.isAddingPin && !this.relocatingFeatureId) {
          this.map.getCanvas().style.cursor = '';
        }
      });
    }

    // 2. Update Soundwalk Polyline Trajectory Paths
    const pathGeoJson = {
      type: 'FeatureCollection',
      features: lineFeatures
    };

    if (this.map.getSource('soundwalk-paths')) {
      this.map.getSource('soundwalk-paths').setData(pathGeoJson);
    } else {
      this.map.addSource('soundwalk-paths', {
        type: 'geojson',
        data: pathGeoJson
      });

      // Outer neon glow
      this.map.addLayer({
        id: 'soundwalk-paths-glow',
        type: 'line',
        source: 'soundwalk-paths',
        layout: {
          'line-join': 'round',
          'line-cap': 'round'
        },
        paint: {
          'line-color': '#e83bb2',
          'line-width': 8,
          'line-opacity': 0.35,
          'line-blur': 3
        }
      });

      // Inner vibrant dashed route
      this.map.addLayer({
        id: 'soundwalk-paths-core',
        type: 'line',
        source: 'soundwalk-paths',
        layout: {
          'line-join': 'round',
          'line-cap': 'round'
        },
        paint: {
          'line-color': '#ffffff',
          'line-width': 3,
          'line-dasharray': [1, 2],
          'line-opacity': 0.95
        }
      });

      // Interactive soundwalk selection on click
      const handleSoundwalkPathClick = (e) => {
        if (this.isDrawingPolygon || this.isEditingPolygon || this.isDrawingSoundwalk || this.isEditingSoundwalk || this.isAddingPin || this.relocatingFeatureId) return;
        const featId = e.features?.[0]?.properties?.featureId;
        if (featId && this.onSoundSelect) {
          const feat = this.features.find(f => String(f.id) === String(featId));
          if (feat) {
            this.onSoundSelect(feat);
          }
        }
      };

      this.map.on('click', 'soundwalk-paths-glow', handleSoundwalkPathClick);
      this.map.on('click', 'soundwalk-paths-core', handleSoundwalkPathClick);

      this.map.on('mouseenter', 'soundwalk-paths-core', () => {
        if (!this.isDrawingPolygon && !this.isEditingPolygon && !this.isDrawingSoundwalk && !this.isEditingSoundwalk && !this.isAddingPin && !this.relocatingFeatureId) {
          this.map.getCanvas().style.cursor = 'pointer';
        }
      });

      this.map.on('mouseleave', 'soundwalk-paths-core', () => {
        if (!this.isDrawingPolygon && !this.isEditingPolygon && !this.isDrawingSoundwalk && !this.isEditingSoundwalk && !this.isAddingPin && !this.relocatingFeatureId) {
          this.map.getCanvas().style.cursor = '';
        }
      });
    }
  }

  /**
   * Helper to safely extract a guaranteed valid [lng, lat] coordinate pair from any GeoJSON feature or geometry
   * @param {Object} feature - GeoJSON Feature or Geometry
   * @returns {[number, number]} [lng, lat]
   */
  getFeatureCoordinates(feature) {
    if (!feature) {
      return this.initialCenter ? [...this.initialCenter] : [115.8605, -31.9505];
    }

    const geom = feature.geometry || (feature.type && feature.coordinates ? feature : null);
    if (!geom) {
      return this.initialCenter ? [...this.initialCenter] : [115.8605, -31.9505];
    }

    const geomType = geom.type || 'Point';
    let coords = null;

    if (geomType === 'Polygon' || geomType === 'MultiPolygon') {
      coords = GeoEngine.getPolygonCentroid(geom.coordinates);
    } else if (geomType === 'LineString' || geomType === 'MultiLineString') {
      if (Array.isArray(geom.coordinates) && geom.coordinates.length > 0) {
        let firstPt = geom.coordinates[0];
        while (Array.isArray(firstPt) && Array.isArray(firstPt[0])) {
          firstPt = firstPt[0];
        }
        if (Array.isArray(firstPt) && firstPt.length >= 2 && !isNaN(firstPt[0]) && !isNaN(firstPt[1]) && firstPt[0] !== null && firstPt[1] !== null) {
          coords = [Number(firstPt[0]), Number(firstPt[1])];
        }
      }
    } else {
      // Point or flat coordinate
      const raw = geom.coordinates;
      if (Array.isArray(raw) && raw.length >= 2 && !isNaN(raw[0]) && !isNaN(raw[1]) && raw[0] !== null && raw[1] !== null) {
        coords = [Number(raw[0]), Number(raw[1])];
      } else if (raw && typeof raw === 'object') {
        const lng = raw.lng ?? raw.lon ?? raw.longitude;
        const lat = raw.lat ?? raw.latitude;
        if (!isNaN(lng) && !isNaN(lat) && lng !== null && lat !== null) {
          coords = [Number(lng), Number(lat)];
        }
      }
    }

    if (!coords || !Array.isArray(coords) || coords.length < 2 || isNaN(coords[0]) || isNaN(coords[1]) || coords[0] === null || coords[1] === null) {
      return this.initialCenter ? [...this.initialCenter] : [115.8605, -31.9505];
    }

    return coords;
  }

  /**
   * Creates custom HTML marker pin for a sound node, polygon centroid, or soundwalk path
   */
  createPinMarker(feature) {
    if (!this.map || !feature) return;
    if (!this.waypointMarkers) this.waypointMarkers = new Map();

    // Clean up any existing marker for this feature ID
    if (this.soundMarkers.has(feature.id)) {
      this.soundMarkers.get(feature.id).remove();
      this.soundMarkers.delete(feature.id);
    }
    if (this.waypointMarkers.has(feature.id)) {
      const markers = this.waypointMarkers.get(feature.id) || [];
      markers.forEach(m => m.remove());
      this.waypointMarkers.delete(feature.id);
    }

    const geomType = feature.geometry?.type || 'Point';
    const isPolygon = geomType === 'Polygon' || geomType === 'MultiPolygon';
    const isLineString = geomType === 'LineString' || geomType === 'MultiLineString';

    const coords = this.getFeatureCoordinates(feature);
    const props = feature.properties || {};
    const tax = props.archival?.taxonomies?.[0] || 'biophony';

    const el = document.createElement('div');
    const badgeClass = isPolygon ? 'pin-habitat-zone' : isLineString ? 'pin-soundwalk-path' : '';
    el.className = `sound-pin-marker pin-${tax} ${badgeClass}`;
    el.dataset.id = feature.id;
    el.title = isPolygon
      ? `Habitat Zone: ${props.title} (Click to view)`
      : isLineString
      ? `Soundwalk Trailhead: ${props.title} (Click to view)`
      : `${props.title} (Click to view or drag to reposition)`;

    el.innerHTML = isPolygon
      ? `
        <div class="pin-icon">
          <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2">
            <polygon points="12 2 2 7 12 12 22 7 12 2"></polygon>
            <polyline points="2 17 12 22 22 17"></polyline>
            <polyline points="2 12 12 17 22 12"></polyline>
          </svg>
        </div>
        <div class="pin-tooltip">🌲 ${props.title}</div>
      `
      : isLineString
      ? `
        <div class="pin-icon">
          <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2">
            <path d="M13 4v16M13 4l-4 4M13 4l4 4M7 16l6 4 6-4" />
          </svg>
        </div>
        <div class="pin-tooltip">🚶 ${props.title}</div>
      `
      : `
        <div class="pin-icon">
          <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2">
            <path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z"/>
            <path d="M19 10v2a7 7 0 0 1-14 0v-2"/>
            <line x1="12" y1="19" x2="12" y2="23"/>
            <line x1="8" y1="23" x2="16" y2="23"/>
          </svg>
        </div>
        <div class="pin-tooltip">${props.title}</div>
      `;

    el.addEventListener('click', (e) => {
      e.stopPropagation();
      if (this.onSoundSelect) {
        this.onSoundSelect(feature);
      }
    });

    const marker = new maplibregl.Marker({ 
      element: el,
      draggable: (!isPolygon && !isLineString) // Polygons & LineStrings anchored to geo vertices
    })
      .setLngLat(coords)
      .addTo(this.map);

    // If soundwalk has waypoints, render numbered nodes along route synchronized with line vertices
    if (isLineString) {
      const vertices = GeoEngine.extractLineVertices(feature.geometry.coordinates);
      const waypoints = props.spatialPlayback?.waypoints || [];
      const createdWaypoints = [];

      vertices.forEach((vertexCoord, wIdx) => {
        if (wIdx === 0 || !vertexCoord) return; // Skip trailhead (already has primary trailhead pin marker)
        
        let wpCoords = null;
        if (Array.isArray(vertexCoord) && vertexCoord.length >= 2 && !isNaN(vertexCoord[0]) && !isNaN(vertexCoord[1])) {
          wpCoords = [Number(vertexCoord[0]), Number(vertexCoord[1])];
        }

        if (!wpCoords) return;

        const wp = waypoints[wIdx] || { index: wIdx, name: `Waypoint ${wIdx + 1}` };

        const wpEl = document.createElement('div');
        wpEl.className = 'soundwalk-waypoint-dot';
        wpEl.innerHTML = `<span>${wIdx + 1}</span><div class="waypoint-tooltip">${wp.name || `Waypoint ${wIdx + 1}`}</div>`;
        wpEl.addEventListener('click', (e) => {
          e.stopPropagation();
          if (this.onSoundSelect) this.onSoundSelect(feature);
        });

        const wpMarker = new maplibregl.Marker({ element: wpEl })
          .setLngLat(wpCoords)
          .addTo(this.map);
        createdWaypoints.push(wpMarker);
      });
      this.waypointMarkers.set(feature.id, createdWaypoints);
    }

    if (!isPolygon && !isLineString) {
      // Real-time acoustic zone update while dragging pin
      marker.on('drag', () => {
        const lngLat = marker.getLngLat();
        feature.geometry.coordinates = [lngLat.lng, lngLat.lat];
        this.updateAcousticZonePolygons();
        if (this.onSoundMove) {
          this.onSoundMove(feature, [lngLat.lng, lngLat.lat]);
        }
      });

      // Finalize position & persist on dragend
      marker.on('dragend', () => {
        const lngLat = marker.getLngLat();
        feature.geometry.coordinates = [lngLat.lng, lngLat.lat];
        this.updateAcousticZonePolygons();
        if (this.onSoundMoved) {
          this.onSoundMoved(feature, [lngLat.lng, lngLat.lat]);
        }
      });
    }

    this.soundMarkers.set(feature.id, marker);
  }

  /**
   * Center map on a specific sound pin, polygon centroid, or soundwalk trailhead
   */
  focusOnPin(target) {
    if (!this.map || !target) return;

    let centerCoords = null;

    if (typeof target === 'object' && target.geometry) {
      // GeoJSON Feature passed directly
      centerCoords = this.getFeatureCoordinates(target);
    } else if (Array.isArray(target)) {
      if (target.length >= 2 && typeof target[0] === 'number' && typeof target[1] === 'number') {
        // Direct [lng, lat]
        centerCoords = target;
      } else if (Array.isArray(target[0])) {
        if (Array.isArray(target[0][0])) {
          // Polygon coordinates array
          centerCoords = GeoEngine.getPolygonCentroid(target);
        } else {
          // LineString coordinates array
          centerCoords = target[0];
        }
      }
    }

    if (centerCoords && centerCoords.length >= 2 && typeof centerCoords[0] === 'number' && typeof centerCoords[1] === 'number' && !isNaN(centerCoords[0]) && !isNaN(centerCoords[1])) {
      this.map.flyTo({
        center: centerCoords,
        zoom: 16.5,
        speed: 1.2
      });
    }
  }
}
