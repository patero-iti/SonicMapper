/**
 * AudioEngine - Web Audio API Spatial Engine
 * Handles AudioContext lifecycle, 3D/distance attenuation, audio file streaming, procedural synthesis,
 * First-Order Ambisonics (FOA) to Binaural decoding, and FFT analysis.
 */
import { GeoEngine } from './geo-engine.js';
import { FOABinauralDecoder } from './ambisonic-decoder.js';

export class AudioEngine {
  constructor() {
    this.ctx = null;
    this.masterGain = null;
    this.analyser = null;
    this.soundNodes = new Map(); // id -> SoundSourceNode
    this.isUnlocked = false;
    this.listenerPosition = [115.8605, -31.9505]; // [lng, lat]
    this.listenerHeading = 0; // degrees
    this.masterVolume = 0.85;
    this.mode = 'mock-gps'; // 'location', 'mock-gps', 'static'
    this.activeAuditionId = null; // for static solo audition
    this.activeAuditionWaypoint = null; // for specific waypoint solo audition
  }

  /**
   * Initializes or resumes the AudioContext on user interaction.
   */
  async unlock() {
    if (!this.ctx) {
      const AudioCtx = window.AudioContext || window.webkitAudioContext;
      this.ctx = new AudioCtx({ latencyHint: 'interactive' });

      // Master Gain
      this.masterGain = this.ctx.createGain();
      this.masterGain.gain.setValueAtTime(this.masterVolume, this.ctx.currentTime);

      // Master Analyser Node for Visualizers
      this.analyser = this.ctx.createAnalyser();
      this.analyser.fftSize = 256;
      this.analyser.smoothingTimeConstant = 0.8;

      this.masterGain.connect(this.analyser);
      this.analyser.connect(this.ctx.destination);
    }

    if (this.ctx.state === 'suspended') {
      await this.ctx.resume();
    }

    this.isUnlocked = true;
    return this.ctx.state === 'running';
  }

  /**
   * Sets master output volume (0.0 - 1.0)
   */
  setMasterVolume(val) {
    this.masterVolume = Math.max(0, Math.min(1, val));
    if (this.masterGain && this.ctx) {
      this.masterGain.gain.setTargetAtTime(this.masterVolume, this.ctx.currentTime, 0.05);
    }
  }

  /**
   * Register multiple sound features from GeoJSON manifest.
   */
  registerSounds(features) {
    features.forEach((feature) => {
      this.createSoundSource(feature);
    });
  }

  /**
   * Creates an audio source graph data object.
   */
  createSoundSource(feature, audioBlob = null, waypointBlobsMap = null) {
    const id = feature.id;
    if (this.soundNodes.has(id)) return this.soundNodes.get(id);

    const props = feature.properties || {};
    const geomType = feature.geometry?.type || 'Point';
    const isPolygon = geomType === 'Polygon' || geomType === 'MultiPolygon';
    const isLineString = geomType === 'LineString' || geomType === 'MultiLineString';
    const polygonCoords = isPolygon ? feature.geometry?.coordinates : null;
    const lineCoords = isLineString ? feature.geometry?.coordinates : null;

    let coords;
    if (isPolygon) {
      coords = GeoEngine.getPolygonCentroid(feature.geometry?.coordinates);
    } else if (isLineString) {
      const vertices = GeoEngine.extractLineVertices(feature.geometry?.coordinates);
      const midIdx = Math.floor(vertices.length / 2);
      coords = vertices[midIdx] || vertices[0] || [115.8605, -31.9505];
    } else {
      coords = GeoEngine.toCoordPair(feature.geometry?.coordinates) || [115.8605, -31.9505];
    }

    const radius = props.spatialPlayback?.radiusMeters || (isPolygon ? 50 : isLineString ? 40 : 60);
    const rolloff = props.spatialPlayback?.rolloff || 'exponential';
    const synthType = props.synthType || (props.audio?.url ? null : (isPolygon ? 'water' : isLineString ? 'wind' : 'birdsong'));
    const synthVolume = props.spatialPlayback?.synthVolume !== undefined ? Number(props.spatialPlayback.synthVolume) : 0.35;
    const audioVolume = props.spatialPlayback?.audioVolume !== undefined ? Number(props.spatialPlayback.audioVolume) : 0.85;

    const channelFormat = props.audio?.channelFormat || props.channelFormat || 'stereo';
    const channels = props.audio?.channels || (channelFormat.includes('ambisonic') ? 4 : 2);
    const isAmbisonic = channelFormat.includes('ambisonic') || channels === 4;

    const sourceObj = {
      id,
      feature,
      coords,
      isPolygon,
      polygonCoords,
      isLineString,
      lineCoords,
      radius,
      rolloff,
      synthType,
      synthVolume,
      audioVolume,
      channelFormat,
      channels,
      isAmbisonic,
      audioUrl: props.audio?.url,
      audioBlob: audioBlob,
      waypointBlobsMap: waypointBlobsMap || new Map(),
      gainNode: null,
      synthGainNode: null,
      audioGainNode: null,
      pannerNode: null,
      ambisonicDecoder: null,
      sourceNode: null,
      synthSourceNodes: [],
      audioElement: null,
      waypointNodes: new Map(), // wpIndex -> WaypointAudioNode
      isPlaying: false,
      currentDistance: Infinity,
      currentGain: 0,
      activeWaypoint: null
    };

    this.soundNodes.set(id, sourceObj);

    if (this.isUnlocked) {
      this.initSourceAudioGraph(sourceObj);
      this.updateProximityMix();
    }

    return sourceObj;
  }

