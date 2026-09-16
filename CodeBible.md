# SoundScape Mapper / Audio Cartography Tool: CodeBible

An architectural blueprint, technical specification, and development bible for an interactive spatial audio mapping web application designed for field recording, sound art curation, acoustic ecology, and archival mapping.

---

## 1. Project Overview & Vision

The **Audio Cartography & Sound Art Mapping Tool** is a web-based platform designed to link acoustic recordings, field captures, and spatial sound compositions directly to geographic locations. The application bridges archival rigor with artistic presentation, functioning seamlessly across mobile devices (field/on-site listening and recording) and desktop/laptop environments (curatorial review, deep archival browsing, and compositional mapping).

### Core Goals
* **Dual Operating Paradigms**: A unified interface dynamically toggled between **Location-Aware Mode** (GPS-tracked, proximity-based spatial audio triggering, mobile optimized) and **Static Mode** (desktop/laptop interactive cartography, manual exploration, playlist curation, metadata inspection).
* **Sound Art & Archival Integrity**: Support for rich metadata schemas (BWF, acoustic tags, equipment specs, transcripts, access notes) paired with expressive audio playback (binaural rendering, crossfading, environmental zones/polygons).
* **Cross-Platform Resilience**: Modern web standards ensuring accessibility across mobile WebKit/Gecko/Chromium browsers without requiring native app-store installation.

---

## 2. Core Features Specification

### 2.1 Mode Architecture: Location-Aware vs. Static Mode

| Feature / Dimension | Location-Aware Mode (Mobile / On-Site) | Static Mode (Desktop / Laptop / Curatorial) |
| :--- | :--- | :--- |
| **Primary Input** | Device Geolocation API (`watchPosition`), DeviceOrientation API / compass | Mouse, keyboard navigation, multi-point selection, trackpad gestures |
| **User Role** | Physical walker, flâneur, on-site listener, field contributor | Curatorial archivist, researcher, acoustic analyst, remote listener |
| **Viewport Control** | Auto-centering on user GPS coordinates, heading-based map orientation | Free panning, zoom clustering, bounding-box search, split-screen inspections |
| **Playback Triggering** | Proximity radius / geofence enter-exit triggers, distance-attenuated gain | Explicit pin click, playlist progression, spatial mix preview |
| **Power Management** | Screen Wake Lock API, background audio session management | High-resolution spectrograms, simultaneous multi-channel stem auditioning |

### 2.2 Cartographic & Spatial Sound Capabilities
* **Geographic Pinning & Bounding Zones**:
  * **Point Markers**: Exact lat/long pinning for discrete field recordings (e.g., specific water drain, street corner, bird roost).
  * **Soundscape Polygons & Paths**: Geofenced polygons (ambient zones) and polyline paths (soundwalks, transit recordings) with directional waypoints.
* **Proximity & Dynamic Spatial Attenuation**:
  * Distance-based rolloff curves (linear, inverse, or exponential) simulating sound attenuation as the user approaches or leaves a marker.
  * Web Audio API `PannerNode` integration: 3D spatial panning (binaural listener simulation) based on distance and compass bearing.
* **Multi-Layer Soundwalks**:
  * Sequential audio tracks keyed to geographic waypoints.
  * Dynamic crossfading between overlapping acoustic zones to prevent abrupt cutoffs.

### 2.3 Archival & Sound Art Metadata
* **Metadata Schema Support**:
  * Title, Artist/Recordist, Date & Time of capture (ISO 8601).
  * Technical Specs: Sample rate, bit depth, microphone setup (ORTF, Ambisonic 1st/2nd order, Binaural in-ear, Hydrophone, Contact mic), recorder hardware.
  * Acoustic Ecology Tags: Bioacoustic (biophony), anthropophonic, geophonic taxonomy (Bernie Krause classification).
  * Access Intimacy & Accessibility Notes: Content disclosures, high-frequency warnings, synchronous WebVTT transcripts/captions for spoken word or audio description.
* **Audio Visualizations**:
  * Pre-rendered or canvas-generated interactive waveforms.
  * Real-time FFT spectrum visualizer and historical spectrograms for bioacoustic inspection.

