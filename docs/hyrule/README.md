# Temporary Hyrule Atlas viewer

This frozen preview uses the verified November 24 Atlas runtime. Hyrule's
artwork and authored coordinates are unchanged. The map's full-quality tiles
come directly from MapGenie's public tile CDN; they are not bundled here.
Map facts and artwork retain their visible MapGenie/Nintendo attribution.

`cdn-host.js` is the only renderer-host adaptation. It uses Atlas's documented
mutable native-inspector facade to supply one fixed tile origin for this exact
Hyrule scene. All native validation remains in the original inspector. Other
scenes retain the default policy. `mount.js` owns mounting and page-exit cleanup.

GitHub Pages serves only `/docs`; the repository's older Kenzan snapshot outside
that folder is not part of this deployment. This is not a guide release or a
claim of performance parity. There is no local tile server or WebSocket, so
network timing differs from the local benchmark transport. Tile imagery,
coordinates, image sampling, memory limits and pinned renderer are unchanged.
