(async () => {
  const { api, getToken, requireSession, initials, clearAuth, startSessionHeartbeat, toast } = window.Shelf;
  const user = await requireSession();
  if (!user) return;
  const id = new URLSearchParams(location.search).get('id');
  if (!id) { location.replace('/library'); return; }

  document.getElementById('readerUser').textContent = user.name;
  document.getElementById('readerUsername').textContent = `@${user.username}`;
  document.getElementById('readerInitial').textContent = initials(user.name);
  document.getElementById('backButton').addEventListener('click', () => location.href = user.role === 'ADMIN' ? '/admin' : '/library');
  document.getElementById('returnLogin').addEventListener('click', () => { clearAuth(); location.replace('/'); });

  function showRevoked() {
    document.getElementById('sessionAlert').classList.remove('hidden');
  }
  startSessionHeartbeat({ onRevoked: showRevoked, interval: 5000 });

  const watermark = document.getElementById('watermarkLayer');
  const wmText = `${user.username} · PRIVATE COPY`;
  watermark.innerHTML = Array.from({ length: 32 }, () => `<div class="watermark-item">${window.Shelf.escapeHtml(wmText)}</div>`).join('');

  document.addEventListener('contextmenu', (e) => e.preventDefault());
  document.addEventListener('keydown', (e) => {
    if ((e.ctrlKey || e.metaKey) && ['s', 'p', 'u'].includes(e.key.toLowerCase())) { e.preventDefault(); toast('Download/print shortcuts are disabled in this reader.', 'info'); }
  });

  // Fullscreen toggle
  document.getElementById('fullscreenButton').addEventListener('click', () => {
    if (!document.fullscreenElement) document.documentElement.requestFullscreen?.().catch(() => {});
    else document.exitFullscreen?.();
  });

  pdfjsLib.GlobalWorkerOptions.workerSrc = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js';

  const scrollEl = document.getElementById('readerScroll');
  const pagesEl = document.getElementById('readerPages');
  const zoomLabel = document.getElementById('zoomLabel');
  const pageLabel = document.getElementById('pageLabel');
  const zoomInBtn = document.getElementById('zoomInBtn');
  const zoomOutBtn = document.getElementById('zoomOutBtn');
  const fitWidthBtn = document.getElementById('fitWidthBtn');
  const prevPageBtn = document.getElementById('prevPageBtn');
  const nextPageBtn = document.getElementById('nextPageBtn');

  const MIN_SCALE = 0.4;
  const MAX_SCALE = 4;
  let pdfDoc = null;
  let pageCount = 0;
  let currentScale = 1;
  let baseWidth = 0; // page width at scale 1 (css px)
  let currentPage = 1;
  let renderToken = 0;

  function clampScale(s) { return Math.min(MAX_SCALE, Math.max(MIN_SCALE, s)); }
  function setZoomLabel() { zoomLabel.textContent = `${Math.round(currentScale * 100)}%`; }
  function setPageLabel() { pageLabel.textContent = `${currentPage} / ${pageCount}`; }

  async function renderAllPages(scale) {
    const myToken = ++renderToken;
    const dpr = Math.min(window.devicePixelRatio || 1, 2.5);
    pagesEl.innerHTML = '';
    for (let num = 1; num <= pageCount; num++) {
      if (myToken !== renderToken) return;
      const page = await pdfDoc.getPage(num);
      const viewport = page.getViewport({ scale });
      const wrap = document.createElement('div');
      wrap.className = 'pdf-page-wrap';
      wrap.style.width = `${viewport.width}px`;
      wrap.style.height = `${viewport.height}px`;
      wrap.dataset.page = String(num);
      const canvas = document.createElement('canvas');
      canvas.width = Math.floor(viewport.width * dpr);
      canvas.height = Math.floor(viewport.height * dpr);
      canvas.style.width = `${viewport.width}px`;
      canvas.style.height = `${viewport.height}px`;
      const ctx = canvas.getContext('2d');
      ctx.scale(dpr, dpr);
      wrap.appendChild(canvas);
      pagesEl.appendChild(wrap);
      await page.render({ canvasContext: ctx, viewport }).promise;
      if (myToken !== renderToken) return;
    }
    observePages();
  }

  let io = null;
  function observePages() {
    if (io) io.disconnect();
    io = new IntersectionObserver((entries) => {
      let best = null;
      for (const entry of entries) {
        if (entry.isIntersecting && (!best || entry.intersectionRatio > best.intersectionRatio)) best = entry;
      }
      if (best) {
        currentPage = Number(best.target.dataset.page);
        setPageLabel();
      }
    }, { root: scrollEl, threshold: [0.25, 0.5, 0.75] });
    pagesEl.querySelectorAll('.pdf-page-wrap').forEach((el) => io.observe(el));
  }

  function scrollToPage(num) {
    const target = pagesEl.querySelector(`.pdf-page-wrap[data-page="${num}"]`);
    if (target) target.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  // --- Point-anchored zoom helpers -----------------------------------
  // Keeps whatever content is under the cursor/fingers fixed in place
  // while the scale changes, instead of always zooming from the top.
  function captureAnchor(clientX, clientY) {
    const rect = scrollEl.getBoundingClientRect();
    const x = clientX - rect.left;
    const y = clientY - rect.top;
    return {
      x, y,
      ratioX: scrollEl.scrollWidth ? (scrollEl.scrollLeft + x) / scrollEl.scrollWidth : 0,
      ratioY: scrollEl.scrollHeight ? (scrollEl.scrollTop + y) / scrollEl.scrollHeight : 0,
    };
  }
  function applyAnchor(anchor) {
    scrollEl.scrollLeft = anchor.ratioX * scrollEl.scrollWidth - anchor.x;
    scrollEl.scrollTop = anchor.ratioY * scrollEl.scrollHeight - anchor.y;
  }
  function viewportCenterClient() {
    const rect = scrollEl.getBoundingClientRect();
    return { clientX: rect.left + rect.width / 2, clientY: rect.top + rect.height / 2 };
  }

  let zoomDebounce = null;
  function applyZoom(newScale, opts = {}) {
    const center = opts.clientX != null ? { clientX: opts.clientX, clientY: opts.clientY } : viewportCenterClient();
    const anchor = captureAnchor(center.clientX, center.clientY);
    currentScale = clampScale(newScale);
    setZoomLabel();
    const commit = () => renderAllPages(currentScale).then(() => applyAnchor(anchor));
    if (opts.immediate) { commit(); return; }
    clearTimeout(zoomDebounce);
    zoomDebounce = setTimeout(commit, 140);
  }

  zoomInBtn.addEventListener('click', () => applyZoom(currentScale + 0.2, { immediate: true }));
  zoomOutBtn.addEventListener('click', () => applyZoom(currentScale - 0.2, { immediate: true }));
  fitWidthBtn.addEventListener('click', () => {
    if (!baseWidth) return;
    const available = scrollEl.clientWidth - 32;
    applyZoom(available / baseWidth, { immediate: true });
  });
  prevPageBtn.addEventListener('click', () => scrollToPage(Math.max(1, currentPage - 1)));
  nextPageBtn.addEventListener('click', () => scrollToPage(Math.min(pageCount, currentPage + 1)));

  // Ctrl / Cmd + wheel to zoom (desktop trackpad / mouse) — anchored at the cursor
  scrollEl.addEventListener('wheel', (e) => {
    if (!(e.ctrlKey || e.metaKey)) return;
    e.preventDefault();
    const delta = e.deltaY > 0 ? -0.1 : 0.1;
    applyZoom(currentScale + delta, { clientX: e.clientX, clientY: e.clientY });
  }, { passive: false });

  // Pinch-to-zoom on touch devices — anchored at the midpoint between the two fingers
  let pinchState = null;
  scrollEl.addEventListener('touchstart', (e) => {
    if (e.touches.length === 2) {
      const [a, b] = e.touches;
      const dist = Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY);
      const midClientX = (a.clientX + b.clientX) / 2;
      const midClientY = (a.clientY + b.clientY) / 2;
      const pagesRect = pagesEl.getBoundingClientRect();
      const originX = pagesRect.width ? ((midClientX - pagesRect.left) / pagesRect.width) * 100 : 50;
      const originY = pagesRect.height ? ((midClientY - pagesRect.top) / pagesRect.height) * 100 : 0;
      pagesEl.style.transformOrigin = `${originX}% ${originY}%`;
      pinchState = {
        startDist: dist,
        startScale: currentScale,
        anchor: captureAnchor(midClientX, midClientY),
      };
    }
  }, { passive: true });

  scrollEl.addEventListener('touchmove', (e) => {
    if (e.touches.length === 2 && pinchState) {
      e.preventDefault();
      const [a, b] = e.touches;
      const dist = Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY);
      const ratio = dist / pinchState.startDist;
      const targetScale = clampScale(pinchState.startScale * ratio);
      currentScale = targetScale;
      setZoomLabel();
      pagesEl.style.transform = `scale(${targetScale / pinchState.startScale})`;
    }
  }, { passive: false });

  scrollEl.addEventListener('touchend', (e) => {
    if (pinchState && e.touches.length < 2) {
      pagesEl.style.transform = '';
      const finalScale = currentScale;
      const anchor = pinchState.anchor;
      pinchState = null;
      renderAllPages(finalScale).then(() => {
        applyAnchor(anchor);
        pagesEl.style.transformOrigin = '';
      });
    }
  }, { passive: true });

  // Double-tap to zoom in/out on touch — anchored at the tap point
  let lastTap = 0;
  scrollEl.addEventListener('touchend', (e) => {
    if (e.touches.length > 0) return;
    const now = Date.now();
    if (now - lastTap < 300 && e.changedTouches.length) {
      const t = e.changedTouches[0];
      applyZoom(currentScale >= 1.6 ? 1 : currentScale + 0.6, { immediate: true, clientX: t.clientX, clientY: t.clientY });
    }
    lastTap = now;
  });

  try {
    const library = await api('/api/library');
    const book = (library.items || []).find((b) => b.id === id);
    if (!book && user.role !== 'ADMIN') throw new Error('This PDF is not assigned to your account.');
    document.getElementById('readerTitle').textContent = book?.title || 'Private PDF';
    document.title = `${book?.title || 'Reader'} — PDFshelf`;

    const response = await fetch(`/api/pdfs/${encodeURIComponent(id)}/file`, { headers: { Authorization: `Bearer ${getToken()}` }, cache: 'no-store' });
    if (response.status === 401) { showRevoked(); return; }
    if (!response.ok) { const data = await response.json().catch(() => null); throw new Error(data?.message || 'Unable to open the PDF.'); }
    const arrayBuffer = await response.arrayBuffer();

    pdfDoc = await pdfjsLib.getDocument({ data: arrayBuffer }).promise;
    pageCount = pdfDoc.numPages;
    const firstPage = await pdfDoc.getPage(1);
    baseWidth = firstPage.getViewport({ scale: 1 }).width;

    const available = scrollEl.clientWidth - 32;
    currentScale = clampScale(available / baseWidth);
    setZoomLabel();
    setPageLabel();
    await renderAllPages(currentScale);

    document.getElementById('readerLoading').classList.add('hidden');
  } catch (error) {
    document.getElementById('readerLoading').innerHTML = `<div class="loader-card"><strong>Unable to open this document</strong><span>${window.Shelf.escapeHtml(error.message)}</span><div style="margin-top:16px"><button class="btn btn-primary" onclick="location.href='${user.role === 'ADMIN' ? '/admin' : '/library'}'">Go back</button></div></div>`;
    document.getElementById('readerLoading').classList.remove('hidden');
  }
})();