### 2.4 Version Tracking, Telemetry & Build Metadata
* **Semantic Versioning (SemVer)**: Automatic and manual version stamping across UI, diagnostics, and GeoJSON manifest exports (`vMAJOR.MINOR.PATCH`).
* **Build Info Overlay / Diagnostic HUD**: Visible or toggleable build identifier, commit hash/date, active audio engine status, and runtime environment indicators for field debugging.
* **Changelog & Migration Sync**: Persistent build log within `CodeBible.md` tracking architectural changes, data schema modifications, and feature increments across releases.

---

## 3. Technology Stack & Library Recommendations

### 3.1 Mapping & Geospatial Engine
* **MapLibre GL JS + OpenFreeMap** *(Primary)*:
  * Open-source fork of Mapbox GL JS (BSD 3-Clause).
  * GPU-accelerated vector tile rendering with 100% free hosting and zero API keys via **OpenFreeMap** (`https://tiles.openfreemap.org/styles/dark`).
  * Smooth 60fps animations, 3D pitch/bearing rotation, and crisp retina rendering.
* *Alternative*: **Leaflet**:
  * Lightweight and simple for classic 2D raster tiles, though less performant when handling hundreds of animated sound radius circles or dense polygon overlays.

### 3.2 Audio Engine & Spatial Processing
* **Web Audio API (Native)**:
  * Fundamental layer for high-performance audio routing, `GainNode` gain automation, and `PannerNode` spatial positioning.
* **Tone.js**:
  * Production-grade framework built on Web Audio API. Provides robust transport scheduling, seamless crossfading, buffer pooling, and audio effect chains (reverb, filters, dynamic compression).
* **Howler.js**:
  * Solid fallback for cross-browser HTML5 audio unlocking, automatic caching, and basic 3D spatial audio roll-off, especially on restrictive iOS Safari environments.
* **Omnitone (Google)** *(Optional / Advanced)*:
  * Ambisonic spatial audio decoder for Web Audio, allowing first-order and higher-order Ambisonic (FOA/HOA) field recordings to be rotated dynamically as the listener turns their mobile device or rotates the desktop map.

### 3.3 Geolocation & Sensory APIs
* **W3C Geolocation API** (`navigator.geolocation.watchPosition`):
  * Continuous high-accuracy GPS tracking with configurable threshold filtering.
* **DeviceOrientation & DeviceMotionEvent**:
  * Accessing device compass heading for directional acoustic orientation and Ambisonic rotation.
* **Screen Wake Lock API**:
  * Prevents mobile screens from dimming/sleeping during active guided soundwalks.
* **Turf.js**:
  * Client-side spatial analysis library: calculates exact point-to-point distances (`turf.distance`), points inside acoustic polygon zones (`turf.booleanPointInPolygon`), and closest sound nodes.

### 3.4 Audio Visuals & Spectral Analysis
* **Wavesurfer.js**:
  * Interactive audio waveform rendering, marker regions, and Web Audio scrubbing.
* **Canvas API / WebGL**:
  * Custom fast-rendering spectrogram display for archival inspection.

### 3.5 Frontend Architecture & State Management
* **Framework**: **SvelteKit** or **React (Vite / Next.js)**:
  * Fast client-side rendering, low overhead, and efficient reactive state updates when processing real-time GPS coordinates.
* **State Management**: **Zustand** or **Pinia / Svelte Stores**:
  * Clean decoupled state tracking: `userLocation`, `currentMode ('static' | 'gps')`, `activeSounds[]`, `audioContextState`, and `selectedArchivePin`.
* **Database & Audio Storage (Backend)**:
  * **PostgreSQL + PostGIS**: Industry standard for geo-queries (e.g., `ST_DWithin`, finding all audio files within viewport bounding boxes).
  * **S3 / Cloudflare R2**: Object storage with CDN delivery and HTTP byte-range requests (essential for instant audio seeking).

---

## 4. Architectural Architecture Diagram

