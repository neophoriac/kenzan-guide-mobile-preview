// One tab-wide view of browser progress, including changes that could not be saved.
// This never replaces the browser's Storage prototype or writes gameplay save files.
(() => {
  const remembered = new Map();
  const pending = new Map();
  const listeners = new Set();
  let unavailable = false;
  let scheduled = false;
  let lastControl;

  function snapshot() { return { pending: pending.size, unavailable }; }
  function changed() {
    if (scheduled) return;
    scheduled = true;
    queueMicrotask(() => {
      scheduled = false;
      const state = snapshot();
      for (const listener of listeners) listener(state);
      document.dispatchEvent(new CustomEvent('kenzan:storage-state', { detail: state }));
    });
  }
  function getItem(key) {
    key = String(key);
    if (pending.has(key)) return pending.get(key);
    try {
      const value = localStorage.getItem(key);
      remembered.set(key, value);
      return value;
    } catch {
      if (!unavailable) { unavailable = true; changed(); }
      return remembered.get(key) ?? null;
    }
  }
  function write(key, value) {
    key = String(key);
    const active = document.activeElement;
    if (active instanceof HTMLElement && active !== document.body && !active.closest('#browser-storage-notice')) lastControl = active;
    remembered.set(key, value);
    pending.set(key, value);
    try {
      if (value === null) localStorage.removeItem(key);
      else localStorage.setItem(key, value);
      pending.delete(key);
      unavailable = false;
    } catch {
      unavailable = true;
    }
    changed();
    return !pending.has(key);
  }
  function retry() {
    for (const [key, value] of [...pending]) write(key, value);
    if (!pending.size) {
      try { localStorage.getItem('kenzan-guide:storage-health'); unavailable = false; }
      catch { unavailable = true; }
    }
    changed();
    return snapshot();
  }
  window.kenzanStorage = {
    getItem,
    setItem: (key, value) => write(key, String(value)),
    removeItem: key => write(key, null),
    retry,
    get pendingCount() { return pending.size; },
    subscribe(listener) {
      listeners.add(listener);
      listener(snapshot());
      return () => listeners.delete(listener);
    },
  };
  window.addEventListener('beforeunload', event => {
    if (!pending.size) return;
    event.preventDefault();
    event.returnValue = '';
  });

  window.mountKenzanStorageNotice = (host = document) => {
    const root = host.id === 'browser-storage-notice' ? host : host.querySelector('#browser-storage-notice');
    if (!root) return () => {};
    const page = document.documentElement;
    page.dataset.kenzanStorageNotice = '';
    const status = root.querySelector('[data-storage-status]');
    const retryButton = root.querySelector('[data-storage-retry]');
    function revealFocus() {
      if (root.hidden) return;
      const active = document.activeElement;
      if (!(active instanceof HTMLElement) || active === document.body || root.contains(active) || active.closest('dialog[open]')) return;
      const visible = active.closest('label') ?? active;
      const box = visible.getBoundingClientRect();
      const banner = root.getBoundingClientRect();
      if (box.width && box.height && box.bottom > banner.top && box.top < banner.bottom + 4) {
        window.scrollBy({ top: box.top - banner.bottom - 4, behavior: 'instant' });
      }
    }
    function measure() {
      const height = root.hidden ? 0 : Math.ceil(root.getBoundingClientRect().height);
      page.style.setProperty('--storage-notice-height', `${height}px`);
      revealFocus();
    }
    const size = new ResizeObserver(measure);
    size.observe(root);
    function focusAfterRecovery() {
      if (!root.contains(document.activeElement)) return;
      const usable = element => element?.isConnected && element.getClientRects().length
        && getComputedStyle(element).visibility !== 'hidden' && !element.matches(':disabled') && !element.closest('[hidden], [inert]');
      const target = usable(lastControl) ? lastControl : document.querySelector('#atlas-map') ?? document.querySelector('#completion-title');
      if (usable(target)) target.focus({ preventScroll: true });
    }
    const unsubscribe = window.kenzanStorage.subscribe(({ pending: count, unavailable: blocked }) => {
      const visible = count > 0 || blocked;
      if (!visible) focusAfterRecovery();
      root.hidden = !visible;
      const text = count
        ? `${count} ${count === 1 ? 'change is' : 'changes are'} not saved. Your changes are kept only in this tab. Retry saving before you reload or close it.`
        : 'Browser storage is unavailable. Checkmarks and settings may not survive a reload. Retry before leaving this page.';
      if (visible && status.textContent !== text) status.textContent = text;
      measure();
    });
    const onRetry = () => {
      const state = retry();
      if (!state.pending && !state.unavailable) window.dispatchEvent(new StorageEvent('storage', { key: null }));
    };
    retryButton.addEventListener('click', onRetry);
    document.addEventListener('focusin', revealFocus);
    return () => {
      unsubscribe();
      size.disconnect();
      retryButton.removeEventListener('click', onRetry);
      document.removeEventListener('focusin', revealFocus);
      page.style.removeProperty('--storage-notice-height');
      delete page.dataset.kenzanStorageNotice;
    };
  };
})();

