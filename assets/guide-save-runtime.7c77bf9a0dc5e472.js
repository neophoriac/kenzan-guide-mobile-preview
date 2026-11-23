(() => {
  function readStory(data, windows) {
    // Chapter comes from the native scenario row. The guide's finer windows
    // are derived separately from verified selectors and story-event flags.
    const currentSelector = data.getUint32(0x46ac);
    const resumeMode = data.getUint32(0x46a4);
    const common = data.getUint32(0x1b0);
    const chapterFor = selector => windows.chapterRanges.find(([first, last]) => selector >= first && selector <= last)?.[2];
    let selector = currentSelector;
    // A native type-4 substory temporarily replaces the current scenario. The
    // game preserves its main-story parent at +0x44 in the saved resume header.
    // Only use that parent for verified substory selectors in ordinary saves;
    // an arbitrary unknown selector must remain unknown rather than guess.
    const sideScenario = (windows.substorySelectorRanges ?? []).some(([first, last]) =>
      currentSelector >= first && currentSelector <= last);
    if (sideScenario && resumeMode === 0x12c) {
      const parent = data.byteLength >= 0x46d8 ? data.getUint32(0x46d4) : undefined;
      selector = chapterFor(parent) === undefined ? undefined : parent;
    }
    const chapter = chapterFor(selector);
    const playSeconds = Math.floor(data.getUint32(0x80) / 60);
    const weaponScenes = Object.entries(windows.weaponPickupScenes ?? {});
    const pickupScenes = Object.entries(windows.pickupScenes ?? windows.weaponPickupScenes ?? {});
    const flag = (group, state) =>
      Boolean(data.getUint32(0x190 + group * 32 + (state >>> 5) * 4) & (1 << (state & 31)));
    if (common & (1 << 13)) return { mode: 'adventure', playSeconds };
    if ((common & (1 << 3)) && (currentSelector === 0x2ee || currentSelector === 0x2ef)) {
      return { mode: 'clear', playSeconds, pickupReviewScenes: pickupScenes.map(([id]) => id),
        weaponPickupWindows: weaponScenes.map(([code]) => code) };
    }
    if (chapter === undefined) {
      return { mode: 'unknown', playSeconds };
    }
    const meets = ({ group, set = [], clear = [] }) =>
      set.every(state => flag(group, state)) && clear.every(state => !flag(group, state));
    const rules = resumeMode === 0x12c ? (windows.selectors[selector] ?? []) : [];
    const matches = rules.filter(rule =>
      meets(rule) && (rule.also ?? []).every(meets));
    // Leave ambiguous, unverified and story-only positions to the player.
    const window = chapter <= 4 ? '4-7' : matches.length === 1 ? matches[0].window : undefined;
    const reached = scenes => scenes
      .filter(([code, scene]) => {
        const pickupChapter = scene.chapter ?? Number(code.split('-')[0]);
        return chapter > pickupChapter || (chapter === pickupChapter &&
          (selector >= scene.selector || flag(scene.group, scene.flag)));
      }).map(([code]) => code);
    return { mode: 'story', chapter, window, playSeconds,
      pickupReviewScenes: reached(pickupScenes), weaponPickupWindows: reached(weaponScenes) };
  }

  if (typeof module === 'object' && module.exports) module.exports = { readStory };
  else window.readKenzanSaveStory = readStory;
})();

(() => {
  const slotPattern = /^BLJM60064-LIST-(\d+)$/;
  const systemSlot = 'BLJM60064-FIXED-';
  const readAccess = { mode: 'read' };
  const existingOnly = { create: false };
  const interval = 5000;
  const publicGuidePath = '/kenzan-guide/';
  const publicGuideOrigin = 'https://neophoriac.github.io';

  function isSaveFolder(folder) {
    return folder?.kind === 'directory' && folder.name === 'savedata' && typeof folder.resolve === 'function';
  }

  function matchesPath(path, ...expected) {
    return path?.length === expected.length && expected.every((part, index) => path[index] === part);
  }

  function isSaveSlot(name) {
    return name === systemSlot || slotPattern.test(name);
  }

  function includeSlot(name, slot, includeSystem) {
    return name === systemSlot ? includeSystem : !slot || name === slot;
  }

  async function listSaveSlots(folder, live) {
    const slots = [];
    if (!isSaveFolder(folder) || !live()) return slots;
    for await (const [name, entry] of folder.entries()) {
      if (!live()) break;
      if (entry.kind === 'directory' && isSaveSlot(name)) slots.push(name);
    }
    return slots;
  }

  async function openSave(folder, slot, live) {
    if (!isSaveFolder(folder) || !isSaveSlot(slot) || !live()) return null;
    try {
      // Accept exactly one slot directory and its USERDATA child from the chosen root.
      const entry = await folder.getDirectoryHandle(slot, existingOnly);
      if (!live() || entry.kind !== 'directory' || entry.name !== slot) return null;
      if (!matchesPath(await folder.resolve(entry), slot) || !live()) return null;
      const handle = await entry.getFileHandle('USERDATA', existingOnly);
      if (!live() || handle.kind !== 'file' || handle.name !== 'USERDATA') return null;
      if (!matchesPath(await folder.resolve(handle), slot, 'USERDATA') || !live()) return null;
      const file = await handle.getFile();
      return live() && file.name === 'USERDATA' ? file : null;
    } catch (error) {
      // RPCS3 can replace the slot directory while saving. Get new handles on the next scan.
      if (!['NotFoundError', 'NotReadableError', 'TypeMismatchError'].includes(error.name)) throw error;
      return null;
    }
  }

  async function scanSaveFolder(folder, live = () => true, { slot, includeSystem = true } = {}) {
    const names = await listSaveSlots(folder, live);
    const files = [];
    for (const name of names) {
      if (!live()) break;
      if (!includeSlot(name, slot, includeSystem)) continue;
      files.push({ slot: name, file: await openSave(folder, name, live) });
    }
    return { names, files };
  }

  function isDroppedSaveFolder(folder) {
    return folder?.isDirectory && folder.name === 'savedata' && folder.fullPath === '/savedata'
      && typeof folder.createReader === 'function';
  }

  async function* droppedEntries(folder, live) {
    // Each legacy reader has one traversal. Start from the retained root on every scan.
    const reader = folder.createReader();
    while (live()) {
      const batch = await new Promise((resolve, reject) => reader.readEntries(resolve, reject));
      if (!batch.length) return;
      for (const entry of batch) {
        if (!live()) return;
        yield entry;
      }
    }
  }

  async function readDroppedSave(slot, live) {
    try {
      for await (const entry of droppedEntries(slot, live)) {
        if (!entry.isFile || entry.name !== 'USERDATA' || entry.fullPath !== slot.fullPath + '/USERDATA') continue;
        const file = await new Promise((resolve, reject) => entry.file(resolve, reject));
        return live() && file.name === 'USERDATA' ? file : null;
      }
    } catch (error) {
      // A slot may briefly disappear when RPCS3 replaces it.
      if (!['InvalidStateError', 'NotFoundError', 'NotReadableError', 'TypeMismatchError'].includes(error.name)) throw error;
    }
    return null;
  }

  async function scanDroppedFolder(folder, live, { slot, includeSystem = true } = {}) {
    const names = [];
    const files = [];
    if (!isDroppedSaveFolder(folder) || !live()) return { names, files };
    for await (const entry of droppedEntries(folder, live)) {
      const { name } = entry;
      if (!entry.isDirectory || !isSaveSlot(name) || entry.fullPath !== folder.fullPath + '/' + name) continue;
      names.push(name);
      if (includeSlot(name, slot, includeSystem)) files.push({ slot: name, file: await readDroppedSave(entry, live) });
    }
    return { names, files };
  }

  function selectSaves(files, slot) {
    const gameplay = files.filter(({ slot }) => slotPattern.test(slot));
    const choices = slot ? gameplay.filter(entry => entry.slot === slot)
      : [...gameplay].sort((a, b) => (b.file?.lastModified ?? -1) - (a.file?.lastModified ?? -1)
        || a.slot.localeCompare(b.slot, 'en', { numeric: true }));
    const system = files.find(({ slot }) => slot === systemSlot);
    return { gameplay, current: choices[0], system };
  }

  function storedFolder(key, change, connectionToForget, replace = false) {
    return new Promise((resolve, reject) => {
      const open = indexedDB.open('kenzan-guide-save-folder', 1);
      open.onupgradeneeded = () => open.result.createObjectStore('folders');
      open.onerror = () => reject(open.error);
      open.onblocked = () => reject(new Error('Folder storage is busy.'));
      open.onsuccess = () => {
        const db = open.result;
        try {
          const transaction = db.transaction('folders', change === undefined ? 'readonly' : 'readwrite');
          const store = transaction.objectStore('folders');
          const request = replace ? store.put(change, key) : store.get(key);
          if (change !== undefined && !replace) request.onsuccess = () => {
            if (!request.result) return;
            const savedConnection = request.result?.connection ?? null;
            if (change === null && savedConnection === connectionToForget) store.delete(key);
            if (change && savedConnection === change.connection) store.put(change, key);
          };
          transaction.oncomplete = () => { db.close(); resolve(request.result); };
          transaction.onabort = () => { db.close(); reject(transaction.error); };
        } catch (error) {
          db.close();
          reject(error);
        }
      };
    });
  }

  function initSaveFolderSync({ parse, hasSaveHeader, add, showStory, showFolderConnection, recordSync }) {
    const localGuide = location.protocol === 'file:' && !location.hostname;
    const publicGuide = location.origin === publicGuideOrigin
      && [publicGuidePath, publicGuidePath + 'index.html'].includes(location.pathname);
    const unsupportedLocation = !window.isSecureContext || window.top !== window.self || (!localGuide && !publicGuide);
    const pickerAvailable = typeof window.showDirectoryPicker === 'function';
    const dropAvailable = !pickerAvailable && typeof window.DataTransferItem?.prototype.webkitGetAsEntry === 'function';
    if (unsupportedLocation || (!pickerAvailable && !dropAvailable)) return { unsupportedLocation };
    const scanFolder = pickerAvailable ? scanSaveFolder : scanDroppedFolder;

    let config;
    let revision = 0;
    let autoRevision = 0;
    let busy = false;
    let requested = false;
    let timer;
    let picking = false;
    let persistent = pickerAvailable;
    let lastStatus = '';
    let slots = [];
    let slotNames = [];
    let connected = false;
    let needsReconnect = false;
    let reconnecting = false;
    let render;
    let latestTime = -1;
    let storySlot;
    const seen = new Map();
    const storageKey = publicGuide ? publicGuidePath : location.pathname;
    const dropPreferenceKey = 'kenzan-guide:dropped-save-folder:' + storageKey;
    // A preference can survive a reload. The dropped entry stays in this tab's memory.
    let dropPreference = null;
    if (dropAvailable) {
      try {
        dropPreference = localStorage.getItem(dropPreferenceKey);
      } catch {
        // Dropping and reconnecting still work for this tab.
      }
    }
    let connectionEvents;
    try {
      if (pickerAvailable) connectionEvents = new BroadcastChannel('kenzan-save-folder:' + storageKey);
    } catch {
      // A browser can disable cross-tab coordination for local pages.
    }

    function clearStory() {
      storySlot = undefined;
      showStory();
    }

    function message(value) {
      if (value === lastStatus) return;
      lastStatus = value;
      updateView();
    }

    function updateView() {
      if (render) render({ connected, needsReconnect, reconnecting, busy, picking, status: lastStatus,
        hasFolder: Boolean(config), auto: Boolean(config?.auto), slot: config?.slot ?? '', slotNames });
    }

    function controls(online, reconnect = false) {
      connected = online;
      needsReconnect = reconnect;
      showFolderConnection(reconnect ? 'disconnected' : config ? 'configured' : 'unconnected');
      updateView();
    }

    function rememberDrop(preference) {
      dropPreference = preference;
      try {
        localStorage.setItem(dropPreferenceKey, preference);
      } catch {
        // Retry is still available with the in-memory preference.
      }
    }

    function setSlotOptions(gameplay) {
      const names = [...gameplay];
      if (config.slot && !names.includes(config.slot)) names.push(config.slot);
      slotNames = names.sort((a, b) => a.localeCompare(b, 'en', { numeric: true }));
      updateView();
    }

    function stop() {
      clearInterval(timer);
      timer = undefined;
    }

    function schedule() {
      stop();
      if (config?.auto && !document.hidden && !picking) timer = setInterval(() => scan('auto'), interval);
    }

    function disconnect(reconnect = false) {
      revision++;
      config = undefined;
      stop();
      requested = false;
      slots = [];
      slotNames = [];
      seen.clear();
      latestTime = -1;
      controls(false, reconnect);
      clearStory();
    }

    connectionEvents?.addEventListener('message', ({ data }) => {
      if (data?.type !== 'forget' || !config || data.connection !== config.connection) return;
      disconnect();
      message('The save folder was disconnected in another tab.');
    });

    let storageQueue = Promise.resolve();
    function persist(connectionToForget, replace = false) {
      if (!pickerAvailable) return;
      const value = config ?? null;
      const save = () => storedFolder(storageKey, value, connectionToForget, replace)
        .then(() => { persistent = true; }, () => { persistent = false; });
      storageQueue = storageQueue.then(save);
      return storageQueue;
    }

    async function scan(mode) {
      if (!config || picking || (mode === 'auto' && (!config.auto || document.hidden))) return;
      if (busy) {
        if (mode !== 'auto' || !requested) requested = mode;
        return;
      }
      const active = config;
      const scanRevision = revision;
      const autoScanRevision = autoRevision;
      const live = () => revision === scanRevision
        && (mode !== 'auto' || (autoRevision === autoScanRevision && !document.hidden));
      busy = true;
      updateView();
      try {
        const permission = pickerAvailable ? await active.handle.queryPermission(readAccess) : 'granted';
        if (!live()) return;
        if (permission !== 'granted') {
          stop();
          controls(false, true);
          clearStory();
          message('Saved folder: ' + active.handle.name + '. Reconnect to give this browser read access again.');
          return;
        }
        const { names, files } = await scanFolder(active.handle, live, { slot: active.slot, includeSystem: mode !== 'inspect' });
        if (!live()) return;
        controls(true);
        const { current, system } = selectSaves(files, active.slot);
        slots = names.filter(name => slotPattern.test(name));
        setSlotOptions(slots);
        const prefix = persistent ? 'Folder: ' + active.handle.name + '. ' : 'Folder access is available for this tab only. ';
        const nextStep = active.auto ? 'Auto-sync is on.' : 'Auto-sync is off. Use Sync now to import from this folder.';
        const source = current ? ' Gameplay slot ' + slotPattern.exec(current.slot)[1] + '.' : '';
        const pending = [];
        let retry = false;
        for (const entry of (mode === 'inspect' ? [current] : [current, system]).filter(Boolean)) {
          const { slot, file } = entry;
          // When the current slot is briefly missing during a save, don't import an older slot.
          if (mode === 'auto' && !active.slot && slot !== systemSlot && file?.lastModified < latestTime) {
            retry = true;
            continue;
          }
          if (!file || (mode === 'auto' && Date.now() - file.lastModified < 1000)) {
            retry = true;
            continue;
          }
          const stamp = file.lastModified + ':' + file.size;
          if (mode === 'auto' && seen.get(slot) === stamp && (slot === systemSlot || slot === storySlot)) continue;
          try {
            const expected = slot === systemSlot ? 'system' : 'gameplay';
            if (!live()) return;
            if (!await hasSaveHeader(file, expected)) {
              retry = true;
              continue;
            }
            if (!live()) return;
            const buffer = await file.arrayBuffer();
            if (!live()) return;
            pending.push({ slot, stamp, parsed: parse(buffer) });
          } catch {
            retry = true;
          }
        }
        if (!live()) return;
        const gameplayResult = pending.find(({ slot }) => slot === current?.slot);
        if (gameplayResult) {
          storySlot = gameplayResult.slot;
          showStory('Slot ' + slotPattern.exec(storySlot)[1], gameplayResult.parsed);
        } else if (current?.slot !== storySlot || mode !== 'auto') {
          clearStory();
        }
        if (mode === 'inspect') {
          message(prefix + nextStep + source + (retry ? ' The story position could not be read yet.'
            : current ? '' : ' No Kenzan gameplay save was found.'));
          return;
        }
        if (pending.length) {
          const count = add(pending.flatMap(({ parsed }) => parsed.progress));
          recordSync();
          for (const { slot, stamp } of pending) {
            seen.set(slot, stamp);
            if (!active.slot && slot === current?.slot) latestTime = current.file.lastModified;
          }
          message(prefix + (count ? 'Added ' + count + ' checkmark' + (count === 1 ? '' : 's') + '. ' : 'No new checkmarks. ')
            + nextStep + source + (retry ? ' A save is not ready yet.' : ''));
        } else if (retry) {
          message(prefix + 'A save is unreadable or still being written. ' + (active.auto ? 'The guide will try again.' : 'Try Sync now after RPCS3 finishes saving.'));
        } else if (!current) {
          message(prefix + (active.slot ? 'The selected gameplay slot was not found. ' : 'No Kenzan gameplay save was found. ') + nextStep);
        } else if (mode !== 'auto') {
          message(prefix + nextStep + source);
        }
      } catch (error) {
        if (!live()) return;
        if (dropAvailable && ['InvalidStateError', 'NotAllowedError', 'SecurityError', 'NotFoundError'].includes(error.name)) {
          disconnect(true);
          message('Folder access was lost. Drop the RPCS3 savedata folder again.');
        } else if (['NotAllowedError', 'SecurityError', 'NotFoundError'].includes(error.name)) {
          stop();
          controls(false, true);
          clearStory();
          message(error.name === 'NotFoundError'
            ? 'The saved folder is unavailable. Check the drive, then reconnect or choose the folder again.'
            : 'Folder access is unavailable. Reconnect the saved folder, or import a file manually.');
        } else {
          message('Could not sync from the folder. Try Sync now, reconnect it, or import a save manually.');
        }
      } finally {
        busy = false;
        updateView();
        const next = requested;
        requested = false;
        if (next && (next !== 'auto' || config?.auto)) void scan(next);
      }
    }

    async function restore() {
      const start = revision;
      try {
        const saved = await storedFolder(storageKey);
        if (revision !== start) return;
        if (!saved) {
          controls(false);
          return;
        }
        if (!isSaveFolder(saved.handle)) {
          controls(false, true);
          message('The remembered folder isn’t an RPCS3 savedata folder. Choose your savedata folder to reconnect.');
          return;
        }
        config = { handle: saved.handle, auto: saved.auto === true,
          slot: typeof saved.slot === 'string' && slotPattern.test(saved.slot) ? saved.slot : '',
          connection: typeof saved.connection === 'string' ? saved.connection : null };
        controls(false);
        schedule();
        await scan(config.auto ? 'auto' : 'inspect');
      } catch {
        persistent = false;
        if (revision === start && !config) controls(false);
      }
    }

    async function connectFolder(getFolder) {
      if (picking) return;
      picking = true;
      updateView();
      const pickerRevision = ++revision;
      const live = () => revision === pickerRevision;
      stop();
      requested = false;
      let changed = false;
      try {
        const handle = await getFolder();
        if (!live()) return;
        if (!(pickerAvailable ? isSaveFolder(handle) : isDroppedSaveFolder(handle))) {
          message(pickerAvailable ? 'Choose the RPCS3 folder named savedata.' : 'Drop one RPCS3 folder named savedata.');
          return;
        }
        const { files } = await scanFolder(handle, live);
        let recognized = false;
        for (const { slot, file } of files) {
          if (!live()) return;
          if (file && await hasSaveHeader(file, slot === systemSlot ? 'system' : 'gameplay')) {
            recognized = true;
            break;
          }
        }
        if (!live()) return;
        if (!recognized) {
          message('No readable Kenzan USERDATA was found in this savedata folder.');
          return;
        }
        clearStory();
        seen.clear();
        latestTime = -1;
        slots = [];
        slotNames = [];
        config = { handle, auto: false, slot: '', connection: crypto.randomUUID() };
        if (dropAvailable) rememberDrop('connected');
        changed = true;
        await persist(undefined, true);
      } catch (error) {
        if (error.name === 'AbortError' || !live()) return;
        message(pickerAvailable
          ? 'The folder picker couldn’t connect. Try desktop Chrome or Edge, or import a save file below.'
          : 'Could not read the dropped folder. Drop it again or import a save file below.');
      } finally {
        picking = false;
        updateView();
        schedule();
        if (changed && live()) await scan('inspect');
      }
    }

    function chooseFolder() {
      return connectFolder(() => window.showDirectoryPicker({
        ...readAccess, id: 'kenzan-rpcs3-saves', ...(config && { startIn: config.handle }),
      }));
    }

    function dropFolder(entry) {
      if (!isDroppedSaveFolder(entry)) {
        message('Drop one RPCS3 folder named savedata.');
        return;
      }
      return connectFolder(() => entry);
    }

    async function reconnectFolder() {
      if (!config || reconnecting) return;
      const active = config;
      const reconnectRevision = revision;
      reconnecting = true;
      updateView();
      try {
        const permission = await active.handle.requestPermission(readAccess);
        if (revision !== reconnectRevision) return;
        if (permission !== 'granted') {
          message('Read access wasn’t granted. You can reconnect again or import a save file.');
          return;
        }
        if (active !== config) return;
        schedule();
        await scan(config.auto ? 'auto' : 'inspect');
      } catch {
        if (revision !== reconnectRevision) return;
        message('Could not reconnect this folder. Choose it again or import a save file below.');
      } finally {
        reconnecting = false;
        updateView();
      }
    }

    async function forgetFolder() {
      const connection = config?.connection;
      if (dropAvailable) rememberDrop('dismissed');
      disconnect();
      if (dropAvailable) {
        message('Folder disconnected. Existing checkmarks were kept.');
        return;
      }
      const forgetRevision = revision;
      connectionEvents?.postMessage({ type: 'forget', connection });
      await persist(connection);
      connectionEvents?.postMessage({ type: 'forget', connection });
      if (revision !== forgetRevision) return;
      message(persistent ? 'Folder forgotten. Existing checkmarks were kept.' : 'Folder disconnected. Browser storage could not be cleared. Revoke access in site settings.');
    }

    async function setAuto(auto) {
      if (!config) return;
      revision++;
      const active = config = { ...config, auto };
      seen.clear();
      schedule();
      await persist();
      if (active === config) await scan(active.auto ? 'auto' : 'inspect');
    }

    async function setSlot(slot) {
      if (!config) return;
      revision++;
      const active = config = { ...config, slot };
      clearStory();
      setSlotOptions(slots);
      seen.clear();
      latestTime = -1;
      await persist();
      if (active === config) await scan(active.auto ? 'auto' : 'inspect');
    }

    const refresh = () => { if (config?.auto && !document.hidden) void scan('auto'); };
    window.addEventListener('focus', refresh);
    document.addEventListener('visibilitychange', () => {
      if (document.hidden) autoRevision++;
      schedule();
      refresh();
    });
    window.addEventListener('pagehide', () => {
      autoRevision++;
      stop();
    });
    window.addEventListener('pageshow', () => {
      schedule();
      refresh();
    });
    if (pickerAvailable) void restore();
    else {
      const reconnect = dropPreference === 'connected';
      controls(false, reconnect);
      if (reconnect) message('Drop the RPCS3 savedata folder again to reconnect.');
    }
    return { chooseFolder: pickerAvailable ? chooseFolder : undefined, dropFolder: dropAvailable ? dropFolder : undefined,
      reconnectFolder, forgetFolder, setAuto, setSlot, syncNow: () => scan('now'),
      subscribe(listener) {
        render = listener;
        updateView();
        return () => { if (render === listener) render = undefined; };
      },
    };
  }

  function mountSaveFolderView(service, reconnectStory, signal) {
    // The scan scheduler and permission state live in the service, outside this view.
    const root = document.querySelector('#save-folder-sync');
    const node = id => root.querySelector('#save-folder-' + id);
    const choose = node('choose');
    const status = node('status');
    if (!service.subscribe) {
      choose.hidden = true;
      if (service.unsupportedLocation) {
        node('privacy').hidden = true;
        node('storage').hidden = true;
        status.textContent = 'Open the official guide on GitHub Pages or open the downloaded guide directly to use folder sync. You can still import a single save below.';
      } else {
        status.textContent = 'Folder sync isn’t available in this browser. Open this guide in desktop Chrome or Edge, or import a save manually below.';
      }
      return;
    }
    const reconnect = node('reconnect');
    const now = node('now');
    const forget = node('forget');
    const settings = node('settings');
    const slotPicker = node('slot');
    const autoPicker = node('auto');
    const dropZone = node('drop');
    choose.hidden = !service.chooseFolder;
    if (service.dropFolder) {
      dropZone.hidden = false;
      node('storage').textContent = 'Saves are processed on this device. Drop the folder again after reloading this page. Your checkmarks are kept.';
      forget.textContent = 'Disconnect folder';
      dropZone.addEventListener('dragover', event => {
        event.preventDefault();
        event.dataTransfer.dropEffect = 'copy';
        dropZone.setAttribute('data-dragging', '');
      }, { signal });
      dropZone.addEventListener('dragleave', () => dropZone.removeAttribute('data-dragging'), { signal });
      dropZone.addEventListener('drop', event => {
        event.preventDefault();
        dropZone.removeAttribute('data-dragging');
        const items = event.dataTransfer.items;
        const entry = items.length === 1 && items[0].kind === 'file' ? items[0].webkitGetAsEntry() : null;
        // Keep the entry itself. Firefox restricts access to DataTransferItem to the drop event.
        void service.dropFolder(entry);
      }, { signal });
    }
    let slotsKey;
    let folderState;
    const unsubscribe = service.subscribe(state => {
      folderState = state;
      reconnect.hidden = !service.chooseFolder || !state.needsReconnect || !state.hasFolder;
      reconnect.disabled = state.reconnecting;
      reconnectStory.disabled = state.reconnecting || state.picking;
      now.hidden = settings.hidden = !state.connected;
      now.disabled = state.busy;
      forget.hidden = !state.hasFolder;
      choose.textContent = state.hasFolder ? 'Change save folder' : 'Choose save folder';
      choose.disabled = state.picking;
      autoPicker.checked = state.auto;
      if (status.textContent !== state.status) status.textContent = state.status;
      const key = state.slotNames.join();
      if (slotsKey !== key) {
        slotsKey = key;
        slotPicker.replaceChildren(new Option('Most recently saved', ''), ...state.slotNames.map(name =>
          new Option('Slot ' + slotPattern.exec(name)[1], name)));
      }
      slotPicker.value = state.slot;
    });
    signal.addEventListener('abort', unsubscribe, { once: true });
    function focusFolderControl() {
      root.closest('details').open = true;
      const target = !reconnect.hidden && !reconnect.disabled ? reconnect
        : !choose.hidden && !choose.disabled ? choose
          : !dropZone.hidden ? dropZone : !reconnectStory.hidden && !reconnectStory.disabled ? reconnectStory
            : document.querySelector('#completion-title');
      target?.focus({ preventScroll: true });
    }
    const actions = [[choose, service.chooseFolder], [forget, service.forgetFolder], [now, service.syncNow]];
    for (const [button, action] of actions) {
      if (action) button.addEventListener('click', async () => {
        const restoreFocus = document.activeElement === button;
        try { await action(); }
        finally {
          // Only an explicit action restores focus. Background permission updates
          // must not interrupt someone who is reading or using another control.
          const active = document.activeElement;
          if (!signal.aborted && restoreFocus && (active === document.body ||
            (active === button && (button.hidden || button.disabled)))) focusFolderControl();
        }
      }, { signal });
    }
    for (const button of [reconnect, reconnectStory]) button.addEventListener('click', async () => {
      if (service.dropFolder) {
        root.closest('details').open = true;
        dropZone.scrollIntoView({ block: 'nearest' });
        dropZone.focus({ preventScroll: true });
        return;
      }
      const restoreFocus = document.activeElement === button;
      if (folderState.hasFolder) await service.reconnectFolder();
      else {
        root.closest('details').open = true;
        await service.chooseFolder();
      }
      if (!signal.aborted && restoreFocus && document.activeElement === document.body) {
        if (button.hidden || button.disabled) focusFolderControl();
        else button.focus({ preventScroll: true });
      }
    }, { signal });
    autoPicker.addEventListener('change', () => service.setAuto(autoPicker.checked), { signal });
    slotPicker.addEventListener('change', () => service.setSlot(slotPicker.value), { signal });
  }

  if (typeof module === 'object' && module.exports) module.exports = { scanSaveFolder, selectSaves };
  else {
    window.initSaveFolderSync = initSaveFolderSync;
    window.mountKenzanSaveFolderView = mountSaveFolderView;
  }
})();