  /**
   * Start playback for all registered spatial sound sources.
   */
  async startAllSpatialSources() {
    await this.unlock();

    for (const [, sound] of this.soundNodes) {
      if (!sound.isPlaying) {
        this.initSourceAudioGraph(sound);
      }
    }
    this.updateProximityMix();
  }

  /**
   * Initializes audio routing for an individual source.
   */
  initSourceAudioGraph(sound) {
    if (!this.ctx || sound.isPlaying) return;

    if (sound.isAmbisonic) {
      // Setup First-Order Ambisonic (FOA) Binaural Pipeline
      const format = sound.channelFormat.includes('fuma') ? 'fuma' : 'ambix';
      sound.ambisonicDecoder = new FOABinauralDecoder(this.ctx, { format });
      sound.ambisonicDecoder.output.connect(this.masterGain);

      // Attach File Stream or Procedural Ambisonic generator
      if (sound.audioBlob || (sound.audioUrl && sound.audioUrl.startsWith('http'))) {
        this.attachAmbisonicFileAudioSource(sound);
      } else {
        this.attachProceduralAmbisonicAudio(sound);
      }
    } else if (sound.isLineString) {
      // Guided Soundwalk Trail Routing: Master corridor gain + Dual Layering (Synth Bed + Trail Audio)
      sound.gainNode = this.ctx.createGain();
      sound.gainNode.gain.setValueAtTime(0, this.ctx.currentTime);

      if (this.ctx.createStereoPanner) {
        sound.pannerNode = this.ctx.createStereoPanner();
        sound.pannerNode.pan.setValueAtTime(0, this.ctx.currentTime);
      }

      if (sound.pannerNode) {
        sound.gainNode.connect(sound.pannerNode);
        sound.pannerNode.connect(this.masterGain);
      } else {
        sound.gainNode.connect(this.masterGain);
      }

      // 1. Synthetic Ambience Bed Layer
      sound.synthGainNode = this.ctx.createGain();
      sound.synthGainNode.gain.setValueAtTime(sound.synthVolume, this.ctx.currentTime);
      sound.synthGainNode.connect(sound.gainNode);
      this.attachProceduralAudio(sound, sound.synthGainNode, sound.synthType || 'wind');

      // 2. Primary Trail Audio File Layer (Optional / Simultaneous)
      sound.audioGainNode = this.ctx.createGain();
      sound.audioGainNode.gain.setValueAtTime(sound.audioVolume, this.ctx.currentTime);
      sound.audioGainNode.connect(sound.gainNode);

      if (sound.audioBlob || (sound.audioUrl && sound.audioUrl.startsWith('http'))) {
        this.attachFileAudioSource(sound, sound.audioGainNode);
      }

      // 3. Multi-Waypoint Audio Stems / Pointers
      this.initWaypointAudioSources(sound);
    } else {
      // Standard Mono / Stereo Spatial Routing (Point or Polygon)
      sound.gainNode = this.ctx.createGain();
      sound.gainNode.gain.setValueAtTime(0, this.ctx.currentTime);

      if (this.ctx.createStereoPanner) {
        sound.pannerNode = this.ctx.createStereoPanner();
        sound.pannerNode.pan.setValueAtTime(0, this.ctx.currentTime);
      }

      if (sound.pannerNode) {
        sound.gainNode.connect(sound.pannerNode);
        sound.pannerNode.connect(this.masterGain);
      } else {
        sound.gainNode.connect(this.masterGain);
      }

      if (sound.audioBlob || (sound.audioUrl && sound.audioUrl.startsWith('http'))) {
        this.attachFileAudioSource(sound, sound.gainNode);
      } else {
        this.attachProceduralAudio(sound, sound.gainNode, sound.synthType);
      }
    }

    sound.isPlaying = true;
  }

  /**
   * Initializes audio stem routing for individual waypoints along a soundwalk
   */
  initWaypointAudioSources(sound) {
    if (!this.ctx || !sound.isLineString) return;

    this.cleanupWaypointSources(sound);
    sound.waypointNodes = new Map();

    const waypoints = sound.feature.properties?.spatialPlayback?.waypoints || [];
    waypoints.forEach((wp, idx) => {
      const wpIndex = wp.index !== undefined ? wp.index : idx;
      const wpCoords = GeoEngine.toCoordPair(wp.coords);
      if (!wpCoords) return;

      const wpRadius = wp.radiusMeters || wp.radius || 30;
      const wpVolume = wp.volume !== undefined ? Number(wp.volume) : 0.85;
      const wpSynth = wp.synthType || null;
      const wpBlob = sound.waypointBlobsMap?.get(wpIndex) || null;
      const wpUrl = wp.audio?.url || null;

      const wpGainNode = this.ctx.createGain();
      wpGainNode.gain.setValueAtTime(0, this.ctx.currentTime);

      let wpPanner = null;
      if (this.ctx.createStereoPanner) {
        wpPanner = this.ctx.createStereoPanner();
        wpPanner.pan.setValueAtTime(0, this.ctx.currentTime);
        wpGainNode.connect(wpPanner);
        wpPanner.connect(this.masterGain);
      } else {
        wpGainNode.connect(this.masterGain);
      }

      const wpNode = {
        index: wpIndex,
        name: wp.name || `Waypoint ${wpIndex + 1}`,
        coords: wpCoords,
        radius: wpRadius,
        volume: wpVolume,
        synthType: wpSynth,
        audioBlob: wpBlob,
        audioUrl: wpUrl,
        gainNode: wpGainNode,
        pannerNode: wpPanner,
        audioElement: null,
        sourceNode: null,
        synthSourceNodes: [],
        currentDistance: Infinity,
        currentGain: 0
      };

      if (wpBlob || (wpUrl && wpUrl.startsWith('http'))) {
        this.attachWaypointFileAudio(wpNode);
      } else if (wpSynth) {
        this.attachWaypointProceduralAudio(wpNode);
      }

      sound.waypointNodes.set(wpIndex, wpNode);
    });
  }