mountKenzanStorageNotice();
var AtlasSidebar = (() => {
  var __defProp = Object.defineProperty;
  var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
  var __getOwnPropNames = Object.getOwnPropertyNames;
  var __hasOwnProp = Object.prototype.hasOwnProperty;
  var __export = (target, all) => {
    for (var name in all)
      __defProp(target, name, { get: all[name], enumerable: true });
  };
  var __copyProps = (to, from, except, desc) => {
    if (from && typeof from === "object" || typeof from === "function") {
      for (let key of __getOwnPropNames(from))
        if (!__hasOwnProp.call(to, key) && key !== except)
          __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
    }
    return to;
  };
  var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);

  // entries/sidebar.js
  var sidebar_exports = {};
  __export(sidebar_exports, {
    setupSidebar: () => setupSidebar
  });

  // sidebar.js
  function setupSidebar(layout, mobileOpen, centeredContent, signal, state = {}) {
    const dock = layout.querySelector(".sidebar-dock");
    const panel = dock.querySelector(".sidebar-panel");
    const toggle = dock.querySelector(".sidebar-toggle");
    const handle = dock.querySelector(".sidebar-resize");
    const label = toggle.querySelector(".sidebar-toggle-label").textContent.toLowerCase();
    const compact = matchMedia("(max-width: 48rem)");
    let desktopOpen = state.desktopOpen ?? true;
    mobileOpen = state.mobileOpen ?? mobileOpen;
    if (state.width) layout.style.setProperty("--sidebar-width", state.width);
    let drag;
    const isOpen = () => compact.matches ? mobileOpen : desktopOpen;
    const rem = () => parseFloat(getComputedStyle(document.documentElement).fontSize);
    const maxWidth = () => Math.min(36 * rem(), innerWidth * (layout.dataset.sidebarDesign === "browse" ? 0.45 : 0.55));
    const minWidth = () => 14 * rem();
    function render() {
      const open = isOpen();
      if (!open && (panel.contains(document.activeElement) || handle === document.activeElement)) {
        toggle.focus({ preventScroll: true });
      }
      layout.toggleAttribute("data-sidebar-collapsed", !open);
      panel.inert = !open;
      toggle.setAttribute("aria-expanded", String(open));
      toggle.title = `${open ? "Hide" : "Show"} ${label}`;
      toggle.setAttribute("aria-label", toggle.title);
    }
    function setOpen(open) {
      if (compact.matches) mobileOpen = open;
      else desktopOpen = open;
      render();
    }
    function resize(width) {
      const clamped = Math.max(minWidth(), Math.min(width, maxWidth()));
      layout.style.setProperty("--sidebar-width", `${clamped}px`);
    }
    function widthAtPointer(clientX) {
      const edge = drag.width + Math.max(0, drag.centeredSpace - drag.width) / 2;
      const target = edge + clientX - drag.x;
      return drag.centeredSpace > 0 && target < drag.centeredSpace ? 2 * target - drag.centeredSpace : target;
    }
    toggle.addEventListener("click", () => setOpen(!isOpen()), { signal });
    handle.addEventListener("pointerdown", (event) => {
      if (event.button !== 0 || !event.isPrimary || drag) return;
      const centeredSpace = centeredContent ? layout.clientWidth - parseFloat(getComputedStyle(centeredContent).maxWidth) : 0;
      drag = {
        id: event.pointerId,
        x: event.clientX,
        width: dock.offsetWidth,
        previous: layout.style.getPropertyValue("--sidebar-width"),
        centeredSpace
      };
      handle.setPointerCapture(event.pointerId);
      layout.setAttribute("data-sidebar-resizing", "");
    }, { signal });
    handle.addEventListener("pointermove", (event) => {
      if (event.pointerId === drag?.id) resize(widthAtPointer(event.clientX));
    }, { signal });
    function endDrag(event) {
      if (event.pointerId !== drag?.id) return;
      const width = widthAtPointer(event.clientX);
      if (event.type !== "pointerup" || width <= 5 * rem()) {
        layout.style.setProperty("--sidebar-width", drag.previous);
        if (event.type === "pointerup") setOpen(false);
      } else if (event.clientX !== drag.x) resize(width);
      drag = void 0;
      layout.removeAttribute("data-sidebar-resizing");
    }
    for (const event of ["pointerup", "pointercancel", "lostpointercapture"]) handle.addEventListener(event, endDrag, { signal });
    handle.addEventListener("keydown", (event) => {
      const width = dock.offsetWidth;
      if (event.key === "Home" || event.key === "ArrowLeft" && width <= Math.ceil(minWidth())) setOpen(false);
      else if (event.key === "End") resize(maxWidth());
      else if (event.key === "ArrowLeft") resize(width - 24);
      else if (event.key === "ArrowRight") resize(width + 24);
      else return;
      event.preventDefault();
    }, { signal });
    const observer = new ResizeObserver(() => {
      if (compact.matches || !desktopOpen) return;
      handle.setAttribute("aria-valuenow", String(dock.offsetWidth));
      handle.setAttribute("aria-valuemax", String(Math.round(maxWidth())));
      handle.setAttribute("aria-valuetext", `${dock.offsetWidth} pixels`);
    });
    signal?.addEventListener("abort", () => {
      observer.disconnect();
      if (drag && handle.hasPointerCapture(drag.id)) handle.releasePointerCapture(drag.id);
      drag = void 0;
      layout.removeAttribute("data-sidebar-resizing");
      Object.assign(state, { desktopOpen, mobileOpen, width: layout.style.getPropertyValue("--sidebar-width") });
    }, { once: true });
    observer.observe(dock);
    compact.addEventListener("change", render, { signal });
    render();
    return {
      get collapsed() {
        return !isOpen();
      },
      open() {
        setOpen(true);
      },
      closeOnMobile() {
        if (!compact.matches || !mobileOpen) return false;
        setOpen(false);
        return true;
      }
    };
  }
  return __toCommonJS(sidebar_exports);
})();
var { setupSidebar } = AtlasSidebar;