(() => {
  const turtleSlotsOffset = 0x8bb4;
  const slotCount = 5;
  const recordSize = 0x3c;
  // Native rating uses maximum Stamina and Fullness and both values for Leg Power, Sand, Water, and Mud.
  const ratingFields = [0x01, 0x05, 0x06, 0x08, 0x09, 0x0b, 0x0c, 0x0e, 0x0f, 0x12];
  const growthCapFields = { stamina: 0x01, legPower: 0x06, fullness: 0x12, water: 0x0c, sand: 0x09, mud: 0x0f };
  // Native growth tables are indexed by the stored growth type and age, from youngest to oldest.
  const growthOutlooks = ['May slow', 'Likely steady', 'May improve'];
  const growthPatterns = [
    { name: 'Early Bloomer', factors: [1.5, 1.6, 1.4, 1.2, 1.1, .9, .8, .6, .4, .2], outlooks: [1, 1, 0, 0, 0, 0, 0, 0, 0, 1] },
    { name: 'Normal', factors: [.7, 1, 1.2, 1.4, 1.5, 1.4, 1.1, .95, .8, .6], outlooks: [2, 2, 2, 1, 1, 0, 1, 1, 0, 1] },
    { name: 'Late Bloomer', factors: [.8, .9, 1, 1.1, 1.2, 1.3, 1.4, 1.5, 1.4, 1], outlooks: [2, 2, 2, 2, 2, 2, 2, 1, 0, 1] },
    { name: 'Unpredictable', factors: [1.5, .8, 1.1, 1.3, .7, 1.1, 1.2, .9, .7, .4], outlooks: [0, 2, 2, 0, 2, 1, 0, 0, 0, 1] },
  ];
  const speciesNames = ['Chinese Pond Turtle', 'Japanese Pond Turtle', 'Miyamoto Turtle',
    'Temple Turtle', 'Farm Turtle', 'Riverbed Turtle', 'Eternal Turtle'];
  const rankNames = ['Hiramaku', 'Komusubi', 'Sekiwake', 'Ozeki', 'Yokozuna', 'Musabetsu'];
  const personalities = ['Timid', 'Normal', 'Clumsy', 'Unpredictable', 'Awful'];
  // The native bucket screen derives form from two indices in the turtle record.
  const formScores = [
    [50, 70, 90, 70, 50, 30, 20, 30, 50],
    [60, 60, 65, 70, 65, 60, 40, 40, 60],
    [50, 30, 50, 70, 50, 60, 80, 40, 30],
    [80, 70, 80, 70, 70, 50, 40, 30, 40],
  ];
  const nameDecoder = new TextDecoder('shift_jis');

  function readTurtleName(data, offset, fallback = '') {
    if (offset + 20 > data.byteLength) return fallback;
    const bytes = new Uint8Array(data.buffer, data.byteOffset + offset, 20);
    const terminator = bytes.indexOf(0);
    const name = bytes.subarray(0, terminator === -1 ? bytes.length : terminator);
    // Generated names use the Shift-JIS character 名 and a species control byte.
    if (name[0] === 0x96 && name[1] === 0xbc) {
      const speciesToken = bytes[2];
      const defaultName = fallback || speciesNames[speciesToken <= 6 ? speciesToken : 0];
      const tail = nameDecoder.decode(name.subarray(speciesToken <= 6 ? 3 : 2));
      if (tail === '') return defaultName;
      if (/^ [1-5]$/.test(tail)) return defaultName + tail;
    }
    return nameDecoder.decode(name).replace(/[\u0001-\u001f\u007f]/gu, '').trim() || fallback;
  }

  function turtleForm(score) {
    if (score === undefined) return null;
    if (score < 40) return 'Terrible';
    if (score < 50) return 'Bad';
    if (score < 60) return 'Okay';
    return score < 80 ? 'Good' : 'Excellent';
  }

  function readRaceWins(mask, raceCount) {
    const wins = [];
    for (let index = 0; index < raceCount; index++) {
      if (mask & (1 << index)) wins.push(index);
    }
    return wins;
  }

  function readGrowth(byte, life) {
    const fields = Object.entries(growthCapFields);
    const ceilings = Object.fromEntries(fields.map(([stat, field]) => [stat, byte(field + 1)]));
    const points = Object.fromEntries(fields.map(([stat, field]) =>
      [stat, Math.max(0, ceilings[stat] - byte(field))]));
    const pattern = growthPatterns[byte(0x2d)];
    if (!pattern || !life) return { ceilings, points, pattern: pattern?.name };
    // Match the game's single-precision age calculation before indexing its growth tables.
    const adjustedLife = Math.fround(life.initial * Math.fround(.05) + life.remaining);
    const band = Math.trunc(Math.fround(Math.fround(adjustedLife / life.initial) * 10));
    const age = 9 - Math.min(9, band);
    return { ceilings, points, pattern: pattern.name, factor: pattern.factors[age], outlook: growthOutlooks[pattern.outlooks[age]] };
  }

  function readTurtles(data) {
    const roster = [];
    if (data.byteLength < turtleSlotsOffset + slotCount * recordSize) return roster;
    for (let slot = 1; slot <= slotCount; slot++) {
      const offset = turtleSlotsOffset + (slot - 1) * recordSize;
      const byte = field => data.getUint8(offset + field);
      const word = field => data.getUint16(offset + field);
      // Bit 0 marks ownership. Bit 1 distinguishes the bucket from the inventory.
      const flags = word(0x38);
      if (!(flags & 1)) continue;
      const stat = field => ({ value: byte(field), max: byte(field + 1) });
      const terrainGrade = field => Math.min(2, Math.floor(byte(field) / 85));
      const speciesId = byte(0x2b);
      const species = speciesNames[speciesId] ?? null;
      const rankId = byte(0x2c);
      // Yokozuna wins survive demotion and are stored separately from current-rank wins.
      const yokozunaRaceWins = readRaceWins(flags >>> 6, 10);
      const rankRaceWins = rankId === 4 ? yokozunaRaceWins
        : readRaceWins(word(0x3a), rankId < 4 ? 10 : rankId === 5 ? 13 : 0);
      const formScore = formScores[byte(3)]?.[byte(4)];
      const initialLife = word(0x34);
      const remainingLife = word(0x36);
      const life = initialLife > 0 && remainingLife <= initialLife ? { initial: initialLife, remaining: remainingLife } : null;
      const ratingTotal = ratingFields.reduce((sum, field) => sum + byte(field), 0);
      roster.push({
        slot,
        inBucket: Boolean(flags & 2),
        name: readTurtleName(data, offset + 0x16, species ?? `Turtle ${slot}`),
        species,
        speciesId,
        rank: rankNames[rankId] ?? null,
        rankId,
        rankStars: rankId === 4 || rankNames[rankId] === undefined ? null : Math.min(rankRaceWins.length, 3),
        rankRaceWins,
        yokozunaRaceWins,
        adamantineEligible: Boolean(flags & 0x20),
        personality: personalities[byte(0x15)] ?? null,
        form: turtleForm(formScore),
        formScore,
        affinity: byte(0x14),
        recentRaceFeedBonus: Boolean(flags & 8),
        stamina: stat(0),
        legPower: stat(5),
        fullness: stat(0x11),
        terrain: { water: terrainGrade(0xb), sand: terrainGrade(8), mud: terrainGrade(0xe) },
        terrainStats: { water: stat(0xb), sand: stat(8), mud: stat(0xe) },
        calculatedRating: Math.floor(ratingTotal * 100 / (ratingFields.length * 255)),
        savedRating: byte(0x2a),
        growth: readGrowth(byte, life),
        lifespan: speciesId === 6 ? { eternal: true } : life,
        wins: word(0x32),
        races: word(0x30),
        winStreak: byte(0x2e),
        lossStreak: byte(0x2f),
      });
    }
    return roster;
  }

  if (typeof module === 'object' && module.exports) module.exports = { readTurtles, readTurtleName };
  else {
    window.readKenzanTurtles = readTurtles;
    window.readKenzanTurtleName = readTurtleName;
  }
})();

