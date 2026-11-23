function mountKenzanAtlas(viewSignal, viewState) {
function atlasPinIconUrl(source) {
  if (typeof source !== 'string' || !source.trim()) return undefined;
  const url = source.trim();
  if (/^data:image\/(?:apng|avif|bmp|gif|jpeg|png|svg\+xml|webp|x-icon|vnd\.microsoft\.icon)(?:;|,)/i.test(url)) return url;
  try {
    const { protocol } = new URL(url, 'https://atlas.invalid/');
    if (protocol === 'http:' || protocol === 'https:' || protocol === 'file:') return url;
  } catch {
    // An invalid source leaves the built-in marker visible.
  }
}

function attachAtlasPinIcon(target, source, signal, onLoad) {
  const url = atlasPinIconUrl(source);
  if (!url) return;
  const document = target.ownerDocument;
  const image = document.createElement('img');
  image.className = 'atlas-marker-art';
  image.alt = '';
  image.draggable = false;
  image.decoding = 'async';
  image.referrerPolicy = 'no-referrer';
  image.hidden = true;
  const fallback = document.createElement('span');
  fallback.textContent = target.textContent;
  target.replaceChildren(fallback, image);
  image.src = url;
  image.decode().then(() => {
    if (signal.aborted || !image.naturalWidth || !image.naturalHeight) return;
    image.hidden = false;
    // Preserve the marker's dimensions when replacing its glyph.
    fallback.style.visibility = 'hidden';
    if (image.isConnected) onLoad?.();
  }, () => { /* A missing or unsupported image keeps the glyph visible. */ });
  return image;
}

if (typeof module === 'object' && module.exports) module.exports = { atlasPinIconUrl };

function createMotionMarkerLayer(markerLayer, signal) {
  const padding = 6;
  const sprites = new Map();
  let canvas;
  let context;
  let unavailable = false;
  let pixelRatio;
  let lastRecords;
  let prepared;
  let warmup;
  let spriteWarmup;
  let teardropPath;

  function warmSpriteCopy() {
    if (canvas || signal.aborted) return;
    const bitmap = document.createElement('canvas');
    bitmap.width = bitmap.height = 64;
    const pen = bitmap.getContext('2d');
    const target = document.createElement('canvas');
    target.width = target.height = 128;
    const surface = target.getContext('2d');
    if (!pen || !surface) return;
    pen.fillRect(0, 0, bitmap.width, bitmap.height);
    surface.drawImage(bitmap, 0, 0);
  }

  function warm() {
    // Give the first map image a frame before initializing the sprite copy path.
    requestAnimationFrame(() => {
      if (!canvas && !signal.aborted) warmup = window.requestIdleCallback?.(warmSpriteCopy);
    });
  }

  function paintSprite(style, ratio) {
    const { icon, iconSize } = style;
    const key = icon ? JSON.stringify([icon.src, style]) : JSON.stringify(style);
    const cached = sprites.get(key);
    if (cached) return cached;
    const { text, width, height, radius, font, fill, border, color, shadow, outline, teardrop } = style;
    const w = width + padding * 2, h = height + padding * 2;
    const anchorY = teardrop ? padding + height : h / 2;
    const teardropScale = teardrop ? width / atlasTeardrop.width : 1;
    const glyphY = teardrop ? padding + atlasTeardrop.headY * teardropScale : h / 2;
    const bitmap = document.createElement('canvas');
    bitmap.width = Math.ceil(w * ratio);
    bitmap.height = Math.ceil(h * ratio);
    const pen = bitmap.getContext('2d');
    if (!pen || typeof pen.roundRect !== 'function') return undefined;
    pen.scale(bitmap.width / w, bitmap.height / h);
    pen.beginPath();
    if (teardrop) {
      teardropPath ??= new Path2D(atlasTeardrop.path);
      pen.save();
      pen.translate(padding, padding);
      pen.scale(teardropScale, teardropScale);
      pen.lineJoin = 'round';
    } else pen.roundRect(padding + .5, padding + .5, width - 1, height - 1, radius);
    pen.fillStyle = fill;
    if (shadow) {
      pen.shadowColor = '#101511a8';
      pen.shadowBlur = 4 * ratio;
      pen.shadowOffsetY = ratio;
    }
    if (teardrop) pen.fill(teardropPath);
    else pen.fill();
    pen.shadowColor = 'transparent';
    if (teardrop) {
      pen.strokeStyle = outline ?? border;
      pen.lineWidth = outline ? 2 : 1;
      pen.stroke(teardropPath);
      pen.restore();
    } else {
      pen.strokeStyle = border;
      pen.stroke();
    }
    if (outline && !teardrop) {
      pen.beginPath();
      pen.roundRect(padding - 2, padding - 2, width + 4, height + 4, radius + 2);
      pen.strokeStyle = outline;
      pen.lineWidth = 2;
      pen.stroke();
    }
    if (icon?.naturalWidth && icon.naturalHeight) {
      const scale = iconSize / Math.max(icon.naturalWidth, icon.naturalHeight);
      const iconWidth = icon.naturalWidth * scale;
      const iconHeight = icon.naturalHeight * scale;
      pen.drawImage(icon, (w - iconWidth) / 2, glyphY - iconHeight / 2, iconWidth, iconHeight);
    } else {
      pen.font = font;
      pen.fillStyle = color;
      pen.textAlign = 'center';
      pen.textBaseline = 'middle';
      pen.fillText(text, w / 2, glyphY);
    }
    const sprite = { bitmap, w, h, anchorY };
    if (sprites.size >= 512) sprites.delete(sprites.keys().next().value);
    sprites.set(key, sprite);
    return sprite;
  }

  function syncPixelRatio() {
    const scale = devicePixelRatio || 1;
    if (pixelRatio !== scale) {
      sprites.clear();
      lastRecords = undefined;
      pixelRatio = scale;
    }
    return scale;
  }

  function warmSprites(getRecords) {
    if (!window.requestIdleCallback || unavailable) return;
    if (spriteWarmup !== undefined) window.cancelIdleCallback(spriteWarmup);
    let next = 0;
    function prepare(deadline) {
      spriteWarmup = undefined;
      const records = getRecords();
      if (!records || signal.aborted) return;
      const scale = syncPixelRatio();
      // Only cache the current view's sprites. The viewport canvas stays unallocated.
      while (next < records.length && deadline.timeRemaining() > 2) {
        const { sprite, caption } = records[next++];
        if (sprite && !paintSprite(sprite, scale)) return;
        if (caption && !paintSprite(caption.sprite, scale)) return;
      }
      if (next < records.length) spriteWarmup = window.requestIdleCallback(prepare);
    }
    spriteWarmup = window.requestIdleCallback(prepare);
  }

  function hide() {
    if (!canvas || canvas.hidden) return;
    canvas.hidden = true;
    canvas.width = canvas.height = 0;
    lastRecords = undefined;
    prepared = undefined;
  }

  function draw(records, { width, height, ratio, dx, dy }) {
    if (unavailable || signal.aborted) return false;
    if (!canvas) {
      canvas = document.createElement('canvas');
      canvas.className = 'atlas-motion-markers';
      canvas.dataset.renderer = 'canvas';
      canvas.setAttribute('aria-hidden', 'true');
      context = canvas.getContext('2d');
      if (!context) {
        unavailable = true;
        return false;
      }
      markerLayer.before(canvas);
    }
    if (typeof context.roundRect !== 'function' || context.isContextLost?.()) return false;
    const scale = syncPixelRatio();
    if (records !== lastRecords) {
      prepared = records.map(({ sprite, caption, ...record }) => ({
        ...record,
        sprite: sprite && paintSprite(sprite, scale),
        caption: caption && { ...caption, image: paintSprite(caption.sprite, scale) },
      }));
      if (prepared.some((record, i) => (records[i].sprite && !record.sprite) || (record.caption && !record.caption.image))) {
        prepared = undefined;
        return false;
      }
      lastRecords = records;
    }
    const pixelWidth = Math.round(width * scale), pixelHeight = Math.round(height * scale);
    if (canvas.width !== pixelWidth || canvas.height !== pixelHeight) {
      canvas.width = pixelWidth;
      canvas.height = pixelHeight;
    }
    canvas.hidden = false;
    context.setTransform(pixelWidth / width, 0, 0, pixelHeight / height, 0, 0);
    context.clearRect(0, 0, width, height);
    const change = ratio - 1;
    for (const { x, y, anchor, sprite, caption, lines } of prepared) {
      const left = x + dx + anchor.x * change;
      const top = y + dy + anchor.y * change;
      const margin = Math.max(40, caption?.image.w ?? 0);
      if (left < -margin || top < -80 || left > width + margin || top > height + 80) continue;
      for (const line of lines ?? []) {
        const fromY = top + (line.fromY ?? 0);
        context.beginPath();
        context.moveTo(left, fromY);
        context.lineTo(left + line.dx, fromY + line.dy);
        context.lineWidth = line.width;
        context.strokeStyle = line.color;
        context.stroke();
        if (line.dot) {
          context.beginPath();
          context.arc(left, top, line.dot, 0, 2 * Math.PI);
          context.fillStyle = line.color;
          context.fill();
        }
      }
      if (sprite) context.drawImage(sprite.bitmap, left - sprite.w / 2, top - sprite.anchorY, sprite.w, sprite.h);
      if (caption) {
        const { image } = caption;
        context.drawImage(image.bitmap, left + caption.x - padding, top + caption.y - padding, image.w, image.h);
      }
    }
    return true;
  }

  signal.addEventListener('abort', () => {
    if (warmup !== undefined) window.cancelIdleCallback(warmup);
    if (spriteWarmup !== undefined) window.cancelIdleCallback(spriteWarmup);
    hide();
    sprites.clear();
    canvas?.remove();
  }, { once: true });
  return { draw, hide, warm, warmSprites };
}

// Levels are listed coarsest first. Crop coordinates are pixels in their level.
// A missing grid cell is transparent. A level may also be a single whole image.
function createAtlasPyramid({ levels, tileSize, fallback, wholeViewCoverage, preloadMargin = 64, opaque = false }) {
  const prepared = levels.map(level => {
    const onlyTile = level.tiles.length === 1 ? level.tiles[0] : undefined;
    const whole = onlyTile && onlyTile.x === 0 && onlyTile.y === 0 &&
      onlyTile.w === level.width && onlyTile.h === level.height;
    const edge = tileSize ?? Math.max(level.width, level.height);
    const columns = Math.ceil(level.width / edge);
    const cells = new Map(level.tiles.map(tile => [
      Math.floor(tile.y / edge) * columns + Math.floor(tile.x / edge), { ...tile },
    ]));
    return { ...level, cells, edge, columns, whole: whole ? onlyTile.source : undefined };
  });
  return {
    fallback: prepared[0]?.whole ?? fallback,
    levels: prepared,
    wholeViewCoverage,
    wholeLevels: wholeViewCoverage ? prepared.filter(level => level.whole) : [],
    preloadMargin,
    opaque,
    requested: new Set(),
    painted: new Set(),
  };
}

function visiblePyramidTiles(level, bounds, camera, width, height, margin) {
  const left = camera.x + bounds.x * camera.scale;
  const top = camera.y + bounds.y * camera.scale;
  const scaleX = bounds.w * camera.scale / level.width;
  const scaleY = bounds.h * camera.scale / level.height;
  const { edge, columns, cells } = level;
  const firstX = Math.max(0, Math.floor((-left - margin) / (edge * scaleX)));
  const firstY = Math.max(0, Math.floor((-top - margin) / (edge * scaleY)));
  const lastX = Math.min(columns, Math.ceil((width - left + margin) / (edge * scaleX)));
  const lastY = Math.min(Math.ceil(level.height / edge), Math.ceil((height - top + margin) / (edge * scaleY)));
  const visible = [];
  for (let y = firstY; y < lastY; y++) {
    for (let x = firstX; x < lastX; x++) {
      const tile = cells.get(y * columns + x);
      if (!tile) continue;
      const tileLeft = left + tile.x * scaleX, tileTop = top + tile.y * scaleY;
      const tileWidth = tile.w * scaleX, tileHeight = tile.h * scaleY;
      const onScreen = tileLeft + tileWidth > 0 && tileLeft < width && tileTop + tileHeight > 0 && tileTop < height;
      const distance = (tileLeft + (tileWidth - width) / 2) ** 2 + (tileTop + (tileHeight - height) / 2) ** 2;
      visible.push({ tile, onScreen, distance });
    }
  }
  return visible;
}

function clearPyramidRaster(area) {
  const { pyramid } = area;
  if (!pyramid.raster) return;
  const { canvas } = pyramid.raster;
  canvas.remove();
  canvas.width = canvas.height = 0;
  pyramid.raster = undefined;
  pyramid.painted.clear();
  pyramid.paintedLevel = undefined;
  pyramid.base = undefined;
  area.element.removeAttribute('data-pyramid-composited');
}

function pyramidRasterBounds(level, candidates) {
  let left = level.width, top = level.height, right = 0, bottom = 0;
  for (const { tile } of candidates) {
    left = Math.min(left, tile.x);
    top = Math.min(top, tile.y);
    right = Math.max(right, tile.x + tile.w);
    bottom = Math.max(bottom, tile.y + tile.h);
  }
  // Leave space for filtering across the edge of the cropped canvas.
  const x = Math.max(0, left - 2), y = Math.max(0, top - 2);
  return { x, y, w: Math.min(level.width, right + 2) - x, h: Math.min(level.height, bottom + 2) - y };
}

function paintPyramidTiles(area, level, ready, ownerDocument, candidates) {
  const { pyramid, image } = area;
  if (!ready.length) {
    clearPyramidRaster(area);
    return true;
  }
  const base = image.naturalWidth ? image : undefined;
  const { width, height } = level;
  const cropped = pyramid.opaque;
  const { x, y, w, h } = cropped ? pyramidRasterBounds(level, candidates) : { x: 0, y: 0, w: width, h: height };
  const previous = pyramid.raster;
  const sameBounds = previous?.x === x && previous.y === y && previous.canvas.width === w && previous.canvas.height === h;
  const sameLayer = sameBounds && pyramid.paintedLevel === level && pyramid.base === base;
  if (sameLayer && pyramid.painted.size === ready.length && ready.every(tile => pyramid.painted.has(tile))) return true;

  if (!pyramid.raster) {
    const canvas = ownerDocument.createElement('canvas');
    canvas.className = 'atlas-raster-layer atlas-pyramid-raster';
    canvas.setAttribute('aria-hidden', 'true');
    const context = canvas.getContext('2d');
    if (!context) return false;
    pyramid.raster = { canvas, context };
    area.element.append(canvas);
  }
  const { canvas, context } = pyramid.raster;
  const next = new Set(ready);
  // Keep the fallback and detail on one surface so the browser samples their join once.
  if (sameLayer) {
    for (const tile of pyramid.painted) {
      if (next.has(tile)) continue;
      const { x, y, w, h } = tile;
      context.clearRect(x, y, w, h);
      if (!base) continue;
      // Restore from the same full-level sampling grid used for the initial fallback.
      context.save();
      context.beginPath();
      context.rect(x, y, w, h);
      context.clip();
      context.drawImage(base, 0, 0, width, height);
      context.restore();
    }
  } else {
    if (canvas.width !== w) canvas.width = w;
    if (canvas.height !== h) canvas.height = h;
    pyramid.raster.x = x;
    pyramid.raster.y = y;
    if (cropped) {
      canvas.style.width = 100 * w / width + '%';
      canvas.style.height = 100 * h / height + '%';
      canvas.style.transform = `translate(${100 * x / w}%, ${100 * y / h}%)`;
    }
    context.setTransform(1, 0, 0, 1, -x, -y);
    context.clearRect(x, y, w, h);
    if (base) context.drawImage(base, 0, 0, width, height);
  }

  for (const tile of ready) {
    if (sameLayer && pyramid.painted.has(tile)) continue;
    // Replace the fallback's transparent pixels and colors together.
    context.clearRect(tile.x, tile.y, tile.w, tile.h);
    context.drawImage(tile.image, tile.x, tile.y);
  }
  area.element.toggleAttribute('data-pyramid-composited', !cropped);
  pyramid.paintedLevel = level;
  pyramid.base = base;
  pyramid.painted = next;
  return true;
}

// All geometry is in world units. An optional overview uses the same origin and
// covers disjoint area rectangles. The host owns the camera, controls, and data.
function createAtlasImagery({ areas: mapImages, overviewLayer, overviewSources = [], world,
  signal: viewSignal, onChange: requestPan, onFirstArtwork, ownerDocument,
  maxImageDecodes = 6, imageCacheBudget = 24 * 1024 * 1024 }) {
  const imageQueue = new Map();
  const imageCache = new Map();
  const pendingImageDecodes = new WeakMap();
  const imageRetryDelays = [500, 1500];
  let imageDecodes = 0;
  let cachedImageBytes = 0;
  let imageRetryTimer;
  let nextImageRetry = Infinity;
  let overviewImage = overviewLayer;
  let overviewRaster;
  let overviewPixels = 0;
  const overviewLoad = { rank: -1, distance: 0 };
  const sortedOverviewSources = [...overviewSources].sort((a, b) => a.width - b.width);
  const overviewFailures = new Set();
  const overviewCutouts = new Set();
  const overviewChanges = new Set();
  for (const area of mapImages) if (area.pyramid) area.pyramid = createAtlasPyramid(area.pyramid);

  function pumpImageQueue() {
    if (viewSignal.aborted) return;
    while (imageQueue.size && imageDecodes < maxImageDecodes) {
      let key;
      for (const candidate of imageQueue.keys()) {
        if (!key || candidate.rank < key.rank || (candidate.rank === key.rank && candidate.distance < key.distance)) key = candidate;
      }
      const load = imageQueue.get(key);
      imageQueue.delete(key);
      imageDecodes++;
      load().finally(() => {
        imageDecodes--;
        pumpImageQueue();
      });
    }
  }

  function decodeMapImage(image, source) {
    return new Promise((resolve, reject) => {
      pendingImageDecodes.set(image, () => resolve(false));
      image.src = source;
      image.decode().then(() => resolve(true), reject);
    }).finally(() => pendingImageDecodes.delete(image));
  }

  function cancelMapImage(image) {
    if (!image) return;
    // A detached image's native decode can stay pending after src is removed.
    pendingImageDecodes.get(image)?.();
    image.removeAttribute('src');
  }

  function takeCachedImage(source) {
    const cached = imageCache.get(source);
    if (!cached) return;
    imageCache.delete(source);
    cachedImageBytes -= cached.bytes;
    return cached.image;
  }

  function cacheImage(image) {
    const source = image.getAttribute('src');
    if (!source || !image.naturalWidth) return;
    const bytes = image.naturalWidth * image.naturalHeight * 4;
    if (bytes > imageCacheBudget) return;
    takeCachedImage(source);
    imageCache.set(source, { image, bytes });
    cachedImageBytes += bytes;
    while (cachedImageBytes > imageCacheBudget) takeCachedImage(imageCache.keys().next().value);
  }

  function artworkReady() {
    onFirstArtwork?.();
    onFirstArtwork = undefined;
  }

  function swapMapImage(tile, image) {
    cacheImage(tile.image);
    tile.image.replaceWith(image);
    tile.image = image;
    if (overviewImage) {
      const available = image.hasAttribute('src');
      if (available !== overviewCutouts.has(tile)) {
        if (available) overviewCutouts.add(tile);
        else overviewCutouts.delete(tile);
        overviewChanges.add(tile);
      }
    }
    if (image.naturalWidth) artworkReady();
  }

  function canLoadImage(tile, source) {
    if (!source) return false;
    const retry = tile.imageFailures?.get(source);
    if (!retry || retry.at <= performance.now()) return true;
    if (retry.at < nextImageRetry) {
      clearTimeout(imageRetryTimer);
      nextImageRetry = retry.at;
      imageRetryTimer = setTimeout(() => {
        nextImageRetry = Infinity;
        requestPan();
      }, Math.ceil(retry.at - performance.now()));
    }
    return false;
  }

  function recordImageFailure(tile, source) {
    tile.imageFailures ??= new Map();
    const attempts = (tile.imageFailures.get(source)?.attempts ?? 0) + 1;
    const delay = imageRetryDelays[attempts - 1];
    tile.imageFailures.set(source, { attempts, at: performance.now() + (delay ?? Infinity) });
  }

  function chooseMapImage(tile, desired, background) {
    const shown = tile.image.getAttribute('src');
    if (shown) return canLoadImage(tile, desired) ? desired : shown;
    if (background) return canLoadImage(tile, desired) ? desired : undefined;
    return tile.source ?? [tile.preview, desired, tile.medium, tile.detail].find(source => canLoadImage(tile, source));
  }

  function loadOverview(pixelScale) {
    if (!overviewImage || !sortedOverviewSources.length) return;
    const requestedWidth = world.width * pixelScale;
    const choice = sortedOverviewSources.find(({ width }) => width * 1.25 >= requestedWidth) ?? sortedOverviewSources.at(-1);
    if (overviewFailures.has(choice.source) || overviewLoad.source === choice.source) return;
    if (overviewPixels >= choice.width) return;
    cancelMapImage(overviewLoad.pending);
    overviewLoad.source = choice.source;
    imageQueue.set(overviewLoad, async () => {
      const image = overviewImage.cloneNode(false);
      image.removeAttribute('src');
      image.fetchPriority = 'high';
      overviewLoad.pending = image;
      try {
        if (!(await decodeMapImage(image, choice.source))) return;
      } catch {
        if (overviewLoad.pending !== image) return;
        overviewFailures.add(choice.source);
        overviewLoad.source = undefined;
        overviewLoad.pending = undefined;
        requestPan();
        return;
      }
      if (overviewLoad.pending !== image) return;
      overviewImage.replaceWith(image);
      overviewImage = image;
      overviewPixels = choice.width;
      overviewLoad.pending = undefined;
      requestPan();
      artworkReady();
    });
  }

  function clearOverviewRaster() {
    if (!overviewRaster) return;
    const { canvas } = overviewRaster;
    canvas.remove();
    canvas.width = canvas.height = 0;
    overviewRaster = undefined;
    overviewImage.removeAttribute('data-overview-composited');
  }

  function paintOverview() {
    if (!overviewPixels) return;
    if (!overviewCutouts.size) {
      clearOverviewRaster();
      overviewChanges.clear();
      return;
    }
    const newBase = overviewRaster?.base !== overviewImage;
    if (!newBase && !overviewChanges.size) return;
    if (!overviewRaster) {
      const canvas = ownerDocument.createElement('canvas');
      const context = canvas.getContext('2d');
      if (!context) return;
      canvas.className = 'atlas-overview-raster';
      canvas.setAttribute('aria-hidden', 'true');
      overviewImage.after(canvas);
      overviewRaster = { canvas, context };
    }
    const { canvas, context } = overviewRaster;
    const width = overviewImage.naturalWidth, height = overviewImage.naturalHeight;
    if (newBase) {
      if (canvas.width !== width) canvas.width = width;
      if (canvas.height !== height) canvas.height = height;
      context.clearRect(0, 0, width, height);
      context.drawImage(overviewImage, 0, 0);
      overviewRaster.base = overviewImage;
    }
    const scaleX = width / world.width, scaleY = height / world.height;
    for (const tile of newBase ? overviewCutouts : overviewChanges) {
      const { x, y, w, h } = tile.bounds;
      // Use the same rounded pixel bounds as the baked overview image.
      const left = Math.min(width - 1, Math.round(x * scaleX));
      const top = Math.min(height - 1, Math.round(y * scaleY));
      const cropWidth = Math.max(1, Math.round((x + w) * scaleX) - left);
      const cropHeight = Math.max(1, Math.round((y + h) * scaleY) - top);
      context.clearRect(left, top, cropWidth, cropHeight);
      if (!overviewCutouts.has(tile)) {
        context.drawImage(overviewImage, left, top, cropWidth, cropHeight, left, top, cropWidth, cropHeight);
      }
    }
    overviewChanges.clear();
    overviewImage.toggleAttribute('data-overview-composited', true);
  }

  function loadMapImage(tile, source) {
    if (tile.source === source && (source || !tile.image.hasAttribute('src'))) return;
    tile.source = source;
    imageQueue.delete(tile);
    cancelMapImage(tile.pending);
    tile.pending = undefined;
    if (!source) {
      if (tile.image.hasAttribute('src')) swapMapImage(tile, tile.imageTemplate.cloneNode(false));
      return;
    }
    if (tile.image.getAttribute('src') === source) return;
    const cached = takeCachedImage(source);
    if (cached) {
      swapMapImage(tile, cached);
      requestPan();
      return;
    }
    imageQueue.set(tile, async () => {
      const image = tile.imageTemplate.cloneNode(false);
      tile.pending = image;
      try {
        if (!(await decodeMapImage(image, source))) return;
      } catch {
        if (tile.pending !== image) return;
        tile.pending = undefined;
        tile.source = undefined;
        recordImageFailure(tile, source);
        requestPan();
        return;
      }
      if (tile.pending !== image) return;
      tile.imageFailures?.delete(source);
      swapMapImage(tile, image);
      tile.pending = undefined;
      requestPan();
    });
  }

  function loadPyramidTile(tile) {
    if (imageQueue.has(tile) || !canLoadImage(tile, tile.source)) return;
    const cached = takeCachedImage(tile.source);
    if (cached) {
      tile.image = cached;
      tile.ready = true;
      return;
    }
    imageQueue.set(tile, async () => {
      const image = ownerDocument.createElement('img');
      tile.image = image;
      try {
        if (!(await decodeMapImage(image, tile.source))) return;
      } catch {
        if (tile.image === image) {
          tile.image = undefined;
          recordImageFailure(tile, tile.source);
          requestPan();
        }
        return;
      }
      if (tile.image !== image) return;
      tile.imageFailures?.delete(tile.source);
      tile.ready = true;
      requestPan();
    });
  }

  function releasePyramidTile(tile) {
    imageQueue.delete(tile);
    if (!tile.image) return;
    if (tile.ready) cacheImage(tile.image);
    else cancelMapImage(tile.image);
    tile.image = undefined;
    tile.ready = false;
  }

  function intersects(left, top, width, height, viewWidth, viewHeight, margin = 0) {
    return left + width >= -margin && left <= viewWidth + margin
      && top + height >= -margin && top <= viewHeight + margin;
  }

  function distanceToCenter(left, top, width, height, viewWidth, viewHeight) {
    return (left + (width - viewWidth) / 2) ** 2 + (top + (height - viewHeight) / 2) ** 2;
  }

  function clearPyramid(area) {
    if (!area.pyramid?.level) return;
    for (const tile of area.pyramid.requested) {
      releasePyramidTile(tile);
      tile.imageFailures?.clear();
    }
    area.pyramid.requested.clear();
    area.pyramid.level = undefined;
    clearPyramidRaster(area);
    area.element.removeAttribute('data-pyramid-scale');
    area.element.removeAttribute('data-pyramid-ready');
  }

  function updatePyramid(area, camera, viewportWidth, viewportHeight, pixelRatio) {
    const { pyramid, bounds, element, image } = area;
    const width = bounds.w * camera.scale, height = bounds.h * camera.scale;
    const pixels = Math.max(width, height) * pixelRatio;
    // Judge the size of the view independently of where it is panned.
    const fitsWholeView = pyramid.wholeLevels.length &&
      Math.min(1, viewportWidth / width) * Math.min(1, viewportHeight / height) >= pyramid.wholeViewCoverage;
    const levels = fitsWholeView
      ? pyramid.wholeLevels : pyramid.levels;
    const level = levels.find(item => Math.max(item.width, item.height) * 1.15 >= pixels) ?? levels.at(-1);
    const shown = image.getAttribute('src');
    if (pyramid.level !== level) {
      pyramid.level = level;
      element.dataset.pyramidScale = level.scaleFactor;
    }
    const desired = level.whole ?? shown ?? pyramid.fallback;
    const useFallback = !shown && !(pyramid.wholeLevels.length && canLoadImage(area, level.whole));
    const source = useFallback && canLoadImage(area, pyramid.fallback) ? pyramid.fallback : desired;
    loadMapImage(area, chooseMapImage(area, source, true));
    const candidates = level.whole ? [] : visiblePyramidTiles(level, bounds, camera, viewportWidth, viewportHeight, pyramid.preloadMargin);
    const requested = new Set(candidates.map(({ tile }) => tile));
    for (const tile of pyramid.requested) {
      if (!requested.has(tile)) {
        releasePyramidTile(tile);
        tile.imageFailures?.clear();
      }
    }
    pyramid.requested = requested;
    if (level.whole) {
      const ready = area.image.getAttribute('src') === level.whole;
      if (ready) clearPyramidRaster(area);
      element.toggleAttribute('data-pyramid-ready', ready);
      return;
    }
    for (const { tile, onScreen, distance } of candidates) {
      tile.rank = onScreen ? area.rank === 1 ? 1 : 2 : 3;
      tile.distance = distance;
      if (!tile.image) loadPyramidTile(tile);
    }
    const fallbackFailed = area.imageFailures?.get(pyramid.fallback)?.at === Infinity;
    if (!area.image.naturalWidth && pyramid.fallback && !fallbackFailed) {
      element.removeAttribute('data-pyramid-ready');
      return;
    }
    const ready = candidates.filter(({ tile }) => tile.ready).map(({ tile }) => tile);
    const drawn = ready.length || pyramid.paintedLevel === level
      ? paintPyramidTiles(area, level, ready, ownerDocument, candidates) : false;
    element.toggleAttribute('data-pyramid-ready', Boolean(drawn) && candidates.every(({ tile, onScreen }) => !onScreen || tile.ready));
  }

  function findDestination(camera, viewWidth, viewHeight) {
    if (!camera) return;
    const { x, y, scale } = camera;
    let closest;
    let distance = Infinity;
    for (const tile of mapImages) {
      const bounds = tile.bounds;
      const left = x + bounds.x * scale, top = y + bounds.y * scale;
      const width = bounds.w * scale, height = bounds.h * scale;
      if (!intersects(left, top, width, height, viewWidth, viewHeight)) continue;
      const candidate = distanceToCenter(left, top, width, height, viewWidth, viewHeight);
      if (candidate < distance) {
        closest = tile;
        distance = candidate;
      }
    }
    return closest;
  }

  function update({ camera, viewportWidth, viewportHeight, pixelRatio = 1, overview, inMotion, zooming, destination }) {
    if (viewSignal.aborted) return;
    const { x, y, scale } = camera;
    if (overview) loadOverview((destination?.scale ?? scale) * pixelRatio);
    const background = overviewPixels > 0;
    const overviewOnly = overview && (background || overviewLoad.source);
    const destinationTile = !overview && findDestination(destination, viewportWidth, viewportHeight);
    for (const tile of mapImages) {
      const bounds = tile.bounds;
      if (overviewOnly) {
        if (inMotion || !background) continue;
        clearPyramid(tile);
        if (tile.source || tile.image.hasAttribute('src')) loadMapImage(tile);
        continue;
      }
      const left = x + bounds.x * scale;
      const top = y + bounds.y * scale;
      const width = bounds.w * scale;
      const height = bounds.h * scale;
      const margin = tile.source ? 160 : 80;
      const nearby = intersects(left, top, width, height, viewportWidth, viewportHeight, margin);
      const visible = intersects(left, top, width, height, viewportWidth, viewportHeight);
      const atDestination = tile === destinationTile;
      const hasFallback = tile.image.hasAttribute('src');
      tile.rank = visible && !hasFallback && !background ? 0 : atDestination ? 1 : visible ? 2 : 3;
      tile.distance = distanceToCenter(left, top, width, height, viewportWidth, viewportHeight);
      if (!nearby && !atDestination) {
        if (inMotion) {
          if (imageQueue.delete(tile)) tile.source = tile.image.getAttribute('src') ?? undefined;
          for (const crop of tile.pyramid?.requested ?? []) {
            if (!crop.ready) releasePyramidTile(crop);
          }
          continue;
        }
        clearPyramid(tile);
        tile.imageFailures?.clear();
        loadMapImage(tile);
        continue;
      }
      if (zooming && !atDestination) {
        // Hold the current tiers until scale settles. At a fixed scale, panning can load detail.
        if (!tile.source && !background) {
          const fallback = tile.pyramid?.fallback ?? tile.preview ?? tile.medium ?? tile.detail;
          loadMapImage(tile, chooseMapImage(tile, fallback, Boolean(tile.pyramid)));
        }
        continue;
      }
      const imageCamera = atDestination ? destination : camera;
      if (tile.pyramid) {
        updatePyramid(tile, imageCamera, viewportWidth, viewportHeight, pixelRatio);
        continue;
      }
      const imageryScale = imageCamera.scale * pixelRatio;
      const pixels = Math.max(bounds.w, bounds.h) * imageryScale;
      const detailThreshold = tile.medium
        ? tile.source === tile.detail ? 464 : 544
        : tile.source === tile.detail ? 208 : 256;
      const mediumThreshold = tile.source === tile.medium ? 176 : 208;
      const useDetail = !overview && pixels >= detailThreshold;
      let desired = background ? undefined : tile.preview ?? tile.medium ?? tile.detail;
      if (useDetail) desired = tile.detail;
      else if (!overview && tile.medium && pixels >= mediumThreshold) desired = tile.medium;
      else if (background && imageryScale > overviewPixels / world.width * 1.25) desired = tile.preview;
      // Start from the small image on first entry unless the overview already covers the area.
      loadMapImage(tile, desired ? chooseMapImage(tile, desired, background) : undefined);
    }
    paintOverview();
    pumpImageQueue();
  }


  viewSignal.addEventListener('abort', () => {
    clearTimeout(imageRetryTimer);
    imageQueue.clear();
    cancelMapImage(overviewLoad.pending);
    clearOverviewRaster();
    cancelMapImage(overviewImage);
    for (const areaImage of mapImages) {
      clearPyramid(areaImage);
      cancelMapImage(areaImage.pending);
      areaImage.pending = undefined;
      areaImage.image.removeAttribute('src');
    }
    imageCache.clear();
  }, { once: true });

  return { update };
}

function mountPhotoViewer(dialog, signal, fallbackFocus) {
  const title = dialog.querySelector('h2');
  const image = dialog.querySelector('img');
  let returnFocus;
  dialog.addEventListener('close', () => {
    image.removeAttribute('src');
    image.style.backgroundImage = '';
    const previous = returnFocus;
    returnFocus = undefined;
    if (!signal?.aborted) (previous?.isConnected ? previous : fallbackFocus)?.focus({ preventScroll: true });
  });
  signal?.addEventListener('abort', () => {
    if (dialog.open) dialog.close();
  }, { once: true });

  return function openPhoto(photo, name, trigger) {
    if (dialog.open) return;
    returnFocus = trigger;
    title.textContent = name;
    dialog.style.setProperty('--atlas-photo-ratio', photo.width / photo.height);
    image.alt = `Location screenshot for ${name}`;
    image.width = photo.width;
    image.height = photo.height;
    image.style.backgroundImage = `url(${JSON.stringify(photo.preview)})`;
    image.src = photo.source;
    dialog.showModal();
  };
}

const atlasTeardrop = {
  width: 18, height: 26, headY: 9,
  path: 'M9 25.5C8.5 25.5 8.2 25 8 24.5 6 18.8.5 14 .5 9a8.5 8.5 0 1 1 17 0c0 5-5.5 9.8-7.5 15.5-.2.5-.5 1-1 1Z',
};

const atlasPlacePinWidths = { small: 14, medium: 18, large: 24, larger: 32 };
const atlasPlacePinDimensions = Object.fromEntries(Object.values(atlasPlacePinWidths).map(width => {
  const ratio = width / atlasTeardrop.width;
  const height = atlasTeardrop.height * ratio;
  return [width, {
    centered: { width, height: width, anchorY: width / 2, headY: width / 2, inset: 1 },
    teardrop: { width, height, anchorY: height, headY: atlasTeardrop.headY * ratio, inset: 0 },
  }];
}));

function atlasPlacePinSize(size) {
  return typeof size === 'string' && Object.hasOwn(atlasPlacePinWidths, size) ? size : 'medium';
}

function atlasPlacePinMetrics(place) {
  const dimensions = atlasPlacePinDimensions[atlasPlacePinWidths[atlasPlacePinSize(place.size)]];
  return place.shape === 'teardrop' ? dimensions.teardrop : dimensions.centered;
}

function setAtlasPlacePinSize(button, value) {
  const size = atlasPlacePinSize(value);
  if (button.dataset.pinSize === size) return;
  button.dataset.pinSize = size;
  if (size === 'medium') button.style.removeProperty('--atlas-pin-width');
  else button.style.setProperty('--atlas-pin-width', atlasPlacePinWidths[size] + 'px');
}

function setAtlasPlacePinShape(button, shape = 'square') {
  if (button.dataset.pinShape === shape) return;
  if (button.dataset.pinShape === 'teardrop') button.querySelector('.atlas-pin-shape-art').remove();
  button.dataset.pinShape = shape;
  if (shape !== 'teardrop') return;
  const namespace = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(namespace, 'svg');
  svg.classList.add('atlas-pin-shape-art');
  svg.setAttribute('viewBox', `0 0 ${atlasTeardrop.width} ${atlasTeardrop.height}`);
  svg.setAttribute('aria-hidden', 'true');
  svg.setAttribute('focusable', 'false');
  const path = document.createElementNS(namespace, 'path');
  path.setAttribute('d', atlasTeardrop.path);
  svg.append(path);
  button.append(svg);
}

const atlasLinkFields = { pin: 'place', quest: 'quest', activity: 'route', collectible: 'collectible', location: 'location' };

function atlasLinkParams(link, parameters = new URLSearchParams()) {
  for (const [parameter, field] of Object.entries(atlasLinkFields)) {
    if (link[field] !== undefined) parameters.set(parameter, link[field]);
  }
  if (link.quest !== undefined || link.route !== undefined) {
    if (Number.isSafeInteger(link.step) && link.step >= 0) parameters.set('step', link.step + 1);
    if (link.interior !== undefined) parameters.set('inside', link.interior ? '1' : '0');
    if (link.retry) parameters.set('retry', '1');
  }
  return parameters;
}

function readAtlasLink(parameters) {
  const link = {};
  for (const [parameter, field] of Object.entries(atlasLinkFields)) {
    const value = parameters.get(parameter);
    if (value) link[field] = value;
  }
  if (link.quest !== undefined || link.route !== undefined) {
    const step = parameters.get('step') ?? '';
    if (/^[1-9]\d*$/.test(step) && Number.isSafeInteger(Number(step))) link.step = Number(step) - 1;
    const inside = parameters.get('inside');
    if (inside === '0' || inside === '1') link.interior = inside === '1';
    if (parameters.get('retry') === '1') link.retry = true;
  }
  return link;
}

function atlasShareURL(fragment) {
  const url = new URL(window.location.href);
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return undefined;
  url.hash = String(fragment);
  return url.href;
}

function atlasPlaceLink(place) {
  return String(place.linkId ?? place.id ?? JSON.stringify([place.area, place.type, place.name, place.x, place.y]));
}

// Mounts the markup from atlas/render.cjs. The host owns its lifetime and game rules.
function mountAtlas(root, { signal: viewSignal, state: viewState = {}, adapter = {}, autoOpen = true, linkURL } = {}) {
  const mapShell = root.querySelector('.atlas-shell');
  const query = selector => mapShell.querySelector(selector);
  const { world, tiles, quests, objectives, places, placeTypes, questTypes, layerIcons = {}, imageryTrials, mapLocations = [], config } = JSON.parse(root.querySelector('#atlas-data').textContent);
  const byArea = new Map(tiles.map(tile => [tile.id, tile]));
  const locations = new Map(mapLocations.map(location => [location.key, location]));
  for (const { id, label } of tiles) {
    const key = 'area:' + id;
    locations.set(key, { key, type: 'area', area: id, name: label });
  }
  const mapPositions = new WeakMap();
  const { story, onCollectibleProgress, onRouteProgress, resolveLink } = adapter;
  const linkedRouteType = config.linkedRouteType;
  const linkedRouteLabel = config.linkedRouteLabel ?? 'Activity';
  const linkedRoutes = places.flatMap(place => (place.routes ?? []).map(entry => ({ ...entry, place, type: linkedRouteType })));
  const completedRoutes = new Set();
  const viewport = query('#atlas-map');
  const atlasSidebar = setupSidebar(mapShell, true, undefined, viewSignal, viewState.sidebar);
  const storageKey = name => config.storageNamespace + ':' + name;
  const guideHref = (anchor, prerequisite = false) => config.guideHref === undefined ? undefined
    : config.guideHref + (prerequisite && config.guideHref ? '?prerequisite' : '') + '#' + anchor;
  const routeProgressKey = id => adapter.routeProgressKey?.(id) ?? storageKey('route-done:' + id);
  const canvas = query('#atlas-world');
  const markerLayer = query('#atlas-markers');
  const motionMarkers = createMotionMarkerLayer(markerLayer, viewSignal);
  const markerImages = new WeakMap();
  for (const symbol of mapShell.querySelectorAll('[data-atlas-icon]')) {
    attachAtlasPinIcon(symbol, symbol.dataset.atlasIcon, viewSignal);
  }

  function addPinImage(button, target, source) {
    const image = attachAtlasPinIcon(target, source, viewSignal, () => {
      motionMarkerRecords = undefined;
      requestPan();
    });
    if (image) markerImages.set(button, image);
  }

  function loadedPinImage(button) {
    const image = markerImages.get(button);
    return image?.hidden === false ? image : undefined;
  }
  const imageryOptions = new URLSearchParams(location.search);
  const mapImages = [...canvas.querySelectorAll('.atlas-area-image')].map(image => {
    const element = image.parentElement;
    const bounds = byArea.get(element.dataset.area);
    const trial = imageryTrials?.[bounds.id];
    const variant = trial && imageryOptions.get(trial.parameter);
    const selected = variant && Object.hasOwn(trial.variants, variant)
      ? trial.variants[variant] : trial?.variants[trial.defaultVariant];
    return {
      element, bounds, image,
      pyramid: selected ? { levels: selected.levels, tileSize: selected.tileSize,
        fallback: trial.variants.whole?.levels[0]?.tiles[0]?.source ?? image.dataset.detailSrc } : bounds.pyramid,
      imageTemplate: image.cloneNode(false),
      preview: image.dataset.previewSrc,
      medium: image.dataset.mediumSrc,
      detail: image.dataset.detailSrc,
      source: undefined,
      pending: undefined,
    };
  });
  const overviewLayer = canvas.querySelector('.atlas-overview-image');
  const overviewSources = overviewLayer?.getAttributeNames().flatMap(attribute => {
    const match = /^data-overview-(\d+)-src$/.exec(attribute);
    return match ? [{ width: Number(match[1]), source: overviewLayer.getAttribute(attribute) }] : [];
  });
  const imagery = createAtlasImagery({
    areas: mapImages,
    overviewLayer,
    overviewSources,
    world,
    signal: viewSignal,
    onChange: requestPan,
    onFirstArtwork: motionMarkers.warm,
    ownerDocument: canvas.ownerDocument,
  });
  const groupedLabelLayers = [];
  const hasCustomLabelLayers = mapLocations.some(location => location.layer !== undefined);
  const labelLayers = [['street', query('#atlas-streets')], ['district', query('#atlas-districts')]].flatMap(([type, root]) => {
    const groups = hasCustomLabelLayers ? [...root.querySelectorAll('[data-atlas-label-layer]')] : [];
    if (!groups.length) return [[type, type, root]];
    groupedLabelLayers.push({ root, groups });
    return groups.map(group => [type, group.dataset.atlasLabelLayer, group]);
  });
  const pins = query('#atlas-pins');
  const stepPins = query('#atlas-step-pins');
  const questPinColors = Object.fromEntries(Object.values(questTypes).map(({ layer, color }) => [layer, color]));
  questPinColors.cluster = '#454a36';
  const placeLayer = query('#atlas-places');
  const mapTooltip = query('#atlas-collectible-tooltip');
  const tooltipContent = mapTooltip.querySelector('.atlas-tooltip-content');
  const tooltipDetails = new WeakMap();
  const photoThumbnail = query('#atlas-photo-thumbnail');
  const photoViewer = query('#atlas-photo-viewer');
  const openPhoto = photoViewer && mountPhotoViewer(photoViewer, viewSignal, viewport);
  const layerOptions = [...mapShell.querySelectorAll('[data-layer]')];
  const layerById = new Map(layerOptions.map(input => [input.dataset.layer, input]));
  const collectibleTypes = new Set([...mapShell.querySelectorAll('.atlas-collectibles [data-layer]')].map(input => input.dataset.layer));
  const hideCollected = query(story ? '#atlas-unfinished' : '#atlas-hide-collected');
  const collected = new Set();
  const collectibleProgressKey = storageKey('collected:');
  const hideCollectedKey = storageKey('hide-collected');
  const focusSelection = query('#atlas-focus-selection');
  const showAll = query('#atlas-show-all');
  const hideAll = query('#atlas-hide-all');
  const legend = query('.atlas-legend');
  const legendItems = [...legend.querySelectorAll('[data-legend]')];
  const routes = query('.atlas-routes');
  const textMeasure = document.createElement('canvas').getContext('2d');
  const captionFont = '600 12px "Segoe UI", sans-serif';
  textMeasure.font = captionFont;
  const markerTextMeasure = document.createElement('canvas').getContext('2d');
  const captionMetrics = new Map();
  const layerKey = storageKey('visible-layers');
  const focusKey = storageKey('focus-on-selection');
  const selectionKey = storageKey('selection');
  const chapter = query('#atlas-chapter');
  const firstWindow = query('#atlas-window');
  const type = query('#atlas-type');
  const area = query('#atlas-area');
  const objective = query('#atlas-window-objective');
  const linkedRouteFilterNote = query('#atlas-route-filter-note');
  const count = query('#atlas-count');
  const results = query('#atlas-results');
  const resultRows = new Map();
  const resultCollator = new Intl.Collator(undefined, { numeric: true });
  const resultGroups = [...results.querySelectorAll('[data-result-type]')];
  const collectibleResults = query('#atlas-collectible-results');
  const collectibleResultGroups = [...collectibleResults.querySelectorAll('[data-collectible-result-type]')];
  const detail = query('#atlas-detail');
  const sidebarCollectible = document.createElement('div');
  const guideNote = document.createElement('p');
  const selectionPanel = query('#atlas-selection');
  const selectionName = query('#atlas-selection-name');
  const selectionDetails = query('#atlas-selection-collectible');
  const shareButton = query('[data-atlas-share]');
  const shareStatus = query('[data-atlas-share-status]');
  const shareDialog = query('[data-atlas-share-dialog]');
  const shareInput = shareDialog?.querySelector('[data-atlas-share-url]');
  let shareTarget;
  let shareAddress;
  let shareFeedbackTimer;
  const stepProgress = query('#atlas-step-progress');
  const stepText = query('#atlas-step-text');
  const previousStep = query('#atlas-previous-step');
  const nextStep = query('#atlas-next-step');
  const currentStep = stepText.parentElement;
  const stepControls = previousStep.parentElement;
  const selectionDone = query('#atlas-selection-done');
  const clearMapSelection = query('#atlas-clear-selection');
  const showSteps = query('#atlas-show-steps');
  const mapTools = showSteps.parentElement;
  const plus = query('#atlas-plus');
  const minus = query('#atlas-minus');
  const fit = query('#atlas-fit');
  const coarse = matchMedia('(pointer: coarse)');
  const compact = matchMedia('(max-width: 48rem)');
  const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)');
  const pointers = new Map();
  let pressedLocation;
  viewport.toggleAttribute('data-selectable-locations', Boolean(linkURL));
  const dragSamples = [];
  const camera = { x: 0, y: 0, scale: 1 };
  const panMargin = 160;
  const panVelocityWindow = 64;
  const panHistoryLimit = 160;
  const panIdleLimit = 85;
  // CSS pixels per millisecond and per millisecond squared.
  const panMaxSpeed = 1.35;
  const panDeceleration = .00225;
  const maxScale = config.maxScale ?? 12;
  const canvasMarkerThreshold = 64;
  const wheelDuration = 200;
  const wheelStartAdvance = 5;
  const wheelRate = .006;
  const defaultWheelControl = { x: .25, y: .1 };
  const mapLabelScale = config.mapLabelScale ?? 1.7;
  const captionHeight = 21;
  const captionInterval = 32;
  const captionMoveThreshold = 4;
  const captionReturnClearance = 8;
  const collisionCellSize = 64;
  const placeMoveDuration = 180;
  const pinOffsetSteps = [0, 22, -22, 44, -44, 66, -66];
  const pinOffsets = pinOffsetSteps.flatMap(dy => pinOffsetSteps.map(dx => ({ dx, dy })))
    .sort((a, b) => Math.hypot(a.dx, a.dy) - Math.hypot(b.dx, b.dy));
  const labelBounds = new Map();
  const pinPositions = new WeakMap();
  const preferredCaptionSlots = new WeakMap();
  const placeControls = new Map();
  const placeMoves = new Map();
  let questControls = new Map();
  const motionPaint = new WeakMap();
  const questMotionText = '700 12.48px "Segoe UI", sans-serif';
  markerTextMeasure.font = questMotionText;
  const mapPanels = [mapTools, selectionPanel, legend];
  let viewportWidth = 0;
  let viewportHeight = 0;
  let viewportOrigin;
  let panelBounds;
  let frame;
  let cameraMotion;
  let pendingWheel;
  let fullDrawNeeded = false;
  let mapLabelsVisible = false;
  let markerView;
  let markersTranslated = false;
  let markerProjectionScale = 1;
  let projectedMarkers = [];
  let motionMarkerRecords;
  let captionView;
  let lastCaptionLayout;
  let matches = [];
  let matchingRoutes = [];
  let selectedRoute;
  let selectedPlace;
  let selectedLocation;
  let selectedLocationElements = [];
  let selectedCollectibleEntry;
  let focusPlaceSelection = false;
  let selectedCluster;
  let showLinkedRouteSteps = false;
  let linkedRouteStep = 0;
  let selected;
  let guideState;
  let spotlight;
  let expanded;
  let markerFocus;
  let previousSize;
  let overview = true;
  let fittedSteps;
  let mapTooltipPin;

  function clamp(value, min, max) {
    return Math.max(min, Math.min(value, max));
  }

  function moveElement(element, x, y, transform = '') {
    element.style.transform = `translate(${x}px, ${y}px)${transform}`;
  }

  function movePin(pin, x, y, anchor = { x, y }) {
    const previous = pinPositions.get(pin);
    pinPositions.set(pin, { x, y, anchor });
    if (markerProjectionScale !== 1 || previous?.x !== x || previous?.y !== y) moveElement(pin, x, y);
  }

  function createPinLine(x, y, dx, dy) {
    const line = document.createElement('span');
    line.className = 'atlas-pin-line';
    line.setAttribute('aria-hidden', 'true');
    const length = Math.max(1, Math.hypot(dx, dy));
    pinPositions.set(line, { x, y, anchor: { x, y }, line: true });
    motionPaint.set(line, { dx, dy, color: '#ffe3a5', width: 2, dot: 3 });
    line.style.translate = `${x}px ${y}px`;
    line.style.transform = `rotate(${Math.atan2(dy, dx)}rad) scaleX(${length})`;
    line.style.setProperty('--pin-line-dot-scale', 1 / length);
    return line;
  }

  function projectMarkers(ratio) {
    if (ratio === markerProjectionScale) return;
    markerProjectionScale = ratio;
    // Project the map point and keep collision offsets, icons and captions in screen pixels.
    const change = ratio - 1;
    for (const { element, x, y, anchor, line } of projectedMarkers) {
      const left = x + anchor.x * change;
      const top = y + anchor.y * change;
      if (line) element.style.translate = `${left}px ${top}px`;
      else moveElement(element, left, top);
    }
  }

  function updateViewportSize(width, height) {
    viewportWidth = Math.round(width);
    viewportHeight = Math.round(height);
    viewportOrigin = undefined;
    panelBounds = undefined;
  }

  function getPanelBounds() {
    panelBounds ??= new Map((compact.matches ? [] : mapPanels.filter(panel => !panel.hidden)).map(panel => [panel, {
      x: panel.offsetLeft, y: panel.offsetTop, w: panel.offsetWidth, h: panel.offsetHeight,
    }]));
    return panelBounds;
  }

  function getLabelBounds(layer) {
    if (!labelBounds.has(layer)) {
      const origin = canvas.getBoundingClientRect();
      const scale = camera.scale;
      // Keep the rendered bounds of rotated and curved text in map coordinates.
      labelBounds.set(layer, [...layer.querySelectorAll('.atlas-map-label')].map(label => {
        const box = label.getBoundingClientRect();
        return { key: label.dataset.atlasLocation, x: (box.left - origin.left) / scale, y: (box.top - origin.top) / scale,
          w: box.width / scale, h: box.height / scale };
      }));
    }
    return labelBounds.get(layer);
  }

  function placeInfo(place) {
    return [place.location || byArea.get(place.area).label, place.groupLabel ?? placeTypes[place.type]?.label,
      place.approximate && 'Approximate pin'].filter(Boolean).join(' · ');
  }

  function appendSummaryText(container, text, className) {
    if (!text) return;
    const paragraph = document.createElement('p');
    if (className) paragraph.className = className;
    paragraph.textContent = text;
    container.append(paragraph);
  }

  function appendRouteSummary(container, route, point, interactive = false) {
    const location = point?.location || (point && byArea.get(point.area).label);
    appendSummaryText(container, [route.type, route.window && `First window ${route.window}`, location].filter(Boolean).join(' · '), 'quest-meta');
    appendSummaryText(container, route.where);
    appendSummaryText(container, route.target && `Target · ${route.target}`);
    appendSummaryText(container, route.unlock && `Story unlock · ${route.unlock}`);
    if (route.prerequisites) container.append(prerequisiteSummary(route.prerequisites.parts, interactive));
    appendSummaryText(container, [route.time, route.picture && `Picture ${route.picture}`].filter(Boolean).join(' · '));
  }

  function collectibleProgressIds(place) {
    if (place.repeatable) return [];
    if (place.pickup) return [place.pickup.progressId];
    return (place.entries ?? []).map(entry => entry.progressId).filter(Boolean);
  }

  function isCollected(place) {
    const ids = collectibleProgressIds(place);
    return ids.length > 0 && ids.every(id => collected.has(id));
  }

  function visibleCollectibleEntries(place) {
    const entries = place.entries ?? [];
    if (!hideCollected.checked) return entries;
    const remaining = entries.filter(entry => !collected.has(entry.progressId));
    return remaining.length ? remaining : entries;
  }

  function appendPhotoPreview(container, photo, name) {
    const inTooltip = container === tooltipContent;
    const button = photoThumbnail.content.firstElementChild.cloneNode(true);
    button.setAttribute('aria-label', `Enlarge location photo for ${name}`);
    if (inTooltip) button.tabIndex = -1;
    const image = button.querySelector('img');
    image.src = photo.preview;
    image.width = photo.width;
    image.height = photo.height;
    button.addEventListener('click', () => {
      const trigger = inTooltip ? mapTooltipPin : button;
      hideMapTooltip();
      openPhoto(photo, name, trigger);
    });
    if (inTooltip) container.prepend(button);
    else container.append(button);
  }

  function appendCollectibleDetails(container, place, interactive) {
    const paragraph = (text, className) => {
      const element = document.createElement('p');
      if (className) element.className = className;
      element.textContent = text;
      container.append(element);
    };
    const checkbox = (id, name) => {
      if (!interactive || !id) return;
      const label = document.createElement('label');
      label.className = 'atlas-collected-check';
      const input = document.createElement('input');
      input.type = 'checkbox';
      input.autocomplete = 'off';
      input.dataset.collectibleCollected = id;
      input.checked = collected.has(id);
      input.setAttribute('aria-label', `Collected ${name}`);
      label.append(input, ' Collected');
      container.append(label);
    };
    const guideLink = (anchor, label) => {
      const href = anchor && guideHref(anchor);
      if (!interactive || !href) return;
      const link = document.createElement('a');
      link.href = href;
      link.textContent = label;
      const line = document.createElement('p');
      line.append(link);
      container.append(line);
    };

    if (place.pickup) {
      const { progressId, summary: info, steps: directions, reward, note, link, photo } = place.pickup;
      checkbox(progressId, place.name);
      if (info) paragraph(info, 'quest-meta');
      const steps = document.createElement('ol');
      steps.className = 'atlas-step-list';
      for (const step of directions ?? []) {
        const item = document.createElement('li');
        item.textContent = step;
        steps.append(item);
      }
      container.append(steps);
      if (interactive && photo) appendPhotoPreview(container, photo, place.name);
      if (reward) paragraph(reward);
      if (note) paragraph(note);
      if (link) guideLink(link.anchor, link.label);
      return;
    }

    let entries = visibleCollectibleEntries(place);
    if (interactive && selectedPlace === place && selectedCollectibleEntry) {
      entries = [selectedCollectibleEntry, ...entries.filter(entry => entry !== selectedCollectibleEntry)];
    }
    for (const entry of entries) {
      if (place.entries.length > 1 && !(container === selectionDetails && entry === selectedCollectibleEntry)) {
        const heading = document.createElement('h3');
        heading.textContent = entry.name;
        container.append(heading);
      }
      checkbox(place.repeatable ? undefined : entry.progressId, entry.name);
      const info = [entry.window && `Story window ${entry.window}`, entry.approximate && 'Approximate location'].filter(Boolean).join(' · ');
      if (info) paragraph(info, 'quest-meta');
      paragraph(entry.detail);
      for (const link of entry.links ?? []) guideLink(link.anchor, link.label);
      if ((place.entries.length === 1 || entry === selectedCollectibleEntry) && entry.guideLink) {
        guideLink(entry.guideLink.anchor, entry.guideLink.label);
      }
    }
  }

  function hideMapTooltip() {
    if (!mapTooltipPin) return;
    mapTooltipPin.removeAttribute('aria-describedby');
    mapTooltipPin = undefined;
    mapTooltip.hidden = true;
  }

  function showMapTooltip(pin) {
    if (pin === mapTooltipPin || pointers.size || cameraMotion || pendingWheel || placeMoves.has(pin)) return;
    const { name, photo, renderDetails } = tooltipDetails.get(pin);
    hideMapTooltip();
    mapTooltipPin = pin;
    const title = document.createElement('strong');
    title.textContent = name;
    title.setAttribute('aria-hidden', 'true');
    const details = document.createElement('div');
    details.className = 'atlas-tooltip-details';
    details.append(title);
    renderDetails(details);
    tooltipContent.replaceChildren(details);
    if (photo) appendPhotoPreview(tooltipContent, photo, name);
    const hasPhoto = Boolean(photo);
    mapTooltip.toggleAttribute('data-has-photo', hasPhoto);
    mapTooltip.setAttribute('role', hasPhoto ? 'region' : 'tooltip');
    if (hasPhoto) mapTooltip.setAttribute('aria-label', name);
    else mapTooltip.removeAttribute('aria-label');
    tooltipContent.style.maxHeight = '';
    mapTooltip.hidden = false;

    const { x: pinX, y: pinY } = pinPositions.get(pin);
    const pinHeight = pin.offsetHeight;
    const fromTop = pin.dataset.pinShape === 'teardrop' ? pinHeight : pinHeight / 2;
    const padding = 8;
    const gap = 8;
    const above = pinY - fromTop - gap;
    const below = pinY + pinHeight - fromTop + gap;
    const naturalHeight = mapTooltip.offsetHeight;
    const width = mapTooltip.offsetWidth;
    const aboveFits = above - naturalHeight >= padding;
    const belowFits = below + naturalHeight <= viewportHeight - padding;
    const placeAbove = aboveFits || (!belowFits && above >= viewportHeight - below);
    let height = naturalHeight;
    if (!aboveFits && !belowFits) {
      const available = placeAbove ? above - padding : viewportHeight - below - padding;
      const maxHeight = Math.max(40, available - 2);
      tooltipContent.style.maxHeight = `${maxHeight}px`;
      height = Math.min(naturalHeight, maxHeight + 2);
    }
    const left = clamp(pinX - width / 2, padding, viewportWidth - width - padding);
    const top = clamp(placeAbove ? above - height : below, padding, viewportHeight - height - padding);
    moveElement(mapTooltip, left, top);
    mapTooltip.style.setProperty('--tooltip-arrow-x', `${clamp(pinX - left, 9, width - 9)}px`);
    mapTooltip.classList.toggle('above-pin', placeAbove);
    tooltipContent.scrollTop = 0;
    pin.setAttribute('aria-describedby', mapTooltip.id);
  }

  function tooltipPin(target) {
    const pin = target?.closest?.('button');
    return tooltipDetails.has(pin) ? pin : undefined;
  }

  markerLayer.addEventListener('pointerover', event => {
    if (event.pointerType === 'touch' || event.buttons) return;
    const pin = tooltipPin(event.target);
    if (pin && pin !== tooltipPin(event.relatedTarget)) showMapTooltip(pin);
  });
  markerLayer.addEventListener('pointerout', event => {
    if (mapTooltipPin && tooltipPin(event.target) === mapTooltipPin && tooltipPin(event.relatedTarget) !== mapTooltipPin
      && !mapTooltip.contains(event.relatedTarget)) {
      hideMapTooltip();
    }
  });
  mapTooltip.addEventListener('pointerout', event => {
    if (!mapTooltip.contains(event.relatedTarget) && tooltipPin(event.relatedTarget) !== mapTooltipPin) hideMapTooltip();
  });
  markerLayer.addEventListener('focusin', event => {
    const pin = tooltipPin(event.target);
    if (pin?.matches(':focus-visible')) showMapTooltip(pin);
  });
  markerLayer.addEventListener('focusout', event => {
    if (event.target === mapTooltipPin && !mapTooltip.contains(event.relatedTarget)) hideMapTooltip();
  });

  function visible(id) {
    return layerById.get(id)?.checked ?? false;
  }

  function questLayer(quest) {
    return questTypes[quest.type].layer;
  }

  function isCollectible(place) {
    return collectibleTypes.has(place.type);
  }

  function canOffsetPin(place) {
    return Boolean(place.routes) || isCollectible(place);
  }

  function usesPinOffset(place) {
    return place.offsetPin === true || canOffsetPin(place);
  }

  function updateLegend(focusedTypes) {
    const showClusters = Object.values(questTypes).some(({ layer }) => visible(layer));
    for (const item of legendItems) {
      const layer = item.dataset.legend;
      const shown = focusedTypes && layer !== 'routes'
        ? focusedTypes.has(item.dataset.legendVariant ?? layer)
        : layer === 'cluster' ? showClusters : visible(layer);
      if (item.hidden === shown) {
        item.hidden = !shown;
        panelBounds = undefined;
      }
    }
    legend.hidden = legendItems.every(item => item.hidden);
  }

  function updateLayers(save = true) {
    expanded = undefined;
    showAll.disabled = layerOptions.every(input => input.checked);
    hideAll.disabled = layerOptions.every(input => !input.checked);
    if (save) {
      try {
        localStorage.setItem(layerKey, JSON.stringify({ layers: [...layerById.keys()],
          hidden: layerOptions.filter(input => !input.checked).map(input => input.dataset.layer) }));
      } catch {
        // The atlas still works when file storage is unavailable.
      }
    }
    requestDraw();
  }

  function fitScale(width = world.width, height = world.height) {
    const padding = viewportWidth < 600 ? 18 : 40;
    return Math.max(.01, Math.min((viewportWidth - padding * 2) / width,
      (viewportHeight - padding * 2) / height));
  }

  function constrainCamera(view) {
    view.x = clamp(view.x, 32 - world.width * view.scale, viewportWidth - 32);
    view.y = clamp(view.y, 32 - world.height * view.scale, viewportHeight - 32);
    return view;
  }

  function recordDragPosition(time) {
    const last = dragSamples.at(-1);
    if (last?.x === camera.x && last.y === camera.y) return;
    while (dragSamples.length && dragSamples[0].time < time - panHistoryLimit) dragSamples.shift();
    dragSamples.push({ x: camera.x, y: camera.y, time });
  }

  function startPanInertia(time) {
    const last = dragSamples.at(-1);
    if (reducedMotion.matches || dragSamples.length < 2 || time - last.time >= panIdleLimit) return false;
    // Time between the last movement and mouse-up counts as part of the velocity sample.
    let index = dragSamples.length - 2;
    while (index > 0 && dragSamples[index - 1].time >= time - panVelocityWindow) index--;
    const first = dragSamples[index];
    if (time - first.time > panHistoryLimit) return false;
    const elapsed = Math.max(16, time - first.time);
    const dx = last.x - first.x;
    const dy = last.y - first.y;
    const distance = Math.hypot(dx, dy);
    const speed = Math.min(distance / elapsed, panMaxSpeed);
    if (speed < .06) return false;

    // Constant deceleration travels half the initial speed times the stopping time.
    const duration = speed / panDeceleration;
    const travel = speed * duration / (2 * distance);
    const start = { ...camera };
    const destination = constrainCamera({
      x: start.x + dx * travel, y: start.y + dy * travel, scale: start.scale,
    });
    if (Math.hypot(destination.x - start.x, destination.y - start.y) < 2) return false;
    cameraMotion = { start, destination, duration, inertia: true, time: performance.now() };
    return true;
  }

  function moveCamera(destination, animate, { fly = false, stepZoomRatio } = {}) {
    pendingWheel = undefined;
    constrainCamera(destination);
    if (animate && markerView && !reducedMotion.matches) {
      const target = cameraMotion?.destination ?? camera;
      if (target.x === destination.x && target.y === destination.y && target.scale === destination.scale) {
        requestDraw();
        return;
      }
      const start = { ...camera };
      const centerX = viewportWidth / 2;
      const centerY = viewportHeight / 2;
      const dx = (centerX - destination.x) / destination.scale - (centerX - start.x) / start.scale;
      const dy = (centerY - destination.y) / destination.scale - (centerY - start.y) / start.scale;
      const widerScale = Math.min(start.scale, destination.scale);
      // Measure how many screens we cross at the wider of the two views.
      const travel = Math.max(Math.abs(dx) / viewportWidth, Math.abs(dy) / viewportHeight) * widerScale;
      const zoomChange = Math.abs(Math.log2(destination.scale / start.scale));
      const baseDuration = 520 + Math.min(880, 220 * Math.log2(1 + travel) + 145 * zoomChange);
      const zoomRatio = stepZoomRatio ?? (fly ? 1 / (1 + 1.3 * Math.max(0, travel - .55)) : 1);
      const widestScale = Math.min(widerScale, Math.max(fitScale(), widerScale * zoomRatio));
      let duration = baseDuration;
      if (fly) duration += 160 + 105 * Math.max(0, Math.log2(destination.scale / start.scale));
      let flight;
      if (widestScale < widerScale) {
        const levelsOut = Math.log2(start.scale / widestScale);
        const levelsIn = Math.log2(destination.scale / widestScale);
        duration = baseDuration + 440 + 165 * Math.max(levelsOut, levelsIn);
        const turn = .33 + .14 * levelsOut / (levelsOut + levelsIn);
        flight = { scale: widestScale, turn };
      }
      cameraMotion = { start, destination, duration, flight, time: performance.now() };
    } else {
      cameraMotion = undefined;
      Object.assign(camera, destination);
    }
    requestDraw();
  }

  function centerAt(x, y, scale, targetY = viewportHeight / 2, animate = true, stepZoomRatio) {
    fittedSteps = undefined;
    expanded = undefined;
    const next = clamp(scale, fitScale(), maxScale);
    moveCamera({ x: viewportWidth / 2 - x * next, y: targetY - y * next, scale: next }, animate, { fly: true, stepZoomRatio });
  }

  function fitAll(animate = true) {
    overview = true;
    area.value = '';
    centerAt(world.width / 2, world.height / 2, fitScale(), viewportHeight / 2, animate);
  }

  function zoomAt(scale, anchor, { target = anchor, animate = false, from = camera } = {}) {
    if (cameraMotion && (!animate || cameraMotion.inertia)) {
      cameraMotion = undefined;
      requestDraw();
    }
    const next = clamp(scale, fitScale(), maxScale);
    if (next === from.scale && target.x === anchor.x && target.y === anchor.y) return;
    fittedSteps = undefined;
    expanded = undefined;
    const factor = next / from.scale;
    overview = false;
    moveCamera({
      x: target.x - (anchor.x - from.x) * factor,
      y: target.y - (anchor.y - from.y) * factor,
      scale: next,
    }, animate);
  }

  function zoomBy(factor) {
    const anchor = { x: viewportWidth / 2, y: viewportHeight / 2 };
    const target = cameraMotion?.inertia ? camera : cameraMotion?.destination ?? camera;
    zoomAt(target.scale * factor, anchor, { animate: true, from: target });
  }

  function worldPoint(point) {
    let position = mapPositions.get(point);
    if (!position) {
      const tile = byArea.get(point.area);
      position = { x: tile.x + point.x * tile.w, y: tile.y + point.y * tile.h };
      mapPositions.set(point, position);
    }
    return position;
  }

  function routeZoomRatio(previous, next) {
    if (!previous) return 1;
    const from = worldPoint(previous);
    const to = worldPoint(next);
    // Use a fixed atlas distance so the amount of zoom-out doesn't depend on the viewport.
    const distance = Math.hypot(to.x - from.x, to.y - from.y);
    const fraction = clamp((distance - 40) / (.35 * Math.hypot(world.width, world.height)), 0, 1);
    return 1 - .68 * fraction * (2 - fraction);
  }

  function screenPoint(point) {
    const position = worldPoint(point);
    return { x: camera.x + position.x * camera.scale, y: camera.y + position.y * camera.scale };
  }

  function focusTile(tile, point, stepZoomRatio, { w, h } = tile) {
    const position = point ? worldPoint(point) : { x: tile.x + tile.w / 2, y: tile.y + tile.h / 2 };
    const scale = Math.min(viewportWidth * .75 / w, viewportHeight * .75 / h);
    overview = false;
    let targetY = viewportHeight / 2;
    const panel = point && !selectionPanel.hidden ? getPanelBounds().get(selectionPanel) : undefined;
    if (panel && panel.x + panel.w + 16 >= viewportWidth / 2) {
      const top = panel.y + panel.h + 18;
      const bottom = viewportHeight - 18;
      if (top < bottom) targetY = (top + bottom) / 2;
    }
    area.value = tile.id;
    centerAt(position.x, position.y, scale, targetY, true, stepZoomRatio);
  }

  function letterLabel(letter) {
    return letter === 'board' ? 'Board' : letter;
  }

  function saveSelection() {
    try {
      const route = selected?.quest ?? selectedRoute;
      if (route) localStorage.setItem(selectionKey, JSON.stringify({ id: route.id, step: selected?.step ?? linkedRouteStep,
        ...(selectedRoute && { kind: 'route' }), ...(selectedRoute?.retry && { retry: true }) }));
      else localStorage.removeItem(selectionKey);
    } catch {
      // Selection still works in the current view when storage is unavailable.
    }
  }

  function restoreSelection(explicitId, restoring = false, explicitStep, interior) {
    let saved;
    try {
      saved = JSON.parse(localStorage.getItem(selectionKey));
    } catch {
      // An unreadable selection is treated as a fresh visit.
    }
    if (explicitId === undefined && (saved?.kind === 'route'
      || (typeof saved?.id === 'string' && !quests.some(quest => quest.id === saved.id)))) {
      const linkedRoute = matchingRoutes.find(entry => entry.id === saved.id);
      if (linkedRoute) openLinkedRoute(linkedRoute, Boolean(saved.retry) === Boolean(linkedRoute.retry) ? saved.step : 0);
      return;
    }
    const explicitQuest = explicitId === undefined ? undefined : quests.find(quest => String(quest.id) === String(explicitId));
    const quest = explicitQuest ?? matches.find(quest => quest.id === saved?.id);
    if (!quest) return;
    if (explicitQuest && (!matches.includes(quest) || !visible(questLayer(quest)))) spotlight = quest;
    const step = explicitStep !== undefined ? (quest.steps[Number(explicitStep)] ? Number(explicitStep) : 0)
      : saved?.id === quest.id && Number.isInteger(saved.step) && saved.step >= 0 && saved.step < quest.steps.length
      ? saved.step : 0;
    const point = (interior && quest.interior) || quest.pin;
    const lastMapped = quest.steps.slice(0, step + 1).findLast(entry => quest.locations[entry.letter]);
    const viewPoint = interior !== undefined ? point : quest.locations[lastMapped?.letter] ?? point;
    showQuest(quest, point, {
      recenter: !restoring, step, viewPoint,
      fitRoute: restoring ? viewState.fitSteps : explicitStep === undefined && interior === undefined && (Boolean(explicitQuest) || step === 0),
      scrollToDetail: Boolean(explicitQuest) && !restoring,
    });
  }

  function setSelectedDone(event) {
    if (selectedRoute) {
      setRouteDone(selectedRoute.id, event.currentTarget.checked);
      return;
    }
    const checked = event.currentTarget.checked;
    const { id } = selected.quest;
    try {
      story.setDone(id, checked);
    } catch {
      // Keep the current map state when file storage is unavailable.
    }
    if (checked) guideState.completed.add(id);
    else guideState.completed.delete(id);
    readMapStoryFilters(guideState.completed, true);
  }

  function selectionLink() {
    if (selected) return { quest: selected.quest.id, step: selected.step, interior: selected.interior };
    if (selectedRoute) return { route: selectedRoute.id, step: linkedRouteStep, retry: selectedRoute.retry };
    if (selectedCollectibleEntry) return { collectible: collectibleEntryKey(selectedPlace, selectedCollectibleEntry) };
    if (selectedPlace) {
      const id = atlasPlaceLink(selectedPlace);
      if (places.find(place => atlasPlaceLink(place) === id) === selectedPlace) return { place: id };
    }
    if (selectedLocation) return { location: selectedLocation.key };
  }

  function renderSelectionPanel() {
    panelBounds = undefined;
    const route = selected?.quest ?? selectedRoute;
    selectionPanel.hidden = !route && !selectedPlace && !selectedCluster && !selectedLocation;
    currentStep.hidden = !route;
    stepControls.hidden = !route;
    selectionDetails.hidden = selectionPanel.hidden;
    if (shareButton && linkURL) {
      const link = selectionLink();
      const address = link && linkURL(link);
      if (address !== shareAddress) {
        clearTimeout(shareFeedbackTimer);
        shareStatus.textContent = '';
      }
      shareTarget = link;
      shareAddress = address;
      shareButton.hidden = !address;
    }
    selectionDetails.replaceChildren();
    const index = selected?.step ?? linkedRouteStep;
    const step = route?.steps[index];
    const name = selected ? `#${route.id} ${route.name}`
      : route?.name ?? selectedCollectibleEntry?.name ?? selectedPlace?.name ?? selectedLocation?.name
        ?? (selectedCluster && clusterName(selectedCluster));
    const label = step?.letter === 'board' ? 'Board' : step?.letter ? `Pin ${step.letter}` : '';
    if (route) {
      const point = route.locations[step.letter];
      if (point?.photo) appendPhotoPreview(selectionDetails, point.photo, `${name} · ${label}`);
      appendRouteSummary(selectionDetails, route, point ?? selected?.point ?? selectedPlace, true);
    } else if (selectedPlace) {
      appendPlaceSummary(selectionDetails, selectedPlace, true);
    } else if (selectedCluster) {
      selectionDetails.append(clusterList(selectedCluster, true));
    } else if (selectedLocation?.type === 'area') {
      selectionDetails.hidden = true;
    } else if (selectedLocation) {
      const type = config.locationTypeLabels?.[selectedLocation.type] ?? (selectedLocation.type === 'street' ? 'Street' : 'District');
      appendSummaryText(selectionDetails, `${type} · ${byArea.get(selectedLocation.area).label}`, 'quest-meta');
    }
    showSteps.hidden = !route;
    showSteps.textContent = selectedRoute ? linkedRouteLabel + ' steps' : 'Quest steps';
    if (name && selectionName.textContent !== name) selectionName.textContent = name;
    if (!route) {
      selectionDetails.scrollTop = 0;
      return;
    }
    selectionDone.parentElement.hidden = !selectedRoute && !story;
    selectionDone.checked = selectedRoute ? completedRoutes.has(route.id) : Boolean(guideState?.completed.has(route.id));
    stepProgress.textContent = `Step ${index + 1} of ${route.steps.length}${label ? ` · ${label}` : ''}`;
    stepText.textContent = step.text;
    previousStep.disabled = index === 0;
    nextStep.disabled = index === route.steps.length - 1;
    selectionDetails.scrollTop = 0;
    stepText.scrollTop = 0;
  }

  function activateStep(index, recenter) {
    const route = selected?.quest ?? selectedRoute;
    const step = route?.steps[index];
    if (!step) return;
    const previousPoint = route.locations[route.steps[selected?.step ?? linkedRouteStep]?.letter];
    const point = route.locations[step.letter];
    if (selected) {
      selected.step = index;
      if (recenter && point) selected.interior = undefined;
    } else linkedRouteStep = index;
    saveSelection();
    renderSelectionPanel();
    for (const [rowIndex, row] of [...detail.querySelectorAll('.atlas-step-list > li')].entries()) {
      const current = rowIndex === index;
      row.setAttribute('aria-current', current ? 'step' : 'false');
      row.querySelector('button')?.setAttribute('aria-pressed', String(current));
    }
    if (recenter && point) {
      focusTile(byArea.get(point.area), point, routeZoomRatio(previousPoint, point));
      viewport.scrollIntoView({ block: 'nearest' });
    } else {
      if (!recenter && !compact.matches && !atlasSidebar.collapsed) {
        detail.querySelector(`[data-step-index="${index}"]`)?.scrollIntoView({ block: 'nearest', container: 'nearest' });
      }
      requestDraw();
    }
  }

  function fitQuestSteps(locations) {
    const points = Object.values(locations).map(worldPoint);
    const xs = points.map(({ x }) => x);
    const ys = points.map(({ y }) => y);
    const left = Math.min(...xs), right = Math.max(...xs);
    const top = Math.min(...ys), bottom = Math.max(...ys);
    const panels = getPanelBounds();
    const selection = panels.get(selectionPanel);
    const tools = panels.get(mapTools);
    const key = panels.get(legend);
    let frameTop = Math.max(selection ? selection.y + selection.h : 0, tools ? tools.y + tools.h : 0);
    let frameBottom = key?.y ?? viewportHeight;
    const verticalSpan = Math.max(70, bottom - top);
    if (frameBottom - frameTop < verticalSpan * fitScale() + 64) {
      frameTop = 0;
      frameBottom = viewportHeight;
    }
    const inset = Math.min(coarse.matches ? 60 : 52, Math.max(32, (frameBottom - frameTop - verticalSpan * fitScale()) / 2));
    const scale = Math.min((viewportWidth - 2 * inset) / Math.max(70, right - left),
      (frameBottom - frameTop - 2 * inset) / verticalSpan, 4);
    overview = false;
    area.value = '';
    centerAt((left + right) / 2, (top + bottom) / 2, scale, (frameTop + frameBottom) / 2);
    fittedSteps = locations;
  }

  function appendRouteSteps(route, current, selectStep, label) {
    const heading = document.createElement('h3');
    heading.textContent = label;
    const list = document.createElement('ol');
    list.className = 'atlas-step-list';
    const shownPhotos = new Set();
    for (const [index, step] of route.steps.entries()) {
      const row = document.createElement('li');
      row.setAttribute('aria-current', index === current ? 'step' : 'false');
      const point = route.locations[step.letter];
      if (point) {
        const button = document.createElement('button');
        button.type = 'button';
        button.dataset.stepIndex = index;
        button.setAttribute('aria-pressed', String(index === current));
        const badge = document.createElement('span');
        badge.className = 'atlas-step-badge';
        badge.textContent = letterLabel(step.letter);
        const copy = document.createElement('span');
        const location = document.createElement('small');
        const precision = { approximate: ' · Approximate', building: ' · Building', entrance: ' · Entrance' }[point.precision] ?? '';
        location.textContent = byArea.get(point.area).label + precision;
        copy.append(step.text, location);
        button.append(badge, copy);
        button.addEventListener('click', () => selectStep(index));
        row.append(button);
        if (point.photo && !shownPhotos.has(step.letter)) {
          appendPhotoPreview(row, point.photo, `${route.name} · Pin ${letterLabel(step.letter)}`);
          shownPhotos.add(step.letter);
        }
      } else {
        row.textContent = step.text;
      }
      list.append(row);
    }
    if (label) detail.append(heading);
    detail.append(list);
  }

  function drawStepPins(margin) {
    const route = selected?.quest ?? selectedRoute;
    if (!route || !(visible('steps') || showLinkedRouteSteps)) return [];
    const step = selected?.step ?? linkedRouteStep;
    const drawn = [];
    const occupied = [];
    const gap = coarse.matches ? 40 : 32;
    const offsets = [[0, 0], [0, -gap], [gap, 0], [0, gap], [-gap, 0], [gap, -gap], [-gap, gap]];
    for (const [letter, point] of Object.entries(route.locations)) {
      const anchor = screenPoint(point);
      if (anchor.x < -margin || anchor.x > viewportWidth + margin || anchor.y < -margin || anchor.y > viewportHeight + margin) continue;
      const halfWidth = letter === 'board' ? 26 : gap / 2;
      const position = offsets.map(([x, y]) => ({ x: anchor.x + x, y: anchor.y + y })).find(({ x, y }) =>
        x >= halfWidth - margin && x <= viewportWidth + margin - halfWidth
        && y >= gap / 2 - margin && y <= viewportHeight + margin - gap / 2
        && !occupied.some(other => Math.abs(other.x - x) < other.halfWidth + halfWidth && Math.abs(other.y - y) < gap)) ?? anchor;
      occupied.push({ ...position, halfWidth });
      if (position.x !== anchor.x || position.y !== anchor.y) {
        const dx = position.x - anchor.x, dy = position.y - anchor.y;
        drawn.push(createPinLine(anchor.x, anchor.y, dx, dy));
      }
      const active = route.steps[step]?.letter === letter;
      const index = active ? step : route.steps.findIndex(item => item.letter === letter);
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'atlas-pin atlas-step-pin';
      button.dataset.stepPin = letter;
      movePin(button, position.x, position.y, anchor);
      button.textContent = letterLabel(letter);
      addPinImage(button, button, point.icon ?? layerIcons.steps);
      button.setAttribute('aria-label', `${letterLabel(letter)} · ${route.steps[index].text}`);
      const title = selected ? `#${route.id} ${route.name}` : route.name;
      const label = letter === 'board' ? 'Board' : `Pin ${letter}`;
      tooltipDetails.set(button, {
        name: `${title} · ${label}`, photo: point.photo, renderDetails: container => appendRouteSummary(container, route, point),
      });
      button.setAttribute('aria-controls', 'atlas-detail');
      button.setAttribute('aria-pressed', String(active));
      button.addEventListener('click', () => activateStep(index, false));
      drawn.push(button);
    }
    return drawn;
  }

  function prerequisiteLink({ id, text }) {
    const link = document.createElement('a');
    link.href = guideHref('quest-' + id, true);
    link.dataset.prerequisite = '';
    link.textContent = text;
    return link;
  }

  function prerequisiteSummary(parts, interactive) {
    const note = document.createElement('p');
    note.className = 'atlas-prerequisites';
    note.append('Requires · ', ...parts.map(part => interactive && part.id && guideHref('quest-' + part.id) ? prerequisiteLink(part) : part.text));
    return note;
  }

  function appendPrerequisites({ parts, links }) {
    detail.append(prerequisiteSummary(parts, true));
    if (links.length && config.guideHref !== undefined) {
      const group = document.createElement('details');
      group.className = 'quest-prerequisite-links';
      const summary = document.createElement('summary');
      summary.textContent = `Browse ${links.length} required quests`;
      const list = document.createElement('ul');
      for (const link of links) {
        const item = document.createElement('li');
        item.append(prerequisiteLink(link));
        list.append(item);
      }
      group.append(summary, list);
      detail.append(group);
    }
  }

  function updateGuideNote(questId) {
    const note = guideState?.notes[questId];
    const text = note?.text ?? '';
    if (guideNote.textContent !== text) guideNote.textContent = text;
    guideNote.hidden = !text;
    guideNote.classList.toggle('quest-prerequisite-warning', Boolean(note?.prerequisiteWarning));
  }

  function showQuest(quest, point, {
    recenter = false, step = 0, viewPoint = quest.locations[quest.steps[step].letter] ?? point,
    fitRoute = true, scrollToDetail = true,
  } = {}) {
    selectedRoute = undefined;
    selectedPlace = undefined;
    setSelectedLocation();
    selectedCollectibleEntry = undefined;
    focusPlaceSelection = false;
    selectedCluster = undefined;
    fittedSteps = undefined;
    showLinkedRouteSteps = false;
    expanded = undefined;
    if (spotlight !== quest) spotlight = undefined;
    const interior = quest.interior && (viewPoint === quest.interior ? true : viewPoint === quest.pin ? false : undefined);
    selected = { quest, point, step, interior };
    saveSelection();
    renderSelectionPanel();
    detail.hidden = false;
    const title = document.createElement('h2');
    title.textContent = `#${quest.id} ${quest.name}`;
    const start = document.createElement('p');
    start.textContent = quest.where;
    const meta = document.createElement('p');
    meta.className = 'quest-meta';
    meta.textContent = [quest.window && `First window ${quest.window}`, byArea.get(viewPoint.area).label].filter(Boolean).join(' · ');
    const actions = document.createElement('div');
    actions.className = 'detail-actions';
    const href = guideHref('quest-' + quest.id);
    if (href) {
      const walkthrough = document.createElement('a');
      walkthrough.href = href;
      walkthrough.textContent = 'Open walkthrough';
      actions.append(walkthrough);
    }
    if (story) {
      const label = document.createElement('label');
      label.className = 'atlas-done';
      const checkbox = document.createElement('input');
      checkbox.type = 'checkbox';
      checkbox.checked = selectionDone.checked;
      checkbox.addEventListener('change', setSelectedDone);
      label.append(checkbox, 'Done');
      actions.append(label);
    }
    if (quest.interior) {
      const inside = viewPoint.area === quest.interior.area;
      const toggle = document.createElement('button');
      toggle.type = 'button';
      toggle.textContent = inside ? 'Show building' : 'Show inside';
      toggle.addEventListener('click', () => {
        const destination = inside ? quest.pin : quest.interior;
        showQuest(quest, destination, { recenter: true, step: selected.step, viewPoint: destination, fitRoute: false, scrollToDetail: false });
        detail.querySelector('button').focus({ preventScroll: true });
      });
      actions.append(toggle);
    }
    const hasMultiplePins = Object.keys(quest.locations).length > 1;
    if (hasMultiplePins) {
      const fitSteps = document.createElement('button');
      fitSteps.type = 'button';
      fitSteps.textContent = 'Fit step pins';
      fitSteps.addEventListener('click', () => {
        fitQuestSteps(quest.locations);
        viewport.scrollIntoView({ block: 'nearest' });
      });
      actions.append(fitSteps);
    }
    const clear = document.createElement('button');
    clear.type = 'button';
    clear.textContent = 'Clear selection';
    clear.addEventListener('click', clearQuestSelection);
    actions.append(clear);
    detail.replaceChildren(title, start, meta);
    for (const text of [quest.target && `Target · ${quest.target}`, quest.unlock && `Story unlock · ${quest.unlock}`,
      spotlight === quest && 'Opened from the guide. This quest is outside your current map filters.']) {
      if (!text) continue;
      const paragraph = document.createElement('p');
      paragraph.textContent = text;
      detail.append(paragraph);
    }
    updateGuideNote(quest.id);
    detail.append(guideNote);
    if (quest.prerequisites) appendPrerequisites(quest.prerequisites);
    detail.append(actions);
    appendRouteSteps(quest, selected.step, index => activateStep(index, true), 'Quest steps');
    markCurrentResult();
    if (scrollToDetail) {
      atlasSidebar.open();
      requestAnimationFrame(() => {
        if (!viewSignal.aborted && selected?.quest === quest) detail.scrollIntoView({
          block: 'start', inline: 'nearest', behavior: reducedMotion.matches ? 'instant' : 'smooth',
        });
      });
    }
    if (fitRoute && hasMultiplePins) fitQuestSteps(quest.locations);
    else if (recenter || viewPoint !== point) focusTile(byArea.get(viewPoint.area), viewPoint);
    else requestDraw();
  }

  function openQuestResult(quest, point) {
    showQuest(quest, point, { recenter: true });
  }

  function resetQuestSelection(forgetSelection = true) {
    const forget = forgetSelection && (selected || selectedRoute);
    selected = undefined;
    selectedRoute = undefined;
    selectedPlace = undefined;
    selectedCollectibleEntry = undefined;
    setSelectedLocation();
    focusPlaceSelection = false;
    selectedCluster = undefined;
    fittedSteps = undefined;
    showLinkedRouteSteps = false;
    if (forget) saveSelection();
    spotlight = undefined;
    expanded = undefined;
    results.querySelector('[aria-current]')?.removeAttribute('aria-current');
  }

  function clearQuestSelection(event) {
    const returnFocus = event.currentTarget === clearMapSelection ? viewport : results.querySelector('[aria-current]') ?? viewport;
    resetQuestSelection();
    renderSelectionPanel();
    detail.hidden = true;
    returnFocus.focus({ preventScroll: true });
    requestDraw();
  }

  function setSelectedLocation(location) {
    if (selectedLocation === location) return;
    for (const element of selectedLocationElements) element.removeAttribute('data-location-selected');
    selectedLocation = location;
    selectedLocationElements = location ? [...canvas.querySelectorAll(`[data-atlas-location="${CSS.escape(location.key)}"]`)] : [];
    for (const element of selectedLocationElements) element.setAttribute('data-location-selected', '');
  }

  function showLocation(location, recenter = true) {
    resetQuestSelection();
    setSelectedLocation(location);
    renderSelectionPanel();
    detail.hidden = true;
    if (!recenter) return;
    const tile = byArea.get(location.area);
    if (location.bounds) {
      const [left, top, right, bottom] = location.bounds;
      focusTile(tile, { area: tile.id, x: (left + right) / 2, y: (top + bottom) / 2 }, undefined, {
        w: tile.w * Math.max(.25, (right - left) * 1.2),
        h: tile.h * Math.max(.25, (bottom - top) * 1.2),
      });
    } else focusTile(tile);
  }

  function catalogueSection(section, interactive = true) {
    const list = document.createElement(interactive ? 'details' : 'div');
    list.className = 'atlas-catalogue';
    if (interactive) list.open = true;
    const heading = document.createElement(interactive ? 'summary' : 'h3');
    heading.textContent = section.label;
    list.append(heading);
    if (section.note) {
      const note = document.createElement('p');
      note.className = 'quest-meta';
      note.textContent = section.note;
      list.append(note);
    }

    const table = document.createElement('table');
    table.setAttribute('aria-label', section.label);
    const headings = table.createTHead().insertRow();
    for (const label of ['Item', `${section.priceLabel ?? 'Price'} (${section.currency})`]) {
      const column = document.createElement('th');
      column.scope = 'col';
      column.textContent = label;
      headings.append(column);
    }
    const body = table.createTBody();
    for (const { name, price, note } of section.items) {
      const row = body.insertRow();
      const item = row.insertCell();
      item.textContent = name;
      if (note) {
        const condition = document.createElement('small');
        condition.textContent = note;
        item.append(condition);
      }
      const amount = row.insertCell();
      amount.textContent = price === null ? '—' : price.toLocaleString('en');
    }
    const scroller = document.createElement('div');
    scroller.className = 'atlas-catalogue-table';
    scroller.append(table);
    list.append(scroller);
    return list;
  }

  function appendVenueDetails(container, place, interactive) {
    if (interactive && place.photo) appendPhotoPreview(container, place.photo, place.name);
    if (place.detail) {
      appendSummaryText(container, place.detail);
      if (interactive && place.reference) {
        const reference = document.createElement('a');
        reference.href = place.reference;
        reference.target = '_blank';
        reference.rel = 'noopener noreferrer';
        reference.textContent = place.referenceLabel ?? 'Reference';
        container.lastElementChild.append(' ', reference);
      }
    }
    for (const { anchor, label, summary } of place.guideLinks ?? []) {
      const href = interactive && guideHref(anchor);
      if (href) {
        const paragraph = document.createElement('p');
        const link = document.createElement('a');
        link.href = href;
        link.textContent = label;
        paragraph.append(link);
        container.append(paragraph);
      } else appendSummaryText(container, summary, 'quest-meta');
    }
    if (place.destinations?.length) {
      if (interactive) {
        const actions = document.createElement('div');
        actions.className = 'detail-actions';
        for (const destination of place.destinations) {
          const tile = byArea.get(destination.area);
          const button = document.createElement('button');
          button.type = 'button';
          button.textContent = `View ${tile.label}`;
          button.addEventListener('click', () => {
            focusTile(tile, destination);
            viewport.scrollIntoView({ block: 'nearest' });
            viewport.focus({ preventScroll: true });
          });
          actions.append(button);
        }
        container.append(actions);
      } else {
        const destinations = place.destinations.map(({ area }) => byArea.get(area).label);
        appendSummaryText(container, `Connects to ${[...new Set(destinations)].join(', ')}`);
      }
    }
    for (const { sections, note } of place.catalogues ?? []) {
      appendSummaryText(container, note, 'quest-meta');
      container.append(...sections.map(section => catalogueSection(section, interactive)));
    }
  }

  function appendPlaceSummary(container, place, interactive) {
    appendSummaryText(container, placeInfo(place), 'quest-meta');
    if (isCollectible(place)) {
      if (interactive && place.photo) appendPhotoPreview(container, place.photo, place.name);
      appendCollectibleDetails(container, place, interactive);
      return;
    }
    appendVenueDetails(container, place, interactive);
    if (!place.routes) return;
    const entries = matchingRoutes.filter(entry => entry.place === place);
    for (const entry of entries) {
      if (place.name !== entry.name || entries.length > 1) {
        const heading = document.createElement('h3');
        heading.textContent = entry.name;
        container.append(heading);
      }
      appendRouteSummary(container, entry);
    }
  }

  function appendLinkedRouteSteps(entries) {
    for (const entry of entries) {
      const { id, name, window, time, picture } = entry;
      if (entries.length > 1) {
        const heading = document.createElement('h3');
        heading.textContent = name;
        detail.append(heading);
      }
      const meta = document.createElement('p');
      meta.className = 'quest-meta';
      meta.textContent = [window && `First window ${window}`, time, picture && `Picture ${picture}`].filter(Boolean).join(' · ');
      detail.append(meta);
      appendRouteSteps(entry, entry === selectedRoute ? linkedRouteStep : -1,
        index => entry === selectedRoute ? activateStep(index, true) : openLinkedRoute(entry, index), 'Quick steps');
      const link = document.createElement('a');
      link.className = 'atlas-linked-route-guide';
      const href = entry.guideAnchor && guideHref(entry.guideAnchor);
      if (href) link.href = href;
      link.textContent = 'Read in the guide';
      const actions = document.createElement('div');
      actions.className = 'detail-actions';
      const label = document.createElement('label');
      label.className = 'atlas-done';
      const check = document.createElement('input');
      check.type = 'checkbox';
      check.checked = completedRoutes.has(id);
      check.dataset.routeDone = id;
      check.setAttribute('aria-label', `Mark ${name} done`);
      label.append(check, 'Done');
      if (href) actions.append(link);
      actions.append(label);
      if (Object.keys(entry.locations).length > 1) {
        const fitSteps = document.createElement('button');
        fitSteps.type = 'button';
        fitSteps.textContent = 'Fit step pins';
        fitSteps.addEventListener('click', () => {
          if (entry !== selectedRoute) showPlace(entry.place, entry);
          fitQuestSteps(entry.locations);
          viewport.scrollIntoView({ block: 'nearest' });
        });
        actions.append(fitSteps);
      }
      detail.append(actions);
    }
  }

  function showPlace(place, linkedRoute, step = 0, {
    select = canOffsetPin(place) || (focusPlaceSelection && selectedPlace === place),
    collectibleEntry,
  } = {}) {
    resetQuestSelection();
    selectedPlace = place;
    selectedCollectibleEntry = collectibleEntry;
    focusPlaceSelection = select;
    selectedRoute = linkedRoute;
    linkedRouteStep = step;
    if (linkedRoute) saveSelection();
    markCurrentResult();
    const title = document.createElement('h2');
    title.textContent = linkedRoute?.name ?? place.name;
    const meta = document.createElement('p');
    meta.className = 'quest-meta';
    meta.textContent = placeInfo(place);
    detail.hidden = false;
    detail.replaceChildren(title, meta);
    appendVenueDetails(detail, place, true);
    if (isCollectible(place)) {
      sidebarCollectible.replaceChildren();
      appendCollectibleDetails(sidebarCollectible, place, true);
      detail.append(sidebarCollectible);
    }
    renderSelectionPanel();
    if (place.routes) {
      const entries = linkedRoute ? [linkedRoute] : matchingRoutes.filter(entry => entry.place === place);
      appendLinkedRouteSteps(entries);
      const actions = document.createElement('div');
      actions.className = 'detail-actions';
      const clear = document.createElement('button');
      clear.type = 'button';
      clear.textContent = 'Clear selection';
      clear.addEventListener('click', clearQuestSelection);
      actions.append(clear);
      detail.append(actions);
      showSteps.textContent = linkedRouteLabel + ' steps';
      showSteps.hidden = !entries.length;
      if (linkedRoute && !matchingRoutes.includes(linkedRoute)) {
        const note = document.createElement('p');
        note.className = 'quest-meta';
        note.textContent = `Opened from the guide. This ${linkedRouteLabel} is outside your current map filters.`;
        meta.after(note);
      }
    }
    if (compact.matches) viewport.scrollIntoView({ block: 'nearest' });
    else if (!atlasSidebar.collapsed && (placeTypes[place.type]?.scrollToDetail || canOffsetPin(place)
      || place.destinations?.length || place.catalogues?.length)) {
      detail.scrollIntoView({ block: 'start' });
    }
    requestDraw();
  }

  function openLinkedRoute(linkedRoute, step = 0, showLinkedSteps = false) {
    const { place } = linkedRoute;
    const index = linkedRoute.steps[step] ? step : 0;
    showPlace(place, linkedRoute, index);
    showLinkedRouteSteps = showLinkedSteps;
    const lastMapped = linkedRoute.steps.slice(0, index + 1).findLast(({ letter }) => linkedRoute.locations[letter]);
    const point = linkedRoute.locations[lastMapped?.letter] ?? place;
    focusTile(byArea.get(point.area), point);
    if (compact.matches) viewport.scrollIntoView({ block: 'start' });
  }

  function linkedRouteButton(linkedRoute) {
    const button = document.createElement('button');
    button.type = 'button';
    button.dataset.linkedRoute = linkedRoute.id;
    button.textContent = linkedRoute.name;
    const meta = document.createElement('small');
    meta.className = 'quest-meta';
    meta.textContent = [linkedRouteLabel, linkedRoute.window, completedRoutes.has(linkedRoute.id) && 'Done'].filter(Boolean).join(' · ');
    button.append(meta);
    button.addEventListener('click', () => openLinkedRoute(linkedRoute));
    const row = document.createElement('li');
    row.append(button);
    return row;
  }

  function questButton(quest, action) {
    const button = document.createElement('button');
    button.type = 'button';
    button.dataset.quest = quest.id;
    const number = document.createElement('span');
    number.className = 'quest-number';
    number.textContent = `#${quest.id}`;
    button.append(number, ` ${quest.name}`);
    if (guideState?.completed.has(quest.id)) {
      const done = document.createElement('span');
      done.className = 'quest-meta';
      done.textContent = ' · Done';
      button.append(done);
    }
    button.addEventListener('click', action);
    const row = document.createElement('li');
    row.append(button);
    return row;
  }

  function clusterName(group) {
    return `${group.entries.length} starts in ${byArea.get(group.area).label}`;
  }

  function clusterList(group, interactive) {
    const list = document.createElement('ul');
    list.className = 'atlas-cluster-list';
    for (const { quest, point } of group.entries) {
      if (interactive) {
        list.append(questButton(quest, () => openQuestResult(quest, point)));
      } else {
        const item = document.createElement('li');
        item.textContent = `#${quest.id} ${quest.name}`;
        list.append(item);
      }
    }
    return list;
  }

  function showCluster(group) {
    resetQuestSelection();
    selectedCluster = group;
    renderSelectionPanel();
    const title = document.createElement('h2');
    title.textContent = clusterName(group);
    const list = clusterList(group, true);
    detail.hidden = false;
    detail.replaceChildren(title, list);
    const { x, y } = group.entries[0].point;
    const sharedStart = group.entries.every(({ point }) => point.x === x && point.y === y);
    if (group.entries.length > 8 && camera.scale < maxScale && !sharedStart) {
      const anchor = { x: group.x, y: group.y };
      zoomAt(camera.scale * 1.7, anchor, { animate: true });
      list.querySelector('button').focus({ preventScroll: true });
      return;
    }
    expanded = group;
    markerFocus = markerKey(group.area, [group.entries[0]]);
    requestDraw();
  }

  function pinGroups(focusedQuest, margin) {
    const distance = coarse.matches ? 34 : 29;
    const distanceSquared = distance * distance;
    const edge = margin + 20;
    const groups = [];
    const byArea = new Map();
    const candidates = spotlight && !matches.includes(spotlight) ? [...matches, spotlight] : matches;
    for (const quest of focusedQuest ? [focusedQuest] : candidates) {
      if (quest !== spotlight && !visible(questLayer(quest))) continue;
      for (const point of [quest.pin, quest.interior].filter(Boolean)) {
        if (quest === selected?.quest && visible('steps') && Object.values(quest.locations).some(location => location.area === point.area)) continue;
        if (expanded?.entries.some(entry => entry.point === point)) continue;
        const { x, y } = screenPoint(point);
        if (x < -edge || x > viewportWidth + edge || y < -edge || y > viewportHeight + edge) continue;
        let areaGroups = byArea.get(point.area);
        if (!areaGroups) byArea.set(point.area, areaGroups = []);
        const group = areaGroups.find(item => (item.x - x) ** 2 + (item.y - y) ** 2 < distanceSquared);
        if (group) group.entries.push({ quest, point });
        else {
          const group = { x, y, area: point.area, entries: [{ quest, point }] };
          groups.push(group);
          areaGroups.push(group);
        }
      }
    }
    return groups;
  }

  function placeCandidates(focused, focusedPlace, margin) {
    const candidates = [];
    for (const [index, place] of places.entries()) {
      if (focused && place !== focusedPlace) continue;
      if (hideCollected.checked && place !== selectedPlace && isCollectible(place) && isCollected(place)) continue;
      if (place === selectedPlace && selectedRoute && (visible('steps') || showLinkedRouteSteps)
        && Object.values(selectedRoute.locations).some(point => point.area === place.area && point.x === place.x && point.y === place.y)) continue;
      if (!visible(place.type) && selectedPlace !== place) continue;
      if (place.routes && selectedPlace !== place
        && !(place.overviewOnly ? typeMatches({ type: linkedRouteType }) && !chapter.value && !firstWindow.value
          && !guideState?.objective && !guideState?.missableOnly : matchingRoutes.some(entry => entry.place === place))) continue;
      const tile = byArea.get(place.area);
      const extent = Math.max(tile.w, tile.h) * camera.scale;
      if (place !== selectedPlace && !canOffsetPin(place)
        && extent < (placeTypes[place.type]?.minExtent ?? 185)) continue;
      const { x, y } = screenPoint(place);
      if (x < 10 - margin || x > viewportWidth - 10 + margin || y < 10 - margin || y > viewportHeight - 10 + margin) continue;
      candidates.push({ index, place, x, y });
    }
    return candidates;
  }

  function collisionGrid(margin = 0) {
    const cells = new Map();
    const minCell = Math.floor(-margin / collisionCellSize);
    const maxColumn = Math.floor((viewportWidth + margin) / collisionCellSize);
    const maxRow = Math.floor((viewportHeight + margin) / collisionCellSize);
    function visit(box, query, ignoredOwner) {
      const right = box.x + box.w, bottom = box.y + box.h;
      const startColumn = Math.max(minCell, Math.floor(box.x / collisionCellSize));
      const startRow = Math.max(minCell, Math.floor(box.y / collisionCellSize));
      const endColumn = Math.min(maxColumn, Math.floor(right / collisionCellSize));
      const endRow = Math.min(maxRow, Math.floor(bottom / collisionCellSize));
      for (let row = startRow; row <= endRow; row++) {
        for (let column = startColumn; column <= endColumn; column++) {
          const key = (row - minCell) * (maxColumn - minCell + 1) + column - minCell;
          const bucket = cells.get(key);
          if (query) {
            if (!bucket) continue;
            for (const other of bucket) {
              if (ignoredOwner && other.owner === ignoredOwner) continue;
              if (box.x < other.x + other.w && right > other.x && box.y < other.y + other.h && bottom > other.y) return true;
            }
          } else if (bucket) bucket.push(box);
          else cells.set(key, [box]);
        }
      }
      return false;
    }
    return { add: box => visit(box, false), overlaps: (box, ignoredOwner) => visit(box, true, ignoredOwner) };
  }

  function markerScreenPoint(pin, dx, dy, ratio) {
    const { x, y, anchor } = pinPositions.get(pin);
    return { x: x + dx + anchor.x * (ratio - 1), y: y + dy + anchor.y * (ratio - 1) };
  }

  function addMarkerObstacles(grid, questMarkers, margin, dx, dy, ratio) {
    const width = viewportWidth + margin;
    const height = viewportHeight + margin;
    for (const { x, y, w, h } of getPanelBounds().values()) {
      grid.add({ x: x - 5, y: y - 5, w: w + 10, h: h + 10 });
    }
    for (const marker of questMarkers) {
      const { x, y } = markerScreenPoint(marker, dx, dy, ratio);
      if (x + 20 > -margin && x - 20 < width && y + 17 > -margin && y - 17 < height) {
        grid.add({ x: x - 20, y: y - 17, w: 40, h: 34 });
      }
    }
    if (!mapLabelsVisible && !selectedLocation) return;
    const { x: mapX, y: mapY, scale } = camera;
    const selectedLayer = selectedLocation?.layer ?? selectedLocation?.type;
    for (const [type, id, layer] of labelLayers) {
      if (layer.hidden) continue;
      const onlySelected = !mapLabelsVisible || layer.hasAttribute('data-location-only');
      if (onlySelected && (selectedLocation?.type !== type || selectedLayer !== id)) continue;
      for (const box of getLabelBounds(layer)) {
        if (onlySelected && box.key !== selectedLocation.key) continue;
        const x = mapX + box.x * scale - 2;
        const y = mapY + box.y * scale - 2;
        const w = box.w * scale + 4;
        const h = box.h * scale + 4;
        if (x < width && y < height && x + w > -margin && y + h > -margin) grid.add({ x, y, w, h });
      }
    }
  }

  function placePinBox(place, x, y, pad) {
    const { width, height, anchorY } = atlasPlacePinMetrics(place);
    return { x: x - width / 2 - pad, y: y - anchorY - pad, w: width + 2 * pad, h: height + 2 * pad, owner: place };
  }

  function positionPlacePins(grid, candidates, margin) {
    const width = viewportWidth + margin;
    const height = viewportHeight + margin;
    if (grid) {
      for (const { x, y, place } of candidates) {
        if (!usesPinOffset(place)) grid.add(placePinBox(place, x, y, 0));
      }
    }
    for (const candidate of candidates) {
      const { place, x, y } = candidate;
      if (!usesPinOffset(place)) continue;
      let offset = placeControls.get(candidate.index)?.pinOffset;
      if (grid) {
        const fits = ({ dx, dy }) => {
          const box = placePinBox(place, x + dx, y + dy, 1);
          return box.x >= -margin && box.y >= -margin && box.x + box.w <= width && box.y + box.h <= height
            && !grid.overlaps(box);
        };
        // Keep valid offsets in motion. At rest, try the real anchor first.
        if (!margin || !offset || !fits(offset)) offset = pinOffsets.find(fits);
      }
      if (offset) Object.assign(candidate, { x: x + offset.dx, y: y + offset.dy, anchor: { x, y }, offset });
      grid?.add(placePinBox(place, candidate.x, candidate.y, 1));
    }
  }

  function makePlaceLine(className) {
    const line = document.createElement('span');
    line.className = `atlas-place-line ${className}`;
    line.setAttribute('aria-hidden', 'true');
    return line;
  }

  function paintPlaceOffset(control, dx, dy) {
    const { button, pinLine, pinOffset, place } = control;
    const x = dx - (pinOffset?.dx ?? 0);
    const y = dy - (pinOffset?.dy ?? 0);
    // Keep the camera transform separate from the animation's screen-space displacement.
    if (x || y) button.style.translate = `calc(-50% + ${x}px) calc(var(--atlas-pin-anchor-y) + ${y}px)`;
    else button.style.removeProperty('translate');
    pinLine.hidden = !dx && !dy;
    if (!pinLine.hidden) {
      const { width, anchorY, inset } = atlasPlacePinMetrics(place);
      moveElement(pinLine, width / 2 - inset, anchorY - (inset || .5),
        ` rotate(${Math.atan2(-dy, -dx)}rad) scaleX(${Math.hypot(dx, dy)})`);
    }
  }

  function updatePlaceOffset(control, offset, animate, now) {
    const { button, pinOffset: previous } = control;
    const from = previous ?? pinOffsets[0];
    const to = offset ?? pinOffsets[0];
    control.pinOffset = offset;
    if (from.dx === to.dx && from.dy === to.dy) return;

    if (!control.pinLine) {
      control.pinLine = makePlaceLine('atlas-offset-line');
      button.insertBefore(control.pinLine, control.leader);
    }
    const start = placeMoves.get(button)?.current ?? from;
    if (animate && button.isConnected && (start.dx !== to.dx || start.dy !== to.dy)) {
      placeMoves.set(button, { control, start, to, time: now, current: start });
      paintPlaceOffset(control, start.dx, start.dy);
      requestPan();
    } else {
      placeMoves.delete(button);
      paintPlaceOffset(control, to.dx, to.dy);
    }
  }

  function advancePlaceMoves(now) {
    for (const [button, movement] of placeMoves) {
      const { control, start, to, time } = movement;
      const progress = reducedMotion.matches ? 1 : clamp((now - time) / placeMoveDuration, 0, 1);
      if (progress === 1) {
        placeMoves.delete(button);
        paintPlaceOffset(control, to.dx, to.dy);
        if (button.matches(':hover, :focus-visible')) showMapTooltip(button);
      } else {
        const remaining = (1 - progress) ** 3;
        const dx = to.dx + (start.dx - to.dx) * remaining;
        const dy = to.dy + (start.dy - to.dy) * remaining;
        movement.current = { dx, dy };
        paintPlaceOffset(control, dx, dy);
      }
    }
    if (placeMoves.size) requestPan();
  }

  function createPlaceControl(index, place) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = `atlas-place ${place.type}`;
    button.dataset.place = index;
    const name = place.accessibleName ?? place.name;
    button.setAttribute('aria-label', name);
    tooltipDetails.set(button, { name, photo: place.photo ?? place.pickup?.photo, renderDetails: container => appendPlaceSummary(container, place, false) });
    const icon = document.createElement('span');
    icon.className = 'atlas-place-icon';
    icon.setAttribute('aria-hidden', 'true');
    icon.textContent = place.symbol ?? placeTypes[place.type]?.symbol ?? '•';
    button.append(icon);
    if (place.shape) setAtlasPlacePinShape(button, place.shape);
    if (place.size) setAtlasPlacePinSize(button, place.size);
    addPinImage(button, icon, place.icon ?? placeTypes[place.type]?.icon ?? layerIcons[place.type]);
    const color = place.color ?? placeTypes[place.type]?.color;
    if (color) button.style.setProperty('--collectible-color', color);
    if (place.textColor) button.style.setProperty('--atlas-marker-ink', place.textColor);
    if (place.variant) button.classList.add(place.variant);
    if (place.routes?.length) {
      button.addEventListener('click', () => {
        const entries = matchingRoutes.filter(entry => entry.place === place);
        const entry = selectedRoute?.place === place ? selectedRoute : entries.length === 1 ? entries[0] : undefined;
        if (entry) {
          const index = entry.steps.findIndex(({ letter }) => {
            const point = entry.locations[letter];
            return point?.area === place.area && point.x === place.x && point.y === place.y;
          });
          showPlace(place, entry, Math.max(0, index));
        } else showPlace(place);
      });
    } else button.addEventListener('click', () => showPlace(place));
    const caption = document.createElement('span');
    caption.className = 'atlas-place-name is-hidden';
    const text = place.caption ?? place.name;
    caption.textContent = text;
    caption.setAttribute('aria-hidden', 'true');
    const leader = makePlaceLine('atlas-caption-line is-hidden');
    button.append(leader, caption);
    return { button, place, caption, leader, text };
  }

  function updatePlaceControls(candidates, animateOffsets, now) {
    const active = new Set();
    const controls = [];
    for (const { index, place, x, y, anchor, offset } of candidates) {
      active.add(index);
      let control = placeControls.get(index);
      if (!control) {
        control = createPlaceControl(index, place);
        placeControls.set(index, control);
      }
      const { button } = control;
      movePin(button, x, y, anchor);
      updatePlaceOffset(control, offset, animateOffsets, now);
      if (canOffsetPin(place) || selectedPlace === place) button.setAttribute('aria-pressed', String(selectedPlace === place));
      else button.removeAttribute('aria-pressed');
      controls.push(control);
    }
    for (const [index, { button }] of placeControls) {
      if (!active.has(index)) {
        placeMoves.delete(button);
        button.remove();
        placeControls.delete(index);
      }
    }
    return controls;
  }

  function getCaptionMetrics(text, pin) {
    let bySize = captionMetrics.get(text);
    if (!bySize) captionMetrics.set(text, bySize = new Map());
    if (!bySize.has(pin)) {
      const width = Math.ceil(textMeasure.measureText(text).width) + 14;
      const side = pin.width / 2 + 2;
      const head = pin.headY - pin.anchorY;
      const top = -pin.anchorY - captionHeight - 1;
      const bottom = pin.height - pin.anchorY + 2;
      bySize.set(pin, { width, slots: [
        [side, head - captionHeight / 2], [-width - side, head - captionHeight / 2], [-width / 2, top],
        [-width / 2, bottom], [side - 1, top], [-width - side + 1, bottom],
      ] });
    }
    return bySize.get(pin);
  }

  function placeCaption(control, grid, x, y) {
    const { caption, leader, place } = control;
    let slot = -1;
    const pin = atlasPlacePinMetrics(place);
    const radius = pin.width / 2;
    if (x >= -radius && x <= viewportWidth + radius && y >= pin.anchorY - pin.height && y <= viewportHeight + pin.anchorY
      && (!canOffsetPin(place) || camera.scale >= mapLabelScale)) {
      const { width, slots } = getCaptionMetrics(control.text, pin);
      const { anchorY, inset } = pin;
      const headY = pin.headY - anchorY;
      const box = { x: 0, y: 0, w: width, h: captionHeight };
      const preferred = preferredCaptionSlots.get(place);
      const fits = (index, clearance = 0) => {
        box.x = x + slots[index][0];
        box.y = y + slots[index][1];
        const inset = 3 + clearance;
        if (box.x < inset || box.y < inset || box.x + box.w > viewportWidth - inset || box.y + box.h > viewportHeight - inset) return false;
        if (!clearance) return !grid.overlaps(box);
        return !grid.overlaps({ x: box.x - clearance, y: box.y - clearance,
          w: box.w + 2 * clearance, h: box.h + 2 * clearance }, place);
      };
      // Return to the original slot only once it has extra room. An existing slot can stay at the normal limit.
      if (preferred !== undefined && preferred !== control.slot && fits(preferred, captionReturnClearance)) slot = preferred;
      else if (control.slot !== undefined && fits(control.slot)) slot = control.slot;
      else slot = slots.findIndex((_, index) => fits(index));
      if (slot >= 0) {
        if (preferred === undefined) preferredCaptionSlots.set(place, slot);
        grid.add(box);
        const [left, top] = slots[slot];
        if (left !== control.captionX || top !== control.captionY) {
          moveElement(caption, left + radius - inset, top + anchorY - inset);
          const dx = clamp(0, left, left + width);
          const dy = clamp(headY, top, top + captionHeight) - headY;
          const distance = Math.hypot(dx, dy);
          let angle = Math.atan2(dy, dx);
          const previous = control.leaderAngle ?? angle;
          angle += 2 * Math.PI * Math.round((previous - angle) / (2 * Math.PI));
          moveElement(leader, radius - inset + radius * dx / distance, pin.headY - inset + radius * dy / distance,
            ` rotate(${angle}rad) scaleX(${distance - radius})`);
          control.leaderAngle = angle;
          control.captionX = left;
          control.captionY = top;
          control.hasLeader = distance > radius + 8;
        }
        control.slot = slot;
      }
    }
    const visible = slot >= 0;
    if (visible !== control.captionVisible) {
      caption.classList.toggle('is-hidden', !visible);
      control.captionVisible = visible;
    }
    const leaderVisible = visible && control.hasLeader;
    if (leaderVisible !== control.leaderVisible) {
      leader.classList.toggle('is-hidden', !leaderVisible);
      control.leaderVisible = leaderVisible;
    }
  }

  function layoutPlaceCaptions(now, dx, dy, ratio, grid) {
    lastCaptionLayout = { x: camera.x, y: camera.y, time: now };
    const { controls, questMarkers } = captionView;
    if (!controls.length) return;
    const positions = controls.map(control => markerScreenPoint(control.button, dx, dy, ratio));
    if (!grid) {
      grid = collisionGrid();
      addMarkerObstacles(grid, questMarkers, 0, dx, dy, ratio);
      for (let i = 0; i < controls.length; i++) {
        const { x, y } = positions[i];
        const { place } = controls[i];
        const box = placePinBox(place, x, y, Number(usesPinOffset(place)));
        if (box.x + box.w >= 0 && box.x <= viewportWidth && box.y + box.h >= 0 && box.y <= viewportHeight) grid.add(box);
      }
    }
    controls.forEach((control, index) => placeCaption(control, grid, positions[index].x, positions[index].y));
  }

  function updateDragCaptions(now, dx, dy, ratio) {
    if ((pointers.size !== 1 && !cameraMotion?.inertia) || !captionView?.controls.length) return;
    const elapsed = now - lastCaptionLayout.time;
    const movement = Math.max(Math.abs(camera.x - lastCaptionLayout.x), Math.abs(camera.y - lastCaptionLayout.y));
    if (movement < captionMoveThreshold) return;
    if (elapsed >= captionInterval) layoutPlaceCaptions(now, dx, dy, ratio);
    else requestPan();
  }

  function markerKey(areaId, entries) {
    return `${areaId}:${entries.map(entry => entry.quest.id).join(',')}`;
  }

  function createQuestControl(group, key, spread) {
    const { quest, point } = group.entries[0];
    const multiple = group.entries.length > 1;
    const button = document.createElement('button');
    button.type = 'button';
    const markerType = multiple ? 'cluster' : questLayer(quest);
    button.className = `atlas-pin ${markerType}`;
    button.dataset.markerType = markerType;
    if (questPinColors[markerType]) button.style.setProperty('--atlas-pin-color', questPinColors[markerType]);
    if (spread) button.classList.add('spread');
    button.dataset.marker = key;
    button.textContent = multiple ? `×${group.entries.length}` : quest.id;
    if (!multiple) addPinImage(button, button, point.icon ?? quest.icon ?? questTypes[quest.type]?.icon ?? layerIcons[markerType]);
    const name = multiple ? clusterName(group) : `#${quest.id} ${quest.name}`;
    button.setAttribute('aria-label', name);
    tooltipDetails.set(button, { name, renderDetails: container => {
      if (multiple) container.append(clusterList(group, false));
      else appendRouteSummary(container, quest, point);
    } });
    const control = { button, group };
    button.addEventListener('click', () => multiple ? showCluster(control.group) : showQuest(quest, point));
    return control;
  }

  function marker(group, anchor, controls) {
    const key = markerKey(group.area, group.entries);
    const locations = group.entries.map(({ quest, point }) => point === quest.interior ? 'i' : 'o').join('');
    const cacheKey = `${key}:${locations}:${Boolean(anchor)}`;
    const control = questControls.get(cacheKey) ?? createQuestControl(group, key, anchor);
    control.group = group;
    controls.set(cacheKey, control);
    const { button } = control;
    movePin(button, group.x, group.y, anchor);
    const pressed = String(group.entries.some(entry => entry.quest === selected?.quest && entry.point === selected.point));
    if (button.getAttribute('aria-pressed') !== pressed) button.setAttribute('aria-pressed', pressed);
    return button;
  }

  function expandedMarkers(controls) {
    if (!expanded) return [];
    const { area: areaId, entries } = expanded;
    const spacing = coarse.matches ? 44 : 36;
    const anchors = entries.map(entry => screenPoint(entry.point));
    const radius = Math.max(spacing, spacing / (2 * Math.sin(Math.PI / entries.length)));
    const columns = Math.max(1, Math.min(Math.ceil(Math.sqrt(entries.length)), Math.floor((viewportWidth - 40) / spacing)));
    const rows = Math.ceil(entries.length / columns);
    const offsets = entries.map((_, index) => {
      if (entries.length > 8) {
        return { x: (index % columns - (columns - 1) / 2) * spacing, y: (Math.floor(index / columns) - (rows - 1) / 2) * spacing };
      }
      const angle = -Math.PI / 2 + index * 2 * Math.PI / entries.length;
      return { x: radius * Math.cos(angle), y: radius * Math.sin(angle) };
    });
    const left = 24 - Math.min(...offsets.map(offset => offset.x));
    const right = viewportWidth - 24 - Math.max(...offsets.map(offset => offset.x));
    const top = 60 - Math.min(...offsets.map(offset => offset.y));
    const bottom = viewportHeight - 48 - Math.max(...offsets.map(offset => offset.y));
    const x = left <= right ? clamp(anchors[0].x, left, right) : viewportWidth / 2;
    const y = top <= bottom ? clamp(anchors[0].y, top, bottom) : viewportHeight / 2;
    const lines = [];
    const buttons = entries.map((entry, index) => {
      const position = { x: x + offsets[index].x, y: y + offsets[index].y };
      const anchor = anchors[index];
      const dx = position.x - anchor.x;
      const dy = position.y - anchor.y;
      lines.push(createPinLine(anchor.x, anchor.y, dx, dy));
      return marker({ ...position, area: areaId, entries: [entry] }, anchor, controls);
    });
    return [...lines, ...buttons];
  }

  function advanceCamera(now) {
    if (!cameraMotion) return;
    const { start, destination, duration, flight, wheel, inertia, time } = cameraMotion;
    const elapsed = now - time;
    if (elapsed >= duration || reducedMotion.matches) {
      if (!inertia || !reducedMotion.matches) Object.assign(camera, destination);
      cameraMotion = undefined;
      fullDrawNeeded = true;
      return;
    }
    const progress = clamp(elapsed / duration, 0, 1);
    if (inertia) {
      const eased = progress * (2 - progress);
      camera.x = start.x + (destination.x - start.x) * eased;
      camera.y = start.y + (destination.y - start.y) * eased;
      return;
    }
    if (wheel) {
      const easing = sampleWheelEasing(wheel.control, progress);
      const factor = Math.exp(wheel.logChange * easing.value);
      camera.scale = start.scale * factor;
      camera.x = wheel.anchor.x - (wheel.anchor.x - start.x) * factor;
      camera.y = wheel.anchor.y - (wheel.anchor.y - start.y) * factor;
      wheel.velocity = wheel.logChange * easing.slope / duration;
      return;
    }
    const center = progress * progress * (3 - 2 * progress);
    if (flight) {
      // Ease the zoom separately so it rounds the turn while the center keeps moving.
      const zoomingOut = progress < flight.turn;
      const zoom = zoomingOut ? 1 - progress / flight.turn : (progress - flight.turn) / (1 - flight.turn);
      const easedZoom = zoom ** 3 * (10 + zoom * (6 * zoom - 15));
      const endpointScale = zoomingOut ? start.scale : destination.scale;
      camera.scale = flight.scale * (endpointScale / flight.scale) ** easedZoom;
    } else {
      camera.scale = start.scale * (destination.scale / start.scale) ** center;
    }
    const from = (1 - center) * camera.scale / start.scale;
    const to = center * camera.scale / destination.scale;
    camera.x = viewportWidth / 2 + (start.x - viewportWidth / 2) * from + (destination.x - viewportWidth / 2) * to;
    camera.y = viewportHeight / 2 + (start.y - viewportHeight / 2) * from + (destination.y - viewportHeight / 2) * to;
  }

  function sampleWheelEasing(control, time) {
    // Evaluate cubic-bezier(control.x, control.y, .25, 1) and its slope at this time.
    // Solve the x coordinate first, since the Bézier parameter is not elapsed time.
    let min = 0, max = 1, t = time;
    let dx = 0;
    for (let i = 0; i < 20; i++) {
      const u = 1 - t;
      const error = 3 * u * u * t * control.x + .75 * u * t * t + t ** 3 - time;
      dx = 3 * (u * u * control.x + 2 * u * t * (.25 - control.x) + .75 * t * t);
      if (Math.abs(error) < 1e-7) break;
      if (error > 0) max = t;
      else min = t;
      const next = t - error / dx;
      if (i < 19) t = next > min && next < max ? next : (min + max) / 2;
    }
    const u = 1 - t;
    const value = 3 * u * u * t * control.y + 3 * u * t * t + t ** 3;
    const dy = 3 * (u * u * control.y + 2 * u * t * (1 - control.y));
    return { value, slope: dy / dx };
  }

  function applyWheelZoom(now, { delta, anchor }) {
    const previous = cameraMotion?.wheel;
    const targetScale = previous ? cameraMotion.destination.scale : camera.scale;
    // MapLibre batches deltas and uses a sigmoid to soften a large input burst.
    const gain = 2 / (1 + Math.exp(-Math.abs(delta) * wheelRate));
    const scale = clamp(targetScale * (delta < 0 ? gain : 1 / gain), fitScale(), maxScale);
    if (scale === targetScale) return;
    anchor = previous?.anchor ?? anchor;
    const factor = scale / camera.scale;
    const destination = constrainCamera({
      x: anchor.x - (anchor.x - camera.x) * factor,
      y: anchor.y - (anchor.y - camera.y) * factor,
      scale,
    });
    if (expanded) fullDrawNeeded = true;
    expanded = undefined;
    fittedSteps = undefined;
    overview = false;
    const logChange = Math.log(factor);
    if (reducedMotion.matches || Math.abs(logChange) < 1e-9) {
      Object.assign(camera, destination);
      cameraMotion = undefined;
      fullDrawNeeded = true;
      return;
    }
    let control = defaultWheelControl;
    if (previous) {
      // Match the outgoing log-zoom velocity even as the remaining distance changes.
      // A reversal starts with a flat tangent so it won't overshoot the new target.
      const slope = Math.max(0, previous.velocity * wheelDuration / logChange);
      const x = slope > 3 ? .75 / slope : .25;
      control = { x, y: x * slope };
    }
    cameraMotion = {
      start: { ...camera }, destination, duration: wheelDuration, time: previous ? now : now - wheelStartAdvance,
      wheel: { anchor, control, logChange, velocity: 0 },
    };
    // Give the first frame a small visible response. Retargets already advanced above.
    if (!previous) advanceCamera(now);
  }

  function prepareMotionMarkers() {
    const placeByButton = new Map(captionView.controls.map(control => [control.button, control]));
    const records = [];
    for (const { element, line, x, y, anchor } of projectedMarkers) {
      const control = placeByButton.get(element);
      if (control) {
        const { place, captionX, captionY, captionVisible, leaderVisible, text } = control;
        const pin = atlasPlacePinMetrics(place);
        const scale = pin.width / 18;
        const teardrop = place.shape === 'teardrop';
        const sprite = {
          text: element.firstElementChild.textContent, width: pin.width, height: pin.height,
          radius: (place.shape === 'circle' ? 9 : 4) * scale,
          font: `750 ${11 * scale}px "Segoe UI", "Segoe UI Symbol", sans-serif`, teardrop,
          color: place.textColor ?? '#fff6e7', fill: place.color ?? placeTypes[place.type]?.color ?? '#5b4932',
          border: '#f4e9cc', shadow: true, outline: selectedPlace === place ? '#ffe3a5' : undefined,
          icon: loadedPinImage(element), iconSize: 14 * scale,
        };
        const lines = [];
        if (anchor.x !== x || anchor.y !== y) lines.push({ dx: anchor.x - x, dy: anchor.y - y, color: '#9ce3da', width: 1 });
        let caption;
        if (captionVisible) {
          const width = getCaptionMetrics(text, pin).width;
          caption = { x: captionX, y: captionY, sprite: { text, width, height: captionHeight, radius: 4,
            font: captionFont, fill: '#242c27f2', border: '#b9ac8690', color: '#fff7e4' } };
          if (leaderVisible) {
            const fromY = pin.headY - pin.anchorY;
            lines.push({ fromY, dx: clamp(0, captionX, captionX + width),
              dy: clamp(fromY, captionY, captionY + captionHeight) - fromY, color: '#e5d3a2', width: 1 });
          }
        }
        records.push({ x, y, anchor, sprite, caption, lines });
        continue;
      }
      if (line) {
        records.push({ x, y, anchor, lines: [motionPaint.get(element)] });
        continue;
      }
      const active = element.getAttribute('aria-pressed') === 'true';
      const step = Boolean(element.dataset.stepPin);
      const minimum = coarse.matches && (step || element.classList.contains('spread')) ? 32 : step ? 28.8 : 26.4;
      const text = element.textContent;
      const width = Math.max(minimum, markerTextMeasure.measureText(text).width + 9.68);
      const fill = step ? active ? '#ffe3a5' : '#8c352c' : questPinColors[element.dataset.markerType];
      records.push({ x, y, anchor, sprite: { text, width, height: minimum, radius: minimum / 2,
        font: questMotionText, fill, color: step && active ? '#3b2517' : '#fff', border: '#fff8e6',
        shadow: true, outline: active ? '#ffdd7e' : undefined, icon: loadedPinImage(element), iconSize: 16 } });
    }
    return records;
  }

  function hideMotionMarkers() {
    if (!viewport.hasAttribute('data-motion-markers')) return;
    motionMarkers.hide();
    viewport.removeAttribute('data-motion-markers');
    motionMarkerRecords = undefined;
  }

  function drawMotionMarkers(ratio, dx, dy) {
    // Keep the current renderer as pins leave the view during a zoom.
    const count = projectedMarkers.length;
    const sparse = count < canvasMarkerThreshold && !viewport.hasAttribute('data-motion-markers');
    if (!count || sparse || placeMoves.size || markerLayer.contains(document.activeElement)) {
      hideMotionMarkers();
      return false;
    }
    motionMarkerRecords ??= prepareMotionMarkers();
    if (!motionMarkers.draw(motionMarkerRecords, { width: viewportWidth, height: viewportHeight, ratio, dx, dy })) {
      hideMotionMarkers();
      return false;
    }
    viewport.toggleAttribute('data-motion-markers', true);
    return true;
  }

  function draw(now) {
    frame = undefined;
    if (!viewportWidth || !viewportHeight) return;
    const wheel = pendingWheel;
    pendingWheel = undefined;
    if (wheel?.delta && !cameraMotion?.wheel) {
      if (cameraMotion?.inertia) fullDrawNeeded = true;
      cameraMotion = undefined;
    }
    advanceCamera(now);
    constrainCamera(camera);
    // Advance the existing curve before applying new input, even on consecutive wheel frames.
    if (wheel?.delta) {
      applyWheelZoom(now, wheel);
      constrainCamera(camera);
    }
    advancePlaceMoves(now);
    const moving = Boolean(cameraMotion);
    if (moving) requestPan();
    const zooming = pointers.size === 2 || Boolean(cameraMotion
      && (cameraMotion.flight || cameraMotion.start.scale !== cameraMotion.destination.scale));
    // With a focused place, give map labels their own layers across the visibility threshold.
    const focusedPlaceZoom = focusSelection.checked && focusPlaceSelection;
    const labelZoom = zooming && (focusedPlaceZoom || (cameraMotion && (cameraMotion.flight?.scale
      ?? Math.min(cameraMotion.start.scale, cameraMotion.destination.scale)) >= mapLabelScale));
    viewport.toggleAttribute('data-zooming', zooming);
    viewport.toggleAttribute('data-label-zoom', Boolean(labelZoom));
    viewport.toggleAttribute('data-wheel-zoom-out', (cameraMotion?.wheel?.logChange ?? 0) < 0);
    viewport.toggleAttribute('data-inertia', Boolean(cameraMotion?.inertia));
    moveElement(canvas, camera.x, camera.y, ` scale(${camera.scale})`);
    const nextMapLabelsVisible = camera.scale >= mapLabelScale;
    if (fullDrawNeeded || mapLabelsVisible !== nextMapLabelsVisible) {
      mapLabelsVisible = nextMapLabelsVisible;
      canvas.toggleAttribute('data-hide-map-labels', !mapLabelsVisible);
      const selectedLayer = selectedLocation?.layer ?? selectedLocation?.type;
      for (const [type, id, layer] of labelLayers) {
        const enabled = visible(id);
        const selected = selectedLocation?.type === type && selectedLayer === id;
        layer.toggleAttribute('hidden', !enabled && !selected);
        layer.toggleAttribute('data-location-only', !enabled && selected);
      }
      for (const { root, groups } of groupedLabelLayers) {
        root.toggleAttribute('hidden', groups.every(group => group.hidden));
      }
    }
    imagery.update({ camera, viewportWidth, viewportHeight, pixelRatio: window.devicePixelRatio || 1,
      overview, inMotion: moving || pointers.size > 0, zooming,
      destination: cameraMotion && !cameraMotion.wheel && !cameraMotion.inertia ? cameraMotion.destination : undefined });
    if (!zooming) hideMotionMarkers();
    if (!fullDrawNeeded && markerView?.margin === 0 && !moving && !pointers.size
      && camera.x === markerView.x && camera.y === markerView.y && camera.scale === markerView.scale) return;
    const margin = pointers.size || moving ? panMargin : 0;
    const ratio = markerView ? camera.scale / markerView.scale : 1;
    const dx = markerView ? camera.x - markerView.x * ratio : 0;
    const dy = markerView ? camera.y - markerView.y * ratio : 0;
    // Move cached pin positions with the map while keeping their screen size steady.
    // The extra area supplies pins entering the viewport between layout passes.
    const offset = Math.max(Math.abs(dx), Math.abs(dy),
      Math.abs(dx + viewportWidth * (ratio - 1)), Math.abs(dy + viewportHeight * (ratio - 1)));
    if (!fullDrawNeeded && margin && markerView?.margin === margin && ratio >= .85 && ratio <= 1.18
      && offset <= margin - 24) {
      if (!zooming || !drawMotionMarkers(ratio, dx, dy)) {
        moveElement(markerLayer, dx, dy);
        projectMarkers(ratio);
        markersTranslated = true;
      }
      if (!zooming) {
        updateDragCaptions(now, dx, dy, ratio);
        motionMarkerRecords = undefined;
      }
      return;
    }
    fullDrawNeeded = false;
    if (markersTranslated) markerLayer.style.removeProperty('transform');
    markersTranslated = false;
    markerView = { ...camera, margin };
    canvas.classList.toggle('hide-area-names', !visible('area'));
    routes.toggleAttribute('hidden', !visible('routes'));
    plus.disabled = camera.scale >= maxScale;
    minus.disabled = camera.scale <= fitScale();
    const focused = markerFocus ?? (pins.contains(document.activeElement) ? document.activeElement.dataset.marker : null);
    const focusedPlace = placeLayer.contains(document.activeElement) ? document.activeElement.dataset.place : null;
    const focusedStep = stepPins.contains(document.activeElement) ? document.activeElement.dataset.stepPin : null;
    markerFocus = undefined;
    const focus = focusSelection.checked;
    const focusedQuest = focus ? selected?.quest : undefined;
    const focusedMapPlace = focus && focusPlaceSelection ? selectedPlace : undefined;
    const isolated = Boolean(focusedQuest || focusedMapPlace);
    const controlsByQuest = new Map();
    const markers = focusedMapPlace ? [] : [...pinGroups(focusedQuest, margin).map(group => marker(group, undefined, controlsByQuest)),
      ...expandedMarkers(controlsByQuest)];
    const stepElements = drawStepPins(margin);
    const steps = stepElements.filter(element => element.dataset.stepPin);
    const starts = markers.filter(element => element.dataset.markerType);
    const candidates = placeCandidates(isolated, focusedMapPlace, margin);
    if (isolated) {
      const types = new Set(starts.map(element => element.dataset.markerType));
      if (steps.length) types.add('steps');
      for (const { place } of candidates) types.add(place.variant ?? place.type);
      updateLegend(types);
    } else updateLegend();
    const questMarkers = [...starts, ...steps];
    // Keep existing offsets during zoom. Its final draw places pins and captions together.
    const grid = zooming ? null : collisionGrid(margin);
    if (grid) addMarkerObstacles(grid, questMarkers, margin, 0, 0, 1);
    positionPlacePins(grid, candidates, margin);
    hideMapTooltip();
    for (const [key, { button }] of questControls) {
      if (!controlsByQuest.has(key)) button.remove();
    }
    questControls = controlsByQuest;
    for (const node of pins.querySelectorAll('.atlas-pin-line')) node.remove();
    let nextMarker = pins.firstChild;
    for (const element of markers) {
      if (element === nextMarker) nextMarker = element.nextSibling;
      else pins.insertBefore(element, nextMarker);
    }
    stepPins.replaceChildren(...stepElements);
    const controls = updatePlaceControls(candidates, !margin && !reducedMotion.matches, now);
    projectedMarkers = [...markers, ...stepElements, ...controls.map(control => control.button)]
      .map(element => ({ element, ...pinPositions.get(element) }));
    markerProjectionScale = 1;
    captionView = { controls, questMarkers };
    let nextPlace = null;
    for (let i = controls.length - 1; i >= 0; i--) {
      const { button } = controls[i];
      if (!button.parentNode) placeLayer.insertBefore(button, nextPlace);
      nextPlace = button;
    }
    if (grid) layoutPlaceCaptions(now, 0, 0, 1, grid);
    motionMarkerRecords = undefined;
    if (focused || focusedStep !== null || focusedPlace !== null) hideMotionMarkers();
    if (focused) {
      const marker = markers.find(button => button.dataset.marker === focused);
      if (marker !== document.activeElement) (marker ?? viewport).focus({ preventScroll: true });
    } else if (focusedStep !== null) {
      (steps.find(button => button.dataset.stepPin === focusedStep) ?? viewport).focus({ preventScroll: true });
    } else if (focusedPlace !== null) {
      (placeControls.get(Number(focusedPlace))?.button ?? viewport).focus({ preventScroll: true });
    }
    if (zooming) drawMotionMarkers(1, 0, 0);
    else if (!margin && projectedMarkers.length >= canvasMarkerThreshold) {
      const markers = projectedMarkers;
      motionMarkers.warmSprites(() => {
        if (markers !== projectedMarkers || cameraMotion || pendingWheel || pointers.size) return;
        return motionMarkerRecords ??= prepareMotionMarkers();
      });
    }
  }

  function requestPan() {
    if (!viewSignal.aborted && !root.hidden && frame === undefined) frame = requestAnimationFrame(draw);
  }

  function requestDraw() {
    fullDrawNeeded = true;
    requestPan();
  }

  function typeMatches(entry) {
    return !type.value || type.value === entry.type;
  }

  function chapterMatches(entry) {
    return !chapter.value || chapter.value === entry.chapter;
  }

  function windowMatches(entry) {
    return !firstWindow.value || firstWindow.value === entry.window;
  }

  const windowOrder = new Map(Object.keys(objectives).map((code, index) => [code, index]));

  function setWindows() {
    const previous = firstWindow.value;
    const codes = [...new Set([...quests, ...linkedRoutes].filter(entry => entry.window && chapterMatches(entry) && typeMatches(entry))
      .map(entry => entry.window))].sort((a, b) => windowOrder.get(a) - windowOrder.get(b));
    firstWindow.replaceChildren(new Option('All first windows', ''),
      ...codes.map(code => new Option(objectives[code] ? `${code} · ${objectives[code]}` : code, code)));
    if (codes.includes(previous)) firstWindow.value = previous;
  }

  function collectibleEntryKey(place, entry) {
    return `${place.id}:${entry.progressId}`;
  }

  function openCollectible(place, entry) {
    showPlace(place, undefined, 0, { select: true, collectibleEntry: place.entries?.length > 1 ? entry : undefined });
    focusTile(byArea.get(place.area), place);
    if (compact.matches) viewport.scrollIntoView({ block: 'start' });
  }

  function collectibleResultButton(place, entry) {
    const button = document.createElement('button');
    button.type = 'button';
    button.dataset.collectibleResult = place.id;
    button.dataset.collectibleEntry = collectibleEntryKey(place, entry);
    button.textContent = entry.name;
    const meta = document.createElement('small');
    meta.className = 'quest-meta';
    meta.textContent = [place.location || byArea.get(place.area).label, entry.window,
      place.pickup?.listMeta,
      collected.has(entry.progressId) && 'Collected'].filter(Boolean).join(' · ');
    button.append(meta);
    button.addEventListener('click', () => openCollectible(place, entry));
    const row = document.createElement('li');
    row.append(button);
    return row;
  }

  function renderCollectibleResults() {
    if (root.hidden) return;
    const active = document.activeElement;
    const activeGroup = active.closest('[data-collectible-result-type]');
    let total = 0;
    for (const group of collectibleResultGroups) {
      const entries = places.filter(place => place.type === group.dataset.collectibleResultType
        && !(hideCollected.checked && isCollected(place))).flatMap(place => {
        const items = place.pickup ? [{ name: place.name, progressId: place.pickup.progressId }]
          : visibleCollectibleEntries(place);
        return items.map(entry => ({ place, entry }));
      });
      entries.sort((a, b) => resultCollator.compare(a.entry.name, b.entry.name)
        || byArea.get(a.place.area).label.localeCompare(byArea.get(b.place.area).label));
      setResultRows(group, entries, ({ place, entry }) => collectibleResultButton(place, entry));
      total += entries.length;
    }
    collectibleResults.querySelector('summary .atlas-result-count').textContent = `(${total})`;
    collectibleResults.querySelector('.atlas-collectible-empty').hidden = total !== 0;
    markCurrentResult({ expand: false });
    if (active.dataset.collectibleEntry) {
      const fallback = activeGroup.hidden ? collectibleResults : activeGroup;
      const button = collectibleResults.querySelector(`[data-collectible-entry="${CSS.escape(active.dataset.collectibleEntry)}"]`);
      (button ?? fallback.querySelector('summary')).focus({ preventScroll: true });
    }
  }

  function fillResultRows(group) {
    const pending = resultRows.get(group);
    if (!pending) return;
    group.querySelector('ul').replaceChildren(...pending.entries.map(pending.render));
    resultRows.delete(group);
  }

  function setResultRows(group, entries, render) {
    group.hidden = !entries.length;
    group.querySelector('.atlas-result-count').textContent = `(${entries.length})`;
    resultRows.set(group, { entries, render });
    if (group.open) fillResultRows(group);
    else group.querySelector('ul').replaceChildren();
  }

  function markCurrentResult({ expand = true } = {}) {
    results.querySelector('[aria-current]')?.removeAttribute('aria-current');
    const selector = selected ? `[data-quest="${CSS.escape(String(selected.quest.id))}"]`
      : selectedRoute ? `[data-linked-route="${CSS.escape(selectedRoute.id)}"]`
        : selectedPlace && isCollectible(selectedPlace) ? `[data-collectible-result="${CSS.escape(selectedPlace.id)}"]` : '';
    if (!selector) return;
    const entrySelector = selectedCollectibleEntry
      && `[data-collectible-entry="${CSS.escape(collectibleEntryKey(selectedPlace, selectedCollectibleEntry))}"]`;
    const group = selected || selectedRoute
      ? resultGroups.find(group => group.dataset.resultType === (selected?.quest.type ?? linkedRouteType))
      : collectibleResultGroups.find(group => group.dataset.collectibleResultType === selectedPlace?.type);
    if (expand && group) fillResultRows(group);
    const button = results.querySelector(entrySelector || selector);
    if (!button) return;
    button.setAttribute('aria-current', 'true');
    if (expand) {
      button.closest('details').open = true;
      if (collectibleResults.contains(button)) collectibleResults.open = true;
    }
  }

  function renderResults() {
    if (root.hidden) return;
    for (const group of resultGroups) {
      const groupType = group.dataset.resultType;
      if (groupType === linkedRouteType) {
        setResultRows(group, [...matchingRoutes].sort((a, b) => windowOrder.get(a.window) - windowOrder.get(b.window)), linkedRouteButton);
      } else {
        setResultRows(group, matches.filter(quest => quest.type === groupType),
          quest => questButton(quest, () => openQuestResult(quest, quest.pin)));
      }
    }
    markCurrentResult({ expand: false });
  }

  for (const group of [...resultGroups, ...collectibleResultGroups]) {
    group.addEventListener('toggle', () => {
      if (!group.open || root.hidden) return;
      fillResultRows(group);
      markCurrentResult({ expand: false });
    });
  }

  function filterQuests({ keepSelection = false, forgetSelection = true } = {}) {
    matches = quests.filter(quest => (!guideState || guideState.eligible.has(quest.id))
      && chapterMatches(quest) && windowMatches(quest) && typeMatches(quest));
    matchingRoutes = linkedRoutes.filter(entry => chapterMatches(entry) && windowMatches(entry) && typeMatches(entry)
      && (adapter.routeAvailable?.(entry, guideState, completedRoutes) ?? !entry.retry));
    objective.hidden = !objectives[firstWindow.value];
    if (!objective.hidden) objective.textContent = `Window objective · ${objectives[firstWindow.value]}`;
    linkedRouteFilterNote.hidden = !guideState?.objective || !matchingRoutes.length;
    const counts = [];
    if (Object.keys(questTypes).length && type.value !== linkedRouteType) counts.push(`${matches.length} ${matches.length === 1 ? 'quest' : 'quests'}`);
    if (linkedRouteType && (!type.value || type.value === linkedRouteType)) counts.push(`${matchingRoutes.length} ${matchingRoutes.length === 1 ? linkedRouteLabel : linkedRouteType}`);
    count.textContent = counts.join(' · ');
    if (keepSelection && selected && matches.includes(selected.quest)) {
      selectionDone.checked = Boolean(guideState?.completed.has(selected.quest.id));
      const check = detail.querySelector('.atlas-done input');
      if (check) check.checked = selectionDone.checked;
      updateGuideNote(selected.quest.id);
    } else if (keepSelection && selectedRoute && matchingRoutes.includes(selectedRoute)) {
      selectionDone.checked = completedRoutes.has(selectedRoute.id);
      detail.querySelector('[data-route-done]').checked = completedRoutes.has(selectedRoute.id);
    } else if (!keepSelection || !selectedLocation) {
      const focusInSelection = selectionPanel.contains(document.activeElement) || detail.contains(document.activeElement);
      resetQuestSelection(forgetSelection);
      renderSelectionPanel();
      detail.hidden = true;
      if (focusInSelection) viewport.focus({ preventScroll: true });
    }
    renderResults();
    requestDraw();
  }

  function loadRouteProgress() {
    try {
      for (const { id } of linkedRoutes) {
        if (localStorage.getItem(routeProgressKey(id)) === '1' || adapter.routeDone?.(id)) completedRoutes.add(id);
        else completedRoutes.delete(id);
      }
    } catch {
      // Use the current page's progress if file storage is unavailable.
    }
  }

  function loadCollectibleProgress() {
    try {
      const ids = places.filter(isCollectible).flatMap(collectibleProgressIds);
      const saved = ids.filter(id => localStorage.getItem(collectibleProgressKey + id) === '1');
      collected.clear();
      for (const id of saved) collected.add(id);
      if (!story) hideCollected.checked = localStorage.getItem(hideCollectedKey) === '1';
    } catch {
      // Keep the current page's progress when storage is unavailable.
    }
  }

  function updateCollectibleProgress(refreshEntries = hideCollected.checked) {
    const active = document.activeElement;
    if (selectedPlace && isCollectible(selectedPlace) && refreshEntries) {
      if (hideCollected.checked && isCollected(selectedPlace)) {
        resetQuestSelection();
        renderSelectionPanel();
        detail.hidden = true;
        if (selectionPanel.contains(active) || detail.contains(active) || placeLayer.contains(active)) viewport.focus({ preventScroll: true });
      } else {
        if (hideCollected.checked && collected.has(selectedCollectibleEntry?.progressId)) selectedCollectibleEntry = undefined;
        const container = selectionDetails.contains(active) ? selectionDetails
          : sidebarCollectible.contains(active) ? sidebarCollectible : undefined;
        const before = container?.scrollTop;
        renderSelectionPanel();
        sidebarCollectible.replaceChildren();
        appendCollectibleDetails(sidebarCollectible, selectedPlace, true);
        if (container) {
          (container.querySelector('input') ?? clearMapSelection).focus({ preventScroll: true });
          container.scrollTop = before;
        }
      }
    }
    for (const check of mapShell.querySelectorAll('[data-collectible-collected]')) {
      check.checked = collected.has(check.dataset.collectibleCollected);
    }
    onCollectibleProgress?.();
    renderCollectibleResults();
    requestDraw();
  }

  function localPoint(event) {
    viewportOrigin ??= viewport.getBoundingClientRect();
    return { x: event.clientX - viewportOrigin.left, y: event.clientY - viewportOrigin.top };
  }

  function midpoint(a, b) {
    return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
  }

  document.addEventListener('keydown', event => {
    if (event.key !== 'Escape' || mapTooltip.hidden) return;
    hideMapTooltip();
    event.preventDefault();
    event.stopPropagation();
  }, { capture: true, signal: viewSignal });
  viewport.addEventListener('pointerdown', event => {
    if (mapTooltip.contains(event.target)) return;
    hideMapTooltip();
    if (event.button !== 0 || pointers.size >= 2) return;
    if (cameraMotion?.inertia) {
      cameraMotion = undefined;
      requestDraw();
    }
    if (event.target.closest('button')) return;
    event.preventDefault();
    cameraMotion = undefined;
    pendingWheel = undefined;
    expanded = undefined;
    const position = localPoint(event);
    const location = linkURL && !pointers.size
      ? locations.get(event.target.closest('[data-atlas-location]')?.dataset.atlasLocation) : undefined;
    pressedLocation = location && { id: event.pointerId, position, location };
    pointers.set(event.pointerId, position);
    dragSamples.length = 0;
    if (pointers.size === 1) recordDragPosition(event.timeStamp);
    viewport.setPointerCapture(event.pointerId);
    viewport.setAttribute('data-dragging', '');
    viewport.focus({ preventScroll: true });
    requestDraw();
  });
  viewport.addEventListener('pointermove', event => {
    const before = pointers.get(event.pointerId);
    if (!before) return;
    const after = localPoint(event);
    if (pressedLocation?.id === event.pointerId
      && Math.hypot(after.x - pressedLocation.position.x, after.y - pressedLocation.position.y) > 5) {
      pressedLocation = undefined;
    }
    pointers.set(event.pointerId, after);
    if (pointers.size === 2) {
      const ids = pointers.keys();
      const first = ids.next().value;
      const other = pointers.get(first === event.pointerId ? ids.next().value : first);
      const oldDistance = Math.hypot(before.x - other.x, before.y - other.y);
      const newDistance = Math.hypot(after.x - other.x, after.y - other.y);
      if (oldDistance > 1) zoomAt(camera.scale * newDistance / oldDistance, midpoint(before, other), { target: midpoint(after, other) });
    } else {
      fittedSteps = undefined;
      camera.x += after.x - before.x;
      camera.y += after.y - before.y;
      constrainCamera(camera);
      recordDragPosition(event.timeStamp);
      overview = false;
      requestPan();
    }
  });
  for (const event of ['pointerup', 'pointercancel', 'lostpointercapture']) {
    viewport.addEventListener(event, pointer => {
      if (!pointers.delete(pointer.pointerId)) return;
      if (!pointers.size) {
        viewport.removeAttribute('data-dragging');
        const tap = pressedLocation;
        pressedLocation = undefined;
        if (event === 'pointerup' && tap?.id === pointer.pointerId) {
          dragSamples.length = 0;
          showLocation(tap.location, false);
          requestDraw();
          return;
        }
        const coasting = event === 'pointerup' && startPanInertia(pointer.timeStamp);
        dragSamples.length = 0;
        if (coasting) {
          requestPan();
          return;
        }
      } else {
        dragSamples.length = 0;
        recordDragPosition(pointer.timeStamp);
      }
      requestDraw();
    });
  }
  viewport.addEventListener('wheel', event => {
    if (mapTooltip.contains(event.target)) return;
    event.preventDefault();
    const delta = event.deltaY * (event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? viewportHeight : 1);
    if (!delta || pointers.size) return;
    hideMapTooltip();
    pendingWheel ??= { anchor: localPoint(event), delta: 0 };
    pendingWheel.delta += delta;
    requestPan();
  }, { passive: false });
  viewport.addEventListener('keydown', event => {
    if (event.key === 'Escape' && expanded) {
      markerFocus = markerKey(expanded.area, expanded.entries);
      expanded = undefined;
      requestDraw();
      event.preventDefault();
      return;
    }
    if (event.target !== viewport) return;
    const offsets = { ArrowLeft: [55, 0], ArrowRight: [-55, 0], ArrowUp: [0, 55], ArrowDown: [0, -55] };
    if (offsets[event.key]) {
      const [x, y] = offsets[event.key];
      cameraMotion = undefined;
      pendingWheel = undefined;
      fittedSteps = undefined;
      expanded = undefined;
      camera.x += x;
      camera.y += y;
      overview = false;
      requestDraw();
    } else if (event.key === '+' || event.key === '=') zoomBy(1.35);
    else if (event.key === '-') zoomBy(1 / 1.35);
    else if (event.key === 'Home') fitAll();
    else return;
    event.preventDefault();
  });
  plus.addEventListener('click', () => zoomBy(1.35));
  legend.open = !compact.matches;
  legend.addEventListener('toggle', requestDraw);
  minus.addEventListener('click', () => zoomBy(1 / 1.35));
  fit.addEventListener('click', () => fitAll());
  showSteps.addEventListener('click', () => {
    atlasSidebar.open();
    requestAnimationFrame(() => detail.scrollIntoView({ block: 'start' }));
  });
  clearMapSelection.addEventListener('click', clearQuestSelection);
  shareButton?.addEventListener('click', async () => {
    const address = shareTarget && linkURL(shareTarget);
    if (!address) return;
    try {
      await navigator.clipboard.writeText(address);
      if (viewSignal.aborted || !shareTarget || linkURL(shareTarget) !== address) return;
      clearTimeout(shareFeedbackTimer);
      shareStatus.textContent = 'Link copied';
      shareFeedbackTimer = setTimeout(() => { shareStatus.textContent = ''; }, 2000);
    } catch {
      if (viewSignal.aborted || !shareTarget || linkURL(shareTarget) !== address || !shareDialog || shareDialog.open) return;
      shareInput.value = address;
      shareDialog.showModal();
      shareInput.select();
    }
  }, { signal: viewSignal });
  selectionDone?.addEventListener('change', setSelectedDone);
  for (const [button, offset, opposite] of [[previousStep, -1, nextStep], [nextStep, 1, previousStep]]) {
    button.addEventListener('click', () => {
      if (!selected && !selectedRoute) return;
      activateStep((selected?.step ?? linkedRouteStep) + offset, true);
      if (button.disabled) opposite.focus({ preventScroll: true });
    });
  }
  focusSelection.addEventListener('change', () => {
    try {
      localStorage.setItem(focusKey, focusSelection.checked ? 'on' : 'off');
    } catch {
      // The setting still applies to the current view.
    }
    requestDraw();
  });
  for (const input of layerOptions) input.addEventListener('change', () => updateLayers());
  for (const [button, checked] of [[showAll, true], [hideAll, false]]) {
    button.addEventListener('click', () => {
      for (const input of layerOptions) input.checked = checked;
      updateLayers();
      (checked ? hideAll : showAll).focus();
    });
  }
  chapter.addEventListener('change', () => {
    setWindows();
    filterQuests();
  });
  firstWindow.addEventListener('change', () => filterQuests());
  type.addEventListener('change', () => {
    setWindows();
    filterQuests();
    const group = resultGroups.find(group => group.dataset.resultType === type.value);
    if (group) group.open = true;
  });
  area.addEventListener('change', () => {
    if (selectedLocation) {
      setSelectedLocation();
      renderSelectionPanel();
    }
    if (area.value) focusTile(byArea.get(area.value));
    else fitAll();
  });
  function setRouteDone(id, checked) {
    if (checked) completedRoutes.add(id);
    else completedRoutes.delete(id);
    try {
      if (checked) localStorage.setItem(routeProgressKey(id), '1');
      else localStorage.removeItem(routeProgressKey(id));
      onRouteProgress?.(id, checked);
    } catch {
      // Progress still applies to the current view.
    }
    for (const check of mapShell.querySelectorAll(`[data-route-done="${CSS.escape(id)}"]`)) check.checked = checked;
    filterQuests({ keepSelection: true });
  }
  mapShell.addEventListener('change', event => {
    const id = event.target.dataset.routeDone;
    if (id) setRouteDone(id, event.target.checked);
    const collectibleId = event.target.dataset.collectibleCollected;
    if (!collectibleId) return;
    if (event.target.checked) collected.add(collectibleId);
    else collected.delete(collectibleId);
    try {
      if (event.target.checked) localStorage.setItem(collectibleProgressKey + collectibleId, '1');
      else localStorage.removeItem(collectibleProgressKey + collectibleId);
    } catch {
      // Progress still applies to the current view.
    }
    updateCollectibleProgress();
  });
  if (!story) hideCollected.addEventListener('change', () => {
    try {
      localStorage.setItem(hideCollectedKey, hideCollected.checked ? '1' : '0');
    } catch {
      // The filter still applies to the current view.
    }
    updateCollectibleProgress(true);
  });
  window.addEventListener('storage', event => {
    if (story && (event.key === null || story.observes(event.key))) {
      if (event.key === null || story.isObjectiveKey(event.key)) loadMapStoryObjective();
      readMapStoryFilters(undefined, true);
    }
    if (event.key === null || event.key.startsWith(storageKey('route-done:')) || adapter.observesRouteProgress?.(event.key)) {
      loadRouteProgress();
      filterQuests({ keepSelection: true });
    }
    if (event.key === null || event.key === hideCollectedKey || event.key.startsWith(collectibleProgressKey)) {
      const wasHiding = hideCollected.checked;
      loadCollectibleProgress();
      updateCollectibleProgress(wasHiding || hideCollected.checked);
    }
  }, { signal: viewSignal });
  function loadMapStoryObjective() {
    try {
      query('#atlas-objective').value = story.getObjective();
    } catch {
      query('#atlas-objective').value = viewState.filters.objective ?? '';
    }
  }

  function readMapStoryFilters(completed, keepSelection = false) {
    if (!completed) {
      completed = new Set();
      try {
        for (const { id } of quests) if (story.isDone(id)) completed.add(id);
      } catch {
        completed = guideState?.completed ?? completed;
      }
    }
    const picker = query('#atlas-objective');
    const context = query('#atlas-story-context');
    guideState = story.filter(quests.map(quest => quest.id), completed, picker.value,
      hideCollected.checked, query('#atlas-missable').checked);
    Object.assign(viewState.filters, { objective: picker.value, hideCompleted: guideState.hideCompleted,
      missableOnly: guideState.missableOnly });
    context.hidden = !guideState.objective;
    context.textContent = guideState.objective ? picker.selectedOptions[0].textContent : '';
    if (!root.hidden) filterQuests({ keepSelection });
  }

  chapter.value = viewState.chapter ?? '';
  type.value = viewState.type ?? '';
  setWindows();
  firstWindow.value = viewState.firstWindow ?? '';

  if (story) {
    const storyPicker = query('#atlas-objective');
    const missableOnly = query('#atlas-missable');
    viewState.filters ??= {};
    loadMapStoryObjective();
    hideCollected.checked = viewState.filters.hideCompleted ?? false;
    missableOnly.checked = viewState.filters.missableOnly ?? false;
    for (const input of [storyPicker, hideCollected, missableOnly]) input.addEventListener('change', () => {
      if (input === storyPicker) {
        try { story.setObjective(input.value); } catch { /* The current view still applies it. */ }
      }
      readMapStoryFilters(guideState.completed);
      if (input === hideCollected) updateCollectibleProgress(true);
    });
    readMapStoryFilters();
  }

  function openAtlas(link = {}) {
    updateViewportSize(viewport.clientWidth, viewport.clientHeight);
    const { quest: questId, route: routeId, place: placeLink, collectible, step, area: areaLink, street,
      location: locationLink, interior, retry } = resolveLink?.(link) ?? link;
    const hasTarget = questId !== undefined || routeId || placeLink || collectible || areaLink || street || locationLink;
    if (!previousSize) {
      const initial = !hasTarget && !viewState.camera && byArea.get(config.initialArea);
      if (initial) {
        overview = false;
        area.value = initial.id;
        centerAt(initial.x + initial.w / 2, initial.y + initial.h / 2,
          fitScale(initial.w, initial.h), viewportHeight / 2, false);
      } else fitAll(false);
    }
    previousSize = { width: viewportWidth, height: viewportHeight };
    const linkedRoute = step === undefined && !retry && matchingRoutes.find(entry => entry.id === routeId)
      || linkedRoutes.find(entry => entry.id === routeId && Boolean(entry.retry) === Boolean(retry));
    let place = placeLink === undefined ? undefined
      : places.find(item => atlasPlaceLink(item) === String(placeLink))
        ?? places.find(item => item.id === placeLink || `${item.area}:${item.name}` === placeLink);
    let entry;
    if (collectible) {
      const match = places.find(item => isCollectible(item)
        && (item.id === collectible || item.entries?.some(candidate => collectibleEntryKey(item, candidate) === collectible)
          || (item.pickup && collectibleEntryKey(item, item.pickup) === collectible)));
      place = match;
      entry = place?.entries?.find(candidate => collectibleEntryKey(place, candidate) === collectible);
    }
    const location = locationLink ? locations.get(locationLink) ?? locations.get(config.locationAliases?.[locationLink])
      : areaLink ? locations.get('area:' + areaLink) ?? locations.get('district:' + areaLink)
        : street ? locations.get('street:' + street) : undefined;
    const restoring = !hasTarget && viewState.camera;
    if (place) openCollectible(place, entry);
    else if (linkedRoute) openLinkedRoute(linkedRoute, step === undefined ? 0 : Number(step), step !== undefined);
    else if (location) showLocation(location);
    else if (restoring && locations.has(viewState.location)) showLocation(locations.get(viewState.location), false);
    else if (restoring && places[viewState.place]) {
      const previousPlace = places[viewState.place];
      const previousEntry = previousPlace.entries?.find(item => item.progressId === viewState.entry);
      showPlace(previousPlace, undefined, 0, { select: viewState.focusPlace, collectibleEntry: previousEntry });
    } else restoreSelection(questId ?? (restoring ? viewState.spotlight : undefined), Boolean(restoring), step, interior);
    if (restoring) {
      const { x, y, scale } = viewState.camera;
      area.value = viewState.area;
      if (viewState.overview) fitAll(false);
      else if (!fittedSteps) {
        overview = false;
        centerAt(x, y, scale, viewportHeight / 2, false);
      }
    }
  }
  const viewportObserver = new ResizeObserver(([{ contentRect }]) => {
    const size = { width: Math.round(contentRect.width), height: Math.round(contentRect.height) };
    if (!size.width || !size.height || (size.width === viewportWidth && size.height === viewportHeight)) return;
    updateViewportSize(size.width, size.height);
    if (overview || !previousSize) fitAll(Boolean(cameraMotion));
    else if (fittedSteps) fitQuestSteps(fittedSteps);
    else centerAt((previousSize.width / 2 - camera.x) / camera.scale,
      (previousSize.height / 2 - camera.y) / camera.scale, camera.scale, viewportHeight / 2, false);
    previousSize = size;
  });
  viewportObserver.observe(viewport);
  const panelObserver = new ResizeObserver(() => {
    panelBounds = undefined;
    if (fittedSteps) fitQuestSteps(fittedSteps);
    else requestDraw();
  });
  for (const panel of mapPanels) panelObserver.observe(panel, { box: 'border-box' });
  window.addEventListener('scroll', () => { viewportOrigin = undefined; }, { capture: true, passive: true, signal: viewSignal });
  compact.addEventListener('change', () => {
    viewportOrigin = undefined;
    panelBounds = undefined;
    requestDraw();
  }, { signal: viewSignal });
  document.fonts.addEventListener('loadingdone', () => {
    captionMetrics.clear();
    labelBounds.clear();
    requestDraw();
  }, { signal: viewSignal });
  viewSignal.addEventListener('abort', () => {
    clearTimeout(shareFeedbackTimer);
    if (shareDialog?.open) shareDialog.close();
    placeMoves.clear();
    const { x, y, scale } = cameraMotion?.inertia ? camera : cameraMotion?.destination ?? camera;
    Object.assign(viewState, {
      camera: { x: (viewportWidth / 2 - x) / scale, y: (viewportHeight / 2 - y) / scale, scale }, overview,
      chapter: chapter.value, firstWindow: firstWindow.value, type: type.value, area: area.value, fitSteps: Boolean(fittedSteps),
      place: selectedPlace && !selectedRoute ? places.indexOf(selectedPlace) : undefined,
      location: selectedLocation?.key,
      entry: selectedCollectibleEntry?.progressId, focusPlace: focusPlaceSelection, spotlight: spotlight?.id,
    });
    viewportObserver.disconnect();
    panelObserver.disconnect();
    if (frame !== undefined) cancelAnimationFrame(frame);
  }, { once: true });
  loadRouteProgress();
  loadCollectibleProgress();
  updateCollectibleProgress(false);
  setWindows();
  filterQuests();
  try {
    focusSelection.checked = localStorage.getItem(focusKey) !== 'off';
    const savedLayers = JSON.parse(localStorage.getItem(layerKey));
    const hidden = Array.isArray(savedLayers) ? [...savedLayers, ...(config.legacyLayerIds ?? [])] : savedLayers?.hidden;
    if (Array.isArray(hidden)) {
      const knownLayers = Array.isArray(savedLayers.layers) ? new Set(savedLayers.layers) : null;
      for (const [id, input] of layerById) {
        const known = knownLayers ? knownLayers.has(id) : !collectibleTypes.has(id) || config.legacyLayerIds?.includes(id);
        if (known) input.checked = !hidden.includes(id);
      }
    }
  } catch {
    // Keep the default layer settings when saved preferences cannot be read.
  }
  updateLayers(false);
  if (autoOpen) {
    openAtlas();
  }
  return { open: openAtlas };
}