const viewSignal = new AbortController().signal;
const viewState = {};
const questProgressPrefix = 'kenzan-guide:done:';
const storyWindowKey = 'kenzan-guide:story-window';

function questStoryAvailability(story, id, checkpoint) {
  if (!checkpoint) return '';
  const { order, clock } = checkpoint;
  const rule = story.quests[id];
  if (!clock || order < rule.first) return null;
  const phase = rule.continuations.find(item => order >= item.first
    && (item.last === null || order <= item.last) && item.clocks.includes(clock));
  if (phase) return phase.note;
  if ((rule.last !== null && order > rule.last) || (rule.gion && order >= story.gionCloses)
    || (rule.clocks && !rule.clocks.includes(clock))) return null;
  return '';
}

function questPrerequisiteWarning(story, id, completed) {
  const { all, any } = story.quests[id];
  return all.some(required => !completed.has(required)) || (any.length > 0 && !any.some(required => completed.has(required)));
}

function questMapFilter(story, ids, completed, objective, hideCompleted, missableOnly) {
  const checkpoint = story.checkpoints[objective];
  const eligible = new Set();
  const notes = {};
  const unfinishedOnly = hideCompleted || missableOnly;
  for (const id of ids) {
    const done = completed.has(id);
    const timing = questStoryAvailability(story, id, checkpoint);
    if ((!unfinishedOnly || !done) && (!missableOnly || story.quests[id].missable) && timing !== null) eligible.add(id);
    const prerequisiteWarning = !done && questPrerequisiteWarning(story, id, completed);
    const text = [timing, prerequisiteWarning && 'Prerequisite completion is unconfirmed. See Requires.'].filter(Boolean).join(' ');
    if (text) notes[id] = { text, prerequisiteWarning };
  }
  return { eligible, completed, notes, objective, checkpoint, hideCompleted, missableOnly, locked: Boolean(checkpoint && !checkpoint.clock) };
}