(() => {
  const readTurtleName = typeof module === 'object' && module.exports
    ? require('./save-turtle-bucket.js').readTurtleName : window.readKenzanTurtleName;
  const raceRecords = [
    ['h', 0x8ce0, 10], ['k', 0x8da8, 10], ['s', 0x8e70, 10],
    ['o', 0x8f38, 10], ['y', 0x9000, 10], ['m', 0x90c8, 13],
  ].flatMap(([rank, start, count]) => Array.from({ length: count }, (_, index) => ({
    id: 'turtle-race-' + rank + String(index).padStart(2, '0'),
    offset: start + 20 * index,
  })));

  function readTurtleRaceResults(data) {
    // The completion menu treats a nonempty winner name as a first-place finish.
    return raceRecords.filter(({ offset }) => !data || data.getUint8(offset)).map(({ id, offset }) => ({
      id,
      winner: data ? readTurtleName(data, offset) || null : null,
    }));
  }

  function streakProgress(count, label) {
    return count >= 10 ? `Eligible · ${count} ${label} in a row` : `${count} / 10 ${label} in a row`;
  }

  function seniorProgress(lifespan) {
    if (lifespan?.eternal) return 'Doesn’t age';
    if (!lifespan) return 'Lifespan unavailable';
    const { initial, remaining } = lifespan;
    if (!remaining) return 'No lifespan left';
    // Compare the stored values so display rounding never makes a turtle eligible.
    return remaining * 10 <= initial ? 'Eligible' : 'Above the 10% limit';
  }

  function kenzanTurtleRaceView(section = document.querySelector('#minigame-turtle-racing')) {
    const doc = section.ownerDocument;
    const prompt = section.querySelector('[data-turtle-race-sync]');
    const planner = section.querySelector('[data-turtle-race-entry]');
    const qualifiers = [...section.querySelectorAll('[data-turtle-genbu-qualifier]')];
    const genbuStatus = section.querySelector('[data-turtle-genbu-status]');
    const empty = section.querySelector('[data-turtle-race-empty]');
    const candidates = section.querySelector('[data-turtle-race-candidates]');
    const entries = section.querySelector('[data-turtle-race-entries]');
    const seniors = section.querySelector('[data-turtle-senior]');
    const seniorEntries = section.querySelector('[data-turtle-senior-entries]');
    const winners = [...section.querySelectorAll('tr[id^="turtle-race-"] > th[scope="row"]')].map(header => {
      const label = doc.createElement('span');
      label.className = 'turtle-race-winner';
      label.dataset.turtleLastWinner = header.parentElement.id;
      label.hidden = true;
      header.append(label);
      return label;
    });
    const listNames = new Intl.ListFormat('en');
    let displayed;

    return snapshot => {
      if (displayed === snapshot) return;
      displayed = snapshot;
      const results = new Map(snapshot?.turtleRaceResults?.map(({ id, winner }) => [id, winner]));
      for (const label of winners) {
        const winner = results.get(label.dataset.turtleLastWinner);
        label.hidden = !winner;
        label.textContent = winner ? 'Last won by ' + winner : '';
      }
      const turtles = snapshot?.turtles ?? [];
      const hasSave = Boolean(snapshot?.turtleRaceResults);
      prompt.hidden = hasSave;
      planner.hidden = !hasSave;
      empty.hidden = Boolean(turtles.length);
      candidates.hidden = !turtles.length;
      seniors.open = false;

      const allQualifiersWon = qualifiers.every(qualifier => results.has(qualifier.dataset.turtleGenbuQualifier));
      for (const qualifier of qualifiers) {
        const won = results.has(qualifier.dataset.turtleGenbuQualifier);
        qualifier.textContent = won ? 'Won' : 'Still to win';
      }
      const sekiwake = turtles.filter(turtle => turtle.rankId === 2).map(turtle => turtle.name);
      genbuStatus.textContent = sekiwake.length
        ? (allQualifiersWon ? 'Eligible Sekiwake: ' : 'Sekiwake in this save: ') + listNames.format(sekiwake)
        : 'No Sekiwake turtle in this save.';

      entries.replaceChildren(...turtles.map(turtle => {
        const row = doc.createElement('tr');
        const name = doc.createElement('th');
        name.scope = 'row';
        name.textContent = turtle.name;
        row.append(name);
        const adamantine = turtle.adamantineEligible ? 'Eligible'
          : `${turtle.yokozunaRaceWins.length} / 10 Yokozuna wins`;
        for (const progress of [adamantine, streakProgress(turtle.winStreak, 'wins'), streakProgress(turtle.lossStreak, 'losses')]) {
          const cell = doc.createElement('td');
          cell.textContent = progress;
          row.append(cell);
        }
        return row;
      }));
      seniorEntries.replaceChildren(...turtles.map(turtle => {
        const item = doc.createElement('li');
        const name = doc.createElement('strong');
        name.textContent = turtle.name;
        item.append(name, ' · ' + seniorProgress(turtle.lifespan));
        return item;
      }));
    };
  }

  if (typeof module === 'object' && module.exports) module.exports = { readTurtleRaceResults };
  else {
    window.readKenzanTurtleRaceResults = readTurtleRaceResults;
    window.kenzanTurtleRaceView = kenzanTurtleRaceView;
  }
})();

(() => {
  const courses = ['red-spirit', 'white-spirit', 'black-spirit', 'blue-spirit', 'yellow-spirit'];
  // Fixed reference targets from wtfl_setting.bin, not values stored in a save.
  const waterfallNirvanaTargets = Object.freeze(Object.fromEntries(courses.map((course, index) =>
    [course, [12000, 13000, 17000, 22000, 18000][index]])));

  function readWaterfallRecords(data) {
    // The gameplay-save reader validates the full USERDATA header first. This
    // bounded helper also accepts a DataView into an offset ArrayBuffer slice.
    try {
      if (Object.prototype.toString.call(data) !== '[object DataView]' || data.byteLength < 0x9334) return undefined;
    } catch {
      return undefined; // A detached/unavailable buffer is not an empty record.
    }
    // Native result writer 0x23ac in the isolated Waterfall module reads five
    // three-bit best ranks, followed by five big-endian uint16 best scores.
    // Only successful finishes reach that writer; each record only increases.
    // Evidence: research/kenzan60/waterfall-save-20261120/native/.
    const packed = data.getUint16(0x9328, false);
    return Object.fromEntries(courses.map((course, index) => {
      const rank = (packed >>> (3 * index)) & 7;
      const score = data.getUint16(0x932a + 2 * index, false);
      const status = rank === 0 && score === 0 ? 'none'
        : rank >= 1 && rank <= 4 && score > 0 ? 'recorded' : 'unavailable';
      return [course, status === 'unavailable' ? { score: null, rank: null, status }
        : { score, rank, status }];
    }));
  }

  if (typeof module === 'object' && module.exports) module.exports = { readWaterfallRecords, waterfallNirvanaTargets };
  else {
    window.readKenzanWaterfallRecords = readWaterfallRecords;
    window.kenzanWaterfallNirvanaTargets = waterfallNirvanaTargets;
  }
})();

(() => {
  const targets = typeof module === 'object' && module.exports
    ? require('../tracker/save-waterfall.js').waterfallNirvanaTargets : window.kenzanWaterfallNirvanaTargets;

  function waterfallScoreText(record, target) {
    if (!record) return { score: 'Sync a gameplay save', rank: '', goal: '' };
    if (record.status === 'none') return { score: 'No successful result recorded', rank: '', goal: '' };
    if (record.status !== 'recorded' || !Number.isInteger(record.score) || record.score <= 0
      || !Number.isInteger(record.rank) || record.rank < 1 || record.rank > 4) {
      return { score: 'Record unavailable', rank: '', goal: '' };
    }
    const remaining = target - record.score;
    return {
      score: `${record.score.toLocaleString()} ${record.score === 1 ? 'point' : 'points'}`,
      rank: record.rank === 4 ? 'Nirvana · highest rank' : `Best rank: ${record.rank} of 4`,
      goal: record.rank === 4 ? '' : remaining > 0 ? `${remaining.toLocaleString()} ${remaining === 1 ? 'point' : 'points'} to Nirvana` : 'Nirvana score reached',
    };
  }

  function mountWaterfallScores(root = document) {
    // Capture the live cells before the checklist loader detaches closed bodies.
    const cells = [...root.querySelectorAll('[data-waterfall-score]')];
    const help = root.querySelector('[data-waterfall-score-help]');
    const source = root.querySelector('[data-waterfall-source]');
    return snapshot => {
      const records = snapshot?.waterfall;
      if (help) help.hidden = Boolean(records);
      if (source) {
        source.hidden = !records;
        const observed = new Date(snapshot?.observedAt);
        source.textContent = records ? `Saved records · ${snapshot.source || 'Gameplay save'}${Number.isFinite(observed.getTime()) ? ` · Read ${observed.toLocaleString()}` : ''}` : '';
      }
      for (const cell of cells) {
        const copy = waterfallScoreText(records?.[cell.dataset.waterfallScore], targets[cell.dataset.waterfallScore]);
        const document = cell.ownerDocument;
        const score = document.createElement(copy.rank ? 'strong' : 'span');
        score.className = 'waterfall-score-value';
        score.textContent = copy.score;
        const parts = [score];
        for (const value of [copy.rank, copy.goal].filter(Boolean)) {
          const detail = document.createElement('span');
          detail.className = 'waterfall-score-note';
          detail.textContent = value;
          parts.push(detail);
        }
        cell.replaceChildren(...parts);
      }
    };
  }

  if (typeof module === 'object' && module.exports) module.exports = { waterfallScoreText, mountWaterfallScores };
  else window.mountKenzanWaterfallScores = mountWaterfallScores;
})();

(() => {
  const scarecrowCourses = Object.freeze([
    'single-formation', 'twin-formation', 'oni-formation', 'shinobi-formation',
    'single-strength-formation', 'twin-strength-formation', 'great-strength-formation',
    'enduring-strength-formation', 'enlightenment-formation', 'two-heavens-formation',
    'ultimate-formation', 'purgatory-formation',
  ]);
  const jiraiyaCourses = Object.freeze([
    'first-chamber', 'earth-chamber', 'water-chamber', 'fire-chamber',
    'wind-chamber', 'heavenly-chamber', 'ultimate-chamber',
  ]);
  const trainingRankNames = Object.freeze([null, 'Novice Ninja', 'Average Ninja', 'Elite Ninja', 'Master Ninja']);

  function readTrainingRecords(data) {
    // The caller admits the full USERDATA header. This helper also works with
    // DataViews into offset buffers; invalid/detached input is not an empty save.
    try {
      if (Object.prototype.toString.call(data) !== '[object DataView]' || data.byteLength < 0x981a) return undefined;
      const flag = state => Boolean(data.getUint32(0x190 + 0x154 * 32 + (state >>> 5) * 4, false)
        & (1 << (state & 31)));
      const scarecrow = Object.fromEntries(scarecrowCourses.map((course, index) => {
        // Completion consumer 0x2ecb60 returns the highest of four rank flags.
        // Its first table entry is Master Ninja, then Elite/Average/Novice.
        let rank = 0;
        for (let position = 0; position < 4; position++) {
          if (flag(37 + 4 * index + position)) { rank = 4 - position; break; }
        }
        const entries = Array.from({ length: 10 }, (_, place) => {
          const at = 0x9384 + 80 * index + 8 * place;
          return { ticks: data.getUint32(at, false), nameId: data.getUint32(at + 4, false), place: place + 1 };
        });
        const valid = entries.every(entry => entry.nameId <= 41);
        // Result writer 0x13fa24 inserts (elapsed 30 Hz ticks, name 0), then
        // sorts ten entries. NPC records use names 1..41. Multiple player
        // entries can remain; the shortest listed one is the personal best.
        const personal = valid ? entries.filter(entry => entry.nameId === 0 && entry.ticks > 0) : [];
        const best = personal.reduce((winner, entry) => !winner || entry.ticks < winner.ticks ? entry : winner, undefined);
        return [course, {
          rank, rankName: trainingRankNames[rank], cleared: flag(19 + index),
          status: rank ? 'recorded' : 'none',
          // The native menu formats this saved counter with a divisor of 30.
          // This mirrors its displayed time; it is not measured wall time or
          // a claim about how an FPS patch advances the gameplay clock.
          bestTimeTicks: best?.ticks ?? null, bestTime: best ? best.ticks / 30 : null,
          leaderboardPlace: best?.place ?? null,
          timeStatus: valid ? best ? 'recorded' : 'not-on-board' : 'unavailable',
        }];
      }));
      const packed = data.getUint32(0x9744, false);
      const jiraiya = Object.fromEntries(jiraiyaCourses.map((course, index) => {
        const rank = (packed >>> (8 + 3 * index)) & 7;
        const cleared = Boolean(packed & (1 << index));
        const entries = Array.from({ length: 10 }, (_, place) => {
          const at = 10 * index + place;
          const identity = data.getUint8(0x97d4 + at);
          // Native k_yabusame reader: two score bits share the name byte.
          const score = data.getUint16(0x9748 + 2 * at, false) | ((identity & 0xc0) << 10);
          return { nameId: identity & 0x3f, score, place: place + 1 };
        });
        const valid = rank <= 4 && entries.every(entry => entry.nameId <= 10);
        // Name 0 is the player. The ten NPC defaults are not personal scores.
        // This board retains only ten entries, so absence does not prove that
        // the player never played or never earned a score on this course.
        const personal = valid ? entries.filter(entry => entry.nameId === 0 && entry.score > 0) : [];
        const best = personal.reduce((winner, entry) => !winner || entry.score > winner.score ? entry : winner, undefined);
        return [course, {
          rank: valid ? rank : null, rankName: valid ? trainingRankNames[rank] : null,
          cleared, status: valid ? rank ? 'recorded' : 'none' : 'unavailable',
          score: best?.score ?? null, leaderboardPlace: best?.place ?? null,
          scoreStatus: valid ? best ? 'recorded' : 'not-on-board' : 'unavailable',
        }];
      }));
      return { scarecrow, jiraiya };
    } catch {
      return undefined;
    }
  }

  if (typeof module === 'object' && module.exports) {
    module.exports = { readTrainingRecords, trainingRankNames, scarecrowCourses, jiraiyaCourses };
  } else {
    window.readKenzanTrainingRecords = readTrainingRecords;
  }
})();

(() => {
  // Saved ranks are independent of the player's entries on the ten-place
  // boards. NPC defaults and a missing personal entry never become a record.
  function formatTrainingTime(ticks) {
    // Match the native display's separate truncated components. Rounding the
    // whole duration would turn a 29-tick fraction into the wrong hundredths.
    const minutes = Math.floor(ticks / 1800);
    const seconds = Math.floor(ticks / 30) % 60;
    const hundredths = Math.floor((ticks % 30) * 100 / 30);
    return `${minutes}:${String(seconds).padStart(2, '0')}.${String(hundredths).padStart(2, '0')}`;
  }

  function trainingRecordText(record, kind) {
    if (!record) return { value: 'Sync a gameplay save', note: '' };
    const rank = record.status === 'recorded' && record.rankName ? record.rankName
      : record.status === 'unavailable' ? 'Rank unavailable' : 'No rank recorded';
    if (kind === 'scarecrow') {
      if (record.timeStatus === 'recorded' && Number.isSafeInteger(record.bestTimeTicks) && record.bestTimeTicks > 0) {
        return { value: formatTrainingTime(record.bestTimeTicks),
          note: `Best rank: ${rank} · Board place ${record.leaderboardPlace} of 10` };
      }
      return { value: record.timeStatus === 'not-on-board' ? 'No personal time on this board' : 'Time unavailable',
        note: `Best rank: ${rank}` };
    }
    if (record.scoreStatus === 'recorded' && Number.isInteger(record.score) && record.score > 0) {
      return { value: `${record.score.toLocaleString()} points`,
        note: `Best rank: ${rank} · Board place ${record.leaderboardPlace} of 10` };
    }
    return { value: record.scoreStatus === 'unavailable' ? 'Score unavailable' : 'No personal score on this board', note: rank };
  }

  function mountTrainingRecords(root = document) {
    // Capture cells before the existing checklist owner detaches closed tables.
    const cells = [...root.querySelectorAll('[data-training-record]')];
    const helps = [...root.querySelectorAll('[data-training-record-help]')];
    return snapshot => {
      const records = snapshot?.trainingRecords;
      for (const help of helps) help.hidden = Boolean(records);
      for (const cell of cells) {
        const kind = cell.dataset.trainingRecordKind;
        const text = trainingRecordText(records?.[kind]?.[cell.dataset.trainingRecord], kind);
        const value = cell.ownerDocument.createElement('strong');
        value.className = 'waterfall-score-value';
        value.textContent = text.value;
        const note = cell.ownerDocument.createElement('span');
        note.className = 'waterfall-score-note';
        note.textContent = text.note;
        cell.replaceChildren(value, ...(text.note ? [note] : []));
      }
    };
  }
  if (typeof module === 'object' && module.exports) module.exports = { trainingRecordText, mountTrainingRecords, formatTrainingTime };
  else window.mountKenzanTrainingRecords = mountTrainingRecords;
})();

(() => {
  const inventoryOffset = 0x4850;
  const inventoryCount = 1000;
  const recordSize = 4;
  const setsOffset = 0x6890;
  const slotsPerSet = 7;
  const emptyIndex = 1000;
  const referenceLimit = 1064;
  const acquiredOffset = 0x68d8;
  const recipesOffset = 0x73ac;
  const recipeCount = 175;

  const hasBytes = (data, offset, count) => Boolean(data
    && typeof data.getUint32 === 'function' && offset >= 0 && offset + count <= data.byteLength);

  // Both native history bitsets use low-to-high bits within big-endian words.
  function historyBit(data, offset, index) {
    const word = offset + (index >>> 5) * 4;
    return hasBytes(data, word, 4) ? Boolean(data.getUint32(word) & (1 << (index & 31))) : null;
  }

  function readWeapons(data, catalogue) {
    // The catalogue contains completion weapons only. Other equipment may appear in
    // an ordinary record, but neither those records nor built-ins award a weapon.
    if (!Array.isArray(catalogue?.weapons)) return undefined;
    // Equipment renderer 002fe2ac reads this u16, then adds floor(POW / 10)
    // to its individual/pair Attack value. This is distinct from player level.
    const characterPower = hasBytes(data, 0x4808, 2) ? data.getUint16(0x4808) : null;
    const entries = catalogue.weapons.filter(entry => Number.isInteger(entry?.itemId)
      && entry.itemId > 0 && entry.itemId <= 0xffff && typeof entry.key === 'string');
    // The native item.bin row count validates all ordinary equipment, including
    // legitimate equipment outside the completion-weapon catalogue.
    const itemCount = catalogue.itemCount;
    const itemCountKnown = itemCount === undefined || Number.isInteger(itemCount)
      && itemCount > 0 && itemCount <= 0x10000;
    const catalogueKnown = entries.length === catalogue.weapons.length && entries.length > 0
      && new Set(entries.map(({ itemId }) => itemId)).size === entries.length && itemCountKnown;
    const inventoryAvailable = catalogueKnown && hasBytes(data, inventoryOffset, inventoryCount * recordSize);
    const inventoryIds = inventoryAvailable ? Array.from({ length: inventoryCount }, (_, index) =>
      data.getUint16(inventoryOffset + index * recordSize)) : undefined;
    const validItemId = itemId => itemCount === undefined || itemId < itemCount;
    const known = inventoryAvailable && inventoryIds.every(validItemId);
    const byItemId = Object.fromEntries(entries.map(({ itemId, key }) => [itemId, {
      itemId, key, count: known ? 0 : null, instances: [],
      assigned: null, activeSavedSet: null,
      acquired: historyBit(data, acquiredOffset, itemId),
      crafted: false, craftedRecipeCount: 0, recipeCount: 0,
    }]));
    if (inventoryAvailable) {
      // Exactly 1,000 >HBB records. Bytes 2/3 have no established general UI label.
      for (let index = 0; index < inventoryCount; index++) {
        const itemId = inventoryIds[index];
        if (!validItemId(itemId)) continue;
        const weapon = byItemId[itemId];
        if (!weapon) continue;
        if (known) weapon.count++;
        weapon.instances.push({ index, assignments: [] });
      }
    }
    const instances = new Map(Object.values(byItemId).flatMap(weapon =>
      weapon.instances.map(instance => [instance.index, instance])));
    const sets = [1, 2].map(set => {
      const slots = Array.from({ length: slotsPerSet }, (_, slotIndex) => {
        const slot = slotIndex + 1;
        const offset = setsOffset + ((set - 1) * slotsPerSet + slotIndex) * 4;
        if (!hasBytes(data, offset, 4)) return { slot, index: null, kind: 'unknown' };
        const index = data.getUint32(offset);
        if (index === emptyIndex) return { slot, index, kind: 'empty' };
        if (index >= referenceLimit) return { slot, index, kind: 'unknown' };
        if (index > emptyIndex) return { slot, index, kind: 'builtin' };
        if (!inventoryAvailable || !validItemId(inventoryIds[index])) return { slot, index, kind: 'unknown' };
        const itemId = inventoryIds[index];
        instances.get(index)?.assignments.push({ set, slot });
        return { slot, index, kind: 'ordinary', itemId };
      });
      return { set, known: slots.every(slot => slot.kind !== 'unknown'), slots };
    });
    const selector = hasBytes(data, 0x480d, 1) ? data.getUint8(0x480d) : null;
    const activeSet = selector === 0 || selector === 1 ? selector + 1 : null;
    const assignmentKnown = inventoryAvailable && sets.every(set => set.known);
    const activeAssignmentKnown = inventoryAvailable && activeSet !== null && sets[activeSet - 1].known;
    for (const weapon of Object.values(byItemId)) {
      // A verified positive reference survives an unrelated bad slot. A negative
      // result requires the whole relevant saved slice to be understood.
      const assignments = weapon.instances.flatMap(instance => instance.assignments);
      weapon.assigned = assignments.length ? true : assignmentKnown ? false : null;
      weapon.activeSavedSet = activeSet === null ? null
        : assignments.some(assignment => assignment.set === activeSet) ? true : activeAssignmentKnown ? false : null;
    }
    const recipes = (Array.isArray(catalogue.recipes) ? catalogue.recipes : []).map(recipe => {
      const { index, outputItemId, key } = recipe ?? {};
      const complete = Number.isInteger(index) && index >= 0 && index < recipeCount
        ? historyBit(data, recipesOffset, index) : null;
      return { index, outputItemId, key, complete };
    });
    for (const weapon of Object.values(byItemId)) {
      const histories = recipes.filter(recipe => recipe.outputItemId === weapon.itemId);
      weapon.recipeCount = histories.length;
      weapon.craftedRecipeCount = histories.some(recipe => recipe.complete === null) ? null
        : histories.filter(recipe => recipe.complete).length;
      weapon.crafted = histories.some(recipe => recipe.complete) ? true
        : histories.some(recipe => recipe.complete === null) ? null : false;
    }
    // These are saved assignments, not a claim about live equipment: the game can
    // temporarily resolve equipment through a separate runtime override.
    return { known, byItemId, activeSet, sets, assignmentKnown, activeAssignmentKnown, recipes, characterPower };
  }

  function equipmentMenuAttack(baseAttack, characterPower) {
    if (!Number.isInteger(baseAttack) || baseAttack < 0 || baseAttack > 0xff
      || !Number.isInteger(characterPower) || characterPower < 0 || characterPower > 0xffff) return null;
    return baseAttack + Math.floor(characterPower / 10);
  }

  if (typeof module === 'object' && module.exports) module.exports = { readWeapons, equipmentMenuAttack };
  else {
    window.readKenzanWeapons = readWeapons;
    window.getKenzanEquipmentMenuAttack = equipmentMenuAttack;
  }
})();

