// Static host policy only. Atlas and its pinned renderer remain byte-for-byte unchanged.
// The ordinary inspector admits assets against one origin. This one-map host
// supplies the fixed public tile origin as that base, preserving every geometry,
// format, URL-authority and dimension guard in the original inspector.
(() => {
  const policy = AtlasRuntime.AtlasSceneNativeRasterMath;
  const original = policy.inspect;
  const tileBase = 'https://tiles.mapgenie.io/games/zelda-breath-of-the-wild/hyrule/default-v1/';
  const scoped = function (scene, options) {
    const area = scene?.tiles?.[0];
    const fixedHyrule = scene?.tiles?.length === 1 && area?.id === 'hyrule'
      && scene?.world?.width === 131072 && scene?.world?.height === 131072
      && area?.pyramid?.fallback === tileBase + '8/127/127.jpg';
    return original.call(this, scene, fixedHyrule ? { ...options, imageBase: tileBase } : options);
  };
  policy.inspect = scoped;
  window.AtlasHyruleStaticHost = Object.freeze({
    dispose() { if (policy.inspect === scoped) policy.inspect = original; },
    tileBase,
  });
})();
