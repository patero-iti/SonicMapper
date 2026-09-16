/**
 * FOABinauralDecoder - First-Order Ambisonics (FOA) to Binaural Web Audio Engine
 *
 * Supports:
 * - AmbiX format (ACN channel ordering: W, Y, Z, X; SN3D normalization)
 * - FuMa format (Furse-Malham: W, X, Y, Z; MaxN normalization)
 * - Real-time soundfield yaw rotation matrix based on listener compass heading
 * - Virtual loudspeaker binaural decoding matrix paired with HRTF spatialization
 */
export class FOABinauralDecoder {
  /**
   * @param {AudioContext} ctx - Web Audio API context
   * @param {Object} options - Configuration options
   * @param {string} [options.format='ambix'] - 'ambix' or 'fuma'
   */
  constructor(ctx, options = {}) {
    this.ctx = ctx;
    this.format = options.format || 'ambix'; // 'ambix' (W, Y, Z, X) or 'fuma' (W, X, Y, Z)
    
    // Main input: 4-channel stream / buffer source connects here
    this.input = this.ctx.createGain();
    this.input.channelCount = 4;
    this.input.channelCountMode = 'explicit';
    this.input.channelInterpretation = 'discrete';

    // Output: 2-channel stereo binaural bus
    this.output = this.ctx.createGain();
    this.output.gain.setValueAtTime(1.0, this.ctx.currentTime);

    // Attenuation Gain Node
    this.gainNode = this.ctx.createGain();
    this.gainNode.gain.setValueAtTime(1.0, this.ctx.currentTime);

    // Channel Splitter (4 discrete channels)
    this.splitter = this.ctx.createChannelSplitter(4);
    this.input.connect(this.splitter);

    // 4 Canonical B-format buses: W, X, Y, Z
    this.busW = this.ctx.createGain();
    this.busX = this.ctx.createGain();
    this.busY = this.ctx.createGain();
    this.busZ = this.ctx.createGain();

    // Map input channels to Canonical B-format
    this.initFormatMapping();

    // Soundfield Rotation Matrix Nodes (Yaw / Compass Heading)
    this.initRotationMatrix();

    // Virtual Loudspeaker Binaural Array (Front-Left, Front-Right, Rear-Left, Rear-Right)
    this.initVirtualSpeakers();

    // Connect speaker sum to gain and output
    this.speakerMasterGain.connect(this.gainNode);
    this.gainNode.connect(this.output);

    this.currentYawDegrees = 0;
  }

  /**
   * Maps input channels according to AmbiX (ACN-SN3D) or FuMa (Furse-Malham)
   */
  initFormatMapping() {
    if (this.format === 'ambix') {
      // AmbiX (ACN / SN3D):
      // Ch 0: W (Omni)
      // Ch 1: Y (Left-Right dipole)
      // Ch 2: Z (Up-Down dipole)
      // Ch 3: X (Front-Back dipole)
      this.splitter.connect(this.busW, 0);
      this.splitter.connect(this.busY, 1);
      this.splitter.connect(this.busZ, 2);
      this.splitter.connect(this.busX, 3);
    } else {
      // FuMa (MaxN):
      // Ch 0: W (Gain * sqrt(2) to normalize with AmbiX)
      // Ch 1: X (Front-Back dipole)
      // Ch 2: Y (Left-Right dipole)
      // Ch 3: Z (Up-Down dipole)
      const wGain = this.ctx.createGain();
      wGain.gain.setValueAtTime(Math.SQRT2, this.ctx.currentTime);
      this.splitter.connect(wGain, 0);
      wGain.connect(this.busW);

      this.splitter.connect(this.busX, 1);
      this.splitter.connect(this.busY, 2);
      this.splitter.connect(this.busZ, 3);
    }
  }

  /**
   * Soundfield Rotation Matrix around Z-axis (Yaw / Heading)
   *
   * Equations:
   * W' = W
   * X' = X * cos(yaw) + Y * sin(yaw)
   * Y' = -X * sin(yaw) + Y * cos(yaw)
   * Z' = Z
   */
  initRotationMatrix() {
    // Rotated output buses
    this.rotW = this.ctx.createGain();
    this.rotX = this.ctx.createGain();
    this.rotY = this.ctx.createGain();
    this.rotZ = this.ctx.createGain();

    // W and Z pass through directly for horizontal rotation
    this.busW.connect(this.rotW);
    this.busZ.connect(this.rotZ);

    // Matrix Gain Nodes for X and Y
    this.gainXX = this.ctx.createGain(); // X -> X' (cos yaw)
    this.gainYX = this.ctx.createGain(); // Y -> X' (sin yaw)
    this.gainXY = this.ctx.createGain(); // X -> Y' (-sin yaw)
    this.gainYY = this.ctx.createGain(); // Y -> Y' (cos yaw)

    // Initial coefficients for yaw = 0 (cos = 1, sin = 0)
    this.gainXX.gain.setValueAtTime(1.0, this.ctx.currentTime);
    this.gainYX.gain.setValueAtTime(0.0, this.ctx.currentTime);
    this.gainXY.gain.setValueAtTime(0.0, this.ctx.currentTime);
    this.gainYY.gain.setValueAtTime(1.0, this.ctx.currentTime);

    this.busX.connect(this.gainXX);
    this.gainXX.connect(this.rotX);

    this.busY.connect(this.gainYX);
    this.gainYX.connect(this.rotX);

    this.busX.connect(this.gainXY);
    this.gainXY.connect(this.rotY);

    this.busY.connect(this.gainYY);
    this.gainYY.connect(this.rotY);
  }