  /**
   * Attach audio file stream to a specific waypoint node
   */
  attachWaypointFileAudio(wpNode) {
    try {
      if (wpNode.audioElement) {
        wpNode.audioElement.pause();
        wpNode.audioElement.src = '';
      }

      const audioEl = new Audio();
      audioEl.crossOrigin = 'anonymous';
      audioEl.loop = true;

      if (wpNode.audioBlob) {
        audioEl.src = URL.createObjectURL(wpNode.audioBlob);
      } else if (wpNode.audioUrl) {
        audioEl.src = wpNode.audioUrl;
      }

      const mediaSource = this.ctx.createMediaElementSource(audioEl);
      mediaSource.connect(wpNode.gainNode);

      audioEl.play().catch(() => {});

      wpNode.audioElement = audioEl;
      wpNode.sourceNode = mediaSource;
    } catch (e) {
      console.warn(`Could not attach audio to waypoint ${wpNode.index}:`, e);
    }
  }

  /**
   * Attach procedural audio generator to a specific waypoint node
   */
  attachWaypointProceduralAudio(wpNode) {
    if (!wpNode.synthType) return;
    const ctx = this.ctx;
    const type = wpNode.synthType;

    // Clean up existing generators
    if (wpNode.synthSourceNodes) {
      wpNode.synthSourceNodes.forEach(node => {
        try { node.stop ? node.stop() : node.disconnect(); } catch (e) {}
      });
      wpNode.synthSourceNodes = [];
    }

    if (type === 'birdsong') {
      const osc = ctx.createOscillator();
      const lfo = ctx.createOscillator();
      const lfoGain = ctx.createGain();

      osc.type = 'sine';
      osc.frequency.setValueAtTime(2600 + (wpNode.index * 150), ctx.currentTime);

      lfo.type = 'triangle';
      lfo.frequency.setValueAtTime(4.2 + (wpNode.index * 0.3), ctx.currentTime);
      lfoGain.gain.setValueAtTime(550, ctx.currentTime);

      lfo.connect(lfoGain);
      lfoGain.connect(osc.frequency);

      const filter = ctx.createBiquadFilter();
      filter.type = 'bandpass';
      filter.frequency.setValueAtTime(2800, ctx.currentTime);
      filter.Q.setValueAtTime(3.5, ctx.currentTime);

      osc.connect(filter);
      filter.connect(wpNode.gainNode);

      osc.start();
      lfo.start();
      wpNode.synthSourceNodes.push(osc, lfo, lfoGain, filter);
    } else if (type === 'water') {
      const bufferSize = ctx.sampleRate * 2;
      const buffer = ctx.createBuffer(1, bufferSize, ctx.sampleRate);
      const data = buffer.getChannelData(0);
      let b0 = 0, b1 = 0, b2 = 0;
      for (let i = 0; i < bufferSize; i++) {
        const white = Math.random() * 2 - 1;
        b0 = 0.99886 * b0 + white * 0.0555179;
        b1 = 0.99332 * b1 + white * 0.0750759;
        b2 = 0.96900 * b2 + white * 0.1538520;
        data[i] = (b0 + b1 + b2) * 0.14;
      }

      const noiseSource = ctx.createBufferSource();
      noiseSource.buffer = buffer;
      noiseSource.loop = true;

      const filter = ctx.createBiquadFilter();
      filter.type = 'lowpass';
      filter.frequency.setValueAtTime(480, ctx.currentTime);

      noiseSource.connect(filter);
      filter.connect(wpNode.gainNode);

      noiseSource.start();
      wpNode.synthSourceNodes.push(noiseSource, filter);
    } else {
      const osc = ctx.createOscillator();
      osc.type = 'sine';
      osc.frequency.setValueAtTime(320, ctx.currentTime);
      osc.connect(wpNode.gainNode);
      osc.start();
      wpNode.synthSourceNodes.push(osc);
    }
  }

  /**
   * Cleans up all audio elements, sources and oscillators for waypoint nodes
   */
  cleanupWaypointSources(sound) {
    if (!sound.waypointNodes) return;
    for (const [, wpNode] of sound.waypointNodes) {
      if (wpNode.audioElement) {
        wpNode.audioElement.pause();
        wpNode.audioElement.src = '';
      }
      if (wpNode.sourceNode) {
        try { wpNode.sourceNode.disconnect(); } catch (e) {}
      }
      if (wpNode.synthSourceNodes) {
        wpNode.synthSourceNodes.forEach(node => {
          try { node.stop ? node.stop() : node.disconnect(); } catch (e) {}
        });
      }
      if (wpNode.gainNode) {
        wpNode.gainNode.disconnect();
      }
      if (wpNode.pannerNode) {
        wpNode.pannerNode.disconnect();
      }
    }
    sound.waypointNodes.clear();
  }