(() => {
  // Native E5DC4 counts one copy per >HBB record. The last two bytes
  // are auxiliary data, never a stack quantity. See forge-readiness-20261119.
  function readCrafting(data, catalogue) {
    if (!data || typeof data.getUint16 !== 'function' || typeof data.getUint32 !== 'function'
      || typeof data.getUint8 !== 'function' || !Number.isInteger(data.byteLength)
      || !Number.isInteger(catalogue?.itemCount) || catalogue.itemCount <= 0 || catalogue.itemCount > 0x8000
      || !Array.isArray(catalogue.materials) || !Array.isArray(catalogue.books)
      || catalogue.materials.some(id => !Number.isInteger(id) || id <= 0 || id >= catalogue.itemCount)
      || (catalogue.turtleFoods !== undefined && (!Array.isArray(catalogue.turtleFoods)
        || catalogue.turtleFoods.some(id => !Number.isInteger(id) || id <= 0 || id >= catalogue.itemCount)))
      || catalogue.books.some(book => !Number.isInteger(book?.keyItemIndex) || book.keyItemIndex < 0
        || book.keyItemIndex >= 256 || book.itemId !== (0x8000 | book.keyItemIndex))) return undefined;
    const pools = [[0x4814, 15], [0x4850, 1000], [0x58f0, 500]].map(([offset, size]) => {
      if (data.byteLength < offset + size * 4) return null;
      const counts = new Map();
      for (let index = 0; index < size; index++) {
        const id = data.getUint16(offset + index * 4);
        if (id >= catalogue.itemCount) return null;
        if (id) counts.set(id, (counts.get(id) ?? 0) + 1);
      }
      return counts;
    });
    const readStocks = ids => Object.fromEntries(ids.map(id => {
      const counts = pools.map(pool => pool?.get(id) ?? (pool ? 0 : null));
      const onPlayer = counts[0] === null || counts[1] === null ? null : counts[0] + counts[1];
      const storage = counts[2];
      const minimum = counts.reduce((sum, value) => sum + (value ?? 0), 0);
      return [id, { onPlayer, storage, total: counts.includes(null) ? null : minimum, minimum }];
    }));
    const materials = readStocks(catalogue.materials);
    const books = Object.fromEntries((catalogue.books ?? []).map(({ itemId, keyItemIndex: key }) => {
      const offset = 0x70d8 + (key >>> 3);
      return [itemId, Number.isInteger(key) && key >= 0 && key < 256 && offset < data.byteLength
        ? Boolean(data.getUint8(offset) & (1 << (key & 7))) : null];
    }));
    const amount = data.byteLength >= 0x70fc ? data.getUint32(0x70f8) : null;
    return { mon: amount !== null && amount <= 99999999 ? amount : null, materials, books,
      ...(catalogue.turtleFoods === undefined ? {} : { foods: readStocks(catalogue.turtleFoods) }) };
  }

  function assessRecipe(recipe, crafting, weapons, sourceItemId) {
    const count = weapons?.known ? weapons.byItemId?.[sourceItemId]?.count ?? null : null;
    const source = { count, met: count === null ? null : count >= 1 };
    const mon = crafting?.mon ?? null;
    const fee = { mon, met: mon === null ? null : mon >= recipe.cost };
    const materials = recipe.materials.map(item => {
      const stock = crafting?.materials?.[item.itemId];
      const met = stock?.total !== null && stock?.total !== undefined ? stock.total >= item.count
        : stock?.minimum >= item.count ? true : null;
      return { ...item, stock, met };
    });
    const books = recipe.books.map(item => ({ ...item, met: crafting?.books?.[item.itemId] ?? null }));
    const checks = [source.met, fee.met, ...materials.map(item => item.met), ...books.map(item => item.met)];
    return { source, fee, materials, books,
      met: checks.includes(false) ? false : checks.includes(null) ? null : true };
  }

  if (typeof module === 'object' && module.exports) module.exports = { readCrafting, assessRecipe };
  else window.kenzanCrafting = { readCrafting, assessRecipe };
})();

(() => {
  const registryVersion = 1;
  const defaultRegistry = typeof module === 'object' && module.exports
    ? require('../../data/quests/quest-milestones-data.json') : undefined;
  const hasBytes = (data, offset, length) => Boolean(data
    && typeof data.getUint8 === 'function' && typeof data.getUint16 === 'function'
    && typeof data.getUint32 === 'function' && typeof data.getInt16 === 'function' && Number.isInteger(data.byteLength)
    && Number.isInteger(offset) && offset >= 0 && offset + length <= data.byteLength);
  const any = values => values.includes(true) ? true : values.includes(null) ? null : false;
  const all = values => values.includes(false) ? false : values.includes(null) ? null : true;

  // This reader never stores guide checks or combines facts from different saves.
  // Missing bytes, unverified native mappings and invalid stock stay unknown.
  function readQuestMilestones(data, registry = defaultRegistry, options = {}) {
    if (registry?.version !== registryVersion || !Array.isArray(registry.quests)
      || !registry.storage || !Number.isInteger(registry.storage.itemCount)) return undefined;
    const layout = registry.storage;
    const pools = (layout.ordinaryPools ?? []).map(pool => {
      if (!Number.isInteger(pool.count) || !hasBytes(data, pool.offset, pool.count * 4)) return null;
      const counts = new Map();
      for (let index = 0; index < pool.count; index++) {
        const id = data.getUint16(pool.offset + index * 4);
        if (id >= layout.itemCount) return null;
        if (id) counts.set(id, (counts.get(id) ?? 0) + 1);
      }
      return counts;
    });
    const flag = (group, bit) => {
      if (!Number.isInteger(group) || group < 0 || group >= 520
        || !Number.isInteger(bit) || bit < 0 || bit >= 256) return null;
      const offset = layout.scenarioOffset + group * layout.scenarioGroupBytes + (bit >>> 5) * 4;
      return hasBytes(data, offset, 4) ? Boolean(data.getUint32(offset) & (1 << (bit & 31))) : null;
    };
    const history = id => {
      if (!Number.isInteger(id) || id <= 0 || id >= layout.itemCount) return null;
      const offset = layout.itemHistoryOffset + (id >>> 5) * 4;
      return hasBytes(data, offset, 4) ? Boolean(data.getUint32(offset) & (1 << (id & 31))) : null;
    };
    function stock(item) {
      if (item?.kind === 'key') {
        if (!Number.isInteger(item.id) || item.id < 0 || item.id >= 256) return null;
        const offset = layout.keyItemsOffset + (item.id >>> 3);
        const held = hasBytes(data, offset, 1) ? Boolean(data.getUint8(offset) & (1 << (item.id & 7))) : null;
        return { kind: 'key', held, onPlayer: held === null ? null : Number(held), storage: 0,
          total: held === null ? null : Number(held), minimum: held ? 1 : 0 };
      }
      if (item?.kind !== 'ordinary' || !Number.isInteger(item.id) || item.id <= 0
        || item.id >= layout.itemCount || pools.length !== 3) return null;
      const values = pools.map(pool => pool ? pool.get(item.id) ?? 0 : null);
      const onPlayer = values[0] === null || values[1] === null ? null : values[0] + values[1];
      return { kind: 'ordinary', onPlayer, storage: values[2],
        total: values.includes(null) ? null : values.reduce((sum, n) => sum + n, 0),
        minimum: values.reduce((sum, n) => sum + (n ?? 0), 0) };
    }
    function owned(item) {
      const value = stock(item);
      return !value ? null : value.minimum > 0 ? true : value.total === null ? null : false;
    }
    const progressGroups = Array.isArray(options.existingProgress) ? options.existingProgress : [];
    function existingCount(spec) {
      const group = progressGroups.find(entry => entry?.label === spec.group && Array.isArray(entry.keys));
      if (!group || !Array.isArray(spec.keys)) return null;
      // Reuse the existing fighter checkmarks, but do not trust negative/corrupt
      // native win records that the older summary reader cannot distinguish.
      if (spec.group === 'Coliseum fighters defeated') {
        if (!hasBytes(data, 0x7d14, 50 * 24)) return null;
        for (let index = 0; index < 50 * 12; index++) {
          if (data.getInt16(0x7d14 + 2 * index) < 0) return null;
        }
      }
      const keys = new Set(group.keys);
      return spec.keys.filter(key => keys.has(key)).length;
    }
    const quests = {};
    for (const definition of registry.quests) {
      const counters = {};
      function evaluate(expression) {
        if (!expression || typeof expression !== 'object') return null;
        if (Array.isArray(expression.flag)) return flag(...expression.flag);
        if (Array.isArray(expression.any)) return any(expression.any.map(evaluate));
        if (Array.isArray(expression.all)) return all(expression.all.map(evaluate));
        if (expression.unknown) return null;
        if (expression.history !== undefined) return history(expression.history);
        if (expression.owned) return owned(expression.owned);
        if (typeof expression.counter === 'string') {
          const counter = counters[expression.counter];
          if (!counter) return null;
          return counter.value !== null ? counter.value >= expression.atLeast
            : counter.minimum >= expression.atLeast ? true : null;
        }
        return null;
      }
      const complete = evaluate(definition.completeState);
      for (const [id, spec] of Object.entries(definition.counters ?? {})) {
        let value = null;
        let minimum = 0;
        if (spec.type === 'highestFlag') {
          const states = spec.flags.map(([group, bit, amount]) => ({ set: flag(group, bit), amount }));
          minimum = Math.max(0, ...states.filter(state => state.set === true).map(state => state.amount));
          value = states.every(state => state.set !== null) || minimum >= spec.target ? minimum : null;
        } else if (spec.type === 'flagCount') {
          const states = spec.flags.map(([group, bit]) => flag(group, bit));
          minimum = states.filter(state => state === true).length;
          value = states.includes(null) ? null : minimum;
        } else if (spec.type === 'existingProgress') {
          value = existingCount(spec);
          minimum = value ?? 0;
        } else if (spec.type === 'scalar' && spec.serializationVerified === true
          && Number.isInteger(spec.offset) && hasBytes(data, spec.offset, 2)) {
          const number = data.getInt16(spec.offset);
          if (number >= spec.min && number <= spec.max) value = minimum = number;
        }
        const completedByEvent = evaluate(spec.completeState);
        counters[id] = { ...spec, value, minimum, completedByEvent: completedByEvent === true,
          complete: completedByEvent === true ? true : value !== null ? value >= spec.target
            : minimum >= spec.target ? true : null,
          source: value === null ? 'unknown' : 'save' };
      }
      const milestones = definition.milestones.map(row => {
        const result = { ...row, complete: evaluate(row.state) };
        if (row.item) result.owned = stock(row.item);
        for (const field of ['acquired', 'delivered', 'used']) {
          if (row[field + 'State']) result[field] = evaluate(row[field + 'State']);
        }
        if (row.counterId) result.counter = counters[row.counterId];
        result.source = result.complete === null ? 'unknown' : 'save';
        return result;
      });
      const prerequisites = (definition.prerequisites ?? []).map(row => ({ ...row, complete: evaluate(row.state) }));
      quests[definition.id] = { ...definition, complete, milestones, counters, prerequisites };
    }
    const observedAt = typeof options.observedAt === 'string' && Number.isFinite(Date.parse(options.observedAt))
      ? options.observedAt : null;
    const result = { version: registryVersion, observedAt, quests };
    result.assessment = assessQuestMilestones(result);
    return result;
  }

  // This is a checklist summary, never a substitute for native quest completion.
  // Optional deliveries and source-route acquisitions do not alter a quest's result.
  function assessQuestMilestones(snapshot) {
    return Object.fromEntries(Object.entries(snapshot?.quests ?? {}).map(([id, quest]) => {
      const rows = quest.milestones.filter(row => !row.optional);
      const states = rows.map(row => row.complete);
      return [id, { questComplete: quest.complete, checked: states.filter(value => value === true).length,
        total: rows.length, unknown: states.filter(value => value === null).length,
        allMilestones: all(states) }];
    }));
  }

  const api = { readQuestMilestones, assessQuestMilestones, registryVersion };
  if (typeof module === 'object' && module.exports) module.exports = api;
  else window.kenzanQuestMilestones = api;
})();