  /**
   * Decodes Rotated FOA Soundfield into 4 Virtual Loudspeakers with Web Audio HRTF Panners
   *
   * Virtual Speaker Layout (Horizontal Plane):
   * 1. Front-Left  (FL:  +45° / +0.785 rad): S_FL = 0.5 * (W + (X + Y)/sqrt(2))
   * 2. Front-Right (FR:  -45° / -0.785 rad): S_FR = 0.5 * (W + (X - Y)/sqrt(2))
   * 3. Rear-Left   (RL: +135° / +2.356 rad): S_RL = 0.5 * (W + (-X + Y)/sqrt(2))
   * 4. Rear-Right  (RR: -135° / -2.356 rad): S_RR = 0.5 * (W + (-X - Y)/sqrt(2))
   */
  initVirtualSpeakers() {
    this.speakerMasterGain = this.ctx.createGain();
    this.speakerMasterGain.gain.setValueAtTime(0.75, this.ctx.currentTime);

    const speakers = [
      { name: 'FL', angle: 45, x: -1, y: 0, z: -1 },
      { name: 'FR', angle: -45, x: 1, y: 0, z: -1 },
      { name: 'RL', angle: 135, x: -1, y: 0, z: 1 },
      { name: 'RR', angle: -135, x: 1, y: 0, z: 1 }
    ];

    const invSqrt2 = 1 / Math.SQRT2;
    this.virtualSpeakers = [];

    speakers.forEach((spk) => {
      const sumNode = this.ctx.createGain();
      sumNode.gain.setValueAtTime(0.5, this.ctx.currentTime);

      // Connect W
      this.rotW.connect(sumNode);

      // Connect X and Y with directivity factors
      const rad = (spk.angle * Math.PI) / 180;
      const xFactor = Math.cos(rad) * invSqrt2;
      const yFactor = Math.sin(rad) * invSqrt2;

      const gainX = this.ctx.createGain();
      gainX.gain.setValueAtTime(xFactor, this.ctx.currentTime);
      this.rotX.connect(gainX);
      gainX.connect(sumNode);

      const gainY = this.ctx.createGain();
      gainY.gain.setValueAtTime(yFactor, this.ctx.currentTime);
      this.rotY.connect(gainY);
      gainY.connect(sumNode);

      // HRTF 3D Panner for Binaural Positioning
      const panner = this.ctx.createPanner();
      panner.panningModel = 'HRTF';
      panner.distanceModel = 'inverse';
      panner.refDistance = 1;
      panner.maxDistance = 10000;
      panner.rolloffFactor = 0; // Fixed virtual speaker distance
      panner.coneInnerAngle = 360;

      // Position virtual speaker relative to listener head
      if (panner.positionX) {
        panner.positionX.setValueAtTime(spk.x, this.ctx.currentTime);
        panner.positionY.setValueAtTime(spk.y, this.ctx.currentTime);
        panner.positionZ.setValueAtTime(spk.z, this.ctx.currentTime);
      } else {
        panner.setPosition(spk.x, spk.y, spk.z);
      }

      sumNode.connect(panner);
      panner.connect(this.speakerMasterGain);

      this.virtualSpeakers.push({
        name: spk.name,
        sumNode,
        panner
      });
    });
  }

  /**
   * Updates soundfield yaw rotation in real time (e.g. from compass heading / GPS bearing)
   * @param {number} yawDegrees - Rotation angle in degrees
   */
  setRotation(yawDegrees) {
    this.currentYawDegrees = yawDegrees;
    const rad = (yawDegrees * Math.PI) / 180;
    const cosY = Math.cos(rad);
    const sinY = Math.sin(rad);

    const now = this.ctx.currentTime;
    const timeConstant = 0.05;

    this.gainXX.gain.setTargetAtTime(cosY, now, timeConstant);
    this.gainYX.gain.setTargetAtTime(sinY, now, timeConstant);
    this.gainXY.gain.setTargetAtTime(-sinY, now, timeConstant);
    this.gainYY.gain.setTargetAtTime(cosY, now, timeConstant);
  }

  /**
   * Sets attenuation gain (e.g. distance rolloff)
   * @param {number} gain - 0.0 to 1.0
   */
  setGain(gain) {
    const now = this.ctx.currentTime;
    this.gainNode.gain.setTargetAtTime(Math.max(0, gain), now, 0.05);
  }

  /**
   * Disconnects and cleans up all audio graph nodes
   */
  disconnect() {
    try {
      this.input.disconnect();
      this.splitter.disconnect();
      this.busW.disconnect();
      this.busX.disconnect();
      this.busY.disconnect();
      this.busZ.disconnect();
      this.rotW.disconnect();
      this.rotX.disconnect();
      this.rotY.disconnect();
      this.rotZ.disconnect();
      this.gainXX.disconnect();
      this.gainYX.disconnect();
      this.gainXY.disconnect();
      this.gainYY.disconnect();
      this.virtualSpeakers.forEach((spk) => {
        spk.sumNode.disconnect();
        spk.panner.disconnect();
      });
      this.speakerMasterGain.disconnect();
      this.gainNode.disconnect();
      this.output.disconnect();
    } catch (e) {
      console.warn('Error disconnecting FOABinauralDecoder:', e);
    }
  }
}