  /**
   * Attach an HTMLAudioElement streaming a Blob or URL (Stereo / Mono)
   */
  attachFileAudioSource(sound, targetGainNode = null) {
    try {
      const destGain = targetGainNode || sound.gainNode;
      const audioEl = new Audio();
      audioEl.crossOrigin = 'anonymous';
      audioEl.loop = true;

      if (sound.audioBlob) {
        audioEl.src = URL.createObjectURL(sound.audioBlob);
      } else if (sound.audioUrl) {
        audioEl.src = sound.audioUrl;
      }

      audioEl.onerror = () => {
        if (!sound.isLineString) {
          this.attachProceduralAudio(sound, destGain);
        }
      };

      const mediaSource = this.ctx.createMediaElementSource(audioEl);
      mediaSource.connect(destGain);

      audioEl.play().catch(() => {
        if (!sound.isLineString) {
          this.attachProceduralAudio(sound, destGain);
        }
      });

      sound.audioElement = audioEl;
      sound.sourceNode = mediaSource;
    } catch (e) {
      if (!sound.isLineString) {
        this.attachProceduralAudio(sound, targetGainNode || sound.gainNode);
      }
    }
  }

  /**
   * Load and decode a 4-channel Ambisonic audio file via Web Audio API decodeAudioData
   */
  async attachAmbisonicFileAudioSource(sound) {
    try {
      let arrayBuffer;
      if (sound.audioBlob) {
        arrayBuffer = await sound.audioBlob.arrayBuffer();
      } else if (sound.audioUrl) {
        const response = await fetch(sound.audioUrl);
        arrayBuffer = await response.arrayBuffer();
      }

      if (!arrayBuffer) {
        throw new Error('No audio data received');
      }

      const audioBuffer = await this.ctx.decodeAudioData(arrayBuffer);
      const bufferSource = this.ctx.createBufferSource();
      bufferSource.buffer = audioBuffer;
      bufferSource.loop = true;

      if (audioBuffer.numberOfChannels >= 4) {
        // Direct 4-channel connection to Ambisonic Decoder
        bufferSource.connect(sound.ambisonicDecoder.input);
      } else {
        // If file is mono/stereo, upmix into Ambisonic W and Y
        const splitter = this.ctx.createChannelSplitter(audioBuffer.numberOfChannels);
        const merger = this.ctx.createChannelMerger(4);
        bufferSource.connect(splitter);
        
        splitter.connect(merger, 0, 0); // Ch0 -> W (Omni)
        if (audioBuffer.numberOfChannels > 1) {
          splitter.connect(merger, 1, 1); // Ch1 -> Y (Left-Right)
        }
        merger.connect(sound.ambisonicDecoder.input);
      }

      bufferSource.start(0);
      sound.sourceNode = bufferSource;
    } catch (err) {
      console.warn(`Ambisonic file decoding error for [${sound.id}], falling back to procedural ambisonic:`, err.message);
      this.attachProceduralAmbisonicAudio(sound);
    }
  }

