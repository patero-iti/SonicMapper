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
  createSoundSource(feature, audioBlob = null) {
    const id = feature.id;
    if (this.soundNodes.has(id)) return this.soundNodes.get(id);

    const props = feature.properties;
    const geomType = feature.geometry?.type || 'Point';
    const isPolygon = geomType === 'Polygon' || geomType === 'MultiPolygon';
    const polygonCoords = isPolygon ? feature.geometry.coordinates : null;
    const coords = isPolygon
      ? GeoEngine.getPolygonCentroid(feature.geometry.coordinates)
      : (feature.geometry?.coordinates || [115.8605, -31.9505]);

    const radius = props.spatialPlayback?.radiusMeters || (isPolygon ? 50 : 60);
    const rolloff = props.spatialPlayback?.rolloff || 'exponential';
    const synthType = props.synthType || (props.audio?.url ? null : (isPolygon ? 'water' : 'birdsong'));

    const channelFormat = props.audio?.channelFormat || props.channelFormat || 'stereo';
    const channels = props.audio?.channels || (channelFormat.includes('ambisonic') ? 4 : 2);
    const isAmbisonic = channelFormat.includes('ambisonic') || channels === 4;

    const sourceObj = {
      id,
      feature,
      coords,
      isPolygon,
      polygonCoords,
      radius,
      rolloff,
      synthType,
      channelFormat,
      channels,
      isAmbisonic,
      audioUrl: props.audio?.url,
      audioBlob: audioBlob,
      gainNode: null,
      pannerNode: null,
      ambisonicDecoder: null,
      sourceNode: null,
      audioElement: null,
      isPlaying: false,
      currentDistance: Infinity,
      currentGain: 0
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
    } else {
      // Standard Mono / Stereo Spatial Routing
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
        this.attachFileAudioSource(sound);
      } else {
        this.attachProceduralAudio(sound);
      }
    }

    sound.isPlaying = true;
  }

  /**
   * Attach an HTMLAudioElement streaming a Blob or URL (Stereo / Mono)
   */
  attachFileAudioSource(sound) {
    try {
      const audioEl = new Audio();
      audioEl.crossOrigin = 'anonymous';
      audioEl.loop = true;

      if (sound.audioBlob) {
        audioEl.src = URL.createObjectURL(sound.audioBlob);
      } else if (sound.audioUrl) {
        audioEl.src = sound.audioUrl;
      }

      audioEl.onerror = () => {
        // Silently fallback to procedural audio if audio file failed to load
        this.attachProceduralAudio(sound);
      };

      const mediaSource = this.ctx.createMediaElementSource(audioEl);
      mediaSource.connect(sound.gainNode);

      audioEl.play().catch(() => {
        this.attachProceduralAudio(sound);
      });

      sound.audioElement = audioEl;
      sound.sourceNode = mediaSource;
    } catch (e) {
      this.attachProceduralAudio(sound);
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
  attachProceduralAudio(sound) {
    const type = sound.synthType || 'birdsong';
    const ctx = this.ctx;

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
      filter.connect(sound.gainNode);

      osc.start();
      lfo.start();
      sound.sourceNode = osc;
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
      filter.connect(sound.gainNode);

      noiseSource.start();
      lfo.start();
      sound.sourceNode = noiseSource;
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
      filter.connect(sound.gainNode);

      noiseSource.start();
      lfo.start();
      sound.sourceNode = noiseSource;
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
      subGain.connect(sound.gainNode);

      osc1.start();
      osc2.start();
      sound.sourceNode = osc1;
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
    if (sound.gainNode) {
      sound.gainNode.disconnect();
    }
    if (sound.pannerNode) {
      sound.pannerNode.disconnect();
    }
    if (sound.ambisonicDecoder) {
      sound.ambisonicDecoder.disconnect();
    }

    if (this.activeAuditionId === id) {
      this.activeAuditionId = null;
    }

    this.soundNodes.delete(id);
    this.updateProximityMix();
  }

  /**
   * Updates coordinates of an existing sound source (e.g. when dragged on map)
   */
  updateSoundCoordinates(id, coords) {
    const sound = this.soundNodes.get(id);
    if (sound) {
      sound.coords = coords;
      if (sound.feature && sound.feature.geometry) {
        sound.feature.geometry.coordinates = coords;
      }
      this.updateProximityMix();
    }
  }

  /**
   * Updates an entire sound feature's properties and reconfigures routing if necessary
   */
  updateSoundSource(feature, newAudioBlob = null) {
    const id = feature.id;
    const existing = this.soundNodes.get(id);
    if (!existing) {
      return this.createSoundSource(feature, newAudioBlob);
    }

    const props = feature.properties;
    const coords = feature.geometry.coordinates;
    const radius = props.spatialPlayback?.radiusMeters || 60;
    const rolloff = props.spatialPlayback?.rolloff || 'exponential';
    const channelFormat = props.audio?.channelFormat || props.channelFormat || 'stereo';
    const channels = props.audio?.channels || (channelFormat.includes('ambisonic') ? 4 : 2);
    const isAmbisonic = channelFormat.includes('ambisonic') || channels === 4;
    const synthType = props.synthType || (props.audio?.url ? null : 'birdsong');

    const formatChanged = existing.isAmbisonic !== isAmbisonic || existing.channelFormat !== channelFormat;
    const audioFileChanged = newAudioBlob !== null || (props.audio?.url && props.audio.url !== existing.audioUrl);

    existing.feature = feature;
    existing.coords = coords;
    existing.radius = radius;
    existing.rolloff = rolloff;
    existing.synthType = synthType;
    existing.channelFormat = channelFormat;
    existing.channels = channels;
    existing.isAmbisonic = isAmbisonic;
    if (props.audio?.url) existing.audioUrl = props.audio.url;
    if (newAudioBlob) existing.audioBlob = newAudioBlob;

    if (formatChanged || audioFileChanged) {
      // Re-initialize audio graph if spatial format or audio asset changed
      const currentBlob = newAudioBlob || existing.audioBlob;
      this.removeSoundSource(id);
      this.createSoundSource(feature, currentBlob);
    } else {
      this.updateProximityMix();
    }
  }

  /**
   * Updates listener position and recalculates proximity attenuation and panning.
   */
  updateListenerPosition(coords, heading = null) {
    this.listenerPosition = coords;
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
          sound.currentGain = 1.0;
          if (sound.isAmbisonic && sound.ambisonicDecoder) {
            sound.ambisonicDecoder.setGain(1.0);
            sound.ambisonicDecoder.setRotation(0);
          } else if (sound.gainNode) {
            sound.gainNode.gain.setTargetAtTime(1.0, now, timeConstant);
            if (sound.pannerNode) sound.pannerNode.pan.setTargetAtTime(0, now, timeConstant);
          }
        } else {
          sound.currentGain = 0;
          if (sound.isAmbisonic && sound.ambisonicDecoder) {
            sound.ambisonicDecoder.setGain(0);
          } else if (sound.gainNode) {
            sound.gainNode.gain.setTargetAtTime(0, now, timeConstant);
          }
        }
        continue;
      }

      // Proximity Distance & Gain Calculation (Point Radius vs Polygon Habitat)
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
        const maxPanDist = sound.isPolygon ? 150 : (sound.radius * 1.5);
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
   * Set solo pin audition for Static Mode
   */
  setSoloAudition(soundId) {
    this.activeAuditionId = soundId;
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
