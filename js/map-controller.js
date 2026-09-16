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
   * Fetches OpenFreeMap vector style JSON and applies strict type sanitization
   */
  async fetchSanitizedStyle(url) {
    try {
      const res = await fetch(url);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const rawStyle = await res.json();
      return this.sanitizeStyleExpressions(rawStyle);
    } catch (e) {
      console.warn('Could not pre-sanitize vector style JSON, falling back to direct URL:', e.message);
      return url;
    }
  }

  /**
   * Initializes the MapLibre GL instance with high-performance OpenFreeMap vector tiles.
   */
  async init() {
    const defaultStyleUrl = 'https://tiles.openfreemap.org/styles/positron';
    const initialStyle = await this.fetchSanitizedStyle(defaultStyleUrl);

    this.map = new maplibregl.Map({
      container: this.containerId,
      style: initialStyle, // Sanitized Positron Light style
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
   * Map click handler for listener relocation, pin adding, and pin relocation
   */
  setupMapClick() {
    this.map.on('click', (e) => {
      const coords = [e.lngLat.lng, e.lngLat.lat];

      // 1. Adding New Pin Mode
      if (this.isAddingPin) {
        this.setAddingPinMode(false);
        if (this.onPinDrop) {
          this.onPinDrop(coords);
        }
        return;
      }

      // 2. Relocating Existing Pin Mode
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

      // 3. Move listener in Mock GPS mode
      if (this.mode === 'mock-gps') {
        this.setListenerCoordinates(coords);
        if (this.onListenerMove) {
          this.onListenerMove(coords);
        }
      }
    });
  }

  /**
   * Toggle Pin Dropping placement mode
   */
  setAddingPinMode(active) {
    this.isAddingPin = active;
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
    if (this.listenerMarker) {
      this.listenerMarker.setLngLat(coords);
    }
    if (panTo && this.map) {
      this.map.easeTo({ center: coords, duration: 600 });
    }
  }

  /**
   * Initial render of Sound Markers and Proximity Radius Polygons
   */
  renderSoundscapeFeatures(geoJsonData) {
    this.features = [...geoJsonData.features];
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
    this.focusOnPin(feature.geometry.coordinates);
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

    const marker = this.soundMarkers.get(feature.id);
    const coords = feature.geometry.coordinates;
    const props = feature.properties;
    const tax = props.archival?.taxonomies?.[0] || 'biophony';

    if (marker) {
      marker.setLngLat(coords);
      const el = marker.getElement();
      if (el) {
        el.className = `sound-pin-marker pin-${tax}`;
        const tooltip = el.querySelector('.pin-tooltip');
        if (tooltip) tooltip.innerText = props.title;
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
    this.updateAcousticZonePolygons();
  }

  /**
   * Re-calculates and updates the GeoJSON polygon layer on the map
   */
  updateAcousticZonePolygons() {
    if (!this.map || !this.map.isStyleLoaded()) return;

    const polygonFeatures = (this.features || []).map((f, index) => {
      const isPolygon = f.geometry?.type === 'Polygon' || f.geometry?.type === 'MultiPolygon';
      let polyGeom;

      if (isPolygon) {
        polyGeom = f.geometry;
      } else {
        const radius = Number(f.properties?.spatialPlayback?.radiusMeters) || 60;
        const coords = f.geometry?.coordinates || [115.8605, -31.9505];
        polyGeom = GeoEngine.createCirclePolygon(coords, radius);
      }

      const tax = String(f.properties?.archival?.taxonomies?.[0] || 'biophony');

      return {
        type: 'Feature',
        id: index + 1,
        geometry: polyGeom,
        properties: {
          featureId: String(f.id || index),
          title: String(f.properties?.title || 'Sound'),
          taxonomy: tax,
          isPolygon: isPolygon
        }
      };
    });

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
    }
  }

  /**
   * Creates custom HTML marker pin for a sound node or polygon centroid
   */
  createPinMarker(feature) {
    const isPolygon = feature.geometry?.type === 'Polygon' || feature.geometry?.type === 'MultiPolygon';
    const coords = isPolygon
      ? GeoEngine.getPolygonCentroid(feature.geometry.coordinates)
      : feature.geometry.coordinates;

    const props = feature.properties;
    const tax = props.archival?.taxonomies?.[0] || 'biophony';

    const el = document.createElement('div');
    el.className = `sound-pin-marker pin-${tax} ${isPolygon ? 'pin-habitat-zone' : ''}`;
    el.dataset.id = feature.id;
    el.title = isPolygon
      ? `Habitat Zone: ${props.title} (Click to view)`
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
      draggable: !isPolygon // Polygons are anchored to geographic vertices
    })
      .setLngLat(coords)
      .addTo(this.map);

    if (!isPolygon) {
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
   * Center map on a specific sound pin
   */
  focusOnPin(coords) {
    if (this.map) {
      this.map.flyTo({
        center: coords,
        zoom: 16.5,
        speed: 1.2
      });
    }
  }
}