  /**
   * Procedural sound generation based on ecological taxonomy (Mono/Stereo)
   */
  attachProceduralAudio(sound, targetGainNode = null, explicitType = null) {
    const type = explicitType || sound.synthType || 'birdsong';
    const ctx = this.ctx;
    const destGain = targetGainNode || sound.gainNode;

    if (!destGain) return;

    if (type === 'birdsong') {
      const osc = ctx.createOscillator();
      const lfo = ctx.createOscillator();
      const lfoGain = ctx.createGain();

      osc.type = 'sine';
      osc.frequency.setValueAtTime(2400, ctx.currentTime);

      lfo.type = 'triangle';
      lfo.frequency.setValueAtTime(4.5, ctx.currentTime);
      lfoGain.gain.setValueAtTime(600, ctx.currentTime);

      lfo.connect(lfoGain);
      lfoGain.connect(osc.frequency);

      const filter = ctx.createBiquadFilter();
      filter.type = 'bandpass';
      filter.frequency.setValueAtTime(2800, ctx.currentTime);
      filter.Q.setValueAtTime(3, ctx.currentTime);

      osc.connect(filter);
      filter.connect(destGain);

      osc.start();
      lfo.start();
      if (!sound.sourceNode) sound.sourceNode = osc;
    } else if (type === 'water') {
      const bufferSize = ctx.sampleRate * 2;
      const buffer = ctx.createBuffer(1, bufferSize, ctx.sampleRate);
      const data = buffer.getChannelData(0);
      let b0 = 0, b1 = 0, b2 = 0;
      for (let i = 0; i < bufferSize; i++) {
        const white = Math.random() * 2 - 1;
        b0 = 0.99886 * b0 + white * 0.0555179;
        b1 = 0.99332 * b1 + white * 0.0750759;
        b2 = 0.96900 * b2 + white * 0.1538520;
        data[i] = (b0 + b1 + b2) * 0.12;
      }

      const noiseSource = ctx.createBufferSource();
      noiseSource.buffer = buffer;
      noiseSource.loop = true;

      const filter = ctx.createBiquadFilter();
      filter.type = 'lowpass';
      filter.frequency.setValueAtTime(450, ctx.currentTime);

      const lfo = ctx.createOscillator();
      const lfoGain = ctx.createGain();
      lfo.type = 'sine';
      lfo.frequency.setValueAtTime(0.25, ctx.currentTime);
      lfoGain.gain.setValueAtTime(180, ctx.currentTime);
      lfo.connect(lfoGain);
      lfoGain.connect(filter.frequency);

      noiseSource.connect(filter);
      filter.connect(destGain);

      noiseSource.start();
      lfo.start();
      if (!sound.sourceNode) sound.sourceNode = noiseSource;
    } else if (type === 'wind') {
      const bufferSize = ctx.sampleRate * 2;
      const buffer = ctx.createBuffer(1, bufferSize, ctx.sampleRate);
      const data = buffer.getChannelData(0);
      for (let i = 0; i < bufferSize; i++) {
        data[i] = (Math.random() * 2 - 1) * 0.1;
      }

      const noiseSource = ctx.createBufferSource();
      noiseSource.buffer = buffer;
      noiseSource.loop = true;

      const filter = ctx.createBiquadFilter();
      filter.type = 'bandpass';
      filter.frequency.setValueAtTime(600, ctx.currentTime);
      filter.Q.setValueAtTime(1.2, ctx.currentTime);

      const lfo = ctx.createOscillator();
      const lfoGain = ctx.createGain();
      lfo.type = 'sine';
      lfo.frequency.setValueAtTime(0.12, ctx.currentTime);
      lfoGain.gain.setValueAtTime(350, ctx.currentTime);
      lfo.connect(lfoGain);
      lfoGain.connect(filter.frequency);

      noiseSource.connect(filter);
      filter.connect(destGain);

      noiseSource.start();
      lfo.start();
      if (!sound.sourceNode) sound.sourceNode = noiseSource;
    } else {
      const osc1 = ctx.createOscillator();
      const osc2 = ctx.createOscillator();
      osc1.type = 'sawtooth';
      osc1.frequency.setValueAtTime(60, ctx.currentTime);
      osc2.type = 'sine';
      osc2.frequency.setValueAtTime(120, ctx.currentTime);

      const filter = ctx.createBiquadFilter();
      filter.type = 'lowpass';
      filter.frequency.setValueAtTime(220, ctx.currentTime);

      const subGain = ctx.createGain();
      subGain.gain.setValueAtTime(0.15, ctx.currentTime);

      osc1.connect(filter);
      osc2.connect(filter);
      filter.connect(subGain);
      subGain.connect(destGain);

      osc1.start();
      osc2.start();
      if (!sound.sourceNode) sound.sourceNode = osc1;
    }
  }

  /**
   * Procedural First-Order Ambisonic (4-channel: W, Y, Z, X) soundfield generator
   */
  attachProceduralAmbisonicAudio(sound) {
    const ctx = this.ctx;
    const merger = ctx.createChannelMerger(4);

    // Channel 0 (W: Omni): Ambient broadband forest rustle / air
    const bufferSize = ctx.sampleRate * 2;
    const buffer = ctx.createBuffer(1, bufferSize, ctx.sampleRate);
    const data = buffer.getChannelData(0);
    for (let i = 0; i < bufferSize; i++) {
      data[i] = (Math.random() * 2 - 1) * 0.08;
    }
    const noiseSource = ctx.createBufferSource();
    noiseSource.buffer = buffer;
    noiseSource.loop = true;
    const filterW = ctx.createBiquadFilter();
    filterW.type = 'lowpass';
    filterW.frequency.setValueAtTime(900, ctx.currentTime);
    noiseSource.connect(filterW);
    filterW.connect(merger, 0, 0); // Connect to W (Ch 0)

    // Channel 1 (Y: Left-Right dipole): High-frequency insects / birds on lateral plane
    const oscY = ctx.createOscillator();
    oscY.type = 'sine';
    oscY.frequency.setValueAtTime(3200, ctx.currentTime);
    const lfoY = ctx.createOscillator();
    lfoY.type = 'triangle';
    lfoY.frequency.setValueAtTime(3.2, ctx.currentTime);
    const lfoGainY = ctx.createGain();
    lfoGainY.gain.setValueAtTime(400, ctx.currentTime);
    lfoY.connect(lfoGainY);
    lfoGainY.connect(oscY.frequency);
    const gainY = ctx.createGain();
    gainY.gain.setValueAtTime(0.12, ctx.currentTime);
    oscY.connect(gainY);
    gainY.connect(merger, 0, 1); // Connect to Y (Ch 1)

    // Channel 2 (Z: Up-Down dipole): High canopy rustle
    const filterZ = ctx.createBiquadFilter();
    filterZ.type = 'bandpass';
    filterZ.frequency.setValueAtTime(1800, ctx.currentTime);
    filterZ.Q.setValueAtTime(2.0, ctx.currentTime);
    const gainZ = ctx.createGain();
    gainZ.gain.setValueAtTime(0.09, ctx.currentTime);
    noiseSource.connect(filterZ);
    filterZ.connect(gainZ);
    gainZ.connect(merger, 0, 2); // Connect to Z (Ch 2)

    // Channel 3 (X: Front-Back dipole): Modulated front breeze
    const filterX = ctx.createBiquadFilter();
    filterX.type = 'bandpass';
    filterX.frequency.setValueAtTime(500, ctx.currentTime);
    filterX.Q.setValueAtTime(1.5, ctx.currentTime);
    const gainX = ctx.createGain();
    gainX.gain.setValueAtTime(0.15, ctx.currentTime);
    noiseSource.connect(filterX);
    filterX.connect(gainX);
    gainX.connect(merger, 0, 3); // Connect to X (Ch 3)

    // Start oscillators
    noiseSource.start();
    oscY.start();
    lfoY.start();

    // Connect 4-channel procedural soundfield to Ambisonic Decoder
    merger.connect(sound.ambisonicDecoder.input);
    sound.sourceNode = noiseSource;
  }

