// Open the one-map preview immediately; retain existing object/share fragments.
if (!location.hash) history.replaceState(history.state, '', location.pathname + location.search + '#map=hyrule');
window.__atlasBenchmark = mountAtlasProject(document.querySelector('[data-atlas-project]'), { urlNavigation: true });
window.addEventListener('pagehide', event => {
  if (event.persisted) return; // Back/forward cache retains its mounted lifetime.
  window.__atlasBenchmark.destroy();
  window.AtlasHyruleStaticHost.dispose();
}, { once: false });
