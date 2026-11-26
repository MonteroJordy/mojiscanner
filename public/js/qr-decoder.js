/*
 * Self-contained QR code decoder (no dependencies), so the door app works offline from the first load and on
 * iPhones, which have no built-in BarcodeDetector. Structure follows the ZXing reader:
 *   luminance -> hybrid binarizer -> finder patterns -> alignment pattern -> perspective sampling ->
 *   format/version info -> unmask -> codewords -> Reed-Solomon -> bit stream.
 *
 * Usage: QRDecoder.decode({ data: Uint8ClampedArray RGBA, width, height }) -> { text, version, ecLevel } | null
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.QRDecoder = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  function NotFound() { this.name = 'NotFound'; }

  // ---------------------------------------------------------------- bit matrix

  function BitMatrix(width, height) {
    this.width = width;
    this.height = height;
    this.data = new Uint8Array(width * height);
  }
  BitMatrix.prototype.get = function (x, y) { return this.data[y * this.width + x] === 1; };
  BitMatrix.prototype.set = function (x, y) { this.data[y * this.width + x] = 1; };
  BitMatrix.prototype.flip = function (x, y) { var i = y * this.width + x; this.data[i] = this.data[i] ? 0 : 1; };
  BitMatrix.prototype.setRegion = function (left, top, w, h) {
    for (var y = top; y < top + h; y++) for (var x = left; x < left + w; x++) this.data[y * this.width + x] = 1;
  };
  BitMatrix.prototype.clone = function () {
    var m = new BitMatrix(this.width, this.height);
    m.data.set(this.data);
    return m;
  };

  // ---------------------------------------------------------------- binarizer

  function toLuminance(rgba, width, height) {
    var out = new Uint8Array(width * height);
    for (var i = 0, j = 0; i < out.length; i++, j += 4) out[i] = (rgba[j] * 77 + rgba[j + 1] * 150 + rgba[j + 2] * 29) >> 8;
    return out;
  }

  /** Local-threshold binarizer (ZXing HybridBinarizer): copes with shadows, glare and uneven phone screens. */
  function binarize(lum, width, height) {
    var B = 8;
    var matrix = new BitMatrix(width, height);
    if (width < 5 * B || height < 5 * B) {
      var sum = 0;
      for (var k = 0; k < lum.length; k++) sum += lum[k];
      var t = sum / lum.length;
      for (k = 0; k < lum.length; k++) if (lum[k] <= t) matrix.data[k] = 1;
      return matrix;
    }
    var subW = Math.ceil(width / B);
    var subH = Math.ceil(height / B);
    var black = new Float32Array(subW * subH);
    var maxX = width - B;
    var maxY = height - B;
    for (var by = 0; by < subH; by++) {
      var yoff = Math.min(by * B, maxY);
      for (var bx = 0; bx < subW; bx++) {
        var xoff = Math.min(bx * B, maxX);
        var s = 0, min = 255, max = 0;
        for (var yy = 0; yy < B; yy++) {
          var off = (yoff + yy) * width + xoff;
          for (var xx = 0; xx < B; xx++) {
            var p = lum[off + xx];
            s += p;
            if (p < min) min = p;
            if (p > max) max = p;
          }
        }
        var avg = s / 64;
        if (max - min <= 24) {
          // Flat block: assume it's background unless the neighbours say this area is dark.
          avg = min / 2;
          if (by > 0 && bx > 0) {
            var nb = (black[(by - 1) * subW + bx] + 2 * black[by * subW + bx - 1] + black[(by - 1) * subW + bx - 1]) / 4;
            if (min < nb) avg = nb;
          }
        }
        black[by * subW + bx] = avg;
      }
    }
    for (by = 0; by < subH; by++) {
      yoff = Math.min(by * B, maxY);
      var top = Math.max(2, Math.min(by, subH - 3));
      for (bx = 0; bx < subW; bx++) {
        xoff = Math.min(bx * B, maxX);
        var left = Math.max(2, Math.min(bx, subW - 3));
        var total = 0;
        for (var z = -2; z <= 2; z++) {
          var row = (top + z) * subW + left;
          total += black[row - 2] + black[row - 1] + black[row] + black[row + 1] + black[row + 2];
        }
        var threshold = total / 25;
        for (yy = 0; yy < B; yy++) {
          off = (yoff + yy) * width + xoff;
          for (xx = 0; xx < B; xx++) if (lum[off + xx] <= threshold) matrix.data[off + xx] = 1;
        }
      }
    }
    return matrix;
  }

  // ---------------------------------------------------------------- finder patterns

  function foundPatternCross(sc) {
    var total = 0;
    for (var i = 0; i < 5; i++) { if (sc[i] === 0) return false; total += sc[i]; }
    if (total < 7) return false;
    var m = total / 7;
    var v = m / 2;
    return Math.abs(m - sc[0]) < v && Math.abs(m - sc[1]) < v && Math.abs(3 * m - sc[2]) < 3 * v &&
      Math.abs(m - sc[3]) < v && Math.abs(m - sc[4]) < v;
  }

  function foundPatternDiagonal(sc) {
    var total = 0;
    for (var i = 0; i < 5; i++) { if (sc[i] === 0) return false; total += sc[i]; }
    if (total < 7) return false;
    var m = total / 7;
    var v = m / 1.333;
    return Math.abs(m - sc[0]) < v && Math.abs(m - sc[1]) < v && Math.abs(3 * m - sc[2]) < 3 * v &&
      Math.abs(m - sc[3]) < v && Math.abs(m - sc[4]) < v;
  }

  function centerFromEnd(sc, end) { return end - sc[4] - sc[3] - sc[2] / 2; }

  function crossCheckVertical(img, startI, centerJ, maxCount, originalTotal) {
    var maxI = img.height;
    var sc = [0, 0, 0, 0, 0];
    var i = startI;
    while (i >= 0 && img.get(centerJ, i)) { sc[2]++; i--; }
    if (i < 0) return NaN;
    while (i >= 0 && !img.get(centerJ, i) && sc[1] <= maxCount) { sc[1]++; i--; }
    if (i < 0 || sc[1] > maxCount) return NaN;
    while (i >= 0 && img.get(centerJ, i) && sc[0] <= maxCount) { sc[0]++; i--; }
    if (sc[0] > maxCount) return NaN;
    i = startI + 1;
    while (i < maxI && img.get(centerJ, i)) { sc[2]++; i++; }
    if (i === maxI) return NaN;
    while (i < maxI && !img.get(centerJ, i) && sc[3] < maxCount) { sc[3]++; i++; }
    if (i === maxI || sc[3] >= maxCount) return NaN;
    while (i < maxI && img.get(centerJ, i) && sc[4] < maxCount) { sc[4]++; i++; }
    if (sc[4] >= maxCount) return NaN;
    var total = sc[0] + sc[1] + sc[2] + sc[3] + sc[4];
    if (5 * Math.abs(total - originalTotal) >= 2 * originalTotal) return NaN;
    return foundPatternCross(sc) ? centerFromEnd(sc, i) : NaN;
  }

  function crossCheckHorizontal(img, startJ, centerI, maxCount, originalTotal) {
    var maxJ = img.width;
    var sc = [0, 0, 0, 0, 0];
    var j = startJ;
    while (j >= 0 && img.get(j, centerI)) { sc[2]++; j--; }
    if (j < 0) return NaN;
    while (j >= 0 && !img.get(j, centerI) && sc[1] <= maxCount) { sc[1]++; j--; }
    if (j < 0 || sc[1] > maxCount) return NaN;
    while (j >= 0 && img.get(j, centerI) && sc[0] <= maxCount) { sc[0]++; j--; }
    if (sc[0] > maxCount) return NaN;
    j = startJ + 1;
    while (j < maxJ && img.get(j, centerI)) { sc[2]++; j++; }
    if (j === maxJ) return NaN;
    while (j < maxJ && !img.get(j, centerI) && sc[3] < maxCount) { sc[3]++; j++; }
    if (j === maxJ || sc[3] >= maxCount) return NaN;
    while (j < maxJ && img.get(j, centerI) && sc[4] < maxCount) { sc[4]++; j++; }
    if (sc[4] >= maxCount) return NaN;
    var total = sc[0] + sc[1] + sc[2] + sc[3] + sc[4];
    if (5 * Math.abs(total - originalTotal) >= originalTotal) return NaN;
    return foundPatternCross(sc) ? centerFromEnd(sc, j) : NaN;
  }

  function crossCheckDiagonal(img, centerI, centerJ) {
    var sc = [0, 0, 0, 0, 0];
    var i = 0;
    while (centerI >= i && centerJ >= i && img.get(centerJ - i, centerI - i)) { sc[2]++; i++; }
    if (sc[2] === 0) return false;
    while (centerI >= i && centerJ >= i && !img.get(centerJ - i, centerI - i)) { sc[1]++; i++; }
    if (sc[1] === 0) return false;
    while (centerI >= i && centerJ >= i && img.get(centerJ - i, centerI - i)) { sc[0]++; i++; }
    if (sc[0] === 0) return false;
    var maxI = img.height, maxJ = img.width;
    i = 1;
    while (centerI + i < maxI && centerJ + i < maxJ && img.get(centerJ + i, centerI + i)) { sc[2]++; i++; }
    while (centerI + i < maxI && centerJ + i < maxJ && !img.get(centerJ + i, centerI + i)) { sc[3]++; i++; }
    if (sc[3] === 0) return false;
    while (centerI + i < maxI && centerJ + i < maxJ && img.get(centerJ + i, centerI + i)) { sc[4]++; i++; }
    if (sc[4] === 0) return false;
    return foundPatternDiagonal(sc);
  }

  function handlePossibleCenter(img, sc, i, j, centers) {
    var total = sc[0] + sc[1] + sc[2] + sc[3] + sc[4];
    var centerJ = centerFromEnd(sc, j);
    var centerI = crossCheckVertical(img, i, Math.floor(centerJ), sc[2], total);
    if (isNaN(centerI)) return false;
    centerJ = crossCheckHorizontal(img, Math.floor(centerJ), Math.floor(centerI), sc[2], total);
    if (isNaN(centerJ) || !crossCheckDiagonal(img, Math.floor(centerI), Math.floor(centerJ))) return false;
    var size = total / 7;
    for (var k = 0; k < centers.length; k++) {
      var c = centers[k];
      if (Math.abs(centerI - c.y) <= size && Math.abs(centerJ - c.x) <= size) {
        var diff = Math.abs(size - c.size);
        if (diff <= 1 || diff <= c.size) {
          var n = c.count + 1;
          centers[k] = { x: (c.count * c.x + centerJ) / n, y: (c.count * c.y + centerI) / n, size: (c.count * c.size + size) / n, count: n };
          return true;
        }
      }
    }
    centers.push({ x: centerJ, y: centerI, size: size, count: 1 });
    return true;
  }

  function findFinderPatterns(img) {
    var maxI = img.height, maxJ = img.width;
    var centers = [];
    var iSkip = 2;
    var sc = [0, 0, 0, 0, 0];
    for (var i = iSkip - 1; i < maxI; i += iSkip) {
      sc[0] = sc[1] = sc[2] = sc[3] = sc[4] = 0;
      var state = 0;
      for (var j = 0; j < maxJ; j++) {
        if (img.get(j, i)) {
          if ((state & 1) === 1) state++;
          sc[state]++;
        } else if ((state & 1) === 0) {
          if (state === 4) {
            if (foundPatternCross(sc) && handlePossibleCenter(img, sc, i, j, centers)) {
              state = 0;
              sc[0] = sc[1] = sc[2] = sc[3] = sc[4] = 0;
            } else {
              sc[0] = sc[2]; sc[1] = sc[3]; sc[2] = sc[4]; sc[3] = 1; sc[4] = 0;
              state = 3;
            }
          } else {
            sc[++state]++;
          }
        } else {
          sc[state]++;
        }
      }
      if (foundPatternCross(sc)) handlePossibleCenter(img, sc, i, maxJ, centers);
    }
    return centers;
  }

  function dist(a, b) { var dx = a.x - b.x, dy = a.y - b.y; return Math.sqrt(dx * dx + dy * dy); }
  function sqDist(a, b) { var dx = a.x - b.x, dy = a.y - b.y; return dx * dx + dy * dy; }

  /** All plausible triples of finder patterns, best (closest to an isosceles right triangle) first. */
  function rankTriples(centers) {
    var list = centers.slice().sort(function (a, b) { return b.count - a.count; }).slice(0, 16);
    list.sort(function (a, b) { return a.size - b.size; });
    var out = [];
    for (var i = 0; i < list.length - 2; i++) {
      for (var j = i + 1; j < list.length - 1; j++) {
        for (var k = j + 1; k < list.length; k++) {
          var A = list[i], Bp = list[j], C = list[k];
          if (C.size > A.size * 1.4) continue;
          var d = [sqDist(A, Bp), sqDist(Bp, C), sqDist(A, C)].sort(function (x, y) { return x - y; });
          var distortion = (Math.abs(d[2] - 2 * d[1]) + Math.abs(d[2] - 2 * d[0])) / d[2];
          if (distortion > 1) continue;
          out.push({ points: [A, Bp, C], distortion: distortion });
        }
      }
    }
    out.sort(function (a, b) { return a.distortion - b.distortion; });
    return out;
  }

  /** Orders points as [bottomLeft, topLeft, topRight]. */
  function orderPatterns(p) {
    var d01 = dist(p[0], p[1]), d12 = dist(p[1], p[2]), d02 = dist(p[0], p[2]);
    var A, Bp, C;
    if (d12 >= d01 && d12 >= d02) { Bp = p[0]; A = p[1]; C = p[2]; }
    else if (d02 >= d12 && d02 >= d01) { Bp = p[1]; A = p[0]; C = p[2]; }
    else { Bp = p[2]; A = p[0]; C = p[1]; }
    if (((C.x - Bp.x) * (A.y - Bp.y)) - ((C.y - Bp.y) * (A.x - Bp.x)) < 0) { var t = A; A = C; C = t; }
    return { bottomLeft: A, topLeft: Bp, topRight: C };
  }

  // ---------------------------------------------------------------- detector

  function sizeOfBlackWhiteBlackRun(img, fromX, fromY, toX, toY) {
    var steep = Math.abs(toY - fromY) > Math.abs(toX - fromX);
    var t;
    if (steep) { t = fromX; fromX = fromY; fromY = t; t = toX; toX = toY; toY = t; }
    var dx = Math.abs(toX - fromX), dy = Math.abs(toY - fromY);
    var error = -dx / 2;
    var xstep = fromX < toX ? 1 : -1, ystep = fromY < toY ? 1 : -1;
    var state = 0;
    var xLimit = toX + xstep;
    for (var x = fromX, y = fromY; x !== xLimit; x += xstep) {
      var realX = steep ? y : x, realY = steep ? x : y;
      if ((state === 1) === img.get(realX, realY)) {
        if (state === 2) return Math.sqrt((x - fromX) * (x - fromX) + (y - fromY) * (y - fromY));
        state++;
      }
      error += dy;
      if (error > 0) {
        if (y === toY) break;
        y += ystep;
        error -= dx;
      }
    }
    if (state === 2) return Math.sqrt((toX + xstep - fromX) * (toX + xstep - fromX) + (toY - fromY) * (toY - fromY));
    return NaN;
  }

  function sizeOfBlackWhiteBlackRunBothWays(img, fromX, fromY, toX, toY) {
    var result = sizeOfBlackWhiteBlackRun(img, fromX, fromY, toX, toY);
    var scale = 1;
    var otherToX = fromX - (toX - fromX);
    if (otherToX < 0) { scale = fromX / (fromX - otherToX); otherToX = 0; }
    else if (otherToX >= img.width) { scale = (img.width - 1 - fromX) / (otherToX - fromX); otherToX = img.width - 1; }
    var otherToY = Math.floor(fromY - (toY - fromY) * scale);
    scale = 1;
    if (otherToY < 0) { scale = fromY / (fromY - otherToY); otherToY = 0; }
    else if (otherToY >= img.height) { scale = (img.height - 1 - fromY) / (otherToY - fromY); otherToY = img.height - 1; }
    otherToX = Math.floor(fromX + (otherToX - fromX) * scale);
    result += sizeOfBlackWhiteBlackRun(img, fromX, fromY, otherToX, otherToY);
    return result - 1;
  }

  function moduleSizeOneWay(img, a, b) {
    var e1 = sizeOfBlackWhiteBlackRunBothWays(img, Math.floor(a.x), Math.floor(a.y), Math.floor(b.x), Math.floor(b.y));
    var e2 = sizeOfBlackWhiteBlackRunBothWays(img, Math.floor(b.x), Math.floor(b.y), Math.floor(a.x), Math.floor(a.y));
    if (isNaN(e1)) return e2 / 7;
    if (isNaN(e2)) return e1 / 7;
    return (e1 + e2) / 14;
  }

  function computeDimension(tl, tr, bl, moduleSize) {
    var a = Math.round(dist(tl, tr) / moduleSize);
    var b = Math.round(dist(tl, bl) / moduleSize);
    var dimension = Math.floor((a + b) / 2) + 7;
    switch (dimension & 3) {
      case 0: dimension++; break;
      case 2: dimension--; break;
      case 3: throw new NotFound();
    }
    return dimension;
  }

  function findAlignment(img, moduleSize, estX, estY, factor) {
    var allowance = Math.floor(factor * moduleSize);
    var leftX = Math.max(0, estX - allowance);
    var rightX = Math.min(img.width - 1, estX + allowance);
    if (rightX - leftX < moduleSize * 3) return null;
    var topY = Math.max(0, estY - allowance);
    var bottomY = Math.min(img.height - 1, estY + allowance);
    if (bottomY - topY < moduleSize * 3) return null;
    var width = rightX - leftX, height = bottomY - topY;
    var maxJ = leftX + width;
    var middleI = topY + Math.floor(height / 2);
    var possible = [];

    function cross(sc) {
      var v = moduleSize / 2;
      for (var q = 0; q < 3; q++) if (Math.abs(moduleSize - sc[q]) >= v) return false;
      return true;
    }
    function centerEnd(sc, end) { return end - sc[2] - sc[1] / 2; }
    function checkVertical(startI, centerJ, maxCount, originalTotal) {
      var sc = [0, 0, 0];
      var i = startI;
      while (i >= 0 && img.get(centerJ, i) && sc[1] <= maxCount) { sc[1]++; i--; }
      if (i < 0 || sc[1] > maxCount) return NaN;
      while (i >= 0 && !img.get(centerJ, i) && sc[0] <= maxCount) { sc[0]++; i--; }
      if (sc[0] > maxCount) return NaN;
      i = startI + 1;
      while (i < img.height && img.get(centerJ, i) && sc[1] <= maxCount) { sc[1]++; i++; }
      if (i === img.height || sc[1] > maxCount) return NaN;
      while (i < img.height && !img.get(centerJ, i) && sc[2] <= maxCount) { sc[2]++; i++; }
      if (sc[2] > maxCount) return NaN;
      var total = sc[0] + sc[1] + sc[2];
      if (5 * Math.abs(total - originalTotal) >= 2 * originalTotal) return NaN;
      return cross(sc) ? centerEnd(sc, i) : NaN;
    }
    function handle(sc, i, j) {
      var total = sc[0] + sc[1] + sc[2];
      var centerJ = centerEnd(sc, j);
      var centerI = checkVertical(i, Math.floor(centerJ), 2 * sc[1], total);
      if (isNaN(centerI)) return null;
      var size = total / 3;
      for (var k = 0; k < possible.length; k++) {
        var c = possible[k];
        if (Math.abs(centerI - c.y) <= size && Math.abs(centerJ - c.x) <= size) {
          var diff = Math.abs(size - c.size);
          if (diff <= 1 || diff <= c.size) return { x: (c.x + centerJ) / 2, y: (c.y + centerI) / 2, size: (c.size + size) / 2 };
        }
      }
      possible.push({ x: centerJ, y: centerI, size: size });
      return null;
    }

    for (var iGen = 0; iGen < height; iGen++) {
      var i = middleI + ((iGen & 1) === 0 ? (iGen + 1) >> 1 : -((iGen + 1) >> 1));
      if (i < 0 || i >= img.height) continue;
      var sc = [0, 0, 0];
      var j = leftX;
      while (j < maxJ && !img.get(j, i)) j++;
      var state = 0;
      while (j < maxJ) {
        if (img.get(j, i)) {
          if (state === 1) sc[1]++;
          else if (state === 2) {
            if (cross(sc)) { var confirmed = handle(sc, i, j); if (confirmed) return confirmed; }
            sc[0] = sc[2]; sc[1] = 1; sc[2] = 0; state = 1;
          } else sc[++state]++;
        } else {
          if (state === 1) state++;
          sc[state]++;
        }
        j++;
      }
      if (cross(sc)) { var c2 = handle(sc, i, maxJ); if (c2) return c2; }
    }
    return possible.length ? possible[0] : null;
  }

  // Perspective transform, as in ZXing (a11 a21 a31 / a12 a22 a32 / a13 a23 a33).
  function Transform(a11, a21, a31, a12, a22, a32, a13, a23, a33) {
    this.a11 = a11; this.a21 = a21; this.a31 = a31; this.a12 = a12; this.a22 = a22; this.a32 = a32; this.a13 = a13; this.a23 = a23; this.a33 = a33;
  }
  Transform.squareToQuad = function (x0, y0, x1, y1, x2, y2, x3, y3) {
    var dx3 = x0 - x1 + x2 - x3, dy3 = y0 - y1 + y2 - y3;
    if (dx3 === 0 && dy3 === 0) return new Transform(x1 - x0, x2 - x1, x0, y1 - y0, y2 - y1, y0, 0, 0, 1);
    var dx1 = x1 - x2, dx2 = x3 - x2, dy1 = y1 - y2, dy2 = y3 - y2;
    var den = dx1 * dy2 - dx2 * dy1;
    var a13 = (dx3 * dy2 - dx2 * dy3) / den;
    var a23 = (dx1 * dy3 - dx3 * dy1) / den;
    return new Transform(x1 - x0 + a13 * x1, x3 - x0 + a23 * x3, x0, y1 - y0 + a13 * y1, y3 - y0 + a23 * y3, y0, a13, a23, 1);
  };
  Transform.prototype.adjoint = function () {
    var t = this;
    return new Transform(
      t.a22 * t.a33 - t.a23 * t.a32, t.a23 * t.a31 - t.a21 * t.a33, t.a21 * t.a32 - t.a22 * t.a31,
      t.a13 * t.a32 - t.a12 * t.a33, t.a11 * t.a33 - t.a13 * t.a31, t.a12 * t.a31 - t.a11 * t.a32,
      t.a12 * t.a23 - t.a13 * t.a22, t.a13 * t.a21 - t.a11 * t.a23, t.a11 * t.a22 - t.a12 * t.a21);
  };
  Transform.prototype.times = function (o) {
    var t = this;
    return new Transform(
      t.a11 * o.a11 + t.a21 * o.a12 + t.a31 * o.a13, t.a11 * o.a21 + t.a21 * o.a22 + t.a31 * o.a23, t.a11 * o.a31 + t.a21 * o.a32 + t.a31 * o.a33,
      t.a12 * o.a11 + t.a22 * o.a12 + t.a32 * o.a13, t.a12 * o.a21 + t.a22 * o.a22 + t.a32 * o.a23, t.a12 * o.a31 + t.a22 * o.a32 + t.a32 * o.a33,
      t.a13 * o.a11 + t.a23 * o.a12 + t.a33 * o.a13, t.a13 * o.a21 + t.a23 * o.a22 + t.a33 * o.a23, t.a13 * o.a31 + t.a23 * o.a32 + t.a33 * o.a33);
  };
  Transform.quadToQuad = function (x0, y0, x1, y1, x2, y2, x3, y3, x0p, y0p, x1p, y1p, x2p, y2p, x3p, y3p) {
    var qToS = Transform.squareToQuad(x0, y0, x1, y1, x2, y2, x3, y3).adjoint();
    var sToQ = Transform.squareToQuad(x0p, y0p, x1p, y1p, x2p, y2p, x3p, y3p);
    return sToQ.times(qToS);
  };

  function sampleGrid(img, transform, dimension) {
    var bits = new BitMatrix(dimension, dimension);
    var t = transform;
    for (var y = 0; y < dimension; y++) {
      var iv = y + 0.5;
      for (var x = 0; x < dimension; x++) {
        var xv = x + 0.5;
        var den = t.a13 * xv + t.a23 * iv + t.a33;
        var px = (t.a11 * xv + t.a21 * iv + t.a31) / den;
        var py = (t.a12 * xv + t.a22 * iv + t.a32) / den;
        var ix = Math.floor(px), iy = Math.floor(py);
        if (ix < -1 || iy < -1 || ix > img.width || iy > img.height || isNaN(px) || isNaN(py)) throw new NotFound();
        if (ix < 0) ix = 0; else if (ix >= img.width) ix = img.width - 1;
        if (iy < 0) iy = 0; else if (iy >= img.height) iy = img.height - 1;
        if (img.get(ix, iy)) bits.set(x, y);
      }
    }
    return bits;
  }

  // Where to look for the bottom-right corner when there is no alignment pattern to pin it down (version 1, or
  // one we couldn't find). The parallelogram guess is wrong when the phone is tilted, so we nudge it by up to two
  // modules each way; Reed-Solomon tells us when the grid is right.
  var CORNER_OFFSETS = (function () {
    var steps = [0, -0.5, 0.5, -1, 1, -1.5, 1.5, -2, 2];
    var out = [];
    for (var a = 0; a < steps.length; a++) for (var b = 0; b < steps.length; b++) out.push([steps[a], steps[b]]);
    out.sort(function (p, q) { return (Math.abs(p[0]) + Math.abs(p[1])) - (Math.abs(q[0]) + Math.abs(q[1])); });
    return out;
  })();

  /** Returns the grid size and a function that samples the code with the n-th corner guess (null when out of guesses). */
  function detect(img, pts) {
    var tl = pts.topLeft, tr = pts.topRight, bl = pts.bottomLeft;
    var moduleSize = (moduleSizeOneWay(img, tl, tr) + moduleSizeOneWay(img, tl, bl)) / 2;
    if (!(moduleSize >= 1)) throw new NotFound();
    var dimension = computeDimension(tl, tr, bl, moduleSize);
    var version = (dimension - 17) / 4;
    if (version < 1 || version > 40) throw new NotFound();
    var modulesBetween = dimension - 7;
    var align = null;
    if (version >= 2) {
      var brX = tr.x - tl.x + bl.x, brY = tr.y - tl.y + bl.y;
      var corr = 1 - 3 / modulesBetween;
      var estX = Math.floor(tl.x + corr * (brX - tl.x));
      var estY = Math.floor(tl.y + corr * (brY - tl.y));
      for (var f = 4; f <= 16 && !align; f <<= 1) align = findAlignment(img, moduleSize, estX, estY, f);
    }
    var dm = dimension - 3.5;
    // One module to the right / down, in image space.
    var rx = (tr.x - tl.x) / modulesBetween, ry = (tr.y - tl.y) / modulesBetween;
    var dx = (bl.x - tl.x) / modulesBetween, dy = (bl.y - tl.y) / modulesBetween;
    var ALIGN_TRIES = [[0, 0], [-0.5, 0], [0.5, 0], [0, -0.5], [0, 0.5]];
    function sample(n) {
      var bx, by, sbx, sby;
      if (align && n < ALIGN_TRIES.length) {
        var o = ALIGN_TRIES[n];
        bx = align.x + o[0] * rx + o[1] * dx; by = align.y + o[0] * ry + o[1] * dy;
        sbx = sby = dm - 3;
      } else {
        // No alignment pattern, or the one we found didn't work out (could be a look-alike): fall back to guessing.
        if (align) n -= ALIGN_TRIES.length;
        if (n >= CORNER_OFFSETS.length) return null;
        var c = CORNER_OFFSETS[n];
        bx = tr.x - tl.x + bl.x + c[0] * rx + c[1] * dx;
        by = tr.y - tl.y + bl.y + c[0] * ry + c[1] * dy;
        sbx = sby = dm;
      }
      var transform = Transform.quadToQuad(3.5, 3.5, dm, 3.5, sbx, sby, 3.5, dm, tl.x, tl.y, tr.x, tr.y, bx, by, bl.x, bl.y);
      return sampleGrid(img, transform, dimension);
    }
    return { dimension: dimension, sample: sample };
  }

  // ---------------------------------------------------------------- version tables

  // [L, M, Q, H] for versions 0..40 (index 0 unused). Per-block counts from the QR spec (as in Nayuki's tables).
  var ECC_PER_BLOCK = [
    [-1, 7, 10, 15, 20, 26, 18, 20, 24, 30, 18, 20, 24, 26, 30, 22, 24, 28, 30, 28, 28, 28, 28, 30, 30, 26, 28, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30],
    [-1, 10, 16, 26, 18, 24, 16, 18, 22, 22, 26, 30, 22, 22, 24, 24, 28, 28, 26, 26, 26, 26, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28],
    [-1, 13, 22, 18, 26, 18, 24, 18, 22, 20, 24, 28, 26, 24, 20, 30, 24, 28, 28, 26, 30, 28, 30, 30, 30, 30, 28, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30],
    [-1, 17, 28, 22, 16, 22, 28, 26, 26, 24, 28, 24, 28, 22, 24, 24, 30, 28, 28, 26, 28, 30, 24, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30],
  ];
  var NUM_BLOCKS = [
    [-1, 1, 1, 1, 1, 1, 2, 2, 2, 2, 4, 4, 4, 4, 4, 6, 6, 6, 6, 7, 8, 8, 9, 9, 10, 12, 12, 12, 13, 14, 15, 16, 17, 18, 19, 19, 20, 21, 22, 24, 25],
    [-1, 1, 1, 1, 2, 2, 4, 4, 4, 5, 5, 5, 8, 9, 9, 10, 10, 11, 13, 14, 16, 17, 17, 18, 20, 21, 23, 25, 26, 28, 29, 31, 33, 35, 37, 38, 40, 43, 45, 47, 49],
    [-1, 1, 1, 2, 2, 4, 4, 6, 6, 8, 8, 8, 10, 12, 16, 12, 17, 16, 18, 21, 20, 23, 23, 25, 27, 29, 34, 34, 35, 38, 40, 43, 45, 48, 51, 53, 56, 59, 62, 65, 68],
    [-1, 1, 1, 2, 4, 4, 4, 5, 6, 8, 8, 11, 11, 16, 16, 18, 16, 19, 21, 25, 25, 25, 34, 30, 32, 35, 37, 40, 42, 45, 48, 51, 54, 57, 60, 63, 66, 70, 74, 77, 81],
  ];

  function alignmentPositions(version) {
    if (version === 1) return [];
    var num = Math.floor(version / 7) + 2;
    var size = version * 4 + 17;
    var step = version === 32 ? 26 : Math.floor((version * 4 + num * 2 + 1) / (num * 2 - 2)) * 2;
    var out = [6];
    for (var pos = size - 7; out.length < num; pos -= step) out.splice(1, 0, pos);
    return out;
  }

  function numRawDataModules(ver) {
    var r = (16 * ver + 128) * ver + 64;
    if (ver >= 2) {
      var na = Math.floor(ver / 7) + 2;
      r -= (25 * na - 10) * na - 55;
      if (ver >= 7) r -= 36;
    }
    return r;
  }

  function bitLength(v) { var n = 0; while (v !== 0) { n++; v >>>= 1; } return n; }
  function bchRemainder(value, poly) {
    var pb = bitLength(poly);
    while (bitLength(value) >= pb) value ^= poly << (bitLength(value) - pb);
    return value;
  }
  var FORMAT_CODES = [];
  for (var fd = 0; fd < 32; fd++) FORMAT_CODES.push({ code: ((fd << 10) | bchRemainder(fd << 10, 0x537)) ^ 0x5412, data: fd });
  var VERSION_CODES = [];
  for (var vv = 7; vv <= 40; vv++) VERSION_CODES.push({ code: (vv << 12) | bchRemainder(vv << 12, 0x1f25), version: vv });

  function popcount(x) { var n = 0; while (x) { n += x & 1; x >>>= 1; } return n; }

  function decodeFormat(bits1, bits2) {
    var best = 99, bestData = -1;
    for (var i = 0; i < FORMAT_CODES.length; i++) {
      var c = FORMAT_CODES[i];
      if (c.code === bits1 || c.code === bits2) return c.data;
      var d1 = popcount(bits1 ^ c.code);
      if (d1 < best) { best = d1; bestData = c.data; }
      var d2 = popcount(bits2 ^ c.code);
      if (d2 < best) { best = d2; bestData = c.data; }
    }
    return best <= 3 ? bestData : -1;
  }

  function decodeVersionBits(bits) {
    var best = 99, bestV = -1;
    for (var i = 0; i < VERSION_CODES.length; i++) {
      var c = VERSION_CODES[i];
      if (c.code === bits) return c.version;
      var d = popcount(bits ^ c.code);
      if (d < best) { best = d; bestV = c.version; }
    }
    return best <= 3 ? bestV : -1;
  }

  // ---------------------------------------------------------------- matrix parsing

  function readFormat(bits) {
    var dim = bits.height;
    var f1 = 0;
    var cb = function (x, y, acc) { return (acc << 1) | (bits.get(x, y) ? 1 : 0); };
    for (var i = 0; i < 6; i++) f1 = cb(i, 8, f1);
    f1 = cb(7, 8, f1);
    f1 = cb(8, 8, f1);
    f1 = cb(8, 7, f1);
    for (var j = 5; j >= 0; j--) f1 = cb(8, j, f1);
    var f2 = 0;
    for (j = dim - 1; j >= dim - 7; j--) f2 = cb(8, j, f2);
    for (i = dim - 8; i < dim; i++) f2 = cb(i, 8, f2);
    var data = decodeFormat(f1, f2);
    if (data < 0) data = decodeFormat(f1 ^ 0x5412, f2 ^ 0x5412);
    if (data < 0) throw new NotFound();
    // EC level bits: 01 = L, 00 = M, 11 = Q, 10 = H -> index into [L, M, Q, H]
    var ecBits = (data >> 3) & 3;
    return { ecIndex: [1, 0, 3, 2][ecBits], mask: data & 7 };
  }

  function readVersion(bits) {
    var dim = bits.height;
    var provisional = (dim - 17) / 4;
    if (provisional <= 6) return provisional;
    var v = 0, i, j;
    for (j = 5; j >= 0; j--) for (i = dim - 9; i >= dim - 11; i--) v = (v << 1) | (bits.get(i, j) ? 1 : 0);
    var ver = decodeVersionBits(v);
    if (ver > 0 && ver * 4 + 17 === dim) return ver;
    v = 0;
    for (i = 5; i >= 0; i--) for (j = dim - 9; j >= dim - 11; j--) v = (v << 1) | (bits.get(i, j) ? 1 : 0);
    ver = decodeVersionBits(v);
    if (ver > 0 && ver * 4 + 17 === dim) return ver;
    throw new NotFound();
  }

  function isMasked(mask, i, j) {
    switch (mask) {
      case 0: return ((i + j) & 1) === 0;
      case 1: return (i & 1) === 0;
      case 2: return j % 3 === 0;
      case 3: return (i + j) % 3 === 0;
      case 4: return ((Math.floor(i / 2) + Math.floor(j / 3)) & 1) === 0;
      case 5: return (i * j) % 6 === 0;
      case 6: return (i * j) % 6 < 3;
      default: return ((i + j + ((i * j) % 3)) & 1) === 0;
    }
  }

  function functionPattern(version) {
    var dim = version * 4 + 17;
    var m = new BitMatrix(dim, dim);
    m.setRegion(0, 0, 9, 9);
    m.setRegion(dim - 8, 0, 8, 9);
    m.setRegion(0, dim - 8, 9, 8);
    var centers = alignmentPositions(version);
    var max = centers.length;
    for (var x = 0; x < max; x++) {
      var i = centers[x] - 2;
      for (var y = 0; y < max; y++) {
        if ((x !== 0 || (y !== 0 && y !== max - 1)) && (x !== max - 1 || y !== 0)) m.setRegion(centers[y] - 2, i, 5, 5);
      }
    }
    m.setRegion(6, 9, 1, dim - 17);
    m.setRegion(9, 6, dim - 17, 1);
    if (version > 6) {
      m.setRegion(dim - 11, 0, 3, 6);
      m.setRegion(0, dim - 11, 6, 3);
    }
    return m;
  }

  function readCodewords(bits, version, mask) {
    var dim = bits.height;
    for (var i = 0; i < dim; i++) for (var j = 0; j < dim; j++) if (isMasked(mask, i, j)) bits.flip(j, i);
    var fp = functionPattern(version);
    var total = Math.floor(numRawDataModules(version) / 8);
    var out = new Uint8Array(total);
    var offset = 0, current = 0, count = 0, up = true;
    for (var x = dim - 1; x > 0; x -= 2) {
      if (x === 6) x--;
      for (var c = 0; c < dim; c++) {
        var y = up ? dim - 1 - c : c;
        for (var col = 0; col < 2; col++) {
          if (!fp.get(x - col, y)) {
            count++;
            current = (current << 1) | (bits.get(x - col, y) ? 1 : 0);
            if (count === 8) {
              if (offset < total) out[offset] = current;
              offset++;
              count = 0;
              current = 0;
            }
          }
        }
      }
      up = !up;
    }
    if (offset !== total) throw new NotFound();
    return out;
  }

  function dataBlocks(raw, version, ecIndex) {
    var numBlocks = NUM_BLOCKS[ecIndex][version];
    var ecc = ECC_PER_BLOCK[ecIndex][version];
    var rawCodewords = raw.length;
    var numShort = numBlocks - (rawCodewords % numBlocks);
    var shortLen = Math.floor(rawCodewords / numBlocks);
    var blocks = [];
    for (var b = 0; b < numBlocks; b++) {
      var dataLen = shortLen - ecc + (b < numShort ? 0 : 1);
      blocks.push({ dataLen: dataLen, codewords: new Uint8Array(dataLen + ecc) });
    }
    var shortData = shortLen - ecc;
    var o = 0;
    for (var i = 0; i < shortData; i++) for (b = 0; b < numBlocks; b++) blocks[b].codewords[i] = raw[o++];
    for (b = numShort; b < numBlocks; b++) blocks[b].codewords[shortData] = raw[o++];
    var max = blocks[0].codewords.length;
    for (i = shortData; i < max; i++) {
      for (b = 0; b < numBlocks; b++) {
        var idx = b < numShort ? i : i + 1;
        blocks[b].codewords[idx] = raw[o++];
      }
    }
    return { blocks: blocks, ecc: ecc };
  }

  // ---------------------------------------------------------------- Reed-Solomon over GF(256), poly 0x11D, base 0

  var EXP = new Uint8Array(512), LOG = new Uint8Array(256);
  (function () {
    var x = 1;
    for (var i = 0; i < 255; i++) { EXP[i] = x; LOG[x] = i; x <<= 1; if (x & 0x100) x ^= 0x11d; }
    for (i = 255; i < 512; i++) EXP[i] = EXP[i - 255];
  })();
  function gmul(a, b) { return a === 0 || b === 0 ? 0 : EXP[LOG[a] + LOG[b]]; }
  function ginv(a) { if (a === 0) throw new NotFound(); return EXP[255 - LOG[a]]; }

  // Polynomials as arrays, highest degree first.
  function pNorm(c) { var i = 0; while (i < c.length - 1 && c[i] === 0) i++; return i ? c.slice(i) : c; }
  function pDeg(p) { return p.length - 1; }
  function pIsZero(p) { return p[0] === 0; }
  function pCoef(p, d) { return p[p.length - 1 - d]; }
  function pEval(p, a) {
    if (a === 0) return pCoef(p, 0);
    var r = 0;
    for (var i = 0; i < p.length; i++) r = gmul(a, r) ^ p[i];
    return r;
  }
  function pAdd(a, b) {
    if (pIsZero(a)) return b;
    if (pIsZero(b)) return a;
    var small = a, large = b;
    if (small.length > large.length) { small = b; large = a; }
    var out = large.slice();
    var diff = large.length - small.length;
    for (var i = 0; i < small.length; i++) out[i + diff] = small[i] ^ large[i + diff];
    return pNorm(out);
  }
  function pMul(a, b) {
    if (pIsZero(a) || pIsZero(b)) return [0];
    var out = new Array(a.length + b.length - 1).fill(0);
    for (var i = 0; i < a.length; i++) for (var j = 0; j < b.length; j++) out[i + j] ^= gmul(a[i], b[j]);
    return pNorm(out);
  }
  function pScale(p, s) {
    if (s === 0) return [0];
    return p.map(function (c) { return gmul(c, s); });
  }
  function pMulMono(p, degree, coef) {
    if (coef === 0) return [0];
    var out = p.map(function (c) { return gmul(c, coef); });
    for (var i = 0; i < degree; i++) out.push(0);
    return pNorm(out);
  }
  function pMono(degree, coef) {
    if (coef === 0) return [0];
    var out = new Array(degree + 1).fill(0);
    out[0] = coef;
    return out;
  }

  function rsDecode(received, twoS) {
    var poly = Array.prototype.slice.call(received);
    var syn = new Array(twoS);
    var noError = true;
    for (var i = 0; i < twoS; i++) {
      var e = pEval(poly, EXP[i]);
      syn[twoS - 1 - i] = e;
      if (e !== 0) noError = false;
    }
    if (noError) return;
    var syndrome = pNorm(syn);
    // Euclidean algorithm
    var a = pMono(twoS, 1), b = syndrome;
    if (pDeg(a) < pDeg(b)) { var tmp = a; a = b; b = tmp; }
    var rLast = a, r = b, tLast = [0], t = [1];
    while (2 * pDeg(r) >= twoS) {
      var rLastLast = rLast, tLastLast = tLast;
      rLast = r; tLast = t;
      if (pIsZero(rLast)) throw new NotFound();
      r = rLastLast;
      var q = [0];
      var dltInv = ginv(pCoef(rLast, pDeg(rLast)));
      while (pDeg(r) >= pDeg(rLast) && !pIsZero(r)) {
        var degDiff = pDeg(r) - pDeg(rLast);
        var scale = gmul(pCoef(r, pDeg(r)), dltInv);
        q = pAdd(q, pMono(degDiff, scale));
        r = pAdd(r, pMulMono(rLast, degDiff, scale));
      }
      t = pAdd(pMul(q, tLast), tLastLast);
      if (pDeg(r) >= pDeg(rLast)) throw new NotFound();
    }
    var sigmaAtZero = pCoef(t, 0);
    if (sigmaAtZero === 0) throw new NotFound();
    var inv = ginv(sigmaAtZero);
    var sigma = pScale(t, inv), omega = pScale(r, inv);
    // Error locations (Chien search)
    var numErrors = pDeg(sigma);
    var locations = [];
    if (numErrors === 1) locations.push(pCoef(sigma, 1));
    else {
      for (var x = 1; x < 256 && locations.length < numErrors; x++) if (pEval(sigma, x) === 0) locations.push(ginv(x));
      if (locations.length !== numErrors) throw new NotFound();
    }
    // Error magnitudes (Forney)
    for (i = 0; i < locations.length; i++) {
      var xiInv = ginv(locations[i]);
      var den = 1;
      for (var j = 0; j < locations.length; j++) {
        if (i === j) continue;
        var term = gmul(locations[j], xiInv);
        den = gmul(den, (term & 1) === 0 ? term | 1 : term & ~1);
      }
      var magnitude = gmul(pEval(omega, xiInv), ginv(den));
      var position = received.length - 1 - LOG[locations[i]];
      if (position < 0) throw new NotFound();
      received[position] ^= magnitude;
    }
  }

  // ---------------------------------------------------------------- bit stream

  var ALNUM = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ $%*+-./:';

  function BitReader(bytes) { this.bytes = bytes; this.pos = 0; }
  BitReader.prototype.available = function () { return this.bytes.length * 8 - this.pos; };
  BitReader.prototype.read = function (n) {
    if (n > this.available()) throw new NotFound();
    var v = 0;
    for (var i = 0; i < n; i++) {
      var byte = this.bytes[(this.pos >> 3)];
      v = (v << 1) | ((byte >> (7 - (this.pos & 7))) & 1);
      this.pos++;
    }
    return v >>> 0;
  };

  function countBits(mode, version) {
    var idx = version <= 9 ? 0 : version <= 26 ? 1 : 2;
    switch (mode) {
      case 1: return [10, 12, 14][idx];
      case 2: return [9, 11, 13][idx];
      case 4: return [8, 16, 16][idx];
      case 8: case 13: return [8, 10, 12][idx];
    }
    throw new NotFound();
  }

  var ECI_LABELS = { 1: 'iso-8859-1', 3: 'iso-8859-1', 4: 'iso-8859-2', 5: 'iso-8859-3', 6: 'iso-8859-4', 7: 'iso-8859-5', 8: 'iso-8859-6', 9: 'iso-8859-7', 10: 'iso-8859-8', 11: 'windows-874', 13: 'iso-8859-11', 15: 'iso-8859-13', 16: 'iso-8859-14', 17: 'iso-8859-15', 18: 'iso-8859-16', 20: 'shift_jis', 21: 'windows-1250', 22: 'windows-1251', 23: 'windows-1252', 24: 'windows-1256', 25: 'utf-16be', 26: 'utf-8', 27: 'us-ascii', 28: 'big5', 29: 'gb18030', 30: 'euc-kr' };

  function decodeBytes(bytes, label) {
    if (typeof TextDecoder === 'undefined') {
      var s = '';
      for (var i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
      return s;
    }
    if (label) {
      try { return new TextDecoder(label).decode(bytes); } catch (e) { /* fall through */ }
    }
    try { return new TextDecoder('utf-8', { fatal: true }).decode(bytes); } catch (e) {
      return new TextDecoder('windows-1252').decode(bytes);
    }
  }

  function parseStream(bytes, version) {
    var br = new BitReader(bytes);
    var text = '';
    var eci = null;
    var fnc1 = false;
    for (;;) {
      if (br.available() < 4) break;
      var mode = br.read(4);
      if (mode === 0) break;
      if (mode === 5) { fnc1 = true; continue; }
      if (mode === 9) { fnc1 = true; br.read(8); continue; }
      if (mode === 3) { br.read(16); continue; }
      if (mode === 7) {
        var first = br.read(8);
        if ((first & 0x80) === 0) eci = first & 0x7f;
        else if ((first & 0xc0) === 0x80) eci = ((first & 0x3f) << 8) | br.read(8);
        else if ((first & 0xe0) === 0xc0) eci = ((first & 0x1f) << 16) | br.read(16);
        else throw new NotFound();
        continue;
      }
      if (mode === 13) {
        var subset = br.read(4);
        var nh = br.read(countBits(13, version));
        var hb = new Uint8Array(nh * 2);
        for (var h = 0; h < nh; h++) {
          var tb = br.read(13);
          var asm = ((Math.floor(tb / 0x060)) << 8) | (tb % 0x060);
          asm += asm < 0x00a00 ? 0x0a1a1 : 0x0a6a1;
          hb[2 * h] = (asm >> 8) & 0xff; hb[2 * h + 1] = asm & 0xff;
        }
        if (subset === 1) text += decodeBytes(hb, 'gb18030');
        continue;
      }
      if (mode !== 1 && mode !== 2 && mode !== 4 && mode !== 8) throw new NotFound();
      var count = br.read(countBits(mode, version));
      if (mode === 1) {
        while (count >= 3) {
          var three = br.read(10);
          if (three >= 1000) throw new NotFound();
          text += (three < 100 ? '0' : '') + (three < 10 ? '0' : '') + three;
          count -= 3;
        }
        if (count === 2) { var two = br.read(7); if (two >= 100) throw new NotFound(); text += (two < 10 ? '0' : '') + two; }
        else if (count === 1) { var one = br.read(4); if (one >= 10) throw new NotFound(); text += one; }
      } else if (mode === 2) {
        var chunk = '';
        while (count > 1) {
          var pair = br.read(11);
          var c1 = Math.floor(pair / 45), c2 = pair % 45;
          if (c1 >= 45) throw new NotFound();
          chunk += ALNUM[c1] + ALNUM[c2];
          count -= 2;
        }
        if (count === 1) { var single = br.read(6); if (single >= 45) throw new NotFound(); chunk += ALNUM[single]; }
        if (fnc1) chunk = chunk.replace(/%%/g, '\u0000').replace(/%/g, '\u001d').replace(/\u0000/g, '%');
        text += chunk;
      } else if (mode === 4) {
        if (count * 8 > br.available()) throw new NotFound();
        var bytesOut = new Uint8Array(count);
        for (var b = 0; b < count; b++) bytesOut[b] = br.read(8);
        text += decodeBytes(bytesOut, eci !== null ? ECI_LABELS[eci] : null);
      } else {
        var kb = new Uint8Array(count * 2);
        for (var k = 0; k < count; k++) {
          var kt = br.read(13);
          var ka = ((Math.floor(kt / 0x0c0)) << 8) | (kt % 0x0c0);
          ka += ka < 0x01f00 ? 0x08140 : 0x0c140;
          kb[2 * k] = (ka >> 8) & 0xff; kb[2 * k + 1] = ka & 0xff;
        }
        text += decodeBytes(kb, 'shift_jis');
      }
    }
    return text;
  }

  function decodeMatrix(bits) {
    var version = readVersion(bits);
    var format = readFormat(bits);
    var raw = readCodewords(bits, version, format.mask);
    var db = dataBlocks(raw, version, format.ecIndex);
    var totalData = 0;
    db.blocks.forEach(function (bl) { totalData += bl.dataLen; });
    var data = new Uint8Array(totalData);
    var o = 0;
    for (var i = 0; i < db.blocks.length; i++) {
      var bl = db.blocks[i];
      rsDecode(bl.codewords, db.ecc);
      for (var j = 0; j < bl.dataLen; j++) data[o++] = bl.codewords[j];
    }
    return { text: parseStream(data, version), version: version, ecLevel: 'LMQH'[format.ecIndex] };
  }

  function transpose(bits) {
    var m = new BitMatrix(bits.height, bits.width);
    for (var y = 0; y < bits.height; y++) for (var x = 0; x < bits.width; x++) if (bits.get(x, y)) m.set(y, x);
    return m;
  }

  function decodeSampled(bits) {
    try { return decodeMatrix(bits.clone()); } catch (e) {
      if (!(e instanceof NotFound)) throw e;
    }
    // Mirrored codes (scanned through glass or from a flipped selfie camera).
    return decodeMatrix(transpose(bits));
  }

  function scanMatrix(img, maxAttempts) {
    var centers = findFinderPatterns(img);
    if (centers.length < 3) return null;
    var triples = rankTriples(centers);
    var tries = Math.min(triples.length, maxAttempts);
    for (var i = 0; i < tries; i++) {
      var pts = orderPatterns(triples[i].points);
      var det;
      try { det = detect(img, pts); } catch (e) { if (!(e instanceof NotFound)) throw e; continue; }
      for (var attempt = 0; ; attempt++) {
        var bits;
        try { bits = det.sample(attempt); } catch (e) { if (!(e instanceof NotFound)) throw e; continue; }
        if (!bits) break;
        try {
          var result = decodeSampled(bits);
          result.location = pts;
          return result;
        } catch (e) {
          if (!(e instanceof NotFound)) throw e;
        }
      }
    }
    return null;
  }

  function invert(m) {
    var out = new BitMatrix(m.width, m.height);
    for (var i = 0; i < m.data.length; i++) out.data[i] = m.data[i] ? 0 : 1;
    return out;
  }

  /**
   * options.inverted: also look for light-on-dark codes (default true)
   * options.maxAttempts: finder-pattern triples to try (default 3)
   */
  function decode(image, options) {
    options = options || {};
    var lum = toLuminance(image.data, image.width, image.height);
    var bits = binarize(lum, image.width, image.height);
    var max = options.maxAttempts || 3;
    var r = scanMatrix(bits, max);
    if (!r && options.inverted !== false) r = scanMatrix(invert(bits), max);
    if (r && options.inverted !== false && r.text === '') r = null;
    return r;
  }

  return {
    decode: decode,
    _internal: { rankTriples: rankTriples, orderPatterns: orderPatterns, detect: detect, decodeSampled: decodeSampled, readFormat: readFormat, readVersion: readVersion, binarize: binarize, toLuminance: toLuminance, findFinderPatterns: findFinderPatterns, alignmentPositions: alignmentPositions, numRawDataModules: numRawDataModules, rsDecode: rsDecode, FORMAT_CODES: FORMAT_CODES, VERSION_CODES: VERSION_CODES, ECC_PER_BLOCK: ECC_PER_BLOCK, NUM_BLOCKS: NUM_BLOCKS, decodeMatrix: decodeMatrix, BitMatrix: BitMatrix },
  };
});
