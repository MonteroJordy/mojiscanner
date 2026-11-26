/* Decodes camera frames off the main thread so the viewfinder stays smooth. */
/* global QRDecoder */
importScripts('qr-decoder.js');

var frame = 0;
self.onmessage = function (e) {
  var msg = e.data;
  frame++;
  var text = null;
  try {
    // Light-on-dark codes are rare, so only look for them on every other frame.
    var r = QRDecoder.decode({ data: new Uint8ClampedArray(msg.buffer), width: msg.width, height: msg.height }, { inverted: frame % 2 === 0, maxAttempts: 3 });
    text = r ? r.text : null;
  } catch (err) {
    text = null;
  }
  self.postMessage({ id: msg.id, text: text, buffer: msg.buffer }, [msg.buffer]);
};