  /**
   * Remove and clean up a sound source node
   */
  removeSoundSource(id) {
    const sound = this.soundNodes.get(id);
    if (!sound) return;

    if (sound.audioElement) {
      sound.audioElement.pause();
      sound.audioElement.src = '';
    }
    if (sound.sourceNode && sound.sourceNode.stop) {
      try { sound.sourceNode.stop(); } catch (e) {}
    }
    if (sound.synthGainNode) {
      sound.synthGainNode.disconnect();
    }
    if (sound.audioGainNode) {
      sound.audioGainNode.disconnect();
    }
    if (sound.gainNode) {
      sound.gainNode.disconnect();
    }
    if (sound.pannerNode) {
      sound.pannerNode.disconnect();
    }
    if (sound.ambisonicDecoder) {
      sound.ambisonicDecoder.disconnect();
    }

    this.cleanupWaypointSources(sound);

    if (this.activeAuditionId === id) {
      this.activeAuditionId = null;
      this.activeAuditionWaypoint = null;
    }

    this.soundNodes.delete(id);
    this.updateProximityMix();
  }

  /**
   * Sets synthetic ambience bed volume for a soundwalk
   */
  setSoundSynthVolume(id, vol) {
    const sound = this.soundNodes.get(id);
    if (!sound) return;
    sound.synthVolume = Math.max(0, Math.min(1, vol));
    if (sound.synthGainNode && this.ctx) {
      sound.synthGainNode.gain.setTargetAtTime(sound.synthVolume, this.ctx.currentTime, 0.05);
    }
    if (sound.feature.properties.spatialPlayback) {
      sound.feature.properties.spatialPlayback.synthVolume = sound.synthVolume;
    }
  }

  /**
   * Sets primary audio track volume for a soundwalk
   */
  setSoundAudioVolume(id, vol) {
    const sound = this.soundNodes.get(id);
    if (!sound) return;
    sound.audioVolume = Math.max(0, Math.min(1, vol));
    if (sound.audioGainNode && this.ctx) {
      sound.audioGainNode.gain.setTargetAtTime(sound.audioVolume, this.ctx.currentTime, 0.05);
    }
    if (sound.feature.properties.spatialPlayback) {
      sound.feature.properties.spatialPlayback.audioVolume = sound.audioVolume;
    }
  }

  /**
   * Sets volume for a specific soundwalk waypoint
   */
  setWaypointVolume(id, wpIndex, vol) {
    const sound = this.soundNodes.get(id);
    if (!sound || !sound.waypointNodes) return;
    const wpNode = sound.waypointNodes.get(wpIndex);
    if (wpNode) {
      wpNode.volume = Math.max(0, Math.min(1, vol));
    }
    const waypoints = sound.feature.properties?.spatialPlayback?.waypoints;
    if (waypoints && waypoints[wpIndex]) {
      waypoints[wpIndex].volume = Math.max(0, Math.min(1, vol));
    }
    this.updateProximityMix();
  }

  /**
   * Sets trigger radius for a specific soundwalk waypoint
   */
  setWaypointRadius(id, wpIndex, radius) {
    const sound = this.soundNodes.get(id);
    if (!sound || !sound.waypointNodes) return;
    const wpNode = sound.waypointNodes.get(wpIndex);
    if (wpNode) {
      wpNode.radius = Math.max(5, Math.min(200, radius));
    }
    const waypoints = sound.feature.properties?.spatialPlayback?.waypoints;
    if (waypoints && waypoints[wpIndex]) {
      waypoints[wpIndex].radiusMeters = Math.max(5, Math.min(200, radius));
    }
    this.updateProximityMix();
  }

  /**
   * Attaches/replaces an audio blob on a specific soundwalk waypoint
   */
  setWaypointAudio(id, wpIndex, audioBlob) {
    const sound = this.soundNodes.get(id);
    if (!sound || !sound.waypointNodes) return;
    const wpNode = sound.waypointNodes.get(wpIndex);
    if (wpNode) {
      wpNode.audioBlob = audioBlob;
      wpNode.synthType = null;
      if (sound.waypointBlobsMap) {
        sound.waypointBlobsMap.set(wpIndex, audioBlob);
      }
      this.attachWaypointFileAudio(wpNode);
    }
  }

  /**
   * Updates coordinates of an existing sound source (e.g. when dragged on map)
   */
  updateSoundCoordinates(id, coords) {
    const sound = this.soundNodes.get(id);
    if (sound) {
      const validCoords = GeoEngine.toCoordPair(coords);
      if (validCoords) {
        sound.coords = validCoords;
        if (sound.feature && sound.feature.geometry && sound.feature.geometry.type === 'Point') {
          sound.feature.geometry.coordinates = validCoords;
        }
      }
      this.updateProximityMix();
    }
  }