```
+-------------------------------------------------------------------------------+
|                                CLIENT APPLICATION                             |
|                                                                               |
|  +---------------------------+             +-------------------------------+  |
|  |     Presentation Mode     |             |      Spatial Audio Engine     |  |
|  |                           |             |                               |  |
|  |  +---------------------+  |             |  +-------------------------+  |  |
|  |  | Mobile GPS Mode     |  |  Coordinates|  | Tone.js / Web Audio API |  |  |
|  |  | (watchPosition)     |==|============>|  | - PannerNodes           |  |  |
|  |  +---------------------+  |   & Heading |  | - GainNode Proximity    |  |  |
|  |  | Desktop Static Mode |  |             |  | - Ambisonic Rotator     |  |  |
|  |  | (Map click / Hover) |==|============>|  +-------------------------+  |  |
|  |  +---------------------+  | Viewport &  |               |               |  |
|  +---------------------------+ User Action |               v               |  |
|               |                            |      Web Audio Destination    |  |
|               v                            |        (Headphones / DAC)     |  |
|  +---------------------------+             +-------------------------------+  |
|  |     MapLibre GL Canvas    |<----------------------------+                  |
|  | - GeoJSON Sound Layers    |                             |                  |
|  | - Proximity Radius Rings  |                             | GeoJSON & Audio  |
|  | - Soundwalk Polyline Trax |                             | Manifests        |
|  +---------------------------+                             |                  |
+------------------------------------------------------------|------------------+
                                                             |
                                                             v
+-------------------------------------------------------------------------------+
|                            BACKEND & ARCHIVAL STORAGE                         |
|                                                                               |
|  +-------------------------------------+   +-------------------------------+  |
|  |  PostgreSQL / PostGIS REST/GeoJSON   |   | S3 / R2 Object Audio Store    |  |
|  |  (Pins, Polygons, BWF Metadata,     |   | (Lossless FLAC, Opus, AAC,    |  |
|  |   Acoustic Ecology Tags, VTT Trans) |   |  Range Requests for Streaming)|  |
|  +-------------------------------------+   +-------------------------------+  |
+-------------------------------------------------------------------------------+
```

---

## 5. Data Model Schema (GeoJSON Specification)

```json
{
  "type": "FeatureCollection",
  "features": [
    {
      "type": "Feature",
      "id": "rec_f839a041",
      "geometry": {
        "type": "Point",
        "coordinates": [115.8605, -31.9505]
      },
      "properties": {
        "title": "Wetlands Birdsong & Distant Urban Hum",
        "recordist": "Field Recordist",
        "timestamp": "2026-04-12T06:15:00Z",
        "audio": {
          "url": "https://cdn.soundarchive.org/audio/wetlands_morning_2026.opus",
          "format": "audio/ogg; codecs=opus",
          "duration": 248.5,
          "channels": 2,
          "sampleRate": 48000,
          "channelFormat": "binaural",
          "micConfiguration": "In-ear Binaural Omni Pair"
        },
        "spatialPlayback": {
          "triggerType": "proximity",
          "radiusMeters": 45,
          "rolloff": "exponential",
          "loop": true,
          "attenuationMaxDb": -60
        },
        "archival": {
          "license": "CC-BY-SA 4.0",
          "taxonomies": ["biophony", "hydrophony"],
          "weather": "Clear, 18C, 4km/h wind",
          "equipment": "Zoom F6 + Soundman OKM II Classic",
          "transcriptUrl": "https://cdn.soundarchive.org/transcripts/wetlands_morning.vtt"
        }
      }
    }
  ]
}
```

---

## 6. Implementation Challenges & Technical Solutions

### 6.1 Audio Autoplay Policies on Mobile
* **Challenge**: Mobile browsers (iOS Safari, Android Chrome) block programmatic audio playback until an explicit user interaction occurs.
* **Solution**: Implement an initial "Enter Soundscape" or "Activate Listener" splash overlay that triggers an explicit `AudioContext.resume()` and plays a silent 1-sample buffer to unlock the device output pipeline.

### 6.2 GPS Drift & Jitter Mitigation
* **Challenge**: Built-in mobile GPS reporting wanders, causing rapid gain spikes or audio re-triggering while standing still.
* **Solution**: Use Kalman filtering or low-pass exponential smoothing on incoming latitude/longitude values. Apply a hysteresis buffer to proximity geofences (e.g., enter at 30m, exit at 35m) to prevent fluttering.

