(async () => {
  const {
    api,
    getToken,
    requireSession,
    initials,
    clearAuth,
    startSessionHeartbeat,
    toast
  } = window.Shelf;

  const user = await requireSession();
  if (!user) return;

  const id = new URLSearchParams(location.search).get('id');
  if (!id) {
    location.replace('/library');
    return;
  }

  const $ = (id) => document.getElementById(id);

  const readerUser = $('readerUser');
  const readerUsername = $('readerUsername');
  const readerInitial = $('readerInitial');
  const readerTitle = $('readerTitle');
  const readerSubtitle = $('readerSubtitle');
  const readerLoading = $('readerLoading');
  const readerScroll = $('readerScroll');
  const readerPages = $('readerPages');
  const watermarkLayer = $('watermarkLayer');
  const sessionAlert = $('sessionAlert');

  const pageNumberInput = $('pageNumberInput');
  const pageCountLabel = $('pageCountLabel');
  const zoomLabel = $('zoomLabel');
  const prevPageBtn = $('prevPageBtn');
  const nextPageBtn = $('nextPageBtn');
  const zoomOutBtn = $('zoomOutBtn');
  const zoomInBtn = $('zoomInBtn');
  const fitWidthBtn = $('fitWidthBtn');

  readerUser.textContent = user.name;
  readerUsername.textContent = `@${user.username}`;
  readerInitial.textContent = initials(user.name);

  $('backButton').addEventListener('click', () => {
    location.href = user.role === 'ADMIN' ? '/admin' : '/library';
  });

  $('returnLogin').addEventListener('click', () => {
    clearAuth();
    location.replace('/');
  });

  function showRevoked() {
    sessionAlert.classList.remove('hidden');
  }

  startSessionHeartbeat({
    onRevoked: showRevoked,
    interval: 5000
  });

  const wmText = `${user.username} · PRIVATE COPY`;

  watermarkLayer.innerHTML = Array.from(
    { length: 28 },
    () =>
      `<div class="watermark-item">${window.Shelf.escapeHtml(
        wmText
      )}</div>`
  ).join('');

  document.addEventListener('contextmenu', (event) => {
    event.preventDefault();
  });

  document.addEventListener('keydown', (event) => {
    if (
      (event.ctrlKey || event.metaKey) &&
      ['s', 'p', 'u'].includes(event.key.toLowerCase())
    ) {
      event.preventDefault();

      toast(
        'Download/print shortcuts are disabled in this reader.',
        'info'
      );
    }
  });

  $('fullscreenButton').addEventListener('click', async () => {
    try {
      if (!document.fullscreenElement) {
        await document.documentElement.requestFullscreen?.();
      } else {
        await document.exitFullscreen?.();
      }
    } catch (_) {
      // Some mobile browsers intentionally do not expose fullscreen.
    }
  });

  pdfjsLib.GlobalWorkerOptions.workerSrc =
    'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js';

  const MIN_SCALE = 0.35;
  const MAX_SCALE = 4;
  const ZOOM_STEP = 0.18;

  const MOBILE_DPR_CAP = 2;
  const DESKTOP_DPR_CAP = 2.5;

  let pdfDoc = null;
  let pageCount = 0;
  let basePageWidth = 0;

  let currentScale = 1;
  let currentPage = 1;

  let fitMode = true;
  let renderToken = 0;

  let pageObserver = null;
  let resizeTimer = null;
  let pinchState = null;

  const clamp = (value, min, max) =>
    Math.min(max, Math.max(min, value));

  const clampScale = (value) =>
    clamp(value, MIN_SCALE, MAX_SCALE);

  function horizontalReaderPadding() {
    const style = getComputedStyle(readerScroll);

    return (
      parseFloat(style.paddingLeft || '0') +
      parseFloat(style.paddingRight || '0')
    );
  }

  function availablePageWidth() {
    // clientWidth is the CSS viewport width.
    // Subtract real CSS padding instead of a hard-coded value.
    return Math.max(
      120,
      readerScroll.clientWidth -
        horizontalReaderPadding() -
        2
    );
  }

  function calculateFitScale() {
    if (!basePageWidth) {
      return currentScale;
    }

    return clampScale(
      availablePageWidth() / basePageWidth
    );
  }

  function updateZoomUI() {
    zoomLabel.textContent = fitMode
      ? 'Fit'
      : `${Math.round(currentScale * 100)}%`;

    fitWidthBtn.classList.toggle(
      'is-active',
      fitMode
    );

    zoomOutBtn.disabled =
      currentScale <= MIN_SCALE + 0.001;

    zoomInBtn.disabled =
      currentScale >= MAX_SCALE - 0.001;
  }

  function updatePageUI() {
    pageNumberInput.value = String(
      currentPage || 1
    );

    pageNumberInput.max = String(
      Math.max(1, pageCount)
    );

    pageCountLabel.textContent = pageCount
      ? String(pageCount)
      : '—';

    prevPageBtn.disabled =
      !pageCount || currentPage <= 1;

    nextPageBtn.disabled =
      !pageCount || currentPage >= pageCount;
  }

  function setCurrentPage(pageNumber) {
    const next = clamp(
      Number(pageNumber) || 1,
      1,
      Math.max(1, pageCount)
    );

    if (next === currentPage) {
      updatePageUI();
      return;
    }

    currentPage = next;
    updatePageUI();
  }

  function disconnectPageObserver() {
    if (pageObserver) {
      pageObserver.disconnect();
      pageObserver = null;
    }
  }

  function observePages() {
    disconnectPageObserver();

    pageObserver = new IntersectionObserver(
      (entries) => {
        const visible = entries
          .filter((entry) => entry.isIntersecting)
          .sort(
            (a, b) =>
              b.intersectionRatio -
              a.intersectionRatio
          );

        if (visible.length) {
          setCurrentPage(
            Number(
              visible[0].target.dataset.page
            )
          );
        }
      },
      {
        root: readerScroll,
        threshold: [
          0.18,
          0.35,
          0.55,
          0.75
        ]
      }
    );

    readerPages
      .querySelectorAll('.pdf-page-wrap')
      .forEach((element) => {
        pageObserver.observe(element);
      });
  }

  function getPageElement(pageNumber) {
    return readerPages.querySelector(
      `.pdf-page-wrap[data-page="${pageNumber}"]`
    );
  }

  function nearestPageAt(clientX, clientY) {
    const pages = [
      ...readerPages.querySelectorAll(
        '.pdf-page-wrap'
      )
    ];

    if (!pages.length) {
      return null;
    }

    let best = null;
    let bestDistance = Infinity;

    for (const page of pages) {
      const rect =
        page.getBoundingClientRect();

      const dx =
        clientX < rect.left
          ? rect.left - clientX
          : clientX > rect.right
            ? clientX - rect.right
            : 0;

      const dy =
        clientY < rect.top
          ? rect.top - clientY
          : clientY > rect.bottom
            ? clientY - rect.bottom
            : 0;

      const distance =
        Math.hypot(dx, dy);

      if (
        distance <
        bestDistance
      ) {
        best = {
          page,
          rect
        };

        bestDistance =
          distance;

        if (
          distance === 0
        ) {
          break;
        }
      }
    }

    return best;
  }

  // Capture the exact PDF point currently underneath
  // a screen coordinate.
  //
  // We store the point as a normalized location inside
  // one rendered PDF page, so the same document point
  // can be restored after rendering at another scale.
  function captureZoomAnchor(
    clientX,
    clientY
  ) {
    const scrollRect =
      readerScroll.getBoundingClientRect();

    const hit =
      nearestPageAt(
        clientX,
        clientY
      );

    if (!hit) {
      return null;
    }

    const {
      page,
      rect
    } = hit;

    return {
      pageNumber:
        Number(
          page.dataset.page
        ),

      pageX:
        clamp(
          (clientX - rect.left) /
            Math.max(
              1,
              rect.width
            ),
          0,
          1
        ),

      pageY:
        clamp(
          (clientY - rect.top) /
            Math.max(
              1,
              rect.height
            ),
          0,
          1
        ),

      viewportX:
        clamp(
          clientX -
            scrollRect.left,
          0,
          scrollRect.width
        ),

      viewportY:
        clamp(
          clientY -
            scrollRect.top,
          0,
          scrollRect.height
        )
    };
  }

  function captureViewportCenterAnchor() {
    const rect =
      readerScroll.getBoundingClientRect();

    return captureZoomAnchor(
      rect.left +
        rect.width / 2,

      rect.top +
        rect.height / 2
    );
  }

  function restoreZoomAnchor(anchor) {
    if (!anchor) {
      return false;
    }

    const page =
      getPageElement(
        anchor.pageNumber
      );

    if (!page) {
      return false;
    }

    const scrollRect =
      readerScroll.getBoundingClientRect();

    const pageRect =
      page.getBoundingClientRect();

    const actualViewportX =
      pageRect.left -
      scrollRect.left +
      pageRect.width *
        anchor.pageX;

    const actualViewportY =
      pageRect.top -
      scrollRect.top +
      pageRect.height *
        anchor.pageY;

    const desiredScrollLeft =
      readerScroll.scrollLeft +
      (
        actualViewportX -
        anchor.viewportX
      );

    const desiredScrollTop =
      readerScroll.scrollTop +
      (
        actualViewportY -
        anchor.viewportY
      );

    readerScroll.scrollLeft =
      clamp(
        desiredScrollLeft,
        0,
        Math.max(
          0,
          readerScroll.scrollWidth -
            readerScroll.clientWidth
        )
      );

    readerScroll.scrollTop =
      clamp(
        desiredScrollTop,
        0,
        Math.max(
          0,
          readerScroll.scrollHeight -
            readerScroll.clientHeight
        )
      );

    setCurrentPage(
      anchor.pageNumber
    );

    return true;
  }

  function scrollToPage(
    pageNumber,
    behavior = 'smooth'
  ) {
    const number = clamp(
      Number(pageNumber) || 1,
      1,
      Math.max(1, pageCount)
    );

    const target =
      getPageElement(number);

    if (!target) {
      return;
    }

    // Only scroll the internal PDF viewport.
    // scrollIntoView can move the whole document
    // in some mobile browsers.
    const top = Math.max(
      0,
      target.offsetTop - 8
    );

    readerScroll.scrollTo({
      top,
      left:
        readerScroll.scrollLeft,
      behavior
    });

    setCurrentPage(number);
  }

  async function renderAllPages(
    scale,
    options = {}
  ) {
    if (!pdfDoc) {
      return;
    }

    const preservePage =
      clamp(
        Number(
          options.preservePage ||
            currentPage
        ) || 1,
        1,
        pageCount
      );

    const zoomAnchor =
      options.anchor ||
      null;

    const previousScrollLeft =
      readerScroll.scrollLeft;

    const token =
      ++renderToken;

    const mobile =
      window.matchMedia(
        '(max-width: 700px)'
      ).matches;

    const dpr = Math.min(
      window.devicePixelRatio ||
        1,

      mobile
        ? MOBILE_DPR_CAP
        : DESKTOP_DPR_CAP
    );

    disconnectPageObserver();

    readerPages.style.transform =
      '';

    readerPages.innerHTML =
      '';

    for (
      let number = 1;
      number <= pageCount;
      number += 1
    ) {
      if (
        token !==
        renderToken
      ) {
        return;
      }

      const page =
        await pdfDoc.getPage(
          number
        );

      const viewport =
        page.getViewport({
          scale
        });

      const wrap =
        document.createElement(
          'div'
        );

      wrap.className =
        'pdf-page-wrap';

      wrap.dataset.page =
        String(number);

      wrap.style.width =
        `${Math.ceil(
          viewport.width
        )}px`;

      wrap.style.height =
        `${Math.ceil(
          viewport.height
        )}px`;

      const canvas =
        document.createElement(
          'canvas'
        );

      canvas.width =
        Math.max(
          1,
          Math.floor(
            viewport.width *
              dpr
          )
        );

      canvas.height =
        Math.max(
          1,
          Math.floor(
            viewport.height *
              dpr
          )
        );

      canvas.style.width =
        `${Math.ceil(
          viewport.width
        )}px`;

      canvas.style.height =
        `${Math.ceil(
          viewport.height
        )}px`;

      canvas.setAttribute(
        'aria-label',
        `Page ${number}`
      );

      const context =
        canvas.getContext(
          '2d',
          {
            alpha: false
          }
        );

      context.setTransform(
        dpr,
        0,
        0,
        dpr,
        0,
        0
      );

      wrap.appendChild(
        canvas
      );

      readerPages.appendChild(
        wrap
      );

      await page.render({
        canvasContext:
          context,
        viewport
      }).promise;
    }

    if (
      token !==
      renderToken
    ) {
      return;
    }

    // Wait until layout is calculated before restoring
    // the focal document point.
    requestAnimationFrame(
      () => {
        const anchored =
          restoreZoomAnchor(
            zoomAnchor
          );

        if (!anchored) {
          const target =
            getPageElement(
              preservePage
            );

          if (target) {
            readerScroll.scrollTop =
              Math.max(
                0,
                target.offsetTop -
                  8
              );
          }

          readerScroll.scrollLeft =
            fitMode
              ? 0
              : clamp(
                  previousScrollLeft,
                  0,
                  Math.max(
                    0,
                    readerScroll.scrollWidth -
                      readerScroll.clientWidth
                  )
                );
        }

        readerPages.style.transform =
          '';

        readerPages.style.transformOrigin =
          '0 0';

        observePages();
        updatePageUI();
      }
    );
  }

  async function setScale(
    scale,
    options = {}
  ) {
    const nextScale =
      clampScale(scale);

    fitMode =
      Boolean(
        options.fit
      );

    currentScale =
      nextScale;

    updateZoomUI();

    await renderAllPages(
      currentScale,
      {
        preservePage:
          options.preservePage ||
          currentPage,

        anchor:
          options.anchor ||
          null
      }
    );
  }

  async function fitToWidth(
    options = {}
  ) {
    if (!basePageWidth) {
      return;
    }

    await setScale(
      calculateFitScale(),
      {
        fit: true,

        preservePage:
          options.preservePage ||
          currentPage
      }
    );
  }

  zoomInBtn.addEventListener(
    'click',
    () => {
      setScale(
        currentScale +
          ZOOM_STEP,
        {
          preservePage:
            currentPage,

          anchor:
            captureViewportCenterAnchor()
        }
      );
    }
  );

  zoomOutBtn.addEventListener(
    'click',
    () => {
      setScale(
        currentScale -
          ZOOM_STEP,
        {
          preservePage:
            currentPage,

          anchor:
            captureViewportCenterAnchor()
        }
      );
    }
  );

  fitWidthBtn.addEventListener(
    'click',
    () => {
      fitToWidth({
        preservePage:
          currentPage
      });
    }
  );

  prevPageBtn.addEventListener(
    'click',
    () => {
      scrollToPage(
        currentPage - 1
      );
    }
  );

  nextPageBtn.addEventListener(
    'click',
    () => {
      scrollToPage(
        currentPage + 1
      );
    }
  );

  function commitPageInput() {
    const requested =
      clamp(
        parseInt(
          pageNumberInput.value,
          10
        ) ||
          currentPage,

        1,

        Math.max(
          1,
          pageCount
        )
      );

    pageNumberInput.value =
      String(requested);

    scrollToPage(
      requested
    );

    pageNumberInput.blur();
  }

  pageNumberInput.addEventListener(
    'change',
    commitPageInput
  );

  pageNumberInput.addEventListener(
    'keydown',
    (event) => {
      if (
        event.key ===
        'Enter'
      ) {
        event.preventDefault();
        commitPageInput();
      }
    }
  );

  // ---------------------------------------
  // DESKTOP FOCAL-POINT ZOOM
  // ---------------------------------------
  //
  // Ctrl/Cmd + wheel:
  // the exact PDF point underneath the mouse
  // remains underneath the mouse after zoom.

  readerScroll.addEventListener(
    'wheel',
    (event) => {
      if (
        !(
          event.ctrlKey ||
          event.metaKey
        )
      ) {
        return;
      }

      event.preventDefault();

      const anchor =
        captureZoomAnchor(
          event.clientX,
          event.clientY
        );

      const direction =
        event.deltaY > 0
          ? -1
          : 1;

      setScale(
        currentScale +
          direction * 0.1,
        {
          preservePage:
            currentPage,

          anchor
        }
      );
    },
    {
      passive: false
    }
  );

  // ---------------------------------------
  // MOBILE PINCH ZOOM
  // ---------------------------------------
  //
  // The PDF coordinate between the two fingers
  // becomes the focal point.
  //
  // Moving both fingers while pinching also pans
  // that focal point naturally.

  let pinchJustEndedAt = 0;

  readerScroll.addEventListener(
    'touchstart',
    (event) => {
      if (
        event.touches.length !==
        2
      ) {
        return;
      }

      const [a, b] =
        event.touches;

      const midX =
        (
          a.clientX +
          b.clientX
        ) / 2;

      const midY =
        (
          a.clientY +
          b.clientY
        ) / 2;

      const pagesRect =
        readerPages.getBoundingClientRect();

      pinchState = {
        startDistance:
          Math.max(
            1,
            Math.hypot(
              a.clientX -
                b.clientX,

              a.clientY -
                b.clientY
            )
          ),

        startScale:
          currentScale,

        targetScale:
          currentScale,

        startMidX:
          midX,

        startMidY:
          midY,

        lastMidX:
          midX,

        lastMidY:
          midY,

        page:
          currentPage,

        anchor:
          captureZoomAnchor(
            midX,
            midY
          ),

        originX:
          midX -
          pagesRect.left,

        originY:
          midY -
          pagesRect.top
      };

      readerPages.style.transformOrigin =
        `${pinchState.originX}px ${pinchState.originY}px`;
    },
    {
      passive: true
    }
  );

  readerScroll.addEventListener(
    'touchmove',
    (event) => {
      if (
        !pinchState ||
        event.touches.length !==
          2
      ) {
        return;
      }

      event.preventDefault();

      const [a, b] =
        event.touches;

      const midX =
        (
          a.clientX +
          b.clientX
        ) / 2;

      const midY =
        (
          a.clientY +
          b.clientY
        ) / 2;

      const distance =
        Math.hypot(
          a.clientX -
            b.clientX,

          a.clientY -
            b.clientY
        );

      const ratio =
        distance /
        pinchState.startDistance;

      const targetScale =
        clampScale(
          pinchState.startScale *
            ratio
        );

      const previewRatio =
        targetScale /
        pinchState.startScale;

      const moveX =
        midX -
        pinchState.startMidX;

      const moveY =
        midY -
        pinchState.startMidY;

      pinchState.targetScale =
        targetScale;

      pinchState.lastMidX =
        midX;

      pinchState.lastMidY =
        midY;

      // Live CSS preview while finger is moving.
      // This avoids expensive PDF.js rerendering every frame.
      readerPages.style.transform =
        `translate3d(${moveX}px, ${moveY}px, 0) scale(${previewRatio})`;

      zoomLabel.textContent =
        `${Math.round(
          targetScale *
            100
        )}%`;
    },
    {
      passive: false
    }
  );

  readerScroll.addEventListener(
    'touchend',
    (event) => {
      if (
        !pinchState ||
        event.touches.length >= 2
      ) {
        return;
      }

      const finalScale =
        pinchState.targetScale;

      const preservePage =
        pinchState.page;

      const anchor =
        pinchState.anchor;

      // The document point originally between the fingers
      // should finish underneath the FINAL midpoint.
      //
      // This is what gives us zoom + two-finger panning.
      if (anchor) {
        const scrollRect =
          readerScroll.getBoundingClientRect();

        anchor.viewportX =
          clamp(
            pinchState.lastMidX -
              scrollRect.left,

            0,

            scrollRect.width
          );

        anchor.viewportY =
          clamp(
            pinchState.lastMidY -
              scrollRect.top,

            0,

            scrollRect.height
          );
      }

      pinchState = null;

      pinchJustEndedAt =
        Date.now();

      readerPages.style.transform =
        '';

      readerPages.style.transformOrigin =
        '0 0';

      setScale(
        finalScale,
        {
          preservePage,
          anchor
        }
      );
    },
    {
      passive: true
    }
  );

  // ---------------------------------------
  // DOUBLE TAP FOCAL ZOOM
  // ---------------------------------------

  let lastTapAt = 0;

  readerScroll.addEventListener(
    'touchend',
    (event) => {
      if (
        event.touches.length >
          0 ||
        pinchState
      ) {
        return;
      }

      const now =
        Date.now();

      // Prevent pinch touchend from accidentally
      // triggering double tap.
      if (
        now -
          pinchJustEndedAt <
        350
      ) {
        lastTapAt = 0;
        return;
      }

      const touch =
        event.changedTouches?.[0];

      if (!touch) {
        return;
      }

      if (
        now -
          lastTapAt <
        290
      ) {
        const anchor =
          captureZoomAnchor(
            touch.clientX,
            touch.clientY
          );

        if (fitMode) {
          setScale(
            Math.min(
              MAX_SCALE,
              currentScale *
                1.7
            ),
            {
              preservePage:
                currentPage,

              anchor
            }
          );
        } else {
          fitToWidth({
            preservePage:
              currentPage
          });
        }

        lastTapAt = 0;
        return;
      }

      lastTapAt = now;
    },
    {
      passive: true
    }
  );

  // ---------------------------------------
  // RESPONSIVE FIT
  // ---------------------------------------
  //
  // Keep fit-to-width properly fitted after:
  // - phone rotation
  // - browser chrome resize
  // - tablet/Desktop resize

  const resizeObserver =
    new ResizeObserver(
      () => {
        if (
          !pdfDoc ||
          !fitMode
        ) {
          return;
        }

        clearTimeout(
          resizeTimer
        );

        resizeTimer =
          setTimeout(
            () => {
              const next =
                calculateFitScale();

              if (
                Math.abs(
                  next -
                    currentScale
                ) >
                0.01
              ) {
                setScale(
                  next,
                  {
                    fit: true,

                    preservePage:
                      currentPage
                  }
                );
              }
            },
            120
          );
      }
    );

  resizeObserver.observe(
    readerScroll
  );

  // ---------------------------------------
  // LOAD PDF
  // ---------------------------------------

  try {
    const library =
      await api(
        '/api/library'
      );

    const book =
      (
        library.items ||
        []
      ).find(
        (item) =>
          item.id === id
      );

    if (
      !book &&
      user.role !==
        'ADMIN'
    ) {
      throw new Error(
        'This PDF is not assigned to your account.'
      );
    }

    readerTitle.textContent =
      book?.title ||
      'Private PDF';

    readerSubtitle.textContent =
      'PDFshelf reader';

    document.title =
      `${
        book?.title ||
        'Reader'
      } — PDFshelf`;

    const response =
      await fetch(
        `/api/pdfs/${encodeURIComponent(
          id
        )}/file`,
        {
          headers: {
            Authorization:
              `Bearer ${getToken()}`
          },

          cache:
            'no-store'
        }
      );

    if (
      response.status ===
      401
    ) {
      showRevoked();
      return;
    }

    if (
      !response.ok
    ) {
      const data =
        await response
          .json()
          .catch(
            () => null
          );

      throw new Error(
        data?.message ||
          'Unable to open the PDF.'
      );
    }

    const arrayBuffer =
      await response.arrayBuffer();

    pdfDoc =
      await pdfjsLib
        .getDocument({
          data:
            arrayBuffer
        })
        .promise;

    pageCount =
      pdfDoc.numPages;

    const firstPage =
      await pdfDoc.getPage(
        1
      );

    basePageWidth =
      firstPage
        .getViewport({
          scale: 1
        })
        .width;

    currentPage = 1;

    currentScale =
      calculateFitScale();

    fitMode = true;

    updatePageUI();
    updateZoomUI();

    await renderAllPages(
      currentScale,
      {
        preservePage: 1
      }
    );

    readerLoading.classList.add(
      'hidden'
    );
  } catch (error) {
    readerLoading.innerHTML = `
      <div class="loader-card">

        <strong>
          Unable to open this document
        </strong>

        <span>
          ${window.Shelf.escapeHtml(
            error.message
          )}
        </span>

        <div style="margin-top:16px">

          <button
            class="btn btn-primary"
            id="readerErrorBack"
            type="button"
          >
            Go back
          </button>

        </div>

      </div>
    `;

    readerLoading.classList.remove(
      'hidden'
    );

    $('readerErrorBack')
      ?.addEventListener(
        'click',
        () => {
          location.href =
            user.role ===
            'ADMIN'
              ? '/admin'
              : '/library';
        }
      );
  }
})();