function setupSidebar(layout, mobileOpen, centeredContent, signal, state = {}) {
  const dock = layout.querySelector('.sidebar-dock');
  const panel = dock.querySelector('.sidebar-panel');
  const toggle = dock.querySelector('.sidebar-toggle');
  const handle = dock.querySelector('.sidebar-resize');
  const label = toggle.querySelector('.sidebar-toggle-label').textContent.toLowerCase();
  const compact = matchMedia('(max-width: 48rem)');
  let desktopOpen = state.desktopOpen ?? true;
  mobileOpen = state.mobileOpen ?? mobileOpen;
  if (state.width) layout.style.setProperty('--sidebar-width', state.width);
  let drag;

  const isOpen = () => compact.matches ? mobileOpen : desktopOpen;
  const rem = () => parseFloat(getComputedStyle(document.documentElement).fontSize);
  const maxWidth = () => Math.min(36 * rem(), innerWidth * .55);
  const minWidth = () => 14 * rem();

  function render() {
    const open = isOpen();
    if (!open && (panel.contains(document.activeElement) || handle === document.activeElement)) {
      toggle.focus({ preventScroll: true });
    }
    layout.toggleAttribute('data-sidebar-collapsed', !open);
    panel.inert = !open;
    toggle.setAttribute('aria-expanded', String(open));
    toggle.title = `${open ? 'Hide' : 'Show'} ${label}`;
    toggle.setAttribute('aria-label', toggle.title);
  }

  function setOpen(open) {
    if (compact.matches) mobileOpen = open;
    else desktopOpen = open;
    render();
  }

  function resize(width) {
    const clamped = Math.max(minWidth(), Math.min(width, maxWidth()));
    layout.style.setProperty('--sidebar-width', `${clamped}px`);
  }

  function widthAtPointer(clientX) {
    const edge = drag.width + Math.max(0, drag.centeredSpace - drag.width) / 2;
    const target = edge + clientX - drag.x;
    // When the guide has side margins, half a width change goes into moving its left edge.
    return drag.centeredSpace > 0 && target < drag.centeredSpace ? 2 * target - drag.centeredSpace : target;
  }

  toggle.addEventListener('click', () => setOpen(!isOpen()));
  handle.addEventListener('pointerdown', event => {
    if (event.button !== 0 || !event.isPrimary || drag) return;
    const centeredSpace = centeredContent ? layout.clientWidth - parseFloat(getComputedStyle(centeredContent).maxWidth) : 0;
    drag = { id: event.pointerId, x: event.clientX, width: dock.offsetWidth,
      previous: layout.style.getPropertyValue('--sidebar-width'), centeredSpace };
    handle.setPointerCapture(event.pointerId);
    layout.setAttribute('data-sidebar-resizing', '');
  });
  handle.addEventListener('pointermove', event => {
    if (event.pointerId === drag?.id) resize(widthAtPointer(event.clientX));
  });
  function endDrag(event) {
    if (event.pointerId !== drag?.id) return;
    const width = widthAtPointer(event.clientX);
    if (event.type !== 'pointerup' || width <= 5 * rem()) {
      layout.style.setProperty('--sidebar-width', drag.previous);
      if (event.type === 'pointerup') setOpen(false);
    } else if (event.clientX !== drag.x) resize(width);
    drag = undefined;
    layout.removeAttribute('data-sidebar-resizing');
  }
  for (const event of ['pointerup', 'pointercancel', 'lostpointercapture']) handle.addEventListener(event, endDrag);
  handle.addEventListener('keydown', event => {
    const width = dock.offsetWidth;
    if (event.key === 'Home' || (event.key === 'ArrowLeft' && width <= Math.ceil(minWidth()))) setOpen(false);
    else if (event.key === 'End') resize(maxWidth());
    else if (event.key === 'ArrowLeft') resize(width - 24);
    else if (event.key === 'ArrowRight') resize(width + 24);
    else return;
    event.preventDefault();
  });

  const observer = new ResizeObserver(() => {
    if (compact.matches || !desktopOpen) return;
    handle.setAttribute('aria-valuenow', String(dock.offsetWidth));
    handle.setAttribute('aria-valuemax', String(Math.round(maxWidth())));
    handle.setAttribute('aria-valuetext', `${dock.offsetWidth} pixels`);
  });
  observer.observe(dock);
  compact.addEventListener('change', render, { signal });
  signal?.addEventListener('abort', () => {
    observer.disconnect();
    Object.assign(state, { desktopOpen, mobileOpen, width: layout.style.getPropertyValue('--sidebar-width') });
  }, { once: true });
  render();

  return {
    get collapsed() { return !isOpen(); },
    open() { setOpen(true); },
    closeOnMobile() {
      if (!compact.matches || !mobileOpen) return false;
      setOpen(false);
      return true;
    },
  };
}