(() => {
  const numbers = new Intl.NumberFormat('en', { maximumFractionDigits: 1 });
  const n = value => numbers.format(value);
  const multipliers = new Intl.NumberFormat('en', { maximumFractionDigits: 2 });
  const multiplier = value => multipliers.format(value);
  const known = value => typeof value === 'number' && Number.isFinite(value);
  const byte = value => Number.isInteger(value) && value >= 0 && value <= 255;
  const energyFactor = value => .75 + .25 * value / 255;
  const percent = value => `${n(value * 100)}%`;
  const statNames = { stamina: 'Stamina', legPower: 'Leg Power', fullness: 'Fullness', water: 'Water', sand: 'Sand', mud: 'Mud' };
  const personalityNotes = {
    Timid: 'Can doze near the start or finish. Accepted cheering costs up to one trust point.',
    Normal: 'Its main mishap is slowing down. Form, trust and Fullness also affect mishaps.',
    Clumsy: 'Can hit the wall during a mishap. Accepted cheering can add one trust point, up to full trust.',
    Unpredictable: 'Can show Timid, Normal or Clumsy racing behavior rather than one consistent style.',
    Awful: 'Especially prone to Clumsy-style mishaps. Form, trust and Fullness still matter.',
  };
  const patternNotes = {
    'Early Bloomer': 'Food growth is strongest early in life.',
    Normal: 'Food growth peaks around the middle of its life.',
    'Late Bloomer': 'Food growth peaks later in life.',
    Unpredictable: 'Food growth rises and falls with age rather than following a steady curve.',
  };
  const outlookNotes = {
    'May slow': 'Growth from food may slow as it ages.',
    'Likely steady': 'Growth from food is expected to stay roughly steady as it ages.',
    'May improve': 'Growth from food may improve as it ages.',
  };

  function statTip(turtle, key) {
    const label = statNames[key], stat = turtle[key];
    const generic = key === 'stamina' ? 'Stamina supplies energy for running and cheering.'
      : key === 'legPower' ? 'Leg Power supplies base running speed; this is not a speed percentage.'
      : 'Fullness controls how much room it has for food.';
    if (!byte(stat?.value) || !byte(stat?.max)) return `${label} values are unavailable. ${generic}`;
    const { value, max } = stat;
    let detail;
    if (value > max) detail = `The current value is ${n(value-max)} above its saved trained limit.`;
    else if (key === 'fullness') detail = value === max ? 'Full: it cannot eat until Fullness drops.'
      : `Not full, with ${n(max-value)} ${max-value === 1 ? 'point' : 'points'} of room for food.`;
    else detail = value === max ? 'At its current trained maximum.'
      : `${n(max-value)} ${max-value === 1 ? 'point' : 'points'} below its current trained maximum.`;
    let racing;
    if (key === 'stamina') {
      racing = `Its starting stamina contributes ${multiplier(energyFactor(value))}× to running pace, before the other factors. `
        + (value < max ? `Refilling to ${n(max)} would improve this part of its starting pace by ${percent(energyFactor(max) / energyFactor(value) - 1)}.`
          : 'It is already full for this turtle; refilling cannot improve its starting stamina.');
      racing += ' This part of its pace falls as stamina drains during the race.';
    } else if (key === 'legPower') {
      racing = `At ${n(value)}, Leg Power contributes ${multiplier(.5 + .002 * value)}× to running pace on every track, before Form, stamina, terrain and mishaps. Higher Leg Power improves this part of its pace; this number alone cannot tell whether it will beat the other entrants.`;
    } else {
      const atEntry = Math.max(0, value - 32) / 255;
      racing = `After the usual 32-point reduction on race entry, Fullness slows its pace by ${percent(atEntry * .025)} on normal ground, ${percent(atEntry * .05)} on sand, ${percent(atEntry * .075)} in water and ${percent(atEntry * .1)} in mud.`;
      racing += turtle.personality === 'Clumsy' || turtle.personality === 'Awful'
        ? ' Being fuller can reduce its wall-hit mishaps, so emptier is not always better.'
        : turtle.personality === 'Timid' || turtle.personality === 'Normal'
          ? ' Being fuller also increases the Fullness part of its main mishap check.'
          : 'Fullness also affects mishaps differently for each personality.';
    }
    const lowStamina = key === 'stamina' && value <= 15
      ? ' Entering at 15 stamina or less costs up to eight trust points.' : '';
    const emptyStamina = key === 'stamina' && value === 0
      ? ' It can still move, but cannot start cheering at zero stamina.' : '';
    return `${label} ${n(value)} / ${n(max)}. ${racing} ${detail}${lowStamina}${emptyStamina}`;
  }

  function terrainTip(turtle, key) {
    const stat = turtle.terrainStats?.[key], label = statNames[key];
    const generic = `Higher ${label} ability helps it keep speed on ${key} sections.`;
    if (!byte(stat?.value) || !byte(stat?.max)) return `${label} values are unavailable. ${generic}`;
    const { value, max } = stat;
    const grade = value < 85 ? 'Low' : value < 170 ? 'Medium' : 'High';
    const threshold = value < 85 ? 85 : value < 170 ? 170 : null;
    const next = threshold === null ? 'Already in the highest displayed grade.'
      : `${n(threshold-value)} ${threshold-value === 1 ? 'point' : 'points'} to ${grade === 'Low' ? 'Medium' : 'High'} (${threshold})${max < threshold ? '; its trained limit must rise first' : ''}.`;
    return `${label}: ${grade}, ${n(value)} / ${n(max)} trained limit. On ${key} sections, this contributes ${multiplier(.5 + .5 * value / 255)}× to running pace, or ${percent(value / 255)} more than zero ${label} ability with the other factors unchanged. It does not help on the other surfaces and is not a win chance. ${next}`;
  }

  function growthTip(turtle, key) {
    const stat = ['water', 'sand', 'mud'].includes(key) ? turtle.terrainStats?.[key] : turtle[key];
    const ceiling = turtle.growth?.ceilings?.[key], label = statNames[key];
    if (!byte(stat?.max) || !byte(ceiling)) return `${label} growth room is unavailable. It compares the trained limit with this turtle’s own ceiling.`;
    const room = ceiling-stat.max;
    if (room < 0) return `${label} limit ${n(stat.max)} is ${n(-room)} above its ceiling of ${n(ceiling)}. Feeding for this stat can lower the trained limit toward that ceiling.`;
    if (room === 0) return `${label} limit ${n(stat.max)} has reached its ceiling. Food cannot raise that limit further${byte(stat.value) && stat.value < stat.max ? ', but the current stat still has room to refill' : ''}.`;
    return `${label} limit ${n(stat.max)} can still gain ${n(room)} ${room === 1 ? 'point' : 'points'} before its ceiling of ${n(ceiling)}. This is room to raise the trained limit, not a promised gain from one meal.`;
  }

  function turtleCardTips(turtle) {
    const trust = byte(turtle.affinity) ? turtle.affinity : null;
    const rank = turtle.rank ?? 'Unknown rank';
    const wins = Array.isArray(turtle.rankRaceWins) ? turtle.rankRaceWins.length : null;
    const rankTip = turtle.rankId >= 0 && turtle.rankId < 4 && wins !== null
      ? `${rank}: ${Math.min(wins,3)} of 3 promotion stars. Stars count different events won at this rank, not repeat wins in the same event.`
      : turtle.rankId === 4 ? `Yokozuna is the highest normal rank; it has no three-star promotion. ${wins === null ? 'Event-win history is unavailable.' : `${wins} different Yokozuna ${wins === 1 ? 'event' : 'events'} won.`}`
        : turtle.rankId === 5 ? `Musabetsu is the open-rank category, with no further three-star promotion. ${wins === null ? 'Event-win history is unavailable.' : `${wins} different ${wins === 1 ? 'event' : 'events'} won here.`}`
          : 'Rank could not be read. Rank is the race class; ordinary promotion stars count distinct event wins.';
    const score = turtle.formScore;
    const form = !known(score) ? 'The current Form score is unavailable. Better Form helps speed and reduces mishaps.'
      : `Form score ${n(score)}: ${score < 40 ? 'Terrible (below 40)' : score < 50 ? 'Bad (40–49)' : score < 60 ? 'Okay (50–59)' : score < 80 ? 'Good (60–79)' : 'Excellent (80 and above)'}. Its current Form contributes ${multiplier(.75 + score / 200)}× to running pace; 50 Form is the 1× baseline. Higher Form also reduces mishaps. These are pace factors, not winning odds. Feeding cycles Form; it can improve or worsen.`;
    const growth = turtle.growth ?? {};
    const factor = known(growth.factor) ? growth.factor : null;
    const factorDifference = factor === null ? '' : factor === 1 ? 'the same as the 1× base'
      : `${n(Math.abs(factor-1)*100)}% ${factor > 1 ? 'above' : 'below'} the 1× base`;
    const life = turtle.lifespan;
    const lifespan = life?.eternal ? 'This turtle does not age. Feeding and racing do not consume a normal lifespan.'
      : known(life?.remaining) && known(life?.initial) && life.initial > 0 && life.remaining >= 0 && life.remaining <= life.initial
        ? `${n(life.remaining)} of ${n(life.initial)} life units remain (${n(life.remaining/life.initial*100)}%). ${life.remaining === 0 ? 'Its recorded lifespan has run out. ' : ''}Feeding uses one unit; entering a race uses two. These are life units, not real-time minutes.`
        : 'Remaining lifespan is unavailable. For ordinary turtles, feeding uses one life unit and entering a race uses two.';
    const streaks = known(turtle.winStreak) && known(turtle.lossStreak)
      ? turtle.winStreak === 0 && turtle.lossStreak === 0 ? 'No current win or loss streak. A win ends a loss streak; a loss ends a win streak.'
        : turtle.winStreak > 0 && turtle.lossStreak === 0 ? `Currently on a ${turtle.winStreak}-win streak: consecutive first-place finishes. Losing ends this streak.`
          : turtle.lossStreak > 0 && turtle.winStreak === 0 ? `Currently on a ${turtle.lossStreak}-loss streak: consecutive races without a win. Winning ends this streak.`
            : `${turtle.winStreak} consecutive wins and ${turtle.lossStreak} consecutive losses recorded. A win ends a loss streak; a loss ends a win streak.`
      : 'Current streaks are unavailable. They count consecutive wins or losses.';
    return {
      trust: trust === null ? 'Trust is unavailable. More trust helps reduce racing mishaps.'
        : `Trust ${trust} / 255. ${trust === 0 ? 'There is no trust-based reduction in racing mishaps yet.' : `At this value, the trust part of a mishap check is ${percent(1 - (1.3 - .6 * trust / 255) / 1.3)} lower than at zero trust, with other inputs unchanged.`} This is not the turtle’s overall mishap probability; Form, Fullness and personality still matter. ${trust === 255 ? 'At full trust.' : `${255-trust} more ${255-trust === 1 ? 'point' : 'points'} to full trust.`}${byte(turtle.stamina?.value) && turtle.stamina.value <= 15 ? ' Entering at 15 stamina or less costs up to eight trust points before racing.' : ''} The hearts show trust.`,
      feedBonus: typeof turtle.recentRaceFeedBonus !== 'boolean' ? 'The post-race feeding bonus status is unavailable.'
        : `Post-race bonus ${turtle.recentRaceFeedBonus ? 'active' : 'inactive'} when you saved. ${turtle.recentRaceFeedBonus ? trust === null ? 'A qualifying feed can add up to 16 trust.' : trust === 255 ? 'Trust is full, so it cannot add trust now.' : `A qualifying feed can add up to ${Math.min(16,255-trust)} trust at your current trust value.` : 'No extra trust from this bonus is recorded.'} Total stat/growth changes must be nonnegative; the initial meal Fullness is left out.`,
      rank: rankTip, form,
      personality: turtle.personality && personalityNotes[turtle.personality]
        ? `${turtle.personality}: ${personalityNotes[turtle.personality]}`
        : 'Personality could not be read. It affects racing mishaps and responses to cheering.',
      stamina: statTip(turtle, 'stamina'), legPower: statTip(turtle, 'legPower'), fullness: statTip(turtle, 'fullness'),
      water: terrainTip(turtle, 'water'), sand: terrainTip(turtle, 'sand'), mud: terrainTip(turtle, 'mud'),
      rating: !byte(turtle.savedRating) || turtle.savedRating > 100 ? 'The Turtle Master’s saved rating is unavailable.'
        : turtle.savedRating === 0 ? 'Unevaluated: no Turtle Master appraisal is recorded. This does not mean the turtle has a rating of zero.'
          : `The Turtle Master last rated this turtle ${turtle.savedRating} / 100. This is his saved appraisal, not a continuously updated score or a win chance. It does not account for this race’s terrain, current Form or opponents.`,
      record: known(turtle.wins) && known(turtle.races) ? `${n(turtle.wins)} first-place ${turtle.wins === 1 ? 'finish' : 'finishes'} from ${n(turtle.races)} race ${turtle.races === 1 ? 'entry' : 'entries'}. This is its saved race record, not a forecast of its next result.` : 'Race record is unavailable. It counts wins and total races entered.',
      streaks,
      growthPattern: growth.pattern && patternNotes[growth.pattern] ? `${growth.pattern}: ${life?.eternal ? 'This turtle does not age, so it does not progress through the pattern’s age stages.' : patternNotes[growth.pattern]}${factor === null ? '' : ` Its current age multiplier is ${multiplier(factor)}×.`}` : 'Growth pattern is unavailable. It describes when food growth is most effective during this turtle’s life.',
      growthFactor: factor === null ? 'The food growth factor is unavailable; no multiplier can be inferred.'
        : `Current age multiplier: ${multiplier(factor)}×, ${factorDifference}. It scales positive and negative stat/growth changes before trust, rounding and limits. Initial meal Fullness is not scaled.`,
      growthOutlook: growth.outlook && outlookNotes[growth.outlook] ? `${growth.outlook}: ${life?.eternal ? 'This is its native growth hint, but Eternal turtles do not age; it does not predict future improvement.' : `${outlookNotes[growth.outlook]} This is the calculated food-growth hint, not a race prediction.`}` : 'The growth outlook is unavailable. It is a hint about how food growth may change with age.',
      growth: Object.fromEntries(Object.keys(statNames).map(key => [key, growthTip(turtle,key)])),
      lifespan,
    };
  }
  if (typeof module === 'object' && module.exports) module.exports = { turtleCardTips };
  else window.kenzanTurtleCardTips = turtleCardTips;
})();