### 6.3 Background Playback on Mobile Web
* **Challenge**: When a mobile device locks or the browser tab enters the background, standard timers and scripts throttle or suspend.
* **Solution**: Utilize the **Media Session API** (`navigator.mediaSession`) combined with a looping background audio track, allowing continuous spatial tracking and audio stream playback while walking.

---

## 7. Development Roadmap

1. **Phase 1: Minimum Viable Prototyping**
   * Set up MapLibre GL JS map container with toggleable mock GPS coordinates.
   * Basic Web Audio gain node controller triggered by distance calculation (`turf.distance`).
   * Static audio playback drawer with waveform visualization.

2. **Phase 2: Mobile Integration & Orientation**
   * Real Geolocation `watchPosition` binding with hysteresis boundaries.
   * Compass heading binding (`DeviceOrientation`) feeding into 3D binaural `PannerNode`.
   * Screen Wake Lock API and audio context unlocking flow.

3. **Phase 3: Sound Art & Archival Tooling**
   * Polygon geofence support for ambient background zones.
   * Multi-track crossfading matrix.
   * Archival metadata modal with VTT caption sync, spectrogram rendering, and audio download options.

4. **Phase 4: Open Audio Cartography Protocol**
   * Export/Import collections as geo-tagged JSON/GeoJSON.
   * Offline caching via Service Workers for field listening in remote nature areas without cellular coverage.

---

## 8. Build History & Version Tracker

| Version | Date | Target / Focus | Key Additions & Milestones |
| :--- | :--- | :--- | :--- |
| **v0.1.0-spec** | *2026-09-10* | Architecture & Specification | Initial architectural blueprint, technology selection, GeoJSON schema definition, and dual-mode specifications. |
| **v0.1.0** | *2026-09-10* | Phase 1: MVP Scaffolding | Base ES Module architecture, MapLibre GL JS with OpenFreeMap dark vector tiles, Web Audio proximity rolloff engine with procedural synthesis, draggable/clickable Mock GPS listener node, taxonomy-coded pins (biophony, geophony, anthropophony), interactive audio playback drawer with real-time canvas waveform/FFT visualizer, and diagnostic HUD. |
| **v0.2.0** | *2026-09-10* | Cartography Authoring & Client Storage | Interactive '+ Add Sound' pin placement tool, local audio file upload (`.wav`, `.mp3`, `.flac`, `.ogg`), persistent IndexedDB binary audio storage & metadata management (zero-database backend needed), pin deletion, and GeoJSON export/import capabilities. || **v0.3.0** | *2026-09-11* | Phase 2: First-Order Ambisonics (FOA) Binaural Engine | Integrated `FOABinauralDecoder` supporting 4-channel B-format (AmbiX $W, Y, Z, X$ and FuMa $W, X, Y, Z$), dynamic soundfield yaw rotation matrix linked to listener compass heading, virtual loudspeaker array with Web Audio HRTF binauralization, 4-channel audio file ingestion via `decodeAudioData`, synthetic 4-channel procedural ambisonic generator, and spatial format selectors across the UI and GeoJSON metadata schemas. |
| **v0.3.1** | *2026-09-12* | Phase 2+: Marker Editing & Drag Relocation | Interactive Sound Marker Editing modal for all archival & audio fields, direct drag-and-drop map marker repositioning with real-time acoustic proximity radius tracking, dedicated '📍 Move Pin' relocation workflow, automatic IndexedDB client-side persistence on drag and edit, and immediate Web Audio spatial recalculation on move. |
| **v0.3.2** | *2026-09-16* | Mobile Portrait HUD & Vertical Volume Controls | Redesigned top navigation into a slide-over Burger Menu drawer (nesting Sound management, GPS positioning modes, map visual themes, and radar overlay toggle); repositioned master spatial volume controls to an ergonomic lower-left vertical slider with instant mute toggle for portrait mobile thumb access; added touch ergonomics and responsive layout transitions. |
