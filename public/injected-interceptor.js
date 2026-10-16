// MAIN-world bridge. Capture the attempt token before any asynchronous work so
// a late blob can never be attributed to a newer request.
(() => {
  if (window.__monkeysInterceptorInstalled) return;
  window.__monkeysInterceptorInstalled = true;
  // Observe only Studio's own single-post loader. Preserve the original fetch
  // response and emit counts/IDs, never tweet bodies, headers or credentials.
  const originalFetch = window.fetch;
  if (originalFetch) window.fetch = function(input) {
    const result = originalFetch.apply(this, arguments);
    const token = document.documentElement.getAttribute('data-monkeys-job-token');
    if (token) {
      try {
        const url = new URL(typeof input === 'string' ? input : input.url, location.href);
        const id = url.pathname.match(/^\/api\/snapshot\/tweet\/(\d+)$/)?.[1];
        if (url.origin === location.origin && id) result.then(response => response.clone().json().then(post => {
          const text = typeof post.text === 'string' ? post.text : '';
          const sourceId = String(post.id_str ?? post.id ?? '');
          window.postMessage({ type: 'MONKEYS_STUDIO_POST_METADATA', token, targetId: id,
            sourcePostId: /^\d+$/.test(sourceId) ? sourceId : undefined, responseStatus: response.status,
            textLength: text.length, mentionCount: (text.match(/@\w+/g) ?? []).length,
            leadingMentionCount: (text.match(/^(?:\s*@\w+\s+)+/)?.[0].match(/@\w+/g) ?? []).length,
            displayTextStart: Array.isArray(post.display_text_range) ? post.display_text_range[0] : undefined }, '*');
        })).catch(() => {});
      } catch { /* not a Studio post request */ }
    }
    return result;
  };
  const activeToken = () => Number(document.documentElement.getAttribute('data-monkeys-export-until')) > Date.now()
    ? document.documentElement.getAttribute('data-monkeys-export-token') : null;
  // html-to-image awaits an animation frame after image.decode(). Chrome pauses
  // those frames in background tabs, even while the machine remains awake.
  // During an authorized export only, race that frame against a bounded timer.
  const nativeFrame = window.requestAnimationFrame;
  const nativeCancelFrame = window.cancelAnimationFrame;
  const pendingFrames = new Map();
  let frameToken;
  let frameFallbacks = 0;
  if (nativeFrame && nativeCancelFrame) {
    window.requestAnimationFrame = function(callback) {
      const token = activeToken();
      if (!token) return nativeFrame.call(this, callback);
      let done = false, timer, id;
      const finish = time => {
        if (done) return;
        done = true; clearTimeout(timer); pendingFrames.delete(id);
        callback(time);
      };
      id = nativeFrame.call(this, finish);
      timer = setTimeout(() => {
        // Export completion must not cancel unrelated native page callbacks.
        if (activeToken() !== token) { clearTimeout(timer); pendingFrames.delete(id); return; }
        nativeCancelFrame.call(window, id);
        if (frameToken !== token) { frameToken = token; frameFallbacks = 0; }
        frameFallbacks++;
        if (frameFallbacks === 1) window.postMessage({ type: 'MONKEYS_EXPORT_PROGRESS', token,
          event: 'frame_fallback', count: frameFallbacks, visibilityState: document.visibilityState }, '*');
        finish(performance.now());
      }, 100);
      pendingFrames.set(id, () => { done = true; clearTimeout(timer); pendingFrames.delete(id); });
      return id;
    };
    window.cancelAnimationFrame = function(id) {
      pendingFrames.get(id)?.();
      return nativeCancelFrame.call(this, id);
    };
  }
  // Keep the final base64 message below the coordinator's 6 MB character cap.
  // Studio exports at pixelRatio 2; image-heavy PNGs can exceed that cap.
  const MAX_BYTES = 4_400_000;
  const raster = blob => blob instanceof Blob && ['image/png', 'image/jpeg'].includes(blob.type.toLowerCase());
  const failed = (token, error) => window.postMessage({ type: 'MONKEYS_EXPORT_FAILED', token,
    error: error instanceof Error ? error.message : 'Studio image export failed.' }, '*');
  const emitBlob = async (blob, token) => {
    // Ignore intermediate vector images and unrelated media.
    if (!raster(blob)) return;
    window.postMessage({ type: 'MONKEYS_EXPORT_PROGRESS', token, event: 'blob_captured', bytes: blob.size, imageFormat: blob.type }, '*');
    let bitmap;
    try {
      if (blob.size > MAX_BYTES) {
        if (blob.size > 32_000_000) throw new Error('Studio image exceeds 32 MB before compression.');
        bitmap = await createImageBitmap(blob);
        if (!bitmap.width || !bitmap.height || bitmap.width * bitmap.height > 50_000_000) throw new Error('Studio image dimensions are too large.');
        const scale = Math.min(1, 1600 / Math.max(bitmap.width, bitmap.height));
        const canvas = document.createElement('canvas');
        canvas.width = Math.max(1, Math.round(bitmap.width * scale));
        canvas.height = Math.max(1, Math.round(bitmap.height * scale));
        const context = canvas.getContext('2d');
        if (!context) throw new Error('Image compression is unavailable.');
        context.fillStyle = '#ffffff';
        context.fillRect(0, 0, canvas.width, canvas.height);
        context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
        blob = await new Promise((resolve, reject) => canvas.toBlob(result => result ? resolve(result)
          : reject(new Error('Studio image compression failed.')), 'image/jpeg', 0.9));
        if (blob.size > MAX_BYTES) throw new Error('Studio image is still too large after compression.');
      }
      const reader = new FileReader();
      reader.onload = () => window.postMessage({ type: 'MONKEYS_INTERCEPTED_BLOB', token, dataUrl: reader.result }, '*');
      reader.onerror = () => failed(token, new Error('Could not read the Studio image.'));
      reader.readAsDataURL(blob);
    } catch (error) { failed(token, error); }
    finally { bitmap?.close(); }
  };
  if (navigator.clipboard) {
    const originalWrite = navigator.clipboard.write;
    navigator.clipboard.write = function(items) {
      const token = activeToken();
      if (token) for (const item of items || []) {
        if (item.types?.includes('image/png')) item.getType('image/png').then(blob => emitBlob(blob, token)).catch(error => failed(token, error));
      }
      return originalWrite.apply(this, arguments);
    };
  }
  const originalCreateObjectURL = window.URL.createObjectURL;
  window.URL.createObjectURL = function(obj) {
    const token = activeToken();
    if (token && raster(obj)) void emitBlob(obj, token);
    return originalCreateObjectURL.apply(this, arguments);
  };
  window.addEventListener('click', event => {
    const token = activeToken();
    if (!token) return;
    const anchor = event.target.closest?.('a[download]');
    if (!anchor) return;
    const href = anchor.getAttribute('href') || anchor.href;
    if (/^data:image\/(?:png|jpeg)[;,]/i.test(href) || href.startsWith('blob:')) {
      event.preventDefault(); event.stopPropagation();
      fetch(href).then(response => response.blob()).then(blob => emitBlob(blob, token)).catch(error => failed(token, error));
    }
  }, true);
  window.addEventListener('message', event => {
    if (event.source === window && event.data?.type === 'MONKEYS_BRIDGE_PING') {
      window.postMessage({ type: 'MONKEYS_BRIDGE_READY', token: event.data.token, version: '2' }, '*');
    }
  });
})();