  /**
   * Updates an entire sound feature's properties and reconfigures routing if necessary
   */
  updateSoundSource(feature, newAudioBlob = null, waypointBlobsMap = null) {
    const id = feature.id;
    const existing = this.soundNodes.get(id);
    const currentBlob = newAudioBlob || existing?.audioBlob;
    const currentWpBlobs = waypointBlobsMap || existing?.waypointBlobsMap;
    if (existing) {
      this.removeSoundSource(id);
    }
    this.createSoundSource(feature, currentBlob, currentWpBlobs);
    this.updateProximityMix();
  }

  /**
   * Updates listener position and recalculates proximity attenuation and panning.
   */
  updateListenerPosition(coords, heading = null) {
    const validCoords = GeoEngine.toCoordPair(coords);
    if (validCoords) {
      this.listenerPosition = validCoords;
    }
    if (heading !== null && !isNaN(heading)) {
      this.listenerHeading = heading;
    }
    this.updateProximityMix();
  }

  /**
   * Updates listener physical orientation/compass heading in degrees (0-360°)
   */
  updateListenerHeading(heading) {
    if (heading === null || isNaN(heading)) return;
    this.listenerHeading = ((heading % 360) + 360) % 360;
    this.updateProximityMix();
  }

  /**
   * Recalculates distance and adjusts gain / pan / ambisonic rotation across all nodes
   * with acoustic hysteresis boundary damping to prevent edge fluttering.
   */
  updateProximityMix() {
    if (!this.ctx || !this.isUnlocked) return;

    const now = this.ctx.currentTime;
    const timeConstant = 0.12;

    for (const [, sound] of this.soundNodes) {
      // In Static Solo Audition mode
      if (this.mode === 'static' && this.activeAuditionId) {
        if (sound.id === this.activeAuditionId) {
          if (this.activeAuditionWaypoint !== null && this.activeAuditionWaypoint !== undefined && sound.isLineString) {
            // Solo auditioning a specific waypoint along the soundwalk
            sound.currentGain = 0;
            if (sound.gainNode) sound.gainNode.gain.setTargetAtTime(0, now, timeConstant);
            for (const [wpIdx, wpNode] of sound.waypointNodes) {
              if (wpIdx === this.activeAuditionWaypoint) {
                wpNode.currentGain = 1.0;
                wpNode.gainNode.gain.setTargetAtTime(1.0, now, timeConstant);
                if (wpNode.pannerNode) wpNode.pannerNode.pan.setTargetAtTime(0, now, timeConstant);
              } else {
                wpNode.currentGain = 0;
                wpNode.gainNode.gain.setTargetAtTime(0, now, timeConstant);
              }
            }
          } else {
            // Solo auditioning the entire sound / soundwalk
            sound.currentGain = 1.0;
            if (sound.isAmbisonic && sound.ambisonicDecoder) {
              sound.ambisonicDecoder.setGain(1.0);
              sound.ambisonicDecoder.setRotation(0);
            } else if (sound.gainNode) {
              sound.gainNode.gain.setTargetAtTime(1.0, now, timeConstant);
              if (sound.pannerNode) sound.pannerNode.pan.setTargetAtTime(0, now, timeConstant);
            }
            if (sound.waypointNodes) {
              for (const [, wpNode] of sound.waypointNodes) {
                wpNode.currentGain = 0;
                wpNode.gainNode.gain.setTargetAtTime(0, now, timeConstant);
              }
            }
          }
        } else {
          sound.currentGain = 0;
          if (sound.isAmbisonic && sound.ambisonicDecoder) {
            sound.ambisonicDecoder.setGain(0);
          } else if (sound.gainNode) {
            sound.gainNode.gain.setTargetAtTime(0, now, timeConstant);
          }
          if (sound.waypointNodes) {
            for (const [, wpNode] of sound.waypointNodes) {
              wpNode.currentGain = 0;
              wpNode.gainNode.gain.setTargetAtTime(0, now, timeConstant);
            }
          }
        }
        continue;
      }

      // Proximity Distance & Gain Calculation (Point Radius vs Polygon Habitat vs LineString Soundwalk)
      let dist = 0;
      let gain = 0;
      let refCoords = sound.coords;

      if (sound.isPolygon && sound.polygonCoords) {
        const isInside = GeoEngine.isPointInPolygon(this.listenerPosition, sound.polygonCoords);
        if (isInside) {
          dist = 0;
          gain = 1.0;
          sound.isAudible = true;
        } else {
          dist = GeoEngine.distanceToPolygon(this.listenerPosition, sound.polygonCoords);
          const fadeBuffer = sound.radius || 50; // Buffer distance outside polygon before full silence
          if (dist < fadeBuffer) {
            const norm = 1 - dist / fadeBuffer;
            gain = Math.pow(norm, 1.8);
            sound.isAudible = true;
          } else {
            gain = 0;
            sound.isAudible = false;
          }
        }
      } else if (sound.isLineString && sound.lineCoords) {
        dist = GeoEngine.distanceToLineString(this.listenerPosition, sound.lineCoords);
        const closest = GeoEngine.findClosestWaypoint(this.listenerPosition, sound.lineCoords);
        refCoords = closest.coord;
        sound.activeWaypoint = closest;

        const pathBuffer = sound.radius || 40;
        if (dist < pathBuffer) {
          const norm = 1 - dist / pathBuffer;
          gain = sound.rolloff === 'exponential' ? Math.pow(norm, 1.5) : norm;
          sound.isAudible = true;
        } else {
          gain = 0;
          sound.isAudible = false;
        }

        // Calculate proximity for each waypoint stem node along the soundwalk
        if (sound.waypointNodes) {
          for (const [, wpNode] of sound.waypointNodes) {
            const wpDist = GeoEngine.getDistance(this.listenerPosition, wpNode.coords);
            wpNode.currentDistance = wpDist;
            if (wpDist < wpNode.radius) {
              const wpNorm = 1 - (wpDist / wpNode.radius);
              const wpGainVal = Math.pow(wpNorm, 1.4) * (wpNode.volume !== undefined ? wpNode.volume : 0.85);
              wpNode.gainNode.gain.setTargetAtTime(wpGainVal, now, timeConstant);
              wpNode.currentGain = wpGainVal;

              if (wpNode.pannerNode) {
                const bearing = GeoEngine.getBearing(this.listenerPosition, wpNode.coords);
                const relAngle = ((bearing - this.listenerHeading + 540) % 360) - 180;
                const panVal = Math.sin((relAngle * Math.PI) / 180);
                wpNode.pannerNode.pan.setTargetAtTime(panVal, now, timeConstant);
              }
            } else {
              wpNode.gainNode.gain.setTargetAtTime(0, now, timeConstant);
              wpNode.currentGain = 0;
            }
          }
        }
      } else {
        // Standard Point Source with Acoustic Hysteresis
        dist = GeoEngine.getDistance(this.listenerPosition, sound.coords);
        const exitRadius = sound.radius + Math.max(4, sound.radius * 0.08);
        const isAudible = sound.isAudible ? dist < exitRadius : dist <= sound.radius;
        sound.isAudible = isAudible;

        if (isAudible) {
          const effectiveMax = sound.isAudible && dist > sound.radius ? exitRadius : sound.radius;
          const norm = Math.max(0, 1 - dist / effectiveMax); // 1 at center, 0 at boundary
          if (sound.rolloff === 'exponential') {
            gain = Math.pow(norm, 2.0);
          } else {
            gain = norm; // Linear
          }
        }
      }

      sound.currentDistance = dist;
      sound.currentGain = gain;

      if (sound.isAmbisonic && sound.ambisonicDecoder) {
        // Calculate bearing and relative yaw rotation for Ambisonic soundfield
        const bearing = GeoEngine.getBearing(this.listenerPosition, refCoords);
        const relAngle = ((bearing - this.listenerHeading + 540) % 360) - 180;
        sound.ambisonicDecoder.setRotation(relAngle);
        sound.ambisonicDecoder.setGain(gain);
      } else if (sound.gainNode) {
        sound.gainNode.gain.setTargetAtTime(gain, now, timeConstant);

        // Standard Stereo Panning based on angle between listener and source
        const maxPanDist = sound.isPolygon || sound.isLineString ? 150 : (sound.radius * 1.5);
        if (sound.pannerNode && dist < maxPanDist) {
          const bearing = GeoEngine.getBearing(this.listenerPosition, refCoords);
          const relAngle = ((bearing - this.listenerHeading + 540) % 360) - 180;
          const panValue = Math.sin((relAngle * Math.PI) / 180);
          sound.pannerNode.pan.setTargetAtTime(panValue, now, timeConstant);
        }
      }
    }
  }