(() => {
  const fileSize = 0x13750;
  const systemSize = 0x33c;
  const header = [0x4c013750, fileSize, 0x80, 0x190, 0x4690, 0x47f0, 0x4814, 0x70d8,
    0x70f8, 0x7138, 0x7258, 0x72d8, 0x73d8, 0x7be8, 0x8aa4, 0x8ba8, 0x9840];
  // Cumulative experience required for levels 1–50, from the game's level table.
  const levelThresholds = [
    0, 1000, 2500, 4000, 5500, 7000, 8500, 10000, 11500, 13000,
    15000, 17000, 19000, 21300, 23800, 26800, 30300, 34300, 39300, 45300,
    52300, 61300, 71300, 83300, 98300, 115300, 134300, 155300, 178300, 203300,
    229300, 256300, 284300, 313300, 343300, 373300, 403300, 433300, 463300, 493300,
    523300, 553300, 583300, 613300, 643300, 673300, 703300, 738300, 778300, 826300,
  ];
  // Native record order, with the guide quest ID and the scenario's final-letter flag.
  const yujoRecords = [
    ['suzukaze', 2, 37], ['momochika', 3, 33], ['kinuyo', 1, 34], ['hinagiku', 4, 33],
    ['hanamaru', 5, 29], ['shirayuki', 6, 35], ['asagiri', 7, 36],
  ];
  // MINIGAMECOMMON in scenario_state.bin, in native bit order.
  const minigameIds = ['turtle-racing', 'shogi', 'mahjong', 'koi-koi', 'cho-han', 'cee-lo',
    'tokkuri', 'konpira', 'karuta', 'tosenkyo', 'yabusame', 'melon', 'waterfall', 'scarecrow', 'jiraiya', 'kabuki'];
  const minigameScoreGoals = [
    ['mahjong-50000', 0x9260, 50000],
    ['koi-koi-3', 0x9364, 20], ['koi-koi-6', 0x9368, 25], ['koi-koi-9', 0x936c, 35], ['koi-koi-12', 0x9370, 40],
    ['cho-han-200000', 0x9358, 200000, true], ['cee-lo-200000', 0x9354, 200000, true],
    ['kabuki-1000', 0x710c, 10000000, true],
  ];
  const readMinigameScore = (data, offset, signed) => signed ? data.getInt32(offset) : data.getUint32(offset);
  const yabusameCourses = ['beginner', 'intermediate', 'advanced', 'expert'];
  const readTurtleRaceResults = typeof module === 'object' && module.exports
    ? require('./save-turtle-races.js').readTurtleRaceResults : window.readKenzanTurtleRaceResults;
  const readWaterfallRecords = typeof module === 'object' && module.exports
    ? require('./save-waterfall.js').readWaterfallRecords : window.readKenzanWaterfallRecords;
  const readTrainingRecords = typeof module === 'object' && module.exports
    ? require('./save-training-records.js').readTrainingRecords : window.readKenzanTrainingRecords;
  // Chapter and the three chapter flags tested by each native rescue actor, in KAME flag order.
  const turtleRescueWindows = [
    { chapter: 1, opens: 32, closes: 36, completes: 59 },
    { chapter: 2, opens: 2, closes: 5, completes: 14 },
    { chapter: 3, opens: 6, closes: 8, completes: 23 },
    { chapter: 7, opens: 12, closes: 13, completes: 56 },
  ];

  function saveType(data, size) {
    if (size === systemSize && data.byteLength >= 4 && data.getUint32(0) === 0x0800033c) return 'system';
    if (size === fileSize && data.byteLength >= header.length * 4
      && header.every((word, index) => data.getUint32(index * 4) === word)) return 'gameplay';
    return undefined;
  }

  async function hasSaveHeader(file, expectedType) {
    if (file.size !== fileSize && file.size !== systemSize) return false;
    if (expectedType && file.size !== (expectedType === 'system' ? systemSize : fileSize)) return false;
    const prefix = await file.slice(0, file.size === systemSize ? 4 : header.length * 4).arrayBuffer();
    const type = saveType(new DataView(prefix), file.size);
    return Boolean(type && (!expectedType || type === expectedType));
  }

  function readSaveDetails(buffer, groups, storyWindows, weaponCatalogue, questMilestoneRegistry) {
    const data = new DataView(buffer);
    const type = saveType(data, data.byteLength);
    if (type === 'system') return { progress: readSystem(data) };
    if (type !== 'gameplay') {
      throw new Error('This file is not a supported Kenzan save. Choose USERDATA from your RPCS3 save slot.');
    }
    const readStory = typeof module === 'object' && module.exports ? require('./save-story.js').readStory : window.readKenzanSaveStory;
    const readTurtles = typeof module === 'object' && module.exports
      ? require('./save-turtle-bucket.js').readTurtles : window.readKenzanTurtles;
    const readWeapons = typeof module === 'object' && module.exports
      ? require('../weapons/save-weapons.js').readWeapons : window.readKenzanWeapons;
    const readCrafting = typeof module === 'object' && module.exports
      ? require('./save-crafting.js').readCrafting : window.kenzanCrafting?.readCrafting;
    const readQuestMilestones = typeof module === 'object' && module.exports
      ? require('./save-quest-milestones.js').readQuestMilestones : window.kenzanQuestMilestones?.readQuestMilestones;
    const story = storyWindows ? readStory(data, storyWindows) : undefined;
    const turtleProgress = readTurtleProgress(data, story);
    const turtleRaceResults = readTurtleRaceResults(data);
    const progress = readGameplay(data, groups, turtleRaceResults, turtleProgress.eternalLetterClaimed);
    const substories = new Set(progress.find(group => group.label === 'Substories')?.keys);
    return {
      yabusame: readYabusameScores(data),
      waterfall: readWaterfallRecords(data),
      trainingRecords: readTrainingRecords(data),
      progress, yujo: readYujo(data, substories), guidebook: readGuidebook(data, substories),
      story,
      minigames: readMinigameSummary(data, progress),
      playerLevel: readPlayerLevel(data),
      turtles: readTurtles(data),
      turtleProgress,
      turtleRaceResults,
      ...(questMilestoneRegistry ? { questMilestones: readQuestMilestones?.(data, questMilestoneRegistry, { existingProgress: progress }) } : {}),
      ...(weaponCatalogue ? { weapons: readWeapons?.(data, weaponCatalogue), crafting: readCrafting?.(data, weaponCatalogue) } : {}),
    };
  }

  function readSave(buffer, groups) {
    return readSaveDetails(buffer, groups).progress;
  }

  function readPlayerLevel(data) {
    const level = data.getUint8(0x480c);
    const totalXp = data.getUint32(0x4800);
    const threshold = levelThresholds[level - 1];
    if (threshold === undefined || totalXp > 999999) return undefined;
    const nextThreshold = levelThresholds[level];
    if (nextThreshold === undefined) return { level, totalXp };
    const needed = nextThreshold - threshold;
    const earned = Math.min(needed, Math.max(0, totalXp - threshold));
    return { level, totalXp, next: { earned, needed } };
  }

  function scenarioFlag(data, group, state) {
    return Boolean(data.getUint32(0x190 + group * 32 + (state >>> 5) * 4) & (1 << (state & 31)));
  }

  function yujoFlags(data, index) {
    return data.getUint32(0x927c + 24 * index);
  }

  function readYujo(data, completed) {
    return Object.fromEntries(yujoRecords.flatMap(([slug, quest, letterFlag], index) => {
      // The room UI reads quarter-hearts from the first two bytes of the native record.
      const offset = 0x9268 + index * 24;
      const hearts = data.getUint8(offset);
      const limit = data.getUint8(offset + 1);
      if (![40, 60, 80].includes(limit) || hearts > limit) return [];
      const flags = yujoFlags(data, index);
      const group = 0x76 + index;
      const flag = state => scenarioFlag(data, group, state);
      // Asagiri's scenario omits the date encounter with another Yūjo.
      const dateShift = slug === 'asagiri' ? 1 : 0;
      const questComplete = completed.has('kenzan-guide:done:' + quest);
      const letter = flag(letterFlag);
      return [[slug, {
        hearts: hearts / 4,
        limit: limit / 4,
        visitTier: flags & 8 ? 3 : flags & 4 ? 2 : flags & 2 ? 1 : 0,
        gamesStarted: Math.min(data.getUint8(offset + 2), 11),
        laterGameWon: Boolean(flags & 0x100),
        dateLetter: flag(16 - dateShift) || flag(17 - dateShift),
        steps: {
          visit: flag(1),
          'first-game': Boolean(flags & 0x80) || limit >= 60,
          'date-talk': Boolean(flags & 0x2000),
          date: limit === 80,
          'later-talk': Boolean(flags & 0x4000),
          'final-talk': Boolean(flags & 0x8000),
          'quest-unlocked': flag(23 - dateShift) || questComplete,
          'quest-complete': questComplete,
          letter,
        },
      }]];
    }));
  }

  function readGuidebook(data, completed) {
    const state = index => scenarioFlag(data, 0x44, index);
    const waiting = state(8);
    const canCollect = waiting && state(16);
    const reports = Object.fromEntries(yujoRecords.map(([slug, quest, letterFlag], index) => {
      const paid = state(9 + index);
      const submitted = state(1 + index);
      const letter = scenarioFlag(data, 0x76 + index, letterFlag);
      const finishedQuest = completed.has('kenzan-guide:done:' + quest);
      const stage = paid ? 'done' : submitted ? (canCollect ? 'payment' : waiting ? 'waiting' : 'submitted')
        : letter ? (waiting ? 'queued' : 'ready') : finishedQuest ? 'letter' : 'quest';
      // SUB044 records the number of correct answers in seven saved scenario counters.
      const score = data.getUint16(0x44fe + 2 * index);
      return [slug, { stage, correct: (paid || (submitted && waiting)) && score <= 4 ? score : undefined }];
    }));
    return { reports, complete: state(33) };
  }

  function readSystem(data) {
    const keys = [];
    let index = 0;
    for (const [group, count] of [['melee', 10], ['duel', 5], ['challenge', 10], ['rebirth', 4], ['ultimate', 4]]) {
      for (let course = 1; course <= count; course++, index++) {
        const rank = data?.getUint8(0x39 + index * 8);
        // Ultimate Match's all-S check uses rank 4 for every course.
        if (!data || rank === 4) keys.push('kenzan-guide:side-done:ultimate-' + group + '-' + course);
      }
    }
    return [{ label: 'Ultimate Match S ranks', keys }];
  }

  function readMailFlags(data, mailId) {
    const count = Math.min(256, data.getUint32(0x7bd8));
    for (let index = 0; index < count; index++) {
      const offset = 0x73d8 + index * 8;
      if (data.getUint32(offset + 4) === mailId) return data.getUint32(offset);
    }
    return null;
  }

  function readTurtleProgress(data, story) {
    const flag = state => scenarioFlag(data, 0x145, state);
    const mailFlags = readMailFlags(data, 97);
    const currentChapter = story?.chapter;
    const storyEnded = story?.mode === 'clear' || story?.mode === 'adventure';
    const rescues = turtleRescueWindows.map(({ chapter, opens, closes, completes }, index) => {
      const chapterFlag = state => scenarioFlag(data, chapter + 7, state);
      const passed = storyEnded || currentChapter > chapter || chapterFlag(closes) || chapterFlag(completes);
      const upcoming = currentChapter < chapter || (currentChapter === chapter && !(chapterFlag(0) && chapterFlag(opens)));
      const rescueWindow = passed ? 'missed' : upcoming ? 'upcoming' : 'open';
      return { chapter, rescued: flag(index), collected: flag(8 + index), rescueWindow };
    });
    return {
      bucketUnlocked: flag(13),
      deathPending: flag(16),
      recordedDeaths: data.getUint16(0x4520),
      woodenTags: data.getUint32(0x70fc),
      eternalLetterReceived: mailFlags !== null,
      eternalLetterClaimed: Boolean(mailFlags & 0x10000000),
      rescues,
    };
  }

  function readGameplay(data, groups, turtleRaceResults = readTurtleRaceResults(), eternalTurtleClaimedByMail = false) {
    // The game stores 256 flags per group as eight big-endian words.
    const bit = (offset, state) => !data || Boolean(data.getUint32(offset + (state >>> 5) * 4) & (1 << (state & 31)));
    const byteBit = (offset, state) => !data || Boolean(data.getUint8(offset + (state >>> 3)) & (1 << (state & 7)));
    const flag = (group, state) => !data || scenarioFlag(data, group, state);
    // The yūjo completion letter and outdoor Eternal Turtle pickup have independent claim flags.
    const progress = groups.map(({ label, offset, byteBits, checks }) => ({ label, keys: [...new Set(checks
      .filter(([key, group, state, excluding]) => !data ||
        (key === 'kenzan-atlas:collected:eternal-turtle' && eternalTurtleClaimedByMail) || (offset === undefined
        ? flag(group, state) && (excluding === undefined || !flag(group, excluding))
        : (byteBits ? byteBit : bit)(offset, state)))
      .map(([key]) => key))] }));
    progress.push(...readMinigameRecords(data, turtleRaceResults));
    // Native Yujo Completion List order; its final event flag is independent of the substory display.
    progress.push({ label: 'Yujo final events', keys: yujoRecords
      .filter((_, index) => !data || yujoFlags(data, index) & 0x20000)
      .map(([slug]) => 'kenzan-guide:side-done:yujo-final-' + slug) });
    const fighters = [];
    for (let fighter = 0; fighter < 50; fighter++) {
      // The Completion menu sums the twelve tournament win counters for each fighter.
      let wins = 0;
      if (data) for (let bracket = 0; bracket < 12; bracket++) wins += data.getInt16(0x7d14 + 24 * fighter + 2 * bracket);
      if (!data || wins & 0xffff) fighters.push('kenzan-guide:coliseum-done:fighter-' + (fighter + 1));
    }
    progress.push({ label: 'Coliseum fighters defeated', keys: fighters });
    const tournaments = [];
    for (let index = 0; index < 12; index++) {
      // Third-round victory increments this counter; entering a tournament uses a different field.
      if (!data || data.getUint16(0x7c30 + 2 * index)) {
        tournaments.push('kenzan-guide:coliseum-done:tournament-' + String.fromCharCode(65 + index));
      }
    }
    progress.push({ label: 'Coliseum tournaments won', keys: tournaments });
    const adventure = flag(1, 13);
    const collected = [];
    const opened = [];
    for (let index = 0; index < 50; index++) {
      // The English patch letters the locker columns in reverse native order.
      const code = String.fromCharCode(74 - Math.floor(index / 5)) + '-' + (index % 5 + 1);
      if (flag(0xc0, index + 1)) {
        const suffix = index === 0 ? (adventure ? '-tour' : '-story') : '';
        collected.push('kenzan-atlas:collected:locker-key:' + code + suffix);
      }
      // The coin locker menu uses a separate MSB-first bitset for opened lockers.
      if (!data || data.getUint8(0x8b24 + (index >>> 3)) & (0x80 >>> (index & 7))) {
        opened.push('kenzan-guide:side-done:locker-opened-' + code);
      }
    }
    return [...progress, { label: 'Locker keys collected', keys: collected }, { label: 'Lockers opened', keys: opened }];
  }

  function readMinigameRecords(data, turtleRaceResults) {
    // These are the saved scores and packed course ranks read by Kenzan's Completion menu.
    const scores = minigameScoreGoals.filter(([, offset, threshold, signed]) =>
      !data || readMinigameScore(data, offset, signed) >= threshold)
      .map(([key]) => 'kenzan-guide:side-done:minigame-' + key);
    const jiraiyaCourses = ['first-chamber', 'earth-chamber', 'water-chamber', 'fire-chamber', 'wind-chamber', 'heavenly-chamber', 'ultimate-chamber'];
    const jiraiya = data?.getUint32(0x9744);
    const courses = [
      ['yabusame', yabusameCourses, data?.getUint16(0x8baa), 0, [5, 6, 7]],
      ['waterfall', ['red-spirit', 'white-spirit', 'black-spirit', 'blue-spirit', 'yellow-spirit'], data?.getUint16(0x9328), 0, [4]],
      ['melon', ['foundational', 'applied', 'advanced', 'boar-scroll', 'snake-scroll', 'asura-scroll'], data?.getUint32(0x9334), 0, [5, 6]],
      ['jiraiya', jiraiyaCourses, jiraiya, 8, [4]],
    ];
    const mastery = courses.flatMap(([group, entries, packed, shift, ranks]) =>
      entries.flatMap((entry, index) => !data || ranks.includes((packed >>> (shift + 3 * index)) & 7)
        ? ['kenzan-guide:side-done:mastery-' + group + '-' + entry] : []));
    const jiraiyaClears = jiraiyaCourses.flatMap((entry, index) => !data || jiraiya & (1 << index)
      ? ['kenzan-guide:training-done:jiraiya-' + entry] : []);
    const races = turtleRaceResults.map(({ id }) => 'kenzan-guide:side-done:' + id);
    return [
      { label: 'Minigame score goals', keys: scores }, { label: 'Training mastery ranks', keys: mastery },
      { label: 'Jiraiya first clears', keys: jiraiyaClears }, { label: 'Turtle Racing wins', keys: races },
    ];
  }

  function readMinigameSummary(data, progress) {
    const keys = label => (progress.find(group => group.label === label)?.keys ?? [])
      .map(key => key.replace(/^kenzan-guide:side-done:/, ''));
    const count = (entries, prefix) => entries.filter(key => key.startsWith(prefix)).length;
    const shogi = keys('Shogi');
    const mastery = [...keys('Training mastery ranks'), ...keys('Training mastery')];
    const victories = keys('Parlor game wins');
    return {
      attempted: Object.fromEntries(minigameIds.map((id, index) => [id, scenarioFlag(data, 0x153, index)])),
      scores: Object.fromEntries(minigameScoreGoals.map(([id, offset, , signed]) => [id, readMinigameScore(data, offset, signed)])),
      turtleRacesWon: keys('Turtle Racing wins').length,
      shogiChallengesWon: count(shogi, 'shogi-challenge-'),
      shogiKing: shogi.includes('shogi-rank-21'),
      victories,
      mastered: Object.fromEntries(['yabusame', 'melon', 'waterfall', 'scarecrow', 'jiraiya']
        .map(id => [id, count(mastery, 'mastery-' + id + '-')])),
    };
  }

  function readYabusameScores(data) {
    // Four big-endian best scores follow the packed ranks in the Yabusame record.
    return Object.fromEntries(yabusameCourses.map((course, index) => [course, data.getUint16(0x8bac + 2 * index)]));
  }

  function supportedKeys(groups) {
    return new Set([
      ...readGameplay(null, groups).flatMap(({ keys }) => keys),
      ...readSystem(null).flatMap(({ keys }) => keys),
      'kenzan-atlas:collected:locker-key:J-1-story',
    ]);
  }

  if (typeof module === 'object' && module.exports) {
    module.exports = { readSave, readSaveDetails, supportedKeys, hasSaveHeader };
    return;
  }

  const collectiblePrefix = 'kenzan-atlas:collected:';
  const pickupAnswerPrefix = 'kenzan-guide:pickup-answer:';
  const lastSyncKey = 'kenzan-guide:last-save-sync';
  const syncTimeFormat = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'medium' });
  const xpFormat = new Intl.NumberFormat();
  let service;

  function pendingKeys(progress) {
    return [...new Set(progress.flatMap(({ keys }) => keys))].filter(key => window.kenzanStorage.getItem(key) !== '1');
  }

  function addCheckmarks(progress) {
    let added = 0;
    try {
      for (const key of pendingKeys(progress)) {
        window.kenzanStorage.setItem(key, '1');
        added++;
      }
      return added;
    } finally {
      if (added) window.dispatchEvent(new StorageEvent('storage', { key: null }));
    }
  }

  function createSaveSync(groups, storyWindows, weaponCatalogue, questMilestoneRegistry) {
    // Only the subscription references the guide. Unmounting it leaves auto-sync running.
    const stories = new Map();
    let lastSync = readLastSync();
    let folderConnection;
    // Personal weapon data stays in this tab. Disconnecting the watched folder
    // keeps its last dated snapshot available until another gameplay save is read.
    let weaponLatest;
    let render;

    function updateView() {
      if (render) render({ latest: [...stories.values()].at(-1), weaponLatest, lastSync, folderConnection });
    }

    function recordSync() {
      lastSync = new Date();
      try {
        window.kenzanStorage.setItem(lastSyncKey, lastSync.toISOString());
      } catch {
        // Keep the timestamp in memory if it can't be saved.
      }
      updateView();
    }

    function showStory(key, source, snapshot) {
      stories.delete(key);
      const observedAt = snapshot?.story || snapshot?.weapons || snapshot?.crafting || snapshot?.questMilestones ? new Date().toISOString() : undefined;
      if (snapshot?.weapons || snapshot?.crafting || snapshot?.questMilestones) weaponLatest = {
        weapons: snapshot.weapons, crafting: snapshot.crafting, questMilestones: snapshot.questMilestones, source, observedAt,
      };
      if (snapshot?.story) {
        const acquired = new Set(snapshot.progress.find(group => group.label === 'Weapons acquired')?.keys);
        stories.set(key, {
          story: snapshot.story, yujo: snapshot.yujo, guidebook: snapshot.guidebook, source, kind: key, observedAt, acquired,
          yabusame: snapshot.yabusame,
          waterfall: snapshot.waterfall,
          trainingRecords: snapshot.trainingRecords,
          minigames: snapshot.minigames,
          playerLevel: snapshot.playerLevel,
          turtles: snapshot.turtles,
          turtleProgress: snapshot.turtleProgress,
          turtleRaceResults: snapshot.turtleRaceResults,
          weapons: snapshot.weapons,
          crafting: snapshot.crafting,
          questMilestones: snapshot.questMilestones,
        });
        window.kenzanStoryFollow.observe(snapshot.story, key);
      } else if (!snapshot) {
        window.kenzanStoryFollow.unavailable(key);
      }
      updateView();
    }

    const parse = buffer => readSaveDetails(buffer, groups, storyWindows, weaponCatalogue, questMilestoneRegistry);
    const folder = window.initSaveFolderSync({ parse, hasSaveHeader, add: addCheckmarks,
      showStory: (source, snapshot) => showStory('folder', source, snapshot),
      showFolderConnection(connection) {
        if (folderConnection === connection) return;
        folderConnection = connection;
        if (connection === 'disconnected' || connection === 'unconnected') {
          window.kenzanStoryFollow.unavailable('folder', connection === 'disconnected' ? 'disconnected' : 'save');
        }
        updateView();
      },
      recordSync,
    });
    window.addEventListener('storage', ({ key }) => {
      if (key !== lastSyncKey) return;
      lastSync = readLastSync();
      updateView();
    });
    return { folder, parse, showStory, recordSync,
      subscribe(listener) {
        render = listener;
        updateView();
        return () => { if (render === listener) render = undefined; };
      },
    };
  }

  function yujoProgressView() {
    const empty = document.querySelector('[data-yujo-progress-empty]');
    const profiles = [...document.querySelectorAll('[data-yujo-progress]')].map(panel => ({
      panel,
      savedProgress: panel.querySelector('.yujo-saved-progress'),
      hearts: panel.querySelector('[data-yujo-hearts]'),
      icons: [...panel.querySelectorAll('[data-yujo-heart]')],
      details: panel.querySelector('[data-yujo-record]'),
      steps: [...panel.querySelectorAll('[data-yujo-step]')],
    }));
    let displayed;
    return snapshot => {
      if (displayed === snapshot) return;
      displayed = snapshot;
      const records = snapshot?.yujo;
      empty.hidden = Boolean(records && Object.keys(records).length);
      for (const { panel, savedProgress, hearts, icons, details, steps } of profiles) {
        const record = records?.[panel.dataset.yujoProgress];
        savedProgress.hidden = !record;
        if (!record) continue;
        hearts.textContent = `${record.hearts} / ${record.limit} hearts`;
        for (const [index, icon] of icons.entries()) {
          const fill = Math.min(Math.max(record.hearts - index, 0), 1);
          icon.style.setProperty('--heart-fill', fill * 100 + '%');
          icon.toggleAttribute('data-locked', index >= record.limit);
        }
        const games = record.gamesStarted === 11 ? '11+' : String(record.gamesStarted);
        details.textContent = [
          snapshot.source,
          [null, 'First visit', 'Second visit', 'Third visit or later'][record.visitTier],
          `${games} parlor ${games === '1' ? 'game' : 'games'} started`,
          record.dateLetter && !record.steps.date && 'Date invitation received',
          record.laterGameWon && 'Later parlor game won',
        ].filter(Boolean).join(' · ');
        const next = steps.find(step => !record.steps[step.dataset.yujoStep]);
        for (const step of steps) {
          const done = record.steps[step.dataset.yujoStep];
          step.dataset.status = done ? 'done' : step === next ? 'next' : 'pending';
          if (step === next) step.setAttribute('aria-current', 'step');
          else step.removeAttribute('aria-current');
          step.querySelector('[data-yujo-step-state]').textContent = done ? 'Done' : step === next ? 'Next' : 'Pending';
        }
      }
    };
  }

  function minigameProgressView() {
    const prompt = document.querySelector('[data-minigame-save-prompt]');
    const source = document.querySelector('[data-minigame-save-source]');
    const attempts = [...document.querySelectorAll('[data-minigame-attempt]')];
    const results = [...document.querySelectorAll('[data-minigame-result]')];
    const wins = [...document.querySelectorAll('[data-minigame-victory]')];
    let displayed;
    return snapshot => {
      const record = snapshot?.minigames;
      if (displayed === record) return;
      displayed = record;
      prompt.hidden = Boolean(record);
      source.hidden = !record;
      source.textContent = record ? 'Gameplay save · ' + snapshot.source : '';
      for (const cell of attempts) {
        cell.textContent = record ? record.attempted[cell.dataset.minigameAttempt] ? 'Attempted' : 'Not attempted' : '—';
      }
      const victories = new Set(record?.victories);
      for (const cell of wins) {
        cell.textContent = record ? victories.has(cell.dataset.minigameVictory) ? 'Victory' : 'No victory' : '—';
      }
      const entries = {};
      if (record) {
        const { scores, attempted, mastered } = record;
        const points = value => value.toLocaleString('en') + ' points';
        const earnings = scores['kabuki-1000'];
        const mon = Math.abs(earnings) % 10000;
        const payout = `${earnings < 0 ? '−' : ''}${Math.floor(Math.abs(earnings) / 10000).toLocaleString('en')} ryō`
          + (mon ? ` ${mon.toLocaleString('en')} mon` : '');
        Object.assign(entries, {
          'turtle-racing': `${record.turtleRacesWon} of 63 races won`,
          shogi: `${record.shogiChallengesWon} of 11 challenges won · ${record.shogiKing ? 'Shogi King' : 'Seio victory pending'}`,
          mahjong: attempted.mahjong ? points(scores['mahjong-50000']) : '—',
          'koi-koi': attempted['koi-koi'] ? [3, 6, 9, 12].map(rounds =>
            `${rounds} rounds · ${points(scores['koi-koi-' + rounds])}`).join(' / ') : '—',
          'cho-han': attempted['cho-han'] ? points(scores['cho-han-200000']) : '—',
          'cee-lo': attempted['cee-lo'] ? points(scores['cee-lo-200000']) : '—',
          kabuki: attempted.kabuki ? payout : '—',
        });
        for (const [game, total] of [['yabusame', 4], ['melon', 6], ['waterfall', 5], ['scarecrow', 12], ['jiraiya', 7]]) {
          entries[game] = `${mastered[game]} of ${total} mastery targets met`;
        }
        for (const game of ['tokkuri', 'konpira', 'karuta', 'tosenkyo']) {
          entries[game] = `${record.victories.filter(key => key.startsWith('minigame-' + game + '-')).length} of 4 opponents beaten`;
        }
      }
      for (const cell of results) cell.textContent = entries[cell.dataset.minigameResult] ?? '—';
    };
  }

  function mountTurtleStatTips(section, signal) {
    const tooltip = section.querySelector('[data-turtle-stat-callout]');
    document.body.append(tooltip);
    const options = { signal };
    let anchor;
    let pinned = false;
    let dismissTimer;
    const trigger = target => target.closest?.('[data-turtle-stat-tip]');
    const contains = (element, target) => target instanceof Node && element?.contains(target);
    const inside = target => contains(anchor, target) || contains(tooltip, target);

    function hide() {
      clearTimeout(dismissTimer);
      tooltip.hidden = true;
      anchor = undefined;
      pinned = false;
    }

    function position() {
      if (!anchor) return;
      const bounds = anchor.getBoundingClientRect();
      const viewportWidth = document.documentElement.clientWidth;
      const viewportHeight = window.innerHeight;
      if (!bounds.width || !bounds.height || bounds.right <= 0 || bounds.left >= viewportWidth
        || bounds.bottom <= 0 || bounds.top >= viewportHeight) {
        hide();
        return;
      }
      const width = tooltip.offsetWidth;
      const height = tooltip.offsetHeight;
      const left = bounds.left + (bounds.width - width) / 2;
      const above = bounds.top - height - 6;
      const top = above >= 8 ? above : bounds.bottom + 6;
      tooltip.style.left = Math.max(8, Math.min(left, viewportWidth - width - 8)) + 'px';
      tooltip.style.top = Math.max(8, Math.min(top, viewportHeight - height - 8)) + 'px';
    }

    function show(button, pin = false) {
      clearTimeout(dismissTimer);
      pinned = pin || (anchor === button && pinned);
      anchor = button;
      tooltip.textContent = button.dataset.turtleStatTip;
      tooltip.hidden = false;
      position();
    }

    section.addEventListener('pointerover', event => {
      if (event.pointerType === 'touch') return;
      const button = trigger(event.target);
      if (button && !contains(button, event.relatedTarget)) show(button);
      else if (inside(event.target)) clearTimeout(dismissTimer);
    }, options);
    function scheduleDismiss(event) {
      if (anchor && !pinned && inside(event.target) && !inside(event.relatedTarget) && !anchor.matches(':focus-visible')) {
        clearTimeout(dismissTimer);
        dismissTimer = setTimeout(hide, 220);
      }
    }
    section.addEventListener('pointerout', scheduleDismiss, options);
    tooltip.addEventListener('pointerenter', () => clearTimeout(dismissTimer), options);
    tooltip.addEventListener('pointerleave', scheduleDismiss, options);
    section.addEventListener('focusin', event => {
      const button = trigger(event.target);
      if (button?.matches(':focus-visible')) show(button);
    }, options);
    section.addEventListener('focusout', event => {
      if (event.target === anchor) hide();
    }, options);
    section.addEventListener('click', event => {
      const button = trigger(event.target);
      if (!button) return;
      if (button === anchor && pinned) hide();
      else show(button, true);
    }, options);
    document.addEventListener('pointerdown', event => {
      if (anchor && !inside(event.target)) hide();
    }, options);
    document.addEventListener('keydown', event => {
      if (event.key === 'Escape' && anchor) hide();
    }, options);
    window.addEventListener('scroll', position, { capture: true, signal });
    window.addEventListener('resize', position, options);
    signal.addEventListener('abort', () => {
      hide();
      tooltip.remove();
    }, { once: true });
    return hide;
  }

  function turtleRosterView(signal) {
    const section = document.querySelector('#my-turtles');
    const prompt = section.querySelector('[data-turtle-sync]');
    const status = section.querySelector('[data-turtle-status]');
    const roster = section.querySelector('[data-turtle-roster]');
    const template = section.querySelector('#turtle-card-template');
    const hideStatTip = mountTurtleStatTips(section, signal);
    // Race tables remove their rows while closed. Capture titles before they detach.
    const raceTitles = new Map([...document.querySelectorAll('#minigame-turtle-racing tr[id^="turtle-race-"] > th[scope="row"]')]
      .map(header => [header.parentElement.id, header.textContent.trim()]));
    const raceRanks = ['h', 'k', 's', 'o', 'y', 'm'];
    const terrainGrades = ['Low', 'Medium', 'High'];
    const lifePercent = new Intl.NumberFormat(undefined, { style: 'percent', maximumFractionDigits: 1 });
    let displayed;

    return snapshot => {
      if (displayed === snapshot) return;
      displayed = snapshot;
      hideStatTip();
      const turtles = snapshot?.turtles;
      prompt.hidden = Boolean(snapshot);
      roster.hidden = !turtles?.length;
      status.hidden = !snapshot || !roster.hidden;
      status.textContent = status.hidden ? '' : turtles ? 'You have no turtles in this save.'
        : 'The guide couldn’t read your turtles from this save.';
      roster.replaceChildren(...(turtles ?? []).map(turtle => {
        const card = template.content.firstElementChild.cloneNode(true);
        card.dataset.turtleSlot = turtle.slot;
        if (turtle.species) card.dataset.turtleSpeciesId = turtle.speciesId;
        const hearts = card.querySelector('[data-turtle-affinity]');
        const tips = window.kenzanTurtleCardTips(turtle);
        const setTip = (button, message) => { button.dataset.turtleStatTip = message; };
        const valueTip = (field, message) => setTip(card.querySelector(`[data-turtle-${field}]`)
          .closest('dd').previousElementSibling.querySelector('button'), message);
        setTip(hearts, tips.trust);
        setTip(card.querySelector('[data-turtle-feed-bonus]'), tips.feedBonus);
        for (const field of ['rank', 'form', 'personality', 'rating', 'record']) valueTip(field, tips[field]);
        for (const [field, key] of [['growth-pattern', 'growthPattern'], ['growth-rate', 'growthFactor'], ['growth-outlook', 'growthOutlook']]) valueTip(field, tips[key]);
        setTip(card.querySelector('[data-turtle-streaks]').previousElementSibling, tips.streaks);
        setTip(card.querySelector('[data-turtle-lifespan]').previousElementSibling, tips.lifespan);
        for (const row of card.querySelectorAll('[data-turtle-stat]')) setTip(row.querySelector('button'), tips[row.dataset.turtleStat]);
        for (const value of card.querySelectorAll('[data-turtle-growth-points]')) setTip(value.closest('dd').previousElementSibling.querySelector('button'), tips.growth[value.dataset.turtleGrowthPoints]);
        for (const button of card.querySelectorAll('[data-turtle-terrain-tip]')) {
          setTip(button, tips[button.dataset.turtleTerrainTip]);
        }
        card.querySelector('[data-turtle-feed-bonus]').hidden = !turtle.recentRaceFeedBonus;
        card.querySelector('[data-turtle-affinity-warning]').hidden = turtle.affinity !== 0;
        for (const [index, button] of [...card.querySelectorAll('[data-turtle-stat-tip]')].entries()) {
          const description = document.createElement('span');
          description.id = `turtle-stat-tip-${turtle.slot}-${index}`;
          description.hidden = true;
          description.textContent = button.dataset.turtleStatTip;
          button.setAttribute('aria-describedby', description.id);
          button.after(description);
        }
        const text = (field, value) => { card.querySelector('[data-turtle-' + field + ']').textContent = value ?? '—'; };
        text('name', turtle.name);
        text('species', turtle.species);
        text('location', turtle.inBucket ? 'In bucket' : 'Carried');
        text('form', turtle.form);
        text('personality', turtle.personality);
        text('rank', turtle.rank);
        text('rating', turtle.savedRating ? `${turtle.savedRating} / 100` : 'Unevaluated');
        text('calculated-rating', `${turtle.calculatedRating} / 100`);
        const { growth, lifespan } = turtle;
        text('growth-pattern', growth.pattern);
        text('growth-rate', growth.factor === undefined ? null : `${growth.factor}×`);
        text('growth-outlook', growth.outlook);
        for (const value of card.querySelectorAll('[data-turtle-growth-points]')) {
          value.textContent = '+' + growth.points[value.dataset.turtleGrowthPoints];
        }
        for (const value of card.querySelectorAll('[data-turtle-growth-ceiling]')) {
          value.textContent = growth.ceilings[value.dataset.turtleGrowthCeiling];
        }
        let lifeStage;
        let lifeUnits;
        if (lifespan?.eternal) {
          text('lifespan', 'Doesn’t age');
        } else if (lifespan) {
          const { remaining, initial } = lifespan;
          text('lifespan', `${lifePercent.format(remaining / initial)} remaining`);
          lifeUnits = `${remaining} / ${initial} life units`;
          if (remaining > 0) {
            lifeStage = remaining * 4 < initial ? 'Nearing the end of its life'
              : remaining * 4 > initial * 3 ? 'Young and lively' : 'Still full of energy';
          }
        } else {
          text('lifespan', null);
        }
        text('life-units', lifeUnits);
        card.querySelector('[data-turtle-life-units]').hidden = !lifeUnits;
        text('life-stage', lifeStage);
        card.querySelector('[data-turtle-life-stage]').hidden = !lifeStage;
        card.querySelector('[data-turtle-life-warning]').hidden = lifespan?.remaining !== 0;
        text('record', `${turtle.wins} wins / ${turtle.races} races`);
        text('streaks', `${turtle.winStreak}W · ${turtle.lossStreak}L`);
        const stars = card.querySelector('[data-turtle-rank-stars]');
        stars.hidden = turtle.rankStars === null;
        if (!stars.hidden) {
          stars.textContent = '★'.repeat(turtle.rankStars) + '☆'.repeat(3 - turtle.rankStars);
          stars.setAttribute('aria-label', `${turtle.rankStars} of 3 rank stars`);
        }
        const wins = turtle.rankRaceWins.map(index => {
          const id = 'turtle-race-' + raceRanks[turtle.rankId] + String(index).padStart(2, '0');
          return raceTitles.get(id);
        }).filter(Boolean);
        if (wins.length) {
          card.querySelector('[data-turtle-rank-races]').hidden = false;
          text('rank-win-count', `${wins.length} event ${wins.length === 1 ? 'win' : 'wins'}`);
          card.querySelector('[data-turtle-rank-win-list]').append(...wins.map(title => {
            const item = document.createElement('li');
            item.textContent = title;
            return item;
          }));
        }
        // The game rounds the remaining affinity up to one of four heart glyphs.
        const remainder = turtle.affinity % 51;
        const amount = Math.floor(turtle.affinity / 51) + (remainder ? (Math.floor(remainder / 13) + 1) / 4 : 0);
        hearts.setAttribute('aria-label', `Affinity ${amount} of 5 hearts`);
        [...hearts.children].forEach((icon, index) => {
          const fill = Math.min(1, Math.max(0, amount - index));
          icon.style.setProperty('--heart-fill', `${fill * 100}%`);
        });
        for (const row of card.querySelectorAll('[data-turtle-stat]')) {
          const { value, max } = turtle[row.dataset.turtleStat];
          const meter = row.querySelector('meter');
          meter.hidden = max === 0;
          meter.max = max || 1;
          meter.value = value;
          meter.style.inlineSize = `${max / 255 * 100}%`;
          row.querySelector('[data-turtle-stat-value]').textContent = `${value} / ${max}`;
        }
        for (const cell of card.querySelectorAll('[data-turtle-terrain]')) {
          cell.textContent = terrainGrades[turtle.terrain[cell.dataset.turtleTerrain]] ?? '—';
        }
        return card;
      }));
    };
  }

  function guidebookProgressView() {
    const empty = document.querySelector('[data-guidebook-no-save]');
    const panel = document.querySelector('[data-guidebook-saved]');
    const count = panel.querySelector('[data-guidebook-count]');
    const source = panel.querySelector('[data-guidebook-source]');
    const bar = panel.querySelector('progress');
    const milestones = [...panel.querySelectorAll('[data-guidebook-yujo]')];
    const labels = {
      quest: 'Finish her request', letter: 'Collect her final letter', ready: 'Ready to report', queued: 'Ready after payment',
      submitted: 'Interview recorded', waiting: 'Leave and return', payment: 'Collect payment', done: 'Payment collected',
    };
    let displayed;
    return snapshot => {
      if (displayed === snapshot) return;
      displayed = snapshot;
      const record = snapshot?.guidebook;
      empty.hidden = Boolean(record);
      panel.hidden = !record;
      if (!record) return;
      const paid = Object.values(record.reports).filter(({ stage }) => stage === 'done').length;
      bar.value = paid;
      bar.setAttribute('aria-valuetext', `${paid} of ${bar.max} reports paid`);
      const finish = record.complete ? ' · Substory complete' : paid === bar.max ? ' · Speak to the author to finish' : '';
      count.textContent = `${paid} of ${bar.max} reports paid${finish}`;
      source.textContent = '· ' + snapshot.source;
      for (const item of milestones) {
        const { stage, correct } = record.reports[item.dataset.guidebookYujo];
        item.dataset.status = stage === 'done' ? 'done' : ['ready', 'payment', 'waiting'].includes(stage) ? 'ready' : 'pending';
        item.querySelector('[data-guidebook-stage]').textContent = labels[stage];
        const score = item.querySelector('[data-guidebook-score]');
        score.hidden = correct === undefined;
        if (correct !== undefined) {
          const reward = correct === 4 ? '10,000' : correct >= 2 ? '5,000' : '500';
          score.textContent = `${correct}/4 correct · ${reward} mon`;
        }
      }
    };
  }

  function turtleProgressView(section) {
    const bucket = section.querySelector('[data-turtle-bucket-status]');
    const tags = section.querySelector('[data-turtle-tag-balance]');
    const replacements = section.querySelector('[data-turtle-replacements]');
    const deaths = replacements.querySelector('[data-turtle-death-count]');
    const deathLabel = replacements.querySelector('[data-turtle-death-label]');
    const pending = replacements.querySelector('[data-turtle-death-pending]');
    const rewardMail = section.querySelector('[data-turtle-reward-mail]');
    const milestones = [...replacements.querySelectorAll('[data-turtle-replacement]')];
    const numbers = new Intl.NumberFormat();
    let displayed;
    return snapshot => {
      const progress = snapshot?.turtleProgress;
      if (progress === displayed) return;
      displayed = progress;
      for (const element of [bucket, tags, replacements, rewardMail]) element.hidden = !progress;
      if (!progress) return;
      const { bucketUnlocked, deathPending, recordedDeaths, woodenTags, eternalLetterReceived, eternalLetterClaimed, rescues } = progress;
      bucket.textContent = bucketUnlocked ? 'Bucket unlocked' : 'Bucket needed';
      bucket.dataset.ready = String(bucketUnlocked);
      tags.textContent = `${numbers.format(woodenTags)} wooden tags`;
      deaths.textContent = numbers.format(recordedDeaths);
      deathLabel.textContent = recordedDeaths === 1 ? 'recorded death' : 'recorded deaths';
      pending.hidden = !deathPending;
      rewardMail.textContent = eternalLetterReceived
        ? eternalLetterClaimed ? 'Yujo Complete letter received' : 'Yujo Complete letter received · Check your mail'
        : 'Yujo Complete letter pending';
      rewardMail.dataset.ready = String(eternalLetterReceived);
      const hasSpace = snapshot.turtles.length < 5;
      milestones.forEach((milestone, index) => {
        const { chapter, rescued, collected, rescueWindow } = rescues[index];
        const remaining = Math.max(0, index + 1 - recordedDeaths);
        const ready = rescued && bucketUnlocked && remaining === 0 && hasSpace;
        milestone.dataset.stage = collected ? 'collected' : ready ? 'available' : !rescued && rescueWindow === 'missed' ? 'missed' : 'waiting';
        milestone.querySelector('[data-turtle-replacement-status]').textContent = collected ? 'Collected'
          : !rescued ? ({ missed: 'Missed it', upcoming: `Upcoming · Chapter ${chapter}`, open: 'Rescue needed' })[rescueWindow]
          : !bucketUnlocked ? 'Bucket needed'
          : remaining === 1 && deathPending ? 'Record the pending death'
          : remaining ? `${remaining} more ${remaining === 1 ? 'death' : 'deaths'}`
          : !hasSpace ? 'Free a turtle slot' : 'Ready at Tatsuya';
      });
    };
  }

  function mountSaveSync(signal, viewState, mountTurtleRacePlanner, updateWeaponSave) {
    const section = document.querySelector('#save-sync');
    const groups = JSON.parse(document.querySelector('#save-sync-data').textContent);
    const storyWindows = JSON.parse(document.querySelector('#save-story-data').textContent);
    const weaponData = document.querySelector('#weapon-save-data');
    const weaponCatalogue = weaponData ? JSON.parse(weaponData.textContent) : undefined;
    const questMilestoneData = document.querySelector('#quest-milestones-data');
    const questMilestoneRegistry = questMilestoneData ? JSON.parse(questMilestoneData.textContent) : undefined;
    const follower = window.kenzanStoryFollow;
    follower.configure(JSON.parse(document.querySelector('#story-data').textContent).checkpoints);
    service ??= createSaveSync(groups, storyWindows, weaponCatalogue, questMilestoneRegistry);
    const { parse, showStory, recordSync } = service;
    const checkpoints = JSON.parse(document.querySelector('#story-data').textContent).checkpoints;
    const objective = document.querySelector('#story-objective');
    const storyBadge = document.querySelector('#save-story-badge');
    const storyChapter = storyBadge.querySelector('#save-story-chapter');
    const storyActions = storyBadge.querySelector('.save-story-actions');
    const storyMeta = storyBadge.querySelector('.save-story-meta');
    const storyConnection = storyBadge.querySelector('#save-story-connection');
    const storySeparator = storyBadge.querySelector('.save-story-separator');
    const storyTime = storyBadge.querySelector('#save-story-time');
    const storyLastSync = storyBadge.querySelector('#save-story-last-sync');
    const lastSyncTime = storyLastSync.querySelector('time');
    const levelInfo = storyBadge.querySelector('#save-player-level');
    const levelNumber = levelInfo.querySelector('strong');
    const xpBar = levelInfo.querySelector('progress');
    const xpStatus = levelInfo.querySelector('#save-player-xp');
    const useStory = storyBadge.querySelector('#save-story-use');
    const followStatus = storyBadge.querySelector('#save-story-follow-status');
    const filterFollowStatus = document.querySelector('#story-follow-help');
    const reconnectStory = storyBadge.querySelector('#save-story-reconnect');
    const pickupReview = document.querySelector('#story-pickup-review');
    const pickupReviewError = pickupReview.querySelector('[data-review-error]');
    const pickupRows = [...pickupReview.querySelectorAll('[data-review-pickup]')];
    const pickupRowsById = new Map(pickupRows.map(row => [row.dataset.reviewPickup, row]));
    const pickupAnswers = pickupReview.querySelector('[data-review-answers]');
    const pickupAnswersSummary = pickupAnswers.querySelector('[data-review-answers-summary]');
    const pickupAnswerRows = new Map([...pickupAnswers.querySelectorAll('[data-review-answer]')]
      .map(row => [row.dataset.reviewAnswer, row]));
    const pickupReviewStatus = pickupReview.querySelector('[data-review-status]');
    const expandPickupReview = pickupReview.querySelector('[data-review-expand]');
    const session = viewState.saveSync ??= { reviewed: [], status: '' };
    const picker = section.querySelector('#save-sync-file');
    const choose = section.querySelector('#save-sync-choose');
    const apply = section.querySelector('#save-sync-apply');
    const status = section.querySelector('#save-sync-status');
    const preview = section.querySelector('#save-sync-preview');
    // Keep references when closed checklist tables detach their bodies.
    const yabusameScoreHelp = document.querySelector('[data-yabusame-score-help]');
    const yabusameScores = [...document.querySelectorAll('[data-yabusame-score]')];
    const updateWaterfall = window.mountKenzanWaterfallScores();
    const updateTrainingRecords = window.mountKenzanTrainingRecords();
    const updateYujo = yujoProgressView();
    const updateGuidebook = guidebookProgressView();
    const updateMinigames = minigameProgressView();
    const updateTurtles = turtleRosterView(signal);
    const turtleSection = document.querySelector('#minigame-turtle-racing');
    const updateTurtleProgress = turtleProgressView(turtleSection);
    const updateTurtleRaces = window.kenzanTurtleRaceView(turtleSection);
    const updateTurtleRacePlanner = mountTurtleRacePlanner(turtleSection, signal);
    let reviewed = session.reviewed;
    let readId = 0;
    let latestStory;
    let savedWindow;
    const options = { signal };

    function setStatus(message, keep = true) {
      session.status = keep ? message : '';
      status.textContent = message;
    }

    function refreshStoryAction() {
      const { enabled } = follower.state();
      useStory.hidden = !savedWindow && !enabled;
      useStory.disabled = false;
      const label = enabled ? 'Stop following' : 'Use & follow';
      if (useStory.textContent !== label) useStory.textContent = label;
      useStory.setAttribute('aria-label', enabled ? 'Stop automatically updating the story filter' : 'Use this checkpoint and follow save updates');
      useStory.title = enabled ? 'Keep this filter and stop automatic updates' : 'Use this checkpoint and follow each save read';
      if (enabled) {
        storyBadge.hidden = false;
        storyActions.hidden = false;
      }
    }

    function refreshStoryFollowing() {
      const { visible } = follower.state();
      const message = follower.message();
      for (const element of [followStatus, filterFollowStatus]) {
        if (element.hidden === visible) element.hidden = !visible;
        if (element.textContent !== message) element.textContent = message;
      }
      refreshStoryAction();
    }

    objective.addEventListener('change', refreshStoryAction, options);
    useStory.addEventListener('click', () => {
      if (follower.state().enabled) follower.pause();
      else if (savedWindow) follower.enable(savedWindow, latestStory?.kind ?? 'manual');
      if (useStory.hidden) document.querySelector('#completion-title').focus({ preventScroll: true });
    }, options);

    function updateLevel(playerLevel) {
      levelInfo.hidden = !playerLevel;
      if (!playerLevel) return;
      const { level, totalXp, next } = playerLevel;
      const levelLabel = 'Level ' + level;
      const xpLabel = next ? `${xpFormat.format(next.earned)} / ${xpFormat.format(next.needed)} XP` : 'Max level';
      const barLabel = next ? 'Experience toward level ' + (level + 1) : 'Maximum level reached';
      if (levelNumber.textContent !== levelLabel) levelNumber.textContent = levelLabel;
      if (xpStatus.textContent !== xpLabel) xpStatus.textContent = xpLabel;
      xpBar.max = next?.needed ?? 1;
      xpBar.value = next?.earned ?? 1;
      xpBar.setAttribute('aria-label', barLabel);
      levelInfo.title = `${xpFormat.format(totalXp)} total XP`;
    }

    function updateStoryBadge({ latest: sourceStory, lastSync, folderConnection }) {
      const disconnected = folderConnection === 'disconnected';
      const notConnected = folderConnection === 'unconnected';
      const latest = disconnected && sourceStory?.kind !== 'manual' ? undefined : sourceStory;
      updateLevel(latest?.playerLevel);
      const option = latest?.story.window && [...objective.options].find(({ value }) => value === latest.story.window);
      savedWindow = option?.value;
      refreshStoryAction();
      const showFolderAction = disconnected || notConnected;
      const showChapter = Boolean(latest) || showFolderAction;
      storyBadge.hidden = !showChapter && !lastSync && !follower.state().enabled;
      storyChapter.hidden = !showChapter;
      storyActions.hidden = !latest && !showFolderAction && !follower.state().enabled;
      storyMeta.hidden = !latest;
      storyConnection.hidden = !latest || !notConnected;
      storySeparator.hidden = !showChapter || !lastSync;
      storyLastSync.hidden = !lastSync;
      if (lastSync && lastSyncTime.dateTime !== lastSync.toISOString()) {
        lastSyncTime.dateTime = lastSync.toISOString();
        lastSyncTime.textContent = syncTimeFormat.format(lastSync);
      }
      reconnectStory.hidden = !showFolderAction;
      const reconnectLabel = disconnected ? 'Reconnect' : 'Connect';
      if (reconnectStory.textContent !== reconnectLabel) {
        reconnectStory.textContent = reconnectLabel;
        reconnectStory.setAttribute('aria-label', reconnectLabel + ' save folder');
      }
      if (!latest) {
        const label = disconnected ? 'Disconnected' : notConnected ? 'Not connected' : '';
        if (storyChapter.textContent !== label) storyChapter.textContent = label;
        storyChapter.removeAttribute('title');
        return;
      }
      const { story, source } = latest;
      const { mode, chapter, window, playSeconds } = story;
      const code = chapter >= 5 ? checkpoints[window]?.code : undefined;
      const label = mode === 'adventure' ? 'Kyoto Adventure'
        : mode === 'clear' ? 'Clear data'
        : mode === 'unknown' ? 'Unknown chapter'
        : chapter === 0 ? 'Prologue' : 'Chapter ' + (code ?? chapter);
      const time = [Math.floor(playSeconds / 3600), Math.floor(playSeconds / 60) % 60, playSeconds % 60]
        .map((part, i) => i ? String(part).padStart(2, '0') : part).join(':');
      if (storyChapter.textContent !== label) storyChapter.textContent = label;
      if (storyTime.textContent !== time) storyTime.textContent = time;
      storyChapter.title = [source, option?.textContent.trim()].filter(Boolean).join(' · ');
    }

    function refreshPickupReviews() {
      const latest = latestStory;
      const scenes = latest?.story.pickupReviewScenes ?? [];
      const pending = [];
      let answeredCount = 0;
      for (const row of pickupRows) {
        const { reviewPickup, reviewScene, reviewAcquiredKey } = row.dataset;
        const collected = isCollected(reviewPickup);
        const notCollected = hasNotCollectedAnswer(reviewPickup);
        if (collected && notCollected) {
          // A later map/checklist confirmation supersedes the earlier answer.
          // Failure to tidy the optional answer never undoes a collected checkmark.
          try { window.kenzanStorage.removeItem(pickupAnswerPrefix + reviewPickup); } catch { /* Positive progress still wins. */ }
        }
        const answerRow = pickupAnswerRows.get(reviewPickup);
        answerRow.hidden = collected || !notCollected;
        if (!answerRow.hidden) answeredCount++;
        row.hidden = !scenes.includes(reviewScene) || collected || notCollected;
        if (row.hidden) continue;
        pending.push(row);
        const evidence = row.querySelector('[data-review-evidence]');
        const text = reviewAcquiredKey ? latest.acquired.has(reviewAcquiredKey)
          ? 'The save records this item as acquired, but not where you got it.'
          : 'This save has no acquisition record for this item.'
          : 'The save has no location-specific collection record for this pickup.';
        if (evidence.textContent !== text) evidence.textContent = text;
      }
      const shown = session.showAllPickupReviews ? pending.length : Math.min(5, pending.length);
      pending.forEach((row, index) => { row.hidden = index >= shown; });
      pickupAnswers.hidden = !answeredCount;
      pickupAnswersSummary.textContent = `Saved not-collected answers (${answeredCount})`;
      pickupReview.hidden = !pending.length && !answeredCount;
      const text = (pending.length ? `${pending.length} ${pending.length === 1 ? 'pickup' : 'pickups'} to confirm.`
        : 'No pickups waiting for confirmation.') +
        (shown < pending.length ? ` Showing the first ${shown}, oldest story segment first.` : '');
      if (pickupReviewStatus.textContent !== text) pickupReviewStatus.textContent = text;
      expandPickupReview.hidden = pending.length <= 5;
      expandPickupReview.textContent = session.showAllPickupReviews ? 'Show fewer' : `Show all ${pending.length}`;
      expandPickupReview.setAttribute('aria-expanded', String(Boolean(session.showAllPickupReviews)));
    }

    function isCollected(id) {
      try {
        return window.kenzanStorage.getItem(collectiblePrefix + id) === '1';
      } catch {
        return false;
      }
    }

    function hasNotCollectedAnswer(id) {
      try { return window.kenzanStorage.getItem(pickupAnswerPrefix + id) === 'not-collected'; }
      catch { return false; }
    }

    function notifyPickupAnswer(id) {
      window.dispatchEvent(new StorageEvent('storage', { key: pickupAnswerPrefix + id }));
    }

    function focusPickupReview(previousIndex = 0) {
      const visible = pickupRows.filter(item => !item.hidden);
      const next = visible[Math.min(previousIndex, visible.length - 1)];
      (next?.querySelector('[data-review-action="confirm"]') ??
        (!pickupAnswers.hidden ? pickupAnswersSummary : document.querySelector('#completion-title')))
        .focus({ preventScroll: true });
    }

    pickupReview.addEventListener('click', event => {
      const restore = event.target.closest('[data-review-restore]');
      if (restore) {
        const id = restore.dataset.reviewRestore;
        const row = pickupRowsById.get(id);
        if (!row || restore.closest('[data-review-answer]')?.hidden) return;
        pickupReviewError.hidden = true;
        try { window.kenzanStorage.removeItem(pickupAnswerPrefix + id); }
        catch { pickupReviewError.hidden = false; return; }
        const eligible = latestStory?.story.pickupReviewScenes?.includes(row.dataset.reviewScene);
        if (eligible && !isCollected(id)) session.showAllPickupReviews = true;
        notifyPickupAnswer(id);
        refreshPickupReviews();
        if (!row.hidden) row.querySelector('[data-review-action="confirm"]').focus({ preventScroll: true });
        else focusPickupReview();
        return;
      }
      if (event.target.closest('[data-review-expand]')) {
        session.showAllPickupReviews = !session.showAllPickupReviews;
        refreshPickupReviews();
        if (expandPickupReview.hidden) pickupReview.querySelector('[data-review-action="confirm"]')?.focus({ preventScroll: true });
        return;
      }
      const button = event.target.closest('[data-review-action]');
      const row = button?.closest('[data-review-pickup]');
      if (!row || row.hidden) return;
      pickupReviewError.hidden = true;
      const previousIndex = pickupRows.filter(item => !item.hidden).indexOf(row);
      const id = row.dataset.reviewPickup;
      if (button.dataset.reviewAction === 'confirm') {
        try {
          addCheckmarks([{ keys: [collectiblePrefix + id] }]);
        } catch {
          pickupReviewError.hidden = false;
          return;
        }
        try { window.kenzanStorage.removeItem(pickupAnswerPrefix + id); } catch { /* A collected checkmark takes precedence. */ }
      } else if (button.dataset.reviewAction === 'not-collected') {
        if (!isCollected(id)) {
          try { window.kenzanStorage.setItem(pickupAnswerPrefix + id, 'not-collected'); }
          catch { pickupReviewError.hidden = false; return; }
          notifyPickupAnswer(id);
        }
      } else return;
      refreshPickupReviews();
      focusPickupReview(previousIndex);
    }, options);

    window.addEventListener('storage', ({ key }) => {
      if (key === null || key?.startsWith(collectiblePrefix) || key?.startsWith(pickupAnswerPrefix)) refreshPickupReviews();
    }, options);
    document.addEventListener('change', event => {
      if (event.target.dataset.collectibleCollected) refreshPickupReviews();
    }, options);

    function renderPreview() {
      const pending = new Set(pendingKeys(reviewed));
      const shown = new Set();
      const rows = [];
      for (const { label, keys } of reviewed) {
        const unique = keys.filter(key => !shown.has(key));
        if (!unique.length) continue;
        for (const key of unique) shown.add(key);
        const item = document.createElement('li');
        item.textContent = `${label}: ${unique.length} done in the save · ${unique.filter(key => pending.has(key)).length} new`;
        rows.push(item);
      }
      preview.replaceChildren(...rows);
      preview.hidden = !rows.length;
      apply.disabled = !pending.size;
      setStatus(pending.size ? `${pending.size} new checkmarks ready to apply.`
        : shown.size ? 'All recognized progress in this save is already checked.' : 'No supported goals are marked complete in this save.', false);
    }

    choose.addEventListener('click', () => picker.click(), options);
    picker.addEventListener('change', async () => {
      const [file] = picker.files;
      picker.value = '';
      if (!file) return;
      const currentRead = ++readId;
      session.reviewed = reviewed = [];
      preview.hidden = true;
      apply.disabled = true;
      setStatus('Reading save…', false);
      try {
        if (!await hasSaveHeader(file)) {
          throw new Error('Choose a Kenzan USERDATA file from a gameplay slot or the system save.');
        }
        if (signal.aborted || currentRead !== readId) return;
        const buffer = await file.arrayBuffer();
        if (signal.aborted || currentRead !== readId) return;
        const parsed = parse(buffer);
        session.reviewed = reviewed = parsed.progress;
        if (parsed.story || parsed.weapons || parsed.crafting) showStory('manual', 'Imported save', parsed);
        renderPreview();
      } catch (error) {
        if (signal.aborted || currentRead !== readId) return;
        setStatus(error.name === 'SecurityError' ? 'Browser storage is unavailable. Open the guide in a browser that allows it to save progress.' : error.message);
      }
    }, options);

    apply.addEventListener('click', () => {
      apply.disabled = true;
      try {
        const added = addCheckmarks(reviewed);
        recordSync();
        renderPreview();
        if (added) setStatus(window.kenzanStorage.pendingCount
          ? `Added ${added} checkmarks in this tab. Use Retry saving before closing or reloading this page.`
          : `Added ${added} checkmarks. Existing progress was kept.`);
      } catch {
        setStatus('Could not finish applying checkmarks. You can retry without losing existing progress.');
        apply.disabled = false;
      }
    }, options);

    function listUnsupported() {
      const supported = supportedKeys(groups);
      const sources = [
        ['sideDone', 'data-side-done', 'kenzan-guide:side-done:'],
        ['trainingDone', 'data-training-done', 'kenzan-guide:training-done:'],
        ['coliseumDone', 'data-coliseum-done', 'kenzan-guide:coliseum-done:'],
        ['collectibleCollected', 'data-collectible-collected', 'kenzan-atlas:collected:'],
      ];
      const selector = sources.map(([, attribute]) => `#guide input[${attribute}]`).join(',');
      const manual = new Map();
      const counted = new Set();
      for (const check of document.querySelectorAll(selector)) {
        const [type, , prefix] = sources.find(([type]) => check.dataset[type] !== undefined);
        const key = prefix + check.dataset[type];
        if (supported.has(key) || counted.has(key)) continue;
        counted.add(key);
        const area = check.closest('#locker-keys') ?? check.closest('details[id], section[id]');
        if (!area) continue;
        const row = check.closest('tr');
        const title = area.querySelector(':scope > summary, :scope > h2, :scope > h3')?.textContent.trim().replace(/\s*\(\d+\)$/, '') || 'Other goals';
        const label = row?.querySelector('th')?.textContent.trim() || check.getAttribute('aria-label') || key;
        const location = type === 'collectibleCollected' && row?.dataset.checklistLocation;
        const qualifier = check.closest('[data-minigame-mastery]') ? ' — mastery rank'
          : check.closest('[data-minigame-first-clear]') ? ' — first clear' : '';
        if (row && !row.id) row.id = 'manual-' + type + '-' + check.dataset[type];
        if (!manual.has(area.id)) manual.set(area.id, { title, entries: [] });
        manual.get(area.id).entries.push({ target: row?.id || area.id, label: label + qualifier + (location ? ' — ' + location : '') });
      }
      section.querySelector('#save-sync-manual-count').textContent = `(${counted.size})`;
      const container = section.querySelector('#save-sync-manual-list');
      for (const { title, entries } of manual.values()) {
        const group = document.createElement('details');
        const summary = document.createElement('summary');
        summary.textContent = `${title} (${entries.length})`;
        const list = document.createElement('ul');
        for (const { target, label } of entries) {
          const item = document.createElement('li');
          const link = document.createElement('a');
          link.href = '#' + target;
          link.textContent = label;
          item.append(link);
          list.append(item);
        }
        group.append(summary, list);
        container.append(group);
      }
    }

    const unsubscribe = service.subscribe(state => {
      latestStory = state.latest;
      updateWeaponSave?.(state.weaponLatest, state.folderConnection);
      updateStoryBadge(state);
      const scores = state.latest?.yabusame;
      yabusameScoreHelp.hidden = Boolean(scores);
      for (const cell of yabusameScores) {
        const score = scores?.[cell.dataset.yabusameScore];
        cell.textContent = score ? score.toLocaleString() : '—';
      }
      updateWaterfall(state.latest);
      updateTrainingRecords(state.latest);
      // A manual import remains usable if the remembered folder needs reconnecting.
      updateYujo(state.latest);
      updateGuidebook(state.latest);
      updateMinigames(state.latest);
      updateTurtles(state.latest);
      updateTurtleProgress(state.latest);
      updateTurtleRaces(state.latest);
      updateTurtleRacePlanner(state.latest);
      refreshPickupReviews();
    });
    signal.addEventListener('abort', unsubscribe, { once: true });
    const unfollow = follower.subscribe(refreshStoryFollowing);
    signal.addEventListener('abort', unfollow, { once: true });
    window.mountKenzanSaveFolderView(service.folder, reconnectStory, signal);
    const previousStatus = session.status;
    if (reviewed.length) {
      try { renderPreview(); } catch { /* Keep the preview available for retry. */ }
    }
    if (previousStatus) setStatus(previousStatus);
    listUnsupported();
    section.hidden = false;
  }

  function readLastSync() {
    try {
      const time = new Date(window.kenzanStorage.getItem(lastSyncKey) ?? '');
      if (Number.isFinite(time.getTime())) return time;
    } catch {
      // The timestamp can still be shown in this tab when storage is unavailable.
    }
    return null;
  }

  window.mountKenzanSaveSync = mountSaveSync;
})();