// Kenzan's side guide shares story and progress with its map.
function mountKenzanMap(signal, state) {
  const integrated = document.querySelector('#quest-map[data-integrated]');
  const root = integrated ?? document.body;
  const storySource = root.querySelector('#atlas-story-data');
  const storyData = storySource && JSON.parse(storySource.textContent);
  const abilities = storyData?.revelationAbilities ?? {};
  if (integrated) {
    const parameters = new URLSearchParams(location.search);
    Object.assign(state.filters ??= {}, { hideCompleted: parameters.get('hide-completed') === '1',
      missableOnly: parameters.get('missables') === '1' });
  }
  const revelationPrefix = 'kenzan-guide:revelation-done:';
  const abilityPrefix = 'kenzan-guide:side-done:';
  const progressStorage = window.kenzanStorage ?? {
    getItem: key => localStorage.getItem(key),
    setItem: (key, value) => localStorage.setItem(key, value),
    removeItem: key => localStorage.removeItem(key),
  };

  function writeProgress(key, checked) {
    if (checked) progressStorage.setItem(key, '1');
    else progressStorage.removeItem(key);
  }

  const story = storyData && {
    getObjective() {
      const saved = progressStorage.getItem(storyWindowKey);
      return Object.hasOwn(storyData.checkpoints, saved) ? saved : '';
    },
    setObjective(value) {
      window.kenzanStoryFollow?.pause();
      progressStorage.setItem(storyWindowKey, value);
    },
    isDone: id => progressStorage.getItem(questProgressPrefix + id) === '1',
    setDone: (id, checked) => writeProgress(questProgressPrefix + id, checked),
    observes: key => key === storyWindowKey || key.startsWith(questProgressPrefix),
    isObjectiveKey: key => key === storyWindowKey,
    filter: (...filters) => questMapFilter(storyData, ...filters),
  };

  const adapter = {
    storage: progressStorage,
    story,
    routeProgressKey: id => revelationPrefix + id,
    routeDone: id => abilities[id] && progressStorage.getItem(abilityPrefix + abilities[id]) === '1',
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
  if (integrated) {
    const fields = [['#atlas-unfinished', 'hide-completed'], ['#atlas-missable', 'missables']];
    for (const [selector, parameter] of fields) root.querySelector(selector).addEventListener('change', event => {
      const url = new URL(location.href);
      if (event.target.checked) url.searchParams.set(parameter, '1');
      else url.searchParams.delete(parameter);
      history.replaceState(history.state, '', url);
    }, { signal });
    window.addEventListener('popstate', () => {
      const parameters = new URLSearchParams(location.search);
      for (const [selector, parameter] of fields) {
        const input = root.querySelector(selector);
        const checked = parameters.get(parameter) === '1';
        if (input.checked === checked) continue;
        input.checked = checked;
        input.dispatchEvent(new Event('change'));
      }
    }, { signal });
  }
  if (!integrated) {
    const openFromURL = () => atlas.open(readAtlasLink(new URLSearchParams(location.hash.slice(1))));
    window.addEventListener('hashchange', openFromURL, { signal });
    openFromURL();
  }
  return atlas;
}

mountKenzanMap(viewSignal, viewState);