// Runs a single Atlas engine at a time and keeps each map's view state when switching.
function mountAtlasProject(project, { signal, state = {}, adapters = {}, urlNavigation = false } = {}) {
  const picker = project.querySelector('[data-atlas-project-picker]');
  const tabs = [...picker.querySelectorAll('[data-atlas-open-map]')];
  const landing = project.querySelector('[data-atlas-project-landing]');
  const heading = landing.querySelector('.atlas-project-title');
  const titleArt = heading.querySelector('[data-atlas-title-image]');
  const view = project.querySelector('[data-atlas-project-view]');
  const routeSource = project.querySelector('[data-atlas-project-routes]');
  const projectRoutes = new Map((routeSource ? JSON.parse(routeSource.textContent) : []).map(route => [route.id, route]));
  const routePanel = project.querySelector('[data-atlas-project-route]');
  const routeName = routePanel?.querySelector('[data-atlas-route-name]');
  const routeProgress = routePanel?.querySelector('[data-atlas-route-progress]');
  const routeInstructions = routePanel?.querySelector('[data-atlas-route-instructions]');
  const stepButtons = [...routePanel?.querySelectorAll('[data-atlas-project-step]') ?? []];
  const templates = new Map([...project.querySelectorAll('template[data-atlas-map]')]
    .map(template => [template.dataset.atlasMap, template]));
  const fallback = project.dataset.defaultMap;
  const states = state.maps ??= new Map();
  const lifetime = new AbortController();
  const listenerOptions = { signal: lifetime.signal };
  let active;
  let guided;

  function unmountMap() {
    if (!active) return;
    active.controller.abort();
    active = undefined;
    picker.hidden = true;
    project.append(picker);
    if (routePanel && view.contains(routePanel)) {
      routePanel.hidden = true;
      project.append(routePanel);
    }
    view.replaceChildren();
  }

  function clearProjectRoute() {
    guided = undefined;
    delete state.projectRoute;
    if (routePanel) routePanel.hidden = true;
  }

  function showLanding(focus = false) {
    clearProjectRoute();
    unmountMap();
    delete state.map;
    landing.hidden = false;
    if (titleArt && !titleArt.hasAttribute('src')) titleArt.src = titleArt.dataset.atlasTitleImage;
    for (const image of landing.querySelectorAll('[data-atlas-preview]:not([src])')) image.src = image.dataset.atlasPreview;
    if (focus) heading.focus();
  }

  function showTitleImage() {
    if (!titleArt.naturalWidth) return;
    heading.querySelector('span').hidden = true;
    titleArt.hidden = false;
    heading.setAttribute('data-atlas-title-loaded', '');
  }

  function show({ map = active?.id ?? state.map ?? fallback, ...link } = {}) {
    const template = templates.get(map);
    if (!template || lifetime.signal.aborted) return false;
    if (active?.id !== map) {
      const keepFocus = picker.contains(document.activeElement);
      unmountMap();
      const content = template.content.cloneNode(true);
      content.querySelector('[data-atlas-sidebar-top]').prepend(picker);
      const currentTab = tabs.find(tab => tab.dataset.atlasOpenMap === map);
      for (const tab of tabs) tab.removeAttribute('aria-current');
      currentTab.setAttribute('aria-current', 'page');
      picker.hidden = false;
      landing.hidden = true;
      view.replaceChildren(content);
      if (keepFocus) currentTab.focus({ preventScroll: true });

      if (!states.has(map)) states.set(map, {});
      const controller = new AbortController();
      const atlas = mountAtlas(view, {
        signal: controller.signal,
        state: states.get(map),
        adapter: Object.hasOwn(adapters, map) ? adapters[map] : {},
        autoOpen: false,
        linkURL: urlNavigation ? link => {
          const target = guided?.route.steps[guided.step];
          const parameters = target?.map === map && target.place === link.place
            ? new URLSearchParams({ map, route: guided.route.id, step: guided.step + 1 })
            : atlasLinkParams(link, new URLSearchParams({ map }));
          return atlasShareURL(parameters);
        } : undefined,
      });
      active = { id: map, controller, atlas };
      state.map = map;
      atlas.open(link);
    } else if (Object.keys(link).length) {
      active.atlas.open(link);
    }
    return true;
  }

  function showFromURL() {
    const parameters = new URLSearchParams(location.hash.slice(1));
    const route = projectRoutes.get(parameters.get('route'));
    if (route) {
      const value = parameters.get('step') ?? '';
      const index = /^[1-9]\d*$/.test(value) ? Number(value) - 1 : 0;
      showProjectRoute(route.id, route.steps[index] ? index : 0);
      return;
    }
    clearProjectRoute();
    const map = parameters.get('map');
    if (!templates.has(map)) {
      showLanding(view.contains(document.activeElement));
      return;
    }
    show({ map, ...readAtlasLink(parameters) });
  }

  function updateHash(parameters = '') {
    if (!urlNavigation) return;
    const url = new URL(location.href);
    url.hash = String(parameters);
    if (location.hash !== url.hash) history.pushState(history.state, '', url);
  }

  function showProjectRoute(id, step = 0) {
    const route = projectRoutes.get(id);
    const target = Number.isInteger(step) && route?.steps[step];
    if (!target) return false;
    const focused = stepButtons.find(button => button === document.activeElement);
    if (!show({ map: target.map, place: target.place })) return false;
    guided = { route, step };
    state.projectRoute = { id, step };
    const selection = view.querySelector('#atlas-selection');
    if (routePanel.parentNode !== selection) selection.append(routePanel);
    routePanel.hidden = false;
    routeName.textContent = route.label;
    routeProgress.textContent = `Step ${step + 1} of ${route.steps.length} · ${target.mapLabel} · ${target.label}`;
    routeInstructions.textContent = target.text;
    for (const button of stepButtons) {
      const adjacent = route.steps[step + Number(button.dataset.atlasProjectStep)];
      button.disabled = !adjacent;
      if (adjacent) button.setAttribute('aria-label', `${button.textContent}: ${adjacent.mapLabel} · ${adjacent.label}`);
      else button.removeAttribute('aria-label');
    }
    if (matchMedia('(max-width: 48rem)').matches) selection.scrollIntoView({ block: 'nearest' });
    if (focused) {
      const target = focused.disabled ? stepButtons.find(button => !button.disabled) : focused;
      target?.focus({ preventScroll: true });
    }
    return true;
  }

  function open(link = {}) {
    if (link.projectRoute !== undefined) {
      if (!showProjectRoute(link.projectRoute, link.step)) return false;
      updateHash(new URLSearchParams({ map: active.id, route: guided.route.id, step: String(guided.step + 1) }));
      return true;
    }
    if (!show(link)) return false;
    clearProjectRoute();
    updateHash(atlasLinkParams(link, new URLSearchParams({ map: active.id })));
    return true;
  }

  function destroy() {
    if (lifetime.signal.aborted) return;
    lifetime.abort();
    unmountMap();
    landing.hidden = true;
  }

  if (signal?.aborted) {
    destroy();
  } else {
    signal?.addEventListener('abort', destroy, { ...listenerOptions, once: true });
    if (titleArt) {
      titleArt.addEventListener('load', showTitleImage, { ...listenerOptions, once: true });
      if (titleArt.complete) showTitleImage();
    }
    project.addEventListener('click', event => {
      const stepButton = event.target.closest('button[data-atlas-project-step]');
      if (stepButton && guided && !stepButton.disabled) {
        open({ projectRoute: guided.route.id, step: guided.step + Number(stepButton.dataset.atlasProjectStep) });
        return;
      }
      if (guided && event.target.closest('#atlas-clear-selection')) {
        clearProjectRoute();
        updateHash(new URLSearchParams({ map: active.id }));
        return;
      }
      const link = event.target.closest('a[data-atlas-open-map], a[data-atlas-show-landing]');
      if (!link || event.defaultPrevented || event.button !== 0
        || event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
      event.preventDefault();
      if (link.hasAttribute('data-atlas-show-landing')) {
        showLanding(true);
        updateHash();
        return;
      }
      const focusMap = landing.contains(link) || matchMedia('(max-width: 48rem)').matches;
      if (open({ map: link.dataset.atlasOpenMap }) && focusMap) {
        const viewport = view.querySelector('#atlas-map');
        viewport.closest('.atlas-stage').scrollIntoView({ block: 'start' });
        viewport.focus({ preventScroll: true });
      }
    }, listenerOptions);
    if (urlNavigation) {
      window.addEventListener('hashchange', showFromURL, listenerOptions);
      showFromURL();
    } else if (!showProjectRoute(state.projectRoute?.id, state.projectRoute?.step)) {
      clearProjectRoute();
      if (templates.has(state.map)) show({ map: state.map });
      else showLanding();
    }
  }
  return { open, destroy };
}

// Kenzan's side guide shares story and progress with its map.
function mountKenzanMap(signal, state) {
  const integrated = document.querySelector('#quest-map[data-integrated]');
  const root = integrated ?? document.body;
  const storyData = integrated && JSON.parse(root.querySelector('#atlas-story-data').textContent);
  const abilities = storyData?.revelationAbilities ?? {};
  const revelationPrefix = 'kenzan-guide:revelation-done:';
  const abilityPrefix = 'kenzan-guide:side-done:';

  function writeProgress(key, checked) {
    if (checked) localStorage.setItem(key, '1');
    else localStorage.removeItem(key);
  }

  const story = storyData && {
    getObjective() {
      const saved = localStorage.getItem(storyWindowKey);
      return Object.hasOwn(storyData.checkpoints, saved) ? saved : '';
    },
    setObjective: value => localStorage.setItem(storyWindowKey, value),
    isDone: id => localStorage.getItem(questProgressPrefix + id) === '1',
    setDone: (id, checked) => writeProgress(questProgressPrefix + id, checked),
    observes: key => key === storyWindowKey || key.startsWith(questProgressPrefix),
    isObjectiveKey: key => key === storyWindowKey,
    filter: (...filters) => questMapFilter(storyData, ...filters),
  };

  const adapter = {
    story,
    routeProgressKey: id => revelationPrefix + id,
    routeDone: id => abilities[id] && localStorage.getItem(abilityPrefix + abilities[id]) === '1',
    observesRouteProgress: key => key.startsWith(revelationPrefix) || key.startsWith(abilityPrefix + 'ability-'),
    onRouteProgress(id, checked) {
      if (abilities[id]) writeProgress(abilityPrefix + abilities[id], checked);
    },
    onCollectibleProgress() {
      document.dispatchEvent(new Event('kenzan:collectible-progress'));
    },
    routeAvailable(entry, guideState, completed) {
      if (guideState?.missableOnly && !entry.missable) return false;
      const checkpoint = guideState?.checkpoint;
      if ((guideState?.hideCompleted || guideState?.missableOnly) && completed.has(entry.id)) return false;
      if (!checkpoint) return !entry.retry;
      const { order, clock, code } = checkpoint;
      const [chapter, window] = entry.window.split('-').map(Number);
      if (order < chapter * 100 + window || (entry.cutoff && order >= 1204)) return false;
      if (entry.id === 'dry-leaf-smash') return entry.retry ? order >= 901 && Boolean(clock) : code === '8-8' || code === '8-9';
      if (!clock) return entry.id === 'illusory-wolf' && code === '9-8';
      return /^(Any time|Before|Start before)/i.test(entry.time) || entry.time.toLowerCase().includes(clock);
    },
    resolveLink({ share, mapQuest, mapRevelation, mapLockerKey, mapPlace, mapCollectible, mapStep, mapArea, mapStreet, ...link }) {
      if (share !== undefined) return readAtlasLink(new URLSearchParams(share));
      return {
        ...link,
        quest: mapQuest ? Number(mapQuest) : link.quest,
        route: mapRevelation ?? link.route,
        place: mapPlace ?? (mapLockerKey ? 'locker:' + mapLockerKey : mapRevelation === 'shichigoro' ? mapRevelation : link.place),
        collectible: mapCollectible ?? link.collectible,
        step: mapStep ?? link.step,
        area: mapArea ?? link.area,
        street: mapStreet ?? link.street,
      };
    },
  };
  const atlas = mountAtlas(root, {
    signal, state, adapter, autoOpen: false,
    linkURL: link => atlasShareURL((integrated ? 'quest-map?' : '') + atlasLinkParams(link)),
  });
  if (!integrated) {
    const openFromURL = () => atlas.open(readAtlasLink(new URLSearchParams(location.hash.slice(1))));
    window.addEventListener('hashchange', openFromURL, { signal });
    openFromURL();
  }
  return atlas;
}

return mountKenzanMap(viewSignal, viewState);
}