  /**
   * Set solo pin audition for Static Mode, optionally targeting a specific waypoint
   */
  setSoloAudition(soundId, wpIndex = null) {
    this.activeAuditionId = soundId;
    this.activeAuditionWaypoint = wpIndex;
    this.updateProximityMix();
  }

  /**
   * Get active sounds currently within audible proximity radius
   */
  getActiveAudibleSounds() {
    const list = [];
    for (const [, sound] of this.soundNodes) {
      if (sound.currentGain > 0.01) {
        list.push({
          id: sound.id,
          title: sound.feature.properties.title,
          distance: Math.round(sound.currentDistance),
          gain: Math.round(sound.currentGain * 100),
          taxonomy: sound.feature.properties.archival?.taxonomies?.[0] || 'sound',
          channelFormat: sound.channelFormat,
          isAmbisonic: sound.isAmbisonic
        });
      }

      // Also include active waypoints if audible
      if (sound.waypointNodes) {
        for (const [wpIdx, wpNode] of sound.waypointNodes) {
          if (wpNode.currentGain > 0.01) {
            list.push({
              id: `${sound.id}_wp_${wpIdx}`,
              title: `${sound.feature.properties.title} - ${wpNode.name}`,
              distance: Math.round(wpNode.currentDistance),
              gain: Math.round(wpNode.currentGain * 100),
              taxonomy: sound.feature.properties.archival?.taxonomies?.[0] || 'sound',
              channelFormat: 'stereo',
              isAmbisonic: false
            });
          }
        }
      }
    }
    return list.sort((a, b) => b.gain - a.gain);
  }

  /**
   * Frequency and Time Domain Analyser buffers for canvas visualizers
   */
  getVisualizerData() {
    if (!this.analyser) return { freqData: new Uint8Array(0), waveData: new Uint8Array(0) };

    const freqData = new Uint8Array(this.analyser.frequencyBinCount);
    const waveData = new Uint8Array(this.analyser.fftSize);

    this.analyser.getByteFrequencyData(freqData);
    this.analyser.getByteTimeDomainData(waveData);

    return { freqData, waveData };
  }
}
