/*
 * Camera + decoding. Uses the phone's built-in BarcodeDetector when it has one (Android Chrome), otherwise the
 * bundled decoder in a Web Worker (iPhone, desktop). Also listens for handheld/Bluetooth scanners, which type
 * the code followed by Enter.
 */
(function (root) {
  'use strict';

  var MAX_SIDE = 720;    // pixels sent to the decoder (center crop, downscaled)
  var CROP = 0.9;        // share of the shorter video side that is decoded

  function DoorScanner(video, onCode, onStatus) {
    this.video = video;
    this.onCode = onCode;
    this.onStatus = onStatus || function () {};
    this.stream = null;
    this.track = null;
    this.detector = null;
    this.worker = null;
    this.workerBusy = false;
    this.paused = false;
    this.running = false;
    this.canvas = document.createElement('canvas');
    this.ctx = this.canvas.getContext('2d', { willReadFrequently: true });
    this.deviceId = null;
    this.lastDetect = 0;
    this.frameId = 0;
    this.torchOn = false;
  }

  DoorScanner.prototype.start = async function (deviceId) {
    this.stopCamera();
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      throw new Error(location.protocol === 'https:' || location.hostname === 'localhost'
        ? 'This browser has no camera access.'
        : 'The camera only works over https://. Open the secure address of this app.');
    }
    var video = deviceId
      ? { deviceId: { exact: deviceId }, width: { ideal: 1280 }, height: { ideal: 720 } }
      : { facingMode: { ideal: 'environment' }, width: { ideal: 1280 }, height: { ideal: 720 } };
    this.stream = await navigator.mediaDevices.getUserMedia({ audio: false, video: video });
    this.track = this.stream.getVideoTracks()[0];
    var settings = this.track.getSettings ? this.track.getSettings() : {};
    this.deviceId = settings.deviceId || deviceId || null;
    this.video.srcObject = this.stream;
    this.video.setAttribute('playsinline', '');
    await this.video.play().catch(function () { /* autoplay will start it */ });

    if (!this.detector && 'BarcodeDetector' in root) {
      try {
        var formats = await root.BarcodeDetector.getSupportedFormats();
        if (formats.indexOf('qr_code') !== -1) this.detector = new root.BarcodeDetector({ formats: ['qr_code'] });
      } catch (e) { this.detector = null; }
    }
    if (!this.detector && !this.worker) {
      var self = this;
      this.worker = new Worker('/js/qr-worker.js');
      this.worker.onmessage = function (e) {
        self.workerBusy = false;
        if (e.data && e.data.text && !self.paused) self.onCode(e.data.text, 'camera');
      };
      this.worker.onerror = function () { self.workerBusy = false; };
    }
    this.running = true;
    this.gen = (this.gen || 0) + 1;
    this.loop(this.gen);
    return { torch: this.hasTorch(), engine: this.detector ? 'native' : 'built-in' };
  };

  DoorScanner.prototype.loop = function (gen) {
    var self = this;
    if (!this.running || gen !== this.gen) return; // a newer camera session took over
    root.requestAnimationFrame(function () {
      if (gen !== self.gen) return;
      self.tick();
      self.loop(gen);
    });
  };

  DoorScanner.prototype.tick = function () {
    var v = this.video;
    if (this.paused || !v.videoWidth || v.readyState < 2) return;
    var now = performance.now();
    if (this.detector) {
      if (now - this.lastDetect < 90 || this.detecting) return;
      this.lastDetect = now;
      this.detecting = true;
      var self = this;
      this.detector.detect(v).then(function (codes) {
        self.detecting = false;
        if (codes && codes.length && codes[0].rawValue && !self.paused) self.onCode(codes[0].rawValue, 'camera');
      }).catch(function () { self.detecting = false; });
      return;
    }
    if (this.workerBusy) return;
    var side = Math.floor(Math.min(v.videoWidth, v.videoHeight) * CROP);
    var sx = Math.floor((v.videoWidth - side) / 2);
    var sy = Math.floor((v.videoHeight - side) / 2);
    var out = Math.min(side, MAX_SIDE);
    if (this.canvas.width !== out) { this.canvas.width = out; this.canvas.height = out; }
    this.ctx.drawImage(v, sx, sy, side, side, 0, 0, out, out);
    var img = this.ctx.getImageData(0, 0, out, out);
    this.workerBusy = true;
    this.worker.postMessage({ id: ++this.frameId, width: out, height: out, buffer: img.data.buffer }, [img.data.buffer]);
  };

  DoorScanner.prototype.pause = function () { this.paused = true; };
  DoorScanner.prototype.resume = function () { this.paused = false; };

  DoorScanner.prototype.stopCamera = function () {
    this.running = false;
    if (this.stream) this.stream.getTracks().forEach(function (t) { t.stop(); });
    this.stream = null;
    this.track = null;
    this.torchOn = false;
    if (this.video) this.video.srcObject = null;
  };

  DoorScanner.prototype.hasTorch = function () {
    try {
      var caps = this.track && this.track.getCapabilities ? this.track.getCapabilities() : null;
      return !!(caps && caps.torch);
    } catch (e) { return false; }
  };

  DoorScanner.prototype.toggleTorch = async function () {
    if (!this.track) return false;
    this.torchOn = !this.torchOn;
    try { await this.track.applyConstraints({ advanced: [{ torch: this.torchOn }] }); } catch (e) { this.torchOn = false; }
    return this.torchOn;
  };

  /** Cycles to the next camera (front/back/external). */
  DoorScanner.prototype.nextCamera = async function () {
    var devices = (await navigator.mediaDevices.enumerateDevices()).filter(function (d) { return d.kind === 'videoinput'; });
    if (devices.length < 2) return null;
    var idx = devices.findIndex(function (d) { return d.deviceId === this.deviceId; }, this);
    var next = devices[(idx + 1) % devices.length];
    return this.start(next.deviceId);
  };

  /**
   * Handheld scanners act like a keyboard: they type the code fast and press Enter.
   * Typing by a person is slower, so we only accept bursts (< 60 ms between keys on average).
   */
  function listenForHardwareScanner(onCode) {
    var buffer = '';
    var times = [];
    var last = 0;
    root.addEventListener('keydown', function (e) {
      var t = e.target;
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable)) return;
      var now = performance.now();
      if (now - last > 300) { buffer = ''; times = []; }
      last = now;
      if (e.key === 'Enter') {
        if (buffer.length >= 3) {
          var span = times.length > 1 ? (times[times.length - 1] - times[0]) / (times.length - 1) : 0;
          if (span < 60) { e.preventDefault(); onCode(buffer, 'scanner'); }
        }
        buffer = ''; times = [];
        return;
      }
      if (e.key && e.key.length === 1) { buffer += e.key; times.push(now); }
    });
  }

  root.DoorScanner = DoorScanner;
  root.listenForHardwareScanner = listenForHardwareScanner;
})(typeof window !== 'undefined' ? window : this);
