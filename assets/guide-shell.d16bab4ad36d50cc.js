
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

(() => {
  function readStory(data, windows) {
    // Chapter comes from the native scenario row. The guide's finer windows
    // are derived separately from verified selectors and story-event flags.
    const selector = data.getUint32(0x46ac);
    const resumeMode = data.getUint32(0x46a4);
    const common = data.getUint32(0x1b0);
    const chapter = windows.chapterRanges.find(([first, last]) => selector >= first && selector <= last)?.[2];
    const playSeconds = Math.floor(data.getUint32(0x80) / 60);
    const pickupScenes = Object.entries(windows.weaponPickupScenes ?? {});
    const flag = (group, state) =>
      Boolean(data.getUint32(0x190 + group * 32 + (state >>> 5) * 4) & (1 << (state & 31)));
    if (common & (1 << 13)) return { mode: 'adventure', playSeconds };
    if ((common & (1 << 3)) && (selector === 0x2ee || selector === 0x2ef)) {
      return { mode: 'clear', playSeconds, weaponPickupWindows: pickupScenes.map(([code]) => code) };
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
    const weaponPickupWindows = pickupScenes
      .filter(([code, scene]) => {
        const pickupChapter = Number(code.split('-')[0]);
        return chapter > pickupChapter || (chapter === pickupChapter &&
          (selector >= scene.selector || flag(scene.group, scene.flag)));
      }).map(([code]) => code);
    return { mode: 'story', chapter, window, playSeconds, weaponPickupWindows };
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
    const actions = [[choose, service.chooseFolder], [forget, service.forgetFolder], [now, service.syncNow]];
    for (const [button, action] of actions) {
      if (action) button.addEventListener('click', action, { signal });
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
        (button.hidden ? document.querySelector('#completion-title') : button).focus({ preventScroll: true });
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

  function readSaveDetails(buffer, groups, storyWindows) {
    const data = new DataView(buffer);
    const type = saveType(data, data.byteLength);
    if (type === 'system') return { progress: readSystem(data) };
    if (type !== 'gameplay') {
      throw new Error('This file is not a supported Kenzan save. Choose USERDATA from your RPCS3 save slot.');
    }
    const readStory = typeof module === 'object' && module.exports ? require('./save-story.js').readStory : window.readKenzanSaveStory;
    const readTurtles = typeof module === 'object' && module.exports
      ? require('./save-turtle-bucket.js').readTurtles : window.readKenzanTurtles;
    const story = storyWindows ? readStory(data, storyWindows) : undefined;
    const turtleProgress = readTurtleProgress(data, story);
    const turtleRaceResults = readTurtleRaceResults(data);
    const progress = readGameplay(data, groups, turtleRaceResults, turtleProgress.eternalLetterClaimed);
    const substories = new Set(progress.find(group => group.label === 'Substories')?.keys);
    return {
      yabusame: readYabusameScores(data),
      progress, yujo: readYujo(data, substories), guidebook: readGuidebook(data, substories),
      story,
      minigames: readMinigameSummary(data, progress),
      playerLevel: readPlayerLevel(data),
      turtles: readTurtles(data),
      turtleProgress,
      turtleRaceResults,
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
  const lastSyncKey = 'kenzan-guide:last-save-sync';
  const syncTimeFormat = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'medium' });
  const xpFormat = new Intl.NumberFormat();
  let service;

  function pendingKeys(progress) {
    return [...new Set(progress.flatMap(({ keys }) => keys))].filter(key => localStorage.getItem(key) !== '1');
  }

  function addCheckmarks(progress) {
    let added = 0;
    try {
      for (const key of pendingKeys(progress)) {
        localStorage.setItem(key, '1');
        added++;
      }
      return added;
    } finally {
      if (added) window.dispatchEvent(new StorageEvent('storage', { key: null }));
    }
  }

  function createSaveSync(groups, storyWindows) {
    // Only the subscription references the guide. Unmounting it leaves auto-sync running.
    const stories = new Map();
    let lastSync = readLastSync();
    let folderConnection;
    let render;

    function updateView() {
      if (render) render({ latest: [...stories.values()].at(-1), lastSync, folderConnection });
    }

    function recordSync() {
      lastSync = new Date();
      try {
        localStorage.setItem(lastSyncKey, lastSync.toISOString());
      } catch {
        // Keep the timestamp in memory if it can't be saved.
      }
      updateView();
    }

    function showStory(key, source, snapshot) {
      stories.delete(key);
      if (snapshot?.story) {
        const acquired = new Set(snapshot.progress.find(group => group.label === 'Weapons acquired')?.keys);
        stories.set(key, {
          story: snapshot.story, yujo: snapshot.yujo, guidebook: snapshot.guidebook, source, acquired,
          yabusame: snapshot.yabusame,
          minigames: snapshot.minigames,
          playerLevel: snapshot.playerLevel,
          turtles: snapshot.turtles,
          turtleProgress: snapshot.turtleProgress,
          turtleRaceResults: snapshot.turtleRaceResults,
        });
      }
      updateView();
    }

    const parse = buffer => readSaveDetails(buffer, groups, storyWindows);
    const folder = window.initSaveFolderSync({ parse, hasSaveHeader, add: addCheckmarks,
      showStory: (source, snapshot) => showStory('folder', source, snapshot),
      showFolderConnection(connection) {
        if (folderConnection === connection) return;
        folderConnection = connection;
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
        const formButton = card.querySelector('[data-turtle-form-tip]');
        hearts.dataset.turtleStatTip = `Trust ${turtle.affinity} / 255, shown as up to five hearts. ${hearts.dataset.turtleStatTip}`;
        if (turtle.formScore !== undefined) {
          formButton.dataset.turtleStatTip = `Form score ${turtle.formScore}. ${formButton.dataset.turtleStatTip}`;
        }
        for (const button of card.querySelectorAll('[data-turtle-terrain-tip]')) {
          const { value, max } = turtle.terrainStats[button.dataset.turtleTerrainTip];
          button.dataset.turtleStatTip = `Current ability ${value}, trained cap ${max}. ${button.dataset.turtleStatTip}`;
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

  function mountSaveSync(signal, viewState, mountTurtleRacePlanner) {
    const section = document.querySelector('#save-sync');
    const groups = JSON.parse(document.querySelector('#save-sync-data').textContent);
    const storyWindows = JSON.parse(document.querySelector('#save-story-data').textContent);
    service ??= createSaveSync(groups, storyWindows);
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
    const reconnectStory = storyBadge.querySelector('#save-story-reconnect');
    const weaponReview = document.querySelector('#story-weapon-review');
    const weaponReviewError = weaponReview.querySelector('[data-review-error]');
    const weaponRows = [...weaponReview.querySelectorAll('[data-review-pickup]')];
    const session = viewState.saveSync ??= { reviewed: [], dismissedWeaponReviews: new Set(), status: '' };
    const { dismissedWeaponReviews } = session;
    const picker = section.querySelector('#save-sync-file');
    const choose = section.querySelector('#save-sync-choose');
    const apply = section.querySelector('#save-sync-apply');
    const status = section.querySelector('#save-sync-status');
    const preview = section.querySelector('#save-sync-preview');
    // Keep references when closed checklist tables detach their bodies.
    const yabusameScoreHelp = document.querySelector('[data-yabusame-score-help]');
    const yabusameScores = [...document.querySelectorAll('[data-yabusame-score]')];
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
      useStory.hidden = !savedWindow;
      useStory.disabled = Boolean(savedWindow && objective.value === savedWindow);
      useStory.title = useStory.disabled ? 'Story window already selected' : 'Use this story window';
    }

    objective.addEventListener('change', refreshStoryAction, options);
    useStory.addEventListener('click', () => {
      if (!savedWindow) return;
      objective.value = savedWindow;
      objective.dispatchEvent(new Event('change'));
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
      const latest = disconnected ? undefined : sourceStory;
      updateLevel(latest?.playerLevel);
      const option = latest?.story.window && [...objective.options].find(({ value }) => value === latest.story.window);
      savedWindow = option?.value;
      refreshStoryAction();
      const showFolderAction = disconnected || notConnected;
      const showChapter = Boolean(latest) || showFolderAction;
      storyBadge.hidden = !showChapter && !lastSync;
      storyChapter.hidden = !showChapter;
      storyActions.hidden = !latest && !showFolderAction;
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

    function refreshWeaponReviews() {
      const latest = latestStory;
      const windows = latest?.story.weaponPickupWindows ?? [];
      for (const row of weaponRows) {
        const { reviewPickup, reviewWindow, reviewWeapon } = row.dataset;
        row.hidden = !windows.includes(reviewWindow) || dismissedWeaponReviews.has(reviewPickup) ||
          isCollected(reviewPickup);
        if (row.hidden) continue;
        row.querySelector('[data-review-evidence]').textContent = latest.acquired.has(reviewWeapon)
          ? 'The save records this weapon as acquired. Where you got it is uncertain.'
          : 'This save has no acquisition record for this weapon.';
      }
      weaponReview.hidden = weaponRows.every(row => row.hidden);
    }

    function isCollected(id) {
      try {
        return localStorage.getItem(collectiblePrefix + id) === '1';
      } catch {
        return false;
      }
    }

    weaponReview.addEventListener('click', event => {
      const button = event.target.closest('[data-review-action]');
      const row = button?.closest('[data-review-pickup]');
      if (!row || row.hidden) return;
      weaponReviewError.hidden = true;
      const id = row.dataset.reviewPickup;
      if (button.dataset.reviewAction === 'confirm') {
        try {
          addCheckmarks([{ keys: [collectiblePrefix + id] }]);
        } catch {
          weaponReviewError.hidden = false;
          return;
        }
      } else dismissedWeaponReviews.add(id);
      refreshWeaponReviews();
      const next = weaponRows.find(item => !item.hidden);
      (next?.querySelector('[data-review-action="confirm"]') ??
        document.querySelector('#completion-title')).focus({ preventScroll: true });
    }, options);

    window.addEventListener('storage', ({ key }) => {
      if (key === null || key.startsWith(collectiblePrefix)) refreshWeaponReviews();
    }, options);
    document.addEventListener('change', event => {
      if (event.target.dataset.collectibleCollected) refreshWeaponReviews();
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
        if (parsed.story) showStory('manual', 'Imported save', parsed);
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
        if (added) setStatus(`Added ${added} checkmarks. Existing progress was kept.`);
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
      updateStoryBadge(state);
      const scores = state.latest?.yabusame;
      yabusameScoreHelp.hidden = Boolean(scores);
      for (const cell of yabusameScores) {
        const score = scores?.[cell.dataset.yabusameScore];
        cell.textContent = score ? score.toLocaleString() : '—';
      }
      // A manual import remains usable if the remembered folder needs reconnecting.
      updateYujo(state.latest);
      updateGuidebook(state.latest);
      updateMinigames(state.latest);
      updateTurtles(state.latest);
      updateTurtleProgress(state.latest);
      updateTurtleRaces(state.latest);
      updateTurtleRacePlanner(state.latest);
      refreshWeaponReviews();
    });
    signal.addEventListener('abort', unsubscribe, { once: true });
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
      const time = new Date(localStorage.getItem(lastSyncKey) ?? '');
      if (Number.isFinite(time.getTime())) return time;
    } catch {
      // The timestamp can still be shown in this tab when storage is unavailable.
    }
    return null;
  }

  window.mountKenzanSaveSync = mountSaveSync;
})();

const kenzanViews = (() => {
  const hosts = { guide: document.querySelector('#guide-view'), map: document.querySelector('#quest-map') };
  const status = document.querySelector('#view-status');
  const files = kenzanViewAssets;
  const loads = new Map();
  const definitions = new Map();
  const filters = {};
  const states = { guide: { filters, sidebar: {} }, map: { filters, sidebar: {} } };
  let current;
  let sequence = 0;
  let mapLink;
  let atlasRuntime;

  const mapSharePrefix = '#quest-map?';
  const viewForHash = hash => hash === '#quest-map' || hash.startsWith(mapSharePrefix) ? 'map' : 'guide';

  function register(view, html, css, initialize) {
    definitions.set(view, { html, css, initialize });
  }

  function loadScript(source) {
    return new Promise((resolve, reject) => {
      const script = document.createElement('script');
      script.src = source;
      script.onload = () => { script.remove(); resolve(); };
      script.onerror = () => { script.remove(); reject(new Error('Could not load ' + source)); };
      document.head.append(script);
    });
  }

  function load(view) {
    if (loads.has(view)) return loads.get(view);
    const { script, runtime } = files[view];
    if (runtime && !atlasRuntime) {
      atlasRuntime = loadScript(runtime).catch(error => {
        atlasRuntime = undefined;
        throw error;
      });
    }
    const loading = Promise.allSettled([loadScript(script), runtime ? atlasRuntime : undefined]).then(results => {
      const failure = results.find(result => result.status === 'rejected');
      if (failure || !definitions.has(view)) {
        definitions.delete(view);
        throw failure?.reason ?? new Error('Could not initialize ' + script);
      }
    }).finally(() => loads.delete(view));
    loads.set(view, loading);
    return loading;
  }

  function unmount() {
    if (!current) return;
    const { view, lifetime, style } = current;
    lifetime.abort();
    hosts[view].hidden = true;
    hosts[view].replaceChildren();
    style.remove();
    current = undefined;
  }

  function mount(view) {
    const { html, css, initialize } = definitions.get(view);
    definitions.delete(view);
    const host = hosts[view];
    const style = document.createElement('style');
    style.dataset.viewStyle = view;
    style.textContent = css;
    document.head.append(style);
    host.innerHTML = html;
    const lifetime = new AbortController();
    current = { view, lifetime, style };
    // Lay out the guide after its initial filters and restored controls are in place.
    if (view === 'map') host.hidden = false;
    current.ui = initialize(lifetime.signal, states[view]);
    host.hidden = false;
  }

  async function open(initial = false) {
    const route = ++sequence;
    const hash = location.hash;
    const view = viewForHash(hash);
    const link = mapLink ?? (hash.startsWith(mapSharePrefix) ? { share: hash.slice(mapSharePrefix.length) } : undefined);
    mapLink = undefined;
    if (current?.view !== view && (loads.has(view) || !definitions.has(view))) {
      const loadingStatus = setTimeout(() => {
        if (route !== sequence || current) return;
        status.textContent = view === 'map' ? 'Loading interactive map…' : 'Loading side content guide…';
        status.hidden = false;
      }, 150);
      try {
        await load(view);
      } catch (error) {
        if (route !== sequence) return;
        status.textContent = error.message + '. Check the assets folder and reload the page.';
        status.hidden = false;
        return;
      } finally {
        clearTimeout(loadingStatus);
      }
    }
    if (route !== sequence || hash !== location.hash) {
      if (view !== viewForHash(location.hash)) definitions.delete(view);
      return;
    }
    status.hidden = true;
    const changed = current?.view !== view;
    if (changed) {
      if (current?.view === 'guide' && !link) current.ui.rememberScroll();
      unmount();
      mount(view);
    }
    if (view === 'map') {
      if (changed) window.scrollTo(0, 0);
      if (changed || link) current.ui.open(link);
    } else {
      const returning = !hash || hash === '#guide' || hash === states.guide.hash;
      current.ui.open({ reveal: !initial, restoreScroll: changed && returning ? states.guide.scroll : undefined });
      states.guide.hash = hash;
    }
  }

  function start() {
    document.addEventListener('click', event => {
      const anchor = event.target.closest('a[href="#quest-map"]');
      if (!anchor || event.defaultPrevented || event.ctrlKey || event.metaKey || event.shiftKey || event.altKey) return;
      if (current?.view === 'guide') current.ui.rememberScroll();
      mapLink = { ...anchor.dataset };
      if (location.hash === '#quest-map') open();
    });
    history.scrollRestoration = 'manual';
    window.addEventListener('hashchange', () => open());
    open(true);
  }

  return { register, start };
})();

kenzanViews.start();