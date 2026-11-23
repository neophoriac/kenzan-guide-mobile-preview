(function registerTurtleRaceWorker() {
  function startTurtleRaceWorker() {
const turtleRaceScenes = (() => {
  const modules = [(module, load) => {
'use strict';

// These opening snapshots retain only model, camera, speech and clock data.
// Each trial generates a new roster instead of using captured race records.
// They sample representative shared-arena starts. Reusing those starts on
// another course or with another roster is a simulation assumption, and the
// active race seed is sampled independently of each opening's original RNG.
const openings = load(1);
const rootCurves = load(2);
const { generateRivalLineup, surfaces } = load(3);
const { simulateRace } = load(5);
const { createModelGeometryForecast } = load(17);
const { createSceneCamera } = load(21);
const { racerScale } = load(15);
const {
  actorWorldSphere, controllerRootPoint, modelControllerMatrix, racerCameraHeight,
  racerRequestedPose, racerTerrainAdjustment, sampleMotionRoot,
} = load(18);

const f32 = Math.fround;

function trialSeed(index, salt) {
  // Separate streams for field construction and active-race sampling. The
  // same index intentionally pairs trials across terrain and stamina choices.
  let value = (index + 1) ^ salt;
  value = Math.imul(value ^ (value >>> 16), 0x21f0aaad);
  value = Math.imul(value ^ (value >>> 15), 0x735a2d97);
  return (value ^ (value >>> 15)) >>> 0;
}

function createSceneInputs(opening, lineup, track, staminaMode) {
  const { fps } = opening;
  const stepSeconds = f32(1 / fps);
  const animationTiming = { taskSpeed: 1, stepSeconds };
  const racerScales = lineup.map(({ stats }, slot) => {
    const { stamina, legPower } = stats;
    const startingStamina = slot === 0 && staminaMode === 'full' ? stamina.max : stamina.value;
    return racerScale(startingStamina, legPower.value);
  });
  const presentation = {
    effectManagerActive: true, // Present in each measured arena startup.
    racers: opening.racerMotion.map((sample, slot) => ({
      ...sample, scale: racerScales[slot], smoothedDistance: 0, forwardDelta: 0, lateralOffset: 0,
    })),
    crowd: opening.crowd,
    animationTiming,
    commentary: opening.commentary,
    modelNoise: opening.modelNoise,
  };
  const scene = {
    animationTiming,
    guestRaceClock: { modelFrameRate: fps, compensationRatio: fps / 30, timerRate: fps, stepSeconds },
    crowdSample: opening.crowd,
    sceneCheckpoint: { actors: opening.actors },
  };
  const initialActors = racerScales.map((scale, slot) => ({
    slot, distance: 0, base: racerRequestedPose({ slot, smoothedDistance: 0, drift: 0, scale }).position,
  }));
  const { startingPose } = opening.camera;
  const firstFocusZ = initialActors[0].base[2];
  const camera = createSceneCamera({
    ...opening.camera,
    startingPose: {
      ...startingPose,
      eye: [startingPose.eye[0], startingPose.eye[1], f32(firstFocusZ + startingPose.eyeOffset[2])],
      target: [startingPose.target[0], startingPose.target[1], f32(firstFocusZ + startingPose.targetOffset[2])],
    },
  }, initialActors, track.length);
  const geometry = createModelGeometryForecast({ scene, curves: rootCurves });
  const racerActors = opening.actors.filter(actor => actor.kind === 'racer');
  return {
    presentation,
    generateModelNoiseGeometry({ frame, racers, motion, presentation: update }) {
      const missing = [...(update.missing ?? []), ...(update.crowd?.missing ?? [])];
      if (update.commentary?.complete === false) missing.push(update.commentary.reason);
      if (missing.length) return { missing };
      try {
        const actors = racers.map(({ drift, sectionIndex, distance, place }, slot) => {
          const { smoothedDistance, animation, lateralOffset } = motion[slot];
          const scale = racerScales[slot];
          const { position: base, yaw } = racerRequestedPose({ slot, smoothedDistance, drift, lateralOffset, scale });
          base[1] = racerCameraHeight(smoothedDistance, sectionIndex, scale, track);
          const adjustment = racerTerrainAdjustment(smoothedDistance, sectionIndex, scale, track);
          const matrix = modelControllerMatrix({ position: base, yaw, adjustment });
          const rootY = sampleMotionRoot(rootCurves[animation.clip], animation.phase)[1];
          const position = controllerRootPoint({ matrix, root: [0, rootY, 0] });
          const [x, y, z, radius] = racerActors[slot].localSphere;
          const world = actorWorldSphere({ localCenter: [x, y, z], radius, position, yaw });
          return { slot, distance, place, sectionIndex, base, world };
        });
        const view = camera(frame, racers, actors, update.commentary);
        return geometry(view, { frame, racers: actors, crowdEvents: update.crowd?.events,
          crowdAnchorResets: update.crowd?.anchorResets });
      } catch (error) {
        if (!(error instanceof RangeError)) throw error;
        return { missing: [error.message] };
      }
    },
  };
}

function runSceneTrial({ eventId, player, sections, fps, staminaMode, index }) {
  if (!Number.isInteger(index) || index < 0 || index >= 0xffffffff) {
    throw new RangeError('A race trial needs a nonnegative 32-bit index');
  }
  if (!Array.isArray(sections) || !sections.length || sections.length > 5 ||
      sections.some(section => !surfaces.includes(section))) {
    throw new RangeError('A race trial needs one to five resolved track sections');
  }
  if (!['saved', 'full'].includes(staminaMode)) throw new RangeError('Choose saved or full stamina');
  const candidates = openings.filter(opening => opening.fps === fps);
  if (!candidates.length) throw new RangeError('Choose 30, 60, or 120 FPS');
  const opening = candidates[index % candidates.length];
  const seed = trialSeed(index, 0x8b26d17f);
  const raceSeed = trialSeed(index, 0x5a4f3c81);
  const field = generateRivalLineup({ eventId, player, seed });
  const sceneEstimate = {
    arena: 'shared-kenzan-turtle-racing',
    opening: opening.source,
    startingState: 'representative-opening',
    layoutScope: 'synthetic-shared-arena',
    raceSeed: 'independently-sampled',
    setupDraws: field.draws,
  };
  if (field.status !== 'ready') {
    return { status: 'no-start', reason: field.reason, sections: [...sections], results: [], trace: [],
      seed: field.seed, diagnostics: { sceneEstimate } };
  }
  const track = ['Start', ...sections, 'Finish'];
  const { presentation, generateModelNoiseGeometry } = createSceneInputs(opening, field.lineup, track, staminaMode);
  const result = simulateRace({
    eventId, sections, lineup: field.lineup, fps, staminaMode, raceSeed,
    applyEntryEffects: true, frameCounterOffset: opening.cutoff, waterRippleOrigin: 'every-update',
    nativePresentationStart: presentation, generateModelNoiseGeometry,
  });
  result.diagnostics.sceneEstimate = sceneEstimate;
  if (result.status === 'finished' && result.diagnostics.presentation.unmodeled.length) result.status = 'incomplete';
  return result;
}

module.exports = { runSceneTrial };

},
(module, load) => {
module.exports = [{"source":"crystal-cup","fps":30,"cutoff":0,"actors":[{"kind":"crowd","slot":5,"pointer":6,"modelOwner":24576,"localSphere":[0,0,0,1.411010980606079],"culling":{"fade":1,"forcePose":false},"position":[-1.4256263971328735,-0.04755376651883125,-2.023289918899536],"yaw":7864,"basePosition":[-1.4256263971328735,-1,-2.023289918899536],"adjustmentMatrix":[0.8899999856948853,0,0,0,0,0.8899999856948853,0,0,0,0,0.8899999856948853,0,0,0,0,1],"crowdAnchor":[-1.4027519226074219,-1,-2]},{"kind":"crowd","slot":6,"pointer":7,"modelOwner":28672,"localSphere":[0,0,0,1.411010980606079],"culling":{"fade":1,"forcePose":false},"position":[-1.1629090309143066,0.0722302496433258,-0.08030154556035995],"yaw":16895,"basePosition":[-1.1629090309143066,-1,-0.08030154556035995],"adjustmentMatrix":[0.9700000286102295,0,0,0,0,0.9700000286102295,0,0,0,0,0.9700000286102295,0,0,0,0,1],"crowdAnchor":[-1.2542755603790283,-1,0]},{"kind":"crowd","slot":7,"pointer":8,"modelOwner":32768,"localSphere":[0,0,0,1.2553399801254272],"culling":{"fade":1,"forcePose":false},"position":[-1.3444440364837646,0.12852001190185547,-3.0005178451538086],"yaw":3385,"basePosition":[-1.3444440364837646,-1,-3.0005178451538086],"adjustmentMatrix":[1,0,0,0,0,1,0,0,0,0,1,0,0,0,0,1],"crowdAnchor":[-1.3368574380874634,-1,-3]},{"kind":"crowd","slot":8,"pointer":9,"modelOwner":36864,"localSphere":[0,0,0,1.4107749462127686],"culling":{"fade":1,"forcePose":false},"position":[-1.3303273916244507,0.05577746033668518,-4.09583854675293],"yaw":6601,"basePosition":[-1.3303273916244507,-1,-4.09583854675293],"adjustmentMatrix":[0.9399999976158142,0,0,0,0,0.9399999976158142,0,0,0,0,0.9399999976158142,0,0,0,0,1],"crowdAnchor":[-1.316117286682129,-1,-4]},{"kind":"crowd","slot":9,"pointer":10,"modelOwner":40960,"localSphere":[0,0,0,1.392795205116272],"culling":{"fade":1,"forcePose":false},"position":[0.5536876320838928,0.004560187458992004,-5.0158257484436035],"yaw":1517,"basePosition":[0.5536876320838928,-1,-5.0158257484436035],"adjustmentMatrix":[0.8899999856948853,0,0,0,0,0.8899999856948853,0,0,0,0,0.8899999856948853,0,0,0,0,1],"crowdAnchor":[0.5788418650627136,-1,-5]},{"kind":"crowd","slot":10,"pointer":11,"modelOwner":45056,"localSphere":[0,0,0,1.392795205116272],"culling":{"fade":1,"forcePose":false},"position":[-0.5595813393592834,0.027959458529949188,-5.056316375732422],"yaw":4550,"basePosition":[-0.5595813393592834,-1,-5.056316375732422],"adjustmentMatrix":[0.9700000286102295,0,0,0,0,0.9700000286102295,0,0,0,0,0.9700000286102295,0,0,0,0,1],"crowdAnchor":[-0.5635889172554016,-1,-5]},{"kind":"crowd","slot":11,"pointer":12,"modelOwner":49152,"localSphere":[0,0,0,1.386866569519043],"culling":{"fade":1,"forcePose":false},"position":[1.3294020891189575,0.06101454421877861,-4.027078151702881],"yaw":4294967112,"basePosition":[1.3294020891189575,-1,-4.027078151702881],"adjustmentMatrix":[0.9399999976158142,0,0,0,0,0.9399999976158142,0,0,0,0,0.9399999976158142,0,0,0,0,1],"crowdAnchor":[1.340226650238037,-1,-4]},{"kind":"crowd","slot":12,"pointer":13,"modelOwner":53248,"localSphere":[0,0,0,1.3856762647628784],"culling":{"fade":1,"forcePose":false},"position":[1.3388724327087402,0.02413405105471611,-3.0005979537963867],"yaw":4294963951,"basePosition":[1.3388724327087402,-1,-3.0005979537963867],"adjustmentMatrix":[0.9100000262260437,0,0,0,0,0.9100000262260437,0,0,0,0,0.9100000262260437,0,0,0,0,1],"crowdAnchor":[1.36245596408844,-1,-3]},{"kind":"crowd","slot":13,"pointer":14,"modelOwner":57344,"localSphere":[0,0,0,1.411010980606079],"culling":{"fade":1,"forcePose":false},"position":[1.2900723218917847,-0.024278566241264343,-2.0238919258117676],"yaw":4294957574,"basePosition":[1.2900723218917847,-1,-2.0238919258117676],"adjustmentMatrix":[0.9700000286102295,0,0,0,0,0.9700000286102295,0,0,0,0,0.9700000286102295,0,0,0,0,1],"crowdAnchor":[1.2594881057739258,-1,-2]},{"kind":"crowd","slot":14,"pointer":15,"modelOwner":61440,"localSphere":[0,0,0,1.411010980606079],"culling":{"fade":1,"forcePose":false},"position":[1.4587560892105103,0.05614500865340233,-1.1456657648086548],"yaw":4294953118,"basePosition":[1.4587560892105103,-1,-1.1456657648086548],"adjustmentMatrix":[0.9399999976158142,0,0,0,0,0.9399999976158142,0,0,0,0,0.9399999976158142,0,0,0,0,1],"crowdAnchor":[1.3969535827636719,-1,-1]},{"kind":"crowd","slot":15,"pointer":16,"modelOwner":65536,"localSphere":[0,0,0,1.411010980606079],"culling":{"fade":1,"forcePose":false},"position":[0.5158979296684265,0.058392081409692764,1.0017852783203125],"yaw":4294939285,"basePosition":[0.5158979296684265,-1,1.0017852783203125],"adjustmentMatrix":[0.9399999976158142,0,0,0,0,0.9399999976158142,0,0,0,0,0.9399999976158142,0,0,0,0,1],"crowdAnchor":[0.520235002040863,-1,1]},{"kind":"crowd","slot":16,"pointer":17,"modelOwner":69632,"localSphere":[0,0,0,1.4107749462127686],"culling":{"fade":1,"forcePose":false},"position":[-1.408159852027893,0.02011723630130291,-0.995749831199646],"yaw":10683,"basePosition":[-1.408159852027893,-1,-0.995749831199646],"adjustmentMatrix":[0.9100000262260437,0,0,0,0,0.9100000262260437,0,0,0,0,0.9100000262260437,0,0,0,0,1],"crowdAnchor":[-1.4056694507598877,-1,-1]},{"kind":"crowd","slot":17,"pointer":18,"modelOwner":73728,"localSphere":[0,0,0,1.4107749462127686],"culling":{"fade":1,"forcePose":false},"position":[1.3423588275909424,0.049056410789489746,0.015964867547154427],"yaw":4294950330,"basePosition":[1.3423588275909424,-1,0.015964867547154427],"adjustmentMatrix":[0.9399999976158142,0,0,0,0,0.9399999976158142,0,0,0,0,0.9399999976158142,0,0,0,0,1],"crowdAnchor":[1.3581712245941162,-1,0]},{"kind":"crowd","slot":18,"pointer":19,"modelOwner":77824,"localSphere":[0,0,0,1.392795205116272],"culling":{"fade":1,"forcePose":false},"position":[-0.6007224917411804,0.053885944187641144,0.9324773550033569],"yaw":30135,"basePosition":[-0.6007224917411804,-1,0.9324773550033569],"adjustmentMatrix":[0.9399999976158142,0,0,0,0,0.9399999976158142,0,0,0,0,0.9399999976158142,0,0,0,0,1],"crowdAnchor":[-0.5318013429641724,-1,1]},{"kind":"racer","slot":0,"pointer":21,"modelOwner":86016,"localSphere":[0,0,0,0.10856316983699799],"culling":{"fade":1,"forcePose":false}},{"kind":"racer","slot":1,"pointer":22,"modelOwner":90112,"localSphere":[0,0,0,0.10856316983699799],"culling":{"fade":1,"forcePose":false}},{"kind":"racer","slot":2,"pointer":23,"modelOwner":94208,"localSphere":[0,0,0,0.10856342315673828],"culling":{"fade":1,"forcePose":false}},{"kind":"racer","slot":3,"pointer":24,"modelOwner":98304,"localSphere":[0,0,0,0.10856342315673828],"culling":{"fade":1,"forcePose":false}},{"kind":"racer","slot":4,"pointer":25,"modelOwner":102400,"localSphere":[0,0,0,0.10856342315673828],"culling":{"fade":1,"forcePose":false}}],"crowd":[{"slot":0,"pointer":1,"currentClip":2144,"nextClip":2144,"pending":0,"animationStartWord":0,"selector":0,"speed":1.0481841564178467,"override":true,"featured":false,"favoursLeader":true,"pastHalf":false,"modelFlags":40960},{"slot":1,"pointer":2,"currentClip":2136,"nextClip":2136,"pending":0,"animationStartWord":0,"selector":0,"speed":0.8969749212265015,"override":true,"featured":false,"favoursLeader":true,"pastHalf":false,"modelFlags":40960},{"slot":2,"pointer":3,"currentClip":2130,"nextClip":2130,"pending":0,"animationStartWord":0,"selector":0,"speed":0.9163920283317566,"override":true,"featured":false,"favoursLeader":false,"pastHalf":false,"modelFlags":40960},{"slot":3,"pointer":4,"currentClip":2130,"nextClip":2130,"pending":0,"animationStartWord":0,"selector":0,"speed":0.7642672061920166,"override":true,"featured":false,"favoursLeader":true,"pastHalf":false,"modelFlags":40960},{"slot":4,"pointer":5,"currentClip":2130,"nextClip":2130,"pending":0,"animationStartWord":0,"selector":0,"speed":1.0354582071304321,"override":true,"featured":false,"favoursLeader":false,"pastHalf":false,"modelFlags":40960},{"slot":5,"pointer":6,"currentClip":2136,"nextClip":2136,"pending":0,"animationStartWord":0,"selector":0,"speed":1.146582007408142,"override":false,"featured":false,"favoursLeader":true,"pastHalf":false,"modelFlags":0,"animationSample":{"modelClip":2136,"phaseGetter":11049740,"animationFrame":55.03596115112305,"animationLength":96,"controller":{"clipIndex":0,"flags":0,"frame":55.03596115112305,"multiplier":1,"queuedMotions":0,"requestedClip":0,"secondaryClip":-1,"secondaryStart":0,"secondaryEnd":0,"blendFallback":0}}},{"slot":6,"pointer":7,"currentClip":989,"nextClip":989,"pending":0,"animationStartWord":0,"selector":0,"speed":1.0254939794540405,"override":false,"featured":false,"favoursLeader":false,"pastHalf":false,"modelFlags":0,"animationSample":{"modelClip":989,"phaseGetter":11049740,"animationFrame":202.53558349609375,"animationLength":270,"controller":{"clipIndex":0,"flags":0,"frame":202.53558349609375,"multiplier":1,"queuedMotions":0,"requestedClip":0,"secondaryClip":-1,"secondaryStart":0,"secondaryEnd":0,"blendFallback":0}}},{"slot":7,"pointer":8,"currentClip":1016,"nextClip":1016,"pending":0,"animationStartWord":0,"selector":0,"speed":1.0116769075393677,"override":false,"featured":true,"favoursLeader":false,"pastHalf":false,"modelFlags":0,"animationSample":{"modelClip":1016,"phaseGetter":11049740,"animationFrame":38.367828369140625,"animationLength":125,"controller":{"clipIndex":0,"flags":0,"frame":38.367828369140625,"multiplier":1,"queuedMotions":0,"requestedClip":0,"secondaryClip":-1,"secondaryStart":0,"secondaryEnd":0,"blendFallback":0}}},{"slot":8,"pointer":9,"currentClip":1017,"nextClip":1017,"pending":0,"animationStartWord":0,"selector":0,"speed":0.9205653667449951,"override":false,"featured":false,"favoursLeader":false,"pastHalf":false,"modelFlags":0,"animationSample":{"modelClip":1017,"phaseGetter":11049740,"animationFrame":113.29095458984375,"animationLength":140,"controller":{"clipIndex":0,"flags":0,"frame":113.29095458984375,"multiplier":1,"queuedMotions":0,"requestedClip":0,"secondaryClip":-1,"secondaryStart":0,"secondaryEnd":0,"blendFallback":0}}},{"slot":9,"pointer":10,"currentClip":2144,"nextClip":2144,"pending":0,"animationStartWord":0,"selector":0,"speed":1.1791218519210815,"override":false,"featured":false,"favoursLeader":true,"pastHalf":false,"modelFlags":0,"animationSample":{"modelClip":2144,"phaseGetter":11049740,"animationFrame":53.060489654541016,"animationLength":96,"controller":{"clipIndex":0,"flags":0,"frame":53.060489654541016,"multiplier":1,"queuedMotions":0,"requestedClip":0,"secondaryClip":-1,"secondaryStart":0,"secondaryEnd":0,"blendFallback":0}}},{"slot":10,"pointer":11,"currentClip":989,"nextClip":989,"pending":0,"animationStartWord":0,"selector":0,"speed":0.7646639347076416,"override":false,"featured":false,"favoursLeader":true,"pastHalf":false,"modelFlags":0,"animationSample":{"modelClip":989,"phaseGetter":11049740,"animationFrame":38.98453140258789,"animationLength":270,"controller":{"clipIndex":0,"flags":0,"frame":38.98453140258789,"multiplier":1,"queuedMotions":0,"requestedClip":0,"secondaryClip":-1,"secondaryStart":0,"secondaryEnd":0,"blendFallback":0}}},{"slot":11,"pointer":12,"currentClip":2144,"nextClip":2144,"pending":0,"animationStartWord":0,"selector":0,"speed":1.176360011100769,"override":false,"featured":false,"favoursLeader":false,"pastHalf":false,"modelFlags":0,"animationSample":{"modelClip":2144,"phaseGetter":11049740,"animationFrame":32.93809509277344,"animationLength":96,"controller":{"clipIndex":0,"flags":0,"frame":32.93809509277344,"multiplier":1,"queuedMotions":0,"requestedClip":0,"secondaryClip":-1,"secondaryStart":0,"secondaryEnd":0,"blendFallback":0}}},{"slot":12,"pointer":13,"currentClip":1016,"nextClip":1016,"pending":0,"animationStartWord":0,"selector":0,"speed":1.149176001548767,"override":false,"featured":false,"favoursLeader":false,"pastHalf":false,"modelFlags":0,"animationSample":{"modelClip":1016,"phaseGetter":11049740,"animationFrame":91.79225158691406,"animationLength":125,"controller":{"clipIndex":0,"flags":0,"frame":91.79225158691406,"multiplier":1,"queuedMotions":0,"requestedClip":0,"secondaryClip":-1,"secondaryStart":0,"secondaryEnd":0,"blendFallback":0}}},{"slot":13,"pointer":14,"currentClip":2136,"nextClip":2136,"pending":0,"animationStartWord":0,"selector":0,"speed":1.0621461868286133,"override":false,"featured":false,"favoursLeader":false,"pastHalf":false,"modelFlags":0,"animationSample":{"modelClip":2136,"phaseGetter":11049740,"animationFrame":42.48585510253906,"animationLength":96,"controller":{"clipIndex":0,"flags":0,"frame":42.48585510253906,"multiplier":1,"queuedMotions":0,"requestedClip":0,"secondaryClip":-1,"secondaryStart":0,"secondaryEnd":0,"blendFallback":0}}},{"slot":14,"pointer":15,"currentClip":1017,"nextClip":1017,"pending":0,"animationStartWord":0,"selector":0,"speed":1.1824864149093628,"override":false,"featured":false,"favoursLeader":false,"pastHalf":false,"modelFlags":0,"animationSample":{"modelClip":1017,"phaseGetter":11049740,"animationFrame":41.25003433227539,"animationLength":140,"controller":{"clipIndex":0,"flags":0,"frame":41.25003433227539,"multiplier":1,"queuedMotions":0,"requestedClip":0,"secondaryClip":-1,"secondaryStart":0,"secondaryEnd":0,"blendFallback":0}}},{"slot":15,"pointer":16,"currentClip":2130,"nextClip":2130,"pending":0,"animationStartWord":0,"selector":0,"speed":1.026913046836853,"override":false,"featured":false,"favoursLeader":true,"pastHalf":false,"modelFlags":0,"animationSample":{"modelClip":2130,"phaseGetter":11049740,"animationFrame":108.85291290283203,"animationLength":114,"controller":{"clipIndex":0,"flags":0,"frame":108.85291290283203,"multiplier":1,"queuedMotions":0,"requestedClip":0,"secondaryClip":-1,"secondaryStart":0,"secondaryEnd":0,"blendFallback":0}}},{"slot":16,"pointer":17,"currentClip":1016,"nextClip":1016,"pending":0,"animationStartWord":0,"selector":0,"speed":0.9964331984519958,"override":false,"featured":false,"favoursLeader":false,"pastHalf":false,"modelFlags":0,"animationSample":{"modelClip":1016,"phaseGetter":11049740,"animationFrame":123.66534423828125,"animationLength":125,"controller":{"clipIndex":0,"flags":0,"frame":123.66534423828125,"multiplier":1,"queuedMotions":0,"requestedClip":0,"secondaryClip":-1,"secondaryStart":0,"secondaryEnd":0,"blendFallback":0}}},{"slot":17,"pointer":18,"currentClip":2136,"nextClip":2136,"pending":0,"animationStartWord":0,"selector":0,"speed":0.8157740235328674,"override":false,"featured":false,"favoursLeader":false,"pastHalf":false,"modelFlags":0,"animationSample":{"modelClip":2136,"phaseGetter":11049740,"animationFrame":16.315481185913086,"animationLength":96,"controller":{"clipIndex":0,"flags":0,"frame":16.315481185913086,"multiplier":1,"queuedMotions":0,"requestedClip":0,"secondaryClip":-1,"secondaryStart":0,"secondaryEnd":0,"blendFallback":0}}},{"slot":18,"pointer":19,"currentClip":1016,"nextClip":1016,"pending":0,"animationStartWord":0,"selector":0,"speed":1.1837987899780273,"override":false,"featured":false,"favoursLeader":false,"pastHalf":false,"modelFlags":0,"animationSample":{"modelClip":1016,"phaseGetter":11049740,"animationFrame":118.74105834960938,"animationLength":125,"controller":{"clipIndex":0,"flags":0,"frame":118.74105834960938,"multiplier":1,"queuedMotions":0,"requestedClip":0,"secondaryClip":-1,"secondaryStart":0,"secondaryEnd":0,"blendFallback":0}}},{"slot":19,"pointer":20,"currentClip":2144,"nextClip":2144,"pending":0,"animationStartWord":0,"selector":0,"speed":0.9160410165786743,"override":true,"featured":false,"favoursLeader":false,"pastHalf":false,"modelFlags":40960}],"racerMotion":[{"clip":52,"pendingClip":52,"queuedClip":0,"phase":14,"ended":false,"dwell":164,"speed":1,"footfallLatch":4294967295},{"clip":54,"pendingClip":54,"queuedClip":54,"phase":74,"ended":false,"dwell":0,"speed":1,"footfallLatch":4294967295},{"clip":57,"pendingClip":57,"queuedClip":57,"phase":54,"ended":false,"dwell":180,"speed":1,"footfallLatch":4294967295},{"clip":57,"pendingClip":57,"queuedClip":56,"phase":64,"ended":false,"dwell":0,"speed":1,"footfallLatch":4294967295},{"clip":57,"pendingClip":57,"queuedClip":57,"phase":74,"ended":false,"dwell":0,"speed":1,"footfallLatch":4294967295}],"camera":{"cutoff":0,"nativeClockPhase":538,"startingPose":{"eye":[-0.013907313346862793,0.09099999815225601,0.5512219667434692],"target":[-0.013907313346862793,0.05000000074505806,-0.08877800405025482],"eyeOffset":[0.0011116121895611286,0.09099999815225601,0.4699999988079071],"targetOffset":[0.0011116121895611286,0.05000000074505806,-0.17000000178813934],"fov":4551},"scale":1,"aspect":1.7777777777777777,"near":0.10000000149011612,"far":1000},"commentary":{"phase":117,"previousPhase":117,"pause":0,"soundMask":0,"cueId":4,"variant":0,"duration":66,"remaining":37},"modelNoise":{"arithmetic":"rpcs3-llvm","timers":[{"id":24996,"enabled":true,"base":0,"startSpan":150,"minLength":10,"lengthSpan":5,"elapsed":44,"start":148.49850463867188,"end":159.24757385253906,"amplitude":1,"minAmplitude":1},{"id":25036,"enabled":true,"base":0,"startSpan":2,"minLength":4,"lengthSpan":12,"elapsed":12,"start":1.9023116827011108,"end":16.089906692504883,"amplitude":0.7907415628433228,"minAmplitude":0.75},{"id":29092,"enabled":true,"base":0,"startSpan":150,"minLength":10,"lengthSpan":5,"elapsed":116,"start":141.81735229492188,"end":153.6367645263672,"amplitude":1,"minAmplitude":1},{"id":29132,"enabled":true,"base":0,"startSpan":2,"minLength":4,"lengthSpan":12,"elapsed":10,"start":0.5071793794631958,"end":11.188067436218262,"amplitude":0.8310444951057434,"minAmplitude":0.75},{"id":33188,"enabled":true,"base":0,"startSpan":150,"minLength":10,"lengthSpan":5,"elapsed":26,"start":27.193866729736328,"end":39.2516975402832,"amplitude":1,"minAmplitude":1},{"id":33228,"enabled":true,"base":0,"startSpan":2,"minLength":4,"lengthSpan":12,"elapsed":4,"start":1.7876859903335571,"end":17.517051696777344,"amplitude":0.7709200978279114,"minAmplitude":0.75},{"id":37284,"enabled":true,"base":0,"startSpan":150,"minLength":10,"lengthSpan":5,"elapsed":64,"start":97.32891082763672,"end":108.09964752197266,"amplitude":1,"minAmplitude":1},{"id":37324,"enabled":true,"base":0,"startSpan":2,"minLength":4,"lengthSpan":12,"elapsed":8,"start":0.5291523337364197,"end":10.416083335876465,"amplitude":0.925101101398468,"minAmplitude":0.75},{"id":41380,"enabled":true,"base":0,"startSpan":150,"minLength":10,"lengthSpan":5,"elapsed":26,"start":103.21354675292969,"end":115.6572036743164,"amplitude":1,"minAmplitude":1},{"id":41420,"enabled":true,"base":0,"startSpan":2,"minLength":4,"lengthSpan":12,"elapsed":8,"start":1.0708171129226685,"end":11.202563285827637,"amplitude":0.85862135887146,"minAmplitude":0.75},{"id":45476,"enabled":true,"base":0,"startSpan":150,"minLength":10,"lengthSpan":5,"elapsed":39,"start":26.081483840942383,"end":39.987640380859375,"amplitude":1,"minAmplitude":1},{"id":45516,"enabled":true,"base":0,"startSpan":2,"minLength":4,"lengthSpan":12,"elapsed":7,"start":0.5696192979812622,"end":7.094316005706787,"amplitude":0.9712367653846741,"minAmplitude":0.75},{"id":49572,"enabled":true,"base":0,"startSpan":150,"minLength":10,"lengthSpan":5,"elapsed":122,"start":133.00755310058594,"end":144.8662567138672,"amplitude":1,"minAmplitude":1},{"id":49612,"enabled":true,"base":0,"startSpan":2,"minLength":4,"lengthSpan":12,"elapsed":9,"start":1.4908369779586792,"end":9.8294038772583,"amplitude":0.9332494139671326,"minAmplitude":0.75},{"id":53668,"enabled":true,"base":0,"startSpan":150,"minLength":10,"lengthSpan":5,"elapsed":82,"start":77.28313446044922,"end":91.25841522216797,"amplitude":1,"minAmplitude":1},{"id":53708,"enabled":true,"base":0,"startSpan":2,"minLength":4,"lengthSpan":12,"elapsed":15,"start":1.3843899965286255,"end":15.435934066772461,"amplitude":0.7998245358467102,"minAmplitude":0.75},{"id":57764,"enabled":true,"base":0,"startSpan":150,"minLength":10,"lengthSpan":5,"elapsed":107,"start":129.981689453125,"end":143.2672576904297,"amplitude":1,"minAmplitude":1},{"id":57804,"enabled":true,"base":0,"startSpan":2,"minLength":4,"lengthSpan":12,"elapsed":8,"start":1.8652933835983276,"end":9.173693656921387,"amplitude":0.8590219020843506,"minAmplitude":0.75},{"id":61860,"enabled":true,"base":0,"startSpan":150,"minLength":10,"lengthSpan":5,"elapsed":63,"start":123.91622161865234,"end":135.0165557861328,"amplitude":1,"minAmplitude":1},{"id":61900,"enabled":true,"base":0,"startSpan":2,"minLength":4,"lengthSpan":12,"elapsed":1,"start":1.1393911838531494,"end":10.243350982666016,"amplitude":0.7886091470718384,"minAmplitude":0.75},{"id":65956,"enabled":true,"base":0,"startSpan":150,"minLength":10,"lengthSpan":5,"elapsed":115,"start":137.7271728515625,"end":147.9578857421875,"amplitude":1,"minAmplitude":1},{"id":65996,"enabled":true,"base":0,"startSpan":2,"minLength":4,"lengthSpan":12,"elapsed":1,"start":0.1591821163892746,"end":13.364217758178711,"amplitude":0.8008201718330383,"minAmplitude":0.75},{"id":70052,"enabled":true,"base":0,"startSpan":150,"minLength":10,"lengthSpan":5,"elapsed":74,"start":72.40100860595703,"end":82.54375457763672,"amplitude":1,"minAmplitude":1},{"id":70092,"enabled":true,"base":0,"startSpan":2,"minLength":4,"lengthSpan":12,"elapsed":7,"start":0.442572683095932,"end":14.174593925476074,"amplitude":0.9840123653411865,"minAmplitude":0.75},{"id":74148,"enabled":true,"base":0,"startSpan":150,"minLength":10,"lengthSpan":5,"elapsed":40,"start":118.27649688720703,"end":128.39779663085938,"amplitude":1,"minAmplitude":1},{"id":74188,"enabled":true,"base":0,"startSpan":2,"minLength":4,"lengthSpan":12,"elapsed":2,"start":0.5445639491081238,"end":6.291233539581299,"amplitude":0.8434996604919434,"minAmplitude":0.75},{"id":78244,"enabled":true,"base":0,"startSpan":150,"minLength":10,"lengthSpan":5,"elapsed":81,"start":142.03250122070312,"end":154.4615020751953,"amplitude":1,"minAmplitude":1},{"id":78284,"enabled":true,"base":0,"startSpan":2,"minLength":4,"lengthSpan":12,"elapsed":1,"start":0.3015792965888977,"end":14.128084182739258,"amplitude":0.9013237357139587,"minAmplitude":0.75},{"id":86436,"enabled":true,"base":0,"startSpan":150,"minLength":10,"lengthSpan":5,"elapsed":131,"start":127.03135681152344,"end":141.9578094482422,"amplitude":1,"minAmplitude":1},{"id":86476,"enabled":true,"base":0,"startSpan":2,"minLength":4,"lengthSpan":12,"elapsed":8,"start":0.13763637840747833,"end":14.354528427124023,"amplitude":0.8426222801208496,"minAmplitude":0.75},{"id":90532,"enabled":true,"base":0,"startSpan":150,"minLength":10,"lengthSpan":5,"elapsed":126,"start":126.7658462524414,"end":140.9400177001953,"amplitude":1,"minAmplitude":1},{"id":90572,"enabled":true,"base":0,"startSpan":2,"minLength":4,"lengthSpan":12,"elapsed":6,"start":1.5161669254302979,"end":10.772838592529297,"amplitude":0.8090333342552185,"minAmplitude":0.75},{"id":94628,"enabled":true,"base":0,"startSpan":150,"minLength":10,"lengthSpan":5,"elapsed":104,"start":97.80499267578125,"end":109.92462158203125,"amplitude":1,"minAmplitude":1},{"id":94668,"enabled":true,"base":0,"startSpan":2,"minLength":4,"lengthSpan":12,"elapsed":9,"start":0.6115816235542297,"end":16.53687286376953,"amplitude":0.8678683042526245,"minAmplitude":0.75},{"id":98724,"enabled":true,"base":0,"startSpan":150,"minLength":10,"lengthSpan":5,"elapsed":31,"start":67.68367767333984,"end":79.46089935302734,"amplitude":1,"minAmplitude":1},{"id":98764,"enabled":true,"base":0,"startSpan":2,"minLength":4,"lengthSpan":12,"elapsed":4,"start":0.22934310138225555,"end":13.215930938720703,"amplitude":0.9139925241470337,"minAmplitude":0.75},{"id":102820,"enabled":true,"base":0,"startSpan":150,"minLength":10,"lengthSpan":5,"elapsed":33,"start":22.652782440185547,"end":36.84443664550781,"amplitude":1,"minAmplitude":1},{"id":102860,"enabled":true,"base":0,"startSpan":2,"minLength":4,"lengthSpan":12,"elapsed":10,"start":0.3505302369594574,"end":15.14164924621582,"amplitude":0.8594682216644287,"minAmplitude":0.75}]}},{"source":"crystal-cup","fps":60,"cutoff":1,"actors":[{"kind":"crowd","slot":0,"pointer":1,"modelOwner":4096,"localSphere":[0,0,0,1.392795205116272],"culling":{"fade":1,"forcePose":false},"position":[-0.5241963863372803,0.09114966541528702,1.0918478965759277],"yaw":32522,"basePosition":[-0.5241963863372803,-1,1.0918478965759277],"adjustmentMatrix":[0.9700000286102295,0,0,0,0,0.9700000286102295,0,0,0,0,0.9700000286102295,0,0,0,0,1],"crowdAnchor":[-0.5764690637588501,-1,1]},{"kind":"crowd","slot":1,"pointer":2,"modelOwner":8192,"localSphere":[0,0,0,1.392795205116272],"culling":{"fade":1,"forcePose":false},"position":[-1.360863447189331,0.026338590309023857,-3.0020484924316406],"yaw":3638,"basePosition":[-1.360863447189331,-1,-3.0020484924316406],"adjustmentMatrix":[0.9100000262260437,0,0,0,0,0.9100000262260437,0,0,0,0,0.9100000262260437,0,0,0,0,1],"crowdAnchor":[-1.3778523206710815,-1,-3]},{"kind":"crowd","slot":2,"pointer":3,"modelOwner":12288,"localSphere":[0,0,0,1.386866569519043],"culling":{"fade":1,"forcePose":false},"position":[-1.3815068006515503,0.0901399552822113,-0.9438825249671936],"yaw":11519,"basePosition":[-1.3815068006515503,-1,-0.9438825249671936],"adjustmentMatrix":[0.9700000286102295,0,0,0,0,0.9700000286102295,0,0,0,0,0.9700000286102295,0,0,0,0,1],"crowdAnchor":[-1.2502257823944092,-1,-1]},{"kind":"crowd","slot":3,"pointer":4,"modelOwner":16384,"localSphere":[0,0,0,1.3856762647628784],"culling":{"fade":1,"forcePose":false},"position":[1.374719500541687,0.0024583141785115004,0.0003305012360215187],"yaw":4294954010,"basePosition":[1.374719500541687,-1,0.0003305012360215187],"adjustmentMatrix":[0.8899999856948853,0,0,0,0,0.8899999856948853,0,0,0,0,0.8899999856948853,0,0,0,0,1],"crowdAnchor":[1.373189091682434,-1,0]},{"kind":"crowd","slot":4,"pointer":5,"modelOwner":20480,"localSphere":[0,0,0,1.411010980606079],"culling":{"fade":1,"forcePose":false},"position":[-1.528366208076477,0.09122864156961441,0.05728919431567192],"yaw":18026,"basePosition":[-1.528366208076477,-1,0.05728919431567192],"adjustmentMatrix":[0.9700000286102295,0,0,0,0,0.9700000286102295,0,0,0,0,0.9700000286102295,0,0,0,0,1],"crowdAnchor":[-1.4498627185821533,-1,0]},{"kind":"crowd","slot":5,"pointer":6,"modelOwner":24576,"localSphere":[0,0,0,1.411010980606079],"culling":{"fade":1,"forcePose":false},"position":[-0.5444841980934143,0.1282273530960083,-5.017267227172852],"yaw":2811,"basePosition":[-0.5444841980934143,-1,-5.017267227172852],"adjustmentMatrix":[1,0,0,0,0,1,0,0,0,0,1,0,0,0,0,1],"crowdAnchor":[-0.5416845679283142,-1,-5]},{"kind":"crowd","slot":6,"pointer":7,"modelOwner":28672,"localSphere":[0,0,0,1.411010980606079],"culling":{"fade":1,"forcePose":false},"position":[1.4309836626052856,-0.00908082164824009,-2.0011916160583496],"yaw":4294960662,"basePosition":[1.4309836626052856,-1,-2.0011916160583496],"adjustmentMatrix":[0.9100000262260437,0,0,0,0,0.9100000262260437,0,0,0,0,0.9100000262260437,0,0,0,0,1],"crowdAnchor":[1.426839828491211,-1,-2]},{"kind":"crowd","slot":7,"pointer":8,"modelOwner":32768,"localSphere":[0,0,0,1.2553399801254272],"culling":{"fade":1,"forcePose":false},"position":[-1.297776222229004,0.12443435192108154,-2.000624179840088],"yaw":4603,"basePosition":[-1.297776222229004,-1,-2.000624179840088],"adjustmentMatrix":[1,0,0,0,0,1,0,0,0,0,1,0,0,0,0,1],"crowdAnchor":[-1.2833927869796753,-1,-2]},{"kind":"crowd","slot":8,"pointer":9,"modelOwner":36864,"localSphere":[0,0,0,1.4107749462127686],"culling":{"fade":1,"forcePose":false},"position":[-1.432288646697998,-0.022162066772580147,-4.017264366149902],"yaw":1398,"basePosition":[-1.432288646697998,-1,-4.017264366149902],"adjustmentMatrix":[0.8899999856948853,0,0,0,0,0.8899999856948853,0,0,0,0,0.8899999856948853,0,0,0,0,1],"crowdAnchor":[-1.406160831451416,-1,-4]},{"kind":"crowd","slot":9,"pointer":10,"modelOwner":40960,"localSphere":[0,0,0,1.392795205116272],"culling":{"fade":1,"forcePose":false},"position":[1.4574222564697266,0.0555335134267807,-4.010159492492676],"yaw":4294959307,"basePosition":[1.4574222564697266,-1,-4.010159492492676],"adjustmentMatrix":[0.9399999976158142,0,0,0,0,0.9399999976158142,0,0,0,0,0.9399999976158142,0,0,0,0,1],"crowdAnchor":[1.4482635259628296,-1,-4]},{"kind":"crowd","slot":10,"pointer":11,"modelOwner":45056,"localSphere":[0,0,0,1.392795205116272],"culling":{"fade":1,"forcePose":false},"position":[0.5450797080993652,0.013539916835725307,-4.931735992431641],"yaw":4294965911,"basePosition":[0.5450797080993652,-1,-4.931735992431641],"adjustmentMatrix":[0.9399999976158142,0,0,0,0,0.9399999976158142,0,0,0,0,0.9399999976158142,0,0,0,0,1],"crowdAnchor":[0.5814129710197449,-1,-5]},{"kind":"crowd","slot":11,"pointer":12,"modelOwner":49152,"localSphere":[0,0,0,1.386866569519043],"culling":{"fade":1,"forcePose":false},"position":[0.4861518442630768,0.09308147430419922,0.9947887659072876],"yaw":4294939603,"basePosition":[0.4861518442630768,-1,0.9947887659072876],"adjustmentMatrix":[1,0,0,0,0,1,0,0,0,0,1,0,0,0,0,1],"crowdAnchor":[0.5014862418174744,-1,1]},{"kind":"crowd","slot":12,"pointer":13,"modelOwner":53248,"localSphere":[0,0,0,1.3856762647628784],"culling":{"fade":1,"forcePose":false},"position":[1.2598317861557007,0.09076830744743347,-3.1184935569763184],"yaw":4294961105,"basePosition":[1.2598317861557007,-1,-3.1184935569763184],"adjustmentMatrix":[0.9700000286102295,0,0,0,0,0.9700000286102295,0,0,0,0,0.9700000286102295,0,0,0,0,1],"crowdAnchor":[1.2718325853347778,-1,-3]},{"kind":"crowd","slot":13,"pointer":14,"modelOwner":57344,"localSphere":[0,0,0,1.411010980606079],"culling":{"fade":1,"forcePose":false},"position":[1.3438504934310913,-0.054375313222408295,-1.0326502323150635],"yaw":4294961017,"basePosition":[1.3438504934310913,-1,-1.0326502323150635],"adjustmentMatrix":[0.9399999976158142,0,0,0,0,0.9399999976158142,0,0,0,0,0.9399999976158142,0,0,0,0,1],"crowdAnchor":[1.3225291967391968,-1,-1]},{"kind":"racer","slot":0,"pointer":21,"modelOwner":86016,"localSphere":[0,0,0,0.10856316983699799],"culling":{"fade":1,"forcePose":false}},{"kind":"racer","slot":1,"pointer":22,"modelOwner":90112,"localSphere":[0,0,0,0.10856316983699799],"culling":{"fade":1,"forcePose":false}},{"kind":"racer","slot":2,"pointer":23,"modelOwner":94208,"localSphere":[0,0,0,0.10856316983699799],"culling":{"fade":1,"forcePose":false}},{"kind":"racer","slot":3,"pointer":24,"modelOwner":98304,"localSphere":[0,0,0,0.10856316983699799],"culling":{"fade":1,"forcePose":false}},{"kind":"racer","slot":4,"pointer":25,"modelOwner":102400,"localSphere":[0,0,0,0.10856316983699799],"culling":{"fade":1,"forcePose":false}}],"crowd":[{"slot":0,"pointer":1,"currentClip":1017,"nextClip":1017,"pending":0,"animationStartWord":0,"selector":0,"speed":0.9377622604370117,"override":false,"featured":false,"favoursLeader":false,"pastHalf":false,"modelFlags":0,"animationSample":{"modelClip":1017,"phaseGetter":11049740,"animationFrame":22.35365104675293,"animationLength":140,"controller":{"clipIndex":0,"flags":0,"frame":22.35365104675293,"multiplier":1,"queuedMotions":0,"requestedClip":0,"secondaryClip":-1,"secondaryStart":0,"secondaryEnd":0,"blendFallback":0}}},{"slot":1,"pointer":2,"currentClip":2130,"nextClip":2130,"pending":0,"animationStartWord":0,"selector":0,"speed":1.0750401020050049,"override":false,"featured":false,"favoursLeader":false,"pastHalf":false,"modelFlags":0,"animationSample":{"modelClip":2130,"phaseGetter":11049740,"animationFrame":85.46580505371094,"animationLength":114,"controller":{"clipIndex":0,"flags":0,"frame":85.46580505371094,"multiplier":1,"queuedMotions":0,"requestedClip":0,"secondaryClip":-1,"secondaryStart":0,"secondaryEnd":0,"blendFallback":0}}},{"slot":2,"pointer":3,"currentClip":1017,"nextClip":1017,"pending":0,"animationStartWord":0,"selector":0,"speed":1.0117228031158447,"override":false,"featured":false,"favoursLeader":true,"pastHalf":false,"modelFlags":0,"animationSample":{"modelClip":1017,"phaseGetter":11049740,"animationFrame":33.64158248901367,"animationLength":140,"controller":{"clipIndex":0,"flags":0,"frame":33.64158248901367,"multiplier":1,"queuedMotions":0,"requestedClip":0,"secondaryClip":-1,"secondaryStart":0,"secondaryEnd":0,"blendFallback":0}}},{"slot":3,"pointer":4,"currentClip":2130,"nextClip":2130,"pending":0,"animationStartWord":0,"selector":0,"speed":0.861215353012085,"override":false,"featured":false,"favoursLeader":true,"pastHalf":false,"modelFlags":0,"animationSample":{"modelClip":2130,"phaseGetter":11049740,"animationFrame":8.612154960632324,"animationLength":114,"controller":{"clipIndex":0,"flags":0,"frame":8.612154960632324,"multiplier":1,"queuedMotions":0,"requestedClip":0,"secondaryClip":-1,"secondaryStart":0,"secondaryEnd":0,"blendFallback":0}}},{"slot":4,"pointer":5,"currentClip":1017,"nextClip":1017,"pending":0,"animationStartWord":0,"selector":0,"speed":0.9376096725463867,"override":false,"featured":false,"favoursLeader":true,"pastHalf":false,"modelFlags":0,"animationSample":{"modelClip":1017,"phaseGetter":11049740,"animationFrame":94.29305267333984,"animationLength":140,"controller":{"clipIndex":0,"flags":0,"frame":94.29305267333984,"multiplier":1,"queuedMotions":0,"requestedClip":0,"secondaryClip":-1,"secondaryStart":0,"secondaryEnd":0,"blendFallback":0}}},{"slot":5,"pointer":6,"currentClip":2130,"nextClip":2130,"pending":0,"animationStartWord":0,"selector":0,"speed":0.866998553276062,"override":false,"featured":false,"favoursLeader":false,"pastHalf":false,"modelFlags":0,"animationSample":{"modelClip":2130,"phaseGetter":11049740,"animationFrame":45.950862884521484,"animationLength":114,"controller":{"clipIndex":0,"flags":0,"frame":45.950862884521484,"multiplier":1,"queuedMotions":0,"requestedClip":0,"secondaryClip":-1,"secondaryStart":0,"secondaryEnd":0,"blendFallback":0}}},{"slot":6,"pointer":7,"currentClip":989,"nextClip":989,"pending":0,"animationStartWord":0,"selector":0,"speed":0.9722629189491272,"override":false,"featured":false,"favoursLeader":true,"pastHalf":false,"modelFlags":0,"animationSample":{"modelClip":989,"phaseGetter":11049740,"animationFrame":164.0153350830078,"animationLength":270,"controller":{"clipIndex":0,"flags":0,"frame":164.0153350830078,"multiplier":1,"queuedMotions":0,"requestedClip":0,"secondaryClip":-1,"secondaryStart":0,"secondaryEnd":0,"blendFallback":0}}},{"slot":7,"pointer":8,"currentClip":1016,"nextClip":1016,"pending":0,"animationStartWord":0,"selector":0,"speed":0.9625047445297241,"override":false,"featured":true,"favoursLeader":false,"pastHalf":false,"modelFlags":0,"animationSample":{"modelClip":1016,"phaseGetter":11049740,"animationFrame":25.15244483947754,"animationLength":125,"controller":{"clipIndex":0,"flags":0,"frame":25.15244483947754,"multiplier":1,"queuedMotions":0,"requestedClip":0,"secondaryClip":-1,"secondaryStart":0,"secondaryEnd":0,"blendFallback":0}}},{"slot":8,"pointer":9,"currentClip":989,"nextClip":989,"pending":0,"animationStartWord":0,"selector":0,"speed":1.1568589210510254,"override":false,"featured":false,"favoursLeader":true,"pastHalf":false,"modelFlags":0,"animationSample":{"modelClip":989,"phaseGetter":11049740,"animationFrame":244.11666870117188,"animationLength":270,"controller":{"clipIndex":0,"flags":0,"frame":244.11666870117188,"multiplier":1,"queuedMotions":0,"requestedClip":0,"secondaryClip":-1,"secondaryStart":0,"secondaryEnd":0,"blendFallback":0}}},{"slot":9,"pointer":10,"currentClip":2136,"nextClip":2136,"pending":0,"animationStartWord":0,"selector":0,"speed":0.7618715167045593,"override":false,"featured":false,"favoursLeader":true,"pastHalf":false,"modelFlags":0,"animationSample":{"modelClip":2136,"phaseGetter":11049740,"animationFrame":67.42562103271484,"animationLength":96,"controller":{"clipIndex":0,"flags":0,"frame":67.42562103271484,"multiplier":1,"queuedMotions":0,"requestedClip":0,"secondaryClip":-1,"secondaryStart":0,"secondaryEnd":0,"blendFallback":0}}},{"slot":10,"pointer":11,"currentClip":989,"nextClip":989,"pending":0,"animationStartWord":0,"selector":0,"speed":0.8192530870437622,"override":false,"featured":false,"favoursLeader":true,"pastHalf":false,"modelFlags":0,"animationSample":{"modelClip":989,"phaseGetter":11049740,"animationFrame":128.42413330078125,"animationLength":270,"controller":{"clipIndex":0,"flags":0,"frame":128.42413330078125,"multiplier":1,"queuedMotions":0,"requestedClip":0,"secondaryClip":-1,"secondaryStart":0,"secondaryEnd":0,"blendFallback":0}}},{"slot":11,"pointer":12,"currentClip":2136,"nextClip":2136,"pending":0,"animationStartWord":0,"selector":0,"speed":1.227073311805725,"override":false,"featured":false,"favoursLeader":false,"pastHalf":false,"modelFlags":0,"animationSample":{"modelClip":2136,"phaseGetter":11049740,"animationFrame":10.43012523651123,"animationLength":96,"controller":{"clipIndex":0,"flags":0,"frame":10.43012523651123,"multiplier":1,"queuedMotions":0,"requestedClip":0,"secondaryClip":-1,"secondaryStart":0,"secondaryEnd":0,"blendFallback":0}}},{"slot":12,"pointer":13,"currentClip":1017,"nextClip":1017,"pending":0,"animationStartWord":0,"selector":0,"speed":1.0157129764556885,"override":false,"featured":false,"favoursLeader":false,"pastHalf":false,"modelFlags":0,"animationSample":{"modelClip":1017,"phaseGetter":11049740,"animationFrame":26.22341537475586,"animationLength":140,"controller":{"clipIndex":0,"flags":0,"frame":26.22341537475586,"multiplier":1,"queuedMotions":0,"requestedClip":0,"secondaryClip":-1,"secondaryStart":0,"secondaryEnd":0,"blendFallback":0}}},{"slot":13,"pointer":14,"currentClip":2136,"nextClip":2136,"pending":0,"animationStartWord":0,"selector":0,"speed":0.8264172077178955,"override":false,"featured":false,"favoursLeader":true,"pastHalf":false,"modelFlags":0,"animationSample":{"modelClip":2136,"phaseGetter":11049740,"animationFrame":45.039703369140625,"animationLength":96,"controller":{"clipIndex":0,"flags":0,"frame":45.039703369140625,"multiplier":1,"queuedMotions":0,"requestedClip":0,"secondaryClip":-1,"secondaryStart":0,"secondaryEnd":0,"blendFallback":0}}},{"slot":14,"pointer":15,"currentClip":1016,"nextClip":1016,"pending":0,"animationStartWord":0,"selector":0,"speed":0.8194667100906372,"override":true,"featured":false,"favoursLeader":false,"pastHalf":false,"modelFlags":0},{"slot":15,"pointer":16,"currentClip":1017,"nextClip":1017,"pending":0,"animationStartWord":0,"selector":0,"speed":0.9183222651481628,"override":true,"featured":false,"favoursLeader":false,"pastHalf":false,"modelFlags":0},{"slot":16,"pointer":17,"currentClip":989,"nextClip":989,"pending":0,"animationStartWord":0,"selector":0,"speed":1.1709582805633545,"override":true,"featured":false,"favoursLeader":true,"pastHalf":false,"modelFlags":0},{"slot":17,"pointer":18,"currentClip":989,"nextClip":989,"pending":0,"animationStartWord":0,"selector":0,"speed":0.8846150636672974,"override":true,"featured":false,"favoursLeader":false,"pastHalf":false,"modelFlags":0},{"slot":18,"pointer":19,"currentClip":1017,"nextClip":1017,"pending":0,"animationStartWord":0,"selector":0,"speed":1.0652894973754883,"override":true,"featured":false,"favoursLeader":false,"pastHalf":false,"modelFlags":0},{"slot":19,"pointer":20,"currentClip":989,"nextClip":989,"pending":0,"animationStartWord":0,"selector":0,"speed":1.068074345588684,"override":true,"featured":false,"favoursLeader":true,"pastHalf":false,"modelFlags":0}],"racerMotion":[{"clip":58,"pendingClip":58,"queuedClip":57,"phase":36,"ended":false,"dwell":155,"speed":1,"footfallLatch":4294967295},{"clip":54,"pendingClip":54,"queuedClip":54,"phase":6,"ended":false,"dwell":155,"speed":1,"footfallLatch":4294967295},{"clip":53,"pendingClip":53,"queuedClip":52,"phase":6,"ended":false,"dwell":0,"speed":1,"footfallLatch":4294967295},{"clip":56,"pendingClip":56,"queuedClip":52,"phase":16,"ended":false,"dwell":0,"speed":1,"footfallLatch":4294967295},{"clip":56,"pendingClip":56,"queuedClip":52,"phase":16,"ended":false,"dwell":0,"speed":1,"footfallLatch":4294967295}],"camera":{"cutoff":1,"nativeClockPhase":1972,"startingPose":{"eye":[0.24250119924545288,0.09099999815225601,-0.2687999904155731],"target":[0.24250119924545288,0.05000000074505806,0.1712000072002411],"eyeOffset":[-0.0012786908773705363,0.09099999815225601,-0.3499999940395355],"targetOffset":[-0.0012786908773705363,0.05000000074505806,0.09000000357627869],"fov":4551},"scale":2,"aspect":1.7777777777777777,"near":0.10000000149011612,"far":1000},"commentary":{"phase":117,"previousPhase":117,"pause":0,"soundMask":0,"cueId":4,"variant":1,"duration":130,"remaining":71},"modelNoise":{"arithmetic":"rpcs3-llvm","timers":[{"id":4516,"enabled":true,"base":0,"startSpan":150,"minLength":10,"lengthSpan":5,"elapsed":85.5,"start":98.80064392089844,"end":113.74128723144531,"amplitude":1,"minAmplitude":1},{"id":4556,"enabled":true,"base":0,"startSpan":2,"minLength":4,"lengthSpan":12,"elapsed":9,"start":1.096940517425537,"end":12.551461219787598,"amplitude":0.9509994983673096,"minAmplitude":0.75},{"id":8612,"enabled":true,"base":0,"startSpan":150,"minLength":10,"lengthSpan":5,"elapsed":46,"start":60.92698669433594,"end":73.56053924560547,"amplitude":1,"minAmplitude":1},{"id":8652,"enabled":true,"base":0,"startSpan":2,"minLength":4,"lengthSpan":12,"elapsed":11,"start":0.9767605066299438,"end":11.14036750793457,"amplitude":0.9150415658950806,"minAmplitude":0.75},{"id":12708,"enabled":true,"base":0,"startSpan":150,"minLength":10,"lengthSpan":5,"elapsed":90,"start":112.7603530883789,"end":127.25291442871094,"amplitude":1,"minAmplitude":1},{"id":12748,"enabled":true,"base":0,"startSpan":2,"minLength":4,"lengthSpan":12,"elapsed":11,"start":1.006759762763977,"end":14.469795227050781,"amplitude":0.7576867341995239,"minAmplitude":0.75},{"id":16804,"enabled":true,"base":0,"startSpan":150,"minLength":10,"lengthSpan":5,"elapsed":12,"start":4.440375328063965,"end":17.030975341796875,"amplitude":1,"minAmplitude":1},{"id":16844,"enabled":true,"base":0,"startSpan":2,"minLength":4,"lengthSpan":12,"elapsed":7.5,"start":1.4551918506622314,"end":15.615137100219727,"amplitude":0.9917830228805542,"minAmplitude":0.75},{"id":20900,"enabled":true,"base":0,"startSpan":150,"minLength":10,"lengthSpan":5,"elapsed":59,"start":61.95467758178711,"end":72.49996185302734,"amplitude":1,"minAmplitude":1},{"id":20940,"enabled":true,"base":0,"startSpan":2,"minLength":4,"lengthSpan":12,"elapsed":1,"start":0.9112687706947327,"end":13.674647331237793,"amplitude":0.7687304615974426,"minAmplitude":0.75},{"id":24996,"enabled":true,"base":0,"startSpan":150,"minLength":10,"lengthSpan":5,"elapsed":119,"start":107.25566101074219,"end":121.15182495117188,"amplitude":1,"minAmplitude":1},{"id":25036,"enabled":true,"base":0,"startSpan":2,"minLength":4,"lengthSpan":12,"elapsed":6,"start":0.45218586921691895,"end":7.086747169494629,"amplitude":0.9157854318618774,"minAmplitude":0.75},{"id":29092,"enabled":true,"base":0,"startSpan":150,"minLength":10,"lengthSpan":5,"elapsed":2.5,"start":91.62279510498047,"end":106.22651672363281,"amplitude":1,"minAmplitude":1},{"id":29132,"enabled":true,"base":0,"startSpan":2,"minLength":4,"lengthSpan":12,"elapsed":5,"start":0.3177233636379242,"end":10.377508163452148,"amplitude":0.9811932444572449,"minAmplitude":0.75},{"id":33188,"enabled":true,"base":0,"startSpan":150,"minLength":10,"lengthSpan":5,"elapsed":38,"start":112.60700225830078,"end":126.6650619506836,"amplitude":1,"minAmplitude":1},{"id":33228,"enabled":true,"base":0,"startSpan":2,"minLength":4,"lengthSpan":12,"elapsed":9.5,"start":1.6816967725753784,"end":11.357320785522461,"amplitude":0.800915539264679,"minAmplitude":0.75},{"id":37284,"enabled":true,"base":0,"startSpan":150,"minLength":10,"lengthSpan":5,"elapsed":65,"start":144.96910095214844,"end":155.71832275390625,"amplitude":1,"minAmplitude":1},{"id":37324,"enabled":true,"base":0,"startSpan":2,"minLength":4,"lengthSpan":12,"elapsed":4.5,"start":1.4681010246276855,"end":10.211520195007324,"amplitude":0.900164008140564,"minAmplitude":0.75},{"id":41380,"enabled":true,"base":0,"startSpan":150,"minLength":10,"lengthSpan":5,"elapsed":46.5,"start":118.99061584472656,"end":131.13526916503906,"amplitude":1,"minAmplitude":1},{"id":41420,"enabled":true,"base":0,"startSpan":2,"minLength":4,"lengthSpan":12,"elapsed":9.5,"start":0.6259250640869141,"end":11.866209030151367,"amplitude":0.821625828742981,"minAmplitude":0.75},{"id":45476,"enabled":true,"base":0,"startSpan":150,"minLength":10,"lengthSpan":5,"elapsed":103,"start":147.39529418945312,"end":160.0186309814453,"amplitude":1,"minAmplitude":1},{"id":45516,"enabled":true,"base":0,"startSpan":2,"minLength":4,"lengthSpan":12,"elapsed":10,"start":1.5945372581481934,"end":14.819531440734863,"amplitude":0.8361638784408569,"minAmplitude":0.75},{"id":49572,"enabled":true,"base":0,"startSpan":150,"minLength":10,"lengthSpan":5,"elapsed":62,"start":84.42435455322266,"end":98.6327896118164,"amplitude":1,"minAmplitude":1},{"id":49612,"enabled":true,"base":0,"startSpan":2,"minLength":4,"lengthSpan":12,"elapsed":9,"start":0.6814373731613159,"end":16.23263931274414,"amplitude":0.9554283618927002,"minAmplitude":0.75},{"id":53668,"enabled":true,"base":0,"startSpan":150,"minLength":10,"lengthSpan":5,"elapsed":9,"start":57.0771369934082,"end":68.80292510986328,"amplitude":1,"minAmplitude":1},{"id":53708,"enabled":true,"base":0,"startSpan":2,"minLength":4,"lengthSpan":12,"elapsed":9,"start":1.8058747053146362,"end":14.811322212219238,"amplitude":0.9473906755447388,"minAmplitude":0.75},{"id":57764,"enabled":true,"base":0,"startSpan":150,"minLength":10,"lengthSpan":5,"elapsed":4,"start":108.72053527832031,"end":121.76707458496094,"amplitude":1,"minAmplitude":1},{"id":57804,"enabled":true,"base":0,"startSpan":2,"minLength":4,"lengthSpan":12,"elapsed":1.5,"start":1.2067749500274658,"end":8.675943374633789,"amplitude":0.8937132954597473,"minAmplitude":0.75},{"id":86436,"enabled":true,"base":0,"startSpan":150,"minLength":10,"lengthSpan":5,"elapsed":120,"start":132.11947631835938,"end":146.4620361328125,"amplitude":1,"minAmplitude":1},{"id":86476,"enabled":true,"base":0,"startSpan":2,"minLength":4,"lengthSpan":12,"elapsed":2,"start":0.2848249077796936,"end":5.566582679748535,"amplitude":0.7702296376228333,"minAmplitude":0.75},{"id":90532,"enabled":true,"base":0,"startSpan":150,"minLength":10,"lengthSpan":5,"elapsed":72,"start":62.082855224609375,"end":72.99130249023438,"amplitude":1,"minAmplitude":1},{"id":90572,"enabled":true,"base":0,"startSpan":2,"minLength":4,"lengthSpan":12,"elapsed":2,"start":1.759853482246399,"end":15.294849395751953,"amplitude":0.8851186037063599,"minAmplitude":0.75},{"id":94628,"enabled":true,"base":0,"startSpan":150,"minLength":10,"lengthSpan":5,"elapsed":98,"start":113.9986343383789,"end":126.99954986572266,"amplitude":1,"minAmplitude":1},{"id":94668,"enabled":true,"base":0,"startSpan":2,"minLength":4,"lengthSpan":12,"elapsed":10,"start":1.5049058198928833,"end":17.018569946289062,"amplitude":0.8889563083648682,"minAmplitude":0.75},{"id":98724,"enabled":true,"base":0,"startSpan":150,"minLength":10,"lengthSpan":5,"elapsed":50,"start":60.260929107666016,"end":71.00731658935547,"amplitude":1,"minAmplitude":1},{"id":98764,"enabled":true,"base":0,"startSpan":2,"minLength":4,"lengthSpan":12,"elapsed":6.5,"start":1.5155260562896729,"end":10.44534969329834,"amplitude":0.9802510142326355,"minAmplitude":0.75},{"id":102820,"enabled":true,"base":0,"startSpan":150,"minLength":10,"lengthSpan":5,"elapsed":26,"start":81.89517211914062,"end":93.93766784667969,"amplitude":1,"minAmplitude":1},{"id":102860,"enabled":true,"base":0,"startSpan":2,"minLength":4,"lengthSpan":12,"elapsed":6,"start":0.29098954796791077,"end":8.716715812683105,"amplitude":0.8375905752182007,"minAmplitude":0.75}]}},{"source":"crystal-cup","fps":120,"cutoff":3,"actors":[{"kind":"crowd","slot":5,"pointer":6,"modelOwner":24576,"localSphere":[0,0,0,1.4107749462127686],"culling":{"fade":1,"forcePose":false},"position":[1.2809780836105347,0.024632735177874565,-4.12007474899292],"yaw":4294962879,"basePosition":[1.2809780836105347,-1,-4.12007474899292],"adjustmentMatrix":[0.9100000262260437,0,0,0,0,0.9100000262260437,0,0,0,0,0.9100000262260437,0,0,0,0,1],"crowdAnchor":[1.3620439767837524,-1,-4]},{"kind":"crowd","slot":6,"pointer":7,"modelOwner":28672,"localSphere":[0,0,0,1.392795205116272],"culling":{"fade":1,"forcePose":false},"position":[1.268530249595642,-0.016705065965652466,-3.035053253173828],"yaw":4294965908,"basePosition":[1.268530249595642,-1,-3.035053253173828],"adjustmentMatrix":[0.9700000286102295,0,0,0,0,0.9700000286102295,0,0,0,0,0.9700000286102295,0,0,0,0,1],"crowdAnchor":[1.2646913528442383,-1,-3]},{"kind":"crowd","slot":7,"pointer":8,"modelOwner":32768,"localSphere":[0,0,0,1.2553399801254272],"culling":{"fade":1,"forcePose":false},"position":[1.3114244937896729,0.12274348735809326,-2.0421431064605713],"yaw":4294960335,"basePosition":[1.3114244937896729,-1,-2.0421431064605713],"adjustmentMatrix":[1,0,0,0,0,1,0,0,0,0,1,0,0,0,0,1],"crowdAnchor":[1.3460525274276733,-1,-2]},{"kind":"crowd","slot":8,"pointer":9,"modelOwner":36864,"localSphere":[0,0,0,1.386866569519043],"culling":{"fade":1,"forcePose":false},"position":[-0.5046862363815308,0.12360835075378418,1.000147819519043],"yaw":27438,"basePosition":[-0.5046862363815308,-1,1.000147819519043],"adjustmentMatrix":[1,0,0,0,0,1,0,0,0,0,1,0,0,0,0,1],"crowdAnchor":[-0.5046234726905823,-1,1]},{"kind":"crowd","slot":9,"pointer":10,"modelOwner":40960,"localSphere":[0,0,0,1.3856762647628784],"culling":{"fade":1,"forcePose":false},"position":[1.4193425178527832,0.002744561992585659,-0.06830763816833496],"yaw":4294951314,"basePosition":[1.4193425178527832,-1,-0.06830763816833496],"adjustmentMatrix":[0.8899999856948853,0,0,0,0,0.8899999856948853,0,0,0,0,0.8899999856948853,0,0,0,0,1],"crowdAnchor":[1.407405972480774,-1,0]},{"kind":"crowd","slot":10,"pointer":11,"modelOwner":45056,"localSphere":[0,0,0,1.411010980606079],"culling":{"fade":1,"forcePose":false},"position":[1.3657103776931763,0.004364863969385624,-1.010143518447876],"yaw":4294954083,"basePosition":[1.3657103776931763,-1,-1.010143518447876],"adjustmentMatrix":[0.8899999856948853,0,0,0,0,0.8899999856948853,0,0,0,0,0.8899999856948853,0,0,0,0,1],"crowdAnchor":[1.3436477184295654,-1,-1]},{"kind":"crowd","slot":11,"pointer":12,"modelOwner":49152,"localSphere":[0,0,0,1.411010980606079],"culling":{"fade":1,"forcePose":false},"position":[0.7171931862831116,0.09023430943489075,0.9431276321411133],"yaw":4294943592,"basePosition":[0.7171931862831116,-1,0.9431276321411133],"adjustmentMatrix":[0.9700000286102295,0,0,0,0,0.9700000286102295,0,0,0,0,0.9700000286102295,0,0,0,0,1],"crowdAnchor":[0.5605508685112,-1,1]},{"kind":"crowd","slot":12,"pointer":13,"modelOwner":53248,"localSphere":[0,0,0,1.411010980606079],"culling":{"fade":1,"forcePose":false},"position":[-1.3595250844955444,0.026761772111058235,0.000402427336666733],"yaw":17006,"basePosition":[-1.3595250844955444,-1,0.000402427336666733],"adjustmentMatrix":[0.9100000262260437,0,0,0,0,0.9100000262260437,0,0,0,0,0.9100000262260437,0,0,0,0,1],"crowdAnchor":[-1.3428908586502075,-1,0]},{"kind":"crowd","slot":13,"pointer":14,"modelOwner":57344,"localSphere":[0,0,0,1.4107749462127686],"culling":{"fade":1,"forcePose":false},"position":[-1.249180793762207,0.12602746486663818,-1.0923585891723633],"yaw":6573,"basePosition":[-1.249180793762207,-1,-1.0923585891723633],"adjustmentMatrix":[1,0,0,0,0,1,0,0,0,0,1,0,0,0,0,1],"crowdAnchor":[-1.2621400356292725,-1,-1]},{"kind":"crowd","slot":14,"pointer":15,"modelOwner":61440,"localSphere":[0,0,0,1.4107749462127686],"culling":{"fade":1,"forcePose":false},"position":[-1.2820618152618408,0.09126818925142288,-2.0000123977661133],"yaw":3554,"basePosition":[-1.2820618152618408,-1,-2.0000123977661133],"adjustmentMatrix":[0.9700000286102295,0,0,0,0,0.9700000286102295,0,0,0,0,0.9700000286102295,0,0,0,0,1],"crowdAnchor":[-1.2819768190383911,-1,-2]},{"kind":"crowd","slot":15,"pointer":16,"modelOwner":65536,"localSphere":[0,0,0,1.392795205116272],"culling":{"fade":1,"forcePose":false},"position":[-1.4622029066085815,0.08985573053359985,-2.9994325637817383],"yaw":6518,"basePosition":[-1.4622029066085815,-1,-2.9994325637817383],"adjustmentMatrix":[0.9700000286102295,0,0,0,0,0.9700000286102295,0,0,0,0,0.9700000286102295,0,0,0,0,1],"crowdAnchor":[-1.3055245876312256,-1,-3]},{"kind":"crowd","slot":16,"pointer":17,"modelOwner":69632,"localSphere":[0,0,0,1.392795205116272],"culling":{"fade":1,"forcePose":false},"position":[-1.370401382446289,0.09390554577112198,-3.9992282390594482],"yaw":2133,"basePosition":[-1.370401382446289,-1,-3.9992282390594482],"adjustmentMatrix":[0.9700000286102295,0,0,0,0,0.9700000286102295,0,0,0,0,0.9700000286102295,0,0,0,0,1],"crowdAnchor":[-1.385909080505371,-1,-4]},{"kind":"crowd","slot":17,"pointer":18,"modelOwner":73728,"localSphere":[0,0,0,1.386866569519043],"culling":{"fade":1,"forcePose":false},"position":[-0.5825278759002686,0.0920574963092804,-5.016214847564697],"yaw":4294964541,"basePosition":[-0.5825278759002686,-1,-5.016214847564697],"adjustmentMatrix":[0.9700000286102295,0,0,0,0,0.9700000286102295,0,0,0,0,0.9700000286102295,0,0,0,0,1],"crowdAnchor":[-0.5381261706352234,-1,-5]},{"kind":"crowd","slot":18,"pointer":19,"modelOwner":77824,"localSphere":[0,0,0,1.3856762647628784],"culling":{"fade":1,"forcePose":false},"position":[0.5387595295906067,0.060316093266010284,-5.020180702209473],"yaw":4294964894,"basePosition":[0.5387595295906067,-1,-5.020180702209473],"adjustmentMatrix":[0.9399999976158142,0,0,0,0,0.9399999976158142,0,0,0,0,0.9399999976158142,0,0,0,0,1],"crowdAnchor":[0.5148409008979797,-1,-5]},{"kind":"racer","slot":0,"pointer":21,"modelOwner":86016,"localSphere":[0,0,0,0.10856316983699799],"culling":{"fade":1,"forcePose":false}},{"kind":"racer","slot":1,"pointer":22,"modelOwner":90112,"localSphere":[0,0,0,0.10856342315673828],"culling":{"fade":1,"forcePose":false}},{"kind":"racer","slot":2,"pointer":23,"modelOwner":94208,"localSphere":[0,0,0,0.10856316983699799],"culling":{"fade":1,"forcePose":false}},{"kind":"racer","slot":3,"pointer":24,"modelOwner":98304,"localSphere":[0,0,0,0.10856316983699799],"culling":{"fade":1,"forcePose":false}},{"kind":"racer","slot":4,"pointer":25,"modelOwner":102400,"localSphere":[0,0,0,0.10856342315673828],"culling":{"fade":1,"forcePose":false}}],"crowd":[{"slot":0,"pointer":1,"currentClip":989,"nextClip":989,"pending":0,"animationStartWord":0,"selector":0,"speed":0.9323148131370544,"override":true,"featured":false,"favoursLeader":false,"pastHalf":false,"modelFlags":0},{"slot":1,"pointer":2,"currentClip":1016,"nextClip":1016,"pending":0,"animationStartWord":0,"selector":0,"speed":1.1980735063552856,"override":true,"featured":false,"favoursLeader":false,"pastHalf":false,"modelFlags":0},{"slot":2,"pointer":3,"currentClip":1016,"nextClip":1016,"pending":0,"animationStartWord":0,"selector":0,"speed":0.8030251264572144,"override":true,"featured":false,"favoursLeader":true,"pastHalf":false,"modelFlags":0},{"slot":3,"pointer":4,"currentClip":1016,"nextClip":1016,"pending":0,"animationStartWord":0,"selector":0,"speed":0.8771915435791016,"override":true,"featured":false,"favoursLeader":true,"pastHalf":false,"modelFlags":0},{"slot":4,"pointer":5,"currentClip":1016,"nextClip":1016,"pending":0,"animationStartWord":0,"selector":0,"speed":1.1692264080047607,"override":true,"featured":false,"favoursLeader":true,"pastHalf":false,"modelFlags":0},{"slot":5,"pointer":6,"currentClip":1017,"nextClip":1017,"pending":0,"animationStartWord":0,"selector":0,"speed":0.7983787059783936,"override":false,"featured":false,"favoursLeader":false,"pastHalf":false,"modelFlags":0,"animationSample":{"modelClip":1017,"phaseGetter":11049740,"animationFrame":75.9865493774414,"animationLength":140,"controller":{"clipIndex":0,"flags":0,"frame":75.9865493774414,"multiplier":1,"queuedMotions":0,"requestedClip":0,"secondaryClip":-1,"secondaryStart":0,"secondaryEnd":0,"blendFallback":0}}},{"slot":6,"pointer":7,"currentClip":2136,"nextClip":2136,"pending":0,"animationStartWord":0,"selector":0,"speed":0.9674258232116699,"override":false,"featured":false,"favoursLeader":false,"pastHalf":false,"modelFlags":0,"animationSample":{"modelClip":2136,"phaseGetter":11049740,"animationFrame":30.4738712310791,"animationLength":96,"controller":{"clipIndex":0,"flags":0,"frame":30.4738712310791,"multiplier":1,"queuedMotions":0,"requestedClip":0,"secondaryClip":-1,"secondaryStart":0,"secondaryEnd":0,"blendFallback":0}}},{"slot":7,"pointer":8,"currentClip":1016,"nextClip":1016,"pending":0,"animationStartWord":0,"selector":0,"speed":0.9176890254020691,"override":false,"featured":true,"favoursLeader":false,"pastHalf":false,"modelFlags":0,"animationSample":{"modelClip":1016,"phaseGetter":11049740,"animationFrame":104.1171875,"animationLength":125,"controller":{"clipIndex":0,"flags":0,"frame":104.1171875,"multiplier":1,"queuedMotions":0,"requestedClip":0,"secondaryClip":-1,"secondaryStart":0,"secondaryEnd":0,"blendFallback":0}}},{"slot":8,"pointer":9,"currentClip":2136,"nextClip":2136,"pending":0,"animationStartWord":0,"selector":0,"speed":0.8680208921432495,"override":false,"featured":false,"favoursLeader":true,"pastHalf":false,"modelFlags":0,"animationSample":{"modelClip":2136,"phaseGetter":11049740,"animationFrame":91.1420669555664,"animationLength":96,"controller":{"clipIndex":0,"flags":0,"frame":91.1420669555664,"multiplier":1,"queuedMotions":0,"requestedClip":0,"secondaryClip":-1,"secondaryStart":0,"secondaryEnd":0,"blendFallback":0}}},{"slot":9,"pointer":10,"currentClip":1016,"nextClip":1016,"pending":0,"animationStartWord":0,"selector":0,"speed":0.8161173462867737,"override":false,"featured":false,"favoursLeader":true,"pastHalf":false,"modelFlags":0,"animationSample":{"modelClip":1016,"phaseGetter":11049740,"animationFrame":85.69872283935547,"animationLength":125,"controller":{"clipIndex":0,"flags":0,"frame":85.69872283935547,"multiplier":1,"queuedMotions":0,"requestedClip":0,"secondaryClip":-1,"secondaryStart":0,"secondaryEnd":0,"blendFallback":0}}},{"slot":10,"pointer":11,"currentClip":2144,"nextClip":2144,"pending":0,"animationStartWord":0,"selector":0,"speed":1.026882529258728,"override":false,"featured":false,"favoursLeader":true,"pastHalf":false,"modelFlags":0,"animationSample":{"modelClip":2144,"phaseGetter":11049740,"animationFrame":22.591432571411133,"animationLength":96,"controller":{"clipIndex":0,"flags":0,"frame":22.591432571411133,"multiplier":1,"queuedMotions":0,"requestedClip":0,"secondaryClip":-1,"secondaryStart":0,"secondaryEnd":0,"blendFallback":0}}},{"slot":11,"pointer":12,"currentClip":1017,"nextClip":1017,"pending":0,"animationStartWord":0,"selector":0,"speed":0.7548218369483948,"override":false,"featured":false,"favoursLeader":false,"pastHalf":false,"modelFlags":0,"animationSample":{"modelClip":1017,"phaseGetter":11049740,"animationFrame":50.511356353759766,"animationLength":140,"controller":{"clipIndex":0,"flags":0,"frame":50.511356353759766,"multiplier":1,"queuedMotions":0,"requestedClip":0,"secondaryClip":-1,"secondaryStart":0,"secondaryEnd":0,"blendFallback":0}}},{"slot":12,"pointer":13,"currentClip":2130,"nextClip":2130,"pending":0,"animationStartWord":0,"selector":0,"speed":1.0078850984573364,"override":false,"featured":false,"favoursLeader":false,"pastHalf":false,"modelFlags":0,"animationSample":{"modelClip":2130,"phaseGetter":11049740,"animationFrame":46.86676788330078,"animationLength":114,"controller":{"clipIndex":0,"flags":0,"frame":46.86676788330078,"multiplier":1,"queuedMotions":0,"requestedClip":0,"secondaryClip":-1,"secondaryStart":0,"secondaryEnd":0,"blendFallback":0}}},{"slot":13,"pointer":14,"currentClip":1017,"nextClip":1017,"pending":0,"animationStartWord":0,"selector":0,"speed":1.1040550470352173,"override":false,"featured":false,"favoursLeader":false,"pastHalf":false,"modelFlags":0,"animationSample":{"modelClip":1017,"phaseGetter":11049740,"animationFrame":0.6104687452316284,"animationLength":140,"controller":{"clipIndex":0,"flags":0,"frame":0.6104687452316284,"multiplier":1,"queuedMotions":0,"requestedClip":0,"secondaryClip":-1,"secondaryStart":0,"secondaryEnd":0,"blendFallback":0}}},{"slot":14,"pointer":15,"currentClip":2144,"nextClip":2144,"pending":0,"animationStartWord":0,"selector":0,"speed":1.095212459564209,"override":false,"featured":false,"favoursLeader":true,"pastHalf":false,"modelFlags":0,"animationSample":{"modelClip":2144,"phaseGetter":11049740,"animationFrame":95.28364562988281,"animationLength":96,"controller":{"clipIndex":0,"flags":0,"frame":95.28364562988281,"multiplier":1,"queuedMotions":0,"requestedClip":0,"secondaryClip":-1,"secondaryStart":0,"secondaryEnd":0,"blendFallback":0}}},{"slot":15,"pointer":16,"currentClip":1017,"nextClip":1017,"pending":0,"animationStartWord":0,"selector":0,"speed":1.214393138885498,"override":false,"featured":false,"favoursLeader":false,"pastHalf":false,"modelFlags":0,"animationSample":{"modelClip":1017,"phaseGetter":11049740,"animationFrame":40.34320068359375,"animationLength":140,"controller":{"clipIndex":0,"flags":0,"frame":40.34320068359375,"multiplier":1,"queuedMotions":0,"requestedClip":0,"secondaryClip":-1,"secondaryStart":0,"secondaryEnd":0,"blendFallback":0}}},{"slot":16,"pointer":17,"currentClip":2130,"nextClip":2130,"pending":0,"animationStartWord":0,"selector":0,"speed":0.8777256608009338,"override":false,"featured":false,"favoursLeader":false,"pastHalf":false,"modelFlags":0,"animationSample":{"modelClip":2130,"phaseGetter":11049740,"animationFrame":84.4810562133789,"animationLength":114,"controller":{"clipIndex":0,"flags":0,"frame":84.4810562133789,"multiplier":1,"queuedMotions":0,"requestedClip":0,"secondaryClip":-1,"secondaryStart":0,"secondaryEnd":0,"blendFallback":0}}},{"slot":17,"pointer":18,"currentClip":1016,"nextClip":1016,"pending":0,"animationStartWord":0,"selector":0,"speed":1.1473602056503296,"override":false,"featured":false,"favoursLeader":false,"pastHalf":false,"modelFlags":0,"animationSample":{"modelClip":1016,"phaseGetter":11049740,"animationFrame":89.9900894165039,"animationLength":125,"controller":{"clipIndex":0,"flags":0,"frame":89.9900894165039,"multiplier":1,"queuedMotions":0,"requestedClip":0,"secondaryClip":-1,"secondaryStart":0,"secondaryEnd":0,"blendFallback":0}}},{"slot":18,"pointer":19,"currentClip":2130,"nextClip":2130,"pending":0,"animationStartWord":0,"selector":0,"speed":0.936488151550293,"override":false,"featured":false,"favoursLeader":true,"pastHalf":false,"modelFlags":0,"animationSample":{"modelClip":2130,"phaseGetter":11049740,"animationFrame":31.840560913085938,"animationLength":114,"controller":{"clipIndex":0,"flags":0,"frame":31.840560913085938,"multiplier":1,"queuedMotions":0,"requestedClip":0,"secondaryClip":-1,"secondaryStart":0,"secondaryEnd":0,"blendFallback":0}}},{"slot":19,"pointer":20,"currentClip":989,"nextClip":989,"pending":0,"animationStartWord":0,"selector":0,"speed":1.1129205226898193,"override":true,"featured":false,"favoursLeader":true,"pastHalf":false,"modelFlags":0}],"racerMotion":[{"clip":52,"pendingClip":52,"queuedClip":0,"phase":28.25,"ended":false,"dwell":0,"speed":1,"footfallLatch":4294967295},{"clip":52,"pendingClip":52,"queuedClip":0,"phase":28.25,"ended":false,"dwell":0,"speed":1,"footfallLatch":4294967295},{"clip":52,"pendingClip":52,"queuedClip":0,"phase":18.25,"ended":false,"dwell":805,"speed":1,"footfallLatch":4294967295},{"clip":57,"pendingClip":57,"queuedClip":57,"phase":78.25,"ended":false,"dwell":0,"speed":1,"footfallLatch":4294967295},{"clip":54,"pendingClip":54,"queuedClip":54,"phase":58.25,"ended":false,"dwell":716,"speed":1,"footfallLatch":4294967295}],"camera":{"cutoff":3,"nativeClockPhase":4942,"startingPose":{"eye":[-0.06542664021253586,0.09099999815225601,0.5583499670028687],"target":[-0.06542664021253586,0.05000000074505806,-0.08165000379085541],"eyeOffset":[0.0011091402266174555,0.09099999815225601,0.4699999988079071],"targetOffset":[0.0011091402266174555,0.05000000074505806,-0.17000000178813934],"fov":4551},"scale":4,"aspect":1.7777777777777777,"near":0.10000000149011612,"far":1000},"commentary":{"phase":117,"previousPhase":117,"pause":0,"soundMask":0,"cueId":4,"variant":0,"duration":180,"remaining":61},"modelNoise":{"arithmetic":"rpcs3-llvm","timers":[{"id":24996,"enabled":true,"base":0,"startSpan":150,"minLength":10,"lengthSpan":5,"elapsed":37,"start":141.6319580078125,"end":152.9260711669922,"amplitude":1,"minAmplitude":1},{"id":25036,"enabled":true,"base":0,"startSpan":2,"minLength":4,"lengthSpan":12,"elapsed":9,"start":1.447989583015442,"end":11.934782028198242,"amplitude":0.9873426556587219,"minAmplitude":0.75},{"id":29092,"enabled":true,"base":0,"startSpan":150,"minLength":10,"lengthSpan":5,"elapsed":13.25,"start":7.168688774108887,"end":17.48935890197754,"amplitude":1,"minAmplitude":1},{"id":29132,"enabled":true,"base":0,"startSpan":2,"minLength":4,"lengthSpan":12,"elapsed":5.5,"start":0.4454718828201294,"end":15.656091690063477,"amplitude":0.8523231744766235,"minAmplitude":0.75},{"id":33188,"enabled":true,"base":0,"startSpan":150,"minLength":10,"lengthSpan":5,"elapsed":24.75,"start":120.19454956054688,"end":130.7502899169922,"amplitude":1,"minAmplitude":1},{"id":33228,"enabled":true,"base":0,"startSpan":2,"minLength":4,"lengthSpan":12,"elapsed":4.75,"start":1.2666513919830322,"end":15.272418975830078,"amplitude":0.9687647819519043,"minAmplitude":0.75},{"id":37284,"enabled":true,"base":0,"startSpan":150,"minLength":10,"lengthSpan":5,"elapsed":17.25,"start":113.11054992675781,"end":123.59525299072266,"amplitude":1,"minAmplitude":1},{"id":37324,"enabled":true,"base":0,"startSpan":2,"minLength":4,"lengthSpan":12,"elapsed":8.25,"start":0.5129167437553406,"end":14.119874954223633,"amplitude":0.762546718120575,"minAmplitude":0.75},{"id":41380,"enabled":true,"base":0,"startSpan":150,"minLength":10,"lengthSpan":5,"elapsed":1.75,"start":56.22568130493164,"end":70.53910064697266,"amplitude":1,"minAmplitude":1},{"id":41420,"enabled":true,"base":0,"startSpan":2,"minLength":4,"lengthSpan":12,"elapsed":7,"start":0.08114747703075409,"end":9.489067077636719,"amplitude":0.8268635272979736,"minAmplitude":0.75},{"id":45476,"enabled":true,"base":0,"startSpan":150,"minLength":10,"lengthSpan":5,"elapsed":48.25,"start":115.03776550292969,"end":125.98283386230469,"amplitude":1,"minAmplitude":1},{"id":45516,"enabled":true,"base":0,"startSpan":2,"minLength":4,"lengthSpan":12,"elapsed":2.5,"start":0.5959563851356506,"end":8.552376747131348,"amplitude":0.7565385103225708,"minAmplitude":0.75},{"id":49572,"enabled":true,"base":0,"startSpan":150,"minLength":10,"lengthSpan":5,"elapsed":12.25,"start":30.913251876831055,"end":43.509193420410156,"amplitude":1,"minAmplitude":1},{"id":49612,"enabled":true,"base":0,"startSpan":2,"minLength":4,"lengthSpan":12,"elapsed":3.75,"start":0.3195544481277466,"end":11.313191413879395,"amplitude":0.884863018989563,"minAmplitude":0.75},{"id":53668,"enabled":true,"base":0,"startSpan":150,"minLength":10,"lengthSpan":5,"elapsed":90,"start":141.4785919189453,"end":152.3382110595703,"amplitude":1,"minAmplitude":1},{"id":53708,"enabled":true,"base":0,"startSpan":2,"minLength":4,"lengthSpan":12,"elapsed":1,"start":1.3564660549163818,"end":13.166949272155762,"amplitude":0.8313382267951965,"minAmplitude":0.75},{"id":57764,"enabled":true,"base":0,"startSpan":150,"minLength":10,"lengthSpan":5,"elapsed":102,"start":129.55824279785156,"end":141.64407348632812,"amplitude":1,"minAmplitude":1},{"id":57804,"enabled":true,"base":0,"startSpan":2,"minLength":4,"lengthSpan":12,"elapsed":2.25,"start":1.4510414600372314,"end":13.494255065917969,"amplitude":0.9934614896774292,"minAmplitude":0.75},{"id":61860,"enabled":true,"base":0,"startSpan":150,"minLength":10,"lengthSpan":5,"elapsed":0,"start":139.28587341308594,"end":153.9329376220703,"amplitude":1,"minAmplitude":1},{"id":61900,"enabled":true,"base":0,"startSpan":2,"minLength":4,"lengthSpan":12,"elapsed":1,"start":1.3130388259887695,"end":14.976028442382812,"amplitude":0.8617685437202454,"minAmplitude":0.75},{"id":65956,"enabled":true,"base":0,"startSpan":150,"minLength":10,"lengthSpan":5,"elapsed":40.25,"start":125.16136932373047,"end":139.7895965576172,"amplitude":1,"minAmplitude":1},{"id":65996,"enabled":true,"base":0,"startSpan":2,"minLength":4,"lengthSpan":12,"elapsed":5.5,"start":1.5826047658920288,"end":8.721996307373047,"amplitude":0.8097390532493591,"minAmplitude":0.75},{"id":70052,"enabled":true,"base":0,"startSpan":150,"minLength":10,"lengthSpan":5,"elapsed":94.75,"start":147.26023864746094,"end":159.50094604492188,"amplitude":1,"minAmplitude":1},{"id":70092,"enabled":true,"base":0,"startSpan":2,"minLength":4,"lengthSpan":12,"elapsed":7.25,"start":0.7876096963882446,"end":10.485755920410156,"amplitude":0.8407987952232361,"minAmplitude":0.75},{"id":74148,"enabled":true,"base":0,"startSpan":150,"minLength":10,"lengthSpan":5,"elapsed":118,"start":148.7045135498047,"end":160.0372314453125,"amplitude":1,"minAmplitude":1},{"id":74188,"enabled":true,"base":0,"startSpan":2,"minLength":4,"lengthSpan":12,"elapsed":2,"start":0.478339821100235,"end":8.451239585876465,"amplitude":0.7857213616371155,"minAmplitude":0.75},{"id":78244,"enabled":true,"base":0,"startSpan":150,"minLength":10,"lengthSpan":5,"elapsed":11,"start":4.733348369598389,"end":18.15403938293457,"amplitude":1,"minAmplitude":1},{"id":78284,"enabled":true,"base":0,"startSpan":2,"minLength":4,"lengthSpan":12,"elapsed":8,"start":1.8185092210769653,"end":9.267353057861328,"amplitude":0.8577210903167725,"minAmplitude":0.75},{"id":86436,"enabled":true,"base":0,"startSpan":150,"minLength":10,"lengthSpan":5,"elapsed":102.25,"start":130.89036560058594,"end":141.7504425048828,"amplitude":1,"minAmplitude":1},{"id":86476,"enabled":true,"base":0,"startSpan":2,"minLength":4,"lengthSpan":12,"elapsed":10.75,"start":0.7946593165397644,"end":14.088135719299316,"amplitude":0.9574349522590637,"minAmplitude":0.75},{"id":90532,"enabled":true,"base":0,"startSpan":150,"minLength":10,"lengthSpan":5,"elapsed":35.5,"start":50.20599365234375,"end":62.463871002197266,"amplitude":1,"minAmplitude":1},{"id":90572,"enabled":true,"base":0,"startSpan":2,"minLength":4,"lengthSpan":12,"elapsed":7.75,"start":1.8527809381484985,"end":14.780040740966797,"amplitude":0.8089341521263123,"minAmplitude":0.75},{"id":94628,"enabled":true,"base":0,"startSpan":150,"minLength":10,"lengthSpan":5,"elapsed":134.25,"start":126.25314331054688,"end":138.97467041015625,"amplitude":1,"minAmplitude":1},{"id":94668,"enabled":true,"base":0,"startSpan":2,"minLength":4,"lengthSpan":12,"elapsed":7,"start":0.2702677845954895,"end":10.128084182739258,"amplitude":0.8735446929931641,"minAmplitude":0.75},{"id":98724,"enabled":true,"base":0,"startSpan":150,"minLength":10,"lengthSpan":5,"elapsed":35.75,"start":32.6207389831543,"end":45.05447769165039,"amplitude":1,"minAmplitude":1},{"id":98764,"enabled":true,"base":0,"startSpan":2,"minLength":4,"lengthSpan":12,"elapsed":9.25,"start":0.5562828779220581,"end":12.279606819152832,"amplitude":0.9269970059394836,"minAmplitude":0.75},{"id":102820,"enabled":true,"base":0,"startSpan":150,"minLength":10,"lengthSpan":5,"elapsed":31.25,"start":86.27374267578125,"end":100.72205352783203,"amplitude":1,"minAmplitude":1},{"id":102860,"enabled":true,"base":0,"startSpan":2,"minLength":4,"lengthSpan":12,"elapsed":5.5,"start":1.1874570846557617,"end":10.804669380187988,"amplitude":0.9474822282791138,"minAmplitude":0.75}]}},{"source":"novice-cup","fps":120,"cutoff":3,"actors":[{"kind":"crowd","slot":3,"pointer":4,"modelOwner":16384,"localSphere":[0,0,0,1.411010980606079],"culling":{"fade":1,"forcePose":false},"position":[-0.48210349678993225,0.056626658886671066,-4.9673333168029785],"yaw":1257,"basePosition":[-0.48210349678993225,-1,-4.9673333168029785],"adjustmentMatrix":[0.9100000262260437,0,0,0,0,0.9100000262260437,0,0,0,0,0.9100000262260437,0,0,0,0,1],"crowdAnchor":[-0.5041870474815369,-1,-5]},{"kind":"crowd","slot":4,"pointer":5,"modelOwner":20480,"localSphere":[0,0,0,1.4107749462127686],"culling":{"fade":1,"forcePose":false},"position":[-1.3656803369522095,0.055554021149873734,-3.011995553970337],"yaw":4850,"basePosition":[-1.3656803369522095,-1,-3.011995553970337],"adjustmentMatrix":[0.9399999976158142,0,0,0,0,0.9399999976158142,0,0,0,0,0.9399999976158142,0,0,0,0,1],"crowdAnchor":[-1.3591691255569458,-1,-3]},{"kind":"crowd","slot":5,"pointer":6,"modelOwner":24576,"localSphere":[0,0,0,1.4107749462127686],"culling":{"fade":1,"forcePose":false},"position":[-1.4206287860870361,0.015707330778241158,-4.038573265075684],"yaw":3703,"basePosition":[-1.4206287860870361,-1,-4.038573265075684],"adjustmentMatrix":[0.9700000286102295,0,0,0,0,0.9700000286102295,0,0,0,0,0.9700000286102295,0,0,0,0,1],"crowdAnchor":[-1.4121118783950806,-1,-4]},{"kind":"crowd","slot":6,"pointer":7,"modelOwner":28672,"localSphere":[0,0,0,1.392795205116272],"culling":{"fade":1,"forcePose":false},"position":[0.5918537378311157,0.02672629989683628,-5.014305114746094],"yaw":4294962240,"basePosition":[0.5918537378311157,-1,-5.014305114746094],"adjustmentMatrix":[0.9100000262260437,0,0,0,0,0.9100000262260437,0,0,0,0,0.9100000262260437,0,0,0,0,1],"crowdAnchor":[0.5726634860038757,-1,-5]},{"kind":"crowd","slot":7,"pointer":8,"modelOwner":32768,"localSphere":[0,0,0,1.2553399801254272],"culling":{"fade":1,"forcePose":false},"position":[1.4194626808166504,0.12257325649261475,0.04154854267835617],"yaw":4294951410,"basePosition":[1.4194626808166504,-1,0.04154854267835617],"adjustmentMatrix":[1,0,0,0,0,1,0,0,0,0,1,0,0,0,0,1],"crowdAnchor":[1.436941385269165,-1,0]},{"kind":"crowd","slot":8,"pointer":9,"modelOwner":36864,"localSphere":[0,0,0,1.386866569519043],"culling":{"fade":1,"forcePose":false},"position":[-0.5798954367637634,0.02459368109703064,1.0036876201629639],"yaw":27991,"basePosition":[-0.5798954367637634,-1,1.0036876201629639],"adjustmentMatrix":[0.9100000262260437,0,0,0,0,0.9100000262260437,0,0,0,0,0.9100000262260437,0,0,0,0,1],"crowdAnchor":[-0.5825390815734863,-1,1]},{"kind":"crowd","slot":9,"pointer":10,"modelOwner":40960,"localSphere":[0,0,0,1.3856762647628784],"culling":{"fade":1,"forcePose":false},"position":[-1.380219578742981,0.0017336767632514238,-0.9846400022506714],"yaw":4330,"basePosition":[-1.380219578742981,-1,-0.9846400022506714],"adjustmentMatrix":[0.8899999856948853,0,0,0,0,0.8899999856948853,0,0,0,0,0.8899999856948853,0,0,0,0,1],"crowdAnchor":[-1.357862949371338,-1,-1]},{"kind":"crowd","slot":10,"pointer":11,"modelOwner":45056,"localSphere":[0,0,0,1.411010980606079],"culling":{"fade":1,"forcePose":false},"position":[1.4497736692428589,0.003487447975203395,-1.9900199174880981],"yaw":4294960376,"basePosition":[1.4497736692428589,-1,-1.9900199174880981],"adjustmentMatrix":[0.8899999856948853,0,0,0,0,0.8899999856948853,0,0,0,0,0.8899999856948853,0,0,0,0,1],"crowdAnchor":[1.4434233903884888,-1,-2]},{"kind":"crowd","slot":11,"pointer":12,"modelOwner":49152,"localSphere":[0,0,0,1.411010980606079],"culling":{"fade":1,"forcePose":false},"position":[0.5472028851509094,-0.03403296694159508,0.9531768560409546],"yaw":4294939635,"basePosition":[0.5472028851509094,-1,0.9531768560409546],"adjustmentMatrix":[0.8899999856948853,0,0,0,0,0.8899999856948853,0,0,0,0,0.8899999856948853,0,0,0,0,1],"crowdAnchor":[0.5749400854110718,-1,1]},{"kind":"crowd","slot":12,"pointer":13,"modelOwner":53248,"localSphere":[0,0,0,1.411010980606079],"culling":{"fade":1,"forcePose":false},"position":[1.325705885887146,0.09413808584213257,-4.024155139923096],"yaw":4294966781,"basePosition":[1.325705885887146,-1,-4.024155139923096],"adjustmentMatrix":[0.9700000286102295,0,0,0,0,0.9700000286102295,0,0,0,0,0.9700000286102295,0,0,0,0,1],"crowdAnchor":[1.3053597211837769,-1,-4]},{"kind":"crowd","slot":13,"pointer":14,"modelOwner":57344,"localSphere":[0,0,0,1.4107749462127686],"culling":{"fade":1,"forcePose":false},"position":[1.3996539115905762,0.11842012405395508,-3.0214436054229736],"yaw":4294961949,"basePosition":[1.3996539115905762,-1,-3.0214436054229736],"adjustmentMatrix":[1,0,0,0,0,1,0,0,0,0,1,0,0,0,0,1],"crowdAnchor":[1.3879903554916382,-1,-3]},{"kind":"crowd","slot":14,"pointer":15,"modelOwner":61440,"localSphere":[0,0,0,1.4107749462127686],"culling":{"fade":1,"forcePose":false},"position":[-1.4268630743026733,-0.0029497307259589434,-0.00021581241162493825],"yaw":13071,"basePosition":[-1.4268630743026733,-1,-0.00021581241162493825],"adjustmentMatrix":[0.8899999856948853,0,0,0,0,0.8899999856948853,0,0,0,0,0.8899999856948853,0,0,0,0,1],"crowdAnchor":[-1.425893783569336,-1,0]},{"kind":"crowd","slot":15,"pointer":16,"modelOwner":65536,"localSphere":[0,0,0,1.392795205116272],"culling":{"fade":1,"forcePose":false},"position":[-1.4221467971801758,0.004861925262957811,-2.0062193870544434],"yaw":2969,"basePosition":[-1.4221467971801758,-1,-2.0062193870544434],"adjustmentMatrix":[0.8899999856948853,0,0,0,0,0.8899999856948853,0,0,0,0,0.8899999856948853,0,0,0,0,1],"crowdAnchor":[-1.3471938371658325,-1,-2]},{"kind":"crowd","slot":16,"pointer":17,"modelOwner":69632,"localSphere":[0,0,0,1.392795205116272],"culling":{"fade":1,"forcePose":false},"position":[1.432083249092102,0.05918723717331886,-1.0008488893508911],"yaw":4294960756,"basePosition":[1.432083249092102,-1,-1.0008488893508911],"adjustmentMatrix":[0.9399999976158142,0,0,0,0,0.9399999976158142,0,0,0,0,0.9399999976158142,0,0,0,0,1],"crowdAnchor":[1.4300198554992676,-1,-1]},{"kind":"racer","slot":0,"pointer":21,"modelOwner":86016,"localSphere":[0,0,0,0.10856316983699799],"culling":{"fade":1,"forcePose":false}},{"kind":"racer","slot":1,"pointer":22,"modelOwner":90112,"localSphere":[0,0,0,0.10856316983699799],"culling":{"fade":1,"forcePose":false}},{"kind":"racer","slot":2,"pointer":23,"modelOwner":94208,"localSphere":[0,0,0,0.10856342315673828],"culling":{"fade":1,"forcePose":false}},{"kind":"racer","slot":3,"pointer":24,"modelOwner":98304,"localSphere":[0,0,0,0.10856316983699799],"culling":{"fade":1,"forcePose":false}},{"kind":"racer","slot":4,"pointer":25,"modelOwner":102400,"localSphere":[0,0,0,0.10856316983699799],"culling":{"fade":1,"forcePose":false}}],"crowd":[{"slot":0,"pointer":1,"currentClip":1016,"nextClip":1016,"pending":0,"animationStartWord":0,"selector":0,"speed":0.8915579319000244,"override":true,"featured":false,"favoursLeader":true,"pastHalf":false,"modelFlags":0},{"slot":1,"pointer":2,"currentClip":989,"nextClip":989,"pending":0,"animationStartWord":0,"selector":0,"speed":0.781029224395752,"override":true,"featured":false,"favoursLeader":true,"pastHalf":false,"modelFlags":0},{"slot":2,"pointer":3,"currentClip":1017,"nextClip":1017,"pending":0,"animationStartWord":0,"selector":0,"speed":0.8634660840034485,"override":true,"featured":false,"favoursLeader":false,"pastHalf":false,"modelFlags":0},{"slot":3,"pointer":4,"currentClip":989,"nextClip":989,"pending":0,"animationStartWord":0,"selector":0,"speed":1.1311780214309692,"override":false,"featured":false,"favoursLeader":false,"pastHalf":false,"modelFlags":0,"animationSample":{"modelClip":989,"phaseGetter":11049740,"animationFrame":64.01781463623047,"animationLength":270,"controller":{"clipIndex":0,"flags":0,"frame":64.01781463623047,"multiplier":1,"queuedMotions":0,"requestedClip":0,"secondaryClip":-1,"secondaryStart":0,"secondaryEnd":0,"blendFallback":0}}},{"slot":4,"pointer":5,"currentClip":2136,"nextClip":2136,"pending":0,"animationStartWord":0,"selector":0,"speed":1.1990272998809814,"override":false,"featured":false,"favoursLeader":false,"pastHalf":false,"modelFlags":0,"animationSample":{"modelClip":2136,"phaseGetter":11049740,"animationFrame":67.44513702392578,"animationLength":96,"controller":{"clipIndex":0,"flags":0,"frame":67.44513702392578,"multiplier":1,"queuedMotions":0,"requestedClip":0,"secondaryClip":-1,"secondaryStart":0,"secondaryEnd":0,"blendFallback":0}}},{"slot":5,"pointer":6,"currentClip":989,"nextClip":989,"pending":0,"animationStartWord":0,"selector":0,"speed":0.9782673120498657,"override":false,"featured":false,"favoursLeader":true,"pastHalf":false,"modelFlags":0,"animationSample":{"modelClip":989,"phaseGetter":11049740,"animationFrame":184.2972869873047,"animationLength":270,"controller":{"clipIndex":0,"flags":0,"frame":184.2972869873047,"multiplier":1,"queuedMotions":0,"requestedClip":0,"secondaryClip":-1,"secondaryStart":0,"secondaryEnd":0,"blendFallback":0}}},{"slot":6,"pointer":7,"currentClip":2130,"nextClip":2130,"pending":0,"animationStartWord":0,"selector":0,"speed":0.8738117218017578,"override":false,"featured":false,"favoursLeader":true,"pastHalf":false,"modelFlags":0,"animationSample":{"modelClip":2130,"phaseGetter":11049740,"animationFrame":40.19530487060547,"animationLength":114,"controller":{"clipIndex":0,"flags":0,"frame":40.19530487060547,"multiplier":1,"queuedMotions":0,"requestedClip":0,"secondaryClip":-1,"secondaryStart":0,"secondaryEnd":0,"blendFallback":0}}},{"slot":7,"pointer":8,"currentClip":1016,"nextClip":1016,"pending":0,"animationStartWord":0,"selector":0,"speed":1.0361753702163696,"override":false,"featured":true,"favoursLeader":false,"pastHalf":false,"modelFlags":0,"animationSample":{"modelClip":1016,"phaseGetter":11049740,"animationFrame":105.15431213378906,"animationLength":125,"controller":{"clipIndex":0,"flags":0,"frame":105.15431213378906,"multiplier":1,"queuedMotions":0,"requestedClip":0,"secondaryClip":-1,"secondaryStart":0,"secondaryEnd":0,"blendFallback":0}}},{"slot":8,"pointer":9,"currentClip":2144,"nextClip":2144,"pending":0,"animationStartWord":0,"selector":0,"speed":0.9185130000114441,"override":false,"featured":false,"favoursLeader":false,"pastHalf":false,"modelFlags":0,"animationSample":{"modelClip":2144,"phaseGetter":11049740,"animationFrame":89.32566833496094,"animationLength":96,"controller":{"clipIndex":0,"flags":0,"frame":89.32566833496094,"multiplier":1,"queuedMotions":0,"requestedClip":0,"secondaryClip":-1,"secondaryStart":0,"secondaryEnd":0,"blendFallback":0}}},{"slot":9,"pointer":10,"currentClip":1016,"nextClip":1016,"pending":0,"animationStartWord":0,"selector":0,"speed":0.8060005903244019,"override":false,"featured":false,"favoursLeader":false,"pastHalf":false,"modelFlags":0,"animationSample":{"modelClip":1016,"phaseGetter":11049740,"animationFrame":91.26492309570312,"animationLength":125,"controller":{"clipIndex":0,"flags":0,"frame":91.26492309570312,"multiplier":1,"queuedMotions":0,"requestedClip":0,"secondaryClip":-1,"secondaryStart":0,"secondaryEnd":0,"blendFallback":0}}},{"slot":10,"pointer":11,"currentClip":2130,"nextClip":2130,"pending":0,"animationStartWord":0,"selector":0,"speed":1.183943748474121,"override":false,"featured":false,"favoursLeader":true,"pastHalf":false,"modelFlags":0,"animationSample":{"modelClip":2130,"phaseGetter":11049740,"animationFrame":82.28392028808594,"animationLength":114,"controller":{"clipIndex":0,"flags":0,"frame":82.28392028808594,"multiplier":1,"queuedMotions":0,"requestedClip":0,"secondaryClip":-1,"secondaryStart":0,"secondaryEnd":0,"blendFallback":0}}},{"slot":11,"pointer":12,"currentClip":989,"nextClip":989,"pending":0,"animationStartWord":0,"selector":0,"speed":0.9386777877807617,"override":false,"featured":false,"favoursLeader":false,"pastHalf":false,"modelFlags":0,"animationSample":{"modelClip":989,"phaseGetter":11049740,"animationFrame":168.34957885742188,"animationLength":270,"controller":{"clipIndex":0,"flags":0,"frame":168.34957885742188,"multiplier":1,"queuedMotions":0,"requestedClip":0,"secondaryClip":-1,"secondaryStart":0,"secondaryEnd":0,"blendFallback":0}}},{"slot":12,"pointer":13,"currentClip":2130,"nextClip":2130,"pending":0,"animationStartWord":0,"selector":0,"speed":0.8232662081718445,"override":false,"featured":false,"favoursLeader":true,"pastHalf":false,"modelFlags":0,"animationSample":{"modelClip":2130,"phaseGetter":11049740,"animationFrame":30.255006790161133,"animationLength":114,"controller":{"clipIndex":0,"flags":0,"frame":30.255006790161133,"multiplier":1,"queuedMotions":0,"requestedClip":0,"secondaryClip":-1,"secondaryStart":0,"secondaryEnd":0,"blendFallback":0}}},{"slot":13,"pointer":14,"currentClip":989,"nextClip":989,"pending":0,"animationStartWord":0,"selector":0,"speed":1.2484817504882812,"override":false,"featured":false,"favoursLeader":false,"pastHalf":false,"modelFlags":0,"animationSample":{"modelClip":989,"phaseGetter":11049740,"animationFrame":229.29991149902344,"animationLength":270,"controller":{"clipIndex":0,"flags":0,"frame":229.29991149902344,"multiplier":1,"queuedMotions":0,"requestedClip":0,"secondaryClip":-1,"secondaryStart":0,"secondaryEnd":0,"blendFallback":0}}},{"slot":14,"pointer":15,"currentClip":2136,"nextClip":2136,"pending":0,"animationStartWord":0,"selector":0,"speed":0.753486692905426,"override":false,"featured":false,"favoursLeader":true,"pastHalf":false,"modelFlags":0,"animationSample":{"modelClip":2136,"phaseGetter":11049740,"animationFrame":84.01388549804688,"animationLength":96,"controller":{"clipIndex":0,"flags":0,"frame":84.01388549804688,"multiplier":1,"queuedMotions":0,"requestedClip":0,"secondaryClip":-1,"secondaryStart":0,"secondaryEnd":0,"blendFallback":0}}},{"slot":15,"pointer":16,"currentClip":1016,"nextClip":1016,"pending":0,"animationStartWord":0,"selector":0,"speed":1.0625505447387695,"override":false,"featured":false,"favoursLeader":true,"pastHalf":false,"modelFlags":0,"animationSample":{"modelClip":1016,"phaseGetter":11049740,"animationFrame":55.11423873901367,"animationLength":125,"controller":{"clipIndex":0,"flags":0,"frame":55.11423873901367,"multiplier":1,"queuedMotions":0,"requestedClip":0,"secondaryClip":-1,"secondaryStart":0,"secondaryEnd":0,"blendFallback":0}}},{"slot":16,"pointer":17,"currentClip":2130,"nextClip":2130,"pending":0,"animationStartWord":0,"selector":0,"speed":1.008785367012024,"override":false,"featured":false,"favoursLeader":true,"pastHalf":false,"modelFlags":0,"animationSample":{"modelClip":2130,"phaseGetter":11049740,"animationFrame":10.340049743652344,"animationLength":114,"controller":{"clipIndex":0,"flags":0,"frame":10.340049743652344,"multiplier":1,"queuedMotions":0,"requestedClip":0,"secondaryClip":-1,"secondaryStart":0,"secondaryEnd":0,"blendFallback":0}}},{"slot":17,"pointer":18,"currentClip":1017,"nextClip":1017,"pending":0,"animationStartWord":0,"selector":0,"speed":0.9814793467521667,"override":true,"featured":false,"favoursLeader":true,"pastHalf":false,"modelFlags":0},{"slot":18,"pointer":19,"currentClip":1016,"nextClip":1016,"pending":0,"animationStartWord":0,"selector":0,"speed":0.9280194044113159,"override":true,"featured":false,"favoursLeader":true,"pastHalf":false,"modelFlags":0},{"slot":19,"pointer":20,"currentClip":1016,"nextClip":1016,"pending":0,"animationStartWord":0,"selector":0,"speed":0.8167887330055237,"override":true,"featured":false,"favoursLeader":true,"pastHalf":false,"modelFlags":0}],"racerMotion":[{"clip":54,"pendingClip":54,"queuedClip":54,"phase":67.5,"ended":false,"dwell":0,"speed":1,"footfallLatch":4294967295},{"clip":57,"pendingClip":57,"queuedClip":56,"phase":77.5,"ended":false,"dwell":0,"speed":1,"footfallLatch":4294967295},{"clip":52,"pendingClip":52,"queuedClip":0,"phase":17.5,"ended":false,"dwell":952,"speed":1,"footfallLatch":4294967295},{"clip":57,"pendingClip":57,"queuedClip":57,"phase":77.5,"ended":false,"dwell":48,"speed":1,"footfallLatch":4294967295},{"clip":54,"pendingClip":54,"queuedClip":53,"phase":77.5,"ended":false,"dwell":0,"speed":1,"footfallLatch":4294967295}],"camera":{"cutoff":3,"nativeClockPhase":2711,"startingPose":{"eye":[0.24057331681251526,0.09099999815225601,0.5530999898910522],"target":[0.24057331681251526,0.05000000074505806,-0.0869000032544136],"eyeOffset":[-0.0013744259485974908,0.09099999815225601,0.4699999988079071],"targetOffset":[-0.0013744259485974908,0.05000000074505806,-0.17000000178813934],"fov":4551},"scale":4,"aspect":1.7777777777777777,"near":0.10000000149011612,"far":1000},"commentary":{"phase":117,"previousPhase":117,"pause":0,"soundMask":0,"cueId":4,"variant":1,"duration":184,"remaining":65},"modelNoise":{"arithmetic":"rpcs3-llvm","timers":[{"id":16804,"enabled":true,"base":0,"startSpan":150,"minLength":10,"lengthSpan":5,"elapsed":7.75,"start":34.14053726196289,"end":45.88029479980469,"amplitude":1,"minAmplitude":1},{"id":16844,"enabled":true,"base":0,"startSpan":2,"minLength":4,"lengthSpan":12,"elapsed":15.5,"start":0.32828259468078613,"end":15.77328109741211,"amplitude":0.7673609256744385,"minAmplitude":0.75},{"id":20900,"enabled":true,"base":0,"startSpan":150,"minLength":10,"lengthSpan":5,"elapsed":30,"start":90.4486083984375,"end":101.7254867553711,"amplitude":1,"minAmplitude":1},{"id":20940,"enabled":true,"base":0,"startSpan":2,"minLength":4,"lengthSpan":12,"elapsed":2.25,"start":0.252414733171463,"end":13.005355834960938,"amplitude":0.7502479553222656,"minAmplitude":0.75},{"id":24996,"enabled":true,"base":0,"startSpan":150,"minLength":10,"lengthSpan":5,"elapsed":58.5,"start":119.06156921386719,"end":131.40725708007812,"amplitude":1,"minAmplitude":1},{"id":25036,"enabled":true,"base":0,"startSpan":2,"minLength":4,"lengthSpan":12,"elapsed":6.25,"start":1.6599068641662598,"end":12.22287368774414,"amplitude":0.8722285628318787,"minAmplitude":0.75},{"id":29092,"enabled":true,"base":0,"startSpan":150,"minLength":10,"lengthSpan":5,"elapsed":147.25,"start":139.7528076171875,"end":150.72274780273438,"amplitude":1,"minAmplitude":1},{"id":29132,"enabled":true,"base":0,"startSpan":2,"minLength":4,"lengthSpan":12,"elapsed":11.75,"start":0.6543679237365723,"end":14.400304794311523,"amplitude":0.758651852607727,"minAmplitude":0.75},{"id":33188,"enabled":true,"base":0,"startSpan":150,"minLength":10,"lengthSpan":5,"elapsed":134,"start":134.11077880859375,"end":149.0952911376953,"amplitude":1,"minAmplitude":1},{"id":33228,"enabled":true,"base":0,"startSpan":2,"minLength":4,"lengthSpan":12,"elapsed":13.75,"start":0.37497520446777344,"end":15.632837295532227,"amplitude":0.9359807968139648,"minAmplitude":0.75},{"id":37284,"enabled":true,"base":0,"startSpan":150,"minLength":10,"lengthSpan":5,"elapsed":17.5,"start":42.14694595336914,"end":56.571224212646484,"amplitude":1,"minAmplitude":1},{"id":37324,"enabled":true,"base":0,"startSpan":2,"minLength":4,"lengthSpan":12,"elapsed":8.75,"start":0.043427176773548126,"end":14.21435832977295,"amplitude":0.7612344622612,"minAmplitude":0.75},{"id":41380,"enabled":true,"base":0,"startSpan":150,"minLength":10,"lengthSpan":5,"elapsed":25,"start":86.23712158203125,"end":100.58167266845703,"amplitude":1,"minAmplitude":1},{"id":41420,"enabled":true,"base":0,"startSpan":2,"minLength":4,"lengthSpan":12,"elapsed":12.5,"start":1.2641489505767822,"end":13.99365234375,"amplitude":0.9587472677230835,"minAmplitude":0.75},{"id":45476,"enabled":true,"base":0,"startSpan":150,"minLength":10,"lengthSpan":5,"elapsed":69.25,"start":140.93385314941406,"end":155.25009155273438,"amplitude":1,"minAmplitude":1},{"id":45516,"enabled":true,"base":0,"startSpan":2,"minLength":4,"lengthSpan":12,"elapsed":3.5,"start":1.6408331394195557,"end":14.47635555267334,"amplitude":0.8964866399765015,"minAmplitude":0.75},{"id":49572,"enabled":true,"base":0,"startSpan":150,"minLength":10,"lengthSpan":5,"elapsed":86.5,"start":123.85442352294922,"end":134.7796630859375,"amplitude":1,"minAmplitude":1},{"id":49612,"enabled":true,"base":0,"startSpan":2,"minLength":4,"lengthSpan":12,"elapsed":9.75,"start":1.2827649116516113,"end":11.506248474121094,"amplitude":0.7710688710212708,"minAmplitude":0.75},{"id":53668,"enabled":true,"base":0,"startSpan":150,"minLength":10,"lengthSpan":5,"elapsed":149,"start":142.77638244628906,"end":157.31304931640625,"amplitude":1,"minAmplitude":1},{"id":53708,"enabled":true,"base":0,"startSpan":2,"minLength":4,"lengthSpan":12,"elapsed":4.5,"start":0.8719310164451599,"end":5.573235511779785,"amplitude":0.9923628568649292,"minAmplitude":0.75},{"id":57764,"enabled":true,"base":0,"startSpan":150,"minLength":10,"lengthSpan":5,"elapsed":10.25,"start":23.685054779052734,"end":35.8014030456543,"amplitude":1,"minAmplitude":1},{"id":57804,"enabled":true,"base":0,"startSpan":2,"minLength":4,"lengthSpan":12,"elapsed":4,"start":1.3971465826034546,"end":9.954344749450684,"amplitude":0.8204013109207153,"minAmplitude":0.75},{"id":61860,"enabled":true,"base":0,"startSpan":150,"minLength":10,"lengthSpan":5,"elapsed":148.75,"start":142.78553771972656,"end":157.34814453125,"amplitude":1,"minAmplitude":1},{"id":61900,"enabled":true,"base":0,"startSpan":2,"minLength":4,"lengthSpan":12,"elapsed":6.75,"start":1.2777600288391113,"end":8.948714256286621,"amplitude":0.7510337829589844,"minAmplitude":0.75},{"id":65956,"enabled":true,"base":0,"startSpan":150,"minLength":10,"lengthSpan":5,"elapsed":87.5,"start":94.41748809814453,"end":106.93934631347656,"amplitude":1,"minAmplitude":1},{"id":65996,"enabled":true,"base":0,"startSpan":2,"minLength":4,"lengthSpan":12,"elapsed":2.75,"start":0.9077897071838379,"end":11.896848678588867,"amplitude":0.8767566680908203,"minAmplitude":0.75},{"id":70052,"enabled":true,"base":0,"startSpan":150,"minLength":10,"lengthSpan":5,"elapsed":36.5,"start":91.46944427490234,"end":105.63866424560547,"amplitude":1,"minAmplitude":1},{"id":70092,"enabled":true,"base":0,"startSpan":2,"minLength":4,"lengthSpan":12,"elapsed":5,"start":0.32758069038391113,"end":15.414603233337402,"amplitude":0.8834553956985474,"minAmplitude":0.75},{"id":86436,"enabled":true,"base":0,"startSpan":150,"minLength":10,"lengthSpan":5,"elapsed":47.25,"start":138.12542724609375,"end":149.4845428466797,"amplitude":1,"minAmplitude":1},{"id":86476,"enabled":true,"base":0,"startSpan":2,"minLength":4,"lengthSpan":12,"elapsed":8.25,"start":0.95710688829422,"end":13.097551345825195,"amplitude":0.9156366586685181,"minAmplitude":0.75},{"id":90532,"enabled":true,"base":0,"startSpan":150,"minLength":10,"lengthSpan":5,"elapsed":14.25,"start":47.990386962890625,"end":58.97077941894531,"amplitude":1,"minAmplitude":1},{"id":90572,"enabled":true,"base":0,"startSpan":2,"minLength":4,"lengthSpan":12,"elapsed":8,"start":0.9403524994850159,"end":16.536231994628906,"amplitude":0.7845426201820374,"minAmplitude":0.75},{"id":94628,"enabled":true,"base":0,"startSpan":150,"minLength":10,"lengthSpan":5,"elapsed":73.5,"start":119.51476287841797,"end":133.14451599121094,"amplitude":1,"minAmplitude":1},{"id":94668,"enabled":true,"base":0,"startSpan":2,"minLength":4,"lengthSpan":12,"elapsed":4.5,"start":0.8081178069114685,"end":8.965224266052246,"amplitude":0.8619173169136047,"minAmplitude":0.75},{"id":98724,"enabled":true,"base":0,"startSpan":150,"minLength":10,"lengthSpan":5,"elapsed":108.25,"start":130.22201538085938,"end":144.1885223388672,"amplitude":1,"minAmplitude":1},{"id":98764,"enabled":true,"base":0,"startSpan":2,"minLength":4,"lengthSpan":12,"elapsed":6.5,"start":1.3111772537231445,"end":14.024749755859375,"amplitude":0.9305371046066284,"minAmplitude":0.75},{"id":102820,"enabled":true,"base":0,"startSpan":150,"minLength":10,"lengthSpan":5,"elapsed":2,"start":40.49897003173828,"end":55.25406265258789,"amplitude":1,"minAmplitude":1},{"id":102860,"enabled":true,"base":0,"startSpan":2,"minLength":4,"lengthSpan":12,"elapsed":3.25,"start":0.06985580176115036,"end":15.71920394897461,"amplitude":0.8792248368263245,"minAmplitude":0.75}]}}];
},
(module, load) => {
module.exports = {"49":{"name":"AniKame_eat_end.gmt","root":"center_n","frames":80,"fps":30,"loop":false,"translation":[{"axis":"xyz","keys":[[0,0.0007495000027120113,0.021130500361323357,0],[1,0.0007488999981433153,0.021125299856066704,1.0000000116860974e-7],[2,0.0007472000434063375,0.02111849933862686,2.0000000233721948e-7],[3,0.0007445000228472054,0.021110301837325096,4.0000000467443897e-7],[4,0.0007407999946735799,0.02110069990158081,6.000000212225132e-7],[5,0.0007362000178545713,0.021089700981974602,7.00000043707405e-7],[6,0.0007306000334210694,0.02107750065624714,6.000000212225132e-7],[7,0.0007240999839268625,0.02106419950723648,2.0000000233721948e-7],[8,0.0007166999857872725,0.02104960009455681,-4.0000000467443897e-7],[9,0.0007085999823175371,0.021034101024270058,-0.00000140000008741481],[10,0.0006997000309638679,0.021017499268054962,-0.00000280000017482962],[11,0.0006901000160723925,0.021000100299715996,-0.000004800000169780105],[12,0.000679899996612221,0.020981701090931892,-0.000007200000254670158],[13,0.0006690000300295651,0.020962601527571678,-0.000010400000064691994],[14,0.0006575000006705523,0.020942799746990204,-0.000014200000805431046],[15,0.0006453999667428434,0.020922400057315826,-0.000018700000509852543],[16,0.0006328999879769981,0.020901400595903397,-0.00002409999979136046],[17,0.0006199000054039061,0.020879801362752914,-0.000030399998649954796],[18,0.0006064000190235674,0.020857900381088257,-0.00003769999966607429],[19,0.0005926000303588808,0.020835500210523605,-0.00004600000102072954],[20,0.0005785000394098461,0.020812900736927986,-0.00005530000271392055],[21,0.000564000045415014,0.02079000137746334,-0.00006579999899258837],[22,0.0005493000498972833,0.020767001435160637,-0.00007760000153211877],[23,0.0005344000528566539,0.020743900910019875,-0.00009059999865712598],[24,0.0005193999968469143,0.020720001310110092,-0.0001049999991664663],[25,0.0005044999998062849,0.02069460041821003,-0.00012080000306013972],[26,0.0004898000042885542,0.020667700096964836,-0.00013810000382363796],[27,0.00047519998042844236,0.02063940092921257,-0.00015690000145696104],[28,0.0004606999864336103,0.02060980163514614,-0.0001773999974830076],[29,0.0004463000223040581,0.020579000934958458,-0.00019950000569224358],[30,0.00043200000072829425,0.02054700069129467,-0.00022339999850373715],[31,0.00041790000977925956,0.020514098927378654,-0.0002491000050213188],[32,0.00040400002035312355,0.0204802006483078,-0.0002767000114545226],[33,0.00039010000182315707,0.02044540084898472,-0.0003087999939452857],[34,0.00037650001468136907,0.020409999415278435,-0.00034890000824816525],[35,0.00036299999919719994,0.02037380076944828,-0.0003949000092688948],[36,0.00034970001433975995,0.020337101072072983,-0.00044450000859797],[37,0.00033650000113993883,0.020299900323152542,-0.0004954999894835055],[38,0.0003234999894630164,0.020262299105525017,-0.0005457000224851072],[39,0.0003107000084128231,0.020224500447511673,-0.0005929000326432288],[40,0.00029810002888552845,0.020186400040984154,-0.0006349000032059848],[41,0.0002856000210158527,0.020148200914263725,-0.0006694000330753624],[42,0.00027340001543052495,0.020110001787543297,-0.0006942999898456037],[43,0.00026130001060664654,0.02007189951837063,-0.0007071999716572464],[44,0.00024950000806711614,0.020034000277519226,-0.0007053000153973699],[45,0.0002378999924985692,0.01999630033969879,-0.0006835000240243971],[46,0.00022640000679530203,0.01995900087058544,-0.0006433000089600682],[47,0.00021520000882446766,0.019922100007534027,-0.0005871999892406166],[48,0.00020419999782461673,0.019885700196027756,-0.0005179000436328351],[49,0.00019350000366102904,0.019850000739097595,-0.000437700015027076],[50,0.0001829999964684248,0.019814999774098396,-0.00034940001205541193],[51,0.00017270000535063446,0.019780799746513367,-0.0002553999947849661],[52,0.0001627000019652769,0.019747501239180565,-0.00015820001135580242],[53,0.000152900000102818,0.01971520110964775,-0.000060500002291519195],[54,0.0001432999997632578,0.019683999940752983,0.00003520000245771371],[55,0.0001340000017080456,0.01965400017797947,0.00012650000280700624],[56,0.0001250000059371814,0.01962519995868206,0.00021070000366307795],[57,0.00011630000517470762,0.019597800448536873,0.0002853000187315047],[58,0.00010779999865917489,0.019571900367736816,0.0003476999991107732],[59,0.00009960000170394778,0.01954749971628189,0.0003955000138375908],[60,0.00009169999975711107,0.019524799659848213,0.0004259999841451645],[61,0.00008399999933317304,0.019503701478242874,0.00043670000741258264],[62,0.00007670000195503235,0.0194845013320446,0.0004332000098656863],[63,0.00006959999882383272,0.019467299804091454,0.00042320002103224397],[64,0.00006290000601438805,0.01945200003683567,0.0004075000179000199],[65,0.00005650000093737617,0.01943880133330822,0.0003868000057991594],[66,0.00005030000102124177,0.019427800551056862,0.0003619000199250877],[67,0.00004450000051292591,0.019419100135564804,0.0003336000081617385],[68,0.00003900000228895806,0.019412800669670105,0.0003026000049430877],[69,0.00003389999983482994,0.019408900290727615,0.0002696000155992806],[70,0.000029000000722589903,0.019407600164413452,0.0002356000040890649],[71,0.000024500001018168405,0.01942410133779049,0.00020110000332351774],[72,0.000020400000721565448,0.019468801096081734,0.00016710000636521727],[73,0.000016600000890321098,0.019534800201654434,0.00013420000323094428],[74,0.000013099999705445953,0.019614901393651962,0.00010310000652680174],[75,0.000009999999747378752,0.019702201709151268,0.00007480000203941017],[76,0.000007300000561372144,0.019789500162005424,0.00004990000161342323],[77,0.000004900000021734741,0.01986989937722683,0.000029200002245488577],[78,0.000002900000026784255,0.019936298951506615,0.000013500000022759195],[79,0.0000013000000080864993,0.01998170092701912,0.0000035000000480067683],[80,0,0.019999001175165176,0]]}]},"50":{"name":"AniKame_eat_loop.gmt","root":"center_n","frames":100,"fps":30,"loop":true,"translation":[{"axis":"xyz","keys":[[0,0.0007495000027120113,0.021130500361323357,0],[1,0.0007354000117629766,0.021136600524187088,-0.000010700000530050602],[2,0.0006952999974600971,0.021154100075364113,-0.000021600000764010474],[3,0.0006318999803625047,0.021181700751185417,-0.000032500000088475645],[4,0.0005481999833136797,0.021218201145529747,-0.000043399999412940815],[5,0.0004470999992918223,0.02126220054924488,-0.000054200001613935456],[6,0.0003315000212751329,0.021312501281499863,-0.00006489999941550195],[7,0.00020429999858606607,0.02136790007352829,-0.00007529999857069924],[8,0.0000684000042383559,0.021427100524306297,-0.00008540000271750614],[9,-0.00007329999789362773,0.021488800644874573,-0.00009519999730400741],[10,-0.00021800001559313387,0.02155180089175701,-0.00010450000263517722],[11,-0.0003625999961514026,0.02161480113863945,-0.00011320000339765102],[12,-0.0005042999982833862,0.021676501259207726,-0.00012140000762883574],[13,-0.000640300044324249,0.021735699847340584,-0.00012880000576842576],[14,-0.0007675000233575702,0.02179110050201416,-0.00013559999933931977],[15,-0.00088310003047809,0.0218415018171072,-0.00014150000060908496],[16,-0.0009842000436037779,0.021885499358177185,-0.0001463999942643568],[17,-0.001067899982444942,0.021921901032328606,-0.00015050001093186438],[18,-0.0011312001151964068,0.02194949984550476,-0.0001534000039100647],[19,-0.0011714000720530748,0.021966999396681786,-0.00015520000306423753],[20,-0.0011854000622406602,0.021973101422190666,-0.0001559000083943829],[21,-0.0011852000607177615,0.02197200059890747,-0.00015560000611003488],[22,-0.0011846000561490655,0.021968601271510124,-0.00015469999925699085],[23,-0.0011836000485345721,0.021963100880384445,-0.0001534000039100647],[24,-0.0011822000378742814,0.02195570059120655,-0.00015150000399444252],[25,-0.0011805000249296427,0.02194630168378353,-0.000149200001033023],[26,-0.0011784000089392066,0.021935200318694115,-0.0001463999942643568],[27,-0.0011761001078411937,0.0219224002212286,-0.00014319999900180846],[28,-0.001173499971628189,0.021908000111579895,-0.00013970000145491213],[29,-0.0011706000659614801,0.021892201155424118,-0.0001357000001007691],[30,-0.0011675000423565507,0.02187510021030903,-0.0001314999972237274],[31,-0.0011642000172287226,0.021856701001524925,-0.00012700000661425292],[32,-0.0011606999905779958,0.021837200969457626,-0.0001221999991685152],[33,-0.0011570000788196921,0.021816600114107132,-0.00011719999747583643],[34,-0.001153100049123168,0.021795200183987617,-0.00011200000153621659],[35,-0.0011492000194266438,0.021773001179099083,-0.00010659999679774046],[36,-0.0011451001046225429,0.02175000123679638,-0.00010100000508828089],[37,-0.0011408999562263489,0.021726500242948532,-0.00009529999806545675],[38,-0.0011367000406607985,0.02170250006020069,-0.00008960000559454784],[39,-0.001132400007918477,0.021678199991583824,-0.00008379999781027436],[40,-0.0011281000915914774,0.02165360003709793,-0.00007790000381646678],[41,-0.001123800058849156,0.02162889949977398,-0.00007210000330815092],[42,-0.0011196000268682837,0.021604100242257118,-0.00006630000279983506],[43,-0.001115300110541284,0.021579399704933167,-0.000060500002291519195],[44,-0.0011111999629065394,0.02155490033328533,-0.0000548999996681232],[45,-0.0011071000481024384,0.021530700847506523,-0.00004930000432068482],[46,-0.001103100017644465,0.02150689996778965,-0.00004389999958220869],[47,-0.0010992999887093902,0.02148360013961792,-0.00003870000000461005],[48,-0.0010955999605357647,0.021460900083184242,-0.000033700001949910074],[49,-0.001092099933885038,0.021438999101519585,-0.000028899999961140566],[50,-0.0010888000251725316,0.021417800337076187,-0.000024400000256719068],[51,-0.0010857000015676022,0.021397700533270836,-0.00002010000025620684],[52,-0.0010827999794855714,0.02137860096991062,-0.000016199999663513154],[53,-0.0010801999596878886,0.021360600367188454,-0.000012600000445672777],[54,-0.0010777999414131045,0.02134389989078045,-0.000009500000487605575],[55,-0.0010758000425994396,0.021328700706362724,-0.00000670000008540228],[56,-0.001074100029654801,0.021314900368452072,-0.0000044000003072142135],[57,-0.0010727000189945102,0.02130270004272461,-0.000002499999936844688],[58,-0.0010717000113800168,0.021292200312018394,-0.0000011000000768035534],[59,-0.0010711000068113208,0.021283499896526337,-3.000000106112566e-7],[60,-0.001070900005288422,0.021276799961924553,0],[61,-0.0010674999793991446,0.021271200850605965,0],[62,-0.0010577000211924314,0.021265801042318344,0],[63,-0.0010417000157758594,0.02126060053706169,0],[64,-0.0010199000826105475,0.021255699917674065,0],[65,-0.0009926999919116497,0.021251000463962555,0],[66,-0.0009603000362403691,0.021246401593089104,0],[67,-0.0009231000440195203,0.02124210074543953,0],[68,-0.00088160001905635,0.021237900480628014,0],[69,-0.0008359000203199685,0.021233899518847466,0],[70,-0.000786400050856173,0.021230001002550125,0],[71,-0.0007335999980568886,0.021226299926638603,0],[72,-0.0006777000380679965,0.02122270129621029,0],[73,-0.0006189999985508621,0.021219199523329735,0],[74,-0.0005579999997280538,0.02121580019593239,0],[75,-0.0004949000431224704,0.0212125014513731,0],[76,-0.00043009998626075685,0.021209299564361572,0],[77,-0.0003640000068116933,0.021206200122833252,0],[78,-0.00029680001898668706,0.02120320126414299,0],[79,-0.000228899996727705,0.02120020054280758,0],[80,-0.00016070000128820539,0.021197199821472168,0],[81,-0.00009249999857274815,0.021194299682974815,0],[82,-0.000024600001779617742,0.021191401407122612,0],[83,0.000042499999835854396,0.02118850126862526,0],[84,0.00010870000551221892,0.021185599267482758,0],[85,0.00017350001144222915,0.021182699128985405,0],[86,0.00023660001170355827,0.0211798008531332,0],[87,0.00029760002507828176,0.02117680013179779,0],[88,0.0003563000063877553,0.02117380127310753,0],[89,0.00041220002458430827,0.02117069996893406,0],[90,0.0004650000191759318,0.02116760052740574,0],[91,0.0005145000177435577,0.02116440050303936,0],[92,0.0005601000157184899,0.02116120047867298,0],[93,0.0006016999832354486,0.021157799288630486,0],[94,0.0006389000336639583,0.02115429937839508,0],[95,0.0006711999885737896,0.021150698885321617,0],[96,0.0006985000218264759,0.021146999672055244,0],[97,0.0007203000131994486,0.021143099293112755,0],[98,0.0007363000186160207,0.021139100193977356,0],[99,0.0007460999768227339,0.02113489992916584,0],[100,0.0007495000027120113,0.021130500361323357,0]]}]},"51":{"name":"AniKame_eat_st.gmt","root":"center_n","frames":100,"fps":30,"loop":false,"translation":[{"axis":"xyz","keys":[[0,0,0.019999001175165176,0],[1,0.00017010000010486692,0.02003829926252365,-1.0000000116860974e-7],[2,0.0006188999977894127,0.02014940045773983,0],[3,0.0012543000048026443,0.020321501418948174,6.000000212225132e-7],[4,0.001984200207516551,0.020544100552797318,0.0000018999999156221747],[5,0.0027163999620825052,0.020806699991226196,0.000004500000159168849],[6,0.0033589003141969442,0.021098600700497627,0.000008600000001024455],[7,0.0038194002117961645,0.021409301087260246,0.000014700000065204222],[8,0.004127900116145611,0.02172820083796978,0.00002300000051036477],[9,0.00437880028039217,0.022044701501727104,0.00003389999983482994],[10,0.004577200394123793,0.022348200902342796,0.000047900000936351717],[11,0.004728300031274557,0.02262820117175579,0.00006510000093840063],[12,0.004837000276893377,0.022874100133776665,0.00008610000077169389],[13,0.004908499773591757,0.023075301200151443,0.00011109999468317255],[14,0.004947900306433439,0.023221200332045555,0.00014060000830795616],[15,0.00496029993519187,0.023301200941205025,0.0001748000067891553],[16,0.004940600134432316,0.023343099281191826,0.00022570000146515667],[17,0.004879999905824661,0.02338160015642643,0.0003026000049430877],[18,0.004778000060468912,0.023416800424456596,0.0004017000028397888],[19,0.004634200129657984,0.0234490018337965,0.0005193000542931259],[20,0.004447900224477053,0.023478299379348755,0.0006516000139527023],[21,0.00421860022470355,0.023504700511693954,0.0007949000573717058],[22,0.003945900127291679,0.023528600111603737,0.0009452999802306294],[23,0.0036291000433266163,0.023549899458885193,0.0010992999887093902],[24,0.0032678002025932074,0.023568900302052498,0.0012528999941423535],[25,0.0028615000192075968,0.02358580008149147,0.0014024999691173434],[26,0.0024095000699162483,0.02360060065984726,0.0015443000011146069],[27,0.0019514000741764903,0.023613501340150833,0.0016745999455451965],[28,0.0015260999789461493,0.0236246008425951,0.0017897001234814525],[29,0.001132700010202825,0.023634200915694237,0.0018856000388041139],[30,0.00077039998723194,0.023642299696803093,0.0019588000141084194],[31,0.00043810001807287335,0.023649100214242935,0.0020055000204592943],[32,0.00013490000856108963,0.023654699325561523,0.0020219001453369856],[33,-0.00014010000450070947,0.023659400641918182,0.0020200000144541264],[34,-0.0003879000141751021,0.023663200438022614,0.0020137999672442675],[35,-0.0006093000411055982,0.023666299879550934,0.0020024001132696867],[36,-0.0008054999634623528,0.02366890013217926,0.0019850002136081457],[37,-0.0009771999903023243,0.023670999333262444,0.001961000030860305],[38,-0.0011253999546170235,0.02367289923131466,0.0019293001387268305],[39,-0.0012510999804362655,0.023674700409173965,0.0018892999505624175],[40,-0.0013551999581977725,0.023655900731682777,0.001840100041590631],[41,-0.0014387000119313598,0.023600399494171143,0.0017810000572353601],[42,-0.0015024000313133001,0.023514799773693085,0.0017021000385284424],[43,-0.0015474000247195363,0.023405900225043297,0.0015994999557733536],[44,-0.0015745999990031123,0.023280201479792595,0.0014813001034781337],[45,-0.0015847999602556229,0.023144399747252464,0.0013554999604821205],[46,-0.0015845999587327242,0.023005299270153046,0.0012301000533625484],[47,-0.0015797000378370285,0.022869300097227097,0.0011130999773740768],[48,-0.001570400083437562,0.02274320088326931,0.0010125000262632966],[49,-0.0015568999806419015,0.02263360098004341,0.0009363000281155109],[50,-0.0015391999622806907,0.022547300904989243,0.0008925000438466668],[51,-0.0015176000306382775,0.022475900128483772,0.0008678000303916633],[52,-0.001492299954406917,0.02240690030157566,0.0008433000184595585],[53,-0.0014634000835940242,0.0223401989787817,0.0008191000088118017],[54,-0.0014310999540612102,0.02227579988539219,0.0007952000014483929],[55,-0.001395600032992661,0.022213701158761978,0.0007715999963693321],[56,-0.0013570000883191824,0.02215380035340786,0.0007482000510208309],[57,-0.0013155000051483512,0.022096101194620132,0.0007250999915413558],[58,-0.0012713000178337097,0.02204049937427044,0.0007023000507615507],[59,-0.0012246000114828348,0.021987000480294228,0.0006797999958507717],[60,-0.0011754999868571758,0.02193550020456314,0.0006575000006705523],[61,-0.0011242000618949533,0.021886100992560387,0.0006355000077746809],[62,-0.0010708000045269728,0.021838700398802757,0.0006138000171631575],[63,-0.0010157000506296754,0.021793199703097343,0.0005924000288359821],[64,-0.000958800024818629,0.021749598905444145,0.0005712000420317054],[65,-0.000900499988347292,0.021707899868488312,0.0005504000000655651],[66,-0.0008407999994233251,0.021668000146746635,0.0005298000178299844],[67,-0.0007799000013619661,0.021630000323057175,0.0005094999796710908],[68,-0.0007180999964475632,0.021593600511550903,0.0004894000012427568],[69,-0.0006554000428877771,0.02155900001525879,0.0004697000258602202],[70,-0.0005922000273130834,0.021526100113987923,0.0004501999937929213],[71,-0.0005284000071696937,0.021494800224900246,0.00043100002221763134],[72,-0.00046430001384578645,0.021465200930833817,0.0004120999947190285],[73,-0.0004000999906565994,0.02143700048327446,0.0003934999986086041],[74,-0.00033599999733269215,0.02141050063073635,0.0003752000047825277],[75,-0.00027210000553168356,0.021385399624705315,0.00035710001247934997],[76,-0.0002086000022245571,0.0213616993278265,0.00033939999411813915],[77,-0.00014560000272467732,0.021339500322937965,0.00032190000638365746],[78,-0.00008340000204043463,0.021318599581718445,0.0003046999918296933],[79,-0.00002209999911428895,0.021299099549651146,0.00028780000866390765],[80,0.00003809999907389283,0.02128089964389801,0.00027119999867863953],[81,0.0000971000044955872,0.021263999864459038,0.0002549000200815499],[82,0.00015469999925699085,0.02124820090830326,0.00023879999935161322],[83,0.0002106000029016286,0.021233700215816498,0.00022309999621938914],[84,0.0002648000081535429,0.02122030034661293,0.00020759999461006373],[85,0.0003169999981764704,0.02120800130069256,0.00019239999528508633],[86,0.0003671000013127923,0.021196700632572174,0.00017749999824445695],[87,0.0004149000160396099,0.021186498925089836,0.0001630000042496249],[88,0.00046029998338781297,0.021177299320697784,0.00014870001177769154],[89,0.0005030000465922058,0.02116910181939602,0.00013460000627674162],[90,0.0005429000011645257,0.021161800250411034,0.00012090000382158905],[91,0.0005797999911010265,0.021155301481485367,0.00010750000365078449],[92,0.0006136000156402588,0.02114970050752163,0.00009440000576432794],[93,0.0006440000142902136,0.02114490047097206,0.00008150000212481245],[94,0.0006709000444971025,0.021140901371836662,0.00006900000153109431],[95,0.0006941999890841544,0.021137500181794167,0.00005680000322172418],[96,0.0007136000203900039,0.02113489992916584,0.00004480000279727392],[97,0.0007291000219993293,0.021132899448275566,0.000033200001780642197],[98,0.0007402999908663332,0.021131601184606552,0.000021800000467919745],[99,0.0007470999844372272,0.021130800247192383,0.000010800000382005237],[100,0.0007495000027120113,0.021130500361323357,0]]}]},"52":{"name":"AniKame_kamae_normal.gmt","root":"center_n","frames":90,"fps":30,"loop":true,"translation":[{"axis":"xyz","keys":[[0,0,0.019999001175165176,0],[1,-0.0000044000003072142135,0.020002199336886406,-0.000008800000614428427],[2,-0.00001120000069931848,0.02000650018453598,-0.000020700001186924055],[3,-0.00002010000025620684,0.020011700689792633,-0.000035300003219163045],[4,-0.000030899998819222674,0.020017800852656364,-0.00005230000169831328],[5,-0.00004350000017439015,0.020024700090289116,-0.0000712000037310645],[6,-0.0000577000027988106,0.020032299682497978,-0.00009180000051856041],[7,-0.00007329999789362773,0.020040400326251984,-0.0001137000072048977],[8,-0.00009000000136438757,0.020048899576067924,-0.0001365000061923638],[9,-0.00010779999865917489,0.0200578011572361,-0.0001598999951966107],[10,-0.00012630000128410757,0.02006700076162815,-0.00018350000027567148],[11,-0.000145500001963228,0.02007630094885826,-0.00020689998927991837],[12,-0.00016500000492669642,0.02008560113608837,-0.0002297000028192997],[13,-0.00018479999562259763,0.02009500004351139,-0.00025170002481900156],[14,-0.00020460000087041408,0.020104100927710533,-0.0002725000085774809],[15,-0.00022430000535678118,0.02011300064623356,-0.00029170000925660133],[16,-0.00024359999224543571,0.0201214998960495,-0.000308899994706735],[17,-0.00026229998911730945,0.020129600539803505,-0.00032369999098591506],[18,-0.0002803000097628683,0.02013709954917431,-0.0003358999965712428],[19,-0.0002974000235553831,0.02014390006661415,-0.0003451000084169209],[20,-0.0003134000289719552,0.020150000229477882,-0.0003507999936118722],[21,-0.0003270000161137432,0.020155100151896477,-0.00035280000884085894],[22,-0.00033740000799298286,0.020159399136900902,-0.0003530000103637576],[23,-0.0003451000084169209,0.02016250044107437,-0.00035319998278282583],[24,-0.00035039999056607485,0.020164400339126587,-0.0003535999858286232],[25,-0.00035379998735152185,0.020165100693702698,-0.0003538999881129712],[27,-0.0003566000086721033,0.020164400339126587,-0.00035429999115876853],[29,-0.0003564000071492046,0.020162401720881462,-0.0003536999865900725],[31,-0.0003538999881129712,0.020159000530838966,-0.00035149999894201756],[32,-0.0003515999997034669,0.020156901329755783,-0.0003496000135783106],[33,-0.0003487000067252666,0.020154500380158424,-0.0003470999945420772],[34,-0.0003451000084169209,0.02015179954469204,-0.0003439000283833593],[35,-0.0003409000055398792,0.020148901268839836,-0.00033989999792538583],[36,-0.00033599999733269215,0.020145699381828308,-0.0003349999897181988],[37,-0.0003305000136606395,0.02014230005443096,-0.0003293000045232475],[38,-0.0003242999955546111,0.02013860084116459,-0.00032289998489432037],[39,-0.0003175000019837171,0.0201347004622221,-0.0003160000196658075],[40,-0.0003100000030826777,0.020130600780248642,-0.00030849999166093767],[41,-0.000301799998851493,0.020126299932599068,-0.00030040001729503274],[42,-0.00029299999005161226,0.020121799781918526,-0.0002919000107795],[43,-0.0002835000050254166,0.020117199048399925,-0.0002829000004567206],[44,-0.00027340001543052495,0.020112300291657448,-0.00027340001543052495],[45,-0.00026259999140165746,0.020107300952076912,-0.00026359999901615083],[46,-0.00025110002025030553,0.020102201029658318,-0.0002533000078983605],[47,-0.0002390000008745119,0.020096899941563606,-0.00024280001525767148],[48,-0.00022620000527240336,0.020091500133275986,-0.00023200000578071922],[49,-0.00021299999207258224,0.020085999742150307,-0.00022090000857133418],[50,-0.0001998000079765916,0.02008030004799366,-0.00020959999528713524],[51,-0.0001866000093286857,0.020074600353837013,-0.00019809999503195286],[52,-0.00017350001144222915,0.020068800076842308,-0.00018640000780578703],[53,-0.0001604999997653067,0.020062899217009544,-0.00017460000526625663],[54,-0.00014760000340174884,0.02005700021982193,-0.0001627000019652769],[55,-0.00013490000856108963,0.020051000639796257,-0.00015079999866429716],[56,-0.00012240000069141388,0.020044900476932526,-0.00013889999536331743],[57,-0.00011020000238204375,0.020038900896906853,-0.00012700000661425292],[58,-0.00009820000559557229,0.02003280073404312,-0.00011510000331327319],[59,-0.00008660000457894057,0.02002670057117939,-0.00010339999425923452],[60,-0.00007539999933214858,0.02002060040831566,-0.00009169999975711107],[61,-0.00006459999713115394,0.020014500245451927,-0.00008019999950192869],[62,-0.00005430000237538479,0.020008599385619164,-0.00006890000076964498],[63,-0.00004450000051292591,0.020003000274300575,-0.00005779999992228113],[64,-0.00003520000245771371,0.019997799769043922,-0.0000470000013592653],[65,-0.000026599998818710446,0.019992999732494354,-0.00003650000144261867],[66,-0.000018500000805943273,0.01998869888484478,-0.000026300000172341242],[67,-0.000011099999937869143,0.01998489908874035,-0.00001650000012887176],[68,-0.000004500000159168849,0.01998160034418106,-0.000007100000402715523],[69,0.00000140000008741481,0.019978901371359825,0.0000018999999156221747],[70,0.000006499999926745659,0.019976800307631493,0.000010400000064691994],[71,0.000010800000382005237,0.01997530087828636,0.000018400000044493936],[72,0.000014200000805431046,0.019974499940872192,0.000025499999537714757],[73,0.000016700001651770435,0.019974401220679283,0.00003140000262646936],[74,0.000018200000340584666,0.01997479982674122,0.00003619999915827066],[75,0.000018700000509852543,0.01997530087828636,0.000039999998989515007],[76,0.000018700000509852543,0.019975900650024414,0.000042900002881651744],[77,0.000018500000805943273,0.019976599141955376,0.000045000000682193786],[79,0.000017899999875226058,0.01997849904000759,0.000047100002120714635],[81,0.000016700001651770435,0.01998100057244301,0.000046700002712896094],[82,0.000015800000255694613,0.01998240128159523,0.00004470000203582458],[83,0.000014800000826653559,0.01998399943113327,0.00004160000025876798],[84,0.000013500000022759195,0.019985700026154518,0.00003760000254260376],[85,0.000011899999663000926,0.019987599924206734,0.00003260000084992498],[86,0.000010099999599333387,0.019989600405097008,0.00002700000004551839],[87,0.000008099999831756577,0.01999170146882534,0.000020700001186924055],[88,0.000005700000201613875,0.01999399997293949,0.000014100000043981709],[89,0.0000029999998787388904,0.01999640092253685,0.000007100000402715523],[90,0,0.019999001175165176,0]]}]},"53":{"name":"AniKame_kamae_normal02_end.gmt","root":"center_n","frames":50,"fps":30,"loop":false,"translation":[{"axis":"xyz","keys":[[0,-0.00514450017362833,0.023865699768066406,0.003291900036856532],[1,-0.005143000278621912,0.023864999413490295,0.003290899796411395],[2,-0.005138299893587828,0.023862700909376144,0.0032876997720450163],[3,-0.005129700060933828,0.023858901113271713,0.0032822999637573957],[4,-0.005116499960422516,0.023853501304984093,0.0032749001402407885],[5,-0.005098100285977125,0.023846400901675224,0.003265300067141652],[6,-0.005073800217360258,0.023837700486183167,0.0032536000944674015],[7,-0.005042999982833862,0.02382720075547695,0.0032398998737335205],[8,-0.005005100276321173,0.02381489984691143,0.0032240001019090414],[9,-0.004959400277584791,0.0238008014857769,0.003206100082024932],[10,-0.004905200097709894,0.023784900084137917,0.003186199814081192],[11,-0.0048420000821352005,0.023767000064253807,0.003164099995046854],[12,-0.0047690002247691154,0.023747099563479424,0.003140100045129657],[13,-0.004685600288212299,0.023725299164652824,0.0031139999628067017],[14,-0.0045912000350654125,0.023701399564743042,0.00308589986525476],[15,-0.004460900090634823,0.023675400763750076,0.003055799985304475],[16,-0.004276299849152565,0.02364729903638363,0.003023700090125203],[17,-0.004046700429171324,0.02361690066754818,0.0029896001797169447],[18,-0.0037811999209225178,0.023584401234984398,0.002953500021249056],[19,-0.0034890000242739916,0.023549599573016167,0.0029154999647289515],[20,-0.0031793999951332808,0.023512501269578934,0.002875500125810504],[21,-0.002861600136384368,0.023473000153899193,0.002833500038832426],[22,-0.0025446999352425337,0.023431099951267242,0.0027739000506699085],[23,-0.0022381001617759466,0.023386700078845024,0.00268330005928874],[24,-0.0019508000696077943,0.023339901119470596,0.0025655000936239958],[25,-0.0016922000795602798,0.023290500044822693,0.0024241001810878515],[26,-0.0014713000273332,0.023238500580191612,0.00226270011626184],[27,-0.0012974999845027924,0.023183900862932205,0.0020850999280810356],[28,-0.001180000021122396,0.023126600310206413,0.0018948999932035804],[29,-0.0010940000647678971,0.023054299876093864,0.0016959001077339053],[30,-0.0010092000011354685,0.022956399247050285,0.0014916000654920936],[31,-0.0009257000056095421,0.022835901007056236,0.001285900012589991],[32,-0.0008438999648205936,0.022695500403642654,0.0010821999749168754],[33,-0.0007641000556759536,0.022538000717759132,0.0008844000403769314],[34,-0.0006866000476293266,0.022366400808095932,0.0006961000035516918],[35,-0.000611600000411272,0.022183401510119438,0.0005210000090301037],[36,-0.0005396000342443585,0.021991800516843796,0.00036269999691285193],[37,-0.00047070003347471356,0.021794600412249565,0.00022489999537356198],[38,-0.00040530000114813447,0.021594401448965073,0.00011139999696752056],[39,-0.00034370002686046064,0.02139430120587349,0.00002570000106061343],[40,-0.0002860999957192689,0.021196899935603142,-0.00002840000161086209],[41,-0.00023290001263376325,0.02100509963929653,-0.00004720000288216397],[42,-0.0001843999925768003,0.02082180045545101,-0.000044900003558723256],[43,-0.00014080000983085483,0.020649699494242668,-0.000038800000766059384],[44,-0.00010250000195810571,0.02049179933965206,-0.00003020000076503493],[45,-0.0000698000003467314,0.020350800827145576,-0.000020500001483014785],[46,-0.000042900002881651744,0.020229600369930267,-0.000010900000233959872],[47,-0.000022199999875738285,0.020130999386310577,-0.0000027000000955013093],[48,-0.000007900000127847306,0.0200578011572361,0.0000027000000955013093],[49,-4.0000000467443897e-7,0.02001280151307583,0.000003999999989900971],[50,0,0.019999001175165176,0]]}]},"54":{"name":"AniKame_kamae_normal02_loop.gmt","root":"center_n","frames":80,"fps":30,"loop":true,"translation":[{"axis":"xyz","keys":[[0,-0.00514450017362833,0.023865699768066406,0.003291900036856532],[1,-0.005145700182765722,0.023865699768066406,0.0032924001570791006],[2,-0.005149200093001127,0.023865699768066406,0.003293899819254875],[3,-0.00515480013564229,0.023865699768066406,0.0032965000718832016],[4,-0.00516240019351244,0.023865699768066406,0.0033002998679876328],[5,-0.005171800032258034,0.023865699768066406,0.003305500140413642],[6,-0.0051828003488481045,0.023865699768066406,0.003312100190669298],[7,-0.005195199977606535,0.023865699768066406,0.0033202997874468565],[8,-0.005208800081163645,0.023865699768066406,0.003330100094899535],[9,-0.005223599728196859,0.023865699768066406,0.0033418000675737858],[10,-0.005239199846982956,0.023865699768066406,0.0033553000539541245],[11,-0.005255499854683876,0.023865699768066406,0.0033711001742631197],[12,-0.005272400099784136,0.023865699768066406,0.0033893000800162554],[13,-0.005289699882268906,0.023865699768066406,0.00340970023535192],[14,-0.005307100247591734,0.023865699768066406,0.0034318999387323856],[15,-0.005324599798768759,0.023865699768066406,0.0034556002356112003],[16,-0.005341900046914816,0.023865699768066406,0.0034805999603122473],[17,-0.005358799826353788,0.023865699768066406,0.003506600158289075],[18,-0.005375300068408251,0.023865699768066406,0.003533200128003955],[19,-0.005391099955886602,0.023865699768066406,0.0035601002164185047],[20,-0.0054060001857578754,0.023865699768066406,0.0035872000735253096],[21,-0.0054199001751840115,0.023865699768066406,0.0036139998119324446],[22,-0.005432500038295984,0.023865699768066406,0.0036404000129550695],[23,-0.005443799775093794,0.023865699768066406,0.003665899857878685],[24,-0.005453500431030989,0.023865699768066406,0.003690300276502967],[25,-0.005461399909108877,0.023865699768066406,0.0037133998703211546],[26,-0.005468200426548719,0.023865699768066406,0.003734799800440669],[27,-0.005474400240927935,0.023865699768066406,0.003754200180992484],[28,-0.0054800002835690975,0.023865699768066406,0.0037712999619543552],[29,-0.005485100205987692,0.023865699768066406,0.0037859000731259584],[30,-0.005489800125360489,0.023865699768066406,0.003798500169068575],[31,-0.0054939002729952335,0.023865699768066406,0.003809800138697028],[32,-0.005497700069099665,0.023865699768066406,0.003819800214841962],[33,-0.005500999744981527,0.023865699768066406,0.0038288000505417585],[34,-0.00550389988347888,0.023865699768066406,0.003836600109934807],[35,-0.005506400018930435,0.023865699768066406,0.0038435000460594893],[36,-0.005508600268512964,0.023865699768066406,0.0038493999745696783],[37,-0.00551050016656518,0.023865699768066406,0.003854400012642145],[38,-0.005512100178748369,0.023865699768066406,0.0038587001617997885],[39,-0.005513399839401245,0.023865699768066406,0.0038622000720351934],[40,-0.005514400079846382,0.023865699768066406,0.0038649998605251312],[41,-0.005515200085937977,0.023865699768066406,0.003867299994453788],[43,-0.005516299977898598,0.023865699768066406,0.0038702997844666243],[47,-0.005515200085937977,0.023865699768066406,0.003872200148180127],[48,-0.005510599818080664,0.023865699768066406,0.0038723000325262547],[49,-0.0055033001117408276,0.023865699768066406,0.0038723000325262547],[50,-0.005493500269949436,0.023865699768066406,0.0038705000188201666],[51,-0.005481500178575516,0.023865699768066406,0.0038653002120554447],[52,-0.0054675000719726086,0.023865699768066406,0.0038570002652704716],[53,-0.005451799836009741,0.023865699768066406,0.003845800179988146],[54,-0.005434700287878513,0.023865699768066406,0.003831899957731366],[55,-0.00541649991646409,0.023865699768066406,0.0038155000656843185],[56,-0.005397300235927105,0.023865699768066406,0.0037969001568853855],[57,-0.005377400200814009,0.023865699768066406,0.003776300000026822],[58,-0.005357199814170599,0.023865699768066406,0.003753900295123458],[59,-0.0053368001244962215,0.023865699768066406,0.0037301001138985157],[60,-0.005316599737852812,0.023865699768066406,0.0037048999220132828],[61,-0.005296799819916487,0.023865699768066406,0.0036786999553442],[62,-0.005277600139379501,0.023865699768066406,0.0036517002154141665],[63,-0.0052593001164495945,0.023865699768066406,0.0036241000052541494],[64,-0.0052420999854803085,0.023865699768066406,0.003596099792048335],[65,-0.005226499866694212,0.023865699768066406,0.0035681002773344517],[66,-0.005212500225752592,0.023865699768066406,0.003540100296959281],[67,-0.0052004000172019005,0.023865699768066406,0.0035124998539686203],[68,-0.005190600175410509,0.023865699768066406,0.0034855001140385866],[69,-0.00518239988014102,0.023865699768066406,0.003459300147369504],[70,-0.005175100173801184,0.023865699768066406,0.0034341998398303986],[71,-0.005168800242245197,0.023865699768066406,0.0034103000070899725],[72,-0.005163199733942747,0.023865699768066406,0.0033879000693559647],[73,-0.005158500280231237,0.023865699768066406,0.003367400262504816],[74,-0.005154500249773264,0.023865699768066406,0.0033488001208752394],[75,-0.005151300225406885,0.023865699768066406,0.003332399995997548],[76,-0.005148699972778559,0.023865699768066406,0.003318399889394641],[77,-0.005146800074726343,0.023865699768066406,0.003307199804112315],[78,-0.00514549994841218,0.023865699768066406,0.003298899857327342],[79,-0.005144699942320585,0.023865699768066406,0.003293700283393264],[80,-0.00514450017362833,0.023865699768066406,0.003291900036856532]]}]},"55":{"name":"AniKame_kamae_normal02_st.gmt","root":"center_n","frames":50,"fps":30,"loop":false,"translation":[{"axis":"xyz","keys":[[0,0,0.019999001175165176,0],[1,-0.0000380000019504223,0.020132001489400864,0.00003070000093430281],[2,-0.00013380000018514693,0.02045859955251217,0.0001258000120287761],[3,-0.0002696000155992806,0.020878499373793602,0.0002682000049389899],[4,-0.000427500024670735,0.0212910994887352,0.000440800009528175],[5,-0.0005898000090382993,0.021595999598503113,0.000626400054898113],[6,-0.0008456000359728932,0.021814201027154922,0.0008080000407062471],[7,-0.0012595000443980098,0.022031700238585472,0.0009684000397101045],[8,-0.0017774001462385058,0.022244900465011597,0.0010906000388786197],[9,-0.002344900043681264,0.0224504005163908,0.0011810000287368894],[10,-0.0029076000209897757,0.02264470048248768,0.0012583000352606177],[11,-0.0034113002475351095,0.022824300453066826,0.001323399948887527],[12,-0.0038017001934349537,0.022985799238085747,0.0013773000100627542],[13,-0.004024399910122156,0.023125700652599335,0.0014211999950930476],[14,-0.004144500009715557,0.023240601643919945,0.001455900026485324],[15,-0.004262200091034174,0.023326901718974113,0.0014825001126155257],[16,-0.0043762000277638435,0.023381201550364494,0.0015021000290289521],[17,-0.0044848001562058926,0.02340009994804859,0.0015157000161707401],[18,-0.0045865001156926155,0.023399701341986656,0.0015242000808939338],[19,-0.004679800011217594,0.02339860051870346,0.0015286999987438321],[20,-0.004763099830597639,0.023396899923682213,0.0015302000101655722],[21,-0.004835100378841162,0.023394400253891945,0.0015298000071197748],[22,-0.0048940000124275684,0.023391401395201683,0.001528399996459484],[23,-0.004938500002026558,0.02338780090212822,0.0015267999842762947],[24,-0.00496690021827817,0.023383600637316704,0.0015248999698087573],[25,-0.004986200015991926,0.023378899320960045,0.0015227999538183212],[26,-0.005004100035876036,0.0233738012611866,0.0015204999363049865],[27,-0.005020699929445982,0.023368200287222862,0.0015183000359684229],[28,-0.0050361002795398235,0.02331790141761303,0.0015160000184550881],[29,-0.005050200037658215,0.02321450039744377,0.0015138000017032027],[30,-0.005063199903815985,0.023112600669264793,0.0015116999857127666],[31,-0.005074999760836363,0.023066600784659386,0.0015099000884220004],[32,-0.005085700191557407,0.02311040088534355,0.0015084000770002604],[33,-0.005095399916172028,0.02321770042181015,0.0015072000678628683],[34,-0.005104099866002798,0.02335200086236,0.0015064000617712736],[35,-0.005111800041049719,0.023476900532841682,0.0015061000594869256],[36,-0.005118499975651503,0.023555999621748924,0.001559399999678135],[37,-0.005124400369822979,0.023601500317454338,0.0017040999373421073],[38,-0.005129500292241573,0.023648401722311974,0.0019172000465914607],[39,-0.005133700091391802,0.023695100098848343,0.002176100155338645],[40,-0.005137200001627207,0.02373960055410862,0.0024578000884503126],[41,-0.005139899905771017,0.02378010004758835,0.0027395000215619802],[42,-0.005142000038176775,0.02381480112671852,0.002998300129547715],[43,-0.005143399816006422,0.023841900750994682,0.003211500123143196],[44,-0.005144200287759304,0.023859499022364616,0.0033560998272150755],[45,-0.00514450017362833,0.023865699768066406,0.0034093998838216066],[46,-0.00514450017362833,0.023865699768066406,0.003397200023755431],[47,-0.00514450017362833,0.023865699768066406,0.0033681001514196396],[48,-0.00514450017362833,0.023865699768066406,0.003333300119265914],[49,-0.00514450017362833,0.023865699768066406,0.0033042000140994787],[50,-0.00514450017362833,0.023865699768066406,0.003291900036856532]]}]},"56":{"name":"AniKame_kamae_normal03_end.gmt","root":"center_n","frames":50,"fps":30,"loop":false,"translation":[{"axis":"xyz","keys":[[0,-0.00514450017362833,0.023865699768066406,0.003291900036856532],[1,-0.005143000278621912,0.023864999413490295,0.003290899796411395],[2,-0.005138299893587828,0.023862700909376144,0.0032876997720450163],[3,-0.005129700060933828,0.023858901113271713,0.0032822999637573957],[4,-0.005116499960422516,0.023853501304984093,0.0032749001402407885],[5,-0.005098100285977125,0.023846400901675224,0.003265300067141652],[6,-0.005073800217360258,0.023837700486183167,0.0032536000944674015],[7,-0.005042999982833862,0.02382720075547695,0.0032398998737335205],[8,-0.005005100276321173,0.02381489984691143,0.0032240001019090414],[9,-0.004959400277584791,0.0238008014857769,0.003206100082024932],[10,-0.004905200097709894,0.023784900084137917,0.003186199814081192],[11,-0.0048420000821352005,0.023767000064253807,0.003164099995046854],[12,-0.0047690002247691154,0.023747099563479424,0.003140100045129657],[13,-0.004685600288212299,0.023725299164652824,0.0031139999628067017],[14,-0.0045912000350654125,0.023701399564743042,0.00308589986525476],[15,-0.004460900090634823,0.023675400763750076,0.003055799985304475],[16,-0.004276299849152565,0.02364729903638363,0.003023700090125203],[17,-0.004046700429171324,0.02361690066754818,0.0029896001797169447],[18,-0.0037811999209225178,0.023584401234984398,0.002953500021249056],[19,-0.0034890000242739916,0.023549599573016167,0.0029154999647289515],[20,-0.0031793999951332808,0.023512501269578934,0.002875500125810504],[21,-0.002861600136384368,0.023473000153899193,0.002833500038832426],[22,-0.0025446999352425337,0.023431099951267242,0.0027739000506699085],[23,-0.0022381001617759466,0.023386700078845024,0.00268330005928874],[24,-0.0019508000696077943,0.023339901119470596,0.0025655000936239958],[25,-0.0016922000795602798,0.023290500044822693,0.0024241001810878515],[26,-0.0014713000273332,0.023238500580191612,0.00226270011626184],[27,-0.0012974999845027924,0.023183900862932205,0.0020850999280810356],[28,-0.001180000021122396,0.023126600310206413,0.0018948999932035804],[29,-0.0010940000647678971,0.023054299876093864,0.0016959001077339053],[30,-0.0010092000011354685,0.022956399247050285,0.0014916000654920936],[31,-0.0009257000056095421,0.022835901007056236,0.001285900012589991],[32,-0.0008438999648205936,0.022695500403642654,0.0010821999749168754],[33,-0.0007641000556759536,0.022538000717759132,0.0008844000403769314],[34,-0.0006866000476293266,0.022366400808095932,0.0006961000035516918],[35,-0.000611600000411272,0.022183401510119438,0.0005210000090301037],[36,-0.0005396000342443585,0.021991800516843796,0.00036269999691285193],[37,-0.00047070003347471356,0.021794600412249565,0.00022489999537356198],[38,-0.00040530000114813447,0.021594401448965073,0.00011139999696752056],[39,-0.00034370002686046064,0.02139430120587349,0.00002570000106061343],[40,-0.0002860999957192689,0.021196899935603142,-0.00002840000161086209],[41,-0.00023290001263376325,0.02100509963929653,-0.00004720000288216397],[42,-0.0001843999925768003,0.02082180045545101,-0.000044900003558723256],[43,-0.00014080000983085483,0.020649699494242668,-0.000038800000766059384],[44,-0.00010250000195810571,0.02049179933965206,-0.00003020000076503493],[45,-0.0000698000003467314,0.020350800827145576,-0.000020500001483014785],[46,-0.000042900002881651744,0.020229600369930267,-0.000010900000233959872],[47,-0.000022199999875738285,0.020130999386310577,-0.0000027000000955013093],[48,-0.000007900000127847306,0.0200578011572361,0.0000027000000955013093],[49,-4.0000000467443897e-7,0.02001280151307583,0.000003999999989900971],[50,0,0.019999001175165176,0]]}]},"57":{"name":"AniKame_kamae_normal03_loop.gmt","root":"center_n","frames":80,"fps":30,"loop":true,"translation":[{"axis":"xyz","keys":[[0,-0.00514450017362833,0.023865699768066406,0.003291900036856532],[1,-0.005143600050359964,0.023865699768066406,0.0032924001570791006],[2,-0.005141000263392925,0.023865699768066406,0.003293899819254875],[3,-0.005136900115758181,0.023865699768066406,0.0032965000718832016],[4,-0.005131400190293789,0.023865699768066406,0.0033002998679876328],[5,-0.005124600138515234,0.023865699768066406,0.003305500140413642],[6,-0.005116700194776058,0.023865699768066406,0.003312100190669298],[7,-0.005107800010591745,0.023865699768066406,0.0033202997874468565],[8,-0.005098100285977125,0.023865699768066406,0.003330100094899535],[9,-0.005087700206786394,0.023865699768066406,0.0033418000675737858],[10,-0.005076700355857611,0.023865699768066406,0.0033553000539541245],[11,-0.005065300036221743,0.023865699768066406,0.0033711001742631197],[12,-0.0050535001792013645,0.023865699768066406,0.0033893000800162554],[13,-0.005041699856519699,0.023865699768066406,0.00340970023535192],[14,-0.005029800347983837,0.023865699768066406,0.0034318999387323856],[15,-0.005018000025302172,0.023865699768066406,0.0034556002356112003],[16,-0.00500650005415082,0.023865699768066406,0.0034805999603122473],[17,-0.004995400086045265,0.023865699768066406,0.003506600158289075],[18,-0.004984899889677763,0.023865699768066406,0.003533200128003955],[19,-0.0049749999307096004,0.023865699768066406,0.0035601002164185047],[20,-0.004966000095009804,0.023865699768066406,0.0035872000735253096],[21,-0.004957899916917086,0.023865699768066406,0.0036139998119324446],[22,-0.004950900096446276,0.023865699768066406,0.0036404000129550695],[23,-0.004945199936628342,0.023865699768066406,0.003665899857878685],[24,-0.0049402001313865185,0.023865699768066406,0.003690300276502967],[25,-0.004935299977660179,0.023865699768066406,0.0037133998703211546],[26,-0.004930600058287382,0.023865699768066406,0.003734799800440669],[27,-0.004926000256091356,0.023865699768066406,0.003754200180992484],[28,-0.004921599756926298,0.023865699768066406,0.0037712999619543552],[29,-0.00491739995777607,0.023865699768066406,0.0037859000731259584],[30,-0.004913299810141325,0.023865699768066406,0.003798500169068575],[31,-0.004909399896860123,0.023865699768066406,0.003809800138697028],[32,-0.004905800335109234,0.023865699768066406,0.003819800214841962],[33,-0.004902299959212542,0.023865699768066406,0.0038288000505417585],[34,-0.004899000283330679,0.023865699768066406,0.003836600109934807],[35,-0.004896000027656555,0.023865699768066406,0.0038435000460594893],[36,-0.004893200006335974,0.023865699768066406,0.0038493999745696783],[37,-0.004890599753707647,0.023865699768066406,0.003854400012642145],[38,-0.0048882002010941505,0.023865699768066406,0.0038587001617997885],[39,-0.004886100068688393,0.023865699768066406,0.0038622000720351934],[40,-0.004884300287812948,0.023865699768066406,0.0038649998605251312],[41,-0.004882700275629759,0.023865699768066406,0.003867299994453788],[43,-0.004880399908870459,0.023865699768066406,0.0038702997844666243],[47,-0.004880100023001432,0.023865699768066406,0.003872200148180127],[48,-0.004883100278675556,0.023865699768066406,0.0038723000325262547],[49,-0.004887999966740608,0.023865699768066406,0.0038723000325262547],[50,-0.004894500132650137,0.023865699768066406,0.0038705000188201666],[51,-0.004902600310742855,0.023865699768066406,0.0038653002120554447],[52,-0.004912000149488449,0.023865699768066406,0.0038570002652704716],[53,-0.004922499880194664,0.023865699768066406,0.003845800179988146],[54,-0.004934099968522787,0.023865699768066406,0.003831899957731366],[55,-0.004946600180119276,0.023865699768066406,0.0038155000656843185],[56,-0.004959700163453817,0.023865699768066406,0.0037969001568853855],[57,-0.004973300267010927,0.023865699768066406,0.003776300000026822],[58,-0.004987299907952547,0.023865699768066406,0.003753900295123458],[59,-0.005001499783247709,0.023865699768066406,0.0037301001138985157],[60,-0.005015700124204159,0.023865699768066406,0.0037048999220132828],[61,-0.005029800347983837,0.023865699768066406,0.0036786999553442],[62,-0.005043600220233202,0.023865699768066406,0.0036517002154141665],[63,-0.005056900437921286,0.023865699768066406,0.0036241000052541494],[64,-0.005069599952548742,0.023865699768066406,0.003596099792048335],[65,-0.005081500392407179,0.023865699768066406,0.0035681002773344517],[66,-0.005092400126159191,0.023865699768066406,0.003540100296959281],[67,-0.005102300085127354,0.023865699768066406,0.0035124998539686203],[68,-0.005110799800604582,0.023865699768066406,0.0034855001140385866],[69,-0.005118099972605705,0.023865699768066406,0.003459300147369504],[70,-0.005124300252646208,0.023865699768066406,0.0034341998398303986],[71,-0.005129400175064802,0.023865699768066406,0.0034103000070899725],[72,-0.005133600439876318,0.023865699768066406,0.0033879000693559647],[73,-0.005136900115758181,0.023865699768066406,0.003367400262504816],[74,-0.00513949990272522,0.023865699768066406,0.0033488001208752394],[75,-0.005141400266438723,0.023865699768066406,0.003332399995997548],[76,-0.0051426999270915985,0.023865699768066406,0.003318399889394641],[77,-0.005143600050359964,0.023865699768066406,0.003307199804112315],[78,-0.005144200287759304,0.023865699768066406,0.003298899857327342],[79,-0.005144400056451559,0.023865699768066406,0.003293700283393264],[80,-0.00514450017362833,0.023865699768066406,0.003291900036856532]]}]},"58":{"name":"AniKame_kamae_normal03_st.gmt","root":"center_n","frames":50,"fps":30,"loop":false,"translation":[{"axis":"xyz","keys":[[0,0,0.019999001175165176,0],[1,-0.0000380000019504223,0.020132001489400864,0.00003070000093430281],[2,-0.00013380000018514693,0.02045859955251217,0.0001258000120287761],[3,-0.0002696000155992806,0.020878499373793602,0.0002682000049389899],[4,-0.000427500024670735,0.0212910994887352,0.000440800009528175],[5,-0.0005898000090382993,0.021595999598503113,0.000626400054898113],[6,-0.0008456000359728932,0.021814201027154922,0.0008080000407062471],[7,-0.0012595000443980098,0.022031700238585472,0.0009684000397101045],[8,-0.0017774001462385058,0.022244900465011597,0.0010906000388786197],[9,-0.002344900043681264,0.0224504005163908,0.0011810000287368894],[10,-0.0029076000209897757,0.02264470048248768,0.0012583000352606177],[11,-0.0034113002475351095,0.022824300453066826,0.001323399948887527],[12,-0.0038017001934349537,0.022985799238085747,0.0013773000100627542],[13,-0.004024399910122156,0.023125700652599335,0.0014211999950930476],[14,-0.004144500009715557,0.023240601643919945,0.001455900026485324],[15,-0.004262200091034174,0.023326901718974113,0.0014825001126155257],[16,-0.0043762000277638435,0.023381201550364494,0.0015021000290289521],[17,-0.0044848001562058926,0.02340009994804859,0.0015157000161707401],[18,-0.0045865001156926155,0.023399701341986656,0.0015242000808939338],[19,-0.004679800011217594,0.02339860051870346,0.0015286999987438321],[20,-0.004763099830597639,0.023396899923682213,0.0015302000101655722],[21,-0.004835100378841162,0.023394400253891945,0.0015298000071197748],[22,-0.0048940000124275684,0.023391401395201683,0.001528399996459484],[23,-0.004938500002026558,0.02338780090212822,0.0015267999842762947],[24,-0.00496690021827817,0.023383600637316704,0.0015248999698087573],[25,-0.004986200015991926,0.023378899320960045,0.0015227999538183212],[26,-0.005004100035876036,0.0233738012611866,0.0015204999363049865],[27,-0.005020699929445982,0.023368200287222862,0.0015183000359684229],[28,-0.0050361002795398235,0.02331790141761303,0.0015160000184550881],[29,-0.005050200037658215,0.02321450039744377,0.0015138000017032027],[30,-0.005063199903815985,0.023112600669264793,0.0015116999857127666],[31,-0.005074999760836363,0.023066600784659386,0.0015099000884220004],[32,-0.005085700191557407,0.02311040088534355,0.0015084000770002604],[33,-0.005095399916172028,0.02321770042181015,0.0015072000678628683],[34,-0.005104099866002798,0.02335200086236,0.0015064000617712736],[35,-0.005111800041049719,0.023476900532841682,0.0015061000594869256],[36,-0.005118499975651503,0.023555999621748924,0.001559399999678135],[37,-0.005124400369822979,0.023601500317454338,0.0017040999373421073],[38,-0.005129500292241573,0.023648401722311974,0.0019172000465914607],[39,-0.005133700091391802,0.023695100098848343,0.002176100155338645],[40,-0.005137200001627207,0.02373960055410862,0.0024578000884503126],[41,-0.005139899905771017,0.02378010004758835,0.0027395000215619802],[42,-0.005142000038176775,0.02381480112671852,0.002998300129547715],[43,-0.005143399816006422,0.023841900750994682,0.003211500123143196],[44,-0.005144200287759304,0.023859499022364616,0.0033560998272150755],[45,-0.00514450017362833,0.023865699768066406,0.0034093998838216066],[46,-0.00514450017362833,0.023865699768066406,0.003397200023755431],[47,-0.00514450017362833,0.023865699768066406,0.0033681001514196396],[48,-0.00514450017362833,0.023865699768066406,0.003333300119265914],[49,-0.00514450017362833,0.023865699768066406,0.0033042000140994787],[50,-0.00514450017362833,0.023865699768066406,0.003291900036856532]]}]},"59":{"name":"AniKame_kubi_end.gmt","root":"center_n","frames":70,"fps":30,"loop":false,"translation":[{"axis":"xyz","keys":[[0,0,0.019122600555419922,0],[15,0,0.019122600555419922,0],[16,0.00000560000034965924,0.01915140077471733,-0.00007360000017797574],[17,0.000021100000594742596,0.019228899851441383,-0.00027630000840872526],[18,0.000045000000682193786,0.019341999664902687,-0.0005812000017613173],[19,0.00007560000085504726,0.019477300345897675,-0.0009612999856472015],[20,0.00011119999544462189,0.01962140016257763,-0.0013895001029595733],[21,0.00015010000788606703,0.01976120099425316,-0.001838900032453239],[22,0.00019069999689236283,0.019883399829268456,-0.0022824001498520374],[23,0.00023119999968912452,0.01997460052371025,-0.002693100133910775],[24,0.0002702000201679766,0.020021600648760796,-0.0030459000263363123],[25,0.0003056999994441867,0.020042400807142258,-0.003337699919939041],[26,0.00033629999961704016,0.020063800737261772,-0.0035741000901907682],[27,0.00036020000698044896,0.02008560113608837,-0.003761000232771039],[28,0.0003758000093512237,0.02010750025510788,-0.003904100274667144],[29,0.00038129999302327633,0.02012930065393448,-0.004009199794381857],[30,0.0003782999992836267,0.02015089988708496,-0.004081999883055687],[31,0.0003693999897222966,0.02017190121114254,-0.004128399770706892],[32,0.0003555000002961606,0.020192300900816917,-0.004153999965637922],[33,0.0003370000049471855,0.020211700350046158,-0.004164600279182196],[34,0.00031460000900551677,0.020230000838637352,-0.004166100174188614],[35,0.000288800016278401,0.020246900618076324,-0.004106299951672554],[36,0.00026030000299215317,0.020262299105525017,-0.003939000423997641],[37,0.0002297000028192997,0.0202759001404047,-0.0036784999538213015],[38,0.00019749999046325684,0.02028750069439411,-0.003339099930599332],[39,0.00016450000111944973,0.02029689960181713,-0.002935199998319149],[40,0.00013109999417793006,0.02030390128493309,-0.002481200033798814],[41,0.00009790000331122428,0.020308200269937515,-0.0019914000295102596],[42,0.00006569999823113903,0.020309699699282646,-0.0014801999786868691],[43,0.0000349000001733657,0.02030850015580654,-0.0009618000476621091],[44,0.000006199999916134402,0.020304901525378227,-0.00045070002670399845],[45,-0.000019799999790848233,0.02029920183122158,0.000038800000766059384],[46,-0.000042499999835854396,0.02029160037636757,0.0004923000233247876],[47,-0.00006140000186860561,0.0202821996062994,0.0008956000092439353],[48,-0.00007570000161649659,0.02027120068669319,0.0012342000845819712],[49,-0.00008499999967170879,0.02025880105793476,0.0014938999665901065],[50,-0.00008859999798005447,0.020245200023055077,0.0016602000687271357],[51,-0.0000883999964571558,0.020230600610375404,0.001718799932859838],[52,-0.00008689999958733097,0.020215099677443504,0.0017053000628948212],[53,-0.00008430000161752105,0.020198900252580643,0.0016666001174598932],[54,-0.00008069999603321776,0.020182199776172638,0.0016057000029832125],[55,-0.00007619999814778566,0.020165201276540756,0.0015255000907927752],[56,-0.00007100000220816582,0.020148200914263725,0.001429000054486096],[57,-0.00006510000093840063,0.020131101831793785,0.001319000031799078],[58,-0.000058900001022266224,0.02011439949274063,0.0011986000463366508],[59,-0.00005230000169831328,0.020097998902201653,0.001070600003004074],[60,-0.000045600001612911,0.020082300528883934,0.0009379000402987003],[61,-0.000038800000766059384,0.020067300647497177,0.0008035000646486878],[62,-0.00003220000144210644,0.020053399726748466,0.0006703000399284065],[63,-0.00002579999818408396,0.02004059962928295,0.0005412999889813364],[64,-0.000019799999790848233,0.0200290996581316,0.00041939999209716916],[65,-0.000014299999747890979,0.020019201561808586,0.00030739998328499496],[66,-0.000009500000487605575,0.020011000335216522,0.00020840000070165843],[67,-0.00000560000034965924,0.020004700869321823,0.0001252000074600801],[68,-0.0000026000000161729986,0.020000500604510307,0.00006079999729990959],[69,-7.00000043707405e-7,0.019998500123620033,0.00001809999957913533],[70,0,0.019999001175165176,0]]}]},"60":{"name":"AniKame_kubi_loop.gmt","root":"center_n","frames":10,"fps":30,"loop":true,"translation":[{"axis":"y","keys":[[0,0.019122600555419922]]}]},"61":{"name":"AniKame_kubi_st.gmt","root":"center_n","frames":80,"fps":30,"loop":false,"translation":[{"axis":"xyz","keys":[[0,0,0.019999001175165176,0],[1,0.0000197000008483883,0.01999260112643242,4.999999987376214e-7],[2,0.00007159999950090423,0.019974499940872192,0.0000018999999156221747],[3,0.0001449999981559813,0.019945800304412842,0.000003900000137946336],[4,0.000229199999012053,0.019908001646399498,0.000006300000222836388],[5,0.0003134000289719552,0.019862201064825058,0.000009000000318337698],[6,0.0003870000073220581,0.019809700548648834,0.00001160000010713702],[7,0.0004391999973449856,0.019752001389861107,0.000014000000192027073],[8,0.0004594000056385994,0.019690100103616714,0.000015999999959603883],[9,0.00044720000005327165,0.019625499844551086,0.00001739999970595818],[10,0.0004126999992877245,0.019559500738978386,0.000017899999875226058],[11,0.00036020000698044896,0.019493399187922478,0.00001739999970595818],[12,0.00029429999995045364,0.019428800791502,0.000015999999959603883],[13,0.00021939999714959413,0.019367000088095665,0.000014000000192027073],[14,0.00014000000373926014,0.01930920034646988,0.00001160000010713702],[15,0.00006060000305296853,0.019256800413131714,0.000009000000318337698],[16,-0.000014500000361294951,0.019210999831557274,0.000006300000222836388],[17,-0.00008060000254772604,0.01917310059070587,0.000003900000137946336],[18,-0.00013330001092981547,0.01914449967443943,0.0000018999999156221747],[19,-0.00016830000095069408,0.019126301631331444,4.999999987376214e-7],[20,-0.00018090000958181918,0.019120000302791595,0],[21,-0.0001745000045048073,0.019120000302791595,0],[22,-0.00015740000526420772,0.019120000302791595,0],[23,-0.0001326000055996701,0.019120000302791595,0],[24,-0.00010339999425923452,0.019120000302791595,0],[25,-0.00007280000136233866,0.019120100885629654,0],[26,-0.00004410000110510737,0.019120100885629654,0],[27,-0.00002029999996011611,0.019120100885629654,0],[28,-0.000004500000159168849,0.019120100885629654,0],[29,0,0.019120199605822563,0],[65,0,0.019122200086712837,0],[80,0,0.019122600555419922,0]]}]},"62":{"name":"AniKame_run.gmt","root":"center_n","frames":20,"fps":30,"loop":true,"translation":[{"axis":"xyz","keys":[[0,0.005000000353902578,0.0222191009670496,0],[1,0.004421799909323454,0.022290801629424095,0.005009799730032682],[2,0.0033895999658852816,0.023090001195669174,0.010015799663960934],[3,0.0020463999826461077,0.023280400782823563,0.015015700832009315],[4,0.0005355000030249357,0.023381900042295456,0.020009798929095268],[5,-0.0010000000474974513,0.02341189980506897,0.02500000037252903],[6,-0.002421900164335966,0.023409299552440643,0.0299903005361557],[7,-0.003625700017437339,0.02338789962232113,0.03498440235853195],[8,-0.004518500063568354,0.023326799273490906,0.03998459875583649],[9,-0.005007599946111441,0.02320539951324463,0.044990502297878265],[10,-0.005000000353902578,0.0222191009670496,0.05000000074505806],[11,-0.004432400222867727,0.022290801629424095,0.05500950291752815],[12,-0.003401499940082431,0.022703399881720543,0.060015399008989334],[13,-0.0020542999263852835,0.02312990091741085,0.06501560658216476],[14,-0.0005381000228226185,0.02333099953830242,0.07000970095396042],[15,0.0010000000474974513,0.02341189980506897,0.07500000298023224],[16,0.0024244999513030052,0.023409299552440643,0.0799902006983757],[17,0.0036336001940071583,0.02338789962232113,0.08498430252075195],[18,0.004530400037765503,0.023326799273490906,0.08998420089483261],[19,0.005018200259655714,0.02320539951324463,0.09499020129442215],[20,0.005000000353902578,0.0222191009670496,0.10000000149011612]]}]},"63":{"name":"AniKame_walk.gmt","root":"center_n","frames":40,"fps":30,"loop":true,"translation":[{"axis":"xyz","keys":[[0,0,0.020289501175284386,-0.00010000000474974513],[1,-0.00015100000018719584,0.020298799499869347,0.0006000000284984708],[2,-0.00029830000130459666,0.020361199975013733,0.0013000000035390258],[3,-0.0004391999973449856,0.020565500482916832,0.0042500002309679985],[4,-0.0005706000374630094,0.020848900079727173,0.007199999876320362],[5,-0.0006898000137880445,0.0210363008081913,0.010149999521672726],[6,-0.0007937000482343137,0.021108699962496758,0.013100000098347664],[7,-0.0008796000038273633,0.021163901314139366,0.016050001606345177],[8,-0.0009445999749004841,0.021202700212597847,0.01899999938905239],[9,-0.000985700055025518,0.021225599572062492,0.021950000897049904],[10,-0.0010000000474974513,0.021233100444078445,0.024900000542402267],[11,-0.0009849000489339232,0.02123129926621914,0.02785000018775463],[12,-0.0009419000125490129,0.021224500611424446,0.030799999833106995],[13,-0.0008744999649934471,0.021209999918937683,0.03375000134110451],[14,-0.0007857999880798161,0.02118539996445179,0.03670000284910202],[15,-0.0006794999935664237,0.021148299798369408,0.039650000631809235],[16,-0.0005587000050581992,0.02109619975090027,0.04260000213980675],[17,-0.00042710002162493765,0.021026600152254105,0.04554999992251396],[18,-0.00028780000866390765,0.02080029994249344,0.048500001430511475],[19,-0.00014430000737775117,0.0204630009829998,0.04920000210404396],[20,0,0.020289501175284386,0.04990000277757645],[21,0.00014430000737775117,0.020298799499869347,0.050599999725818634],[22,0.00028780000866390765,0.020361199975013733,0.05130000039935112],[23,0.00042710002162493765,0.020565500482916832,0.05425000190734863],[24,0.0005587000050581992,0.020848900079727173,0.057200003415346146],[25,0.0006794999935664237,0.0210363008081913,0.06014999747276306],[26,0.0007857999880798161,0.021108699962496758,0.06310000270605087],[27,0.0008744999649934471,0.021163901314139366,0.06605000048875809],[28,0.0009419000125490129,0.021202700212597847,0.0689999982714653],[29,0.0009849000489339232,0.021225599572062492,0.07195000350475311],[30,0.0010000000474974513,0.021233100444078445,0.07490000128746033],[31,0.000985700055025518,0.02123129926621914,0.07785000652074814],[32,0.0009445999749004841,0.021224500611424446,0.08080000430345535],[33,0.0008796000038273633,0.021209999918937683,0.08375000208616257],[34,0.0007937000482343137,0.02118539996445179,0.08669999986886978],[35,0.0006898000137880445,0.021148299798369408,0.089649997651577],[36,0.0005706000374630094,0.02109619975090027,0.09260000288486481],[37,0.0004391999973449856,0.021026600152254105,0.09555000066757202],[38,0.00029830000130459666,0.02080029994249344,0.09850000590085983],[39,0.00015100000018719584,0.0204630009829998,0.09920000284910202],[40,0,0.020289501175284386,0.09989999979734421]]}]},"868":{"name":"F_cheer_hakusyu.gmt","root":"center_n","frames":205,"fps":30,"loop":true,"translation":[{"axis":"xyz","keys":[[0,-0.03042599931359291,1.1041805744171143,0.000528500007931143],[1,-0.03028460219502449,1.104203701019287,-0.0006656000041402876],[2,-0.029868900775909424,1.1042708158493042,-0.003962100017815828],[3,-0.0291913989931345,1.104378581047058,-0.008932000026106834],[4,-0.02826470136642456,1.1045230627059937,-0.01514660008251667],[5,-0.02710149995982647,1.104701042175293,-0.02217700146138668],[6,-0.025714298710227013,1.104909062385559,-0.02959430031478405],[7,-0.024115700274705887,1.105143427848816,-0.03696979954838753],[8,-0.02231840044260025,1.1054006814956665,-0.04387449845671654],[9,-0.020334800705313683,1.1056773662567139,-0.04987969994544983],[10,-0.0181777011603117,1.105969786643982,-0.05455650016665459],[11,-0.01585960015654564,1.1062747240066528,-0.05747600272297859],[12,-0.013393099419772625,1.1065884828567505,-0.058209504932165146],[13,-0.010790800675749779,1.106907606124878,-0.056923698633909225],[14,-0.00806520041078329,1.107228398323059,-0.054218001663684845],[15,-0.005229100119322538,1.107547640800476,-0.05031229928135872],[16,-0.0022950000129640102,1.1078615188598633,-0.045426201075315475],[17,0.0007246000459417701,1.1081668138504028,-0.039779700338840485],[18,0.0038169999606907368,1.1084598302841187,-0.033592503517866135],[19,0.006969600450247526,1.1087369918823242,-0.02708449959754944],[20,0.01016990002244711,1.108994960784912,-0.020475400611758232],[21,0.01340519916266203,1.1092302799224854,-0.01398520078510046],[22,0.016686100512742996,1.1094391345977783,-0.007833600044250488],[23,0.02001979947090149,1.1096181869506836,-0.0022404000628739595],[24,0.02338859997689724,1.1097639799118042,0.0025746000465005636],[25,0.026774702593684196,1.1098729372024536,0.006391400005668402],[26,0.03016040101647377,1.1099414825439453,0.008990500122308731],[27,0.03352780267596245,1.1099661588668823,0.010151799768209457],[28,0.03685919940471649,1.1099435091018677,0.009655600413680077],[29,0.040136899799108505,1.1098699569702148,0.007195800077170134],[30,0.04334310069680214,1.1097420454025269,0.0030473999213427305],[31,0.0464601032435894,1.1095560789108276,-0.0021379999816417694],[32,0.04947000369429588,1.1093087196350098,-0.0077085006050765514],[33,0.05235520005226135,1.1089963912963867,-0.01301250047981739],[34,0.055097904056310654,1.1089287996292114,-0.017398100346326828],[35,0.05768020078539848,1.1093531847000122,-0.02021380141377449],[36,0.06008460000157356,1.1101726293563843,-0.020807700231671333],[37,0.062293101102113724,1.1112909317016602,-0.019051000475883484],[38,0.06428810209035873,1.112610936164856,-0.015581900253891945],[39,0.06605180352926254,1.114035964012146,-0.010898999869823456],[40,0.06747350096702576,1.1154690980911255,-0.005500999744981527],[41,0.06846420466899872,1.1173795461654663,0.00011350000568199903],[42,0.06903880089521408,1.1198999881744385,0.005445899907499552],[43,0.06921200454235077,1.1224287748336792,0.009997500106692314],[44,0.06899859756231308,1.1243648529052734,0.013269700109958649],[45,0.06841350346803665,1.1251071691513062,0.014763901010155678],[46,0.06747140735387802,1.1240543127059937,0.01515170093625784],[47,0.06618710607290268,1.1209821701049805,0.015439899638295174],[48,0.06457539647817612,1.1165093183517456,0.015632500872015953],[49,0.06265109777450562,1.1112985610961914,0.015733299776911736],[50,0.06042900308966637,1.106012225151062,0.015746399760246277],[51,0.057923901826143265,1.1013129949569702,0.015675799921154976],[52,0.0551505982875824,1.0978635549545288,0.01552529912441969],[53,0.05212390050292015,1.096326231956482,0.015298999845981598],[54,0.04885860159993172,1.096086025238037,0.015000799670815468],[55,0.045369502156972885,1.0960596799850464,0.014634700492024422],[56,0.041671302169561386,1.0962079763412476,0.014204700477421284],[57,0.03777889907360077,1.096491813659668,0.013714599423110485],[58,0.03370710089802742,1.0968718528747559,0.013168600387871265],[59,0.029351500794291496,1.0973092317581177,0.012570400722324848],[60,0.024653300642967224,1.0977643728256226,0.011924199759960175],[61,0.019695300608873367,1.0981982946395874,0.0112338000908494],[62,0.014560100622475147,1.0985716581344604,0.010503199882805347],[63,0.009330599568784237,1.0988456010818481,0.009736400097608566],[64,0.0040895999409258366,1.0989805459976196,0.008937300182878971],[65,-0.0010800999589264393,1.0989373922348022,0.008110000751912594],[66,-0.006095800083130598,1.098677158355713,0.007258299738168716],[67,-0.010874699801206589,1.0982158184051514,0.0063862004317343235],[68,-0.015333999879658222,1.097609519958496,0.0054977997206151485],[69,-0.019390901550650597,1.0968791246414185,0.004596800077706575],[70,-0.022962700575590134,1.0960454940795898,0.0030067001935094595],[71,-0.025966500863432884,1.0951297283172607,0.0002314000012120232],[72,-0.028319699689745903,1.0941523313522339,-0.0034533999860286713],[73,-0.029939299449324608,1.0931345224380493,-0.00777229992672801],[74,-0.030742600560188293,1.0920971632003784,-0.01244990061968565],[75,-0.030646899715065956,1.0910608768463135,-0.017210600897669792],[76,-0.02956930175423622,1.090046763420105,-0.021778900176286697],[77,-0.027427101507782936,1.0890756845474243,-0.025879500433802605],[78,-0.024657901376485825,1.0881685018539429,-0.029236799106001854],[79,-0.02181140147149563,1.087346076965332,-0.03206320106983185],[80,-0.018973100930452347,1.0866292715072632,-0.03463920205831528],[81,-0.016228599473834038,1.0860391855239868,-0.03679190203547478],[82,-0.013663400895893574,1.0855964422225952,-0.03834820166230202],[83,-0.011362900026142597,1.0853219032287598,-0.03913490101695061],[84,-0.009412700310349464,1.085236668586731,-0.038978900760412216],[85,-0.0078982999548316,1.0853615999221802,-0.03770720213651657],[86,-0.0069052004255354404,1.0857174396514893,-0.03514670208096504],[87,-0.00651889992877841,1.0863250494003296,-0.029782399535179138],[88,-0.006824900396168232,1.087205410003662,-0.021000400185585022],[89,-0.007908700034022331,1.0883795022964478,-0.009979000315070152],[90,-0.009855800308287144,1.0898680686950684,0.002103300066664815],[91,-0.012751800008118153,1.0916919708251953,0.01406800001859665],[92,-0.016682200133800507,1.0938721895217896,0.024736599996685982],[93,-0.021732401102781296,1.103732943534851,0.03293069824576378],[94,-0.027987999841570854,1.1239241361618042,0.03747180104255676],[95,-0.03553440049290657,1.1474545001983643,0.039754100143909454],[96,-0.04445720091462135,1.1673332452774048,0.04195589944720268],[97,-0.05267710238695145,1.1765694618225098,0.04407469928264618],[98,-0.058238204568624496,1.1778985261917114,0.04610820114612579],[99,-0.0614112988114357,1.1787540912628174,0.048054199665784836],[100,-0.06246700510382652,1.1791932582855225,0.04991019889712334],[101,-0.06167610362172127,1.1792731285095215,0.0516740046441555],[102,-0.059309400618076324,1.1790506839752197,0.05334320291876793],[103,-0.055637504905462265,1.178582787513733,0.054915398359298706],[104,-0.05093119665980339,1.177926778793335,0.056388404220342636],[105,-0.045461200177669525,1.1771392822265625,0.05775970220565796],[106,-0.03949829936027527,1.1762776374816895,0.05902710184454918],[107,-0.03331319987773895,1.1753987073898315,0.06018810346722603],[108,-0.02717660181224346,1.174559473991394,0.061240602284669876],[109,-0.021359199658036232,1.1736875772476196,0.062182098627090454],[110,-0.016131700947880745,1.1726781129837036,0.06301020085811615],[111,-0.01176500041037798,1.1715388298034668,0.06372269988059998],[112,-0.008529700338840485,1.1702779531478882,0.06431730091571808],[113,-0.006696600001305342,1.1689034700393677,0.06479150056838989],[114,-0.006883700378239155,1.1674236059188843,0.06514310091733932],[115,-0.009183499962091446,1.1658462285995483,0.06536959856748581],[116,-0.013078400865197182,1.164179801940918,0.06546880304813385],[117,-0.018050700426101685,1.162432074546814,0.0654384046792984],[118,-0.02358279936015606,1.1606110334396362,0.0652759000658989],[119,-0.02915700152516365,1.1587250232696533,0.06497909873723984],[120,-0.034255702048540115,1.1567819118499756,0.06454560160636902],[121,-0.03836120292544365,1.1547898054122925,0.06397309899330139],[122,-0.04095590114593506,1.1527570486068726,0.06325920671224594],[123,-0.04102900251746178,1.1506913900375366,0.062401700764894485],[124,-0.03828980028629303,1.1486009359359741,0.06139810010790825],[125,-0.03330120071768761,1.1464940309524536,0.060246098786592484],[126,-0.026625901460647583,1.144378423690796,0.05894340202212334],[127,-0.018826698884367943,1.14226233959198,0.05688459798693657],[128,-0.010466299951076508,1.1401537656784058,0.053578801453113556],[129,-0.0021074998658150434,1.1380610466003418,0.04919489845633507],[130,0.005686900112777948,1.1359919309616089,0.043901700526475906],[131,0.012354200705885887,1.1339545249938965,0.037868302315473557],[132,0.017331600189208984,1.1319570541381836,0.031263601034879684],[133,0.02118000015616417,1.1300076246261597,0.024256600067019463],[134,0.02483610063791275,1.128114104270935,0.017016300931572914],[135,0.028300801292061806,1.1262848377227783,0.009711500257253647],[136,0.03157550096511841,1.1245276927947998,0.0025112999137490988],[137,0.034661002457141876,1.122850775718689,-0.004415399860590696],[138,0.03755849972367287,1.1212620735168457,-0.010899599641561508],[139,0.04026910290122032,1.1197699308395386,-0.016772400587797165],[140,0.04279389977455139,1.1186010837554932,-0.02186490036547184],[141,0.04513389989733696,1.1179254055023193,-0.02600800059735775],[142,0.04729030281305313,1.1176643371582031,-0.02903280034661293],[143,0.04926399886608124,1.1177400350570679,-0.030770400539040565],[144,0.05105630308389664,1.11807382106781,-0.031400199979543686],[145,0.05266820266842842,1.1185879707336426,-0.031248999759554863],[146,0.054100699722766876,1.1192039251327515,-0.030368199571967125],[147,0.055354900658130646,1.1198434829711914,-0.028809500858187675],[148,0.056432005017995834,1.120428442955017,-0.026624200865626335],[149,0.057333000004291534,1.1208807229995728,-0.023864099755883217],[150,0.058059003204107285,1.1211220026016235,-0.020580600947141647],[151,0.058611102402210236,1.1210739612579346,-0.016825400292873383],[152,0.05886020138859749,1.12065851688385,-0.012649900279939175],[153,0.058697402477264404,1.1199547052383423,-0.00810569990426302],[154,0.05815399810671806,1.1191153526306152,-0.0032444000244140625],[155,0.05726150423288345,1.1181728839874268,0.0018825000151991844],[156,0.056050997227430344,1.117159366607666,0.007223399821668863],[157,0.05455399677157402,1.1161072254180908,0.01272680051624775],[158,0.05280179902911186,1.1150486469268799,0.018341099843382835],[159,0.050825800746679306,1.1140159368515015,0.024014700204133987],[160,0.04865720123052597,1.1130412817001343,0.029194001108407974],[161,0.04632740095257759,1.1121569871902466,0.033406101167201996],[162,0.04386770352721214,1.1113953590393066,0.03672100231051445],[163,0.041309501975774765,1.1107887029647827,0.03920849785208702],[164,0.03868420049548149,1.1103692054748535,0.04093850031495094],[165,0.03602289780974388,1.1101692914962769,0.04198110103607178],[166,0.03335709869861603,1.1101205348968506,0.042406100779771805],[167,0.030718201771378517,1.110129952430725,0.042283300310373306],[168,0.02813740074634552,1.1101924180984497,0.04168280214071274],[169,0.02564600110054016,1.1103025674819946,0.040674399584531784],[170,0.023275500163435936,1.1104553937911987,0.03932810202240944],[171,0.02097640000283718,1.1106456518173218,0.03771379962563515],[172,0.01868080161511898,1.110867977142334,0.035901300609111786],[173,0.016392601653933525,1.1111172437667847,0.033960599452257156],[174,0.014115400612354279,1.1113885641098022,0.031961701810359955],[175,0.01185310073196888,1.1116762161254883,0.029974300414323807],[176,0.009609400294721127,1.1119754314422607,0.028068501502275467],[177,0.007388100028038025,1.1122808456420898,0.02625340037047863],[178,0.005193000193685293,1.1125870943069458,0.02449209988117218],[179,0.003027800004929304,1.112889289855957,0.022785499691963196],[180,0.0008963000145740807,1.1131820678710938,0.021134400740265846],[181,-0.0011978000402450562,1.1134603023529053,0.01953990012407303],[182,-0.003250699955970049,1.1137186288833618,0.01800280064344406],[183,-0.005258500110358,1.1139520406723022,0.016523901373147964],[184,-0.007217600475996733,1.1141552925109863,0.015104100108146667],[185,-0.009124199859797955,1.1143231391906738,0.013744400814175606],[186,-0.010974500328302383,1.114450454711914,0.012445700354874134],[187,-0.012764799408614635,1.1145319938659668,0.011208700016140938],[188,-0.01449120044708252,1.1145625114440918,0.010034500621259212],[189,-0.01615000143647194,1.114537000656128,0.00892380066215992],[190,-0.017737500369548798,1.1144499778747559,0.00787770003080368],[191,-0.019249899312853813,1.1142964363098145,0.006896899547427893],[192,-0.020683301612734795,1.114071249961853,0.005982400383800268],[193,-0.02203419990837574,1.113659143447876,0.005135000217705965],[194,-0.0232986006885767,1.1129854917526245,0.004355700220912695],[195,-0.024472801014780998,1.1121060848236084,0.003645300166681409],[196,-0.02555300109088421,1.1110759973526,0.0030048000626266003],[197,-0.026535600423812866,1.1099509000778198,0.0024349000304937363],[198,-0.027416599914431572,1.1087861061096191,0.0019367000786587596],[199,-0.02819240093231201,1.1076372861862183,0.001510899979621172],[200,-0.028859201818704605,1.1065595149993896,0.0011586000910028815],[201,-0.029413199052214622,1.1056084632873535,0.000880400009918958],[202,-0.02985060028731823,1.1048396825790405,0.0006775000365450978],[203,-0.030167698860168457,1.1043084859848022,0.0005506000015884638],[204,-0.03036080114543438,1.1040703058242798,0.0005006000283174217],[205,-0.03042599931359291,1.1041805744171143,0.000528500007931143]]}]},"870":{"name":"F_cheer_nozoku.gmt","root":"center_n","frames":188,"fps":30,"loop":true,"translation":[{"axis":"xyz","keys":[[0,0.0000024000000848900527,1.1200000047683716,0.0000037000002066633897],[1,-0.0006151999696157873,1.1201629638671875,0.004123799968510866],[2,-0.0012969000963494182,1.1207423210144043,0.00838440004736185],[3,-0.001964900176972151,1.1218737363815308,0.012720500119030476],[4,-0.002541100140661001,1.1236927509307861,0.01706700026988983],[5,-0.0029476999770849943,1.1263132095336914,0.021359099075198174],[6,-0.003106700023636222,1.1295381784439087,0.025318598374724388],[7,-0.0029907000716775656,1.1331470012664795,0.028741000220179558],[8,-0.0026585001032799482,1.136919379234314,0.031672101467847824],[9,-0.0021614001598209143,1.1406344175338745,0.034157197922468185],[10,-0.001550600049085915,1.1440720558166504,0.03624200075864792],[11,-0.0008774000452831388,1.1470115184783936,0.03797199949622154],[12,-0.00019320000137668103,1.1498254537582397,0.03939270228147507],[13,0.0004507999983616173,1.1529698371887207,0.04054979979991913],[14,0.001003399956971407,1.1563491821289062,0.04148870334029198],[15,0.0014131999341771007,1.1598678827285767,0.04225509986281395],[16,0.0016289999475702643,1.1634303331375122,0.04289430007338524],[17,0.0015993999550119042,1.1669410467147827,0.043452199548482895],[18,0.0013685000594705343,1.170304298400879,0.043974000960588455],[19,0.0010179000673815608,1.1734248399734497,0.044249001890420914],[20,0.0005533000221475959,1.1762069463729858,0.04408380016684532],[21,-0.000019799999790848233,1.1785550117492676,0.04355020076036453],[22,-0.0006958000012673438,1.1803735494613647,0.04272010177373886],[23,-0.0014693000121042132,1.1815670728683472,0.04166540130972862],[24,-0.002334600081667304,1.182039737701416,0.04045790061354637],[25,-0.0032862999942153692,1.1820696592330933,0.03916960209608078],[26,-0.004318700172007084,1.1820001602172852,0.037872299551963806],[27,-0.00542640034109354,1.1818350553512573,0.03663789853453636],[28,-0.00660370010882616,1.181578278541565,0.035538200289011],[29,-0.007845300249755383,1.181233286857605,0.0346451997756958],[30,-0.009145400486886501,1.180803656578064,0.03388969972729683],[31,-0.010498600080609322,1.1802934408187866,0.03315399959683418],[32,-0.011899299919605255,1.1797059774398804,0.032437101006507874],[33,-0.013342000544071198,1.1790450811386108,0.0317378006875515],[34,-0.014821100048720837,1.1783145666122437,0.031055200845003128],[35,-0.016331100836396217,1.1775178909301758,0.03038810007274151],[36,-0.017866401001811028,1.1766589879989624,0.029735499992966652],[37,-0.019421599805355072,1.1757413148880005,0.029096299782395363],[38,-0.020991001278162003,1.1747688055038452,0.028469299897551537],[39,-0.02256910130381584,1.173744797706604,0.027853598818182945],[40,-0.024150300770998,1.1726733446121216,0.027248099446296692],[41,-0.02572919987142086,1.171557903289795,0.02665170095860958],[42,-0.02730019949376583,1.170030951499939,0.02606329880654812],[43,-0.028857698664069176,1.1678048372268677,0.025481900200247765],[44,-0.030396198853850365,1.1650036573410034,0.024906300008296967],[45,-0.03191019967198372,1.1617511510849,0.024335501715540886],[46,-0.03339400142431259,1.15817129611969,0.02376840077340603],[47,-0.034842200577259064,1.154388189315796,0.023204000666737556],[48,-0.036249302327632904,1.1505255699157715,0.022641200572252274],[49,-0.03760949894785881,1.146707534790039,0.022078899666666985],[50,-0.038917601108551025,1.143057942390442,0.021516000851988792],[51,-0.04016780108213425,1.1397007703781128,0.02095150016248226],[52,-0.041354600340127945,1.1367601156234741,0.020384300500154495],[53,-0.04247260093688965,1.1343597173690796,0.019813301041722298],[54,-0.04351609945297241,1.132623314857483,0.019237400963902473],[55,-0.044479601085186005,1.131675124168396,0.018655600026249886],[56,-0.04535749927163124,1.1311663389205933,0.018066799268126488],[57,-0.04614439979195595,1.1306654214859009,0.017469899728894234],[58,-0.04683470353484154,1.1301722526550293,0.016863800585269928],[59,-0.047422800213098526,1.1296873092651367,0.016247600317001343],[60,-0.04790320247411728,1.129210352897644,0.015620000660419464],[61,-0.04843300208449364,1.1287416219711304,0.014827999286353588],[62,-0.049157701432704926,1.1282811164855957,0.013743300922214985],[63,-0.05005459859967232,1.1278289556503296,0.012401900254189968],[64,-0.05110060051083565,1.127385139465332,0.010839699767529964],[65,-0.052272897213697433,1.1269499063491821,0.009092899970710278],[66,-0.053548600524663925,1.1265233755111694,0.007197300437837839],[67,-0.05490469932556152,1.1261053085327148,0.00518900016322732],[68,-0.05631840229034424,1.125696063041687,0.0031040001194924116],[69,-0.057766903191804886,1.125295877456665,0.0009783999994397163],[70,-0.059227097779512405,1.1249043941497803,-0.001151900039985776],[71,-0.060676198452711105,1.124522089958191,-0.0032508999574929476],[72,-0.06209130212664604,1.1241488456726074,-0.005282500293105841],[73,-0.06344950199127197,1.1237846612930298,-0.007210700307041407],[74,-0.06472790241241455,1.1234298944473267,-0.008999600075185299],[75,-0.06590350717306137,1.1230844259262085,-0.010613100603222847],[76,-0.06695359945297241,1.1227484941482544,-0.012015200220048428],[77,-0.06785520166158676,1.1224220991134644,-0.013169899582862854],[78,-0.06858540326356888,1.1221052408218384,-0.01404110062867403],[79,-0.06912130117416382,1.121798038482666,-0.014593000523746014],[80,-0.06943999975919724,1.1215007305145264,-0.014789399690926075],[81,-0.06951860338449478,1.1212133169174194,-0.014683100394904613],[82,-0.06901630014181137,1.1209357976913452,-0.014361000619828701],[83,-0.06768479943275452,1.1206682920455933,-0.013838599435985088],[84,-0.06564009934663773,1.1204110383987427,-0.013131700456142426],[85,-0.06299810111522675,1.120163917541504,-0.012255500070750713],[86,-0.059874601662158966,1.119927167892456,-0.011225800029933453],[87,-0.056385498493909836,1.1197006702423096,-0.01005799975246191],[88,-0.052646901458501816,1.119484782218933,-0.008767600171267986],[89,-0.04877449944615364,1.1192792654037476,-0.007370200008153915],[90,-0.04488439857959747,1.1190844774246216,-0.005881400313228369],[91,-0.041092399507761,1.1189006567001343,-0.004316600039601326],[92,-0.037514399737119675,1.1187273263931274,-0.002691500121727586],[93,-0.03426630049943924,1.1185649633407593,-0.0010213999776169658],[94,-0.0314640998840332,1.1184136867523193,0.0006779000395908952],[95,-0.029223700985312462,1.118273377418518,0.0023910999298095703],[96,-0.027660900726914406,1.118799090385437,0.004102500155568123],[97,-0.026903798803687096,1.1205172538757324,0.005796600133180618],[98,-0.026799699291586876,1.1232355833053589,0.0074579003266990185],[99,-0.027043798938393593,1.1267614364624023,0.00907090026885271],[100,-0.027331000193953514,1.130902647972107,0.010620000772178173],[101,-0.027356499806046486,1.1354665756225586,0.012200700119137764],[102,-0.026815300807356834,1.1402610540390015,0.013910099864006042],[103,-0.02578980103135109,1.145093321800232,0.015734700486063957],[104,-0.024578100070357323,1.1497710943222046,0.01766120083630085],[105,-0.023199301213026047,1.1541022062301636,0.019676100462675095],[106,-0.021672500297427177,1.1578937768936157,0.021766100078821182],[107,-0.020016800612211227,1.1609538793563843,0.023917799815535545],[108,-0.01825129985809326,1.163089632987976,0.026117799803614616],[109,-0.016394900158047676,1.1641087532043457,0.02835269831120968],[110,-0.01446670014411211,1.1644970178604126,0.03060919977724552],[111,-0.012485899962484837,1.1648679971694946,0.03287380188703537],[112,-0.010471499525010586,1.1652225255966187,0.035133298486471176],[113,-0.008442500606179237,1.1655611991882324,0.0373741015791893],[114,-0.006418000441044569,1.1658847332000732,0.03958290070295334],[115,-0.004417100455611944,1.1661936044692993,0.04174629971385002],[116,-0.0024588999804109335,1.166488528251648,0.04385099932551384],[117,-0.0005623000324703753,1.166770100593567,0.045883502811193466],[118,0.0012533999979496002,1.167038917541504,0.047830503433942795],[119,0.0029694000259041786,1.1672956943511963,0.0496785007417202],[120,0.004566400311887264,1.1675409078598022,0.05141429975628853],[121,0.006025500129908323,1.1677751541137695,0.053024400025606155],[122,0.0073275999166071415,1.167999267578125,0.05449540168046951],[123,0.00845350045710802,1.1682137250900269,0.055813997983932495],[124,0.009384299628436565,1.1684192419052124,0.05696669965982437],[125,0.010100900195538998,1.1686162948608398,0.057940203696489334],[126,0.010584200732409954,1.1688055992126465,0.05872100219130516],[127,0.010815100744366646,1.1689878702163696,0.0592959001660347],[128,0.010591399855911732,1.169163465499878,0.05965150147676468],[129,0.00977260060608387,1.1693332195281982,0.05964430049061775],[130,0.008432100526988506,1.1694977283477783,0.05917540192604065],[131,0.006643400527536869,1.169657588005066,0.058297302573919296],[132,0.004479900002479553,1.1698133945465088,0.05706290155649185],[133,0.0020151000935584307,1.1699657440185547,0.0555248036980629],[134,-0.0006775999790988863,1.170115351676941,0.053735800087451935],[135,-0.003524700179696083,1.1702628135681152,0.05174870043992996],[136,-0.0064526996575295925,1.1704086065292358,0.049616001546382904],[137,-0.009388200007379055,1.1705535650253296,0.04739069938659668],[138,-0.012257699854671955,1.1706982851028442,0.04512530192732811],[139,-0.014987699687480927,1.170843243598938,0.042872700840234756],[140,-0.017504900693893433,1.1709891557693481,0.0406855009496212],[141,-0.019735699519515038,1.171136736869812,0.038616400212049484],[142,-0.021606700494885445,1.1712863445281982,0.036718301475048065],[143,-0.023044399917125702,1.1711968183517456,0.03504380211234093],[144,-0.023975400254130363,1.1706522703170776,0.03364570066332817],[145,-0.024326199665665627,1.1696921586990356,0.032576702535152435],[146,-0.02436540089547634,1.1683558225631714,0.031889501959085464],[147,-0.02440979890525341,1.1666828393936157,0.031421300023794174],[148,-0.024458399042487144,1.1647124290466309,0.030974000692367554],[149,-0.024510100483894348,1.1624839305877686,0.030546700581908226],[150,-0.024563800543546677,1.1600368022918701,0.030138900503516197],[151,-0.024618400260806084,1.1574102640151978,0.029749900102615356],[152,-0.024672800675034523,1.1546438932418823,0.029379000887274742],[153,-0.02472580038011074,1.151776909828186,0.029025599360466003],[154,-0.024776600301265717,1.1488487720489502,0.028689000755548477],[155,-0.02482379972934723,1.145898699760437,0.028368500992655754],[156,-0.024866601452231407,1.142966389656067,0.02806360088288784],[157,-0.02490360103547573,1.140090823173523,0.027773499488830566],[158,-0.02493399940431118,1.137311577796936,0.02749759890139103],[159,-0.02495650015771389,1.1346681118011475,0.02723510004580021],[160,-0.024970201775431633,1.1321996450424194,0.02698560059070587],[161,-0.024973800405859947,1.1299455165863037,0.026748299598693848],[162,-0.024966400116682053,1.1279453039169312,0.026114899665117264],[163,-0.024946700781583786,1.1262381076812744,0.02474050037562847],[164,-0.02491389960050583,1.1248635053634644,0.022718900814652443],[165,-0.024866700172424316,1.1237643957138062,0.020323799923062325],[166,-0.024804001674056053,1.1228361129760742,0.017765101045370102],[167,-0.024724800139665604,1.122065544128418,0.015087899751961231],[168,-0.024482300505042076,1.121439814567566,0.012337099760770798],[169,-0.02394470013678074,1.1209458112716675,0.009557999670505524],[170,-0.023133400827646255,1.1205710172653198,0.0067955004051327705],[171,-0.021954700350761414,1.120301604270935,0.004094700329005718],[172,-0.020367000252008438,1.120125412940979,0.0015007000183686614],[173,-0.018470000475645065,1.1200292110443115,-0.0009415000095032156],[174,-0.016361000016331673,1.1200000047683716,-0.0031868000514805317],[175,-0.014133100397884846,1.1200000047683716,-0.005190100055187941],[176,-0.011873199604451656,1.1200000047683716,-0.006906399969011545],[177,-0.009660700336098671,1.1200000047683716,-0.008290600031614304],[178,-0.007565700449049473,1.1200000047683716,-0.009297700598835945],[179,-0.005728400312364101,1.1200000047683716,-0.009882500395178795],[180,-0.004210200160741806,1.1200000047683716,-0.010000000707805157],[181,-0.0029816001188009977,1.1200000047683716,-0.009871000424027443],[182,-0.0020128001924604177,1.1200000047683716,-0.00966500025242567],[183,-0.0012744000414386392,1.1200000047683716,-0.009260500781238079],[184,-0.0007366000209003687,1.1200000047683716,-0.008535700850188732],[185,-0.0003698999935295433,1.1200000047683716,-0.007368899881839752],[186,-0.0001446999958716333,1.1200000047683716,-0.005638500209897757],[187,-0.000031200001103570685,1.1200000047683716,-0.0032228000927716494],[188,0,1.1200000047683716,0]]}]},"893":{"name":"F_stand_kamae01.gmt","root":"center_n","frames":145,"fps":30,"loop":true,"translation":[{"axis":"xyz","keys":[[0,0,1.1369999647140503,0],[1,0.001012900029309094,1.1369580030441284,-0.00004890000127488747],[2,0.001998299965634942,1.1368368864059448,-0.00019109999993816018],[3,0.00295620015822351,1.1366450786590576,-0.0004199999966658652],[4,0.003886700142174959,1.136389970779419,-0.0007289000204764307],[5,0.004789900034666061,1.1360796689987183,-0.00111109996214509],[6,0.005666000302881002,1.135722041130066,-0.001560000004246831],[7,0.006515000015497208,1.1353249549865723,-0.0020689000375568867],[8,0.007337000221014023,1.1348962783813477,-0.0026311001274734735],[9,0.008132199756801128,1.1344441175460815,-0.0032400002237409353],[10,0.008900499902665615,1.1339759826660156,-0.003888899926096201],[11,0.009642200544476509,1.1334999799728394,-0.004571100231260061],[12,0.01035740040242672,1.1330240964889526,-0.005280000157654285],[13,0.011045999825000763,1.1325559616088867,-0.006008900236338377],[14,0.01170829962939024,1.132103681564331,-0.006751100067049265],[15,0.01234429981559515,1.131675124168396,-0.007500000298023224],[16,0.012954100035130978,1.1312779188156128,-0.008248900063335896],[17,0.013537900522351265,1.1309202909469604,-0.008991099894046783],[18,0.014095700345933437,1.1306101083755493,-0.009720000438392162],[19,0.014627600088715553,1.1303550004959106,-0.010428900830447674],[20,0.015133799985051155,1.1301630735397339,-0.01111110020428896],[21,0.015614300034940243,1.1300420761108398,-0.011760000139474869],[22,0.01606920175254345,1.1299999952316284,-0.012368900701403618],[23,0.01649869978427887,1.1300016641616821,-0.012931100092828274],[24,0.016902800649404526,1.1300066709518433,-0.013439999893307686],[25,0.01728159934282303,1.1300147771835327,-0.01388890016824007],[26,0.017635200172662735,1.13002610206604,-0.014271100051701069],[27,0.017963800579309464,1.1300406455993652,-0.014579999260604382],[28,0.018267400562763214,1.1300581693649292,-0.014808900654315948],[29,0.018546199426054955,1.1300787925720215,-0.014951099641621113],[30,0.018800200894474983,1.130102276802063,-0.015000000596046448],[31,0.01902949996292591,1.1301288604736328,-0.014980499632656574],[32,0.019234299659729004,1.1301583051681519,-0.01492329966276884],[33,0.019414499402046204,1.1301904916763306,-0.01482979953289032],[34,0.019570499658584595,1.1302255392074585,-0.014701800420880318],[35,0.01970209926366806,1.1302632093429565,-0.014540900476276875],[36,0.019809601828455925,1.1303036212921143,-0.014348700642585754],[37,0.01989310048520565,1.130346655845642,-0.014126800000667572],[38,0.019952500239014626,1.13039231300354,-0.013876999728381634],[39,0.019988199695944786,1.1304404735565186,-0.013600699603557587],[40,0.020000001415610313,1.1304911375045776,-0.013299800455570221],[41,0.01999180018901825,1.1305440664291382,-0.012975799851119518],[42,0.01996619999408722,1.1305996179580688,-0.012630200944840908],[43,0.019921500235795975,1.130657434463501,-0.012264899909496307],[44,0.019856199622154236,1.1307175159454346,-0.011881399899721146],[45,0.019768700003623962,1.13077974319458,-0.011481399647891521],[46,0.019657401368021965,1.130844235420227,-0.011066400445997715],[47,0.019520800560712814,1.130910873413086,-0.01063810009509325],[48,0.01935720071196556,1.1309795379638672,-0.01019820012152195],[49,0.019165100529789925,1.1310503482818604,-0.009748300537467003],[50,0.018942801281809807,1.1311229467391968,-0.009290100075304508],[51,0.018688900396227837,1.1311976909637451,-0.008825100027024746],[52,0.018401701003313065,1.1312742233276367,-0.00835500005632639],[53,0.018079599365592003,1.1313525438308716,-0.007881499826908112],[54,0.01772109977900982,1.1314327716827393,-0.0074061001650989056],[55,0.017324600368738174,1.1315144300460815,-0.006930500268936157],[56,0.01688840053975582,1.1315981149673462,-0.00645639980211854],[57,0.016411101445555687,1.1316832304000854,-0.005985400173813105],[58,0.015891000628471375,1.1317907571792603,-0.005519099999219179],[59,0.015326499938964844,1.1319371461868286,-0.0050592003390192986],[60,0.014715999364852905,1.132116436958313,-0.0046072001568973064],[61,0.014058100059628487,1.1323225498199463,-0.004164900165051222],[62,0.013350999914109707,1.132549524307251,-0.003733899910002947],[63,0.012593301013112068,1.1327913999557495,-0.003315800102427602],[64,0.011783200316131115,1.1330419778823853,-0.002912200056016445],[65,0.01091929990798235,1.1332956552505493,-0.002524800132960081],[66,0.010000000707805157,1.1335461139678955,-0.0021552001126110554],[67,0.00904920045286417,1.1337873935699463,-0.0018050000071525574],[68,0.008092900738120079,1.1340134143829346,-0.0014759000623598695],[69,0.007132300175726414,1.1342183351516724,-0.001169599941931665],[70,0.006168799940496683,1.134395956993103,-0.0008875999483279884],[71,0.005203600041568279,1.1345404386520386,-0.0006316000362858176],[72,0.004238000139594078,1.1346458196640015,-0.0004033000150229782],[73,0.003273300128057599,1.134705901145935,-0.00020419999782461673],[74,0.0023108001332730055,1.1347147226333618,-0.00003600000127335079],[75,0.0013518000487238169,1.1346663236618042,0.00009960000170394778],[76,0.00039750002906657755,1.1345781087875366,0.00020110000332351774],[77,-0.0005507000023499131,1.1344722509384155,0.0002667000226210803],[78,-0.0014914999483153224,1.1343504190444946,0.0002575000107754022],[79,-0.0024236999452114105,1.1342142820358276,0.0001407000090694055],[80,-0.0033458999823778868,1.1340653896331787,-0.00007580000237794593],[81,-0.0042570000514388084,1.133905291557312,-0.00038419998600147665],[82,-0.005155500024557114,1.1337354183197021,-0.0007766999769955873],[83,-0.006040200125426054,1.1335575580596924,-0.0012453000526875257],[84,-0.006909800227731466,1.1333732604980469,-0.0017822999507188797],[85,-0.007763099856674671,1.1331841945648193,-0.0023797000758349895],[86,-0.008598700165748596,1.1329915523529053,-0.003029800020158291],[87,-0.00941530056297779,1.132797360420227,-0.003724699839949608],[88,-0.010211700573563576,1.1326030492782593,-0.004456500057131052],[89,-0.010986600071191788,1.132409930229187,-0.005217500030994415],[90,-0.011738600209355354,1.1322201490402222,-0.005999700166285038],[91,-0.012466500513255596,1.1320347785949707,-0.006795200053602457],[92,-0.013168999925255775,1.1318557262420654,-0.007596399635076523],[93,-0.013844800181686878,1.1316838264465332,-0.008395200595259666],[94,-0.014492600224912167,1.1315193176269531,-0.00918390043079853],[95,-0.015111200511455536,1.1313625574111938,-0.009954600594937801],[96,-0.015699200332164764,1.1312134265899658,-0.010699400678277016],[97,-0.016255300492048264,1.1310720443725586,-0.011410600505769253],[98,-0.01677830144762993,1.1309388875961304,-0.012080200016498566],[99,-0.017266899347305298,1.130813717842102,-0.012700400315225124],[100,-0.017719699069857597,1.1306970119476318,-0.013263399712741375],[101,-0.01813559979200363,1.1305887699127197,-0.013761299662292004],[102,-0.01851310022175312,1.1304891109466553,-0.014186300337314606],[103,-0.01885109953582287,1.130398154258728,-0.014530499465763569],[104,-0.019148198887705803,1.130316138267517,-0.014786100946366787],[105,-0.01940310001373291,1.1302433013916016,-0.014945200644433498],[106,-0.019614500924944878,1.130179762840271,-0.015000000596046448],[107,-0.01978120021522045,1.1301254034042358,-0.014970900490880013],[108,-0.019901899620890617,1.1300806999206543,-0.014885700307786465],[109,-0.01997530087828636,1.1300456523895264,-0.014747400768101215],[110,-0.020000001415610313,1.1300203800201416,-0.014559000730514526],[111,-0.019980501383543015,1.130005121231079,-0.014323599636554718],[112,-0.019922200590372086,1.1299999952316284,-0.01404420007020235],[113,-0.019825799390673637,1.130018949508667,-0.013723799958825111],[114,-0.019691800698637962,1.1300740242004395,-0.013365400023758411],[115,-0.019520800560712814,1.1301630735397339,-0.01297220028936863],[116,-0.019313300028443336,1.1302837133407593,-0.012547199614346027],[117,-0.01906999945640564,1.130433440208435,-0.012093300931155682],[118,-0.018791301175951958,1.1306101083755493,-0.011613599956035614],[119,-0.018478000536561012,1.130811333656311,-0.01111110020428896],[120,-0.01813039928674698,1.1310347318649292,-0.010588900186121464],[121,-0.017749300226569176,1.1312779188156128,-0.010050100274384022],[122,-0.01733510009944439,1.13153874874115,-0.009497500024735928],[123,-0.01688849925994873,1.1318148374557495,-0.008934400044381618],[124,-0.016409900039434433,1.132103681564331,-0.008363700471818447],[125,-0.015900099650025368,1.1324031352996826,-0.007788400631397963],[126,-0.015359400771558285,1.1327106952667236,-0.0072116004303097725],[127,-0.01478859968483448,1.1330240964889526,-0.006636300124228001],[128,-0.014188200235366821,1.1333409547805786,-0.006065600086003542],[129,-0.013558700680732727,1.1336591243743896,-0.005502500105649233],[130,-0.01290079951286316,1.1339759826660156,-0.004949900321662426],[131,-0.012214899994432926,1.1342893838882446,-0.004411099944263697],[132,-0.011501699686050415,1.1345969438552856,-0.003888899926096201],[133,-0.010761699639260769,1.1348962783813477,-0.0033863999415189028],[134,-0.009995399974286556,1.1351851224899292,-0.0029067001305520535],[135,-0.009203600697219372,1.1354612112045288,-0.0024528000503778458],[136,-0.008386700414121151,1.135722041130066,-0.0020278000738471746],[137,-0.007545200176537037,1.135965347290039,-0.0016345999902114272],[138,-0.006679899990558624,1.1361887454986572,-0.0012762000551447272],[139,-0.0057911998592317104,1.136389970779419,-0.0009558000019751489],[140,-0.004879600368440151,1.1365666389465332,-0.0006763999699614942],[141,-0.003945900127291679,1.136716365814209,-0.00044100001105107367],[142,-0.002990500070154667,1.1368368864059448,-0.00025260000256821513],[143,-0.002013999968767166,1.1369260549545288,-0.0001142999972216785],[144,-0.001016999944113195,1.1369811296463013,-0.00002910000148403924],[145,0,1.1369999647140503,0]]}]},"894":{"name":"F_stand_kamae02.gmt","root":"center_n","frames":160,"fps":30,"loop":true,"translation":[{"axis":"xyz","keys":[[0,0,1.1369999647140503,0],[1,-0.002652500057592988,1.1369946002960205,0.0010395999997854233],[2,-0.005363100208342075,1.1368271112442017,0.0021100000012665987],[3,-0.008117000572383404,1.1365132331848145,0.0032058001961559057],[4,-0.010899700224399567,1.136069416999817,0.004321400076150894],[5,-0.01369639951735735,1.1355115175247192,0.0054512000642716885],[6,-0.016492601484060287,1.1348557472229004,0.0065897004678845406],[7,-0.01927340030670166,1.1341180801391602,0.007731399964541197],[8,-0.022024400532245636,1.133314847946167,0.008870700374245644],[9,-0.024730700999498367,1.1324619054794312,0.01000209990888834],[10,-0.027377700433135033,1.131575345993042,0.011119999922811985],[11,-0.02995080128312111,1.1306713819503784,0.0122189000248909],[12,-0.032435301691293716,1.1297659873962402,0.01329330075532198],[13,-0.03481660038232803,1.128875494003296,0.014337599277496338],[14,-0.03707990050315857,1.1280157566070557,0.01534619927406311],[15,-0.03921059891581535,1.1272028684616089,0.016313700005412102],[16,-0.04119400307536125,1.1264530420303345,0.017234399914741516],[17,-0.0430155023932457,1.1257823705673218,0.018102901056408882],[18,-0.04466040059924126,1.1252069473266602,0.018913600593805313],[19,-0.0461140014231205,1.1247426271438599,0.01966099999845028],[20,-0.04736180230975151,1.1243937015533447,0.020339500159025192],[21,-0.048388902097940445,1.124145746231079,0.020943600684404373],[22,-0.04918070137500763,1.1239875555038452,0.021467700600624084],[23,-0.04972270131111145,1.1239080429077148,0.021906299516558647],[24,-0.05000000074505806,1.1238957643508911,0.022253800183534622],[25,-0.050147999078035355,1.1239395141601562,0.022506199777126312],[26,-0.050310201942920685,1.1240280866622925,0.022667400538921356],[27,-0.050484802573919296,1.124150276184082,0.022743498906493187],[28,-0.05066949874162674,1.1242947578430176,0.02274090051651001],[29,-0.050862401723861694,1.1244502067565918,0.02266569994390011],[30,-0.05106149986386299,1.1246055364608765,0.02252420037984848],[31,-0.051264699548482895,1.1247495412826538,0.022322699427604675],[32,-0.05147000029683113,1.1248706579208374,0.022067399695515633],[33,-0.05167530104517937,1.1249579191207886,0.02176460064947605],[34,-0.05187860131263733,1.125,0.021420499309897423],[35,-0.052077800035476685,1.1250146627426147,0.021041300147771835],[36,-0.052271004766225815,1.1250274181365967,0.020633399486541748],[37,-0.052456099539995193,1.1250382661819458,0.02020290121436119],[38,-0.05263109877705574,1.1250474452972412,0.019756099209189415],[39,-0.05279390141367912,1.125055193901062,0.019299300387501717],[40,-0.05294240266084671,1.1250617504119873,0.018838701769709587],[41,-0.053074803203344345,1.125067114830017,0.018380500376224518],[42,-0.05318880081176758,1.1250717639923096,0.017931101843714714],[43,-0.05328249931335449,1.1250756978988647,0.01749659888446331],[44,-0.05335390195250511,1.1250791549682617,0.01708330027759075],[45,-0.05340080335736275,1.12508225440979,0.01669739931821823],[46,-0.05342140421271324,1.1250852346420288,0.016345299780368805],[47,-0.05341339856386185,1.1250884532928467,0.016033099964261055],[48,-0.0533750019967556,1.1250919103622437,0.01576700061559677],[49,-0.053303997963666916,1.1250957250595093,0.015553499571979046],[50,-0.053198497742414474,1.1251003742218018,0.015398601070046425],[51,-0.053056299686431885,1.1251057386398315,0.015308700501918793],[52,-0.05287550017237663,1.1251122951507568,0.015275399200618267],[53,-0.052654098719358444,1.125119924545288,0.015284000895917416],[54,-0.052389901131391525,1.1251291036605835,0.015331200323998928],[55,-0.052080899477005005,1.125139832496643,0.015413600020110607],[56,-0.05172520503401756,1.1251524686813354,0.015527799725532532],[57,-0.051320601254701614,1.1251670122146606,0.01567069999873638],[58,-0.05086519941687584,1.1251838207244873,0.015838701277971268],[59,-0.0503569021821022,1.125203013420105,0.016028599813580513],[60,-0.04979360103607178,1.1252248287200928,0.01623700000345707],[61,-0.049173399806022644,1.1252492666244507,0.0164606012403965],[62,-0.04849420115351677,1.125276803970337,0.016696101054549217],[63,-0.04775390028953552,1.1253074407577515,0.016940001398324966],[64,-0.046950601041316986,1.125341534614563,0.017189200967550278],[65,-0.04608210176229477,1.1253790855407715,0.017440101131796837],[66,-0.045146502554416656,1.1254204511642456,0.017689600586891174],[67,-0.044141702353954315,1.1254656314849854,0.017934201285243034],[68,-0.04306570068001747,1.1255148649215698,0.01817060075700283],[69,-0.04191650077700615,1.1255968809127808,0.018395500257611275],[70,-0.04069190099835396,1.1257370710372925,0.01860550045967102],[71,-0.03939000144600868,1.125930905342102,0.01879729889333248],[72,-0.03800880163908005,1.1261736154556274,0.018967600539326668],[73,-0.03654609993100166,1.1264607906341553,0.019113000482320786],[74,-0.03500000014901161,1.1267876625061035,0.019230101257562637],[75,-0.033340901136398315,1.1271499395370483,0.019315700978040695],[76,-0.03154719993472099,1.1275428533554077,0.019366400316357613],[77,-0.029628699645400047,1.1279617547988892,0.019378801807761192],[78,-0.02759520150721073,1.1284021139144897,0.0193496011197567],[79,-0.025456398725509644,1.128859519958496,0.019275499507784843],[80,-0.02322230115532875,1.1293293237686157,0.019153200089931488],[81,-0.020902499556541443,1.1298067569732666,0.018972400575876236],[82,-0.01850689947605133,1.130287528038025,0.018723798915743828],[83,-0.01604519970715046,1.130766749382019,0.018405800685286522],[84,-0.013527399860322475,1.1312401294708252,0.018016299232840538],[85,-0.010963200591504574,1.1317027807235718,0.017553700134158134],[86,-0.008362299762666225,1.1321505308151245,0.017016099765896797],[87,-0.005734700243920088,1.1325784921646118,0.01640170067548752],[88,-0.0030900000128895044,1.1329821348190308,0.015708500519394875],[89,-0.00043810001807287335,1.1333569288253784,0.014934900216758251],[90,0.0022111001890152693,1.1336983442306519,0.014078999869525433],[91,0.004848000127822161,1.134001612663269,0.013138900510966778],[92,0.007462699897587299,1.1342623233795166,0.012112800031900406],[93,0.010045300237834454,1.1344759464263916,0.010998900048434734],[94,0.0125862006098032,1.134637713432312,0.009795299731194973],[95,0.0150755001232028,1.134743094444275,0.008500300347805023],[96,0.017503300681710243,1.134787678718567,0.00711200013756752],[97,0.019859999418258667,1.1347378492355347,0.005628600250929594],[98,0.022135600447654724,1.1345716714859009,0.0038745999336242676],[99,0.02432049997150898,1.134301781654358,0.001750200055539608],[100,0.026404699310660362,1.133940577507019,-0.0006328000454232097],[101,0.028378499671816826,1.1335009336471558,-0.0031628001015633345],[102,0.030232099816203117,1.1329951286315918,-0.005727899726480246],[103,0.03195570036768913,1.132435917854309,-0.008216599933803082],[104,0.03353939950466156,1.1318358182907104,-0.010517200455069542],[105,0.03497360274195671,1.1312075853347778,-0.012517799623310566],[106,0.03624830022454262,1.1305636167526245,-0.014106799848377705],[107,0.03735379874706268,1.1299165487289429,-0.01517259981483221],[108,0.03828030079603195,1.1292790174484253,-0.015603299252688885],[109,0.03901800140738487,1.1286633014678955,-0.01567080058157444],[110,0.03955700248479843,1.128082513809204,-0.0157220009714365],[111,0.039887603372335434,1.1275488138198853,-0.015757901594042778],[112,0.04000000283122063,1.1270750761032104,-0.01577950082719326],[113,0.040002502501010895,1.1266735792160034,-0.015787899494171143],[114,0.04000860080122948,1.1263571977615356,-0.015784000977873802],[115,0.04001600295305252,1.1261383295059204,-0.015768900513648987],[116,0.04002229869365692,1.12602961063385,-0.015743400901556015],[117,0.04002530127763748,1.125994086265564,-0.0157088004052639],[118,0.040022701025009155,1.125984787940979,-0.015665901824831963],[119,0.04001219943165779,1.1259998083114624,-0.015615800395607948],[120,0.03999150171875954,1.1260372400283813,-0.015559501014649868],[121,0.039958201348781586,1.1260948181152344,-0.015497900545597076],[122,0.039910200983285904,1.1261707544326782,-0.015432200394570827],[123,0.03984510153532028,1.1262627840042114,-0.015363200567662716],[124,0.03976060077548027,1.1263691186904907,-0.015292100608348846],[125,0.03965450078248978,1.1264876127243042,-0.015219800174236298],[126,0.03952440246939659,1.12661612033844,-0.015147300437092781],[127,0.039367999881505966,1.1267527341842651,-0.01507560070604086],[128,0.03918300196528435,1.126895546913147,-0.015005799941718578],[129,0.038967300206422806,1.1270424127578735,-0.01493880059570074],[130,0.03871830180287361,1.1271913051605225,-0.014875699765980244],[131,0.038433998823165894,1.1273401975631714,-0.014817400835454464],[132,0.03811190277338028,1.127487063407898,-0.014765000902116299],[133,0.03774980083107948,1.1276299953460693,-0.014719500206410885],[134,0.03734540194272995,1.1277666091918945,-0.014681899920105934],[135,0.03689640015363693,1.1278952360153198,-0.014653200283646584],[136,0.03640040010213852,1.1280139684677124,-0.014634299091994762],[137,0.03585530072450638,1.1281203031539917,-0.014626400545239449],[138,0.0352587029337883,1.128212571144104,-0.014630399644374847],[139,0.034608300775289536,1.1282886266708374,-0.014647300355136395],[140,0.03390190005302429,1.1283464431762695,-0.014678100124001503],[141,0.0331370010972023,1.128448724746704,-0.014723899774253368],[142,0.03231149911880493,1.1286519765853882,-0.014785599894821644],[143,0.03142310306429863,1.128945231437683,-0.014769899658858776],[144,0.03046940080821514,1.1293175220489502,-0.014591099694371223],[145,0.029413102194666862,1.1297576427459717,-0.014262199401855469],[146,0.028221501037478447,1.1302547454833984,-0.013795900158584118],[147,0.02689940109848976,1.1307975053787231,-0.013204899616539478],[148,0.025451600551605225,1.1313750743865967,-0.012502099387347698],[149,0.023882700130343437,1.1319764852523804,-0.011700200848281384],[150,0.022197600454092026,1.1325905323028564,-0.010812100023031235],[151,0.02040099911391735,1.1332062482833862,-0.009850500151515007],[152,0.01849769987165928,1.133812427520752,-0.008828199468553066],[153,0.01649240031838417,1.134398341178894,-0.007758100517094135],[154,0.01438989955931902,1.1349527835845947,-0.006652799900621176],[155,0.012195000424981117,1.1354646682739258,-0.0055252001620829105],[156,0.009912400506436825,1.1359230279922485,-0.004388100001960993],[157,0.007546799723058939,1.1363167762756348,-0.0032542000990360975],[158,0.005102999974042177,1.1366348266601562,-0.00213639996945858],[159,0.0025858001317828894,1.1368663311004639,-0.0010474000591784716],[160,0,1.1369999647140503,0]]}]},"895":{"name":"F_stand_kamae03.gmt","root":"center_n","frames":145,"fps":30,"loop":true,"translation":[{"axis":"xyz","keys":[[0,0,1.121000051498413,0],[1,-0.00355999986641109,1.12009859085083,-0.0007184999994933605],[2,-0.006948699709028006,1.1192573308944702,-0.0014417000347748399],[3,-0.010170199908316135,1.1184743642807007,-0.00216630008071661],[4,-0.013228900730609894,1.1177481412887573,-0.0028890001121908426],[5,-0.01612900011241436,1.1170766353607178,-0.0036063999868929386],[6,-0.018874701112508774,1.1164582967758179,-0.004315400030463934],[7,-0.02147050015628338,1.1158913373947144,-0.00501250009983778],[8,-0.023920400068163872,1.115373969078064,-0.005694599822163582],[9,-0.026228899136185646,1.114904522895813,-0.006358399987220764],[10,-0.028400201350450516,1.1144813299179077,-0.0070004998706281185],[11,-0.03043850138783455,1.1141023635864258,-0.00761760026216507],[12,-0.03234810009598732,1.1137661933898926,-0.008206600323319435],[13,-0.03413330018520355,1.1134709119796753,-0.008764000609517097],[14,-0.03579840064048767,1.1132148504257202,-0.009286700747907162],[15,-0.0373477004468441,1.112985610961914,-0.009771200828254223],[16,-0.03878530114889145,1.1127722263336182,-0.010214400477707386],[17,-0.0401156023144722,1.1125741004943848,-0.010612900368869305],[18,-0.041342899203300476,1.1123913526535034,-0.010963399894535542],[19,-0.042471401393413544,1.112223505973816,-0.011262699961662292],[20,-0.04350540041923523,1.1120704412460327,-0.01150749996304512],[21,-0.044449202716350555,1.1119316816329956,-0.011694500222802162],[22,-0.04530700296163559,1.1118073463439941,-0.011820300482213497],[23,-0.046083200722932816,1.1116969585418701,-0.01188180036842823],[24,-0.04678190127015114,1.1116002798080444,-0.011875600554049015],[25,-0.04740750044584274,1.1115169525146484,-0.011778900399804115],[26,-0.047964200377464294,1.1114472150802612,-0.011576800607144833],[27,-0.048456400632858276,1.111390233039856,-0.011278199963271618],[28,-0.048888202756643295,1.1113461256027222,-0.01089170016348362],[29,-0.04926390200853348,1.1113145351409912,-0.010426199994981289],[30,-0.049587901681661606,1.111295223236084,-0.0098903002217412],[31,-0.049864400178194046,1.1112879514694214,-0.009292899630963802],[32,-0.05009760335087776,1.1112924814224243,-0.008642599917948246],[33,-0.05029190331697464,1.1113084554672241,-0.007948300801217556],[34,-0.05045149847865105,1.1113357543945312,-0.007218600250780582],[35,-0.0505806989967823,1.1113742589950562,-0.006462299730628729],[36,-0.050683703273534775,1.1114234924316406,-0.005688200239092112],[37,-0.050789397209882736,1.1114833354949951,-0.00490510044619441],[38,-0.0509193018078804,1.1115535497665405,-0.004121600184589624],[39,-0.05106649920344353,1.1116336584091187,-0.0033465002197772264],[40,-0.05122410133481026,1.111723780632019,-0.002588599920272827],[41,-0.0513853020966053,1.1118234395980835,-0.001856599934399128],[42,-0.05154320225119591,1.1119325160980225,-0.001159299979917705],[43,-0.051691003143787384,1.1120506525039673,-0.0005054000066593289],[44,-0.05182189866900444,1.1121776103973389,0.0000962999984039925],[45,-0.05192890390753746,1.112313151359558,0.0006371000199578702],[46,-0.05200530216097832,1.1124571561813354,0.0011083000572398305],[47,-0.0520441010594368,1.1126092672348022,0.0015010000206530094],[48,-0.05203850194811821,1.112769365310669,0.0018066000193357468],[49,-0.05198180302977562,1.1129369735717773,0.0020161999855190516],[50,-0.05186690017580986,1.1131120920181274,0.0021662001963704824],[51,-0.051687099039554596,1.1132943630218506,0.0022887999657541513],[52,-0.051435500383377075,1.1134834289550781,0.002369800116866827],[53,-0.051105301827192307,1.11367928981781,0.0023944000713527203],[54,-0.05068949982523918,1.1138814687728882,0.002348399953916669],[55,-0.05018150433897972,1.114089846611023,0.002217100001871586],[56,-0.04957420006394386,1.1143041849136353,0.0019861001055687666],[57,-0.04886090010404587,1.114524245262146,0.0016409000381827354],[58,-0.04803460091352463,1.114749789237976,0.001167000038549304],[59,-0.04708860069513321,1.1150095462799072,0.0005499000544659793],[60,-0.04601610079407692,1.1153267621994019,-0.00022489999537356198],[61,-0.04481000080704689,1.1156928539276123,-0.0011718000750988722],[62,-0.04346359893679619,1.1160991191864014,-0.00230529997497797],[63,-0.04197010025382042,1.1165367364883423,-0.0034875001292675734],[64,-0.040322501212358475,1.116997241973877,-0.004572900012135506],[65,-0.03851410001516342,1.1174719333648682,-0.005565000232309103],[66,-0.03653800114989281,1.1179521083831787,-0.006467100232839584],[67,-0.03438720107078552,1.1184290647506714,-0.0072825001552701],[68,-0.03205510228872299,1.1188939809799194,-0.008014700375497341],[69,-0.0295345988124609,1.1193385124206543,-0.008666999638080597],[70,-0.026819100603461266,1.1197538375854492,-0.009242800064384937],[71,-0.023901499807834625,1.120131254196167,-0.009745399467647076],[72,-0.0209237989038229,1.12046217918396,-0.01017830055207014],[73,-0.018032100051641464,1.1207377910614014,-0.010544700548052788],[74,-0.015226100571453571,1.120949625968933,-0.010848200879991055],[75,-0.012505500577390194,1.1210887432098389,-0.011091900058090687],[76,-0.009869900532066822,1.1211466789245605,-0.011279399506747723],[77,-0.007319100201129913,1.1209611892700195,-0.011413900181651115],[78,-0.004852599930018187,1.1204379796981812,-0.011498900130391121],[79,-0.0024701999500393867,1.1196701526641846,-0.011537699960172176],[80,-0.00017150001076515764,1.1187506914138794,-0.011533699929714203],[81,0.0020437000785022974,1.1177729368209839,-0.011490199714899063],[82,0.004176000133156776,1.116829752922058,-0.011410700157284737],[83,0.006225400138646364,1.1160145998001099,-0.011298500001430511],[84,0.008192500099539757,1.1154204607009888,-0.0111569007858634],[85,0.010077400133013725,1.115140438079834,-0.010989400558173656],[86,0.011880599893629551,1.115052580833435,-0.01079929992556572],[87,0.013602400198578835,1.114972472190857,-0.010590000078082085],[88,0.015243100002408028,1.11489999294281,-0.01036479976028204],[89,0.01680300012230873,1.1148350238800049,-0.010127200745046139],[90,0.01828240044414997,1.1147774457931519,-0.009880500845611095],[91,0.01968180015683174,1.1147269010543823,-0.009628000669181347],[92,0.0210012998431921,1.1146835088729858,-0.009344800375401974],[93,0.02224140055477619,1.1146467924118042,-0.009008199907839298],[94,0.023402400314807892,1.1146167516708374,-0.008625100366771221],[95,0.024484600871801376,1.1145933866500854,-0.00820240005850792],[96,0.025488300248980522,1.1145761013031006,-0.007746999617666006],[97,0.026413802057504654,1.114565134048462,-0.007265800144523382],[98,0.027261599898338318,1.1145600080490112,-0.006765600293874741],[99,0.02803179994225502,1.114560842514038,-0.00625329976901412],[100,0.028724899515509605,1.1145672798156738,-0.0057358997873961926],[101,0.02934120036661625,1.114579200744629,-0.005220200400799513],[102,0.02988089993596077,1.1145964860916138,-0.004713200032711029],[103,0.03034450113773346,1.1146188974380493,-0.004221600014716387],[104,0.030732301995158195,1.114646315574646,-0.0037523999344557524],[105,0.031044501811265945,1.1146786212921143,-0.003312499960884452],[106,0.031281501054763794,1.1147154569625854,-0.0029086999129503965],[107,0.031443700194358826,1.1147568225860596,-0.0025480000767856836],[108,0.03153130039572716,1.1148027181625366,-0.002203800017014146],[109,0.031544800847768784,1.1148524284362793,-0.001846599974669516],[110,0.03148440271615982,1.1149061918258667,-0.0014786000829190016],[111,0.03135040029883385,1.1149638891220093,-0.0011020000092685223],[112,0.031213998794555664,1.1150254011154175,-0.0007193000055849552],[113,0.031139299273490906,1.1150901317596436,-0.0003327000013086945],[114,0.031115902587771416,1.1151583194732666,0.000055599997722310945],[115,0.031133800745010376,1.115229606628418,0.0004432000278029591],[116,0.03118250146508217,1.115303874015808,0.0008278000168502331],[117,0.031251903623342514,1.115381121635437,0.001207199995405972],[118,0.031331803649663925,1.1154608726501465,0.0015791001496836543],[119,0.031411800533533096,1.115543246269226,0.001941199996508658],[120,0.031481798738241196,1.1156277656555176,0.0022911999840289354],[121,0.031531501561403275,1.1157146692276,0.0026267000939697027],[122,0.03155070170760155,1.1158033609390259,0.00294560007750988],[123,0.03152900189161301,1.115893840789795,0.0032456000335514545],[124,0.03145630285143852,1.1159862279891968,0.003524199826642871],[125,0.03132240101695061,1.1160799264907837,0.003779300022870302],[126,0.031116900965571404,1.1161750555038452,0.0040086000226438046],[127,0.03082970157265663,1.1162712574005127,0.004209800157696009],[128,0.030450498685240746,1.1163684129714966,0.004380499944090843],[129,0.029969001188874245,1.116552710533142,0.004518600180745125],[130,0.029374999925494194,1.1168912649154663,0.004621600266546011],[131,0.028658300638198853,1.1173553466796875,0.004687400069087744],[132,0.027808601036667824,1.117916226387024,0.004713600035756826],[133,0.02681559883058071,1.118545413017273,0.004698000382632017],[134,0.025669200345873833,1.119214415550232,0.004638200160115957],[135,0.024359099566936493,1.1198943853378296,0.004532000049948692],[136,0.022875100374221802,1.1205567121505737,0.004364000167697668],[137,0.021206801757216454,1.1211727857589722,0.0041228998452425],[138,0.01934410072863102,1.1217138767242432,0.0038123000413179398],[139,0.017276600003242493,1.122151494026184,0.003435799852013588],[140,0.014994299970567226,1.1224570274353027,0.0029972000047564507],[141,0.012486799620091915,1.1226017475128174,0.0025001000612974167],[142,0.009743800386786461,1.1225570440292358,0.0019480999326333404],[143,0.0067552002146840096,1.122294306755066,0.0013450001133605838],[144,0.0035107003059238195,1.1217848062515259,0.000694399990607053],[145,0,1.121000051498413,0]]}]},"981":{"name":"M_cheer_arm.gmt","root":"center_n","frames":60,"fps":30,"loop":true,"translation":[{"axis":"xyz","keys":[[0,0,1.0609999895095825,0],[1,-0.0008046000148169696,1.0511382818222046,0.0018199001206085086],[2,-0.002988399937748909,1.042046070098877,0.006413699593394995],[3,-0.00620670011267066,1.0406553745269775,0.012482299469411373],[4,-0.010114599950611591,1.0496095418930054,0.018727000802755356],[5,-0.0143673000857234,1.065003752708435,0.023848799988627434],[6,-0.018620101734995842,1.083947777748108,0.026548800989985466],[7,-0.02252800017595291,1.1035515069961548,0.023511899635195732],[8,-0.02574630081653595,1.1212453842163086,0.015983400866389275],[9,-0.027930302545428276,1.135500192642212,0.009504499845206738],[10,-0.028734898194670677,1.1449854373931885,0.005903800018131733],[11,-0.027815600857138634,1.1483711004257202,0.0033525999169796705],[12,-0.02472119964659214,1.1441773176193237,0.0019063999643549323],[13,-0.019871000200510025,1.1334881782531738,0.0011345000239089131],[14,-0.014225299470126629,1.1188206672668457,0.0005892000044696033],[15,-0.008744300343096256,1.1026909351348877,0.0003006000188179314],[16,-0.0021112000104039907,1.0858619213104248,0.00029850000282749534],[17,0.006346500013023615,1.0686224699020386,0.0006129000103101134],[18,0.01470119971781969,1.0527786016464233,0.0012738000368699431],[19,0.021025599911808968,1.040135383605957,0.002311000134795904],[20,0.02339250035583973,1.032498836517334,0.0037546001840382814],[21,0.020630599930882454,1.0316743850708008,0.007582200225442648],[22,0.01402480062097311,1.039467692375183,0.014015999622642994],[23,0.005331899970769882,1.0562479496002197,0.02045300044119358],[24,-0.003691399935632944,1.0781883001327515,0.024289900436997414],[25,-0.01128809992223978,1.1008009910583496,0.021901700645685196],[26,-0.016750698909163475,1.1195977926254272,0.014978299848735332],[27,-0.02064800076186657,1.1330302953720093,0.00888840015977621],[28,-0.023137900978326797,1.1417531967163086,0.006246100179851055],[29,-0.024378100410103798,1.1445834636688232,0.005391600076109171],[30,-0.024526601657271385,1.140337347984314,0.005283299833536148],[31,-0.02412319928407669,1.1299370527267456,0.004879600368440151],[32,-0.02347159944474697,1.1164710521697998,0.0031385000329464674],[33,-0.02237520180642605,1.1020066738128662,-0.0004280999710317701],[34,-0.020637400448322296,1.0886110067367554,-0.003843399928882718],[35,-0.018061701208353043,1.0761533975601196,-0.005737400148063898],[36,-0.014444700442254543,1.063611388206482,-0.006525599863380194],[37,-0.010254500433802605,1.0517144203186035,-0.006231000181287527],[38,-0.006301300134509802,1.0411916971206665,-0.004245100077241659],[39,-0.0033953997772186995,1.032772421836853,-0.00017850000585895032],[40,-0.002346999943256378,1.0271861553192139,0.005617100279778242],[41,-0.003814800176769495,1.0251619815826416,0.012790100648999214],[42,-0.00725860008969903,1.0317505598068237,0.021943099796772003],[43,-0.011690500192344189,1.048791766166687,0.03178820013999939],[44,-0.016122398898005486,1.0721982717514038,0.039138101041316986],[45,-0.019566601142287254,1.097882866859436,0.0408053994178772],[46,-0.022464800626039505,1.1216933727264404,0.03524250164628029],[47,-0.02540700137615204,1.141577124595642,0.026268398389220238],[48,-0.027626698836684227,1.1565965414047241,0.01874540001153946],[49,-0.028357500210404396,1.1658138036727905,0.013964100740849972],[50,-0.027474600821733475,1.1682910919189453,0.009990700520575047],[51,-0.02552570216357708,1.1613961458206177,0.006850400008261204],[52,-0.022753199562430382,1.1486414670944214,0.004568600095808506],[53,-0.01939930021762848,1.1358479261398315,0.0029605000745505095],[54,-0.0157065000385046,1.1233829259872437,0.0017802000511437654],[55,-0.011916900053620338,1.1113446950912476,0.0009620999917387962],[56,-0.008273000828921795,1.0998317003250122,0.00044030003482475877],[57,-0.005017000250518322,1.088942289352417,0.00014890001330059022],[58,-0.002391299931332469,1.0787748098373413,0.000022300000637187622],[59,-0.000638200028333813,1.0694279670715332,-0.0000054000001910026185],[60,0,1.0609999895095825,0]]}]},"982":{"name":"M_cheer_hakusyu.gmt","root":"center_n","frames":35,"fps":30,"loop":true,"translation":[{"axis":"xyz","keys":[[0,0,1.100000023841858,0],[1,-0.0011177000124007463,1.0997049808502197,0.000602699990849942],[2,-0.0041181002743542194,1.098861575126648,0.002297900151461363],[3,-0.008073300123214722,1.0975333452224731,0.004916800186038017],[4,-0.012055500410497189,1.0957831144332886,0.008290099911391735],[5,-0.015137000940740108,1.093673825263977,0.012248899787664413],[6,-0.0163900014013052,1.0912688970565796,0.016624100506305695],[7,-0.015558900311589241,1.0886311531066895,0.02124669961631298],[8,-0.013382199220359325,1.085823893547058,0.02594750002026558],[9,-0.010422799736261368,1.0829099416732788,0.030557701364159584],[10,-0.007243800442665815,1.079952597618103,0.034908000379800797],[11,-0.00440810015425086,1.0770149230957031,0.0388295017182827],[12,-0.0024786998983472586,1.0741599798202515,0.04215310141444206],[13,-0.0020186000037938356,1.0714508295059204,0.0447097010910511],[14,-0.0030338000506162643,1.0689505338668823,0.046330299228429794],[15,-0.00494630029425025,1.0667222738265991,0.046845901757478714],[16,-0.007443200331181288,1.0648292303085327,0.04642210155725479],[17,-0.010211500339210033,1.0633341073989868,0.04538309946656227],[18,-0.012938099913299084,1.0623003244400024,0.043797802180051804],[19,-0.01531010027974844,1.061790943145752,0.041735101491212845],[20,-0.017014600336551666,1.0620211362838745,0.039263900369405746],[21,-0.017738400027155876,1.0630863904953003,0.03645290061831474],[22,-0.017285700887441635,1.0648690462112427,0.033371202647686005],[23,-0.015873299911618233,1.0672520399093628,0.03008750081062317],[24,-0.013807800598442554,1.0701183080673218,0.026670699939131737],[25,-0.011395400390028954,1.0733503103256226,0.02318969927728176],[26,-0.008942699991166592,1.0768309831619263,0.019713399931788445],[27,-0.006756100337952375,1.080443024635315,0.01631060056388378],[28,-0.005142000038176775,1.0840691328048706,0.013050300069153309],[29,-0.003972900100052357,1.087592363357544,0.010001200251281261],[30,-0.002926100045442581,1.0908950567245483,0.007232200354337692],[31,-0.0020151000935584307,1.0938600301742554,0.004812299739569426],[32,-0.0012533999979496002,1.0963705778121948,0.0028101999778300524],[33,-0.0006546999793499708,1.098308801651001,0.0012949000811204314],[34,-0.00023230000806506723,1.0995577573776245,0.00033519999124109745],[35,0,1.100000023841858,0]]}]},"983":{"name":"M_cheer_kuchibue.gmt","root":"center_n","frames":50,"fps":30,"loop":true,"translation":[{"axis":"xyz","keys":[[0,0,1.0839999914169312,0],[1,0.00020280001626815647,1.0869897603988647,0.0021927999332547188],[2,0.0003425000177230686,1.0905531644821167,0.00561530003324151],[3,0.0004220999835524708,1.0939067602157593,0.00746709993109107],[4,0.0004443999787326902,1.0962669849395752,0.00705979997292161],[5,0.0004124999977648258,1.096850037574768,0.005724200047552586],[6,0.00032920000376179814,1.0942882299423218,0.0036899999249726534],[7,0.00019759999122470617,1.0885390043258667,0.0011866999557241797],[8,0.000020600000425474718,1.0808076858520508,-0.0012954999692738056],[9,-0.00036440000985749066,1.0722990036010742,-0.00317169982008636],[10,-0.0010576000204309821,1.0642176866531372,-0.004070600029081106],[11,-0.001962000038474798,1.057768702507019,-0.003621000098064542],[12,-0.002980800112709403,1.0526162385940552,-0.0015714999753981829],[13,-0.00401710020378232,1.0477776527404785,0.001445300062187016],[14,-0.004974000155925751,1.0434874296188354,0.00447490019723773],[15,-0.005754699930548668,1.0399802923202515,0.006562899798154831],[16,-0.006262300070375204,1.036981463432312,0.0077818999998271465],[17,-0.006581699941307306,1.0341941118240356,0.008845300413668156],[18,-0.006863000337034464,1.03181791305542,0.009759499691426754],[19,-0.007107199635356665,1.0300527811050415,0.010531200096011162],[20,-0.007315500173717737,1.0290985107421875,0.011166899465024471],[21,-0.007488799747079611,1.0287047624588013,0.011673199944198132],[22,-0.007628200110048056,1.0284836292266846,0.01205660030245781],[23,-0.007734700571745634,1.028429388999939,0.01232369989156723],[24,-0.007809400092810392,1.028536081314087,0.012481000274419785],[25,-0.007853200659155846,1.02879798412323,0.012535099871456623],[26,-0.007867200300097466,1.0292091369628906,0.012492700479924679],[27,-0.007852500304579735,1.0297638177871704,0.012360099703073502],[28,-0.007810100447386503,1.0304560661315918,0.012144000269472599],[29,-0.007741000037640333,1.0312801599502563,0.011850900016725063],[30,-0.007646200247108936,1.0322301387786865,0.011487500742077827],[31,-0.007526800036430359,1.0333002805709839,0.011060199700295925],[32,-0.007383900228887796,1.034484624862671,0.01057559996843338],[33,-0.007218399550765753,1.0357773303985596,0.010040300898253918],[34,-0.007031399756669998,1.037172555923462,0.00946080032736063],[35,-0.006824000272899866,1.0386645793914795,0.00884380005300045],[36,-0.006597100291401148,1.0402474403381348,0.008195600472390652],[37,-0.006351800169795752,1.0419152975082397,0.007523000240325928],[38,-0.006089100148528814,1.043662428855896,0.006832499988377094],[39,-0.005810100119560957,1.0454827547073364,0.00613059988245368],[40,-0.0055158999748528,1.0473706722259521,0.005423800088465214],[41,-0.005138299893587828,1.0496184825897217,0.004641300067305565],[42,-0.0046315002255141735,1.0524542331695557,0.00374850002117455],[43,-0.004029400181025267,1.0557752847671509,0.002806900069117546],[44,-0.003365900134667754,1.0594791173934937,0.0018776999786496162],[45,-0.0026750999968498945,1.0634633302688599,0.0010223999852314591],[46,-0.0019910000264644623,1.0676254034042358,0.00030220000189729035],[47,-0.001347400015220046,1.0718625783920288,-0.0002215000131400302],[48,-0.000778400048147887,1.076072335243225,-0.0004873000143561512],[49,-0.00031790000502951443,1.0801523923873901,-0.000434000015957281],[50,0,1.0839999914169312,0]]}]},"989":{"name":"M_cheer_yaji.gmt","root":"center_n","frames":270,"fps":30,"loop":true,"translation":[{"axis":"xyz","keys":[[0,0,1.125,0],[1,0.0017596998950466514,1.1249784231185913,-0.00001650000012887176],[2,0.0022456999868154526,1.1249523162841797,-0.0035538000520318747],[3,0.0036674998700618744,1.1244901418685913,-0.012343300506472588],[4,0.005970700178295374,1.1230157613754272,-0.02695629931986332],[5,0.009101100265979767,1.1204026937484741,-0.04512600228190422],[6,0.013004399836063385,1.116937279701233,-0.06404759734869003],[7,0.0176262017339468,1.1126620769500732,-0.08169300109148026],[8,0.022912299260497093,1.1076200008392334,-0.09603440016508102],[9,0.028002599254250526,1.1013740301132202,-0.10603740066289902],[10,0.032042600214481354,1.0940510034561157,-0.11242649704217911],[11,0.034985799342393875,1.0865389108657837,-0.11581219732761383],[12,0.0367858000099659,1.0797263383865356,-0.11680509895086288],[13,0.03739609941840172,1.0742006301879883,-0.11636710166931152],[14,0.03658450022339821,1.0693714618682861,-0.11479660123586655],[15,0.03435030207037926,1.0643595457077026,-0.11170870065689087],[16,0.03099440038204193,1.0582859516143799,-0.10671880096197128],[17,0.026551399379968643,1.050428032875061,-0.09960120171308517],[18,0.021287400275468826,1.0414172410964966,-0.09060230106115341],[19,0.015849800780415535,1.032406210899353,-0.08004459738731384],[20,0.010886300355196,1.0245474576950073,-0.06825100630521774],[21,0.006840100046247244,1.0197738409042358,-0.05636550113558769],[22,0.003714200109243393,1.0184495449066162,-0.04587220028042793],[23,0.0014964001020416617,1.0213351249694824,-0.0376042015850544],[24,0.00017470000602770597,1.0302180051803589,-0.03239449858665466],[25,-0.00026309999520890415,1.0441179275512695,-0.030420899391174316],[26,-0.000021899999410379678,1.0609759092330933,-0.030978098511695862],[27,0.0007054000161588192,1.0795127153396606,-0.033574700355529785],[28,0.0019239999819546938,1.0984491109848022,-0.037719398736953735],[29,0.003700900124385953,1.1117064952850342,-0.04239409789443016],[30,0.005883200094103813,1.1156089305877686,-0.04682769998908043],[31,0.00814600009471178,1.1137551069259644,-0.05089950188994408],[32,0.010164500214159489,1.1088404655456543,-0.05448859930038452],[33,0.011613800190389156,1.101834774017334,-0.057474296540021896],[34,0.01216910034418106,1.093993067741394,-0.059787001460790634],[35,0.01200919970870018,1.086136817932129,-0.06147639825940132],[36,0.011355900205671787,1.078586459159851,-0.06260039657354355],[37,0.009948600083589554,1.0716620683670044,-0.06321709603071213],[38,0.007609900087118149,1.0654958486557007,-0.06338440626859665],[39,0.004641800187528133,1.0596388578414917,-0.06316030025482178],[40,0.0015034000389277935,1.053539752960205,-0.062602698802948],[41,-0.0013460000045597553,1.0466474294662476,-0.061769600957632065],[42,-0.00355999986641109,1.0382359027862549,-0.06045820191502571],[43,-0.005362100433558226,1.0304430723190308,-0.057914502918720245],[44,-0.007148300297558308,1.0270135402679443,-0.053369998931884766],[45,-0.009314499795436859,1.0301707983016968,-0.046056102961301804],[46,-0.012565900571644306,1.0394524335861206,-0.033464301377534866],[47,-0.016491500660777092,1.0545730590820312,-0.016970500349998474],[48,-0.019812799990177155,1.0723170042037964,-0.0016326999757438898],[49,-0.021251199766993523,1.0898607969284058,0.008356000296771526],[50,-0.020100301131606102,1.1075077056884766,0.013674399815499783],[51,-0.016234800219535828,1.1222960948944092,0.016283700242638588],[52,-0.009247800335288048,1.1313250064849854,0.01749030128121376],[53,0.0016522000078111887,1.1349897384643555,0.01856200024485588],[54,0.012735100463032722,1.1336854696273804,0.02076669968664646],[55,0.01934110000729561,1.1271189451217651,0.024824900552630424],[56,0.02142239920794964,1.117629885673523,0.030046800151467323],[57,0.020945901051163673,1.1095620393753052,0.035584401339292526],[58,0.019270099699497223,1.1072590351104736,0.04058980196714401],[59,0.016633300110697746,1.1129720211029053,0.044214800000190735],[60,0.014125600457191467,1.1248135566711426,0.04561160132288933],[61,0.01258269976824522,1.1404937505722046,0.04497390240430832],[62,0.012587599456310272,1.154013752937317,0.04304200038313866],[63,0.014662399888038635,1.1603813171386719,0.039788201451301575],[64,0.017946500331163406,1.1611988544464111,0.03518440201878548],[65,0.02083970047533512,1.1572130918502808,0.029459400102496147],[66,0.022676000371575356,1.1477316617965698,0.02305780164897442],[67,0.023311899974942207,1.133060336112976,0.016275200992822647],[68,0.022816400974988937,1.1135237216949463,0.009407199919223785],[69,0.021236900240182877,1.092807650566101,0.002749399980530143],[70,0.018396800383925438,1.0751221179962158,-0.0034026000648736954],[71,0.014644100330770016,1.0616941452026367,-0.008753000758588314],[72,0.010441000573337078,1.0531152486801147,-0.012700499966740608],[73,0.00578249990940094,1.048804521560669,-0.015213899314403534],[74,0.0006632000440731645,1.0478785037994385,-0.016853200271725655],[75,-0.004922100342810154,1.0494533777236938,-0.01817850023508072],[76,-0.010717500001192093,1.051939845085144,-0.0193766001611948],[77,-0.01570740155875683,1.0539357662200928,-0.02024270035326481],[78,-0.01875779964029789,1.05483877658844,-0.020748799666762352],[79,-0.018734101206064224,1.0540461540222168,-0.020867200568318367],[80,-0.014994400553405285,1.051682710647583,-0.020159399136900902],[81,-0.008825699798762798,1.0492501258850098,-0.017669301480054855],[82,-0.002710100030526519,1.0482128858566284,-0.01303160097450018],[83,0.0021387001033872366,1.050034999847412,-0.006786399986594915],[84,0.0058639999479055405,1.0561808347702026,0.000513700011651963],[85,0.008600699715316296,1.0674277544021606,0.008315800689160824],[86,0.01059970073401928,1.0825022459030151,0.016067400574684143],[87,0.012178300879895687,1.0997918844223022,0.023215701803565025],[88,0.01365440059453249,1.1176838874816895,0.029207998886704445],[89,0.015243700705468655,1.1344178915023804,0.03193270042538643],[90,0.017065901309251785,1.1480426788330078,0.0298117995262146],[91,0.019294099882245064,1.1566599607467651,0.024518899619579315],[92,0.022101501002907753,1.1583713293075562,0.017935199663043022],[93,0.024960700422525406,1.1523981094360352,0.011521300300955772],[94,0.027215702459216118,1.141422986984253,0.006225300021469593],[95,0.028846699744462967,1.1287384033203125,0.0018363998970016837],[96,0.029913801699876785,1.117637276649475,-0.0018562000477686524],[97,0.03055639937520027,1.1103875637054443,-0.005063300020992756],[98,0.030873600393533707,1.10641348361969,-0.00799570046365261],[99,0.030964000150561333,1.104742407798767,-0.01086410041898489],[100,0.030926702544093132,1.1044015884399414,-0.013600500300526619],[101,0.030860498547554016,1.1045242547988892,-0.016034601256251335],[102,0.030862702056765556,1.1048102378845215,-0.01822340115904808],[103,0.03096959926187992,1.1051609516143799,-0.02022409997880459],[104,0.0311886016279459,1.1055455207824707,-0.022093800827860832],[105,0.03152709826827049,1.1059426069259644,-0.023889699950814247],[106,0.03199240192770958,1.106330394744873,-0.025668999180197716],[107,0.03259199857711792,1.1066876649856567,-0.02748890034854412],[108,0.03330039978027344,1.107010006904602,-0.02940629981458187],[109,0.03409440070390701,1.1072725057601929,-0.03147859871387482],[110,0.03498459979891777,1.1074224710464478,-0.03369089961051941],[111,0.03598150238394737,1.1074069738388062,-0.0359329991042614],[112,0.037095602601766586,1.106813907623291,-0.03811870142817497],[113,0.0383572019636631,1.1049541234970093,-0.04016200080513954],[114,0.03933199867606163,1.101058840751648,-0.04184029996395111],[115,0.03933360055088997,1.0934211015701294,-0.04114370048046112],[116,0.03748520091176033,1.0806573629379272,-0.03580930083990097],[117,0.03367749974131584,1.0654925107955933,-0.02230839990079403],[118,0.028374800458550453,1.052213430404663,-0.003644800279289484],[119,0.022206401452422142,1.042574405670166,0.016735099256038666],[120,0.015883399173617363,1.0351340770721436,0.03602760285139084],[121,0.00999310053884983,1.0293850898742676,0.05146980285644531],[122,0.005122700240463018,1.0248205661773682,0.06313910335302353],[123,0.0011538000544533134,1.0216315984725952,0.07192660123109818],[124,-0.002280399901792407,1.0205131769180298,0.07779409736394882],[125,-0.004965600091964006,1.023133635520935,0.0798121988773346],[126,-0.006687399931252003,1.0324057340621948,0.07705169916152954],[127,-0.007604199927300215,1.048648476600647,0.06863800436258316],[128,-0.00803729984909296,1.0690089464187622,0.05548179894685745],[129,-0.008016700856387615,1.0908443927764893,0.039332300424575806],[130,-0.00757210049778223,1.111512303352356,0.021938500925898552],[131,-0.006346800364553928,1.1290749311447144,0.005362800322473049],[132,-0.004238000139594078,1.1415752172470093,-0.009547299705445766],[133,-0.0016573999309912324,1.1471056938171387,-0.022864699363708496],[134,0.0009835000382736325,1.1461331844329834,-0.03466250002384186],[135,0.0032731001265347004,1.13954758644104,-0.04501360282301903],[136,0.00481799989938736,1.1287339925765991,-0.05353990197181702],[137,0.005616100039333105,1.1158828735351562,-0.05995110422372818],[138,0.0058431001380085945,1.1030933856964111,-0.06445210427045822],[139,0.0055146003141999245,1.0924638509750366,-0.06724800169467926],[140,0.004676600452512503,1.0845974683761597,-0.06809829920530319],[141,0.00354969990439713,1.078561782836914,-0.06743159890174866],[142,0.0023551001213490963,1.074153184890747,-0.06580659747123718],[143,0.0013136001070961356,1.0711679458618164,-0.0637856051325798],[144,0.0006270000012591481,1.0697376728057861,-0.06208549812436104],[145,0.00025939999613910913,1.069671392440796,-0.06100649759173393],[146,0.00007510000432375818,1.0702804327011108,-0.06048640236258507],[147,-0.00006189999839989468,1.0708762407302856,-0.06046270206570625],[148,-0.0002872000040952116,1.070614218711853,-0.06112070009112358],[149,-0.0007368000224232674,1.069445013999939,-0.06209750100970268],[150,-0.001546400017105043,1.0678746700286865,-0.06250850111246109],[151,-0.002851800061762333,1.0664085149765015,-0.061469197273254395],[152,-0.004599099978804588,1.066148281097412,-0.05755900219082832],[153,-0.006369300186634064,1.067574381828308,-0.050586897879838943],[154,-0.007750699762254953,1.070259928703308,-0.04151209816336632],[155,-0.00833120010793209,1.0737781524658203,-0.031293999403715134],[156,-0.008038700558245182,1.0777024030685425,-0.021189501509070396],[157,-0.00717280013486743,1.0816057920455933,-0.012025500647723675],[158,-0.005880200304090977,1.0850616693496704,-0.00411650026217103],[159,-0.004307200200855732,1.0876429080963135,0.002223100047558546],[160,-0.002606100169941783,1.0889230966567993,0.006433799862861633],[161,-0.0008700000471435487,1.0892807245254517,0.008096500299870968],[162,0.0008430999587289989,1.0893901586532593,0.007106799632310867],[163,0.002475599991157651,1.0892677307128906,0.0033604998607188463],[164,0.003969700075685978,1.088930368423462,-0.0032055999618023634],[165,0.005267500411719084,1.0883944034576416,-0.01160580012947321],[166,0.006311299744993448,1.0876765251159668,-0.02037080004811287],[167,0.007043399848043919,1.086793303489685,-0.02803090028464794],[168,0.007405800279229879,1.085761547088623,-0.03311670199036598],[169,0.007435900159180164,1.0845974683761597,-0.03554120287299156],[170,0.00724070006981492,1.0833179950714111,-0.03670259937644005],[171,0.006866899784654379,1.0819395780563354,-0.037359800189733505],[172,0.006361500360071659,1.080315351486206,-0.03827160224318504],[173,0.005793000105768442,1.0783238410949707,-0.03988650068640709],[174,0.00521030044183135,1.0760196447372437,-0.04206719994544983],[175,0.004630000330507755,1.0734570026397705,-0.044693801552057266],[176,0.004068899899721146,1.0706905126571655,-0.04764620214700699],[177,0.0035438002087175846,1.067774772644043,-0.05073750019073486],[178,0.0030712999869138002,1.064764142036438,-0.05369129776954651],[179,0.002700400073081255,1.0617129802703857,-0.056252699345350266],[180,0.002473199972882867,1.0586758852005005,-0.05816730484366417],[181,0.0023960000835359097,1.055707335472107,-0.059122003614902496],[182,0.0025997001212090254,1.0528618097305298,-0.05774590000510216],[183,0.0033365997951477766,1.0501936674118042,-0.05239510163664818],[184,0.004894699901342392,1.0477575063705444,-0.042973101139068604],[185,0.006661099847406149,1.0456076860427856,-0.02995940111577511],[186,0.007786700036376715,1.044052243232727,-0.014915299601852894],[187,0.008310200646519661,1.0432695150375366,0.00013800000306218863],[188,0.00840030051767826,1.0431196689605713,0.014031699858605862],[189,0.008225600235164165,1.0434627532958984,0.0255964994430542],[190,0.007954800501465797,1.0441594123840332,0.03366350010037422],[191,0.0077565996907651424,1.0454280376434326,0.0381540022790432],[192,0.00779950013384223,1.0475540161132812,0.040329303592443466],[193,0.008252300322055817,1.0504974126815796,0.041029900312423706],[194,0.009049899876117706,1.0542182922363281,0.04109660163521767],[195,0.00997570063918829,1.0586763620376587,0.04060729965567589],[196,0.010971199721097946,1.0642355680465698,0.03912610188126564],[197,0.01197780016809702,1.070945143699646,0.036722999066114426],[198,0.012937200255692005,1.0782939195632935,0.03346790000796318],[199,0.013790800236165524,1.0857707262039185,0.02943049930036068],[200,0.014480001293122768,1.0928643941879272,0.02468090131878853],[201,0.014946400187909603,1.099063754081726,0.01928890123963356],[202,0.015131400898098946,1.1038572788238525,0.01332439947873354],[203,0.015126200392842293,1.1067339181900024,0.0068572997115552425],[204,0.014955799095332623,1.1077765226364136,-0.000042499999835854396],[205,0.014462199993431568,1.1075419187545776,-0.00730519974604249],[206,0.013487400487065315,1.106229543685913,-0.014860800467431545],[207,0.011850600130856037,1.1040385961532593,-0.022118600085377693],[208,0.009645500220358372,1.1011685132980347,-0.028244702145457268],[209,0.007126399781554937,1.0978186130523682,-0.03280450031161308],[210,0.004547500051558018,1.0941884517669678,-0.03536370024085045],[211,0.0021633999422192574,1.0904771089553833,-0.03661809861660004],[212,0.00004690000059781596,1.0868843793869019,-0.03756580129265785],[213,-0.0018206000095233321,1.0836092233657837,-0.03822549805045128],[214,-0.003457500133663416,1.0808511972427368,-0.03861580044031143],[215,-0.0048825000412762165,1.0788097381591797,-0.038755301386117935],[216,-0.006113899871706963,1.0776841640472412,-0.03866260126233101],[217,-0.007170300465077162,1.0772918462753296,-0.03835650160908699],[218,-0.008070199750363827,1.0773652791976929,-0.0378556028008461],[219,-0.008832099847495556,1.0779756307601929,-0.0371784009039402],[220,-0.009395900182425976,1.0791947841644287,-0.03634360060095787],[221,-0.009681499563157558,1.0810937881469727,-0.03536989912390709],[222,-0.009677000343799591,1.0837444067001343,-0.03427579998970032],[223,-0.009370599873363972,1.087493658065796,-0.033080101013183594],[224,-0.00875029992312193,1.0923479795455933,-0.03180130198597908],[225,-0.007804399821907282,1.097867488861084,-0.030458098277449608],[226,-0.006521000061184168,1.1036123037338257,-0.0290692001581192],[227,-0.0048882002010941505,1.109142541885376,-0.027653101831674576],[228,-0.0029813998844474554,1.1140180826187134,-0.02622850053012371],[229,-0.0009580000187270343,1.117799162864685,-0.024814000353217125],[230,0.001070300000719726,1.1198776960372925,-0.02342830039560795],[231,0.002992199966683984,1.1202468872070312,-0.02208690159022808],[232,0.004696200136095285,1.119368314743042,-0.020792601630091667],[233,0.0060708001255989075,1.1177034378051758,-0.01954459957778454],[234,0.007004600018262863,1.115787148475647,-0.01834220066666603],[235,0.0073861004784703255,1.1138582229614258,-0.017185000702738762],[236,0.007103899959474802,1.1119341850280762,-0.01607220061123371],[237,0.00602089986205101,1.110032558441162,-0.015003100037574768],[238,0.004198800306767225,1.1081708669662476,-0.013977100141346455],[239,0.001823500031605363,1.106366753578186,-0.01299359928816557],[240,-0.0009188000112771988,1.1046375036239624,-0.012052000500261784],[241,-0.003842199919745326,1.1030008792877197,-0.011151500046253204],[242,-0.006760600488632917,1.1014741659164429,-0.010291500017046928],[243,-0.00948800053447485,1.100075125694275,-0.009471300058066845],[244,-0.011838200502097607,1.0988211631774902,-0.008690400049090385],[245,-0.013541199266910553,1.0977298021316528,-0.007948099635541439],[246,-0.014496900141239166,1.0968186855316162,-0.007243700325489044],[247,-0.014774300158023834,1.0961050987243652,-0.006576600018888712],[248,-0.014442299492657185,1.095606803894043,-0.0059460001066327095],[249,-0.013569801114499569,1.0953413248062134,-0.005351500120013952],[250,-0.012225700542330742,1.0953259468078613,-0.0047923000529408455],[251,-0.01047889981418848,1.0958284139633179,-0.004267800133675337],[252,-0.008398400619626045,1.0970252752304077,-0.003777299774810672],[253,-0.00605310034006834,1.0987977981567383,-0.0033202001359313726],[254,-0.003850199980661273,1.1010271310806274,-0.0028958001639693975],[255,-0.0021202999632805586,1.1035946607589722,-0.002503500087186694],[256,-0.0008172999951057136,1.1063814163208008,-0.002142600016668439],[257,0.00010489999840501696,1.1092687845230103,-0.0018124999478459358],[258,0.0006924999761395156,1.112138032913208,-0.0015125999925658107],[259,0.0009914999827742577,1.114870309829712,-0.001242100028321147],[260,0.001048100064508617,1.1173468828201294,-0.001000500051304698],[261,0.0009082999895326793,1.1194490194320679,-0.0007869999972172081],[262,0.0006237000343389809,1.1210579872131348,-0.0006010999786667526],[263,0.00024250001297332346,1.1222472190856934,-0.0004420999903231859],[264,-0.00019360000442247838,1.1231859922409058,-0.0003093999985139817],[265,-0.0006434000097215176,1.1238988637924194,-0.00020220001169946045],[266,-0.0010653999634087086,1.1244103908538818,-0.00012000000424450263],[267,-0.00141810008790344,1.12474524974823,-0.00006199999916134402],[268,-0.0016602000687271357,1.1249282360076904,-0.000027799998861155473],[269,-0.0017500000540167093,1.1249836683273315,-0.00001650000012887176],[270,0,1.125,0]]}]},"1015":{"name":"M_stand_kamae01.gmt","root":"center_n","frames":120,"fps":30,"loop":true,"translation":[{"axis":"xyz","keys":[[0,0,1.125,0],[1,0.0017596998950466514,1.1249784231185913,-0.00001650000012887176],[2,0.0035757001023739576,1.1249158382415771,-0.00006520000169984996],[3,0.005441899877041578,1.1248157024383545,-0.0001449999981559813],[4,0.007352200336754322,1.1246813535690308,-0.00025480001932010055],[5,0.009300400502979755,1.1245163679122925,-0.0003934999986086041],[6,0.011280300095677376,1.124324083328247,-0.0005600000149570405],[7,0.013285900466144085,1.124107837677002,-0.0007530999719165266],[8,0.015310900285840034,1.1238712072372437,-0.0009719000081531703],[9,0.017349300906062126,1.1236175298690796,-0.0012150000547990203],[10,0.019394900649785995,1.1233500242233276,-0.0014814999885857105],[11,0.02144159935414791,1.1230723857879639,-0.0017702000914141536],[12,0.02348319999873638,1.1227878332138062,-0.0020800000056624413],[13,0.025513602420687675,1.1225000619888306,-0.0024097999557852745],[14,0.027526700869202614,1.1222121715545654,-0.0027584999334067106],[15,0.029516300186514854,1.1219276189804077,-0.0031250000465661287],[16,0.031476300209760666,1.121649980545044,-0.003508100053295493],[17,0.03340040147304535,1.1213825941085815,-0.003906900063157082],[18,0.03528270125389099,1.1211289167404175,-0.004320000298321247],[19,0.03711700066924095,1.1208921670913696,-0.004746499937027693],[20,0.03889700025320053,1.1206759214401245,-0.005185199901461601],[21,0.040616802871227264,1.120483636856079,-0.005635000299662352],[22,0.042270101606845856,1.1203186511993408,-0.006094799842685461],[23,0.04385080188512802,1.120184302330017,-0.006563500501215458],[24,0.04535270109772682,1.1200841665267944,-0.007040000054985285],[25,0.046769801527261734,1.1200217008590698,-0.007523100357502699],[26,0.04809590056538582,1.1200000047683716,-0.008011899888515472],[27,0.049324799329042435,1.1200144290924072,-0.008505000732839108],[28,0.0504504032433033,1.12005615234375,-0.009001499973237514],[29,0.051466602832078934,1.1201236248016357,-0.009500200860202312],[30,0.0523671992123127,1.120214819908142,-0.010000000707805157],[31,0.05314610153436661,1.1203280687332153,-0.010499800555408001],[32,0.053797103464603424,1.1204614639282227,-0.010998500511050224],[33,0.054314203560352325,1.1206130981445312,-0.011495000682771206],[34,0.05469110235571861,1.1207813024520874,-0.011988099664449692],[35,0.05492180213332176,1.1209641695022583,-0.012476900592446327],[36,0.055000003427267075,1.121159553527832,-0.012960000894963741],[37,0.054891299456357956,1.1213663816452026,-0.013436500914394855],[38,0.05457080155611038,1.12158203125,-0.01390520017594099],[39,0.054047103971242905,1.1218050718307495,-0.0143649997189641],[40,0.0533285029232502,1.122033715248108,-0.014814800582826138],[41,0.05242360383272171,1.1222659349441528,-0.015253501012921333],[42,0.051340799778699875,1.1225000619888306,-0.01568000018596649],[43,0.05008850246667862,1.1227340698242188,-0.016093101352453232],[44,0.04867539927363396,1.1229662895202637,-0.016491901129484177],[45,0.0471097007393837,1.123194932937622,-0.016875000670552254],[46,0.04540010169148445,1.123417854309082,-0.017241500318050385],[47,0.04355500265955925,1.1236337423324585,-0.017590200528502464],[48,0.041582800447940826,1.12384033203125,-0.017920000478625298],[49,0.03949199989438057,1.1240359544754028,-0.018229801207780838],[50,0.03729100152850151,1.1242188215255737,-0.01851850003004074],[51,0.03498850017786026,1.1243869066238403,-0.01878499984741211],[52,0.03259279951453209,1.1245386600494385,-0.01902810111641884],[53,0.03011230006814003,1.1246719360351562,-0.01924690045416355],[54,0.027555599808692932,1.1247851848602295,-0.019440000876784325],[55,0.024931199848651886,1.1248763799667358,-0.01960649900138378],[56,0.022247500717639923,1.1249438524246216,-0.019745199009776115],[57,0.019512901082634926,1.124985694885254,-0.01985500007867813],[58,0.016735998913645744,1.125,-0.019934801384806633],[59,0.013925201259553432,1.124985694885254,-0.019983500242233276],[60,0.011088999919593334,1.1249438524246216,-0.020000001415610313],[61,0.008235900662839413,1.1248763799667358,-0.019983500242233276],[62,0.005374300293624401,1.1247851848602295,-0.019934801384806633],[63,0.0025126999244093895,1.1246719360351562,-0.01985500007867813],[64,-0.00034050000249408185,1.1245386600494385,-0.019745199009776115],[65,-0.0031767000909894705,1.1243869066238403,-0.01960649900138378],[66,-0.0059875003062188625,1.1242188215255737,-0.019440000876784325],[67,-0.008764400146901608,1.1240359544754028,-0.01924690045416355],[68,-0.011498900130391121,1.12384033203125,-0.01902810111641884],[69,-0.014182700775563717,1.1236337423324585,-0.01878499984741211],[70,-0.01680709980428219,1.123417854309082,-0.01851850003004074],[71,-0.019363800063729286,1.123194932937622,-0.018229801207780838],[72,-0.021844198927283287,1.1229662895202637,-0.017920000478625298],[73,-0.024239901453256607,1.1227340698242188,-0.017590200528502464],[74,-0.026542499661445618,1.1225000619888306,-0.017241500318050385],[75,-0.028743401169776917,1.1222659349441528,-0.016875000670552254],[76,-0.030834201723337173,1.122033715248108,-0.016491901129484177],[77,-0.0328064002096653,1.1218050718307495,-0.016093101352453232],[78,-0.03465160354971886,1.12158203125,-0.01568000018596649],[79,-0.036361198872327805,1.1213663816452026,-0.015253501012921333],[80,-0.037926800549030304,1.121159553527832,-0.014814800582826138],[81,-0.039340000599622726,1.1209641695022583,-0.0143649997189641],[82,-0.04059220105409622,1.1207813024520874,-0.01390520017594099],[83,-0.04167500138282776,1.1206130981445312,-0.013436500914394855],[84,-0.04257990047335625,1.1204614639282227,-0.012960000894963741],[85,-0.04329850152134895,1.1203280687332153,-0.012476900592446327],[86,-0.04382229968905449,1.120214819908142,-0.011988099664449692],[87,-0.0441427007317543,1.1201236248016357,-0.011495000682771206],[88,-0.04425149783492088,1.12005615234375,-0.010998500511050224],[89,-0.04417690262198448,1.1200144290924072,-0.010499800555408001],[90,-0.04395719990134239,1.1200000047683716,-0.010000000707805157],[91,-0.04359839856624603,1.12001633644104,-0.009500200860202312],[92,-0.04310670122504234,1.1200636625289917,-0.009001499973237514],[93,-0.04248800128698349,1.1201399564743042,-0.008505000732839108],[94,-0.04174860194325447,1.120242953300476,-0.008011899888515472],[95,-0.04089429974555969,1.1203703880310059,-0.007523100357502699],[96,-0.03993139788508415,1.120519995689392,-0.007040000054985285],[97,-0.03886590152978897,1.1206896305084229,-0.006563500501215458],[98,-0.037703800946474075,1.1208771467208862,-0.006094799842685461],[99,-0.036451201885938644,1.1210800409317017,-0.005635000299662352],[100,-0.03511419892311096,1.1212962865829468,-0.005185199901461601],[101,-0.03369889780879021,1.1215237379074097,-0.004746499937027693],[102,-0.0322112999856472,1.1217600107192993,-0.004320000298321247],[103,-0.030657602474093437,1.1220029592514038,-0.003906900063157082],[104,-0.02904370240867138,1.1222504377365112,-0.003508100053295493],[105,-0.027375800535082817,1.1225000619888306,-0.0031250000465661287],[106,-0.025659902021288872,1.12274968624115,-0.0027584999334067106],[107,-0.023902101442217827,1.1229970455169678,-0.0024097999557852745],[108,-0.022108400240540504,1.1232399940490723,-0.0020800000056624413],[109,-0.020285099744796753,1.1234763860702515,-0.0017702000914141536],[110,-0.018438000231981277,1.1237037181854248,-0.0014814999885857105],[111,-0.01657330058515072,1.12391996383667,-0.0012150000547990203],[112,-0.01469700038433075,1.124122977256775,-0.0009719000081531703],[113,-0.012815299443900585,1.1243103742599487,-0.0007530999719165266],[114,-0.010934200137853622,1.1244800090789795,-0.0005600000149570405],[115,-0.009059700183570385,1.1246296167373657,-0.0003934999986086041],[116,-0.007197999861091375,1.1247570514678955,-0.00025480001932010055],[117,-0.005355100147426128,1.1248600482940674,-0.0001449999981559813],[118,-0.003537100274115801,1.1249363422393799,-0.00006520000169984996],[119,-0.0017500000540167093,1.1249836683273315,-0.00001650000012887176],[120,0,1.125,0]]}]},"1016":{"name":"M_stand_kamae02.gmt","root":"center_n","frames":125,"fps":30,"loop":true,"translation":[{"axis":"xyz","keys":[[0,0,1.121000051498413,0.0000016000000186977559],[1,0.0014730000402778387,1.1210025548934937,-0.000039500002458225936],[2,0.0027058999985456467,1.1210105419158936,-0.0001610000035725534],[3,0.0037053998094052076,1.121024489402771,-0.00036020000698044896],[4,0.004478100221604109,1.1210451126098633,-0.0006343999993987381],[5,0.0050305998884141445,1.1210731267929077,-0.0009811000199988484],[6,0.005369599908590317,1.121108889579773,-0.0013973000459372997],[7,0.005501700099557638,1.1211532354354858,-0.001880600000731647],[8,0.005433599930256605,1.121206521987915,-0.002428199863061309],[9,0.005172000266611576,1.1212695837020874,-0.003037499962374568],[10,0.004723399877548218,1.1213430166244507,-0.003705700160935521],[11,0.004094500094652176,1.1214271783828735,-0.0044302004389464855],[12,0.0032919999212026596,1.121523141860962,-0.005208299960941076],[13,0.002322399988770485,1.121631145477295,-0.006037299986928701],[14,0.0011926000006496906,1.1217517852783203,-0.0069146002642810345],[15,-0.00009100000170292333,1.1218857765197754,-0.00783739984035492],[16,-0.0015216999454423785,1.1220338344573975,-0.008803100325167179],[17,-0.0030927001498639584,1.1221964359283447,-0.009809000417590141],[18,-0.004797599744051695,1.122374176979065,-0.01085249986499548],[19,-0.006629500072449446,1.1225780248641968,-0.011930800043046474],[20,-0.008581999689340591,1.1228159666061401,-0.013041200116276741],[21,-0.010648299939930439,1.1230840682983398,-0.014181199483573437],[22,-0.012821699492633343,1.1233783960342407,-0.015347899869084358],[23,-0.01509570050984621,1.1236950159072876,-0.016538800671696663],[24,-0.017463700845837593,1.1240301132202148,-0.017751101404428482],[25,-0.019918901845812798,1.1243796348571777,-0.01898219995200634],[26,-0.022454600781202316,1.1247398853302002,-0.02022930048406124],[27,-0.02506439946591854,1.1251068115234375,-0.021489901468157768],[28,-0.027741501107811928,1.1254764795303345,-0.022761201485991478],[29,-0.030479300767183304,1.125845193862915,-0.024040600284934044],[30,-0.033271100372076035,1.1262086629867554,-0.02532530203461647],[31,-0.036110203713178635,1.126563310623169,-0.026612699031829834],[32,-0.03899019956588745,1.126905083656311,-0.027900202199816704],[33,-0.04190419986844063,1.127230167388916,-0.029184898361563683],[34,-0.04484570026397705,1.1275346279144287,-0.030464300885796547],[35,-0.047808002680540085,1.127814531326294,-0.031735699623823166],[36,-0.0507843978703022,1.1280659437179565,-0.03299640119075775],[37,-0.053768403828144073,1.1282849311828613,-0.03424369916319847],[38,-0.05675319954752922,1.1284676790237427,-0.03547490015625954],[39,-0.05973229929804802,1.128610372543335,-0.036687400192022324],[40,-0.06269890069961548,1.1287087202072144,-0.03787840157747269],[41,-0.06564649939537048,1.1287801265716553,-0.03904540091753006],[42,-0.0685684010386467,1.1288437843322754,-0.04018549993634224],[43,-0.07145800441503525,1.128900170326233,-0.04129619896411896],[44,-0.07430850714445114,1.1289491653442383,-0.04237480089068413],[45,-0.07711340487003326,1.1289911270141602,-0.04341850057244301],[46,-0.07986599951982498,1.1290262937545776,-0.04442470148205757],[47,-0.08255969732999802,1.1290546655654907,-0.04539070278406143],[48,-0.08518780022859573,1.1290764808654785,-0.046313900500535965],[49,-0.08774369955062866,1.1290920972824097,-0.047191500663757324],[50,-0.09022070467472076,1.129101276397705,-0.048020899295806885],[51,-0.09261219948530197,1.1291046142578125,-0.04879939928650856],[52,-0.09491150081157684,1.129102110862732,-0.049524400383234024],[53,-0.09711210429668427,1.129093885421753,-0.050193000584840775],[54,-0.09920720010995865,1.1290801763534546,-0.05080270394682884],[55,-0.10119020193815231,1.1290611028671265,-0.051350802183151245],[56,-0.10305440425872803,1.1290370225906372,-0.051834601908922195],[57,-0.10479330271482468,1.1290079355239868,-0.05225139856338501],[58,-0.10640020668506622,1.1289740800857544,-0.05259860306978226],[59,-0.10786839574575424,1.1289355754852295,-0.0528734028339386],[60,-0.10919129848480225,1.1288926601409912,-0.05307319760322571],[61,-0.11036219447851181,1.128845453262329,-0.053195297718048096],[62,-0.11137449741363525,1.1287940740585327,-0.05323709920048714],[63,-0.11221760511398315,1.1287388801574707,-0.05319790169596672],[64,-0.11288829892873764,1.1286799907684326,-0.05308070406317711],[65,-0.11339069902896881,1.128617525100708,-0.05288810282945633],[66,-0.11372940987348557,1.1285516023635864,-0.05262270197272301],[67,-0.11390860378742218,1.128482460975647,-0.05228700116276741],[68,-0.11393280327320099,1.1284103393554688,-0.051883500069379807],[69,-0.1138061061501503,1.1283353567123413,-0.05141490325331688],[70,-0.11353299766778946,1.1282576322555542,-0.05088359862565994],[71,-0.11311780661344528,1.1281774044036865,-0.05029220134019852],[72,-0.1125648021697998,1.1280949115753174,-0.04964340105652809],[73,-0.1118783950805664,1.1280101537704468,-0.048939500004053116],[74,-0.11106300354003906,1.1279234886169434,-0.04818330332636833],[75,-0.11012279987335205,1.1278349161148071,-0.047377198934555054],[76,-0.10906219482421875,1.1277447938919067,-0.0465238019824028],[77,-0.10788559913635254,1.1276531219482422,-0.04562560096383095],[78,-0.10659720003604889,1.1275602579116821,-0.044685300439596176],[79,-0.10520149767398834,1.1274662017822266,-0.043705400079488754],[80,-0.10370270162820816,1.1273713111877441,-0.04268839955329895],[81,-0.10210529714822769,1.1272755861282349,-0.04163680225610733],[82,-0.1004135012626648,1.1271792650222778,-0.040553297847509384],[83,-0.09863170236349106,1.1270716190338135,-0.03944050148129463],[84,-0.09676419943571091,1.1269426345825195,-0.03830070048570633],[85,-0.09481539577245712,1.1267945766448975,-0.03713670000433922],[86,-0.09278950095176697,1.1266289949417114,-0.03595089912414551],[87,-0.09069110453128815,1.1264479160308838,-0.03474600240588188],[88,-0.08852430433034897,1.1262530088424683,-0.03352440148591995],[89,-0.08629360049962997,1.1260462999343872,-0.032288700342178345],[90,-0.08400320261716843,1.1258294582366943,-0.031041601672768593],[91,-0.08165760338306427,1.125604510307312,-0.02978549897670746],[92,-0.07926099747419357,1.1253732442855835,-0.028523001819849014],[93,-0.07681780308485031,1.125137448310852,-0.027256598696112633],[94,-0.07433230429887772,1.1248990297317505,-0.025988999754190445],[95,-0.07180889695882797,1.1246598958969116,-0.024722600355744362],[96,-0.0692519024014473,1.1244215965270996,-0.02346010133624077],[97,-0.06666570156812668,1.124186396598816,-0.022203899919986725],[98,-0.06405450403690338,1.1239559650421143,-0.020956700667738914],[99,-0.06142280250787735,1.123732089996338,-0.019720900803804398],[100,-0.05877489969134331,1.1235166788101196,-0.01849920116364956],[101,-0.056115102022886276,1.1233115196228027,-0.017294099554419518],[102,-0.053447701036930084,1.1231186389923096,-0.016108199954032898],[103,-0.05077720433473587,1.1229366064071655,-0.014944001100957394],[104,-0.048107799142599106,1.1227627992630005,-0.013804000802338123],[105,-0.04544379934668541,1.1225974559783936,-0.012690900824964046],[106,-0.042789701372385025,1.122440218925476,-0.011607199907302856],[107,-0.04014980047941208,1.1222914457321167,-0.010555400513112545],[108,-0.037528302520513535,1.1221507787704468,-0.009538100101053715],[109,-0.03492970019578934,1.1220184564590454,-0.008557800203561783],[110,-0.03235829994082451,1.1218942403793335,-0.007617200259119272],[111,-0.029818400740623474,1.1217782497406006,-0.00671869982033968],[112,-0.02731429971754551,1.1216703653335571,-0.005864900071173906],[113,-0.024850500747561455,1.1215707063674927,-0.0050583998672664165],[114,-0.02243109978735447,1.1214790344238281,-0.004301799926906824],[115,-0.020060701295733452,1.121395468711853,-0.003597500268369913],[116,-0.01774349994957447,1.121320128440857,-0.002948200097307563],[117,-0.015483899973332882,1.1212526559829712,-0.002356400014832616],[118,-0.013286200352013111,1.121193289756775,-0.0018246000399813056],[119,-0.011154700070619583,1.121141791343689,-0.001355400076135993],[120,-0.00909380055963993,1.1210983991622925,-0.000951400026679039],[121,-0.007107800338417292,1.121062994003296,-0.0006151999696157873],[122,-0.005201100371778011,1.1210354566574097,-0.00034920001053251326],[123,-0.003378000110387802,1.1210157871246338,-0.00015600000915583223],[124,-0.0016428999369964004,1.1210039854049683,-0.00003819999983534217],[125,0,1.121000051498413,0.0000016000000186977559],[125,0,1.121000051498413,0.0000016000000186977559]]}]},"1017":{"name":"M_stand_kamae03.gmt","root":"center_n","frames":140,"fps":30,"loop":true,"translation":[{"axis":"xyz","keys":[[0,0.06700000166893005,1.1260000467300415,-0.06600000709295273],[1,0.06353979557752609,1.1260452270507812,-0.06761469691991806],[2,0.059758104383945465,1.1260777711868286,-0.06931210309267044],[3,0.055674999952316284,1.1260977983474731,-0.07106680423021317],[4,0.0513106994330883,1.1261063814163208,-0.07285340130329132],[5,0.04668530076742172,1.1261038780212402,-0.07464650273323059],[6,0.041819099336862564,1.1260908842086792,-0.07642089575529099],[7,0.03673210367560387,1.126068115234375,-0.07815100252628326],[8,0.031444501131772995,1.1260360479354858,-0.07981160283088684],[9,0.025976499542593956,1.1259950399398804,-0.0813772976398468],[10,0.02034820057451725,1.1259459257125854,-0.08282270282506943],[11,0.014579799957573414,1.1258894205093384,-0.08412240445613861],[12,0.008691499941051006,1.1258257627487183,-0.0852511003613472],[13,0.002703400095924735,1.1257556676864624,-0.08618339896202087],[14,-0.0033643001224845648,1.125679850578308,-0.08689390122890472],[15,-0.009491500444710255,1.1255987882614136,-0.08746670186519623],[16,-0.015658101066946983,1.125512957572937,-0.08800309896469116],[17,-0.021843699738383293,1.1254229545593262,-0.08850359916687012],[18,-0.028028398752212524,1.1253297328948975,-0.08896870166063309],[19,-0.03419190272688866,1.1252332925796509,-0.08939900249242783],[20,-0.04031410068273544,1.1251345872879028,-0.08979480713605881],[21,-0.04637480154633522,1.125034213066101,-0.09015680104494095],[22,-0.05235379934310913,1.1249325275421143,-0.09048540145158768],[23,-0.05823109671473503,1.1248302459716797,-0.09078110009431839],[24,-0.0639864057302475,1.1247278451919556,-0.09104450047016144],[25,-0.06959950178861618,1.1246260404586792,-0.09127610176801682],[26,-0.07505040615797043,1.1245254278182983,-0.0914762020111084],[27,-0.08031889796257019,1.1244264841079712,-0.09164559841156006],[28,-0.085384801030159,1.1243298053741455,-0.09178460389375687],[29,-0.09022790193557739,1.124235987663269,-0.09189379960298538],[30,-0.09482809901237488,1.1241455078125,-0.0919736996293068],[31,-0.09916520118713379,1.1240592002868652,-0.0920247957110405],[32,-0.10321910679340363,1.1239774227142334,-0.09204750508069992],[33,-0.10696970671415329,1.1239007711410522,-0.09204249829053879],[34,-0.1103966012597084,1.1238300800323486,-0.09201020002365112],[35,-0.11347990483045578,1.123765468597412,-0.09195100516080856],[36,-0.11633019894361496,1.1237080097198486,-0.09186559915542603],[37,-0.11907080560922623,1.1236579418182373,-0.09175439924001694],[38,-0.12170020490884781,1.1236158609390259,-0.09161800146102905],[39,-0.12421679496765137,1.123584508895874,-0.09145680069923401],[40,-0.12661920487880707,1.1235651969909668,-0.0912713035941124],[41,-0.12890580296516418,1.123557686805725,-0.09106200188398361],[42,-0.13107509911060333,1.123561143875122,-0.09082960337400436],[43,-0.13312560319900513,1.1235750913619995,-0.09047739952802658],[44,-0.13505589962005615,1.1235988140106201,-0.08992360532283783],[45,-0.1368643045425415,1.1236318349838257,-0.08918999880552292],[46,-0.13854940235614777,1.1236733198165894,-0.08829870074987411],[47,-0.14010970294475555,1.123723030090332,-0.08727170526981354],[48,-0.1415437012910843,1.1237801313400269,-0.08613099902868271],[49,-0.14284980297088623,1.1238441467285156,-0.08489860594272614],[50,-0.1440265029668808,1.1239142417907715,-0.08359649777412415],[51,-0.14507240056991577,1.1239901781082153,-0.08224670588970184],[52,-0.1459859013557434,1.1240710020065308,-0.08087130635976791],[53,-0.1467656046152115,1.1241563558578491,-0.07949220389127731],[54,-0.14740979671478271,1.124245524406433,-0.07813140004873276],[55,-0.14791710674762726,1.1243380308151245,-0.07681090384721756],[56,-0.14828599989414215,1.124433159828186,-0.075552798807621],[57,-0.1485150009393692,1.12453031539917,-0.074379101395607],[58,-0.14860260486602783,1.1246289014816284,-0.0733117014169693],[59,-0.1485472023487091,1.1247284412384033,-0.07237260043621063],[60,-0.148347407579422,1.1248281002044678,-0.07158390432596207],[61,-0.14800159633159637,1.1249275207519531,-0.07096760720014572],[62,-0.14750830829143524,1.125025987625122,-0.07054569572210312],[63,-0.14686600863933563,1.1251229047775269,-0.07034020125865936],[64,-0.14607331156730652,1.1252176761627197,-0.07037299871444702],[65,-0.1451285034418106,1.125309705734253,-0.0705685019493103],[66,-0.14403030276298523,1.1253985166549683,-0.07083269953727722],[67,-0.14277701079845428,1.1254831552505493,-0.07116080075502396],[68,-0.14136719703674316,1.1255635023117065,-0.07154770195484161],[69,-0.1397992968559265,1.1256386041641235,-0.07198860496282578],[70,-0.13807189464569092,1.125707983970642,-0.07247840613126755],[71,-0.13614480197429657,1.1257710456848145,-0.07301220297813416],[72,-0.13398469984531403,1.1258271932601929,-0.07358499616384506],[73,-0.13160079717636108,1.12587571144104,-0.07419189810752869],[74,-0.12900200486183167,1.1259162425994873,-0.0748279020190239],[75,-0.1261972039937973,1.1259480714797974,-0.07548810541629791],[76,-0.12319550663232803,1.1259703636169434,-0.0761675015091896],[77,-0.12000590562820435,1.1259828805923462,-0.07686100155115128],[78,-0.11663730442523956,1.1259849071502686,-0.07756390422582626],[79,-0.11309880018234253,1.1259757280349731,-0.07827100157737732],[80,-0.10939940065145493,1.1259565353393555,-0.07897750288248062],[81,-0.10554800182580948,1.1259291172027588,-0.07967840135097504],[82,-0.10155359655618668,1.1258937120437622,-0.08036869764328003],[83,-0.0974252000451088,1.125850796699524,-0.08104350417852402],[84,-0.09317190200090408,1.1258009672164917,-0.08169779926538467],[85,-0.08880250155925751,1.125744342803955,-0.08232660591602325],[86,-0.08432620018720627,1.1256816387176514,-0.08292499929666519],[87,-0.07975190132856369,1.1256130933761597,-0.08348800241947174],[88,-0.07508860528469086,1.1255391836166382,-0.08401070535182953],[89,-0.0703452005982399,1.1254603862762451,-0.08448810130357742],[90,-0.06553079932928085,1.1253770589828491,-0.08491530269384384],[91,-0.060654401779174805,1.1252895593643188,-0.08531089872121811],[92,-0.05572500452399254,1.125198483467102,-0.08569510281085968],[93,-0.05075150355696678,1.1251041889190674,-0.0860648974776268],[94,-0.04574299976229668,1.1250070333480835,-0.0864173024892807],[95,-0.040708400309085846,1.124907374382019,-0.08674950152635574],[96,-0.035656701773405075,1.1248058080673218,-0.08705829828977585],[97,-0.030597001314163208,1.12470281124115,-0.08734080195426941],[98,-0.02553809992969036,1.124598503112793,-0.08759400248527527],[99,-0.020489199087023735,1.1244934797286987,-0.08781509846448898],[100,-0.01545920129865408,1.124388337135315,-0.08800090104341507],[101,-0.010457100346684456,1.1242831945419312,-0.08814860135316849],[102,-0.005491900257766247,1.1241786479949951,-0.08825520426034927],[103,-0.0005725999944843352,1.1240750551223755,-0.08831760287284851],[104,0.004291899967938662,1.1239728927612305,-0.08833300322294235],[105,0.009092400781810284,1.1238726377487183,-0.08829830586910248],[106,0.013820200227200985,1.123774528503418,-0.08821050077676773],[107,0.018466001376509666,1.1236790418624878,-0.08806680142879486],[108,0.023021001368761063,1.123586893081665,-0.08786410093307495],[109,0.027476200833916664,1.1234979629516602,-0.0875995010137558],[110,0.031822603195905685,1.1234130859375,-0.08726999908685684],[111,0.036051101982593536,1.1233326196670532,-0.08687250316143036],[112,0.04015279933810234,1.1232569217681885,-0.08640430122613907],[113,0.04411860182881355,1.1231863498687744,-0.08586210012435913],[114,0.04793969914317131,1.1231215000152588,-0.08524320274591446],[115,0.051607001572847366,1.1230626106262207,-0.08449350297451019],[116,0.05511149764060974,1.123010277748108,-0.08357509970664978],[117,0.058444201946258545,1.1229647397994995,-0.0825091004371643],[118,0.0615961030125618,1.1229265928268433,-0.08131679892539978],[119,0.06455820053815842,1.1228961944580078,-0.08001930266618729],[120,0.06732159852981567,1.1228740215301514,-0.07863789796829224],[121,0.06987730413675308,1.122860312461853,-0.07719369977712631],[122,0.07221610099077225,1.1228556632995605,-0.0757078006863594],[123,0.07432930171489716,1.1228809356689453,-0.07420160621404648],[124,0.07620769739151001,1.1229532957077026,-0.07269610464572906],[125,0.07784240692853928,1.123067021369934,-0.07121260464191437],[126,0.07922430336475372,1.1232166290283203,-0.06977220624685287],[127,0.08034460246562958,1.1233967542648315,-0.06839609891176224],[128,0.08119410276412964,1.1236017942428589,-0.0671055018901825],[129,0.08176390081644058,1.123826265335083,-0.06592170149087906],[130,0.08204510062932968,1.124064564704895,-0.06486570090055466],[131,0.08202850073575974,1.1243113279342651,-0.0639588013291359],[132,0.08170530200004578,1.1245609521865845,-0.06322210282087326],[133,0.08106639981269836,1.1248078346252441,-0.062676802277565],[134,0.08010290563106537,1.125046730041504,-0.062344200909137726],[135,0.07880570739507675,1.1252719163894653,-0.06224539875984192],[136,0.07716580480337143,1.125477910041809,-0.06240160018205643],[137,0.07517430186271667,1.1256592273712158,-0.0628340020775795],[138,0.072822205722332,1.1258103847503662,-0.06356369704008102],[139,0.07010040432214737,1.1259257793426514,-0.0646120011806488],[140,0.06700000166893005,1.1260000467300415,-0.06600000709295273]]}]},"1103":{"name":"MinP_stand_happy.gmt","root":"center_n","frames":110,"fps":30,"loop":false,"translation":[{"axis":"xyz","keys":[[0,0,1.1299999952316284,0],[1,0.0009941000025719404,1.129986047744751,-0.00019370000518392771],[2,0.00190250005107373,1.1299452781677246,-0.000378400000045076],[3,0.0027284000534564257,1.129879355430603,-0.000553599966224283],[4,0.0034749002661556005,1.129790186882019,-0.0007190000033006072],[5,0.004145200364291668,1.1296790838241577,-0.0008743000216782093],[6,0.0047426000237464905,1.1295479536056519,-0.0010189999593421817],[7,0.005270100198686123,1.1293983459472656,-0.0011528999311849475],[8,0.0057310000993311405,1.1292322874069214,-0.0012756999349221587],[9,0.0061285002157092094,1.1290510892868042,-0.0013868000824004412],[10,0.006465800106525421,1.1288565397262573,-0.00148610002361238],[11,0.0067460001446306705,1.128650426864624,-0.001572999986819923],[12,0.0069723003543913364,1.1284343004226685,-0.0016473999712616205],[13,0.007147999946027994,1.1282099485397339,-0.0017087999731302261],[14,0.007276100106537342,1.1279791593551636,-0.001756999990902841],[15,0.007359900511801243,1.1277432441711426,-0.0017080999678000808],[16,0.007309500128030777,1.1275042295455933,-0.0015057999407872558],[17,0.007053900044411421,1.1272637844085693,-0.0011900999816134572],[18,0.0066247000358998775,1.1270233392715454,-0.0008013999904505908],[19,0.006053700111806393,1.1267849206924438,-0.00037980001070536673],[20,0.005372500047087669,1.1265499591827393,0.00003440000000409782],[21,0.004612800199538469,1.126320242881775,0.0004008999967481941],[22,0.003806099994108081,1.1260974407196045,0.0006794999935664237],[23,0.002984300022944808,1.1258831024169922,0.0008301000343635678],[24,0.0021788999438285828,1.1256792545318604,0.0008123000152409077],[25,0.0014217001153156161,1.125487208366394,0.0004261000140104443],[26,0.0007442000205628574,1.125308871269226,-0.0003440000000409782],[27,0.0001782000035746023,1.1251459121704102,-0.0012612000573426485],[28,-0.0005404999828897417,1.125,-0.0020888999570161104],[29,-0.001586100086569786,1.1248668432235718,-0.0025901999324560165],[30,-0.0027922000735998154,1.1247413158416748,-0.0025285000447183847],[31,-0.0039923000149428844,1.1246228218078613,-0.0021750000305473804],[32,-0.005019899923354387,1.1245115995407104,-0.0019461000338196754],[33,-0.005708599928766489,1.124407172203064,-0.0018229000270366669],[34,-0.005891900043934584,1.1243094205856323,-0.001786600099876523],[35,-0.005713199730962515,1.1242183446884155,-0.0018184001091867685],[36,-0.00544640002772212,1.124133825302124,-0.0018994000274688005],[37,-0.005120800342410803,1.12405526638031,-0.00201070006005466],[38,-0.004765800200402737,1.1239830255508423,-0.0021336001809686422],[39,-0.004410599824041128,1.123916506767273,-0.00224910001270473],[40,-0.0040847002528607845,1.1238558292388916,-0.0023384999949485064],[41,-0.0038171999622136354,1.1238006353378296,-0.002382799983024597],[42,-0.0036290001589804888,1.1237508058547974,-0.0023840998765081167],[43,-0.003515699878334999,1.1237062215805054,-0.0023598000407218933],[44,-0.003468800103291869,1.1236666440963745,-0.0023145999293774366],[45,-0.0034797999542206526,1.1236319541931152,-0.002252900041639805],[46,-0.003540100296959281,1.123602032661438,-0.0021794000640511513],[47,-0.0036412000190466642,1.1235765218734741,-0.002098600147292018],[48,-0.0037746999878436327,1.1235555410385132,-0.002015200210735202],[49,-0.0039321002550423145,1.123538613319397,-0.0019335000542923808],[50,-0.004104800056666136,1.1235257387161255,-0.0018582999473437667],[51,-0.004284400027245283,1.1235166788101196,-0.0017940000398084521],[52,-0.00446229986846447,1.1235113143920898,-0.0017453000182285905],[53,-0.004630000330507755,1.1235095262527466,-0.0017167000332847238],[54,-0.004779099952429533,1.1235110759735107,-0.0017128000035881996],[55,-0.0049009001813828945,1.1235156059265137,-0.0017380999634042382],[56,-0.005018400028347969,1.123522162437439,-0.001771200099028647],[57,-0.005158800166100264,1.123529076576233,-0.0017877999925985932],[58,-0.0053205001167953014,1.123536467552185,-0.0017882001120597124],[59,-0.005501899868249893,1.1235443353652954,-0.001772700110450387],[60,-0.005701300222426653,1.1235525608062744,-0.0017414999892935157],[61,-0.005917000118643045,1.1235610246658325,-0.0016949999844655395],[62,-0.00614750012755394,1.1235698461532593,-0.0016333000967279077],[63,-0.0063911001197993755,1.1235789060592651,-0.0015566999791190028],[64,-0.0066462005488574505,1.12358820438385,-0.0014655999839305878],[65,-0.006911099888384342,1.1235976219177246,-0.0013601999962702394],[66,-0.0071841999888420105,1.1236071586608887,-0.0012407000176608562],[67,-0.007463899906724691,1.1236168146133423,-0.0011074000503867865],[68,-0.007748500443994999,1.123626470565796,-0.0009607000392861664],[69,-0.008036400191485882,1.123636245727539,-0.0008008000440895557],[70,-0.008325899951159954,1.1236456632614136,-0.0006279000081121922],[71,-0.008615500293672085,1.1236552000045776,-0.0004422999918460846],[72,-0.008903400041162968,1.1236646175384521,-0.0002442999975755811],[73,-0.009188099764287472,1.1236737966537476,-0.00003420000211917795],[74,-0.009467899799346924,1.1236827373504639,0.00018780000391416252],[75,-0.00974110048264265,1.123691439628601,0.0004214000073261559],[76,-0.010006199590861797,1.12369966506958,0.000666300009470433],[77,-0.010261500254273415,1.12370765209198,0.0009221999789588153],[78,-0.010505300015211105,1.1237152814865112,0.001188900088891387],[79,-0.010736099444329739,1.1237224340438843,0.0014660999877378345],[80,-0.010952100157737732,1.1237291097640991,0.0017535999650135636],[81,-0.011151800863444805,1.1237353086471558,0.002051000017672777],[82,-0.011333500035107136,1.1237409114837646,0.0023581001441925764],[83,-0.011479499749839306,1.1237691640853882,0.0026461000088602304],[84,-0.011575800366699696,1.1238412857055664,0.0028878001030534506],[85,-0.01162640005350113,1.1239537000656128,0.003085399977862835],[86,-0.011635299772024155,1.1241031885147095,0.003240999998524785],[87,-0.011606399901211262,1.1242862939834595,0.0033567999489605427],[88,-0.01154360082000494,1.1244995594024658,0.003435000078752637],[89,-0.011451099999248981,1.1247397661209106,0.0034777000546455383],[90,-0.0113328006118536,1.1250033378601074,0.003487100126221776],[91,-0.01119260024279356,1.1252872943878174,0.0034651998430490494],[92,-0.011034499853849411,1.1255875825881958,0.0034143999218940735],[93,-0.0108625004068017,1.125901460647583,0.0033367001451551914],[94,-0.010680600069463253,1.1262251138687134,0.003234399948269129],[95,-0.010492700152099133,1.1265554428100586,0.0031095000449568033],[96,-0.010302799753844738,1.1268889904022217,0.0029642002191394567],[97,-0.010058100335299969,1.1272224187850952,0.002800700021907687],[98,-0.0097078001126647,1.1275520324707031,0.00262110005132854],[99,-0.009259600192308426,1.1278749704360962,0.002427699975669384],[100,-0.008720899932086468,1.1281874179840088,0.00222250004298985],[101,-0.008099100552499294,1.1284860372543335,0.0020077000372111797],[102,-0.007401800248771906,1.1287678480148315,0.0017854999750852585],[103,-0.006636300124228001,1.1290290355682373,0.0015580999897792935],[104,-0.005810299888253212,1.1292662620544434,0.0013275000965222716],[105,-0.004931100178509951,1.1294764280319214,0.0010960999643430114],[106,-0.004006300121545792,1.1296558380126953,0.0008658000151626766],[107,-0.0030433000065386295,1.1298013925552368,0.0006389000336639583],[108,-0.0020496000070124865,1.1299093961715698,0.0004175000067334622],[109,-0.0010327000636607409,1.1299768686294556,0.00020379999477881938],[110,0,1.1299999952316284,0]]}]},"1104":{"name":"MinP_stand_sad.gmt","root":"center_n","frames":140,"fps":30,"loop":false,"translation":[{"axis":"xyz","keys":[[0,0,1.1299999952316284,0],[1,-0.000010700000530050602,1.1298542022705078,0.00011980000272160396],[2,-0.00003300000025774352,1.129446029663086,0.0004765999910887331],[3,-0.000052200000936863944,1.1288193464279175,0.0010661000851541758],[4,-0.00005370000144466758,1.128017544746399,0.0018841000273823738],[5,-0.000022899999748915434,1.1270846128463745,0.002926599932834506],[6,0.000055100001191021875,1.1260641813278198,0.004189200233668089],[7,0.00019480001355987042,1.125,0.005668000318109989],[8,0.00041080001392401755,1.1239359378814697,0.00735860038548708],[9,0.0007180000538937747,1.122915506362915,0.009256900288164616],[10,0.0011308001121506095,1.121982455253601,0.011358699761331081],[11,0.0016641000984236598,1.121180772781372,0.013659900985658169],[12,0.0023324000649154186,1.120553970336914,0.01615629903972149],[13,0.0031504002399742603,1.1201457977294922,0.018843701109290123],[14,0.004132899921387434,1.1200000047683716,0.021717900410294533],[15,0.00529440026730299,1.1200389862060547,0.02477489970624447],[16,0.006649599876254797,1.1201543807983398,0.028010299429297447],[17,0.008213300257921219,1.120343804359436,0.03142010048031807],[18,0.010000000707805157,1.1206049919128418,0.03500000014901161],[19,0.01278110034763813,1.1209356784820557,0.03906270116567612],[20,0.017092600464820862,1.1213334798812866,0.04386270046234131],[21,0.02259649895131588,1.1217960119247437,0.049308501183986664],[22,0.028954699635505676,1.1223211288452148,0.055308401584625244],[23,0.03582900017499924,1.1229063272476196,0.061771102249622345],[24,0.042881302535533905,1.123549461364746,0.06860510259866714],[25,0.049773599952459335,1.1242481470108032,0.07571880519390106],[26,0.05616769939661026,1.125,0.08302079886198044],[27,0.06172540411353111,1.1259105205535889,0.09041950106620789],[28,0.06610880047082901,1.1269875764846802,0.09782350063323975],[29,0.06897970288991928,1.128083348274231,0.10514120012521744],[30,0.07000000029802322,1.1290494203567505,0.1122812032699585],[31,0.06933420151472092,1.1297377347946167,0.11915190517902374],[32,0.06746150553226471,1.1299999952316284,0.12566189467906952],[33,0.06451579928398132,1.129371166229248,0.1317196935415268],[34,0.06063089892268181,1.1277273893356323,0.137233704328537],[35,0.05594080314040184,1.1254326105117798,0.14211250841617584],[36,0.05057929828763008,1.122851014137268,0.14635299146175385],[37,0.0446803979575634,1.1203469038009644,0.15004250407218933],[38,0.038377899676561356,1.118283987045288,0.1532249003648758],[39,0.031805600970983505,1.1165560483932495,0.15594430267810822],[40,0.025097502395510674,1.1148340702056885,0.15824471414089203],[41,0.018387500196695328,1.1131494045257568,0.16017000377178192],[42,0.011809400282800198,1.1115326881408691,0.16176410019397736],[43,0.005497099831700325,1.1100152730941772,0.16307120025157928],[44,-0.00041550002060830593,1.1086280345916748,0.16413520276546478],[45,-0.00579450000077486,1.107401728630066,0.16500000655651093],[46,-0.0105061000213027,1.1063677072525024,0.16545520722866058],[47,-0.014416299760341644,1.105556845664978,0.16534100472927094],[48,-0.017391299828886986,1.1050000190734863,0.16477739810943604],[49,-0.019297100603580475,1.1046184301376343,0.163884699344635],[50,-0.020000001415610313,1.1043084859848022,0.16278289258480072],[51,-0.020075799897313118,1.1040648221969604,0.16159220039844513],[52,-0.02018660120666027,1.1038817167282104,0.16043250262737274],[53,-0.020327700302004814,1.1037538051605225,0.15942411124706268],[54,-0.02049410156905651,1.1036754846572876,0.15868699550628662],[55,-0.02068129926919937,1.1036412715911865,0.15811850130558014],[56,-0.020884299650788307,1.1036454439163208,0.15754079818725586],[57,-0.02109850011765957,1.1036827564239502,0.15696179866790771],[58,-0.02131900005042553,1.1037472486495972,0.15638940036296844],[59,-0.02154110185801983,1.103833794593811,0.1558315008878708],[60,-0.02175999991595745,1.1039366722106934,0.15529589354991913],[61,-0.021970899775624275,1.1040505170822144,0.15479040145874023],[62,-0.022169100120663643,1.104169249534607,0.154323011636734],[63,-0.022349800914525986,1.10428786277771,0.15390150249004364],[64,-0.022508200258016586,1.104400634765625,0.15353380143642426],[65,-0.022639499977231026,1.1045020818710327,0.15322770178318024],[66,-0.022739000618457794,1.1045864820480347,0.15299099683761597],[67,-0.022802000865340233,1.1046485900878906,0.15283170342445374],[68,-0.022823501378297806,1.1046826839447021,0.15275759994983673],[69,-0.022798901423811913,1.10468327999115,0.15272259712219238],[70,-0.022723400965332985,1.1046446561813354,0.15267600119113922],[71,-0.02261899970471859,1.104587435722351,0.1526183933019638],[72,-0.022509301081299782,1.1045358180999756,0.15255069732666016],[73,-0.02239139936864376,1.1044894456863403,0.15247340500354767],[74,-0.02226260118186474,1.1044481992721558,0.15238741040229797],[75,-0.02212039940059185,1.1044117212295532,0.15229330956935883],[76,-0.021961798891425133,1.1043801307678223,0.1521919071674347],[77,-0.021784299984574318,1.1043531894683838,0.15208390355110168],[78,-0.021585099399089813,1.1043305397033691,0.15197010338306427],[79,-0.021361500024795532,1.1043121814727783,0.15185099840164185],[80,-0.02111080102622509,1.1042978763580322,0.1517276018857956],[81,-0.020830301567912102,1.1042873859405518,0.15160050988197327],[82,-0.020517200231552124,1.1042805910110474,0.15147030353546143],[83,-0.02016890048980713,1.104277491569519,0.15133801102638245],[84,-0.019782600924372673,1.104277491569519,0.15120400488376617],[85,-0.01935569941997528,1.1042808294296265,0.1510692983865738],[86,-0.018885299563407898,1.1042872667312622,0.15093450248241425],[87,-0.018368801102042198,1.1042964458465576,0.15080030262470245],[88,-0.017803600057959557,1.1043082475662231,0.15065351128578186],[89,-0.01718680001795292,1.1043225526809692,0.1505005955696106],[90,-0.0165157001465559,1.1043392419815063,0.15037201344966888],[91,-0.015787700191140175,1.1043580770492554,0.1502981036901474],[92,-0.015000000596046448,1.1043787002563477,0.1503095030784607],[93,-0.014152300544083118,1.1044012308120728,0.1504366099834442],[94,-0.013231100514531136,1.104425311088562,0.15070979297161102],[95,-0.012213700450956821,1.1044508218765259,0.15115970373153687],[96,-0.011077499948441982,1.1044776439666748,0.1518165022134781],[97,-0.009799900464713573,1.1045055389404297,0.15311019122600555],[98,-0.008358299732208252,1.104534387588501,0.15527620911598206],[99,-0.006730200257152319,1.10456383228302,0.1580532044172287],[100,-0.0048929001204669476,1.1045939922332764,0.16118000447750092],[101,-0.0028239001985639334,1.1046243906021118,0.1643953025341034],[102,-0.000500400026794523,1.104655146598816,0.16743800044059753],[103,0.002099999925121665,1.1046857833862305,0.17004670202732086],[104,0.005000000353902578,1.1047163009643555,0.17196029424667358],[105,0.008557300083339214,1.1047465801239014,0.17291750013828278],[106,0.013010600581765175,1.1047762632369995,0.17287319898605347],[107,0.01820400170981884,1.1050552129745483,0.1720041036605835],[108,0.023981399834156036,1.1057945489883423,0.17038150131702423],[109,0.03018690086901188,1.1069364547729492,0.16807660460472107],[110,0.03666440024971962,1.1084232330322266,0.16516080498695374],[111,0.04325820133090019,1.1101971864700317,0.16170519590377808],[112,0.04981210082769394,1.1122006177902222,0.1577811986207962],[113,0.05617010220885277,1.1143754720687866,0.15346010029315948],[114,0.06183920055627823,1.1166642904281616,0.14881320297718048],[115,0.06642010062932968,1.119009256362915,0.14391160011291504],[116,0.06989790499210358,1.1213525533676147,0.13882680237293243],[117,0.07225769758224487,1.1236364841461182,0.13348230719566345],[118,0.07348459959030151,1.1258032321929932,0.1277804970741272],[119,0.0735635980963707,1.1277951002120972,0.12176059931516647],[120,0.07247970253229141,1.129554271697998,0.11546150594949722],[121,0.07021819800138474,1.1310231685638428,0.10892260074615479],[122,0.06676390022039413,1.1321438550949097,0.10218280553817749],[123,0.062485601752996445,1.1328585147857666,0.09528139978647232],[124,0.05782970413565636,1.1331095695495605,0.08825740218162537],[125,0.05289740115404129,1.1328824758529663,0.0811501070857048],[126,0.04779050126671791,1.1322661638259888,0.07399850338697433],[127,0.042610201984643936,1.1313579082489014,0.06684180349111557],[128,0.03745820000767708,1.130255103111267,0.05971909686923027],[129,0.03243600204586983,1.1290549039840698,0.052669502794742584],[130,0.027644900605082512,1.127854585647583,0.045732300728559494],[131,0.02318650111556053,1.1267517805099487,0.038946401327848434],[132,0.019026799127459526,1.1258434057235718,0.03231930360198021],[133,0.015108400955796242,1.1252270936965942,0.02592870034277439],[134,0.011497500352561474,1.125,0.01991969905793667],[135,0.008260400034487247,1.1253703832626343,0.014437300153076649],[136,0.005463299807161093,1.1262964010238647,0.009626599960029125],[137,0.0031725000590085983,1.1274999380111694,0.005632500164210796],[138,0.0014542000135406852,1.1287037134170532,0.0026000000070780516],[139,0.00037460000021383166,1.1296296119689941,0.0006742000114172697],[140,0,1.1299999952316284,0]]}]},"1228":{"name":"MnG09KameM_cheer_01lp.gmt","root":"center_n","frames":57,"fps":30,"loop":true,"translation":[{"axis":"xyz","keys":[[0,-0.000004800000169780105,1.0506463050842285,-0.0000018000000636675395],[1,0.00217230012640357,1.0475311279296875,0.0070722997188568115],[2,0.0024759999942034483,1.0509852170944214,0.014092999510467052],[3,-0.000008600000001024455,1.0623630285263062,0.017580000683665276],[4,-0.0026575999800115824,1.0760172605514526,0.015247699804604053],[5,-0.0035852999426424503,1.0879873037338257,0.0069174999371171],[6,-0.0016868999227881432,1.0964221954345703,-0.004225300159305334],[7,0.0012733000330626965,1.099625825881958,-0.013945500366389751],[8,0.00338740018196404,1.0964093208312988,-0.019016901031136513],[9,0.005317499861121178,1.090341567993164,-0.020097700878977776],[10,0.006213500164449215,1.0874565839767456,-0.016865601763129234],[11,0.004160100128501654,1.09097421169281,-0.012474100105464458],[12,0.002954800147563219,1.0962258577346802,-0.009393400512635708],[13,0.0040107001550495625,1.1001018285751343,-0.009545300155878067],[14,0.007611300330609083,1.1010633707046509,-0.012936499901115894],[15,0.011545199900865555,1.0972412824630737,-0.016166100278496742],[16,0.014018299989402294,1.0925968885421753,-0.016714001074433327],[17,0.014374000020325184,1.0905709266662598,-0.015038199722766876],[18,0.013077199459075928,1.0913819074630737,-0.011910899542272091],[19,0.011634300462901592,1.0940239429473877,-0.008116899989545345],[20,0.009005500003695488,1.0969003438949585,-0.00444769999012351],[21,0.005754000041633844,1.0978730916976929,-0.00032920000376179814],[22,0.0030368000734597445,1.0948679447174072,0.004762100055813789],[23,0.001102200010791421,1.0878163576126099,0.009589000605046749],[24,-0.0006082000327296555,1.0790342092514038,0.013313700444996357],[25,-0.002042200183495879,1.0695319175720215,0.017253201454877853],[26,-0.001938300090841949,1.0618637800216675,0.021831899881362915],[27,-0.0007814000709913671,1.05683171749115,0.026213500648736954],[28,-0.00007480000203941017,1.0566941499710083,0.029875800013542175],[29,0.00002789999962260481,1.061401128768921,0.0317968986928463],[30,0.0006628000410273671,1.0709707736968994,0.03027139976620674],[31,0.0007389000384137034,1.0813863277435303,0.024651100859045982],[32,0.0012398000108078122,1.091650366783142,0.015042099170386791],[33,0.004072499927133322,1.1007660627365112,0.0038511999882757664],[34,0.007904600352048874,1.1024459600448608,-0.006729400251060724],[35,0.01049600075930357,1.09902822971344,-0.01442440040409565],[36,0.010868100449442863,1.0924891233444214,-0.019710199907422066],[37,0.0094328997656703,1.0864043235778809,-0.02204889990389347],[38,0.0074442001059651375,1.083783507347107,-0.02151159942150116],[39,0.00503640016540885,1.0863592624664307,-0.02049880102276802],[40,0.003540600184351206,1.0898977518081665,-0.020090200006961823],[41,0.003313800087198615,1.092281460762024,-0.02208459936082363],[42,0.00424680020660162,1.092876672744751,-0.027333000674843788],[43,0.00496360007673502,1.0908762216567993,-0.032849300652742386],[44,0.004559100139886141,1.0868312120437622,-0.035603802651166916],[45,0.003456100123003125,1.0839511156082153,-0.03594269976019859],[46,0.002221000147983432,1.0838086605072021,-0.03457620367407799],[47,0.0009665999677963555,1.0860297679901123,-0.03319710120558739],[48,-0.0003462000167928636,1.0893404483795166,-0.03247329965233803],[49,-0.0019720999989658594,1.0922530889511108,-0.032792698591947556],[50,-0.0041367001831531525,1.0933797359466553,-0.03317610174417496],[51,-0.006363099906593561,1.0923506021499634,-0.03304530307650566],[52,-0.008010799996554852,1.0883573293685913,-0.03195599839091301],[53,-0.009187299758195877,1.0811411142349243,-0.029467402026057243],[54,-0.009117900393903255,1.0735409259796143,-0.024334801360964775],[55,-0.006872800178825855,1.0657776594161987,-0.01665090024471283],[56,-0.003372600069269538,1.058072566986084,-0.008008900098502636],[57,-0.000004800000169780105,1.0506463050842285,-0.0000018000000636675395],[57,-0.000004800000169780105,1.0506463050842285,-0.0000018000000636675395]]}]},"1229":{"name":"MnG09KameM_cheer_02lp.gmt","root":"center_n","frames":57,"fps":30,"loop":true,"translation":[{"axis":"xyz","keys":[[0,0.000004800000169780105,1.0506463050842285,-0.0000018000000636675395],[1,-0.00217230012640357,1.0475311279296875,0.0070722997188568115],[2,-0.0024759999942034483,1.0509852170944214,0.014092999510467052],[3,0.000008600000001024455,1.0623630285263062,0.017580000683665276],[4,0.0026575999800115824,1.0760172605514526,0.015247699804604053],[5,0.0035852999426424503,1.0879873037338257,0.0069174999371171],[6,0.0016868999227881432,1.0964221954345703,-0.004225300159305334],[7,-0.0012733000330626965,1.099625825881958,-0.013945500366389751],[8,-0.00338740018196404,1.0964093208312988,-0.019016901031136513],[9,-0.005317499861121178,1.090341567993164,-0.020097700878977776],[10,-0.006213500164449215,1.0874565839767456,-0.016865601763129234],[11,-0.004160100128501654,1.09097421169281,-0.012474100105464458],[12,-0.002954800147563219,1.0962258577346802,-0.009393400512635708],[13,-0.0040107001550495625,1.1001018285751343,-0.009545300155878067],[14,-0.007611300330609083,1.1010633707046509,-0.012936499901115894],[15,-0.011545199900865555,1.0972412824630737,-0.016166100278496742],[16,-0.014018299989402294,1.0925968885421753,-0.016714001074433327],[17,-0.014374000020325184,1.0905709266662598,-0.015038199722766876],[18,-0.013077199459075928,1.0913819074630737,-0.011910899542272091],[19,-0.011634300462901592,1.0940239429473877,-0.008116899989545345],[20,-0.009005500003695488,1.0969003438949585,-0.00444769999012351],[21,-0.005754000041633844,1.0978730916976929,-0.00032920000376179814],[22,-0.0030368000734597445,1.0948679447174072,0.004762100055813789],[23,-0.001102200010791421,1.0878163576126099,0.009589000605046749],[24,0.0006082000327296555,1.0790342092514038,0.013313700444996357],[25,0.002042200183495879,1.0695319175720215,0.017253201454877853],[26,0.001938300090841949,1.0618637800216675,0.021831899881362915],[27,0.0007814000709913671,1.05683171749115,0.026213500648736954],[28,0.00007480000203941017,1.0566941499710083,0.029875800013542175],[29,-0.00002789999962260481,1.061401128768921,0.0317968986928463],[30,-0.0006628000410273671,1.0709707736968994,0.03027139976620674],[31,-0.0007389000384137034,1.0813863277435303,0.024651100859045982],[32,-0.0012398000108078122,1.091650366783142,0.015042099170386791],[33,-0.004072499927133322,1.1007660627365112,0.0038511999882757664],[34,-0.007904600352048874,1.1024459600448608,-0.006729400251060724],[35,-0.01049600075930357,1.09902822971344,-0.01442440040409565],[36,-0.010868100449442863,1.0924891233444214,-0.019710199907422066],[37,-0.0094328997656703,1.0864043235778809,-0.02204889990389347],[38,-0.0074442001059651375,1.083783507347107,-0.02151159942150116],[39,-0.00503640016540885,1.0863592624664307,-0.02049880102276802],[40,-0.003540600184351206,1.0898977518081665,-0.020090200006961823],[41,-0.003313800087198615,1.092281460762024,-0.02208459936082363],[42,-0.00424680020660162,1.092876672744751,-0.027333000674843788],[43,-0.00496360007673502,1.0908762216567993,-0.032849300652742386],[44,-0.004559100139886141,1.0868312120437622,-0.035603802651166916],[45,-0.003456100123003125,1.0839511156082153,-0.03594269976019859],[46,-0.002221000147983432,1.0838086605072021,-0.03457620367407799],[47,-0.0009665999677963555,1.0860297679901123,-0.03319710120558739],[48,0.0003462000167928636,1.0893404483795166,-0.03247329965233803],[49,0.0019720999989658594,1.0922530889511108,-0.032792698591947556],[50,0.0041367001831531525,1.0933797359466553,-0.03317610174417496],[51,0.006363099906593561,1.0923506021499634,-0.03304530307650566],[52,0.008010799996554852,1.0883573293685913,-0.03195599839091301],[53,0.009187299758195877,1.0811411142349243,-0.029467402026057243],[54,0.009117900393903255,1.0735409259796143,-0.024334801360964775],[55,0.006872800178825855,1.0657776594161987,-0.01665090024471283],[56,0.003372600069269538,1.058072566986084,-0.008008900098502636],[57,0.000004800000169780105,1.0506463050842285,-0.0000018000000636675395],[57,0.000004800000169780105,1.0506463050842285,-0.0000018000000636675395]]}]},"1230":{"name":"MnG09KameM_cheer_03lp.gmt","root":"center_n","frames":43,"fps":30,"loop":true,"translation":[{"axis":"xyz","keys":[[0,-0.00000470000031782547,1.0697892904281616,-0.0000012000000424450263],[1,-0.009621799923479557,1.0643031597137451,-0.0017329000402241945],[2,-0.017524098977446556,1.062963604927063,-0.0036231998819857836],[3,-0.025138700380921364,1.0724353790283203,-0.00574229983612895],[4,-0.03199009969830513,1.0871371030807495,-0.008160199970006943],[5,-0.03663400188088417,1.100878357887268,-0.010947300121188164],[6,-0.0397828035056591,1.1095770597457886,-0.01417350023984909],[7,-0.042446501553058624,1.1119029521942139,-0.01790889911353588],[8,-0.045152198523283005,1.108105182647705,-0.022223901003599167],[9,-0.04748320206999779,1.097930669784546,-0.02718839980661869],[10,-0.048221003264188766,1.0836069583892822,-0.03268609941005707],[11,-0.04749999940395355,1.0674389600753784,-0.03710250183939934],[12,-0.04450660198926926,1.0547512769699097,-0.038554299622774124],[13,-0.03856290131807327,1.0490527153015137,-0.03515100106596947],[14,-0.031613800674676895,1.0505778789520264,-0.02957719936966896],[15,-0.02421410009264946,1.0607775449752808,-0.020574800670146942],[16,-0.01584080047905445,1.072274088859558,-0.011285300366580486],[17,-0.007356499787420034,1.0840604305267334,-0.0038945998530834913],[18,0.0003940000315196812,1.0951296091079712,0.0009839000413194299],[19,0.009039100259542465,1.102452278137207,0.004676900338381529],[20,0.01828480139374733,1.1042449474334717,0.005741800181567669],[21,0.028679100796580315,1.1016716957092285,0.0019827999640256166],[22,0.039182599633932114,1.0966519117355347,-0.0032175001688301563],[23,0.04891499876976013,1.0950592756271362,-0.006176900118589401],[24,0.052817899733781815,1.0998448133468628,-0.00160910002887249],[25,0.05234919860959053,1.107424020767212,0.005517299752682447],[26,0.050665099173784256,1.1151670217514038,0.013433900661766529],[27,0.0491832010447979,1.1187379360198975,0.02032800018787384],[28,0.05256999656558037,1.1150118112564087,0.022006100043654442],[29,0.05756790190935135,1.1082472801208496,0.017645400017499924],[30,0.06191440299153328,1.1054238080978394,0.012205400504171848],[31,0.06175429746508598,1.1091622114181519,0.007615000009536743],[32,0.06159630045294762,1.1133757829666138,0.007915499620139599],[33,0.06106079742312431,1.115775465965271,0.008776200003921986],[34,0.06042730435729027,1.1138499975204468,0.00859840027987957],[35,0.05947200208902359,1.1095918416976929,0.008503399789333344],[36,0.057395000010728836,1.1046804189682007,0.007720500230789185],[37,0.05288050323724747,1.0997408628463745,0.007190100383013487],[38,0.04638200253248215,1.0947781801223755,0.007027500309050083],[39,0.038352902978658676,1.0897971391677856,0.0064733000472188],[40,0.029246801510453224,1.0848028659820557,0.0054188999347388744],[41,0.019516900181770325,1.0798001289367676,0.0037571003194898367],[42,0.009616900235414505,1.0747939348220825,0.0018350000027567148],[43,-0.00000470000031782547,1.0697892904281616,-0.0000012000000424450263],[43,-0.00000470000031782547,1.0697892904281616,-0.0000012000000424450263]]}]},"1231":{"name":"MnG09KameM_cheer_04lp.gmt","root":"center_n","frames":43,"fps":30,"loop":true,"translation":[{"axis":"xyz","keys":[[0,0.00000470000031782547,1.0697892904281616,-0.0000012000000424450263],[1,0.009621799923479557,1.0643031597137451,-0.0017329000402241945],[2,0.017524098977446556,1.062963604927063,-0.0036231998819857836],[3,0.025138700380921364,1.0724353790283203,-0.00574229983612895],[4,0.03199009969830513,1.0871371030807495,-0.008160199970006943],[5,0.03663400188088417,1.100878357887268,-0.010947300121188164],[6,0.0397828035056591,1.1095770597457886,-0.01417350023984909],[7,0.042446501553058624,1.1119029521942139,-0.01790889911353588],[8,0.045152198523283005,1.108105182647705,-0.022223901003599167],[9,0.04748320206999779,1.097930669784546,-0.02718839980661869],[10,0.048221003264188766,1.0836069583892822,-0.03268609941005707],[11,0.04749999940395355,1.0674389600753784,-0.03710250183939934],[12,0.04450660198926926,1.0547512769699097,-0.038554299622774124],[13,0.03856290131807327,1.0490527153015137,-0.03515100106596947],[14,0.031613800674676895,1.0505778789520264,-0.02957719936966896],[15,0.02421410009264946,1.0607775449752808,-0.020574800670146942],[16,0.01584080047905445,1.072274088859558,-0.011285300366580486],[17,0.007356499787420034,1.0840604305267334,-0.0038945998530834913],[18,-0.0003940000315196812,1.0951296091079712,0.0009839000413194299],[19,-0.009039100259542465,1.102452278137207,0.004676900338381529],[20,-0.01828480139374733,1.1042449474334717,0.005741800181567669],[21,-0.028679100796580315,1.1016716957092285,0.0019827999640256166],[22,-0.039182599633932114,1.0966519117355347,-0.0032175001688301563],[23,-0.04891499876976013,1.0950592756271362,-0.006176900118589401],[24,-0.052817899733781815,1.0998448133468628,-0.00160910002887249],[25,-0.05234919860959053,1.107424020767212,0.005517299752682447],[26,-0.050665099173784256,1.1151670217514038,0.013433900661766529],[27,-0.0491832010447979,1.1187379360198975,0.02032800018787384],[28,-0.05256999656558037,1.1150118112564087,0.022006100043654442],[29,-0.05756790190935135,1.1082472801208496,0.017645400017499924],[30,-0.06191440299153328,1.1054238080978394,0.012205400504171848],[31,-0.06175429746508598,1.1091622114181519,0.007615000009536743],[32,-0.06159630045294762,1.1133757829666138,0.007915499620139599],[33,-0.06106079742312431,1.115775465965271,0.008776200003921986],[34,-0.06042730435729027,1.1138499975204468,0.00859840027987957],[35,-0.05947200208902359,1.1095918416976929,0.008503399789333344],[36,-0.057395000010728836,1.1046804189682007,0.007720500230789185],[37,-0.05288050323724747,1.0997408628463745,0.007190100383013487],[38,-0.04638200253248215,1.0947781801223755,0.007027500309050083],[39,-0.038352902978658676,1.0897971391677856,0.0064733000472188],[40,-0.029246801510453224,1.0848028659820557,0.0054188999347388744],[41,-0.019516900181770325,1.0798001289367676,0.0037571003194898367],[42,-0.009616900235414505,1.0747939348220825,0.0018350000027567148],[43,0.00000470000031782547,1.0697892904281616,-0.0000012000000424450263],[43,0.00000470000031782547,1.0697892904281616,-0.0000012000000424450263]]}]},"1232":{"name":"MnG09KameM_cheer_loselp.gmt","root":"center_n","frames":166,"fps":30,"loop":true,"translation":[{"axis":"xyz","keys":[[0,0.0000014999999393694452,1.0671101808547974,-0.000002499999936844688],[1,0.009808200411498547,1.064706802368164,0.0025351999793201685],[2,0.016284599900245667,1.0641062259674072,0.005341200157999992],[3,0.019823400303721428,1.0650566816329956,0.008422800339758396],[4,0.020817700773477554,1.0673067569732666,0.011787599883973598],[5,0.019660500809550285,1.070604681968689,0.015443000011146069],[6,0.01674470119178295,1.0746991634368896,0.019396601244807243],[7,0.012463199906051159,1.0793384313583374,0.023655900731682777],[8,0.007209000177681446,1.0842711925506592,0.02822819910943508],[9,0.00137520011048764,1.0892456769943237,0.033121202141046524],[10,-0.004645499866455793,1.094010353088379,0.038342200219631195],[11,-0.01045989990234375,1.0983136892318726,0.04389890283346176],[12,-0.015675200149416924,1.1019041538238525,0.04979860037565231],[13,-0.019898399710655212,1.1045302152633667,0.05604889988899231],[14,-0.022736500948667526,1.1059402227401733,0.0626571998000145],[15,-0.023796500638127327,1.1065863370895386,0.06964220106601715],[16,-0.022685600444674492,1.1070865392684937,0.0760767012834549],[17,-0.019010700285434723,1.1074384450912476,0.08178170025348663],[18,-0.012913200072944164,1.1076393127441406,0.0866113007068634],[19,-0.007444699760526419,1.1076868772506714,0.08944910019636154],[20,-0.0026935001369565725,1.107578158378601,0.0905338004231453],[21,0.001187700079753995,1.1073111295700073,0.08989710360765457],[22,0.004340799991041422,1.1068828105926514,0.08790599554777145],[23,0.006362199783325195,1.1062908172607422,0.08516599982976913],[24,0.006802000105381012,1.1055326461791992,0.08210960030555725],[25,0.006472499575465918,1.104605793952942,0.07866010069847107],[26,0.004527700133621693,1.1035076379776,0.07593340426683426],[27,0.0014908000594004989,1.1022355556488037,0.07392920553684235],[28,-0.0019150000298395753,1.1007871627807617,0.07192860543727875],[29,-0.005450400058180094,1.099159836769104,0.06957290321588516],[30,-0.008499400690197945,1.0973509550094604,0.0676083043217659],[31,-0.012093699537217617,1.09535813331604,0.06635220348834991],[32,-0.014876901172101498,1.093178629875183,0.06538350135087967],[33,-0.01682480052113533,1.0908101797103882,0.06511809676885605],[34,-0.019033700227737427,1.0880950689315796,0.0647675022482872],[35,-0.021803000941872597,1.0849589109420776,0.06465750187635422],[36,-0.024984700605273247,1.0815246105194092,0.06459420174360275],[37,-0.0278881024569273,1.0779149532318115,0.06385190039873123],[38,-0.030590400099754333,1.0742524862289429,0.0623432993888855],[39,-0.03250109776854515,1.0706602334976196,0.05989940091967583],[40,-0.0334663987159729,1.0672606229782104,0.056654300540685654],[41,-0.032332997769117355,1.0641764402389526,0.05370759963989258],[42,-0.028980201110243797,1.0615304708480835,0.05135419964790344],[43,-0.026372600346803665,1.0594455003738403,0.04945020005106926],[44,-0.023478299379348755,1.058044195175171,0.048435699194669724],[45,-0.02034359984099865,1.0574489831924438,0.04914189875125885],[46,-0.01701500080525875,1.0580013990402222,0.052198100835084915],[47,-0.01353870052844286,1.0597882270812988,0.05650730058550835],[48,-0.009961300529539585,1.0625509023666382,0.06174659729003906],[49,-0.006328999996185303,1.066030740737915,0.06788729876279831],[50,-0.002688300097361207,1.0699690580368042,0.07482650130987167],[51,0.000914399977773428,1.0741075277328491,0.08289790153503418],[52,0.004432800225913525,1.0781872272491455,0.09125729650259018],[53,0.007820500060915947,1.0819497108459473,0.10001830011606216],[54,0.011031200177967548,1.0851362943649292,0.10929150879383087],[55,0.014018299989402294,1.0874885320663452,0.11831500381231308],[56,0.01673549972474575,1.0892573595046997,0.12672510743141174],[57,0.019136600196361542,1.0908632278442383,0.1339133083820343],[58,0.021547600626945496,1.0923017263412476,0.13926179707050323],[59,0.0224676001816988,1.093567967414856,0.14300189912319183],[60,0.02172739990055561,1.09465754032135,0.14532339572906494],[61,0.01956620067358017,1.095565676689148,0.14617881178855896],[62,0.018323000520467758,1.0962879657745361,0.1462073028087616],[63,0.01709589920938015,1.0968196392059326,0.14537081122398376],[64,0.015882600098848343,1.0971559286117554,0.1437598019838333],[65,0.014681200496852398,1.0972927808761597,0.14121459424495697],[66,0.013489599339663982,1.0972250699996948,0.13831230998039246],[67,0.012305700220167637,1.0969430208206177,0.13545140624046326],[68,0.01112740021198988,1.0964374542236328,0.13234670460224152],[69,0.009952600114047527,1.0957047939300537,0.1293696016073227],[70,0.00877930037677288,1.0947407484054565,0.1258344054222107],[71,0.007605300284922123,1.0935416221618652,0.12194770574569702],[72,0.006428699940443039,1.0921037197113037,0.11918530613183975],[73,0.005247300025075674,1.0904231071472168,0.11744090169668198],[74,0.004058999940752983,1.0884960889816284,0.11610009521245956],[75,0.0028618001379072666,1.0863184928894043,0.11402010172605515],[76,0.0016535999020561576,1.0838868618011475,0.11073310673236847],[77,0.00043230000301264226,1.0808824300765991,0.10563349723815918],[78,-0.0008042000117711723,1.0771269798278809,0.0998217985033989],[79,-0.0020578999537974596,1.0728271007537842,0.09402750432491302],[80,-0.004431200213730335,1.0681895017623901,0.08845710009336472],[81,-0.006435000337660313,1.0634206533432007,0.08318360149860382],[82,-0.006832499988377094,1.0587271451950073,0.0788482055068016],[83,-0.005716000217944384,1.054315447807312,0.07524730265140533],[84,-0.003716700244694948,1.050392508506775,0.07296620309352875],[85,-0.0013918000040575862,1.047164797782898,0.07271980494260788],[86,0.0018712999299168587,1.044838786125183,0.0742047056555748],[87,0.005619899835437536,1.043621301651001,0.07764539867639542],[88,0.009224499575793743,1.043718695640564,0.0820751041173935],[89,0.012713399715721607,1.0455141067504883,0.08757640421390533],[90,0.015611499547958374,1.049026370048523,0.0932919979095459],[91,0.017833100631833076,1.0539146661758423,0.09852799773216248],[92,0.01898770034313202,1.0598386526107788,0.10321129858493805],[93,0.019354401156306267,1.0664578676223755,0.10723640024662018],[94,0.019277699291706085,1.0734317302703857,0.11085610836744308],[95,0.01825750060379505,1.080419898033142,0.11365159600973129],[96,0.01704159937798977,1.0870816707611084,0.11571589857339859],[97,0.015211999416351318,1.0930765867233276,0.11723879724740982],[98,0.012761999852955341,1.0980644226074219,0.11804469674825668],[99,0.010323500260710716,1.101704478263855,0.11815140396356583],[100,0.007858499884605408,1.1036561727523804,0.11811959743499756],[101,0.005301500204950571,1.1046520471572876,0.11729740351438522],[102,0.003335400018841028,1.104717493057251,0.11589930206537247],[103,0.0016443999484181404,1.1043375730514526,0.1137436032295227],[104,0.000048400001105619594,1.1037739515304565,0.11058109998703003],[105,-0.0015431999927386642,1.1030385494232178,0.10677219927310944],[106,-0.0028030001558363438,1.1021440029144287,0.10324310511350632],[107,-0.004320000298321247,1.1011027097702026,0.09978330135345459],[108,-0.005719299893826246,1.0999268293380737,0.09667729586362839],[109,-0.0067309001460671425,1.098629117012024,0.09332020580768585],[110,-0.0076779997907578945,1.0972217321395874,0.0890749990940094],[111,-0.008088000118732452,1.095716953277588,0.08530830591917038],[112,-0.008135099895298481,1.0941274166107178,0.08222400397062302],[113,-0.007502400316298008,1.0924652814865112,0.07936250418424606],[114,-0.00654219975695014,1.090743064880371,0.07717999815940857],[115,-0.005423800088465214,1.0889732837677002,0.07473769783973694],[116,-0.004105099942535162,1.0871680974960327,0.07150530070066452],[117,-0.0024048001505434513,1.085050344467163,0.06756950169801712],[118,-0.00043020001612603664,1.082423210144043,0.06312110275030136],[119,0.0017766999080777168,1.0794200897216797,0.05873050168156624],[120,0.004202899988740683,1.0761739015579224,0.053362298756837845],[121,0.007352100219577551,1.0728178024291992,0.046786002814769745],[122,0.012178699485957623,1.0694849491119385,0.04011030122637749],[123,0.019047100096940994,1.0663083791732788,0.03402700275182724],[124,0.029007399454712868,1.063421368598938,0.028676999732851982],[125,0.04238789901137352,1.0609568357467651,0.024654900655150414],[126,0.0585394985973835,1.059048056602478,0.022694101557135582],[127,0.07621859759092331,1.0578278303146362,0.02279070019721985],[128,0.09424459934234619,1.0574299097061157,0.024142300710082054],[129,0.1119823008775711,1.063119649887085,0.025310998782515526],[130,0.1288229078054428,1.0755704641342163,0.02564769983291626],[131,0.14183330535888672,1.088026762008667,0.025241399183869362],[132,0.15123440325260162,1.0982577800750732,0.024494199082255363],[133,0.15914930403232574,1.1102564334869385,0.022790100425481796],[134,0.1623087078332901,1.1220060586929321,0.021647801622748375],[135,0.16150030493736267,1.1315096616744995,0.01982170157134533],[136,0.15959100425243378,1.1391288042068481,0.016321100294589996],[137,0.15645049512386322,1.14384925365448,0.011274500750005245],[138,0.15149840712547302,1.1448801755905151,0.0051333000883460045],[139,0.14576120674610138,1.1408772468566895,-0.0008821000228635967],[140,0.13895200192928314,1.1321821212768555,-0.00653519993647933],[141,0.13121441006660461,1.1189712285995483,-0.012438400648534298],[142,0.12133419513702393,1.101902723312378,-0.018075300380587578],[143,0.10577590763568878,1.083367943763733,-0.02196270041167736],[144,0.08555660396814346,1.0688035488128662,-0.024792799726128578],[145,0.06710699945688248,1.0648130178451538,-0.02659980021417141],[146,0.05044010281562805,1.0639666318893433,-0.03415840119123459],[147,0.02734619937837124,1.0660771131515503,-0.0322159007191658],[148,0.002951800124719739,1.0697369575500488,-0.029293501749634743],[149,-0.01682170107960701,1.0721465349197388,-0.02937130071222782],[150,-0.03299950063228607,1.0745590925216675,-0.026938600465655327],[151,-0.04614729806780815,1.0772160291671753,-0.022420600056648254],[152,-0.05679119750857353,1.0791386365890503,-0.017259901389479637],[153,-0.0638476014137268,1.081153392791748,-0.013604600913822651],[154,-0.0674860030412674,1.0836495161056519,-0.010276400484144688],[155,-0.0698012039065361,1.0861328840255737,-0.007071399595588446],[156,-0.07028739899396896,1.0880239009857178,-0.005090200342237949],[157,-0.06889240443706512,1.088968276977539,-0.003948900382965803],[158,-0.06647609919309616,1.0887001752853394,-0.0030487000476568937],[159,-0.06294660270214081,1.086729884147644,-0.002283399924635887],[160,-0.058195799589157104,1.0841219425201416,-0.0017884999979287386],[161,-0.051386602222919464,1.0814802646636963,-0.002290799980983138],[162,-0.043125901371240616,1.0788040161132812,-0.0031962997745722532],[163,-0.03434779867529869,1.0760926008224487,-0.004040900152176619],[164,-0.02448990009725094,1.0733451843261719,-0.0038555001374334097],[165,-0.013495800085365772,1.0705610513687134,-0.0023220002185553312],[166,0.0000014999999393694452,1.0671101808547974,-0.000002499999936844688],[166,0.0000014999999393694452,1.0671101808547974,-0.000002499999936844688]]}]},"1233":{"name":"MnG09KameM_cheer_winlp.gmt","root":"center_n","frames":45,"fps":30,"loop":true,"translation":[{"axis":"xyz","keys":[[0,-6.000000212225132e-7,1.0266104936599731,-0.00000140000008741481],[1,-0.0004312999953981489,1.0160093307495117,0.0005299000185914338],[2,-0.0014671999961137772,1.003812313079834,0.002061700215563178],[3,-0.0027715000323951244,0.9923176765441895,0.0045008002780377865],[4,-0.004007500130683184,0.9838238954544067,0.0077541000209748745],[5,-0.004838400054723024,0.9806290864944458,0.011728400364518166],[6,-0.0049275001510977745,0.985343873500824,0.016330599784851074],[7,-0.0040247999131679535,0.9976787567138672,0.021467499434947968],[8,-0.0023217000998556614,1.0170077085494995,0.027046000584959984],[9,-0.0001438000035705045,1.0412479639053345,0.032972801476716995],[10,0.0021833002101629972,1.0667986869812012,0.03915500268340111],[11,0.004334100056439638,1.0899746417999268,0.045499302446842194],[12,0.006796900182962418,1.1035648584365845,0.051912497729063034],[13,0.007899499498307705,1.1079751253128052,0.05830159783363342],[14,0.00887100026011467,1.1060737371444702,0.06457330286502838],[15,0.012264800257980824,1.106092929840088,0.07063450664281845],[16,0.01673229970037937,1.1096885204315186,0.07639210671186447],[17,0.020937800407409668,1.1113473176956177,0.08175290375947952],[18,0.024201801046729088,1.1128352880477905,0.08662369847297668],[19,0.024174800142645836,1.11394464969635,0.09091140329837799],[20,0.020869901403784752,1.1144671440124512,0.09452290087938309],[21,0.017851701006293297,1.1136131286621094,0.09736499935388565],[22,0.014695200137794018,1.1118391752243042,0.09934449940919876],[23,0.014152899384498596,1.1108072996139526,0.10036829859018326],[24,0.01605590060353279,1.1140387058258057,0.10028140991926193],[25,0.01905200071632862,1.1203551292419434,0.09906470030546188],[26,0.02076609991490841,1.1270922422409058,0.09682899713516235],[27,0.019256601110100746,1.1313036680221558,0.09368520230054855],[28,0.015777500346302986,1.1309194564819336,0.08974400162696838],[29,0.012843999080359936,1.1280096769332886,0.08511630445718765],[30,0.012948100455105305,1.1258376836776733,0.07991290092468262],[31,0.01187680009752512,1.1284419298171997,0.07424460351467133],[32,0.010857299901545048,1.135015845298767,0.06822230666875839],[33,0.011026900261640549,1.1397122144699097,0.061956699937582016],[34,0.011384599842131138,1.1393860578536987,0.0555587001144886],[35,0.009667400270700455,1.1336181163787842,0.04913900047540665],[36,0.00666219973936677,1.1219562292099,0.04280860349535942],[37,0.004863699898123741,1.1076042652130127,0.03667820245027542],[38,0.0023632000666111708,1.0931625366210938,0.03085860051214695],[39,0.00023960000544320792,1.079907774925232,0.025460699573159218],[40,-0.0012752000475302339,1.0708000659942627,0.02059520035982132],[41,-0.0017346000531688333,1.062517523765564,0.015533399768173695],[42,-0.0014877000357955694,1.0538089275360107,0.010060399770736694],[43,-0.0008836999768391252,1.0448224544525146,0.005058800335973501],[44,-0.0002716000017244369,1.035706877708435,0.001410700031556189],[45,-6.000000212225132e-7,1.0266104936599731,-0.00000140000008741481],[45,-6.000000212225132e-7,1.0266104936599731,-0.00000140000008741481]]}]},"2069":{"name":"TlkF_stand_angry.gmt","root":"center_n","frames":70,"fps":30,"loop":false,"translation":[{"axis":"xyz","keys":[[0,0,1.1369999647140503,0],[1,6.000000212225132e-7,1.1369802951812744,0.000010800000382005237],[2,0.0000016000000186977559,1.13698410987854,0.00004199999966658652],[3,0.0000014999999393694452,1.1369999647140503,0.00009200000204145908],[4,-8.000000093488779e-7,1.13701593875885,0.00015940000594127923],[5,-0.0000069000002440589014,1.1370198726654053,0.00024250001297332346],[6,-0.000018000000636675395,1.1369999647140503,0.0003395999956410378],[7,-0.000035400000342633575,1.1369909048080444,0.00044930001604370773],[8,-0.000060500002291519195,1.1370282173156738,0.0005700000328943133],[9,-0.00009470000077271834,1.1371017694473267,0.0007000000332482159],[10,-0.00013929999840911478,1.1372008323669434,0.0008378000347875059],[11,-0.0001956000050995499,1.1373153924942017,0.0009817000245675445],[12,-0.00026500000967644155,1.137434959411621,0.001130299991928041],[13,-0.0003487000067252666,1.1375492811203003,0.0012818999821320176],[14,-0.00044830000842921436,1.1376479864120483,0.001434899982996285],[15,-0.0005648999940603971,1.1377204656600952,0.0015876999823376536],[16,-0.0007000000332482159,1.1377567052841187,0.0017387999687343836],[17,-0.0008549000485800207,1.1377462148666382,0.001886500045657158],[18,-0.0007528999703936279,1.137678623199463,0.002375200157985091],[19,-0.00015839999832678586,1.1368423700332642,0.0034869001246988773],[20,0.000865899957716465,1.1348017454147339,0.005126700270920992],[21,0.0022573000751435757,1.1319602727890015,0.007199700456112623],[22,0.003953100182116032,1.1287214756011963,0.009610900655388832],[23,0.0058905999176204205,1.1254888772964478,0.01226549968123436],[24,0.008007100783288479,1.1226662397384644,0.01506850030273199],[25,0.010239900089800358,1.1206568479537964,0.017924999818205833],[26,0.012526300735771656,1.1198642253875732,0.020740201696753502],[27,0.014803500846028328,1.1200621128082275,0.023419100791215897],[28,0.01700890064239502,1.1206921339035034,0.025866800919175148],[29,0.019079800695180893,1.1216603517532349,0.027988402172923088],[30,0.020953500643372536,1.1228725910186768,0.029688900336623192],[31,0.022567201405763626,1.1242345571517944,0.030873501673340797],[32,0.02385829947888851,1.125652551651001,0.03144730255007744],[33,0.024764100089669228,1.1270320415496826,0.0313154011964798],[34,0.025221800431609154,1.128279209136963,0.030382800847291946],[35,0.025168700143694878,1.1292999982833862,0.028554601594805717],[36,0.024887099862098694,1.1299999952316284,0.02628929913043976],[37,0.024684200063347816,1.1304961442947388,0.024111701175570488],[38,0.024535300210118294,1.1309678554534912,0.022026799619197845],[39,0.02441529929637909,1.1314159631729126,0.020039500668644905],[40,0.02429950051009655,1.1318410634994507,0.018154701218008995],[41,0.02416280098259449,1.1322435140609741,0.016377201303839684],[42,0.023980500176548958,1.1326245069503784,0.014712000265717506],[43,0.023727500811219215,1.1329840421676636,0.01316400058567524],[44,0.023378999903798103,1.1333231925964355,0.011738000437617302],[45,0.022910101339221,1.1336424350738525,0.010438899509608746],[46,0.02229589968919754,1.1339424848556519,0.00927169993519783],[47,0.021511400118470192,1.1342238187789917,0.008241199888288975],[48,0.020531801506876945,1.1344870328903198,0.007352299988269806],[49,0.019332200288772583,1.1347330808639526,0.006610000040382147],[50,0.017887599766254425,1.1349622011184692,0.0060189999639987946],[51,0.01617320068180561,1.1351752281188965,0.005584400147199631],[52,0.014164100401103497,1.1353728771209717,0.005311000160872936],[53,0.012106900103390217,1.135555624961853,0.005093100015074015],[54,0.010257399640977383,1.1357240676879883,0.004826800432056189],[55,0.008604899980127811,1.1358789205551147,0.004519300069659948],[56,0.007138300221413374,1.1360210180282593,0.004178100265562534],[57,0.005846700165420771,1.1361507177352905,0.0038107000291347504],[58,0.004719100426882505,1.1362684965133667,0.003424299880862236],[59,0.003744700225070119,1.1363753080368042,0.0030262998770922422],[60,0.0029123001731932163,1.1364716291427612,0.0026241999585181475],[61,0.0022112999577075243,1.1365582942962646,0.0022253000643104315],[62,0.001630399958230555,1.136635661125183,0.0018371001351624727],[63,0.0011588999768719077,1.1367045640945435,0.0014668999938294291],[64,0.0007857999880798161,1.136765480041504,0.0011220000451430678],[65,0.000500100024510175,1.1368191242218018,0.0008100000559352338],[66,0.00029090000316500664,1.1368660926818848,0.0005381000228226185],[67,0.0001472000003559515,1.1369069814682007,0.00031370000215247273],[68,0.00005810000220662914,1.1369426250457764,0.0001444000081392005],[69,0.000012700001207122114,1.1369733810424805,0.00003730000025825575],[70,0,1.1369999647140503,0]]}]},"2070":{"name":"TlkF_stand_ase.gmt","root":"center_n","frames":115,"fps":30,"loop":false,"translation":[{"axis":"xyz","keys":[[0,0,1.1369999647140503,0],[1,0.000042499999835854396,1.1370000839233398,0.000008800000614428427],[2,0.00016169999435078353,1.1370002031326294,0.00002849999873433262],[3,0.0003446000046096742,1.1370000839233398,0.000049200003559235483],[4,0.0005785999819636345,1.1369998455047607,0.00006079999729990959],[5,0.0008509000181220472,1.1369991302490234,0.00005329999839887023],[6,0.0011487000156193972,1.136997938156128,0.000016700001651770435],[7,0.0014592999359592795,1.136995792388916,-0.00005900000178371556],[8,0.0017698999727144837,1.1369929313659668,-0.00018370000179857016],[9,0.0020677000284194946,1.1369889974594116,-0.000367600005120039],[10,0.002339900005608797,1.1369839906692505,-0.0006205000099726021],[11,0.0025738999247550964,1.1369775533676147,-0.0009525000350549817],[12,0.0027566999197006226,1.136969804763794,-0.001373699982650578],[13,0.00287580001167953,1.1369602680206299,-0.001893899985589087],[14,0.0029003999661654234,1.1369489431381226,-0.0025232001207768917],[15,0.002794800093397498,1.136935830116272,-0.002962999977171421],[16,0.0025385001208633184,1.1369205713272095,-0.0029472000896930695],[17,0.002111000008881092,1.1369030475616455,-0.0025353000964969397],[18,0.001491700066253543,1.1368831396102905,-0.0017865000991150737],[19,0.0007961999508552253,1.1368571519851685,-0.0007600000244565308],[20,0.00018020000425167382,1.1368225812911987,0.00048489999608136714],[21,-0.0003163000219501555,1.1367806196212769,0.001888900063931942],[22,-0.0006537000299431384,1.1367329359054565,0.0033927999902516603],[23,-0.0007921000360511243,1.1366807222366333,0.004937299992889166],[24,-0.0006994000286795199,1.1366254091262817,0.006463199853897095],[25,-0.00040190000436268747,1.1365684270858765,0.007911100052297115],[26,0.00005189999865251593,1.136511206626892,0.009221799671649933],[27,0.0006134000141173601,1.1364550590515137,0.010336100123822689],[28,0.0012341000838205218,1.1364015340805054,0.011194700375199318],[29,0.0018650999991223216,1.1363519430160522,0.011813600547611713],[30,0.0024864000733941793,1.136307716369629,0.012257100082933903],[31,0.0030933001544326544,1.13627028465271,0.012538500130176544],[32,0.003680900204926729,1.1362409591674805,0.012671299278736115],[33,0.004244399722665548,1.1362212896347046,0.012668601237237453],[34,0.004778900183737278,1.1362124681472778,0.01254390086978674],[35,0.005279700271785259,1.1362102031707764,0.012310399673879147],[36,0.005741899833083153,1.1362086534500122,0.01198159996420145],[37,0.006160600110888481,1.1362080574035645,0.011570599861443043],[38,0.006531100254505873,1.136208176612854,0.011090800166130066],[39,0.006848599761724472,1.13620924949646,0.010555599816143513],[40,0.0071080997586250305,1.1362110376358032,0.00999779999256134],[41,0.007304999977350235,1.1362136602401733,0.00944290030747652],[42,0.00734170014038682,1.1362169981002808,0.008893399499356747],[43,0.007161600049585104,1.136220932006836,0.008351600728929043],[44,0.006820899900048971,1.1362255811691284,0.007819900289177895],[45,0.0063758003525435925,1.1362309455871582,0.007300700526684523],[46,0.00588250020518899,1.1362370252609253,0.006796299945563078],[47,0.005397100001573563,1.1362437009811401,0.006308999843895435],[48,0.0049760001711547375,1.1362508535385132,0.005841400008648634],[49,0.004675100091844797,1.1362587213516235,0.005395600106567144],[50,0.004435800015926361,1.136267066001892,0.004974199924618006],[51,0.004179200157523155,1.1362758874893188,0.004579400178045034],[52,0.003931700251996517,1.1362853050231934,0.00421359995380044],[53,0.0037197002675384283,1.136295199394226,0.0038793000858277082],[54,0.0035695999395102262,1.1363054513931274,0.0035788000095635653],[55,0.003507699817419052,1.136316180229187,0.00331429997459054],[56,0.0035604999866336584,1.1363273859024048,0.003088500117883086],[57,0.003754299832507968,1.1363388299942017,0.0029033999890089035],[58,0.0040842997841537,1.1363506317138672,0.0027544000186026096],[59,0.004510600119829178,1.1363627910614014,0.0026310000102967024],[60,0.005006799940019846,1.1363751888275146,0.002527800155803561],[61,0.005546800326555967,1.1363879442214966,0.002439199946820736],[62,0.0061043002642691135,1.1364009380340576,0.0023596000391989946],[63,0.006652999669313431,1.1364142894744873,0.0022835000418126583],[64,0.0071666003204882145,1.1364279985427856,0.002205299912020564],[65,0.007634399924427271,1.1364420652389526,0.0021194000728428364],[66,0.008063700050115585,1.1364563703536987,0.002020200015977025],[67,0.008455400355160236,1.1364710330963135,0.0019022999331355095],[68,0.008810199797153473,1.1364860534667969,0.0017828999552875757],[69,0.009128900244832039,1.136501431465149,0.0016818000003695488],[70,0.00941229984164238,1.1365171670913696,0.0015971999382600188],[71,0.009661099873483181,1.1365331411361694,0.0015270999865606427],[72,0.009876100346446037,1.136549711227417,0.0014697000151500106],[73,0.010058200918138027,1.136566400527954,0.0014229000080376863],[74,0.010208100080490112,1.1365835666656494,0.0013849999522790313],[75,0.010326500050723553,1.1366010904312134,0.001353900064714253],[76,0.01041440013796091,1.136618971824646,0.001327900099568069],[77,0.010472300462424755,1.1366372108459473,0.0013049000408500433],[78,0.010501299984753132,1.1366559267044067,0.0012830001069232821],[79,0.010501900687813759,1.1366748809814453,0.0012604000512510538],[80,0.010475000366568565,1.136694312095642,0.0012351999757811427],[81,0.01042139995843172,1.1367141008377075,0.001205399981699884],[82,0.010341799817979336,1.1367343664169312,0.00116910005453974],[83,0.010237100534141064,1.1367548704147339,0.001124400063417852],[84,0.010108000598847866,1.1367759704589844,0.0010694999946281314],[85,0.009955300018191338,1.136796474456787,0.0010022999485954642],[86,0.009779900312423706,1.1368157863616943,0.0009209999698214233],[87,0.009584800340235233,1.1368337869644165,0.0008301000343635678],[88,0.009368500672280788,1.1368504762649536,0.0007354000117629766],[89,0.009124300442636013,1.1368660926818848,0.0006377000245265663],[90,0.00884540006518364,1.13688063621521,0.0005373000167310238],[91,0.0085249999538064,1.1368941068649292,0.0004348000220488757],[92,0.008156600408256054,1.136906385421753,0.00033060001442208886],[93,0.0077333003282547,1.1369178295135498,0.00022539999918080866],[94,0.007248400244861841,1.1369282007217407,0.00011950000043725595],[95,0.006695300340652466,1.1369376182556152,0.000013500000022759195],[96,0.006067200098186731,1.1369463205337524,-0.00009200000204145908],[97,0.005357400048524141,1.1369540691375732,-0.00019660001271404326],[98,0.004614700097590685,1.1369611024856567,-0.0002998000127263367],[99,0.003898999886587262,1.1369673013687134,-0.00040109999827109277],[100,0.003220299957320094,1.1369727849960327,-0.0004999000229872763],[101,0.002588599920272827,1.1369776725769043,-0.0005970000056549907],[102,0.0020137999672442675,1.1369819641113281,-0.0006898000137880445],[103,0.0015057999407872558,1.1369856595993042,-0.0007728000055067241],[104,0.001074700034223497,1.1369887590408325,-0.0008407000568695366],[105,0.0007304000318981707,1.1369913816452026,-0.0008879000670276582],[106,0.0004689000197686255,1.136993646621704,-0.0009089999948628247],[107,0.0002735000161919743,1.1369954347610474,-0.0008987000328488648],[108,0.0001351000100839883,1.136996865272522,-0.0008616999839432538],[109,0.00004470000203582458,1.136997938156128,-0.0008092000498436391],[110,-0.000006800000392104266,1.1369986534118652,-0.0007450000266544521],[111,-0.000028599999495781958,1.1369993686676025,-0.0006732000038027763],[112,-0.000029699998776777647,1.1369997262954712,-0.0005261999904178083],[113,-0.000019299999621580355,1.1369999647140503,-0.00029940000968053937],[114,-0.000006300000222836388,1.1369999647140503,-0.000091200003225822],[115,0,1.1369999647140503,0]]}]},"2082":{"name":"TlkF_stand_gakkari.gmt","root":"center_n","frames":100,"fps":30,"loop":false,"translation":[{"axis":"xyz","keys":[[0,0,1.1369999647140503,0],[1,-0.000010599999768601265,1.137009620666504,-0.00006260000373004004],[2,-0.00004160000025876798,1.1370182037353516,-0.0002533000078983605],[3,-0.00009210000280290842,1.1370257139205933,-0.0005762000218965113],[4,-0.00016120000509545207,1.1370320320129395,-0.0010355999693274498],[5,-0.00024789999588392675,1.1370372772216797,-0.0016357001150026917],[6,-0.0003512999974191189,1.1370415687561035,-0.0023809000849723816],[7,-0.0004704000020865351,1.1370447874069214,-0.0032752000261098146],[8,-0.000604200002271682,1.1370471715927124,-0.004322899971157312],[9,-0.0007519000209867954,1.1370484828948975,-0.005528300069272518],[10,-0.0009123999625444412,1.1370488405227661,-0.006895600352436304],[11,-0.0010847999947145581,1.137048363685608,-0.008429000154137611],[12,-0.0012681999942287803,1.1370469331741333,-0.010132700204849243],[13,-0.0014615999534726143,1.1370446681976318,-0.01201110053807497],[14,-0.0016639999812468886,1.137041449546814,-0.014068200252950191],[15,-0.0018744999542832375,1.1370376348495483,-0.01630840077996254],[16,-0.002092099981382489,1.1370328664779663,-0.01873590052127838],[17,-0.0023159999400377274,1.1370272636413574,-0.021354900673031807],[18,-0.0025451001711189747,1.1370209455490112,-0.024169599637389183],[19,-0.002778500085696578,1.1370140314102173,-0.027184298262000084],[20,-0.0030152001418173313,1.1370062828063965,-0.030403101816773415],[21,-0.003254299983382225,1.1369980573654175,-0.03383050113916397],[22,-0.0034949001856148243,1.1369889974594116,-0.03747040033340454],[23,-0.0037358999252319336,1.1369792222976685,-0.041327301412820816],[24,-0.003976500127464533,1.136968970298767,-0.045405302196741104],[25,-0.004215700086206198,1.136958122253418,-0.04970870167016983],[26,-0.004452399909496307,1.136946678161621,-0.0538766048848629],[27,-0.0046859001740813255,1.136934757232666,-0.05756300315260887],[28,-0.004915100056678057,1.1369222402572632,-0.06079450249671936],[29,-0.00513910036534071,1.1369093656539917,-0.06359760463237762],[30,-0.005356800276786089,1.1368958950042725,-0.06599869579076767],[31,-0.005567499902099371,1.136881947517395,-0.06802430003881454],[32,-0.005770099814981222,1.136867642402649,-0.06970079988241196],[33,-0.005963600240647793,1.1368529796600342,-0.07105489820241928],[34,-0.006147199776023626,1.1368378400802612,-0.07211290299892426],[35,-0.006319799926131964,1.1368224620819092,-0.0729013979434967],[36,-0.006480600219219923,1.1368067264556885,-0.07344680279493332],[37,-0.006628499832004309,1.1367906332015991,-0.07377570122480392],[38,-0.006762600038200617,1.1367743015289307,-0.07391449809074402],[39,-0.006882000248879194,1.136757731437683,-0.0738896057009697],[40,-0.006985700223594904,1.1367409229278564,-0.07372769713401794],[41,-0.007072699721902609,1.1367238759994507,-0.07345510274171829],[42,-0.007142200600355864,1.1367065906524658,-0.07309830188751221],[43,-0.007193099707365036,1.1366891860961914,-0.0726839005947113],[44,-0.0072245001792907715,1.1366716623306274,-0.07223840057849884],[45,-0.007235399913042784,1.136654019355774,-0.07178810238838196],[46,-0.00722500029951334,1.1366362571716309,-0.07135970145463943],[47,-0.00719219958409667,1.1366184949874878,-0.07097949832677841],[48,-0.007135999854654074,1.1366006135940552,-0.0706740990281105],[49,-0.007055699825286865,1.1365827322006226,-0.07046999782323837],[50,-0.00695009995251894,1.1365647315979004,-0.07039359956979752],[51,-0.006827100645750761,1.136548399925232,-0.07032030075788498],[52,-0.006694500334560871,1.1365350484848022,-0.070107601583004],[53,-0.0065517001785337925,1.1365243196487427,-0.06975560635328293],[54,-0.006397999823093414,1.1365164518356323,-0.06926410645246506],[55,-0.006232500076293945,1.136510968208313,-0.06863290071487427],[56,-0.006054500117897987,1.1365078687667847,-0.06786210089921951],[57,-0.005863400176167488,1.1365071535110474,-0.06695150583982468],[58,-0.005658400245010853,1.1365084648132324,-0.06590089946985245],[59,-0.005438800435513258,1.1365119218826294,-0.06471040099859238],[60,-0.005203900393098593,1.1365171670913696,-0.06337980180978775],[61,-0.0049529001116752625,1.1365242004394531,-0.06190890073776245],[62,-0.00468500005081296,1.1365329027175903,-0.06029779836535454],[63,-0.004399700090289116,1.1365430355072021,-0.05854630097746849],[64,-0.004096100106835365,1.136554479598999,-0.056654300540685654],[65,-0.0037734999787062407,1.1365671157836914,-0.054621703922748566],[66,-0.0034311998169869184,1.1365809440612793,-0.05244839936494827],[67,-0.003068499965593219,1.136595606803894,-0.05013430118560791],[68,-0.0026846001856029034,1.1366112232208252,-0.04767930135130882],[69,-0.0022787998896092176,1.1366275548934937,-0.04508329927921295],[70,-0.001850400003604591,1.1366442441940308,-0.042346298694610596],[71,-0.0013987000565975904,1.1366615295410156,-0.039468102157115936],[72,-0.000976799987256527,1.1366790533065796,-0.03644850105047226],[73,-0.0006336999940685928,1.1366968154907227,-0.03328759968280792],[74,-0.00036210002144798636,1.1367145776748657,-0.029985202476382256],[75,-0.00015469999925699085,1.1367322206497192,-0.026541298255324364],[76,-0.000004300000000512227,1.1367496252059937,-0.023076599463820457],[77,0.0000962999984039925,1.136766791343689,-0.019734099507331848],[78,0.00015439999697264284,1.136783242225647,-0.016547000035643578],[79,0.00017719999596010894,1.1367992162704468,-0.013548200018703938],[80,0.000171900013810955,1.1368144750595093,-0.010770999826490879],[81,0.000145800004247576,1.1368287801742554,-0.008248399943113327],[82,0.00010620000830385834,1.136842131614685,-0.006013500038534403],[83,0.00006009999924572185,1.1368541717529297,-0.004099300131201744],[84,0.00001500000053056283,1.1368650197982788,-0.002539099892601371],[85,-0.000021899999410379678,1.1368745565414429,-0.0013658000389114022],[86,-0.00004350000017439015,1.1368836164474487,-0.0006125000072643161],[87,-0.000042499999835854396,1.136893630027771,-0.00031250002211891115],[88,-0.00001160000010713702,1.136904239654541,-0.00025400001322850585],[89,0.000029200002245488577,1.1369152069091797,-0.00020310001855250448],[90,0.00005619999865302816,1.1369264125823975,-0.0001593000051798299],[91,0.00007159999950090423,1.1369374990463257,-0.00012209999840706587],[92,0.00007719999848632142,1.1369483470916748,-0.00009100000170292333],[93,0.00007480000203941017,1.1369587182998657,-0.00006549999670824036],[94,0.00006650000432273373,1.1369683742523193,-0.00004510000144364312],[95,0.00005430000237538479,1.1369770765304565,-0.000029200002245488577],[96,0.00003990000186604448,1.1369848251342773,-0.000017299998944508843],[97,0.00002530000165279489,1.1369911432266235,-0.000009000000318337698],[98,0.000012500000593718141,1.1369959115982056,-0.000003600000127335079],[99,0.0000035000000480067683,1.1369990110397339,-8.000000093488779e-7],[100,0,1.1369999647140503,0]]}]},"2083":{"name":"TlkF_stand_happy.gmt","root":"center_n","frames":105,"fps":30,"loop":false,"translation":[{"axis":"xyz","keys":[[0,0,1.1369999647140503,0],[1,-0.00007400000322377309,1.1370102167129517,-0.0001604999997653067],[2,-0.00026390000130049884,1.1370362043380737,-0.0006248000427149236],[3,-0.0005212000105530024,1.1370714902877808,-0.0013673000503331423],[4,-0.0007977999630384147,1.1371091604232788,-0.00236210017465055],[5,-0.0010451000416651368,1.1371426582336426,-0.003583699930459261],[6,-0.0012148999376222491,1.1371653079986572,-0.0050062998197972775],[7,-0.0012589000398293138,1.1371701955795288,-0.006604299880564213],[8,-0.0011286999797448516,1.137150764465332,-0.00835180003196001],[9,-0.0007759000291116536,1.137100338935852,-0.010223200544714928],[10,-0.000152299995534122,1.1370121240615845,-0.012192799709737301],[11,0.0007905000238679349,1.1368794441223145,-0.01423490047454834],[12,0.002100900048390031,1.1366957426071167,-0.01632380113005638],[13,0.003827099921181798,1.1364541053771973,-0.01843379996716976],[14,0.006016800180077553,1.1361478567123413,-0.02053910121321678],[15,0.008643300272524357,1.1357704401016235,-0.022614100947976112],[16,0.01164340041577816,1.1353150606155396,-0.024633100256323814],[17,0.01495400071144104,1.1347750425338745,-0.02657029964029789],[18,0.018512099981307983,1.134143590927124,-0.028400098904967308],[19,0.022254599258303642,1.1334140300750732,-0.03009670041501522],[20,0.02611829899251461,1.1325796842575073,-0.03163450211286545],[21,0.03004010021686554,1.1316338777542114,-0.032987698912620544],[22,0.03395700082182884,1.1303380727767944,-0.03413059934973717],[23,0.03780579939484596,1.1285232305526733,-0.035037603229284286],[24,0.04152340069413185,1.1262871026992798,-0.0356828011572361],[25,0.04504669830203056,1.1237276792526245,-0.03604070097208023],[26,0.048312701284885406,1.1209425926208496,-0.036085501313209534],[27,0.051278598606586456,1.1180299520492554,-0.03602629899978638],[28,0.05395299941301346,1.1150872707366943,-0.036083001643419266],[29,0.05634940415620804,1.1122125387191772,-0.036246802657842636],[30,0.058481600135564804,1.1095036268234253,-0.036508701741695404],[31,0.06036300212144852,1.1070582866668701,-0.03685959801077843],[32,0.062007397413253784,1.104974389076233,-0.03729049861431122],[33,0.06342830508947372,1.1033496856689453,-0.037792399525642395],[34,0.06463940441608429,1.1022820472717285,-0.03835630044341087],[35,0.0656542032957077,1.1018694639205933,-0.03897320106625557],[36,0.0664864033460617,1.1018251180648804,-0.0396341010928154],[37,0.06714950501918793,1.1017969846725464,-0.04033000022172928],[38,0.06765729933977127,1.1017850637435913,-0.04105190187692642],[39,0.06802330166101456,1.1017886400222778,-0.04179080203175545],[40,0.06826110184192657,1.101807713508606,-0.04253759980201721],[41,0.06838440150022507,1.1018418073654175,-0.04328339919447899],[42,0.06840670108795166,1.1018904447555542,-0.04401920363306999],[43,0.0683417022228241,1.1019537448883057,-0.044735901057720184],[44,0.06820300221443176,1.1020309925079346,-0.045424602925777435],[45,0.06800420582294464,1.1021220684051514,-0.04607610031962395],[46,0.06775890290737152,1.1022266149520874,-0.04668169841170311],[47,0.06748080253601074,1.1023443937301636,-0.04723210260272026],[48,0.06718339771032333,1.1024748086929321,-0.04771850258111954],[49,0.06688030064105988,1.102617859840393,-0.048131801187992096],[50,0.06658520549535751,1.1027730703353882,-0.04846290126442909],[51,0.06631170213222504,1.1029402017593384,-0.04870299994945526],[52,0.06607340276241302,1.103118896484375,-0.04884300008416176],[53,0.06571940332651138,1.1033087968826294,-0.04887770116329193],[54,0.06510099768638611,1.103509783744812,-0.04881010204553604],[55,0.06423509865999222,1.1037211418151855,-0.04864279925823212],[56,0.06313840299844742,1.1039429903030396,-0.048378802835941315],[57,0.061827898025512695,1.1041747331619263,-0.04802099987864494],[58,0.06032050400972366,1.1048357486724854,-0.04757219925522804],[59,0.058632899075746536,1.1062591075897217,-0.047035302966833115],[60,0.05678210407495499,1.1083158254623413,-0.04641300067305565],[61,0.054784901440143585,1.1108766794204712,-0.04570839926600456],[62,0.05265820026397705,1.1138125658035278,-0.04492419958114624],[63,0.05041880160570145,1.1169942617416382,-0.04406319931149483],[64,0.0480835996568203,1.1202927827835083,-0.04312850162386894],[65,0.04566949978470802,1.1235787868499756,-0.04212270304560661],[66,0.04319320246577263,1.1267231702804565,-0.0410488024353981],[67,0.04067179933190346,1.1295968294143677,-0.03990960121154785],[68,0.03812200203537941,1.1320704221725464,-0.038708001375198364],[69,0.03556070104241371,1.1340150833129883,-0.037446800619363785],[70,0.03300480172038078,1.1354602575302124,-0.036128900945186615],[71,0.03047110140323639,1.1365548372268677,-0.03475720062851906],[72,0.02797650173306465,1.1373480558395386,-0.03333450108766556],[73,0.025537801906466484,1.1378896236419678,-0.03186360001564026],[74,0.02317200042307377,1.1382287740707397,-0.03034749999642372],[75,0.02089579962193966,1.1384152173995972,-0.02878899872303009],[76,0.018726101145148277,1.1384984254837036,-0.02719089947640896],[77,0.016679799184203148,1.138527750968933,-0.02555600181221962],[78,0.014773800037801266,1.1385529041290283,-0.023887401446700096],[79,0.013017299585044384,1.1385831832885742,-0.022216999903321266],[80,0.011404300108551979,1.1385960578918457,-0.02058030106127262],[81,0.009928800165653229,1.138593077659607,-0.01898529939353466],[82,0.008584599941968918,1.1385750770568848,-0.017439700663089752],[83,0.007365699857473373,1.1385436058044434,-0.015951400622725487],[84,0.006266199983656406,1.1384998559951782,-0.014528400264680386],[85,0.005279799923300743,1.1384451389312744,-0.013178400695323944],[86,0.004400600213557482,1.138380765914917,-0.011909499764442444],[87,0.00362249999307096,1.138307809829712,-0.01072940044105053],[88,0.002939400030300021,1.1382277011871338,-0.00964600034058094],[89,0.0023453999310731888,1.1381418704986572,-0.008667300455272198],[90,0.0018341999966651201,1.138051152229309,-0.007801000028848648],[91,0.0014000000664964318,1.137957215309143,-0.006998300086706877],[92,0.0010364999761804938,1.1378611326217651,-0.006209000013768673],[93,0.0007377999718300998,1.13776433467865,-0.0054395003244280815],[94,0.0004978000069968402,1.1376678943634033,-0.004695900250226259],[95,0.0003105000068899244,1.1375731229782104,-0.0039842999540269375],[96,0.00016969999705906957,1.137481451034546,-0.003311099950224161],[97,0.00006949999806238338,1.137393832206726,-0.0026823999360203743],[98,0.0000037000002066633897,1.1373119354248047,-0.002104399958625436],[99,-0.00003360000118846074,1.1372368335723877,-0.0015832999488338828],[100,-0.00004860000262851827,1.1371697187423706,-0.0011253999546170235],[101,-0.00004720000288216397,1.137112021446228,-0.0007368000224232674],[102,-0.000035700002626981586,1.1370649337768555,-0.00042380002560094],[103,-0.00001990000055229757,1.1370295286178589,-0.00019249999604653567],[104,-0.000005999999757477781,1.1370075941085815,-0.000049200003559235483],[105,0,1.1369999647140503,0]]}]},"2090":{"name":"TlkF_stand_think.gmt","root":"center_n","frames":95,"fps":30,"loop":false,"translation":[{"axis":"xyz","keys":[[0,0,1.1369999647140503,0],[1,-0.000017899999875226058,1.1370185613632202,0],[2,-0.00007020000339252874,1.137069582939148,0],[3,-0.00015490000077988952,1.1371461153030396,0],[4,-0.00026980001712217927,1.137241244316101,0],[5,-0.00041290000081062317,1.13734769821167,0],[6,-0.000582000007852912,1.1374588012695312,0],[7,-0.0007752000237815082,1.1375675201416016,0],[8,-0.000990200089290738,1.1376667022705078,0],[9,-0.0012252000160515308,1.1377495527267456,0],[10,-0.0014778000768274069,1.1378090381622314,0],[11,-0.0017461000243201852,1.1378380060195923,0],[12,-0.0020280000753700733,1.1378296613693237,0],[13,-0.0023213999811559916,1.1377769708633423,0],[14,-0.0026241999585181475,1.137673020362854,0],[15,-0.0029343999922275543,1.1375106573104858,0],[16,-0.003249799832701683,1.1372830867767334,0],[17,-0.003568299813196063,1.1369831562042236,0],[18,-0.0038880002684891224,1.1365634202957153,0],[19,-0.00420660013332963,1.1359965801239014,0],[20,-0.00452210009098053,1.1353062391281128,0],[21,-0.004832500126212835,1.1345160007476807,0],[22,-0.005135599989444017,1.1336497068405151,0],[23,-0.005429400131106377,1.1327306032180786,0],[24,-0.005711799953132868,1.1317824125289917,0],[25,-0.0059806001372635365,1.1308287382125854,0],[26,-0.00623390031978488,1.129893183708191,0],[27,-0.0064695002511143684,1.1289993524551392,0],[28,-0.006685300264507532,1.1281708478927612,0],[29,-0.006879299879074097,1.1274312734603882,0],[30,-0.007049299776554108,1.1268041133880615,0],[31,-0.0071934000588953495,1.1263130903244019,0],[32,-0.007309400476515293,1.1259816884994507,0],[33,-0.007395199965685606,1.1258337497711182,0],[34,-0.0074487002566456795,1.1258161067962646,0],[35,-0.007467900402843952,1.1258575916290283,0],[36,-0.007450600154697895,1.125954270362854,0],[37,-0.00739490007981658,1.126102328300476,0],[38,-0.007298599928617477,1.1262977123260498,0],[39,-0.00715959956869483,1.12653648853302,0],[40,-0.006975799798965454,1.126814842224121,0],[41,-0.006745200138539076,1.1271288394927979,0],[42,-0.006465599872171879,1.1274745464324951,0],[43,-0.006135100033134222,1.1278479099273682,0],[44,-0.005751400254666805,1.128245234489441,0],[45,-0.005312600173056126,1.1286624670028687,0],[46,-0.004816500004380941,1.1290955543518066,0],[47,-0.004261000081896782,1.1295409202575684,0],[48,-0.0036660998594015837,1.1299943923950195,0],[49,-0.00305499997921288,1.130452036857605,0],[50,-0.002431500004604459,1.1309101581573486,0],[51,-0.0017991000786423683,1.1313645839691162,0],[52,-0.0011612999951466918,1.131811499595642,0],[53,-0.0005216000135987997,1.1322468519210815,0],[54,0.00011640000593615696,1.1326669454574585,0],[55,0.0007492000004276633,1.1330678462982178,0],[56,0.001373099978081882,1.1334455013275146,0],[57,0.0019847999792546034,1.1337960958480835,0],[58,0.0025804999750107527,1.13411545753479,0],[59,0.0031569001730531454,1.1344000101089478,0],[60,0.0037103001959621906,1.1346455812454224,0],[61,0.004237200133502483,1.1348484754562378,0],[62,0.004733999725431204,1.1350234746932983,0],[63,0.005197300110012293,1.1351889371871948,0],[64,0.005623399745672941,1.1353448629379272,0],[65,0.006008900236338377,1.1354916095733643,0],[66,0.006350100040435791,1.1356295347213745,0],[67,0.006643600296229124,1.135758638381958,0],[68,0.006885699927806854,1.135879397392273,0],[69,0.007073000073432922,1.1359922885894775,0],[70,0.007201900240033865,1.1360973119735718,0],[71,0.0072688995860517025,1.1361947059631348,0],[72,0.007270299829542637,1.1362849473953247,0],[73,0.007202800363302231,1.1363681554794312,0],[74,0.007065400015562773,1.1364446878433228,0],[75,0.006864400114864111,1.1365149021148682,0],[76,0.006606500130146742,1.136578917503357,0],[77,0.006298600230365992,1.1366370916366577,0],[78,0.005947500001639128,1.1366896629333496,0],[79,0.005560100078582764,1.1367369890213013,0],[80,0.005143200047314167,1.1367791891098022,0],[81,0.004703700076788664,1.1368167400360107,0],[82,0.004248300101608038,1.1368497610092163,0],[83,0.003784000175073743,1.1368787288665771,0],[84,0.0033174999989569187,1.1369036436080933,0],[85,0.002855700207874179,1.1369251012802124,0],[86,0.0024054001551121473,1.1369431018829346,0],[87,0.00197350000962615,1.1369580030441284,0],[88,0.001566799939610064,1.136970043182373,0],[89,0.001192099996842444,1.1369796991348267,0],[90,0.0008564000017940998,1.1369870901107788,0],[91,0.0005663000047206879,1.1369924545288086,0],[92,0.0003288000007160008,1.1369961500167847,0],[93,0.00015069999790284783,1.1369985342025757,0],[94,0.000038800000766059384,1.1369997262954712,0],[95,0,1.1369999647140503,0]]}]},"2129":{"name":"TlkM_stand_angry.gmt","root":"center_n","frames":90,"fps":30,"loop":false,"translation":[{"axis":"xyz","keys":[[0,0,1.125,0],[1,0.0004296999832149595,1.1250593662261963,0.0004133000038564205],[2,0.0015625000232830644,1.12521231174469,0.001626499928534031],[3,0.003164099995046854,1.125421404838562,0.003599099814891815],[4,0.005000000353902578,1.125649333000183,0.006290900055319071],[5,0.006835900247097015,1.1258586645126343,0.009661400690674782],[6,0.008437500335276127,1.1260117292404175,0.013670300133526325],[7,0.00957029964774847,1.1260713338851929,0.018277401104569435],[8,0.010000000707805157,1.1260000467300415,0.023442300036549568],[9,0.009976799599826336,1.1255563497543335,0.02912450209259987],[10,0.009778200648725033,1.124585509300232,0.035283900797367096],[11,0.009210900403559208,1.1231794357299805,0.04188000038266182],[12,0.008081399835646152,1.1214300394058228,0.04887260124087334],[13,0.006196300033479929,1.1194294691085815,0.05622119829058647],[14,0.0033620998729020357,1.1172693967819214,0.06388550251722336],[15,-0.0006145000224933028,1.1150420904159546,0.07182519882917404],[16,-0.005926999729126692,1.1128394603729248,0.08000000566244125],[17,-0.0127687007188797,1.1107534170150757,0.0889401063323021],[18,-0.021333200857043266,1.10887610912323,0.09905390441417694],[19,-0.03181380033493042,1.1072992086410522,0.11011810600757599],[20,-0.043472401797771454,1.1055315732955933,0.12190959602594376],[21,-0.05511019751429558,1.1037131547927856,0.13420520722866058],[22,-0.06622970104217529,1.1028841733932495,0.14678169786930084],[23,-0.07633339613676071,1.1032527685165405,0.15941590070724487],[24,-0.08492349833250046,1.1039999723434448,0.17188450694084167],[25,-0.09161119908094406,1.1047602891921997,0.18356700241565704],[26,-0.09651099890470505,1.1055020093917847,0.19401079416275024],[27,-0.09988000243902206,1.1062246561050415,0.20324459671974182],[28,-0.10197559744119644,1.1069279909133911,0.21129710972309113],[29,-0.10305509716272354,1.1076114177703857,0.21819689869880676],[30,-0.10337580740451813,1.1082745790481567,0.22397290170192719],[31,-0.10319500416517258,1.1089171171188354,0.22865378856658936],[32,-0.10277010500431061,1.1095384359359741,0.23226819932460785],[33,-0.10235830396413803,1.1101382970809937,0.23484490811824799],[34,-0.10221689939498901,1.1107161045074463,0.23641259968280792],[35,-0.10224349796772003,1.1112713813781738,0.2369999885559082],[36,-0.1021639034152031,1.1118038892745972,0.23710580170154572],[37,-0.10197770595550537,1.112313151359558,0.23719549179077148],[38,-0.10168459266424179,1.1127985715866089,0.2372479885816574],[39,-0.10128410160541534,1.1132597923278809,0.23724238574504852],[40,-0.10077600926160812,1.1136964559555054,0.23715761303901672],[41,-0.1001598984003067,1.1141080856323242,0.2369726002216339],[42,-0.09943550080060959,1.1144943237304688,0.23666639626026154],[43,-0.09860240668058395,1.1148545742034912,0.23621800541877747],[44,-0.09766020625829697,1.115188479423523,0.23560619354248047],[45,-0.09660860151052475,1.1154956817626953,0.2348102182149887],[46,-0.09544730186462402,1.11577570438385,0.23380880057811737],[47,-0.09417589753866196,1.116028070449829,0.23258109390735626],[48,-0.09279400110244751,1.1162523031234741,0.2311059981584549],[49,-0.09130140393972397,1.1164480447769165,0.2293626070022583],[50,-0.08969759941101074,1.1166149377822876,0.22732971608638763],[51,-0.08798230439424515,1.1167523860931396,0.22498641908168793],[52,-0.086148701608181,1.1168601512908936,0.22231172025203705],[53,-0.0841641053557396,1.116937518119812,0.21928440034389496],[54,-0.0820332020521164,1.116984248161316,0.21588371694087982],[55,-0.07976710051298141,1.1169999837875366,0.21208839118480682],[56,-0.0773765966296196,1.1168590784072876,0.20787759125232697],[57,-0.07487250119447708,1.116459608078003,0.20323018729686737],[58,-0.07226600497961044,1.1158359050750732,0.1981251984834671],[59,-0.06956770271062851,1.1150223016738892,0.19254159927368164],[60,-0.06678880006074905,1.11405348777771,0.1864583045244217],[61,-0.06394000351428986,1.1129639148712158,0.1798544079065323],[62,-0.06103220209479332,1.1117879152297974,0.1728219985961914],[63,-0.05807650089263916,1.1105600595474243,0.16549371182918549],[64,-0.05508369952440262,1.1093149185180664,0.15790900588035583],[65,-0.052064698189496994,1.1080868244171143,0.15010730922222137],[66,-0.049030400812625885,1.1069103479385376,0.14212800562381744],[67,-0.04599180072546005,1.1058199405670166,0.13401080667972565],[68,-0.042959701269865036,1.104849934577942,0.12579499185085297],[69,-0.039945099502801895,1.1040350198745728,0.11752010881900787],[70,-0.03695889934897423,1.1034096479415894,0.10922559350728989],[71,-0.034012001007795334,1.1030081510543823,0.10095089673995972],[72,-0.031115202233195305,1.1028650999069214,0.09273549914360046],[73,-0.028279701247811317,1.103060245513916,0.08461900055408478],[74,-0.025516098365187645,1.1036204099655151,0.07664070278406143],[75,-0.02283550053834915,1.1044996976852417,0.06884010136127472],[76,-0.02024870179593563,1.1056526899337769,0.06125680357217789],[77,-0.01776670105755329,1.1070338487625122,0.05393010005354881],[78,-0.015400399453938007,1.1085975170135498,0.046899598091840744],[79,-0.013160699978470802,1.1102979183197021,0.04020470008254051],[80,-0.011058500036597252,1.11208975315094,0.03388490155339241],[81,-0.009104699827730656,1.1139272451400757,0.027979601174592972],[82,-0.0073102000169456005,1.115764856338501,0.022528300061821938],[83,-0.0056859999895095825,1.1175569295883179,0.017570599913597107],[84,-0.004242900293320417,1.119258165359497,0.01314579974859953],[85,-0.0029920001979917288,1.1208226680755615,0.00929350033402443],[86,-0.0019440001342445612,1.1222050189971924,0.00605310034006834],[87,-0.0011098000686615705,1.1233594417572021,0.003464100183919072],[88,-0.0005005000275559723,1.124240517616272,0.0015659000491723418],[89,-0.00012700000661425292,1.1248024702072144,0.00039809997542761266],[90,0,1.125,0]]}]},"2130":{"name":"TlkM_stand_ase.gmt","root":"center_n","frames":114,"fps":30,"loop":false,"translation":[{"axis":"xyz","keys":[[0,0,1.125,0],[1,0.000007300000561372144,1.1250250339508057,-0.000021300000298651867],[2,0.00003060000017285347,1.125096321105957,-0.00008370000432478264],[3,0.00007239999831654131,1.1252087354660034,-0.00018489999638404697],[4,0.00013500000932253897,1.1253572702407837,-0.00032259998260997236],[5,0.0002207000070484355,1.125536322593689,-0.0004943999811075628],[6,0.0003319999959785491,1.125740885734558,-0.0006982000195421278],[7,0.00047129997983574867,1.1259657144546509,-0.0009317000512965024],[8,0.0006407000473700464,1.1262054443359375,-0.0011924001155421138],[9,0.0008428000146523118,1.1264550685882568,-0.0014782000798732042],[10,0.0010799000738188624,1.1267091035842896,-0.0017867001006379724],[11,0.0013543999521061778,1.1269625425338745,-0.0021156000439077616],[12,0.0016686000162735581,1.1272099018096924,-0.0024627000093460083],[13,0.0020248000510036945,1.1274460554122925,-0.002825699979439378],[14,0.0024256000760942698,1.1276658773422241,-0.003202199935913086],[15,0.00287310010753572,1.1278642416000366,-0.00358989997766912],[16,0.0035085000563412905,1.1280354261398315,-0.003986699972301722],[17,0.004436099901795387,1.1281746625900269,-0.004613700322806835],[18,0.005603100173175335,1.1282765865325928,-0.005648400168865919],[19,0.006956800352782011,1.1283358335494995,-0.007022699806839228],[20,0.008444400504231453,1.1283587217330933,-0.008668600581586361],[21,0.010013200342655182,1.128358006477356,-0.01051810011267662],[22,0.011610300280153751,1.1283377408981323,-0.012502999976277351],[23,0.013183101080358028,1.1283020973205566,-0.014555401168763638],[24,0.01467870082706213,1.1282553672790527,-0.016607100144028664],[25,0.01604440063238144,1.1282018423080444,-0.018590200692415237],[26,0.017227400094270706,1.1281455755233765,-0.020436501130461693],[27,0.018175000324845314,1.1280909776687622,-0.022078100591897964],[28,0.018834400922060013,1.128042221069336,-0.02344680018723011],[29,0.019152900204062462,1.128003478050232,-0.024474700912833214],[30,0.01917560026049614,1.1279789209365845,-0.025093600153923035],[31,0.01899300143122673,1.1279728412628174,-0.025235598906874657],[32,0.01862020045518875,1.128000259399414,-0.02508229948580265],[33,0.018072200939059258,1.1280637979507446,-0.024862801656126976],[34,0.01736379973590374,1.1281492710113525,-0.024580100551247597],[35,0.01651020161807537,1.1282421350479126,-0.024237200617790222],[36,0.015526301227509975,1.1283283233642578,-0.023837100714445114],[37,0.01442710030823946,1.1283934116363525,-0.023382799699902534],[38,0.013227599672973156,1.1284230947494507,-0.022877199575304985],[39,0.011942899785935879,1.1283873319625854,-0.022323301061987877],[40,0.010587899945676327,1.1282926797866821,-0.021724199876189232],[41,0.009177600033581257,1.1281794309616089,-0.02108290046453476],[42,0.007727000396698713,1.1280884742736816,-0.020402301102876663],[43,0.006251099985092878,1.128060221672058,-0.019685400649905205],[44,0.004764900077134371,1.1280927658081055,-0.018935201689600945],[45,0.003283499972894788,1.1281524896621704,-0.018154799938201904],[46,0.001821699901483953,1.1282315254211426,-0.017347000539302826],[47,0.0003947000077459961,1.1283220052719116,-0.01651490107178688],[48,-0.0009826000314205885,1.1284164190292358,-0.01566160097718239],[49,-0.00229530013166368,1.1285064220428467,-0.01478980015963316],[50,-0.003528200089931488,1.1285847425460815,-0.013902800157666206],[51,-0.004666400142014027,1.12864351272583,-0.013003400526940823],[52,-0.005694900173693895,1.1286749839782715,-0.012094700708985329],[53,-0.006598799955099821,1.1286711692810059,-0.011179599910974503],[54,-0.007362899836152792,1.1286424398422241,-0.010261200368404388],[55,-0.007972300052642822,1.1286042928695679,-0.009342300705611706],[56,-0.008412099443376064,1.1285579204559326,-0.008426100015640259],[57,-0.008755000308156013,1.1285040378570557,-0.007515499833971262],[58,-0.009077399969100952,1.1284435987472534,-0.00661360053345561],[59,-0.009368999861180782,1.1283774375915527,-0.005723200272768736],[60,-0.009619600139558315,1.1283066272735596,-0.004847399890422821],[61,-0.009819299913942814,1.1282318830490112,-0.003989099990576506],[62,-0.009957700036466122,1.1281542778015137,-0.0031514998991042376],[63,-0.010024799965322018,1.1280746459960938,-0.0023374001029878855],[64,-0.010010399855673313,1.1279938220977783,-0.0015499000437557697],[65,-0.009904400445520878,1.1279127597808838,-0.0007919000345282257],[66,-0.009696600027382374,1.127832293510437,-0.00006640000356128439],[67,-0.00937699992209673,1.1277533769607544,0.0006235000328160822],[68,-0.008935300633311272,1.1276768445968628,0.0012749000452458858],[69,-0.008361400105059147,1.1276037693023682,0.0018847000319510698],[70,-0.007645100355148315,1.1275348663330078,0.002450099913403392],[71,-0.006776399910449982,1.1274710893630981,0.002938800025731325],[72,-0.0057450998574495316,1.1274133920669556,0.00332759995944798],[73,-0.00454110000282526,1.127362608909607,0.003626599907875061],[74,-0.0031785001046955585,1.1273196935653687,0.003846100065857172],[75,-0.0016912000719457865,1.1272854804992676,0.003996200393885374],[76,-0.00009770000178832561,1.1272610425949097,0.0040871999226510525],[77,0.0015830000629648566,1.1272468566894531,0.004129200242459774],[78,0.0033321999944746494,1.1272519826889038,0.004132600035518408],[79,0.0051310001872479916,1.127281904220581,0.004107400309294462],[80,0.006960699800401926,1.1273332834243774,0.004063900094479322],[81,0.008802500553429127,1.127402663230896,0.004012300167232752],[82,0.010637599974870682,1.1274869441986084,0.003962799906730652],[83,0.012447100132703781,1.1275824308395386,0.003925600089132786],[84,0.014212300069630146,1.1276859045028687,0.003911000210791826],[85,0.015914401039481163,1.1277939081192017,0.003898200113326311],[86,0.017534499987959862,1.1279032230377197,0.003861099947243929],[87,0.019053900614380836,1.1280102729797363,0.003801500191912055],[88,0.02045380137860775,1.1281118392944336,0.0037209000438451767],[89,0.021715400740504265,1.128204584121704,0.003621299983933568],[90,0.022819800302386284,1.1282848119735718,0.003504199907183647],[91,0.023748399689793587,1.1283496618270874,0.0033714999444782734],[92,0.024482199922204018,1.1283975839614868,0.0032248999923467636],[93,0.02500239945948124,1.1284316778182983,0.003066200064495206],[94,0.02529039978981018,1.1284542083740234,0.002896999940276146],[95,0.025327300652861595,1.1284674406051636,0.002719100099056959],[96,0.025094199925661087,1.1284736394882202,0.0025343000888824463],[97,0.024572400376200676,1.1284751892089844,0.002344300039112568],[98,0.023731699213385582,1.128474473953247,0.002150700194761157],[99,0.022585099563002586,1.1284736394882202,0.001955500105395913],[100,0.021178700029850006,1.1284294128417969,0.0017602000152692199],[101,0.01955850049853325,1.1283048391342163,0.0015667000552639365],[102,0.01777060143649578,1.1281124353408813,0.0013767000054940581],[103,0.01586109958589077,1.1278643608093262,0.001191799994558096],[104,0.013876000419259071,1.127573013305664,0.0010140000376850367],[105,0.011861300095915794,1.1272510290145874,0.0008448000298812985],[106,0.009863200597465038,1.1269102096557617,0.0006860000430606306],[107,0.007927699945867062,1.1265634298324585,0.0005394000327214599],[108,0.006100700236856937,1.1262227296829224,0.0004067000118084252],[109,0.004428499843925238,1.1259006261825562,0.0002896999940276146],[110,0.002957100048661232,1.125609278678894,0.0001900000061141327],[111,0.0017324000364169478,1.1253613233566284,0.00010949999705189839],[112,0.0008007000433281064,1.125168800354004,0.00004980000085197389],[113,0.0002077999961329624,1.125044345855713,0.000012700001207122114],[114,0,1.125,0]]}]},"2135":{"name":"TlkM_stand_gakkari.gmt","root":"center_n","frames":120,"fps":30,"loop":false,"translation":[{"axis":"xyz","keys":[[0,0,1.125,0],[1,0.00014050000754650682,1.1250344514846802,0.0004676000389736146],[2,0.0005177000421099365,1.1251319646835327,0.0016923999646678567],[3,0.0010648000752553344,1.1252845525741577,0.0034076999872922897],[4,0.0017154001398012042,1.1254838705062866,0.005346500314772129],[5,0.002402799902483821,1.1257213354110718,0.007242000196129084],[6,0.0030604000203311443,1.1259888410568237,0.008827300742268562],[7,0.003621599869802594,1.1262781620025635,0.009835599921643734],[8,0.00401980010792613,1.1265807151794434,0.010000000707805157],[9,0.004188400227576494,1.126888632774353,0.008990700356662273],[10,0.004060800187289715,1.1271932125091553,0.0067888000048696995],[11,0.003716199891641736,1.1274863481521606,0.003593999892473221],[12,0.0032839998602867126,1.1277596950531006,-0.0003942000330425799],[13,0.002773100044578314,1.1280049085617065,-0.0049761999398469925],[14,0.0021921999286860228,1.1282137632369995,-0.009952300228178501],[15,0.0015502999303862453,1.1283777952194214,-0.015123001299798489],[16,0.0008559999987483025,1.1284888982772827,-0.020288599655032158],[17,0.00011830000585177913,1.1285736560821533,-0.025249699130654335],[18,-0.0006540000322274864,1.128662347793579,-0.029806599020957947],[19,-0.001452099997550249,1.1287524700164795,-0.033759601414203644],[20,-0.002267200034111738,1.128841757774353,-0.036909300833940506],[21,-0.003090500133112073,1.1289275884628296,-0.039055898785591125],[22,-0.003913100343197584,1.1290076971054077,-0.04000000283122063],[23,-0.00472630001604557,1.1290794610977173,-0.04019949957728386],[24,-0.005521200131624937,1.1291406154632568,-0.040256302803754807],[25,-0.006288900505751371,1.1291884183883667,-0.040186598896980286],[26,-0.007020700257271528,1.129220724105835,-0.040006302297115326],[27,-0.007707800250500441,1.1292349100112915,-0.0397316999733448],[28,-0.008341199718415737,1.1292284727096558,-0.039378803223371506],[29,-0.008869600482285023,1.1291989088058472,-0.03896380215883255],[30,-0.009258899837732315,1.1291477680206299,-0.03850270062685013],[31,-0.009526900015771389,1.1290792226791382,-0.03801169991493225],[32,-0.009690999984741211,1.1289976835250854,-0.03750690072774887],[33,-0.009768900461494923,1.1289070844650269,-0.03700430318713188],[34,-0.009778100065886974,1.1288119554519653,-0.036520201712846756],[35,-0.009736199863255024,1.1287163496017456,-0.036070600152015686],[36,-0.009660899639129639,1.1286245584487915,-0.03567160293459892],[37,-0.009569699876010418,1.1285407543182373,-0.03533940017223358],[38,-0.00948019977658987,1.1284691095352173,-0.03508999943733215],[39,-0.009410000406205654,1.1284140348434448,-0.03493950143456459],[40,-0.009354200214147568,1.128379464149475,-0.034904200583696365],[41,-0.00929659977555275,1.1283609867095947,-0.03500000014901161],[42,-0.009237500838935375,1.1283503770828247,-0.03518659994006157],[43,-0.009177000261843204,1.1283471584320068,-0.035411201417446136],[44,-0.009115300141274929,1.1283503770828247,-0.03567120060324669],[45,-0.009052900597453117,1.1283595561981201,-0.03596379980444908],[46,-0.008989900350570679,1.1283737421035767,-0.036286499351263046],[47,-0.008926600217819214,1.1283923387527466,-0.0366366021335125],[48,-0.008863200433552265,1.1284146308898926,-0.03701160103082657],[49,-0.008799999952316284,1.128440022468567,-0.037408702075481415],[50,-0.008737199939787388,1.1284675598144531,-0.03782530128955841],[51,-0.008675100281834602,1.128496766090393,-0.03825890272855759],[52,-0.00861399993300438,1.1285266876220703,-0.0387067012488842],[53,-0.008554100058972836,1.1285568475723267,-0.039166200906038284],[54,-0.008495700545608997,1.1285864114761353,-0.03963470086455345],[55,-0.008438999764621258,1.1286146640777588,-0.040109600871801376],[56,-0.008382200263440609,1.1286420822143555,-0.04058830067515373],[57,-0.008323700167238712,1.1286693811416626,-0.041067998856306076],[58,-0.008263500407338142,1.1286965608596802,-0.0415463000535965],[59,-0.008201800286769867,1.12872314453125,-0.04202040284872055],[60,-0.008138700388371944,1.1287492513656616,-0.042487699538469315],[61,-0.008074499666690826,1.1287744045257568,-0.04294560104608536],[62,-0.008009299635887146,1.128798484802246,-0.043391499668359756],[63,-0.007943300530314445,1.1288212537765503,-0.04382270202040672],[64,-0.00787660013884306,1.1288427114486694,-0.044236600399017334],[65,-0.007809400092810392,1.1288626194000244,-0.04463059827685356],[66,-0.007741800043731928,1.128880500793457,-0.04500199854373932],[67,-0.007673999760299921,1.1288964748382568,-0.04534820094704628],[68,-0.007606200408190489,1.1289100646972656,-0.04566660150885582],[69,-0.007538600359112024,1.128921389579773,-0.04595459997653961],[70,-0.007471200078725815,1.1289299726486206,-0.04620940238237381],[71,-0.007404399570077658,1.1289358139038086,-0.04642849788069725],[72,-0.007338100112974644,1.1289385557174683,-0.0466093011200428],[73,-0.007272700313478708,1.12893807888031,-0.04674910008907318],[74,-0.007208199705928564,1.1289342641830444,-0.0468452014029026],[75,-0.007144799921661615,1.1289267539978027,-0.0468950979411602],[76,-0.00708270026370883,1.1289154291152954,-0.04689620062708855],[77,-0.0070220003835856915,1.128900170326233,-0.0468457005918026],[78,-0.006962999701499939,1.128880500793457,-0.04674110189080238],[79,-0.006905700545758009,1.1288565397262573,-0.04657969996333122],[80,-0.006837000139057636,1.1288279294967651,-0.046358902007341385],[81,-0.0067446003668010235,1.128794550895691,-0.04607610031962395],[82,-0.006630100309848785,1.1287553310394287,-0.04561090096831322],[83,-0.006495200097560883,1.128706693649292,-0.044860802590847015],[84,-0.006341499742120504,1.128644585609436,-0.0438494011759758],[85,-0.006170700304210186,1.1285655498504639,-0.042600199580192566],[86,-0.005984200164675713,1.1284656524658203,-0.041137002408504486],[87,-0.005783800035715103,1.1283410787582397,-0.03948340192437172],[88,-0.005571100395172834,1.128187894821167,-0.03766309842467308],[89,-0.005347799975425005,1.1280077695846558,-0.03569970279932022],[90,-0.005115299951285124,1.1278070211410522,-0.03361690044403076],[91,-0.004875400103628635,1.1275891065597534,-0.031438302248716354],[92,-0.004629699978977442,1.1273568868637085,-0.029187599197030067],[93,-0.004379900172352791,1.127113938331604,-0.026888400316238403],[94,-0.004127399995923042,1.1268634796142578,-0.02456440031528473],[95,-0.003874000161886215,1.1266087293624878,-0.02223930135369301],[96,-0.003621299983933568,1.1263530254364014,-0.01993670128285885],[97,-0.003370900172740221,1.1260994672775269,-0.017680199816823006],[98,-0.0031244000419974327,1.1258515119552612,-0.015493600629270077],[99,-0.002883500186726451,1.1256123781204224,-0.013400400057435036],[100,-0.0026497000362724066,1.1253854036331177,-0.011424300260841846],[101,-0.002424800070002675,1.1251736879348755,-0.009589000605046749],[102,-0.0022103001829236746,1.1249805688858032,-0.007918099872767925],[103,-0.0020077999215573072,1.1248095035552979,-0.0064352997578680515],[104,-0.0018189999973401427,1.1246633529663086,-0.005164199974387884],[105,-0.001645500073209405,1.1245458126068115,-0.004128600005060434],[106,-0.0014890000456944108,1.124459981918335,-0.003351900028064847],[107,-0.0013510000426322222,1.1244090795516968,-0.002858000108972192],[108,-0.0012190000852569938,1.1243914365768433,-0.0026704000774770975],[109,-0.0010812999680638313,1.1244004964828491,-0.0025955999735742807],[110,-0.0009408000041730702,1.1244314908981323,-0.002435800153762102],[111,-0.0008001999813131988,1.1244804859161377,-0.0022084000520408154],[112,-0.0006624000379815698,1.1245428323745728,-0.0019309999188408256],[113,-0.0005303000216372311,1.1246142387390137,-0.0016208001179620624],[114,-0.0004065000102855265,1.1246904134750366,-0.001295400084927678],[115,-0.00029409999842755497,1.1247667074203491,-0.0009723000111989677],[116,-0.00019580000662244856,1.1248390674591064,-0.0006688000285066664],[117,-0.00011439999798312783,1.1249029636383057,-0.0004023000074084848],[118,-0.00005270000110613182,1.1249539852142334,-0.00019039999460801482],[119,-0.000013600000784208532,1.1249878406524658,-0.00005050000254414044],[120,0,1.125,0]]}]},"2136":{"name":"TlkM_stand_happy.gmt","root":"center_n","frames":96,"fps":30,"loop":false,"translation":[{"axis":"xyz","keys":[[0,0,1.125,0],[1,0.00016480000340379775,1.1234101057052612,0.0003530000103637576],[2,0.000632600043900311,1.1192187070846558,0.0012996000004932284],[3,0.0013637000229209661,1.1132930517196655,0.002671099966391921],[4,0.0023183999583125114,1.1065000295639038,0.004298900254070759],[5,0.0034568000119179487,1.099707007408142,0.0060143000446259975],[6,0.004739399999380112,1.0937813520431519,0.007648699916899204],[7,0.0061262003146111965,1.0895899534225464,0.009033500216901302],[8,0.007577700074762106,1.0880000591278076,0.010000000707805157],[9,0.009054000489413738,1.0889472961425781,0.010720400139689445],[10,0.01051540020853281,1.0914944410324097,0.011461599729955196],[11,0.011922100558876991,1.0951985120773315,0.012196900323033333],[12,0.013234500773251057,1.0996174812316895,0.012899800203740597],[13,0.014412700198590755,1.1043087244033813,0.01354339998215437],[14,0.015417100861668587,1.1088298559188843,0.014101299457252026],[15,0.016207799315452576,1.1127381324768066,0.014546799473464489],[16,0.016745099797844887,1.1155914068222046,0.014853200875222683],[17,0.01698940061032772,1.116947054862976,0.014993800781667233],[18,0.01677270047366619,1.1157331466674805,0.014344200491905212],[19,0.015800800174474716,1.1106098890304565,0.011656700633466244],[20,0.014132901094853878,1.1023074388504028,0.00730519974604249],[21,0.011844100430607796,1.0916385650634766,0.0017347000539302826],[22,0.009009099565446377,1.0794166326522827,-0.004609699826687574],[23,0.005702800117433071,1.066454529762268,-0.01128270011395216],[24,0.0020000000949949026,1.0535653829574585,-0.017839400097727776],[25,0.0012016999535262585,1.0415623188018799,-0.023834599182009697],[26,0.0005592000088654459,1.0312583446502686,-0.02882320061326027],[27,0.000055599997722310945,1.0234664678573608,-0.03235999867320061],[28,-0.0003259000077378005,1.0189999341964722,-0.03400000184774399],[29,-0.000602399988565594,1.0166248083114624,-0.034529101103544235],[30,-0.0007906000246293843,1.0145516395568848,-0.03502989932894707],[31,-0.0009076000424101949,1.0127602815628052,-0.03550199791789055],[32,-0.0009701999952085316,1.0112305879592896,-0.03594540059566498],[33,-0.0009954000124707818,1.0099424123764038,-0.03635979816317558],[34,-0.0010000000474974513,1.0088753700256348,-0.036744799464941025],[35,-0.0009992000414058566,1.008009672164917,-0.037100400775671005],[36,-0.0009969000238925219,1.0073250532150269,-0.03742630034685135],[37,-0.0009931999957188964,1.0068011283874512,-0.03772220015525818],[38,-0.000988100073300302,1.0064181089401245,-0.037988003343343735],[39,-0.0009815000230446458,1.0061553716659546,-0.038223300129175186],[40,-0.0009737000218592584,1.0059932470321655,-0.03842800110578537],[41,-0.0009646000689826906,1.0059114694595337,-0.03860180079936981],[42,-0.0009542999905534089,1.0058895349502563,-0.038744501769542694],[43,-0.0009429000201635063,1.005907654762268,-0.03885599970817566],[44,-0.0009302999824285507,1.0059455633163452,-0.03893580287694931],[45,-0.0009166999952867627,1.0059829950332642,-0.03898390009999275],[46,-0.0009021000005304813,1.00600004196167,-0.039000000804662704],[47,-0.0008864999981597066,1.0072325468063354,-0.03890730068087578],[48,-0.0008701000479049981,1.0107076168060303,-0.0386366993188858],[49,-0.0008527000318281353,1.01609206199646,-0.03819900006055832],[50,-0.0008346000104211271,1.023052453994751,-0.0376054011285305],[51,-0.0008156999829225242,1.0312554836273193,-0.036866798996925354],[52,-0.0007961000665090978,1.040367841720581,-0.03599419817328453],[53,-0.0007758000283502042,1.0500560998916626,-0.03499870002269745],[54,-0.0007550000445917249,1.05998694896698,-0.03389120101928711],[55,-0.0007335000555031002,1.0698270797729492,-0.03268280252814293],[56,-0.0007116000051610172,1.0792431831359863,-0.03138440102338791],[57,-0.0006893000099807978,1.0879019498825073,-0.030007099732756615],[58,-0.0006665000109933317,1.0954698324203491,-0.028561899438500404],[59,-0.0006433000089600682,1.1016136407852173,-0.027059799060225487],[60,-0.0006199000054039061,1.1060000658035278,-0.02551180124282837],[61,-0.0005962000577710569,1.1092495918273926,-0.023928901180624962],[62,-0.0005723999929614365,1.1122033596038818,-0.022322101518511772],[63,-0.0005483000422827899,1.1148583889007568,-0.02070239931344986],[64,-0.0005241999751888216,1.1172118186950684,-0.01908089965581894],[65,-0.0005000000237487257,1.1192607879638672,-0.017468400299549103],[66,-0.0004757999849971384,1.1210025548934937,-0.015876200050115585],[67,-0.0004517000343184918,1.1224339008331299,-0.014315000735223293],[68,-0.0004275999963283539,1.1235522031784058,-0.012796099297702312],[69,-0.00040380001883022487,1.124354600906372,-0.011330300010740757],[70,-0.00038010001298971474,1.1248382329940796,-0.009928599931299686],[71,-0.0003567000094335526,1.125,-0.008602200075984001],[72,-0.0003335000074002892,1.1248835325241089,-0.007361900061368942],[73,-0.0003107000084128231,1.124564290046692,-0.006218799855560064],[74,-0.00028840001323260367,1.1240872144699097,-0.005183999892324209],[75,-0.0002665000210981816,1.1234973669052124,-0.004268300253897905],[76,-0.00024500000290572643,1.1228399276733398,-0.00348289986141026],[77,-0.00022420000459533185,1.1221600770950317,-0.002838600194081664],[78,-0.00020389999554026872,1.1215026378631592,-0.002346700057387352],[79,-0.00018429999181535095,1.1209129095077515,-0.002017900114879012],[80,-0.00016540000797249377,1.1204358339309692,-0.0017821999499574304],[81,-0.00014730000111740083,1.1201164722442627,-0.0015616000164300203],[82,-0.00012989999959245324,1.1200000047683716,-0.0013562999665737152],[83,-0.00011350000568199903,1.120072841644287,-0.0011659000301733613],[84,-0.00009790000331122428,1.120276927947998,-0.000990399974398315],[85,-0.00008330000127898529,1.1205904483795166,-0.0008297000313177705],[86,-0.00006969999958528206,1.1209912300109863,-0.0006836000247858465],[87,-0.00005709999823011458,1.121457815170288,-0.0005520000122487545],[88,-0.00004569999873638153,1.1219679117202759,-0.0004348000220488757],[89,-0.000035400000342633575,1.1225000619888306,-0.0003318999952170998],[90,-0.000026300000172341242,1.1230320930480957,-0.00024309998843818903],[91,-0.000018500000805943273,1.123542308807373,-0.00016830000095069408],[92,-0.000011899999663000926,1.1240088939666748,-0.00010740000288933516],[93,-0.000006800000392104266,1.124409556388855,-0.000060200000007171184],[94,-0.000003099999958067201,1.1247230768203735,-0.000026699999580159783],[95,-8.000000093488779e-7,1.1249271631240845,-0.000006600000233447645],[96,0,1.125,0]]}]},"2144":{"name":"TlkM_stand_quest.gmt","root":"center_n","frames":96,"fps":30,"loop":false,"translation":[{"axis":"xyz","keys":[[0,0,1.125,0],[1,0.000004500000159168849,1.1250211000442505,-0.0001089000070351176],[2,0.000016199999663513154,1.1250816583633423,-0.0004243000003043562],[3,0.00003199999991920777,1.1251777410507202,-0.0009290000307373703],[4,0.00004900000203633681,1.125305414199829,-0.0016058000037446618],[5,0.00006440000288421288,1.1254606246948242,-0.0024377000518143177],[6,0.00007520000508520752,1.1256396770477295,-0.0034074001014232635],[7,0.00007840000034775585,1.1258383989334106,-0.004497800022363663],[8,0.00007110000296961516,1.1260528564453125,-0.005691799800843],[9,0.00005050000254414044,1.1262792348861694,-0.006972199771553278],[10,0.000013500000022759195,1.1265134811401367,-0.00832189992070198],[11,-0.00004270000135875307,1.1267517805099487,-0.009723699651658535],[12,-0.00012110000534448773,1.1269899606704712,-0.011160599999129772],[13,-0.00022470000840257853,1.127224326133728,-0.012615199200809002],[14,-0.00035620000562630594,1.127450704574585,-0.014070600271224976],[15,-0.0005187999922782183,1.1276652812957764,-0.015509500168263912],[16,-0.0007152000325731933,1.127864122390747,-0.01691479980945587],[17,-0.0009485000045970082,1.1280430555343628,-0.018269401043653488],[18,-0.0012215999886393547,1.128198504447937,-0.01955599896609783],[19,-0.001537300064228475,1.1283186674118042,-0.020757701247930527],[20,-0.0018987000221386552,1.1284008026123047,-0.02185720019042492],[21,-0.00230860011652112,1.1284538507461548,-0.022837301716208458],[22,-0.002769900020211935,1.1284868717193604,-0.023680999875068665],[23,-0.003285700222477317,1.1285089254379272,-0.02437100000679493],[24,-0.0038590000476688147,1.1285288333892822,-0.024890301749110222],[25,-0.0044996002689003944,1.1285558938980103,-0.025295499712228775],[26,-0.005206500180065632,1.1285879611968994,-0.02565459907054901],[27,-0.005971900187432766,1.128617286682129,-0.025967800989747047],[28,-0.006788200233131647,1.1286438703536987,-0.026235101744532585],[29,-0.0076477001421153545,1.128667950630188,-0.026456600055098534],[30,-0.008542600087821484,1.1286894083023071,-0.0266324020922184],[31,-0.009465300478041172,1.1287084817886353,-0.026762399822473526],[32,-0.010408099740743637,1.128725290298462,-0.026846900582313538],[33,-0.011363199912011623,1.128739833831787,-0.026885798200964928],[34,-0.012323100119829178,1.1287522315979004,-0.02687929943203926],[35,-0.013279899954795837,1.1287626028060913,-0.02682729996740818],[36,-0.01422599982470274,1.128771185874939,-0.026730099692940712],[37,-0.015153700485825539,1.1287778615951538,-0.026587501168251038],[38,-0.01605520024895668,1.1287826299667358,-0.026399800553917885],[39,-0.016923001036047935,1.1287859678268433,-0.026166999712586403],[40,-0.017749300226569176,1.128787875175476,-0.025889098644256592],[41,-0.01852640137076378,1.1287881135940552,-0.025566300377249718],[42,-0.019246501848101616,1.1287870407104492,-0.025198502466082573],[43,-0.019902100786566734,1.1287848949432373,-0.024785900488495827],[44,-0.020485399290919304,1.1287813186645508,-0.024328500032424927],[45,-0.02098879963159561,1.1287769079208374,-0.02382650040090084],[46,-0.02140440046787262,1.1287713050842285,-0.02327979914844036],[47,-0.021724600344896317,1.1287649869918823,-0.022688500583171844],[48,-0.02194180153310299,1.1287579536437988,-0.02205280028283596],[49,-0.02209790050983429,1.1287505626678467,-0.021419400349259377],[50,-0.02224010042846203,1.128743052482605,-0.020833401009440422],[51,-0.022369200363755226,1.1287354230880737,-0.020291799679398537],[52,-0.02248550020158291,1.1287277936935425,-0.0197915006428957],[53,-0.02258950099349022,1.1287198066711426,-0.019329799339175224],[54,-0.02268180064857006,1.1287118196487427,-0.018903499469161034],[55,-0.022762799635529518,1.1287034749984741,-0.018509801477193832],[56,-0.022833000868558884,1.1286948919296265,-0.018145600333809853],[57,-0.02289309911429882,1.1286860704421997,-0.017808200791478157],[58,-0.022943301126360893,1.1286768913269043,-0.017494400963187218],[59,-0.022984301671385765,1.1286672353744507,-0.017201300710439682],[60,-0.02301659993827343,1.1286572217941284,-0.016926100477576256],[61,-0.02304050140082836,1.128646969795227,-0.01666570082306862],[62,-0.02305680140852928,1.1286358833312988,-0.01641709916293621],[63,-0.023065799847245216,1.1286243200302124,-0.016177600249648094],[64,-0.023068001493811607,1.1286123991012573,-0.015943899750709534],[65,-0.023063899949193,1.1285996437072754,-0.015713300555944443],[66,-0.023054100573062897,1.1285864114761353,-0.015482800081372261],[67,-0.02303910069167614,1.1285723447799683,-0.015249400399625301],[68,-0.023019300773739815,1.1285576820373535,-0.015010200440883636],[69,-0.022995200008153915,1.1285423040390015,-0.01476220041513443],[70,-0.022967400029301643,1.1285260915756226,-0.014502400532364845],[71,-0.022936299443244934,1.1285089254379272,-0.014228000305593014],[72,-0.02279910072684288,1.1284911632537842,-0.01390090025961399],[73,-0.02246430143713951,1.1284722089767456,-0.013490701094269753],[74,-0.021949101239442825,1.1284525394439697,-0.013005499728024006],[75,-0.02127080038189888,1.128431797027588,-0.012453700415790081],[76,-0.02044679969549179,1.1284101009368896,-0.011843400076031685],[77,-0.019494200125336647,1.1283873319625854,-0.011182799935340881],[78,-0.018430599942803383,1.128339171409607,-0.01048010028898716],[79,-0.01727299951016903,1.128245234489441,-0.00974349956959486],[80,-0.01603890024125576,1.1281110048294067,-0.00898130051791668],[81,-0.014745500870049,1.1279419660568237,-0.008201699703931808],[82,-0.013410200364887714,1.1277437210083008,-0.0074129002168774605],[83,-0.012050200253725052,1.1275217533111572,-0.006622999906539917],[84,-0.010682900436222553,1.1272815465927124,-0.005840399768203497],[85,-0.009325600229203701,1.1270288228988647,-0.005073200445622206],[86,-0.007995500229299068,1.1267690658569336,-0.0043296003714203835],[87,-0.006709899753332138,1.1265077590942383,-0.003617800073698163],[88,-0.005486200097948313,1.1262503862380981,-0.002946099964901805],[89,-0.004341700114309788,1.126002550125122,-0.0023227001074701548],[90,-0.003293599933385849,1.125769853591919,-0.0017557000974193215],[91,-0.002359299920499325,1.1255576610565186,-0.0012534999987110496],[92,-0.0015561000909656286,1.1253716945648193,-0.0008240999886766076],[93,-0.0009012999944388866,1.125217318534851,-0.0004759000148624182],[94,-0.0004120999947190285,1.1251003742218018,-0.0002170000079786405],[95,-0.00010590000601951033,1.1250261068344116,-0.000055599997722310945],[96,0,1.125,0]]}]},"2343":{"name":"TogiF_stand_ouen02.gmt","root":"center_n","frames":83,"fps":30,"loop":true,"translation":[{"axis":"xyz","keys":[[0,-0.000004099999841855606,1.1204643249511719,-0.000003400000196052133],[1,-0.0029254001565277576,1.1196858882904053,0.0038542000111192465],[2,-0.0052004000172019005,1.114879846572876,0.006864100228995085],[3,-0.006895100232213736,1.1083816289901733,0.008925700560212135],[4,-0.00864620041102171,1.1024117469787598,0.010852400213479996],[5,-0.01059700082987547,1.1005795001983643,0.013887499459087849],[6,-0.012720100581645966,1.1031335592269897,0.01646910049021244],[7,-0.014082900248467922,1.1095694303512573,0.018136799335479736],[8,-0.01499979943037033,1.1175541877746582,0.018935101106762886],[9,-0.01645749993622303,1.123437523841858,0.019594701007008553],[10,-0.018708400428295135,1.1252011060714722,0.02003760077059269],[11,-0.021408000960946083,1.1226528882980347,0.02062080055475235],[12,-0.023714300245046616,1.115147352218628,0.020223699510097504],[13,-0.02540000155568123,1.104536771774292,0.017754700034856796],[14,-0.027926702052354813,1.0934704542160034,0.014034600928425789],[15,-0.03130420297384262,1.0860106945037842,0.010247500613331795],[16,-0.03599080070853233,1.0862253904342651,0.00563050014898181],[17,-0.04168980196118355,1.0932644605636597,-0.0002667000226210803],[18,-0.04806370288133621,1.1051239967346191,-0.006969300098717213],[19,-0.05451210215687752,1.118651032447815,-0.013548499904572964],[20,-0.06065809726715088,1.1302673816680908,-0.019260000437498093],[21,-0.06619410216808319,1.1370149850845337,-0.02353840135037899],[22,-0.07092080265283585,1.1378753185272217,-0.026458099484443665],[23,-0.07478799670934677,1.133595585823059,-0.029423698782920837],[24,-0.07899000495672226,1.1235853433609009,-0.03269070014357567],[25,-0.08401259779930115,1.110703468322754,-0.03603009879589081],[26,-0.08890510350465775,1.098580002784729,-0.03804979845881462],[27,-0.09431980550289154,1.090691089630127,-0.03755649924278259],[28,-0.09982920438051224,1.08858323097229,-0.03565970063209534],[29,-0.10388200730085373,1.0932115316390991,-0.033545199781656265],[30,-0.1058541089296341,1.1025848388671875,-0.03055729903280735],[31,-0.10540880262851715,1.1129519939422607,-0.02683820202946663],[32,-0.1031792089343071,1.121260404586792,-0.023023901507258415],[33,-0.09996920078992844,1.1254911422729492,-0.01914980076253414],[34,-0.09543409943580627,1.1248778104782104,-0.015303201042115688],[35,-0.09027940034866333,1.1199878454208374,-0.011979900300502777],[36,-0.08539920300245285,1.1116080284118652,-0.009353800676763058],[37,-0.08117350190877914,1.101084589958191,-0.007066600024700165],[38,-0.07791690528392792,1.090111255645752,-0.004575999919325113],[39,-0.07493770122528076,1.0818758010864258,-0.0019791999366134405],[40,-0.0717674046754837,1.078189730644226,0.00024140000459738076],[41,-0.06951860338449478,1.0803799629211426,0.0020104001741856337],[42,-0.0686069056391716,1.0877729654312134,0.0027145000640302896],[43,-0.06783869862556458,1.0976862907409668,0.003158800071105361],[44,-0.06678520143032074,1.108627438545227,0.003510399954393506],[45,-0.06508740037679672,1.1181849241256714,0.004255000036209822],[46,-0.06288070231676102,1.123896598815918,0.004951999988406897],[47,-0.06076660379767418,1.1256952285766602,0.005546699743717909],[48,-0.058860599994659424,1.123305320739746,0.00572599982842803],[49,-0.057464804500341415,1.1171237230300903,0.0051506999880075455],[50,-0.05656750127673149,1.1088919639587402,0.003253500210121274],[51,-0.05611079931259155,1.100046157836914,0.00020470000163186342],[52,-0.05594779923558235,1.0918458700180054,-0.004232000093907118],[53,-0.05486440286040306,1.0851324796676636,-0.008688299916684628],[54,-0.052740998566150665,1.081737995147705,-0.012753799557685852],[55,-0.04996290057897568,1.0835074186325073,-0.017051799222826958],[56,-0.04727169871330261,1.0905662775039673,-0.021342599764466286],[57,-0.044186100363731384,1.100898027420044,-0.025522200390696526],[58,-0.04088130220770836,1.1124602556228638,-0.029718101024627686],[59,-0.03742010146379471,1.1223688125610352,-0.03353770077228546],[60,-0.033894699066877365,1.128548502922058,-0.036530502140522],[61,-0.03048439882695675,1.129616141319275,-0.03874779865145683],[62,-0.02717900089919567,1.1254515647888184,-0.04033150151371956],[63,-0.02417909912765026,1.1171969175338745,-0.041802000254392624],[64,-0.02136390097439289,1.1071820259094238,-0.04337390139698982],[65,-0.01865839958190918,1.0980876684188843,-0.0453588031232357],[66,-0.015301301144063473,1.0934287309646606,-0.0470225028693676],[67,-0.011771800927817822,1.0945100784301758,-0.047856200486421585],[68,-0.008669400587677956,1.101030707359314,-0.04858959838747978],[69,-0.0060339998453855515,1.1101754903793335,-0.04833650216460228],[70,-0.004564100410789251,1.1184569597244263,-0.0461897999048233],[71,-0.004367799963802099,1.1233532428741455,-0.04262470081448555],[72,-0.005173200275748968,1.1243579387664795,-0.03876189887523651],[73,-0.005372100044041872,1.1206543445587158,-0.034917201846838],[74,-0.0053180004470050335,1.11339271068573,-0.031060699373483658],[75,-0.005050700157880783,1.104619026184082,-0.027217701077461243],[76,-0.004609800409525633,1.0974143743515015,-0.02341349981725216],[77,-0.004035200458019972,1.0950899124145508,-0.019673701375722885],[78,-0.0033666000235825777,1.0984764099121094,-0.01602340117096901],[79,-0.0026436999905854464,1.1047104597091675,-0.012488099746406078],[80,-0.001906299963593483,1.110761046409607,-0.009093000553548336],[81,-0.0011940000113099813,1.1166110038757324,-0.005863700062036514],[82,-0.0005467000300996006,1.1198054552078247,-0.0028252999763935804],[83,-0.000004099999841855606,1.1204643249511719,-0.000003400000196052133],[83,-0.000004099999841855606,1.1204643249511719,-0.000003400000196052133]]}]},"2344":{"name":"TogiF_stand_ouen03.gmt","root":"center_n","frames":124,"fps":30,"loop":true,"translation":[{"axis":"xyz","keys":[[0,-0.0000026000000161729986,1.050876498222351,-8.000000093488779e-7],[1,0.002764300210401416,1.0557454824447632,0.0018767999717965722],[2,0.005484600085765123,1.068385124206543,0.004942900035530329],[3,0.008221699856221676,1.086140513420105,0.00956880021840334],[4,0.011643599718809128,1.1067235469818115,0.014378800056874752],[5,0.015354900620877743,1.127200722694397,0.019247999414801598],[6,0.019221900030970573,1.143058180809021,0.02413720078766346],[7,0.022703800350427628,1.1522663831710815,0.028133699670433998],[8,0.02498820051550865,1.154988169670105,0.029723701998591423],[9,0.026822900399565697,1.1513205766677856,0.028164198622107506],[10,0.02899009920656681,1.14128839969635,0.02474370039999485],[11,0.031235501170158386,1.1242676973342896,0.020677199587225914],[12,0.030942300334572792,1.101491928100586,0.01699499972164631],[13,0.02918100170791149,1.0768998861312866,0.015398199670016766],[14,0.026329100131988525,1.0544788837432861,0.0162712000310421],[15,0.023265700787305832,1.0380741357803345,0.01824910007417202],[16,0.020250899717211723,1.0304869413375854,0.02212510071694851],[17,0.017543800175189972,1.0325117111206055,0.02869660034775734],[18,0.016299299895763397,1.0459903478622437,0.03563680127263069],[19,0.017195500433444977,1.0692631006240845,0.04228140041232109],[20,0.019747300073504448,1.0981652736663818,0.04864970222115517],[21,0.022729801014065742,1.1276715993881226,0.05419830232858658],[22,0.02585659921169281,1.1513454914093018,0.05856059864163399],[23,0.028469398617744446,1.1675915718078613,0.06082460284233093],[24,0.030722200870513916,1.1762264966964722,0.060188502073287964],[25,0.032506201416254044,1.1771153211593628,0.057093601673841476],[26,0.03378100320696831,1.1708858013153076,0.053562600165605545],[27,0.035284098237752914,1.1584861278533936,0.04933610185980797],[28,0.037030499428510666,1.1402312517166138,0.044318199157714844],[29,0.03892750293016434,1.1207475662231445,0.04090860113501549],[30,0.03927890211343765,1.1036030054092407,0.03981950134038925],[31,0.03861759975552559,1.0926178693771362,0.041789401322603226],[32,0.03913620114326477,1.0891894102096558,0.044599901884794235],[33,0.040567200630903244,1.0931029319763184,0.047926198691129684],[34,0.04195209965109825,1.1031053066253662,0.05187569931149483],[35,0.04317350313067436,1.1160472631454468,0.05536380037665367],[36,0.04426589980721474,1.130588412284851,0.0580362044274807],[37,0.04477449879050255,1.144482970237732,0.060154903680086136],[38,0.04400140047073364,1.155052661895752,0.061341702938079834],[39,0.042283400893211365,1.1597951650619507,0.060600604861974716],[40,0.03996739909052849,1.157705307006836,0.05796870216727257],[41,0.03787099942564964,1.148134469985962,0.053550999611616135],[42,0.036642398685216904,1.1344324350357056,0.049108900129795074],[43,0.03459380194544792,1.1183674335479736,0.04615350067615509],[44,0.03378089889883995,1.1038587093353271,0.0438322015106678],[45,0.03478090092539787,1.093458652496338,0.043470900505781174],[46,0.03561140224337578,1.0890334844589233,0.04465290158987045],[47,0.03701240196824074,1.0914949178695679,0.04557120054960251],[48,0.03937850147485733,1.0990228652954102,0.046247899532318115],[49,0.04225350171327591,1.1096733808517456,0.046542201191186905],[50,0.04582170024514198,1.1218326091766357,0.04649690166115761],[51,0.049509502947330475,1.1330398321151733,0.04593740031123161],[52,0.052170999348163605,1.1392717361450195,0.04452520236372948],[53,0.055226899683475494,1.1439027786254883,0.042657800018787384],[54,0.05806350335478783,1.145306944847107,0.04014910012483597],[55,0.06065179780125618,1.1427866220474243,0.03698069974780083],[56,0.06332939863204956,1.1364320516586304,0.03323959931731224],[57,0.06488100439310074,1.1245492696762085,0.030848398804664612],[58,0.06625019758939743,1.1074614524841309,0.026487300172448158],[59,0.06802210211753845,1.089117169380188,0.020495900884270668],[60,0.06928340345621109,1.0734682083129883,0.015240199863910675],[61,0.06972640007734299,1.0618504285812378,0.011049800552427769],[62,0.06908760219812393,1.056426763534546,0.007903199642896652],[63,0.06767799705266953,1.0573543310165405,0.006205299869179726],[64,0.06466330587863922,1.0633233785629272,0.006540799979120493],[65,0.06040310487151146,1.0732768774032593,0.008812000043690205],[66,0.055595703423023224,1.0860382318496704,0.012356700375676155],[67,0.050380803644657135,1.0999045372009277,0.016676099970936775],[68,0.044943198561668396,1.1131271123886108,0.02160480059683323],[69,0.039971400052309036,1.1238311529159546,0.02682560123503208],[70,0.035812199115753174,1.1309419870376587,0.031251098960638046],[71,0.03360829874873161,1.1335490942001343,0.034039199352264404],[72,0.03343310207128525,1.130533218383789,0.03399030119180679],[73,0.034995999187231064,1.1224756240844727,0.03132620081305504],[74,0.037021201103925705,1.1090983152389526,0.027265701442956924],[75,0.039080798625946045,1.0974600315093994,0.024073701351881027],[76,0.039976298809051514,1.0845661163330078,0.022111600264906883],[77,0.03884030133485794,1.07267427444458,0.022480100393295288],[78,0.036588601768016815,1.0640422105789185,0.02438179962337017],[79,0.032864201813936234,1.0609275102615356,0.027838701382279396],[80,0.02782510034739971,1.0636065006256104,0.033907800912857056],[81,0.02111620083451271,1.0705739259719849,0.04060080274939537],[82,0.014611700549721718,1.0814155340194702,0.04546450078487396],[83,0.008843900635838509,1.0957168340682983,0.048852499574422836],[84,0.004087999928742647,1.1130632162094116,0.0517004020512104],[85,-0.000015800000255694613,1.1374561786651611,0.05389469861984253],[86,-0.0033543002791702747,1.1537679433822632,0.05589209869503975],[87,-0.006383100058883429,1.1618387699127197,0.05626950412988663],[88,-0.007960000075399876,1.1636894941329956,0.05429689958691597],[89,-0.008420700207352638,1.1553490161895752,0.04999580234289169],[90,-0.00993959978222847,1.1403543949127197,0.04456120356917381],[91,-0.011437900364398956,1.1244395971298218,0.037906501442193985],[92,-0.012898600660264492,1.108104944229126,0.031596701592206955],[93,-0.014978699386119843,1.0918501615524292,0.028811698779463768],[94,-0.019343901425600052,1.0751090049743652,0.028455400839447975],[95,-0.02435549907386303,1.0685375928878784,0.028521999716758728],[96,-0.029066801071166992,1.0721299648284912,0.02906070090830326],[97,-0.03189770132303238,1.0841805934906006,0.029312899336218834],[98,-0.033094000071287155,1.1009255647659302,0.028199700638651848],[99,-0.0328449010848999,1.1180706024169922,0.02664100006222725],[100,-0.032397400587797165,1.1325238943099976,0.024879999458789825],[101,-0.03128890320658684,1.1418770551681519,0.022882601246237755],[102,-0.0291897002607584,1.1454752683639526,0.020266098901629448],[103,-0.026255199685692787,1.1431196928024292,0.0169770997017622],[104,-0.023334799334406853,1.1357072591781616,0.014071700163185596],[105,-0.021782901138067245,1.1229909658432007,0.012325500138103962],[106,-0.02104630134999752,1.105817198753357,0.010977900587022305],[107,-0.02066590078175068,1.0878338813781738,0.010181300342082977],[108,-0.02098350040614605,1.0718871355056763,0.012008300051093102],[109,-0.022716499865055084,1.0647647380828857,0.016184799373149872],[110,-0.02510949969291687,1.069804072380066,0.020517200231552124],[111,-0.027243200689554214,1.0847690105438232,0.02419460006058216],[112,-0.027807001024484634,1.1060794591903687,0.02662450075149536],[113,-0.027702201157808304,1.1281325817108154,0.028123900294303894],[114,-0.027410298585891724,1.144769549369812,0.029377201572060585],[115,-0.026736000552773476,1.1517465114593506,0.02979930117726326],[116,-0.025476599112153053,1.155363917350769,0.02877950109541416],[117,-0.023490099236369133,1.1518445014953613,0.02591860108077526],[118,-0.020765500143170357,1.1408485174179077,0.02127469889819622],[119,-0.01745009981095791,1.123159408569336,0.015457600355148315],[120,-0.013739100657403469,1.1026190519332886,0.009243500418961048],[121,-0.010057100094854832,1.0830692052841187,0.0042095002718269825],[122,-0.00668080011382699,1.062975525856018,0.00141629995778203],[123,-0.0033662000205367804,1.0521677732467651,0.00010959999781334773],[124,-0.0000026000000161729986,1.050876498222351,-8.000000093488779e-7],[124,-0.0000026000000161729986,1.050876498222351,-8.000000093488779e-7]]}]},"2351":{"name":"TogiM_stand_ouen02.gmt","root":"center_n","frames":50,"fps":30,"loop":true,"translation":[{"axis":"xyz","keys":[[0,-0.000002499999936844688,1.032788634300232,0.0000029999998787388904],[1,0.00013859999307896942,1.032300353050232,0.0011680000461637974],[2,0.00047599998652003706,1.033206820487976,0.0031279001850634813],[3,0.00088160001905635,1.0390657186508179,0.00357990013435483],[4,0.0012268000282347202,1.0534343719482422,-0.004275200422853231],[5,-0.0002586999908089638,1.0741597414016724,-0.03978919982910156],[6,-0.0019168000435456634,1.0947431325912476,-0.06669740378856659],[7,-0.00022249999165069312,1.1082605123519897,-0.08888740092515945],[8,0.002568199997767806,1.1077114343643188,-0.09609200060367584],[9,0.007487799972295761,1.101190447807312,-0.09067559987306595],[10,0.015237000770866871,1.0935181379318237,-0.07793939858675003],[11,0.03146610036492348,1.0853427648544312,-0.0532832033932209],[12,0.0482311025261879,1.0748674869537354,-0.022936400026082993],[13,0.06368540227413177,1.0642999410629272,0.009927500039339066],[14,0.07384859770536423,1.0542936325073242,0.0407412014901638],[15,0.07564099878072739,1.0475329160690308,0.06304760277271271],[16,0.07354970276355743,1.0465826988220215,0.07934259623289108],[17,0.0685833990573883,1.0545645952224731,0.0813824012875557],[18,0.05971890315413475,1.0679311752319336,0.0670292004942894],[19,0.04797939956188202,1.0928773880004883,0.04058460146188736],[20,0.03744350001215935,1.1195341348648071,0.014669000171124935],[21,0.030670499429106712,1.138819932937622,-0.004692399874329567],[22,0.02571049891412258,1.1462315320968628,-0.017689799889922142],[23,0.022597501054406166,1.143450140953064,-0.020688701421022415],[24,0.020503100007772446,1.1314975023269653,-0.023998700082302094],[25,0.020089801400899887,1.1240419149398804,-0.025892099365592003],[26,0.02140890061855316,1.1183974742889404,-0.028294799849390984],[27,0.0236114002764225,1.1173107624053955,-0.029982000589370728],[28,0.02786239981651306,1.1173266172409058,-0.03424980118870735],[29,0.03213810175657272,1.1168984174728394,-0.03645870089530945],[30,0.03552300110459328,1.1157282590866089,-0.04306120052933693],[31,0.03811570256948471,1.1151025295257568,-0.04717550054192543],[32,0.03962410241365433,1.1137899160385132,-0.05488720163702965],[33,0.04030450060963631,1.1119740009307861,-0.06329460442066193],[34,0.039272602647542953,1.1094335317611694,-0.0717393010854721],[35,0.037922099232673645,1.1051318645477295,-0.07971829921007156],[36,0.03519679978489876,1.1004352569580078,-0.08657360076904297],[37,0.03358500078320503,1.0964840650558472,-0.09211050719022751],[38,0.031007399782538414,1.0926976203918457,-0.0955682024359703],[39,0.027306899428367615,1.0887917280197144,-0.09798730164766312],[40,0.02115650102496147,1.084193468093872,-0.09958069771528244],[41,0.014081700704991817,1.079553246498108,-0.10334999859333038],[42,0.006806000601500273,1.0748803615570068,-0.10391320288181305],[43,0.00040770001942291856,1.070183515548706,-0.10151950269937515],[44,-0.0036331003066152334,1.0654717683792114,-0.0980973020195961],[45,-0.005797500256448984,1.0607541799545288,-0.0876586064696312],[46,-0.006565000396221876,1.0543595552444458,-0.07408390194177628],[47,-0.006494400091469288,1.0469883680343628,-0.05603259801864624],[48,-0.0056778001599013805,1.04001784324646,-0.03642899915575981],[49,-0.0025504000950604677,1.0348254442214966,-0.013582601211965084],[50,-0.000002499999936844688,1.032788634300232,0.0000029999998787388904],[50,-0.000002499999936844688,1.032788634300232,0.0000029999998787388904]]}]},"2353":{"name":"TogiM_stand_ouen04.gmt","root":"center_n","frames":68,"fps":30,"loop":true,"translation":[{"axis":"xyz","keys":[[0,2.0000000233721948e-7,1.101116418838501,0.0000019999999949504854],[1,-0.0018299000803381205,1.106137752532959,0.000735800014808774],[2,-0.0037455998826771975,1.1125224828720093,-0.002213600091636181],[3,-0.005048099905252457,1.117476224899292,-0.007470499724149704],[4,-0.004478800110518932,1.1195505857467651,-0.013148101046681404],[5,-0.0006741000106558204,1.1191725730895996,-0.02017050050199032],[6,0.002594300080090761,1.1156309843063354,-0.027419498190283775],[7,0.004787900019437075,1.108508825302124,-0.03342610225081444],[8,0.007136400323361158,1.1008691787719727,-0.03778670355677605],[9,0.010300199501216412,1.0964845418930054,-0.0391697995364666],[10,0.015359500423073769,1.0958561897277832,-0.0348237007856369],[11,0.023394200950860977,1.0980297327041626,-0.02941640093922615],[12,0.03330160304903984,1.101937174797058,-0.023096099495887756],[13,0.04371010139584541,1.105648159980774,-0.014007600024342537],[14,0.05266210064291954,1.108263611793518,-0.0036689999978989363],[15,0.05944659933447838,1.1097886562347412,0.0070988996885716915],[16,0.06279309839010239,1.1095017194747925,0.018011700361967087],[17,0.06200310215353966,1.1098904609680176,0.02584240213036537],[18,0.057050105184316635,1.1119017601013184,0.029847800731658936],[19,0.04975799843668938,1.1151981353759766,0.02850179933011532],[20,0.041839297860860825,1.1189154386520386,0.021443801000714302],[21,0.03481660038232803,1.1213276386260986,0.011479499749839306],[22,0.029324298724532127,1.1204816102981567,0.000014899999769113492],[23,0.02440579980611801,1.1157605648040771,-0.010144200176000595],[24,0.017585599794983864,1.108851432800293,-0.017461201176047325],[25,0.009802799671888351,1.1018339395523071,-0.019929898902773857],[26,0.0033615001011639833,1.096335768699646,-0.018904300406575203],[27,-0.0009530999814160168,1.0928772687911987,-0.017432600259780884],[28,-0.004454800393432379,1.0910966396331787,-0.014969400130212307],[29,-0.0076925004832446575,1.0907987356185913,-0.012176400050520897],[30,-0.010282199829816818,1.0912320613861084,-0.00895370077341795],[31,-0.012080200016498566,1.0920350551605225,-0.005546300206333399],[32,-0.013200200162827969,1.0932077169418335,-0.0015790000325068831],[33,-0.014032900333404541,1.094279408454895,0.0018783999839797616],[34,-0.01417279988527298,1.0951160192489624,0.00520530017092824],[35,-0.014259899966418743,1.0957765579223633,0.007574200164526701],[36,-0.014460699632763863,1.0964488983154297,0.008929899893701077],[37,-0.014575399458408356,1.096969723701477,0.009252100251615047],[38,-0.014964899979531765,1.0978038311004639,0.008655699901282787],[39,-0.01613049954175949,1.0985044240951538,0.006876999977976084],[40,-0.018587499856948853,1.098663091659546,0.003631100058555603],[41,-0.02198610082268715,1.0977439880371094,-0.0007592000183649361],[42,-0.025708600878715515,1.0954245328903198,-0.006884100381284952],[43,-0.02883250080049038,1.0930657386779785,-0.014281700365245342],[44,-0.029663100838661194,1.0917888879776,-0.02254450134932995],[45,-0.027759701013565063,1.0925344228744507,-0.0308454018086195],[46,-0.02368680015206337,1.0951435565948486,-0.038259100168943405],[47,-0.018106399103999138,1.0985912084579468,-0.04484890028834343],[48,-0.011508400551974773,1.1020491123199463,-0.050832599401474],[49,-0.004334900062531233,1.1049364805221558,-0.0567145012319088],[50,0.0028226999565958977,1.106998324394226,-0.06308180093765259],[51,0.00965800043195486,1.1078821420669556,-0.07016300410032272],[52,0.016199400648474693,1.1077293157577515,-0.07824470102787018],[53,0.02278580144047737,1.1059600114822388,-0.085978202521801],[54,0.029296401888132095,1.103534460067749,-0.09070929884910583],[55,0.03332990035414696,1.100583553314209,-0.09060180187225342],[56,0.03442030027508736,1.0984917879104614,-0.08818640559911728],[57,0.03403719887137413,1.0986626148223877,-0.08406289666891098],[58,0.031129300594329834,1.0986171960830688,-0.07862120121717453],[59,0.026323800906538963,1.098698616027832,-0.07310660183429718],[60,0.020817600190639496,1.0990126132965088,-0.06736879795789719],[61,0.015254099853336811,1.0987342596054077,-0.05969100072979927],[62,0.011658400297164917,1.097674012184143,-0.049814000725746155],[63,0.008792100474238396,1.0963001251220703,-0.038731303066015244],[64,0.0065008001402020454,1.095081090927124,-0.02743620052933693],[65,0.0046303002163767815,1.094484806060791,-0.0169220007956028],[66,0.0030262002255767584,1.0949797630310059,-0.008182000368833542],[67,0.001534300041384995,1.0970343351364136,-0.0022096000611782074],[68,2.0000000233721948e-7,1.101116418838501,0.0000019999999949504854],[68,2.0000000233721948e-7,1.101116418838501,0.0000019999999949504854]]}]},"2354":{"name":"TogiM_stand_ouen05.gmt","root":"center_n","frames":60,"fps":30,"loop":true,"translation":[{"axis":"xyz","keys":[[0,0.0000037000002066633897,1.1224027872085571,-0.0000024000000848900527],[1,-0.0005452000186778605,1.1220781803131104,-0.001642799936234951],[2,-0.0009137000306509435,1.1216667890548706,-0.0032265998888760805],[3,-0.0010304999304935336,1.1215485334396362,-0.0038888000417500734],[4,-0.0008244000491686165,1.1216567754745483,-0.004151300061494112],[5,-0.0002238000015495345,1.1215015649795532,-0.003815599950030446],[6,0.0008424000116065145,1.1213319301605225,-0.0031854999251663685],[7,0.0024457001127302647,1.1211246252059937,-0.0030712999869138002],[8,0.0046572997234761715,1.1206496953964233,-0.0030412001069635153],[9,0.007548700552433729,1.1204173564910889,-0.002575900172814727],[10,0.011191199533641338,1.1203359365463257,-0.001840700046159327],[11,0.01565600000321865,1.1199759244918823,-0.0006634999881498516],[12,0.021197199821472168,1.1196240186691284,0.0005381000228226185],[13,0.02703230082988739,1.1192690134048462,0.001241500023752451],[14,0.03333890065550804,1.1191303730010986,0.0019280000124126673],[15,0.040153902024030685,1.1194767951965332,0.003018900053575635],[16,0.047561898827552795,1.119956612586975,0.004003399983048439],[17,0.055560898035764694,1.1195400953292847,0.005077100358903408],[18,0.06396319717168808,1.1193184852600098,0.005858799908310175],[19,0.07185540348291397,1.1192917823791504,0.006064999848604202],[20,0.07941020280122757,1.1193040609359741,0.005711100064218044],[21,0.08662819862365723,1.1194082498550415,0.005508699920028448],[22,0.0936323031783104,1.1196449995040894,0.00537420017644763],[23,0.09991779923439026,1.119633674621582,0.0053357998840510845],[24,0.1052849069237709,1.1193671226501465,0.005203300155699253],[25,0.10908319801092148,1.118866205215454,0.004390600137412548],[26,0.11174050718545914,1.1182076930999756,0.0033948998898267746],[27,0.11394759267568588,1.117716670036316,0.002858100226148963],[28,0.11618310213088989,1.1176931858062744,0.002268600044772029],[29,0.11772409826517105,1.117669701576233,0.0016160000814124942],[30,0.11874829977750778,1.117925763130188,0.0009902999736368656],[31,0.11919939517974854,1.118031620979309,-0.00019839999731630087],[32,0.11878550052642822,1.1179918050765991,-0.0012009000638499856],[33,0.11844050139188766,1.1178048849105835,-0.0015760998940095305],[34,0.11791210621595383,1.1177341938018799,-0.0018336999928578734],[35,0.11729389429092407,1.117514967918396,-0.001864599995315075],[36,0.11627370119094849,1.1173995733261108,-0.0016973000019788742],[37,0.11441149562597275,1.117212176322937,-0.0015275999903678894],[38,0.11168110370635986,1.1167808771133423,-0.001357999979518354],[39,0.10867639631032944,1.1164084672927856,-0.001115199993364513],[40,0.1052497997879982,1.1164432764053345,-0.0007395999855361879],[41,0.10135680437088013,1.116544246673584,-0.0002538000117056072],[42,0.09663770347833633,1.1167365312576294,0.0003197999903932214],[43,0.0910969004034996,1.1170084476470947,0.0009587000240571797],[44,0.084688700735569,1.117348074913025,0.0016403001500293612],[45,0.07752259820699692,1.117743730545044,0.0023422001395374537],[46,0.07023080438375473,1.1181834936141968,0.0030417998787015676],[47,0.06252840161323547,1.1186559200286865,0.003716700244694948],[48,0.054510802030563354,1.119148850440979,0.004344300366938114],[49,0.04726530238986015,1.1196507215499878,0.004902200307697058],[50,0.03997800126671791,1.1201496124267578,0.005367800127714872],[51,0.032864999026060104,1.1206339597702026,0.005718600004911423],[52,0.026142600923776627,1.1210917234420776,0.0059321001172065735],[53,0.02002680115401745,1.1216237545013428,0.005985800176858902],[54,0.014733701013028622,1.1220202445983887,0.005857300013303757],[55,0.010479600168764591,1.1223737001419067,0.005523900035768747],[56,0.007215000223368406,1.1225794553756714,0.0049633001908659935],[57,0.0046617998741567135,1.1227515935897827,0.0041528004221618176],[58,0.0026934000197798014,1.1228268146514893,0.003070099977776408],[59,0.001183000043965876,1.122616171836853,0.001692499965429306],[60,0.0000037000002066633897,1.1224027872085571,-0.0000024000000848900527],[60,0.0000037000002066633897,1.1224027872085571,-0.0000024000000848900527]]}]},"2355":{"name":"TogiM_stand_ouen06.gmt","root":"center_n","frames":60,"fps":30,"loop":true,"translation":[{"axis":"xyz","keys":[[0,0.0000037000002066633897,1.1224027872085571,-0.0000037000002066633897],[1,-0.0005452000186778605,1.1220781803131104,-0.0016441000625491142],[2,-0.0009137000306509435,1.1216667890548706,-0.003228000132367015],[3,-0.0010304999304935336,1.1215485334396362,-0.0038901001680642366],[4,-0.0008244000491686165,1.1216567754745483,-0.004152600187808275],[5,-0.0002238000015495345,1.1215015649795532,-0.0038169000763446093],[6,0.0008424000116065145,1.1213319301605225,-0.0031868000514805317],[7,0.0024457001127302647,1.1211246252059937,-0.0030726001132279634],[8,0.0046572997234761715,1.1206496953964233,-0.003042500000447035],[9,0.007548700552433729,1.1204173564910889,-0.0025772000662982464],[10,0.011191199533641338,1.1203359365463257,-0.0018421000568196177],[11,0.01565600000321865,1.1199759244918823,-0.0006647999980486929],[12,0.021197199821472168,1.1196240186691284,0.0005367000121623278],[13,0.02703230082988739,1.1192690134048462,0.0012402000138536096],[14,0.03333890065550804,1.1191303730010986,0.0019266000017523766],[15,0.040153902024030685,1.1194767951965332,0.0030175000429153442],[16,0.047561898827552795,1.119956612586975,0.004002000205218792],[17,0.055560898035764694,1.1195400953292847,0.005075800232589245],[18,0.06396319717168808,1.1193184852600098,0.005857500247657299],[19,0.07185540348291397,1.1192917823791504,0.006063600070774555],[20,0.07941020280122757,1.1193040609359741,0.00570969982072711],[21,0.08662819862365723,1.1194082498550415,0.005507300142198801],[22,0.0936323031783104,1.1196449995040894,0.0053727999329566956],[23,0.09991779923439026,1.119633674621582,0.0053344001062214375],[24,0.1052849069237709,1.1193671226501465,0.00520200002938509],[25,0.10908319801092148,1.118866205215454,0.004389300011098385],[26,0.11174050718545914,1.1182076930999756,0.003393499879166484],[27,0.11394759267568588,1.117716670036316,0.0028566999826580286],[28,0.11618310213088989,1.1176931858062744,0.0022672999184578657],[29,0.11772409826517105,1.117669701576233,0.0016146000707522035],[30,0.11874829977750778,1.117925763130188,0.0009889000793918967],[31,0.11919939517974854,1.118031620979309,-0.0001998000079765916],[32,0.11878550052642822,1.1179918050765991,-0.0012023000745102763],[33,0.11844050139188766,1.1178048849105835,-0.001577500137500465],[34,0.11791210621595383,1.1177341938018799,-0.0018350000027567148],[35,0.11729389429092407,1.117514967918396,-0.0018659000052139163],[36,0.11627370119094849,1.1173995733261108,-0.0016986000118777156],[37,0.11441149562597275,1.117212176322937,-0.0015290000010281801],[38,0.11168110370635986,1.1167808771133423,-0.0013593001058325171],[39,0.10867639631032944,1.1164084672927856,-0.0011165000032633543],[40,0.1052497997879982,1.1164432764053345,-0.0007409999961964786],[41,0.10135680437088013,1.116544246673584,-0.00025510002160444856],[42,0.09663770347833633,1.1167365312576294,0.00031850000959821045],[43,0.0910969004034996,1.1170084476470947,0.0009572999551892281],[44,0.084688700735569,1.117348074913025,0.001639000023715198],[45,0.07752259820699692,1.117743730545044,0.0023407998960465193],[46,0.07023080438375473,1.1181834936141968,0.003040499985218048],[47,0.06252840161323547,1.1186559200286865,0.00371529976837337],[48,0.054510802030563354,1.119148850440979,0.004343000240623951],[49,0.04726530238986015,1.1196507215499878,0.004900800064206123],[50,0.03997800126671791,1.1201496124267578,0.005366399884223938],[51,0.032864999026060104,1.1206339597702026,0.005717200227081776],[52,0.026142600923776627,1.1210917234420776,0.005930700339376926],[53,0.02002680115401745,1.1216237545013428,0.005984500050544739],[54,0.014733701013028622,1.1220202445983887,0.00585590023547411],[55,0.010479600168764591,1.1223737001419067,0.005522599909454584],[56,0.007215000223368406,1.1225794553756714,0.004961899947375059],[57,0.0046617998741567135,1.1227515935897827,0.004151500295847654],[58,0.0026934000197798014,1.1228268146514893,0.003068700199946761],[59,0.001183000043965876,1.122616171836853,0.0016912000719457865],[60,0.0000037000002066633897,1.1224027872085571,-0.0000037000002066633897],[60,0.0000037000002066633897,1.1224027872085571,-0.0000037000002066633897]]}]},"4855":{"name":"P_stand_kamemiru.gmt","root":"center_n","frames":120,"fps":30,"loop":true,"translation":[{"axis":"xyz","keys":[[0,0,1.1299999952316284,0],[1,0.0002640000020619482,1.1299784183502197,-0.000008199999683711212],[2,0.0005364000098779798,1.1299158334732056,-0.00003260000084992498],[3,0.0008163000456988811,1.129815697669983,-0.00007249999907799065],[4,0.001102800015360117,1.1296814680099487,-0.00012740000966005027],[5,0.0013951000291854143,1.1295164823532104,-0.00019680001423694193],[6,0.0016920000780373812,1.1293240785598755,-0.0002800000074785203],[7,0.001992899924516678,1.1291078329086304,-0.0003766000154428184],[8,0.0022966000251471996,1.128871202468872,-0.0004859000036958605],[9,0.0026024000253528357,1.128617525100708,-0.0006075000273995101],[10,0.002909200033172965,1.1283501386642456,-0.0007406999939121306],[11,0.003216200042515993,1.1280723810195923,-0.0008851000457070768],[12,0.0035225001629441977,1.1277879476547241,-0.0010400000028312206],[13,0.0038270000368356705,1.1274999380111694,-0.0012048999778926373],[14,0.004129000008106232,1.1272121667861938,-0.001379300025291741],[15,0.004427399951964617,1.1269277334213257,-0.0015625000232830644],[16,0.004721400327980518,1.126650094985962,-0.0017541000852361321],[17,0.005010100081562996,1.12638258934021,-0.0019533999729901552],[18,0.005292400252074003,1.1261287927627563,-0.0021600001491606236],[19,0.005567499902099371,1.125892162322998,-0.002373199909925461],[20,0.005834599956870079,1.1256760358810425,-0.0025925999507308006],[21,0.006092499941587448,1.1254836320877075,-0.002817500149831176],[22,0.006340499967336655,1.1253186464309692,-0.0030473999213427305],[23,0.006577599793672562,1.125184416770935,-0.003281800076365471],[24,0.006802900228649378,1.1250842809677124,-0.0035200000274926424],[25,0.007015500217676163,1.1250215768814087,-0.0037616000045090914],[26,0.007214400451630354,1.125,-0.004005900118499994],[27,0.007398699875921011,1.125014305114746,-0.004252500366419554],[28,0.007567600347101688,1.1250561475753784,-0.004500700160861015],[29,0.007720000576227903,1.1251236200332642,-0.004750100430101156],[30,0.007855100557208061,1.12521493434906,-0.005000000353902578],[31,0.007971900515258312,1.1253280639648438,-0.0052499002777040005],[32,0.008069599978625774,1.125461459159851,-0.005499300081282854],[33,0.008147100917994976,1.1256130933761597,-0.005747500341385603],[34,0.008203700184822083,1.1257814168930054,-0.005994100123643875],[35,0.008238299749791622,1.1259640455245972,-0.006238400004804134],[36,0.008250000886619091,1.12615966796875,-0.006480000447481871],[37,0.008233699947595596,1.1263662576675415,-0.006718199700117111],[38,0.00818559993058443,1.126582145690918,-0.006952600087970495],[39,0.008107099682092667,1.1268051862716675,-0.00718249985948205],[40,0.0079993000254035,1.1270337104797363,-0.007407400291413069],[41,0.007863500155508518,1.1272659301757812,-0.007626800332218409],[42,0.0077010998502373695,1.1274999380111694,-0.007840000092983246],[43,0.0075133005157113075,1.1277340650558472,-0.00804660003632307],[44,0.007301300298422575,1.127966284751892,-0.008245900273323059],[45,0.007066500373184681,1.1281949281692505,-0.008437500335276127],[46,0.006809999700635672,1.12841796875,-0.008620700798928738],[47,0.006533200386911631,1.128633737564087,-0.008795100264251232],[48,0.006237400230020285,1.128840446472168,-0.008960000239312649],[49,0.0059238001704216,1.1290358304977417,-0.009114900603890419],[50,0.005593699868768454,1.1292188167572021,-0.0092593003064394],[51,0.005248300265520811,1.1293869018554688,-0.009392499923706055],[52,0.004888900090008974,1.1295385360717773,-0.009514099918305874],[53,0.00451680039986968,1.1296719312667847,-0.009623399935662746],[54,0.004133300390094519,1.129785180091858,-0.009720000438392162],[55,0.003739700186997652,1.1298764944076538,-0.009803200140595436],[56,0.0033371001482009888,1.12994384765625,-0.009872599504888058],[57,0.002926900051534176,1.1299856901168823,-0.009927500039339066],[58,0.0025104000233113766,1.1299999952316284,-0.009967400692403316],[59,0.002088800072669983,1.1299856901168823,-0.009991800412535667],[60,0.0016634000930935144,1.12994384765625,-0.010000000707805157],[61,0.0012353999773040414,1.1298764944076538,-0.009991800412535667],[62,0.0008061000262387097,1.129785180091858,-0.009967400692403316],[63,0.0003769000177271664,1.1296719312667847,-0.009927500039339066],[64,-0.00005109999983687885,1.1295385360717773,-0.009872599504888058],[65,-0.0004765000194311142,1.1293869018554688,-0.009803200140595436],[66,-0.0008980999700725079,1.1292188167572021,-0.009720000438392162],[67,-0.0013146999990567565,1.1290358304977417,-0.009623399935662746],[68,-0.0017247999785467982,1.128840446472168,-0.009514099918305874],[69,-0.0021274001337587833,1.128633737564087,-0.009392499923706055],[70,-0.0025211002212017775,1.12841796875,-0.0092593003064394],[71,-0.002904600230976939,1.1281949281692505,-0.009114900603890419],[72,-0.0032766000367701054,1.127966284751892,-0.008960000239312649],[73,-0.0036359999794512987,1.1277340650558472,-0.008795100264251232],[74,-0.003981399815529585,1.1274999380111694,-0.008620700798928738],[75,-0.004311500117182732,1.1272659301757812,-0.008437500335276127],[76,-0.004625100176781416,1.1270337104797363,-0.008245900273323059],[77,-0.004920999985188246,1.1268051862716675,-0.00804660003632307],[78,-0.00519770011305809,1.126582145690918,-0.007840000092983246],[79,-0.005454200319945812,1.1263662576675415,-0.007626800332218409],[80,-0.005689000245183706,1.12615966796875,-0.007407400291413069],[81,-0.0059009999968111515,1.1259640455245972,-0.00718249985948205],[82,-0.006088800262659788,1.1257814168930054,-0.006952600087970495],[83,-0.006251300219446421,1.1256130933761597,-0.006718199700117111],[84,-0.006386999972164631,1.125461459159851,-0.006480000447481871],[85,-0.006494800094515085,1.1253280639648438,-0.006238400004804134],[86,-0.006573300343006849,1.12521493434906,-0.005994100123643875],[87,-0.006621400360018015,1.1251236200332642,-0.005747500341385603],[88,-0.006637699902057648,1.1250561475753784,-0.005499300081282854],[89,-0.006626500282436609,1.125014305114746,-0.0052499002777040005],[90,-0.006593599915504456,1.125,-0.005000000353902578],[91,-0.006539800204336643,1.1250163316726685,-0.004750100430101156],[92,-0.006465999875217676,1.1250637769699097,-0.004500700160861015],[93,-0.006373200099915266,1.1251400709152222,-0.004252500366419554],[94,-0.006262300070375204,1.125243067741394,-0.004005900118499994],[95,-0.0061342003755271435,1.1253703832626343,-0.0037616000045090914],[96,-0.005989700090140104,1.12552011013031,-0.0035200000274926424],[97,-0.005829900037497282,1.1256896257400513,-0.003281800076365471],[98,-0.005655600223690271,1.125877022743225,-0.0030473999213427305],[99,-0.005467699840664864,1.12608003616333,-0.002817500149831176],[100,-0.005267099943011999,1.1262964010238647,-0.0025925999507308006],[101,-0.00505479983985424,1.126523733139038,-0.002373199909925461],[102,-0.004831700120121241,1.1267600059509277,-0.0021600001491606236],[103,-0.004598600324243307,1.1270030736923218,-0.0019533999729901552],[104,-0.0043565998785197735,1.1272504329681396,-0.0017541000852361321],[105,-0.004106400068849325,1.1274999380111694,-0.0015625000232830644],[106,-0.0038490002043545246,1.1277496814727783,-0.001379300025291741],[107,-0.0035852999426424503,1.1279970407485962,-0.0012048999778926373],[108,-0.0033162999898195267,1.1282399892807007,-0.0010400000028312206],[109,-0.0030428001191467047,1.1284763813018799,-0.0008851000457070768],[110,-0.002765699988231063,1.1287037134170532,-0.0007406999939121306],[111,-0.002486000070348382,1.1289199590682983,-0.0006075000273995101],[112,-0.0022046000231057405,1.1291229724884033,-0.0004859000036958605],[113,-0.001922300085425377,1.1293104887008667,-0.0003766000154428184],[114,-0.0016401000320911407,1.129480004310608,-0.0002800000074785203],[115,-0.0013589999871328473,1.1296296119689941,-0.00019680001423694193],[116,-0.001079699955880642,1.129757046699524,-0.00012740000966005027],[117,-0.0008033000049181283,1.1298600435256958,-0.00007249999907799065],[118,-0.0005306000239215791,1.1299363374710083,-0.00003260000084992498],[119,-0.0002624999906402081,1.1299837827682495,-0.000008199999683711212],[120,0,1.1299999952316284,0]]}]},"4867":{"name":"MnG09KameAni_kame_wait.gmt","root":"center_n","frames":120,"fps":30,"loop":true,"translation":[{"axis":"xyz","keys":[[0,-0.04182429984211922,1.3200130462646484,0.450496107339859],[1,-0.04144600033760071,1.3199727535247803,0.45049968361854553],[2,-0.04104439914226532,1.3198527097702026,0.45048728585243225],[3,-0.04062109813094139,1.3196591138839722,0.45045962929725647],[4,-0.04017780348658562,1.3193981647491455,0.4504168927669525],[5,-0.0397161990404129,1.3190759420394897,0.45035991072654724],[6,-0.039237700402736664,1.3186988830566406,0.4502890110015869],[7,-0.03874420002102852,1.3182729482650757,0.4502048194408417],[8,-0.038237299770116806,1.3178044557571411,0.4501078128814697],[9,-0.037718500941991806,1.3172993659973145,0.4499986171722412],[10,-0.03718959912657738,1.316764235496521,0.4498775899410248],[11,-0.0366520993411541,1.3162047863006592,0.44974541664123535],[12,-0.03610780090093613,1.3156274557113647,0.4496026039123535],[13,-0.0355583019554615,1.3150384426116943,0.44944968819618225],[14,-0.035005200654268265,1.3144439458847046,0.4492872357368469],[15,-0.03445009887218475,1.313849925994873,0.44911572337150574],[16,-0.033894699066877365,1.3132628202438354,0.44893571734428406],[17,-0.0333407036960125,1.3126887083053589,0.4487476944923401],[18,-0.032789599150419235,1.312134027481079,0.44855234026908875],[19,-0.03224320337176323,1.311604619026184,0.44835010170936584],[20,-0.031703002750873566,1.31110680103302,0.4481417238712311],[21,-0.0311708003282547,1.310646891593933,0.4479275345802307],[22,-0.030647998675704002,1.31023108959198,0.4477081000804901],[23,-0.03013649955391884,1.3098653554916382,0.44748422503471375],[24,-0.02963779866695404,1.309556245803833,0.44725629687309265],[25,-0.029153499752283096,1.3093098402023315,0.4470249116420746],[26,-0.028685299679636955,1.3091322183609009,0.4467906057834625],[27,-0.028234899044036865,1.3090213537216187,0.4465540051460266],[28,-0.027804601937532425,1.308971643447876,0.44631609320640564],[29,-0.027395499870181084,1.3089836835861206,0.44607850909233093],[30,-0.02700839936733246,1.309058427810669,0.4458428919315338],[31,-0.026649801060557365,1.3091957569122314,0.4456093907356262],[32,-0.02632809989154339,1.309391975402832,0.4453775882720947],[33,-0.02604690007865429,1.3096425533294678,0.4451478123664856],[34,-0.025810200721025467,1.3099429607391357,0.44491979479789734],[35,-0.025629699230194092,1.3102890253067017,0.44469329714775085],[36,-0.02551420032978058,1.3106763362884521,0.4444678723812103],[37,-0.025466499850153923,1.3111002445220947,0.4442441165447235],[38,-0.02548840083181858,1.3115559816360474,0.4440223276615143],[39,-0.025578901171684265,1.3120384216308594,0.4438033103942871],[40,-0.02573690190911293,1.3125425577163696,0.4435875117778778],[41,-0.02595910243690014,1.3130635023117065,0.4433755874633789],[42,-0.026242000982165337,1.3135968446731567,0.4431680142879486],[43,-0.026581699028611183,1.3141378164291382,0.44296523928642273],[44,-0.026974299922585487,1.314681887626648,0.4427679181098938],[45,-0.02741600014269352,1.3152241706848145,0.44257649779319763],[46,-0.02790280058979988,1.3157603740692139,0.44239160418510437],[47,-0.02843089960515499,1.3162857294082642,0.44221383333206177],[48,-0.02899630181491375,1.3167957067489624,0.44204360246658325],[49,-0.02959510125219822,1.317285418510437,0.44188180565834045],[50,-0.03022339940071106,1.3177506923675537,0.441728800535202],[51,-0.03087710216641426,1.3181865215301514,0.44158539175987244],[52,-0.031552400439977646,1.3185884952545166,0.44145211577415466],[53,-0.03224530071020126,1.3189518451690674,0.4413297176361084],[54,-0.03295179829001427,1.3192720413208008,0.4412188231945038],[55,-0.033668000251054764,1.3195446729660034,0.441119909286499],[56,-0.03438999876379967,1.3197649717330933,0.4410336911678314],[57,-0.035113703459501266,1.319928526878357,0.4409608840942383],[58,-0.035835299640893936,1.3200305700302124,0.4409022033214569],[59,-0.03657760098576546,1.320067286491394,0.44085580110549927],[60,-0.03736310079693794,1.3200371265411377,0.44082021713256836],[61,-0.03818710148334503,1.3199399709701538,0.4407957196235657],[62,-0.03904449939727783,1.3197797536849976,0.4407823979854584],[63,-0.039930399507284164,1.3195607662200928,0.4407801330089569],[64,-0.04083989933133125,1.3192877769470215,0.44078871607780457],[65,-0.041767802089452744,1.3189653158187866,0.44080767035484314],[66,-0.042708899825811386,1.3185982704162598,0.4408371150493622],[67,-0.0436583012342453,1.3181911706924438,0.4408768117427826],[68,-0.04461110010743141,1.3177485466003418,0.4409264028072357],[69,-0.045562200248241425,1.317275047302246,0.44098591804504395],[70,-0.046506598591804504,1.3167755603790283,0.44105520844459534],[71,-0.04743950068950653,1.316254734992981,0.44113412499427795],[72,-0.04835590347647667,1.3157172203063965,0.4412226378917694],[73,-0.04925080016255379,1.315167784690857,0.4413207173347473],[74,-0.050119198858737946,1.3146110773086548,0.4414280951023102],[75,-0.050956398248672485,1.3140519857406616,0.4415450990200043],[76,-0.05175730213522911,1.31349515914917,0.44167134165763855],[77,-0.05251700431108475,1.3129454851150513,0.4418068826198578],[78,-0.05323070287704468,1.312407374382019,0.4419519007205963],[79,-0.05389329791069031,1.3118860721588135,0.44210630655288696],[80,-0.05450009927153587,1.311385989189148,0.44227010011672974],[81,-0.05504610016942024,1.310912013053894,0.44244319200515747],[82,-0.05552629753947258,1.3104690313339233,0.44262591004371643],[83,-0.055935900658369064,1.3100618124008179,0.4428180158138275],[84,-0.05626999959349632,1.3096953630447388,0.4430195987224579],[85,-0.05652589723467827,1.3093734979629517,0.44323068857192993],[86,-0.05670120194554329,1.3091005086898804,0.44345149397850037],[87,-0.056791700422763824,1.3088809251785278,0.4436817169189453],[88,-0.05679300054907799,1.308719277381897,0.44392162561416626],[89,-0.056709300726652145,1.3086202144622803,0.44417062401771545],[90,-0.056550201028585434,1.3085883855819702,0.444428026676178],[91,-0.05633140355348587,1.3086289167404175,0.4446915090084076],[92,-0.056067999452352524,1.3087403774261475,0.4449591338634491],[93,-0.055762600153684616,1.30891752243042,0.44522982835769653],[94,-0.05541810020804405,1.3091553449630737,0.44550272822380066],[95,-0.0550369992852211,1.3094489574432373,0.4457767903804779],[96,-0.0546221025288105,1.3097928762435913,0.44605159759521484],[97,-0.054176002740859985,1.3101824522018433,0.44632622599601746],[98,-0.053701598197221756,1.310612440109253,0.44659939408302307],[99,-0.05320170149207115,1.311077356338501,0.4468705356121063],[100,-0.05267900228500366,1.3115721940994263,0.44713839888572693],[101,-0.05213649943470955,1.3120920658111572,0.4474022090435028],[102,-0.05157729983329773,1.3126317262649536,0.44766131043434143],[103,-0.05100420117378235,1.3131864070892334,0.44791460037231445],[104,-0.05041990429162979,1.3137507438659668,0.4481610953807831],[105,-0.049827300012111664,1.3143199682235718,0.4484001100063324],[106,-0.04922910034656525,1.314888834953308,0.44863054156303406],[107,-0.048628199845552444,1.3154524564743042,0.44885149598121643],[108,-0.048027101904153824,1.3160055875778198,0.4490624964237213],[109,-0.04742870107293129,1.316543459892273,0.44926270842552185],[110,-0.046835701912641525,1.317060947418213,0.449451208114624],[111,-0.046250902116298676,1.317552924156189,0.4496271312236786],[112,-0.045677199959754944,1.3180146217346191,0.4497896134853363],[113,-0.04511740058660507,1.3184407949447632,0.4499375820159912],[114,-0.044574301689863205,1.3188265562057495,0.4500702917575836],[115,-0.04405070096254349,1.3191670179367065,0.45018693804740906],[116,-0.04354939982295036,1.319456934928894,0.4502863883972168],[117,-0.043073300272226334,1.31969153881073,0.45036789774894714],[118,-0.042625200003385544,1.3198658227920532,0.450430691242218],[119,-0.04220790043473244,1.319974660873413,0.4504736065864563],[120,-0.04182429984211922,1.3200130462646484,0.450496107339859]]}]}};
},
(module, load) => {
'use strict';

const { events, rivals } = load(4);

const surfaces = ['Normal', 'Water', 'Sand', 'Mud'];
const eventsById = new Map(events.map(event => [event.id, event]));
const formScores = [
  [50, 70, 90, 70, 50, 30, 20, 30, 50],
  [60, 60, 65, 70, 65, 60, 40, 40, 60],
  [50, 30, 50, 70, 50, 60, 80, 40, 30],
  [80, 70, 80, 70, 70, 50, 40, 30, 40],
];
const personalities = ['Timid', 'Normal', 'Clumsy', 'Unpredictable', 'Awful'];
const statNames = ['stamina', 'legPower', 'sand', 'water', 'mud', 'fullness'];
const f32 = Math.fround;

function createRaceRng(seed = 1) {
  if (!Number.isInteger(seed) || seed < 0 || seed > 0xffffffff) {
    throw new RangeError('Race RNG seed must be an unsigned 32-bit integer');
  }
  let state = seed;
  let draws = 0;
  function next() {
    state = (Math.imul(85, state) + 127) >>> 0;
    draws += 1;
    return state;
  }
  return {
    next,
    next15: () => next() & 0x7fff,
    next16: () => next() & 0xffff,
    unit16: () => f32((next() & 0xffff) * f32(1 / 65535)),
    get seed() { return state; },
    get draws() { return draws; },
  };
}

function getEvent(eventId) {
  const event = eventsById.get(String(eventId).replace(/^turtle-race-/i, '').toUpperCase());
  if (!event) throw new RangeError(`Unknown turtle race event "${eventId}"`);
  return event;
}

function rollRaceBoard(seedOrRng = 1) {
  const rng = typeof seedOrRng === 'number' ? createRaceRng(seedOrRng) : seedOrRng;
  const startDraws = rng.draws;
  // 0x2AB7E4 rolls the whole board in file order. The low two bits rotate
  // across Random cells because the RNG advances by -1 modulo four.
  const layouts = Object.fromEntries(events.map(event => [
    event.id,
    event.sections.map(surface => surface === 'Random' ? surfaces[rng.next15() % 4] : surface),
  ]));
  return { layouts, seed: rng.seed, draws: rng.draws - startDraws };
}

function byte(value, name) {
  if (!Number.isInteger(value) || value < 0 || value > 255) {
    throw new RangeError(`${name} must be a byte in the range 0 to 255`);
  }
  return value;
}

function normalizeTurtle(turtle, slot) {
  if (!turtle || typeof turtle !== 'object') throw new TypeError('Each starting slot needs a turtle');
  const name = turtle.name ?? `Turtle ${slot + 1}`;
  const personalityId = turtle.personalityId ??
    (typeof turtle.personality === 'number' ? turtle.personality : personalities.indexOf(turtle.personality));
  if (!Number.isInteger(personalityId) || personalities[personalityId] === undefined) {
    throw new RangeError(`${name} needs a known personality`);
  }
  const formScore = turtle.formScore ?? formScores[turtle.formCycle]?.[turtle.formPhase];
  if (!Number.isFinite(formScore) || formScore < 0 || formScore > 100) {
    throw new RangeError(`${name} needs a Form score or valid Form indices`);
  }
  const stats = Object.fromEntries(statNames.map(statName => {
    const stat = turtle.stats?.[statName] ?? turtle[statName] ?? turtle.terrainStats?.[statName];
    const value = byte(typeof stat === 'object' && stat !== null ? stat.value : stat, `${name}'s ${statName}`);
    const max = byte(stat?.max ?? value, `${name}'s ${statName} cap`);
    return [statName, { value, max }];
  }));
  return {
    id: turtle.id ?? turtle.slot ?? slot,
    name,
    personalityId,
    formScore,
    formCycle: turtle.formCycle,
    formPhase: turtle.formPhase,
    affinity: byte(turtle.affinity, `${name}'s affinity`),
    rankId: turtle.rankId,
    speciesId: turtle.speciesId,
    runtime: turtle.runtime,
    stats,
  };
}

function formMultiplier(score) {
  // 0x2A9328 divides by 50 first and performs the final multiply-add.
  return f32(f32(f32(score / 50) - 1) * .25 + 1);
}

function rating(turtle) {
  const { stamina, fullness, legPower, sand, water, mud } = turtle.stats;
  const sum = stamina.max + fullness.max + legPower.value + legPower.max +
    sand.value + sand.max + water.value + water.max + mud.value + mud.max;
  return Math.trunc(f32(f32(sum / 2550) * 100));
}

function condition(turtle) {
  // 0x2A95F4, the form/trust/fullness condition used only by rival filters.
  const form = formMultiplier(turtle.formScore);
  const trust = turtle.affinity;
  const fullness = turtle.stats.fullness.value;
  const effectiveFullness = turtle.personalityId === 2 ? 255 - fullness : fullness;
  if (trust >= 193 && effectiveFullness < 64 && form >= f32(1.05)) {
    return form >= f32(1.15) ? 1 : 3;
  }
  if (trust < 64 && effectiveFullness >= 193 && form < 1) {
    return form < f32(.95) ? 2 : 4;
  }
  if (trust >= 129 && effectiveFullness < 128) return 5;
  if (trust < 128 && effectiveFullness >= 129) return 6;
  return 0;
}

function meetsRivalRule(rival, rule) {
  if (rule === 'NONE') return true;
  if (rule === 'M_LIFE') return rival.lifespan.remaining * 10 <= rival.lifespan.initial;
  if (rule === 'M_LOSE') return rating(rival) <= 60 && ![1, 3, 5].includes(condition(rival));
  if (rule === 'S_WIN' || rule === 'M_WIN') {
    return rating(rival) >= (rule === 'S_WIN' ? 40 : 80) && ![2, 4, 6].includes(condition(rival));
  }
  const statName = rule.endsWith('_ENERGY') ? 'stamina' : rule.slice(2).toLowerCase();
  if (rule.startsWith('O_')) return rival.stats[statName].value >= 102;
  return rival.stats[statName].value >= 153 && rival.stats.legPower.value >= 204;
}

function rollRival(template, rankId, rng) {
  function rollStat(name) {
    const { base, amplitude } = template.stats[name];
    return { value: Math.min(255, base + (amplitude ? rng.next15() % amplitude : 0)), max: Math.min(255, base + amplitude) };
  }
  const stamina = rollStat('stamina');
  const formCycle = rng.next15() % 4;
  const formPhase = rng.next15() % 9;
  const stats = {
    stamina,
    legPower: rollStat('legPower'),
    sand: rollStat('sand'),
    water: rollStat('water'),
    mud: rollStat('mud'),
    fullness: rollStat('fullness'),
  };
  const affinity = 63 + rng.next15() % 128;
  const growthPattern = rng.next15() % 4;
  return {
    id: template.id,
    name: template.name,
    speciesId: template.speciesId,
    rankId,
    personalityId: template.personalityId,
    formCycle,
    formPhase,
    formScore: formScores[formCycle][formPhase],
    affinity,
    growthPattern,
    lifespan: { initial: 300, remaining: template.nativeTags.includes('老') ? 10 : 300 },
    stats,
  };
}

function generateRivalLineup({ eventId, player, seed = 1, rng = createRaceRng(seed), titleRaceFix = false,
  maxRivalAttempts = 0x8000 } = {}) {
  const event = getEvent(eventId);
  const entrant = normalizeTurtle(player, 0);
  const entrantRating = rating(entrant);
  const raceClass = event.id[0];
  const rankId = 'HKSOYM'.indexOf(raceClass);
  // 0x2ADC4C subtracts the first index from the last, without adding one.
  const pool = rivals.filter(template => raceClass === 'M'
    ? 'OY'.includes(template.rankPool) : template.rankPool === raceClass).slice(0, -1);
  const startDraws = rng.draws;
  const used = new Set();
  const lineup = [entrant];
  let attempts = 0;
  const result = (status, reason) => ({
    status, reason, lineup, attempts, seed: rng.seed, draws: rng.draws - startDraws, entrantRating,
  });
  if (!titleRaceFix && event.rivalRule === 'M_WIN' && entrantRating <= 59) {
    return result('no-start', 'The original title race cannot fill four rival slots for an entrant rated 59 or lower.');
  }
  if (!Number.isInteger(maxRivalAttempts) || maxRivalAttempts < 1) {
    throw new RangeError('maxRivalAttempts must be a positive integer');
  }

  // The race module consumes one draw on every slot's initialization.
  entrant.runtime = { ...entrant.runtime, laneFlag: rng.unit16() < .5 ? 32 : 0 };
  const tagAllowed = template => !(entrantRating < 80 && template.nativeTags.includes('最')) &&
    !(entrantRating < 60 && template.nativeTags.includes('強'));
  while (lineup.length < 5) {
    const rivalRank = raceClass === 'M' ? 3 + (rng.next() & 1) : rankId;
    let index;
    do {
      index = rng.next15() % pool.length;
    } while (used.has(index));
    for (let trial = 0; trial < maxRivalAttempts; trial += 1) {
      const template = pool[index];
      const candidate = rollRival(template, rivalRank, rng);
      attempts += 1;
      const force = titleRaceFix && trial + 1 >= 0x7f00;
      const allowTagged = titleRaceFix && trial + 1 >= 0x4000;
      if (force || ((allowTagged || tagAllowed(template)) && meetsRivalRule(candidate, event.rivalRule))) {
        used.add(index);
        candidate.runtime = { laneFlag: rng.unit16() < .5 ? 32 : 0 };
        lineup.push(candidate);
        break;
      }
      if (trial + 1 === maxRivalAttempts) {
        return result('no-start', 'The rival selection limit was reached before the field filled.');
      }
      do {
        index = (index + 1) % pool.length;
      } while (used.has(index));
    }
  }
  return result('ready');
}

module.exports = { createRaceRng, formMultiplier, generateRivalLineup, getEvent, normalizeTurtle, rating, rollRaceBoard, surfaces };

},
(module, load) => {
module.exports = {"sourceSha256":{"bin/kame/race.bin":"3b407f8b857c5d43291ff9516ad49e10f349931a2befd894f2af11c56cd47d9b","bin/kame/kame_race.bin":"93cb94de6c5f08948182229bff4255ae18c5ec1680112dca4ca037c196a40304","bin/kame/jikkyou.bin":"24d326495e0ab129eb3f42d15a073711f76e43e5de4dc6682cd149c6d1c6d557","kenzan_english.elf":"aa11d061b53b081f04f728a3da6e3b8cf9ec8ab13430e754d3b450366757d781","bin/pausepar/pause.par::item.bin":"83aec44a4815b3917a8ac10354180bda889d8eb2b868234a6ce7cbe656eaac27"},"events":[{"id":"H00","guideId":"turtle-race-h00","guideName":"Dawn GP","nativeName":"あけぼの賞","entryFeeMon":500,"prizeMon":1000,"sections":["Normal","Normal"],"playerRule":"NONE","rivalRule":"NONE"},{"id":"H01","guideId":"turtle-race-h01","guideName":"Novice Turtle Cup","nativeName":"新亀杯","entryFeeMon":500,"prizeMon":1000,"sections":["Normal","Normal"],"playerRule":"NONE","rivalRule":"NONE"},{"id":"H02","guideId":"turtle-race-h02","guideName":"Dragon Gate Award","nativeName":"登竜門記念","entryFeeMon":500,"prizeMon":1200,"sections":["Random","Random","Random"],"playerRule":"NONE","rivalRule":"NONE"},{"id":"H03","guideId":"turtle-race-h03","guideName":"Crystal Cup","nativeName":"水晶杯","entryFeeMon":500,"prizeMon":1000,"sections":["Water","Water"],"playerRule":"NONE","rivalRule":"NONE"},{"id":"H04","guideId":"turtle-race-h04","guideName":"Iron Trophy GP","nativeName":"鉄杯賞","entryFeeMon":500,"prizeMon":1000,"sections":["Normal","Sand"],"playerRule":"NONE","rivalRule":"NONE"},{"id":"H05","guideId":"turtle-race-h05","guideName":"White Chrysanthemum Cup","nativeName":"白菊杯","entryFeeMon":500,"prizeMon":1000,"sections":["Random","Random"],"playerRule":"NONE","rivalRule":"NONE"},{"id":"H06","guideId":"turtle-race-h06","guideName":"Autumn Leaf Cup","nativeName":"紅葉杯","entryFeeMon":500,"prizeMon":1000,"sections":["Sand","Normal"],"playerRule":"NONE","rivalRule":"NONE"},{"id":"H07","guideId":"turtle-race-h07","guideName":"Beginner's Spirit Cup","nativeName":"初心杯","entryFeeMon":500,"prizeMon":1000,"sections":["Normal","Random"],"playerRule":"NONE","rivalRule":"NONE"},{"id":"H08","guideId":"turtle-race-h08","guideName":"Hololeion Cup","nativeName":"水蘭杯","entryFeeMon":500,"prizeMon":1000,"sections":["Normal","Water"],"playerRule":"NONE","rivalRule":"NONE"},{"id":"H09","guideId":"turtle-race-h09","guideName":"Rising Turtle GP","nativeName":"昇亀賞","entryFeeMon":500,"prizeMon":1200,"sections":["Sand","Water","Mud"],"playerRule":"NONE","rivalRule":"NONE"},{"id":"K00","guideId":"turtle-race-k00","guideName":"Bronze Trophy GP","nativeName":"銅杯賞","entryFeeMon":1000,"prizeMon":1800,"sections":["Mud","Normal","Mud"],"playerRule":"NONE","rivalRule":"NONE"},{"id":"K01","guideId":"turtle-race-k01","guideName":"Tsukuyomi GP","nativeName":"月読賞","entryFeeMon":1000,"prizeMon":2000,"sections":["Normal","Sand","Normal"],"playerRule":"NONE","rivalRule":"NONE"},{"id":"K02","guideId":"turtle-race-k02","guideName":"Falcon GP","nativeName":"はやぶさ賞","entryFeeMon":1000,"prizeMon":2500,"sections":["Random","Random","Random"],"playerRule":"NONE","rivalRule":"NONE"},{"id":"K03","guideId":"turtle-race-k03","guideName":"Rosewood Cup","nativeName":"紫檀杯","entryFeeMon":1000,"prizeMon":2000,"sections":["Normal","Normal","Normal"],"playerRule":"NONE","rivalRule":"NONE"},{"id":"K04","guideId":"turtle-race-k04","guideName":"Big Dipper GP","nativeName":"北斗賞","entryFeeMon":1000,"prizeMon":2000,"sections":["Sand","Random","Sand"],"playerRule":"NONE","rivalRule":"NONE"},{"id":"K05","guideId":"turtle-race-k05","guideName":"Ruby Cup","nativeName":"紅玉杯","entryFeeMon":1000,"prizeMon":2500,"sections":["Random","Random","Random"],"playerRule":"NONE","rivalRule":"NONE"},{"id":"K06","guideId":"turtle-race-k06","guideName":"Red Clover Cup","nativeName":"紅萩杯","entryFeeMon":1000,"prizeMon":2500,"sections":["Random","Random","Random"],"playerRule":"NONE","rivalRule":"NONE"},{"id":"K07","guideId":"turtle-race-k07","guideName":"Grey Heron GP","nativeName":"あおさぎ賞","entryFeeMon":1000,"prizeMon":2500,"sections":["Random","Water","Random"],"playerRule":"NONE","rivalRule":"NONE"},{"id":"K08","guideId":"turtle-race-k08","guideName":"First Storm GP","nativeName":"初嵐賞","entryFeeMon":1000,"prizeMon":2200,"sections":["Mud","Random","Mud"],"playerRule":"NONE","rivalRule":"NONE"},{"id":"K09","guideId":"turtle-race-k09","guideName":"Silver Dragon Cup","nativeName":"銀竜杯","entryFeeMon":1000,"prizeMon":2200,"sections":["Sand","Random","Sand"],"playerRule":"NONE","rivalRule":"NONE"},{"id":"S00","guideId":"turtle-race-s00","guideName":"Green Jade Cup","nativeName":"翡翠杯","entryFeeMon":1000,"prizeMon":3500,"sections":["Random","Random","Random"],"playerRule":"NONE","rivalRule":"NONE"},{"id":"S01","guideId":"turtle-race-s01","guideName":"Silver Trophy GP","nativeName":"銀杯賞","entryFeeMon":1000,"prizeMon":3000,"sections":["Mud","Normal","Mud","Normal"],"playerRule":"NONE","rivalRule":"NONE"},{"id":"S02","guideId":"turtle-race-s02","guideName":"Great Fortune Cup","nativeName":"吉祥杯","entryFeeMon":1000,"prizeMon":3500,"sections":["Random","Random","Random","Random"],"playerRule":"NONE","rivalRule":"NONE"},{"id":"S03","guideId":"turtle-race-s03","guideName":"Genbu Cup","nativeName":"玄武杯","entryFeeMon":1000,"prizeMon":3500,"sections":["Random","Random","Random"],"playerRule":"OTHER3_WIN","rivalRule":"S_WIN"},{"id":"S04","guideId":"turtle-race-s04","guideName":"Byakko Cup","nativeName":"白虎杯","entryFeeMon":1000,"prizeMon":3000,"sections":["Normal","Sand","Normal"],"playerRule":"NONE","rivalRule":"NONE"},{"id":"S05","guideId":"turtle-race-s05","guideName":"Suzaku Cup","nativeName":"朱雀杯","entryFeeMon":1000,"prizeMon":3500,"sections":["Water","Random","Water"],"playerRule":"NONE","rivalRule":"NONE"},{"id":"S06","guideId":"turtle-race-s06","guideName":"Seiryu Cup","nativeName":"青龍杯","entryFeeMon":1000,"prizeMon":3000,"sections":["Water","Sand","Water"],"playerRule":"NONE","rivalRule":"NONE"},{"id":"S07","guideId":"turtle-race-s07","guideName":"Ultramarine Cup","nativeName":"群青杯","entryFeeMon":1000,"prizeMon":3000,"sections":["Water","Normal","Water"],"playerRule":"NONE","rivalRule":"NONE"},{"id":"S08","guideId":"turtle-race-s08","guideName":"Swift Wind GP","nativeName":"疾風賞","entryFeeMon":1000,"prizeMon":3000,"sections":["Normal","Normal","Normal"],"playerRule":"NONE","rivalRule":"NONE"},{"id":"S09","guideId":"turtle-race-s09","guideName":"November Rain Cup","nativeName":"時雨杯","entryFeeMon":1000,"prizeMon":3500,"sections":["Random","Random","Random"],"playerRule":"NONE","rivalRule":"NONE"},{"id":"O00","guideId":"turtle-race-o00","guideName":"Nirvana GP","nativeName":"彼岸賞","entryFeeMon":2000,"prizeMon":5000,"sections":["Random","Random","Random","Random"],"playerRule":"NONE","rivalRule":"NONE"},{"id":"O01","guideId":"turtle-race-o01","guideName":"Silver Grass Special Cup","nativeName":"すすき特別杯","entryFeeMon":2000,"prizeMon":5000,"sections":["Normal","Sand","Normal","Sand"],"playerRule":"NONE","rivalRule":"NONE"},{"id":"O02","guideId":"turtle-race-o02","guideName":"Heian Special Cup","nativeName":"平安特別杯","entryFeeMon":2000,"prizeMon":5000,"sections":["Random","Random","Random","Random"],"playerRule":"NONE","rivalRule":"NONE"},{"id":"O03","guideId":"turtle-race-o03","guideName":"Gold Trophy GP","nativeName":"金杯賞","entryFeeMon":2000,"prizeMon":4000,"sections":["Mud","Normal","Mud","Normal","Mud"],"playerRule":"NONE","rivalRule":"NONE"},{"id":"O04","guideId":"turtle-race-o04","guideName":"Water Turtle Special Cup","nativeName":"水亀特別杯","entryFeeMon":2000,"prizeMon":4000,"sections":["Normal","Normal","Water","Water"],"playerRule":"NONE","rivalRule":"O_WATER"},{"id":"O05","guideId":"turtle-race-o05","guideName":"Sand Turtle Special Cup","nativeName":"砂亀特別杯","entryFeeMon":2000,"prizeMon":4000,"sections":["Normal","Normal","Sand","Sand"],"playerRule":"NONE","rivalRule":"O_SAND"},{"id":"O06","guideId":"turtle-race-o06","guideName":"Mud Turtle Special Cup","nativeName":"泥亀特別杯","entryFeeMon":2000,"prizeMon":4000,"sections":["Normal","Normal","Mud","Mud"],"playerRule":"NONE","rivalRule":"O_MUD"},{"id":"O07","guideId":"turtle-race-o07","guideName":"Indigo Cup","nativeName":"紫紺杯","entryFeeMon":2000,"prizeMon":5000,"sections":["Random","Random","Random","Random"],"playerRule":"NONE","rivalRule":"NONE"},{"id":"O08","guideId":"turtle-race-o08","guideName":"Hibiscus Cup","nativeName":"芙蓉杯","entryFeeMon":2000,"prizeMon":4000,"sections":["Mud","Random","Random","Mud"],"playerRule":"NONE","rivalRule":"NONE"},{"id":"O09","guideId":"turtle-race-o09","guideName":"Golden Wind Cup","nativeName":"金風賞","entryFeeMon":2000,"prizeMon":4000,"sections":["Normal","Sand","Water","Mud"],"playerRule":"NONE","rivalRule":"NONE"},{"id":"Y00","guideId":"turtle-race-y00","guideName":"Japan Cup","nativeName":"日ノ本杯","entryFeeMon":3000,"prizeMon":8000,"sections":["Random","Random","Random","Random"],"playerRule":"NONE","rivalRule":"NONE"},{"id":"Y01","guideId":"turtle-race-y01","guideName":"Gion Cup","nativeName":"祗園杯","entryFeeMon":3000,"prizeMon":7000,"sections":["Normal","Water","Normal","Water"],"playerRule":"NONE","rivalRule":"NONE"},{"id":"Y02","guideId":"turtle-race-y02","guideName":"Skanda GP","nativeName":"韋駄天賞","entryFeeMon":3000,"prizeMon":7000,"sections":["Normal","Normal","Normal","Normal","Normal"],"playerRule":"NONE","rivalRule":"NONE"},{"id":"Y03","guideId":"turtle-race-y03","guideName":"Water King Special Cup","nativeName":"水王特別杯","entryFeeMon":3000,"prizeMon":7000,"sections":["Water","Water","Water","Water","Water"],"playerRule":"NONE","rivalRule":"Y_WATER"},{"id":"Y04","guideId":"turtle-race-y04","guideName":"Sand King Special Cup","nativeName":"砂王特別杯","entryFeeMon":3000,"prizeMon":7000,"sections":["Sand","Sand","Sand","Sand","Sand"],"playerRule":"NONE","rivalRule":"Y_SAND"},{"id":"Y05","guideId":"turtle-race-y05","guideName":"Mud King Special Cup","nativeName":"泥王特別杯","entryFeeMon":3000,"prizeMon":7000,"sections":["Mud","Mud","Mud","Mud","Mud"],"playerRule":"NONE","rivalRule":"Y_MUD"},{"id":"Y06","guideId":"turtle-race-y06","guideName":"Long-Distance King Cup","nativeName":"長距離王杯","entryFeeMon":3000,"prizeMon":7000,"sections":["Normal","Normal","Normal","Normal","Normal"],"playerRule":"NONE","rivalRule":"Y_ENERGY"},{"id":"Y07","guideId":"turtle-race-y07","guideName":"Mid-Autumn GP","nativeName":"中秋賞","entryFeeMon":3000,"prizeMon":7000,"sections":["Sand","Water","Sand"],"playerRule":"NONE","rivalRule":"NONE"},{"id":"Y08","guideId":"turtle-race-y08","guideName":"Autumn Breeze Award","nativeName":"秋風記念","entryFeeMon":3000,"prizeMon":7500,"sections":["Random","Sand","Random","Sand"],"playerRule":"NONE","rivalRule":"NONE"},{"id":"Y09","guideId":"turtle-race-y09","guideName":"Sunrise GP","nativeName":"日輪賞","entryFeeMon":3000,"prizeMon":8000,"sections":["Random","Random","Random","Random"],"playerRule":"NONE","rivalRule":"NONE"},{"id":"M00","guideId":"turtle-race-m00","guideName":"Adamantine Cup","nativeName":"金剛杯","entryFeeMon":3000,"prizeMon":7000,"sections":["Random","Random","Random","Random"],"playerRule":"YOKOZUNA_COMP","rivalRule":"M_WIN"},{"id":"M01","guideId":"turtle-race-m01","guideName":"Shiranui Cup","nativeName":"不知火杯","entryFeeMon":3000,"prizeMon":6000,"sections":["Mud","Random","Mud","Random"],"playerRule":"NONE","rivalRule":"NONE"},{"id":"M02","guideId":"turtle-race-m02","guideName":"Vaisravana Cup","nativeName":"毘沙門杯","entryFeeMon":3000,"prizeMon":7000,"sections":["Random","Random","Random","Random"],"playerRule":"NONE","rivalRule":"NONE"},{"id":"M03","guideId":"turtle-race-m03","guideName":"Meteor Cup","nativeName":"流星杯","entryFeeMon":3000,"prizeMon":6000,"sections":["Normal","Normal","Random","Random"],"playerRule":"NONE","rivalRule":"NONE"},{"id":"M04","guideId":"turtle-race-m04","guideName":"Phoenix GP","nativeName":"鳳凰賞","entryFeeMon":3000,"prizeMon":6000,"sections":["Mud","Mud","Mud"],"playerRule":"NONE","rivalRule":"NONE"},{"id":"M05","guideId":"turtle-race-m05","guideName":"Divine Wind Cup","nativeName":"神風賞","entryFeeMon":3000,"prizeMon":7000,"sections":["Random","Random","Water","Random","Random"],"playerRule":"NONE","rivalRule":"NONE"},{"id":"M06","guideId":"turtle-race-m06","guideName":"Mt. Fuji Cup","nativeName":"富士杯","entryFeeMon":3000,"prizeMon":6000,"sections":["Random","Normal","Water","Sand","Random"],"playerRule":"NONE","rivalRule":"NONE"},{"id":"M07","guideId":"turtle-race-m07","guideName":"Dazzling GP","nativeName":"絢爛賞","entryFeeMon":3000,"prizeMon":7000,"sections":["Random","Random","Random","Random"],"playerRule":"NONE","rivalRule":"NONE"},{"id":"M08","guideId":"turtle-race-m08","guideName":"Hundred Flower Cup","nativeName":"百花杯","entryFeeMon":3000,"prizeMon":6000,"sections":["Water","Normal","Water","Normal"],"playerRule":"NONE","rivalRule":"NONE"},{"id":"M09","guideId":"turtle-race-m09","guideName":"Senior's GP","nativeName":"白寿賞","entryFeeMon":3000,"prizeMon":6000,"sections":["Normal","Normal","Normal","Random"],"playerRule":"LIFE_OLD","rivalRule":"M_LIFE"},{"id":"M10","guideId":"turtle-race-m10","guideName":"Endurance King GP","nativeName":"持久王賞","entryFeeMon":3000,"prizeMon":8000,"sections":["Random","Random","Random","Random","Random"],"playerRule":"NONE","rivalRule":"M_ENERGY"},{"id":"M11","guideId":"turtle-race-m11","guideName":"Strongest Undefeated GP","nativeName":"最強無敗賞","entryFeeMon":3000,"prizeMon":8000,"sections":["Random","Random","Random","Random"],"playerRule":"10WIN","rivalRule":"M_WIN"},{"id":"M12","guideId":"turtle-race-m12","guideName":"Biggest Loser Cup","nativeName":"最強敗者杯","entryFeeMon":3000,"prizeMon":8000,"sections":["Random","Random","Random","Random"],"playerRule":"10LOSE","rivalRule":"M_LOSE"}],"rivals":[{"id":"H00","name":"Kamegami","rankPool":"H","speciesId":0,"personalityId":3,"nativeTags":"無","stats":{"stamina":{"base":120,"amplitude":30},"legPower":{"base":69,"amplitude":4},"sand":{"base":56,"amplitude":1},"water":{"base":55,"amplitude":0},"mud":{"base":73,"amplitude":2},"fullness":{"base":150,"amplitude":51}}},{"id":"H01","name":"Ebisugo","rankPool":"H","speciesId":1,"personalityId":3,"nativeTags":"無","stats":{"stamina":{"base":63,"amplitude":2},"legPower":{"base":50,"amplitude":4},"sand":{"base":66,"amplitude":7},"water":{"base":69,"amplitude":9},"mud":{"base":82,"amplitude":3},"fullness":{"base":51,"amplitude":81}}},{"id":"H02","name":"Bishamon","rankPool":"H","speciesId":0,"personalityId":1,"nativeTags":"無","stats":{"stamina":{"base":61,"amplitude":3},"legPower":{"base":89,"amplitude":1},"sand":{"base":64,"amplitude":9},"water":{"base":75,"amplitude":6},"mud":{"base":97,"amplitude":5},"fullness":{"base":54,"amplitude":100}}},{"id":"H03","name":"Baramon","rankPool":"H","speciesId":0,"personalityId":3,"nativeTags":"無","stats":{"stamina":{"base":60,"amplitude":10},"legPower":{"base":52,"amplitude":10},"sand":{"base":84,"amplitude":7},"water":{"base":66,"amplitude":4},"mud":{"base":77,"amplitude":7},"fullness":{"base":43,"amplitude":151}}},{"id":"H04","name":"Enma","rankPool":"H","speciesId":1,"personalityId":0,"nativeTags":"無","stats":{"stamina":{"base":75,"amplitude":8},"legPower":{"base":99,"amplitude":0},"sand":{"base":73,"amplitude":9},"water":{"base":59,"amplitude":3},"mud":{"base":86,"amplitude":7},"fullness":{"base":78,"amplitude":78}}},{"id":"H05","name":"Daienma","rankPool":"H","speciesId":1,"personalityId":2,"nativeTags":"無","stats":{"stamina":{"base":10,"amplitude":100},"legPower":{"base":20,"amplitude":80},"sand":{"base":20,"amplitude":60},"water":{"base":20,"amplitude":60},"mud":{"base":20,"amplitude":60},"fullness":{"base":108,"amplitude":108}}},{"id":"H06","name":"Onigoro","rankPool":"H","speciesId":0,"personalityId":3,"nativeTags":"無","stats":{"stamina":{"base":68,"amplitude":7},"legPower":{"base":85,"amplitude":9},"sand":{"base":84,"amplitude":2},"water":{"base":55,"amplitude":6},"mud":{"base":76,"amplitude":8},"fullness":{"base":79,"amplitude":99}}},{"id":"H07","name":"Hohoemitaro","rankPool":"H","speciesId":1,"personalityId":0,"nativeTags":"無","stats":{"stamina":{"base":53,"amplitude":7},"legPower":{"base":62,"amplitude":4},"sand":{"base":79,"amplitude":2},"water":{"base":93,"amplitude":7},"mud":{"base":82,"amplitude":3},"fullness":{"base":190,"amplitude":9}}},{"id":"H08","name":"Ikigire","rankPool":"H","speciesId":0,"personalityId":0,"nativeTags":"無","stats":{"stamina":{"base":38,"amplitude":20},"legPower":{"base":100,"amplitude":10},"sand":{"base":55,"amplitude":3},"water":{"base":78,"amplitude":6},"mud":{"base":99,"amplitude":8},"fullness":{"base":26,"amplitude":27}}},{"id":"H09","name":"Dongame","rankPool":"H","speciesId":0,"personalityId":1,"nativeTags":"無","stats":{"stamina":{"base":130,"amplitude":9},"legPower":{"base":51,"amplitude":7},"sand":{"base":75,"amplitude":5},"water":{"base":69,"amplitude":10},"mud":{"base":92,"amplitude":2},"fullness":{"base":73,"amplitude":89}}},{"id":"H10","name":"Saikobi","rankPool":"H","speciesId":0,"personalityId":2,"nativeTags":"無","stats":{"stamina":{"base":91,"amplitude":7},"legPower":{"base":100,"amplitude":7},"sand":{"base":75,"amplitude":8},"water":{"base":61,"amplitude":8},"mud":{"base":76,"amplitude":6},"fullness":{"base":81,"amplitude":90}}},{"id":"H11","name":"Katatsumuri","rankPool":"H","speciesId":1,"personalityId":0,"nativeTags":"無","stats":{"stamina":{"base":100,"amplitude":4},"legPower":{"base":60,"amplitude":2},"sand":{"base":89,"amplitude":8},"water":{"base":82,"amplitude":10},"mud":{"base":78,"amplitude":4},"fullness":{"base":163,"amplitude":4}}},{"id":"H12","name":"Dozaemon","rankPool":"H","speciesId":0,"personalityId":0,"nativeTags":"無","stats":{"stamina":{"base":53,"amplitude":9},"legPower":{"base":88,"amplitude":5},"sand":{"base":90,"amplitude":5},"water":{"base":10,"amplitude":3},"mud":{"base":80,"amplitude":0},"fullness":{"base":2,"amplitude":180}}},{"id":"H13","name":"Doroiyan","rankPool":"H","speciesId":1,"personalityId":0,"nativeTags":"無","stats":{"stamina":{"base":80,"amplitude":2},"legPower":{"base":109,"amplitude":1},"sand":{"base":105,"amplitude":4},"water":{"base":85,"amplitude":4},"mud":{"base":5,"amplitude":10},"fullness":{"base":71,"amplitude":99}}},{"id":"H14","name":"Onichiro","rankPool":"H","speciesId":0,"personalityId":3,"nativeTags":"無","stats":{"stamina":{"base":57,"amplitude":3},"legPower":{"base":97,"amplitude":4},"sand":{"base":60,"amplitude":8},"water":{"base":55,"amplitude":3},"mud":{"base":69,"amplitude":6},"fullness":{"base":70,"amplitude":100}}},{"id":"H15","name":"Onijiro","rankPool":"H","speciesId":0,"personalityId":1,"nativeTags":"無","stats":{"stamina":{"base":86,"amplitude":7},"legPower":{"base":70,"amplitude":7},"sand":{"base":75,"amplitude":2},"water":{"base":77,"amplitude":2},"mud":{"base":91,"amplitude":5},"fullness":{"base":40,"amplitude":80}}},{"id":"H16","name":"Onisaburo","rankPool":"H","speciesId":0,"personalityId":1,"nativeTags":"無","stats":{"stamina":{"base":99,"amplitude":2},"legPower":{"base":79,"amplitude":3},"sand":{"base":70,"amplitude":1},"water":{"base":85,"amplitude":7},"mud":{"base":85,"amplitude":4},"fullness":{"base":10,"amplitude":60}}},{"id":"H17","name":"Inari Hayate","rankPool":"H","speciesId":1,"personalityId":2,"nativeTags":"無","stats":{"stamina":{"base":84,"amplitude":4},"legPower":{"base":97,"amplitude":4},"sand":{"base":99,"amplitude":5},"water":{"base":70,"amplitude":4},"mud":{"base":68,"amplitude":1},"fullness":{"base":55,"amplitude":97}}},{"id":"H18","name":"Otohime","rankPool":"H","speciesId":0,"personalityId":2,"nativeTags":"無","stats":{"stamina":{"base":57,"amplitude":8},"legPower":{"base":87,"amplitude":2},"sand":{"base":81,"amplitude":9},"water":{"base":90,"amplitude":1},"mud":{"base":93,"amplitude":6},"fullness":{"base":187,"amplitude":6}}},{"id":"H19","name":"Omoikane","rankPool":"H","speciesId":0,"personalityId":2,"nativeTags":"無","stats":{"stamina":{"base":88,"amplitude":5},"legPower":{"base":70,"amplitude":10},"sand":{"base":58,"amplitude":1},"water":{"base":64,"amplitude":3},"mud":{"base":80,"amplitude":4},"fullness":{"base":156,"amplitude":9}}},{"id":"H20","name":"Kaguya Ichigo","rankPool":"H","speciesId":1,"personalityId":2,"nativeTags":"無","stats":{"stamina":{"base":64,"amplitude":1},"legPower":{"base":85,"amplitude":7},"sand":{"base":88,"amplitude":10},"water":{"base":72,"amplitude":1},"mud":{"base":58,"amplitude":3},"fullness":{"base":158,"amplitude":9}}},{"id":"H21","name":"Omitake","rankPool":"H","speciesId":1,"personalityId":3,"nativeTags":"無","stats":{"stamina":{"base":60,"amplitude":5},"legPower":{"base":76,"amplitude":7},"sand":{"base":60,"amplitude":1},"water":{"base":55,"amplitude":4},"mud":{"base":94,"amplitude":2},"fullness":{"base":81,"amplitude":102}}},{"id":"H22","name":"Idatengo","rankPool":"H","speciesId":1,"personalityId":3,"nativeTags":"無","stats":{"stamina":{"base":75,"amplitude":10},"legPower":{"base":110,"amplitude":8},"sand":{"base":56,"amplitude":8},"water":{"base":62,"amplitude":7},"mud":{"base":75,"amplitude":1},"fullness":{"base":90,"amplitude":107}}},{"id":"H23","name":"Mizuiyan","rankPool":"H","speciesId":0,"personalityId":0,"nativeTags":"無","stats":{"stamina":{"base":120,"amplitude":9},"legPower":{"base":84,"amplitude":1},"sand":{"base":89,"amplitude":20},"water":{"base":5,"amplitude":10},"mud":{"base":62,"amplitude":2},"fullness":{"base":96,"amplitude":98}}},{"id":"H24","name":"Sunaiyan","rankPool":"H","speciesId":0,"personalityId":1,"nativeTags":"無","stats":{"stamina":{"base":101,"amplitude":2},"legPower":{"base":93,"amplitude":10},"sand":{"base":5,"amplitude":10},"water":{"base":95,"amplitude":9},"mud":{"base":84,"amplitude":10},"fullness":{"base":97,"amplitude":96}}},{"id":"H25","name":"Akanyan","rankPool":"H","speciesId":1,"personalityId":0,"nativeTags":"無","stats":{"stamina":{"base":73,"amplitude":2},"legPower":{"base":59,"amplitude":5},"sand":{"base":52,"amplitude":2},"water":{"base":84,"amplitude":8},"mud":{"base":88,"amplitude":8},"fullness":{"base":56,"amplitude":88}}},{"id":"H26","name":"Nametonnoka","rankPool":"H","speciesId":0,"personalityId":0,"nativeTags":"無","stats":{"stamina":{"base":62,"amplitude":7},"legPower":{"base":60,"amplitude":9},"sand":{"base":83,"amplitude":3},"water":{"base":94,"amplitude":4},"mud":{"base":59,"amplitude":5},"fullness":{"base":196,"amplitude":3}}},{"id":"H27","name":"Gion no Kaze","rankPool":"H","speciesId":0,"personalityId":2,"nativeTags":"無","stats":{"stamina":{"base":77,"amplitude":3},"legPower":{"base":74,"amplitude":9},"sand":{"base":70,"amplitude":8},"water":{"base":66,"amplitude":9},"mud":{"base":79,"amplitude":1},"fullness":{"base":72,"amplitude":109}}},{"id":"H28","name":"Yarimasse","rankPool":"H","speciesId":0,"personalityId":1,"nativeTags":"無","stats":{"stamina":{"base":95,"amplitude":1},"legPower":{"base":89,"amplitude":1},"sand":{"base":82,"amplitude":4},"water":{"base":68,"amplitude":4},"mud":{"base":71,"amplitude":0},"fullness":{"base":197,"amplitude":8}}},{"id":"H29","name":"Bikkurigo","rankPool":"H","speciesId":0,"personalityId":1,"nativeTags":"無","stats":{"stamina":{"base":89,"amplitude":2},"legPower":{"base":67,"amplitude":8},"sand":{"base":89,"amplitude":9},"water":{"base":55,"amplitude":4},"mud":{"base":61,"amplitude":7},"fullness":{"base":9,"amplitude":157}}},{"id":"H30","name":"Tamarande","rankPool":"H","speciesId":1,"personalityId":1,"nativeTags":"無","stats":{"stamina":{"base":82,"amplitude":1},"legPower":{"base":58,"amplitude":5},"sand":{"base":57,"amplitude":7},"water":{"base":68,"amplitude":10},"mud":{"base":58,"amplitude":3},"fullness":{"base":170,"amplitude":9}}},{"id":"K00","name":"Kamegoro","rankPool":"K","speciesId":0,"personalityId":1,"nativeTags":"無","stats":{"stamina":{"base":117,"amplitude":9},"legPower":{"base":74,"amplitude":4},"sand":{"base":50,"amplitude":0},"water":{"base":120,"amplitude":11},"mud":{"base":70,"amplitude":9},"fullness":{"base":73,"amplitude":120}}},{"id":"K01","name":"Shichifuku","rankPool":"K","speciesId":0,"personalityId":2,"nativeTags":"無","stats":{"stamina":{"base":96,"amplitude":1},"legPower":{"base":101,"amplitude":11},"sand":{"base":57,"amplitude":3},"water":{"base":103,"amplitude":7},"mud":{"base":58,"amplitude":6},"fullness":{"base":80,"amplitude":112}}},{"id":"K02","name":"Jurojin","rankPool":"K","speciesId":0,"personalityId":1,"nativeTags":"無","stats":{"stamina":{"base":119,"amplitude":9},"legPower":{"base":76,"amplitude":5},"sand":{"base":114,"amplitude":6},"water":{"base":56,"amplitude":1},"mud":{"base":120,"amplitude":6},"fullness":{"base":90,"amplitude":106}}},{"id":"K03","name":"Fukurokuju","rankPool":"K","speciesId":0,"personalityId":2,"nativeTags":"無","stats":{"stamina":{"base":99,"amplitude":9},"legPower":{"base":107,"amplitude":2},"sand":{"base":106,"amplitude":4},"water":{"base":52,"amplitude":1},"mud":{"base":113,"amplitude":5},"fullness":{"base":81,"amplitude":102}}},{"id":"K04","name":"Benzaiten","rankPool":"K","speciesId":1,"personalityId":2,"nativeTags":"無","stats":{"stamina":{"base":88,"amplitude":30},"legPower":{"base":109,"amplitude":1},"sand":{"base":63,"amplitude":5},"water":{"base":89,"amplitude":2},"mud":{"base":76,"amplitude":1},"fullness":{"base":219,"amplitude":12}}},{"id":"K05","name":"Hotei","rankPool":"K","speciesId":1,"personalityId":2,"nativeTags":"無","stats":{"stamina":{"base":101,"amplitude":5},"legPower":{"base":80,"amplitude":50},"sand":{"base":75,"amplitude":6},"water":{"base":70,"amplitude":6},"mud":{"base":67,"amplitude":8},"fullness":{"base":194,"amplitude":5}}},{"id":"K06","name":"Susanoo","rankPool":"K","speciesId":1,"personalityId":1,"nativeTags":"無","stats":{"stamina":{"base":97,"amplitude":8},"legPower":{"base":104,"amplitude":10},"sand":{"base":62,"amplitude":1},"water":{"base":103,"amplitude":5},"mud":{"base":107,"amplitude":1},"fullness":{"base":212,"amplitude":8}}},{"id":"K07","name":"Izanagi","rankPool":"K","speciesId":0,"personalityId":2,"nativeTags":"無","stats":{"stamina":{"base":106,"amplitude":5},"legPower":{"base":84,"amplitude":2},"sand":{"base":79,"amplitude":2},"water":{"base":103,"amplitude":7},"mud":{"base":78,"amplitude":6},"fullness":{"base":203,"amplitude":2}}},{"id":"K08","name":"Izanami","rankPool":"K","speciesId":0,"personalityId":2,"nativeTags":"無","stats":{"stamina":{"base":103,"amplitude":4},"legPower":{"base":70,"amplitude":9},"sand":{"base":78,"amplitude":8},"water":{"base":57,"amplitude":4},"mud":{"base":120,"amplitude":7},"fullness":{"base":199,"amplitude":0}}},{"id":"K09","name":"Sarutahiko","rankPool":"K","speciesId":0,"personalityId":1,"nativeTags":"無","stats":{"stamina":{"base":116,"amplitude":9},"legPower":{"base":103,"amplitude":4},"sand":{"base":50,"amplitude":4},"water":{"base":105,"amplitude":1},"mud":{"base":102,"amplitude":3},"fullness":{"base":218,"amplitude":3}}},{"id":"K10","name":"Takeru","rankPool":"K","speciesId":1,"personalityId":0,"nativeTags":"無","stats":{"stamina":{"base":73,"amplitude":10},"legPower":{"base":80,"amplitude":5},"sand":{"base":91,"amplitude":3},"water":{"base":53,"amplitude":3},"mud":{"base":103,"amplitude":12},"fullness":{"base":191,"amplitude":2}}},{"id":"K11","name":"Tairago","rankPool":"K","speciesId":0,"personalityId":1,"nativeTags":"無","stats":{"stamina":{"base":56,"amplitude":1},"legPower":{"base":93,"amplitude":6},"sand":{"base":103,"amplitude":4},"water":{"base":56,"amplitude":6},"mud":{"base":82,"amplitude":5},"fullness":{"base":94,"amplitude":101}}},{"id":"K12","name":"Minamoto","rankPool":"K","speciesId":1,"personalityId":0,"nativeTags":"無","stats":{"stamina":{"base":104,"amplitude":9},"legPower":{"base":103,"amplitude":8},"sand":{"base":101,"amplitude":3},"water":{"base":64,"amplitude":12},"mud":{"base":66,"amplitude":0},"fullness":{"base":103,"amplitude":103}}},{"id":"K13","name":"Kameo","rankPool":"K","speciesId":0,"personalityId":3,"nativeTags":"無","stats":{"stamina":{"base":102,"amplitude":5},"legPower":{"base":86,"amplitude":11},"sand":{"base":71,"amplitude":8},"water":{"base":75,"amplitude":1},"mud":{"base":69,"amplitude":7},"fullness":{"base":103,"amplitude":108}}},{"id":"K14","name":"Kameten","rankPool":"K","speciesId":1,"personalityId":0,"nativeTags":"無","stats":{"stamina":{"base":74,"amplitude":5},"legPower":{"base":117,"amplitude":8},"sand":{"base":64,"amplitude":3},"water":{"base":107,"amplitude":7},"mud":{"base":89,"amplitude":5},"fullness":{"base":103,"amplitude":108}}},{"id":"K15","name":"Amaterasu","rankPool":"K","speciesId":0,"personalityId":1,"nativeTags":"無","stats":{"stamina":{"base":101,"amplitude":6},"legPower":{"base":56,"amplitude":11},"sand":{"base":96,"amplitude":8},"water":{"base":94,"amplitude":2},"mud":{"base":80,"amplitude":3},"fullness":{"base":204,"amplitude":3}}},{"id":"K16","name":"Kamui","rankPool":"K","speciesId":1,"personalityId":1,"nativeTags":"無","stats":{"stamina":{"base":109,"amplitude":7},"legPower":{"base":52,"amplitude":2},"sand":{"base":75,"amplitude":5},"water":{"base":87,"amplitude":10},"mud":{"base":101,"amplitude":12},"fullness":{"base":197,"amplitude":5}}},{"id":"K17","name":"Hikari","rankPool":"K","speciesId":1,"personalityId":1,"nativeTags":"無","stats":{"stamina":{"base":78,"amplitude":8},"legPower":{"base":64,"amplitude":7},"sand":{"base":102,"amplitude":11},"water":{"base":67,"amplitude":9},"mud":{"base":70,"amplitude":12},"fullness":{"base":90,"amplitude":108}}},{"id":"K18","name":"Kikuichigo","rankPool":"K","speciesId":1,"personalityId":0,"nativeTags":"無","stats":{"stamina":{"base":97,"amplitude":3},"legPower":{"base":50,"amplitude":6},"sand":{"base":80,"amplitude":6},"water":{"base":68,"amplitude":10},"mud":{"base":116,"amplitude":6},"fullness":{"base":75,"amplitude":139}}},{"id":"K19","name":"Raiden","rankPool":"K","speciesId":0,"personalityId":1,"nativeTags":"無","stats":{"stamina":{"base":61,"amplitude":1},"legPower":{"base":86,"amplitude":1},"sand":{"base":117,"amplitude":4},"water":{"base":56,"amplitude":9},"mud":{"base":84,"amplitude":3},"fullness":{"base":80,"amplitude":80}}},{"id":"K20","name":"Dairaiden","rankPool":"K","speciesId":0,"personalityId":1,"nativeTags":"無","stats":{"stamina":{"base":61,"amplitude":10},"legPower":{"base":81,"amplitude":9},"sand":{"base":67,"amplitude":5},"water":{"base":114,"amplitude":5},"mud":{"base":118,"amplitude":8},"fullness":{"base":120,"amplitude":120}}},{"id":"K21","name":"Inazuma","rankPool":"K","speciesId":1,"personalityId":1,"nativeTags":"無","stats":{"stamina":{"base":110,"amplitude":11},"legPower":{"base":70,"amplitude":12},"sand":{"base":108,"amplitude":5},"water":{"base":78,"amplitude":6},"mud":{"base":102,"amplitude":2},"fullness":{"base":112,"amplitude":102}}},{"id":"K22","name":"Taiho","rankPool":"K","speciesId":1,"personalityId":1,"nativeTags":"無","stats":{"stamina":{"base":100,"amplitude":6},"legPower":{"base":68,"amplitude":6},"sand":{"base":57,"amplitude":4},"water":{"base":116,"amplitude":3},"mud":{"base":103,"amplitude":10},"fullness":{"base":72,"amplitude":193}}},{"id":"K23","name":"Fuji Hayate","rankPool":"K","speciesId":1,"personalityId":1,"nativeTags":"無","stats":{"stamina":{"base":101,"amplitude":1},"legPower":{"base":80,"amplitude":2},"sand":{"base":113,"amplitude":3},"water":{"base":108,"amplitude":11},"mud":{"base":84,"amplitude":6},"fullness":{"base":82,"amplitude":193}}},{"id":"K24","name":"Kurama Tengu","rankPool":"K","speciesId":1,"personalityId":0,"nativeTags":"無","stats":{"stamina":{"base":101,"amplitude":7},"legPower":{"base":81,"amplitude":2},"sand":{"base":82,"amplitude":12},"water":{"base":56,"amplitude":12},"mud":{"base":84,"amplitude":12},"fullness":{"base":216,"amplitude":0}}},{"id":"K25","name":"Toroiyan","rankPool":"K","speciesId":0,"personalityId":2,"nativeTags":"無","stats":{"stamina":{"base":87,"amplitude":30},"legPower":{"base":70,"amplitude":25},"sand":{"base":101,"amplitude":5},"water":{"base":76,"amplitude":3},"mud":{"base":75,"amplitude":7},"fullness":{"base":196,"amplitude":9}}},{"id":"S00","name":"Edo Nishiki","rankPool":"S","speciesId":1,"personalityId":2,"nativeTags":"無","stats":{"stamina":{"base":95,"amplitude":25},"legPower":{"base":133,"amplitude":31},"sand":{"base":51,"amplitude":14},"water":{"base":105,"amplitude":10},"mud":{"base":102,"amplitude":4},"fullness":{"base":212,"amplitude":1}}},{"id":"S01","name":"Shimano","rankPool":"S","speciesId":0,"personalityId":2,"nativeTags":"無","stats":{"stamina":{"base":94,"amplitude":32},"legPower":{"base":148,"amplitude":5},"sand":{"base":101,"amplitude":12},"water":{"base":73,"amplitude":7},"mud":{"base":111,"amplitude":7},"fullness":{"base":124,"amplitude":102}}},{"id":"S02","name":"Tetsujin","rankPool":"S","speciesId":1,"personalityId":1,"nativeTags":"無","stats":{"stamina":{"base":100,"amplitude":15},"legPower":{"base":127,"amplitude":5},"sand":{"base":123,"amplitude":4},"water":{"base":104,"amplitude":10},"mud":{"base":101,"amplitude":12},"fullness":{"base":137,"amplitude":102}}},{"id":"S03","name":"Hanahibiki","rankPool":"S","speciesId":0,"personalityId":0,"nativeTags":"無","stats":{"stamina":{"base":59,"amplitude":50},"legPower":{"base":113,"amplitude":6},"sand":{"base":138,"amplitude":9},"water":{"base":117,"amplitude":10},"mud":{"base":57,"amplitude":7},"fullness":{"base":137,"amplitude":109}}},{"id":"S04","name":"Musashimaru","rankPool":"S","speciesId":1,"personalityId":2,"nativeTags":"無","stats":{"stamina":{"base":130,"amplitude":20},"legPower":{"base":120,"amplitude":4},"sand":{"base":57,"amplitude":2},"water":{"base":78,"amplitude":14},"mud":{"base":90,"amplitude":1},"fullness":{"base":192,"amplitude":12}}},{"id":"S05","name":"Kamezakura","rankPool":"S","speciesId":0,"personalityId":0,"nativeTags":"無","stats":{"stamina":{"base":71,"amplitude":55},"legPower":{"base":120,"amplitude":11},"sand":{"base":104,"amplitude":2},"water":{"base":57,"amplitude":6},"mud":{"base":90,"amplitude":7},"fullness":{"base":110,"amplitude":108}}},{"id":"S06","name":"Kikujiro","rankPool":"S","speciesId":1,"personalityId":1,"nativeTags":"無","stats":{"stamina":{"base":88,"amplitude":50},"legPower":{"base":102,"amplitude":8},"sand":{"base":124,"amplitude":9},"water":{"base":68,"amplitude":4},"mud":{"base":105,"amplitude":0},"fullness":{"base":225,"amplitude":3}}},{"id":"S07","name":"Chiyo","rankPool":"S","speciesId":0,"personalityId":2,"nativeTags":"無","stats":{"stamina":{"base":131,"amplitude":14},"legPower":{"base":127,"amplitude":16},"sand":{"base":107,"amplitude":11},"water":{"base":85,"amplitude":5},"mud":{"base":52,"amplitude":5},"fullness":{"base":198,"amplitude":3}}},{"id":"S08","name":"Shippudoto","rankPool":"S","speciesId":0,"personalityId":0,"nativeTags":"無","stats":{"stamina":{"base":100,"amplitude":20},"legPower":{"base":144,"amplitude":50},"sand":{"base":137,"amplitude":12},"water":{"base":116,"amplitude":5},"mud":{"base":114,"amplitude":14},"fullness":{"base":105,"amplitude":105}}},{"id":"S09","name":"Furinkazan","rankPool":"S","speciesId":0,"personalityId":2,"nativeTags":"無","stats":{"stamina":{"base":74,"amplitude":5},"legPower":{"base":116,"amplitude":4},"sand":{"base":137,"amplitude":0},"water":{"base":90,"amplitude":9},"mud":{"base":118,"amplitude":6},"fullness":{"base":103,"amplitude":123}}},{"id":"S10","name":"Goten","rankPool":"S","speciesId":0,"personalityId":2,"nativeTags":"無","stats":{"stamina":{"base":100,"amplitude":30},"legPower":{"base":139,"amplitude":20},"sand":{"base":68,"amplitude":11},"water":{"base":76,"amplitude":3},"mud":{"base":50,"amplitude":40},"fullness":{"base":119,"amplitude":103}}},{"id":"S11","name":"Daiokame","rankPool":"S","speciesId":0,"personalityId":0,"nativeTags":"無","stats":{"stamina":{"base":114,"amplitude":11},"legPower":{"base":133,"amplitude":9},"sand":{"base":85,"amplitude":7},"water":{"base":101,"amplitude":5},"mud":{"base":100,"amplitude":11},"fullness":{"base":225,"amplitude":5}}},{"id":"S12","name":"Kibariya","rankPool":"S","speciesId":1,"personalityId":2,"nativeTags":"無","stats":{"stamina":{"base":55,"amplitude":3},"legPower":{"base":122,"amplitude":60},"sand":{"base":125,"amplitude":6},"water":{"base":61,"amplitude":5},"mud":{"base":129,"amplitude":13},"fullness":{"base":91,"amplitude":101}}},{"id":"S13","name":"Mt. Fuji","rankPool":"S","speciesId":0,"personalityId":2,"nativeTags":"無","stats":{"stamina":{"base":98,"amplitude":10},"legPower":{"base":126,"amplitude":12},"sand":{"base":139,"amplitude":5},"water":{"base":79,"amplitude":5},"mud":{"base":83,"amplitude":6},"fullness":{"base":111,"amplitude":102}}},{"id":"S14","name":"Sakurajima","rankPool":"S","speciesId":0,"personalityId":0,"nativeTags":"無","stats":{"stamina":{"base":120,"amplitude":0},"legPower":{"base":136,"amplitude":5},"sand":{"base":66,"amplitude":7},"water":{"base":97,"amplitude":9},"mud":{"base":126,"amplitude":14},"fullness":{"base":113,"amplitude":130}}},{"id":"S15","name":"Kame no Ryu","rankPool":"S","speciesId":1,"personalityId":2,"nativeTags":"無","stats":{"stamina":{"base":87,"amplitude":13},"legPower":{"base":115,"amplitude":6},"sand":{"base":120,"amplitude":8},"water":{"base":126,"amplitude":5},"mud":{"base":57,"amplitude":5},"fullness":{"base":96,"amplitude":120}}},{"id":"S16","name":"Noborigame","rankPool":"S","speciesId":1,"personalityId":0,"nativeTags":"無","stats":{"stamina":{"base":100,"amplitude":3},"legPower":{"base":127,"amplitude":9},"sand":{"base":91,"amplitude":3},"water":{"base":105,"amplitude":6},"mud":{"base":79,"amplitude":6},"fullness":{"base":98,"amplitude":112}}},{"id":"S17","name":"Hyottoko","rankPool":"S","speciesId":0,"personalityId":0,"nativeTags":"無","stats":{"stamina":{"base":99,"amplitude":10},"legPower":{"base":139,"amplitude":4},"sand":{"base":137,"amplitude":1},"water":{"base":112,"amplitude":7},"mud":{"base":122,"amplitude":11},"fullness":{"base":227,"amplitude":1}}},{"id":"S18","name":"Okamekame","rankPool":"S","speciesId":0,"personalityId":3,"nativeTags":"無","stats":{"stamina":{"base":135,"amplitude":7},"legPower":{"base":118,"amplitude":1},"sand":{"base":54,"amplitude":13},"water":{"base":97,"amplitude":6},"mud":{"base":125,"amplitude":0},"fullness":{"base":99,"amplitude":111}}},{"id":"S19","name":"Daitenshi","rankPool":"S","speciesId":0,"personalityId":1,"nativeTags":"無","stats":{"stamina":{"base":68,"amplitude":12},"legPower":{"base":136,"amplitude":3},"sand":{"base":74,"amplitude":2},"water":{"base":120,"amplitude":0},"mud":{"base":88,"amplitude":9},"fullness":{"base":215,"amplitude":6}}},{"id":"S20","name":"Mamemoyashi","rankPool":"S","speciesId":0,"personalityId":0,"nativeTags":"無","stats":{"stamina":{"base":100,"amplitude":8},"legPower":{"base":142,"amplitude":1},"sand":{"base":114,"amplitude":5},"water":{"base":128,"amplitude":4},"mud":{"base":95,"amplitude":3},"fullness":{"base":14,"amplitude":197}}},{"id":"S21","name":"Hayao","rankPool":"S","speciesId":1,"personalityId":0,"nativeTags":"無","stats":{"stamina":{"base":125,"amplitude":10},"legPower":{"base":141,"amplitude":2},"sand":{"base":123,"amplitude":11},"water":{"base":125,"amplitude":5},"mud":{"base":116,"amplitude":9},"fullness":{"base":111,"amplitude":123}}},{"id":"S22","name":"Haseo","rankPool":"S","speciesId":0,"personalityId":1,"nativeTags":"無","stats":{"stamina":{"base":102,"amplitude":6},"legPower":{"base":102,"amplitude":12},"sand":{"base":67,"amplitude":6},"water":{"base":63,"amplitude":12},"mud":{"base":57,"amplitude":2},"fullness":{"base":118,"amplitude":112}}},{"id":"S23","name":"Nakibokuro","rankPool":"S","speciesId":0,"personalityId":3,"nativeTags":"無","stats":{"stamina":{"base":88,"amplitude":10},"legPower":{"base":121,"amplitude":7},"sand":{"base":126,"amplitude":10},"water":{"base":107,"amplitude":7},"mud":{"base":77,"amplitude":7},"fullness":{"base":103,"amplitude":108}}},{"id":"S24","name":"Doro Hayate","rankPool":"S","speciesId":0,"personalityId":0,"nativeTags":"無","stats":{"stamina":{"base":98,"amplitude":30},"legPower":{"base":145,"amplitude":31},"sand":{"base":80,"amplitude":10},"water":{"base":59,"amplitude":1},"mud":{"base":200,"amplitude":10},"fullness":{"base":95,"amplitude":120}}},{"id":"S25","name":"Kawaikochan","rankPool":"S","speciesId":1,"personalityId":1,"nativeTags":"無","stats":{"stamina":{"base":93,"amplitude":6},"legPower":{"base":107,"amplitude":12},"sand":{"base":70,"amplitude":8},"water":{"base":84,"amplitude":2},"mud":{"base":120,"amplitude":2},"fullness":{"base":198,"amplitude":4}}},{"id":"S26","name":"Mokari Makka","rankPool":"S","speciesId":0,"personalityId":1,"nativeTags":"無","stats":{"stamina":{"base":72,"amplitude":13},"legPower":{"base":137,"amplitude":30},"sand":{"base":116,"amplitude":9},"water":{"base":108,"amplitude":13},"mud":{"base":139,"amplitude":6},"fullness":{"base":224,"amplitude":4}}},{"id":"S27","name":"Bochi Bochi Denna","rankPool":"S","speciesId":0,"personalityId":2,"nativeTags":"無","stats":{"stamina":{"base":71,"amplitude":5},"legPower":{"base":107,"amplitude":1},"sand":{"base":132,"amplitude":8},"water":{"base":124,"amplitude":4},"mud":{"base":112,"amplitude":1},"fullness":{"base":91,"amplitude":116}}},{"id":"S28","name":"Robinyan","rankPool":"S","speciesId":0,"personalityId":1,"nativeTags":"無","stats":{"stamina":{"base":100,"amplitude":25},"legPower":{"base":151,"amplitude":37},"sand":{"base":55,"amplitude":9},"water":{"base":37,"amplitude":10},"mud":{"base":50,"amplitude":8},"fullness":{"base":20,"amplitude":200}}},{"id":"O00","name":"Kameko","rankPool":"O","speciesId":1,"personalityId":1,"nativeTags":"無","stats":{"stamina":{"base":194,"amplitude":20},"legPower":{"base":200,"amplitude":30},"sand":{"base":130,"amplitude":5},"water":{"base":70,"amplitude":12},"mud":{"base":77,"amplitude":10},"fullness":{"base":100,"amplitude":130}}},{"id":"O01","name":"Shuten-doji","rankPool":"O","speciesId":1,"personalityId":1,"nativeTags":"無","stats":{"stamina":{"base":198,"amplitude":30},"legPower":{"base":197,"amplitude":15},"sand":{"base":125,"amplitude":4},"water":{"base":74,"amplitude":6},"mud":{"base":98,"amplitude":14},"fullness":{"base":123,"amplitude":111}}},{"id":"O02","name":"Rikuo","rankPool":"O","speciesId":0,"personalityId":1,"nativeTags":"老","stats":{"stamina":{"base":172,"amplitude":10},"legPower":{"base":193,"amplitude":30},"sand":{"base":101,"amplitude":7},"water":{"base":80,"amplitude":14},"mud":{"base":138,"amplitude":6},"fullness":{"base":238,"amplitude":3}}},{"id":"O03","name":"Benten","rankPool":"O","speciesId":1,"personalityId":3,"nativeTags":"老","stats":{"stamina":{"base":190,"amplitude":25},"legPower":{"base":152,"amplitude":35},"sand":{"base":112,"amplitude":7},"water":{"base":83,"amplitude":30},"mud":{"base":82,"amplitude":4},"fullness":{"base":218,"amplitude":6}}},{"id":"O04","name":"Kota","rankPool":"O","speciesId":0,"personalityId":3,"nativeTags":"無","stats":{"stamina":{"base":188,"amplitude":7},"legPower":{"base":187,"amplitude":20},"sand":{"base":152,"amplitude":2},"water":{"base":115,"amplitude":4},"mud":{"base":92,"amplitude":10},"fullness":{"base":108,"amplitude":112}}},{"id":"O05","name":"Daikichi","rankPool":"O","speciesId":1,"personalityId":0,"nativeTags":"無","stats":{"stamina":{"base":177,"amplitude":12},"legPower":{"base":153,"amplitude":8},"sand":{"base":129,"amplitude":6},"water":{"base":56,"amplitude":7},"mud":{"base":138,"amplitude":15},"fullness":{"base":125,"amplitude":125}}},{"id":"O06","name":"Orochimaru","rankPool":"O","speciesId":0,"personalityId":0,"nativeTags":"無","stats":{"stamina":{"base":172,"amplitude":13},"legPower":{"base":165,"amplitude":8},"sand":{"base":110,"amplitude":10},"water":{"base":58,"amplitude":12},"mud":{"base":121,"amplitude":13},"fullness":{"base":248,"amplitude":4}}},{"id":"O07","name":"Ayanami","rankPool":"O","speciesId":0,"personalityId":1,"nativeTags":"無","stats":{"stamina":{"base":185,"amplitude":2},"legPower":{"base":177,"amplitude":12},"sand":{"base":51,"amplitude":14},"water":{"base":69,"amplitude":3},"mud":{"base":115,"amplitude":11},"fullness":{"base":100,"amplitude":110}}},{"id":"O08","name":"Sazanami","rankPool":"O","speciesId":1,"personalityId":1,"nativeTags":"無","stats":{"stamina":{"base":190,"amplitude":12},"legPower":{"base":197,"amplitude":12},"sand":{"base":144,"amplitude":8},"water":{"base":96,"amplitude":8},"mud":{"base":140,"amplitude":6},"fullness":{"base":112,"amplitude":120}}},{"id":"O09","name":"Kongo","rankPool":"O","speciesId":1,"personalityId":0,"nativeTags":"無","stats":{"stamina":{"base":199,"amplitude":13},"legPower":{"base":181,"amplitude":30},"sand":{"base":93,"amplitude":4},"water":{"base":60,"amplitude":10},"mud":{"base":144,"amplitude":13},"fullness":{"base":130,"amplitude":120}}},{"id":"O10","name":"Yamato","rankPool":"O","speciesId":0,"personalityId":2,"nativeTags":"無","stats":{"stamina":{"base":182,"amplitude":9},"legPower":{"base":196,"amplitude":11},"sand":{"base":135,"amplitude":12},"water":{"base":112,"amplitude":9},"mud":{"base":116,"amplitude":0},"fullness":{"base":219,"amplitude":7}}},{"id":"O11","name":"Kikka","rankPool":"O","speciesId":0,"personalityId":1,"nativeTags":"無","stats":{"stamina":{"base":188,"amplitude":6},"legPower":{"base":152,"amplitude":35},"sand":{"base":145,"amplitude":1},"water":{"base":108,"amplitude":8},"mud":{"base":140,"amplitude":7},"fullness":{"base":100,"amplitude":107}}},{"id":"O12","name":"Mt. Haruna","rankPool":"O","speciesId":0,"personalityId":1,"nativeTags":"無","stats":{"stamina":{"base":174,"amplitude":5},"legPower":{"base":153,"amplitude":4},"sand":{"base":145,"amplitude":8},"water":{"base":96,"amplitude":8},"mud":{"base":77,"amplitude":0},"fullness":{"base":114,"amplitude":112}}},{"id":"O13","name":"Fuso","rankPool":"O","speciesId":0,"personalityId":1,"nativeTags":"老","stats":{"stamina":{"base":175,"amplitude":5},"legPower":{"base":176,"amplitude":10},"sand":{"base":101,"amplitude":11},"water":{"base":90,"amplitude":2},"mud":{"base":97,"amplitude":13},"fullness":{"base":107,"amplitude":106}}},{"id":"O14","name":"Nagato","rankPool":"O","speciesId":0,"personalityId":1,"nativeTags":"無","stats":{"stamina":{"base":198,"amplitude":9},"legPower":{"base":169,"amplitude":7},"sand":{"base":134,"amplitude":1},"water":{"base":159,"amplitude":11},"mud":{"base":114,"amplitude":4},"fullness":{"base":143,"amplitude":109}}},{"id":"O15","name":"Soryu","rankPool":"O","speciesId":1,"personalityId":1,"nativeTags":"無","stats":{"stamina":{"base":183,"amplitude":6},"legPower":{"base":151,"amplitude":5},"sand":{"base":130,"amplitude":6},"water":{"base":66,"amplitude":12},"mud":{"base":59,"amplitude":14},"fullness":{"base":114,"amplitude":110}}},{"id":"O16","name":"Hiryu","rankPool":"O","speciesId":0,"personalityId":2,"nativeTags":"無","stats":{"stamina":{"base":186,"amplitude":13},"legPower":{"base":190,"amplitude":6},"sand":{"base":114,"amplitude":5},"water":{"base":62,"amplitude":12},"mud":{"base":145,"amplitude":2},"fullness":{"base":245,"amplitude":8}}},{"id":"O17","name":"Shokaku","rankPool":"O","speciesId":1,"personalityId":0,"nativeTags":"無","stats":{"stamina":{"base":182,"amplitude":14},"legPower":{"base":152,"amplitude":3},"sand":{"base":131,"amplitude":4},"water":{"base":122,"amplitude":5},"mud":{"base":74,"amplitude":13},"fullness":{"base":114,"amplitude":111}}},{"id":"O18","name":"Zuikaku","rankPool":"O","speciesId":1,"personalityId":2,"nativeTags":"老","stats":{"stamina":{"base":178,"amplitude":13},"legPower":{"base":180,"amplitude":10},"sand":{"base":118,"amplitude":10},"water":{"base":124,"amplitude":10},"mud":{"base":83,"amplitude":14},"fullness":{"base":128,"amplitude":110}}},{"id":"O19","name":"Aobago","rankPool":"O","speciesId":1,"personalityId":2,"nativeTags":"無","stats":{"stamina":{"base":195,"amplitude":12},"legPower":{"base":161,"amplitude":13},"sand":{"base":57,"amplitude":5},"water":{"base":141,"amplitude":12},"mud":{"base":157,"amplitude":7},"fullness":{"base":133,"amplitude":100}}},{"id":"O20","name":"Daifubuki","rankPool":"O","speciesId":1,"personalityId":1,"nativeTags":"老","stats":{"stamina":{"base":174,"amplitude":12},"legPower":{"base":163,"amplitude":14},"sand":{"base":154,"amplitude":7},"water":{"base":66,"amplitude":3},"mud":{"base":100,"amplitude":3},"fullness":{"base":210,"amplitude":15}}},{"id":"O21","name":"Yugiri","rankPool":"O","speciesId":0,"personalityId":1,"nativeTags":"無","stats":{"stamina":{"base":172,"amplitude":10},"legPower":{"base":189,"amplitude":8},"sand":{"base":201,"amplitude":9},"water":{"base":168,"amplitude":9},"mud":{"base":211,"amplitude":14},"fullness":{"base":138,"amplitude":100}}},{"id":"O22","name":"Hatsuyuki","rankPool":"O","speciesId":1,"personalityId":1,"nativeTags":"無","stats":{"stamina":{"base":173,"amplitude":5},"legPower":{"base":159,"amplitude":14},"sand":{"base":75,"amplitude":9},"water":{"base":117,"amplitude":9},"mud":{"base":103,"amplitude":5},"fullness":{"base":105,"amplitude":105}}},{"id":"O23","name":"Dansetsu","rankPool":"O","speciesId":0,"personalityId":2,"nativeTags":"無","stats":{"stamina":{"base":200,"amplitude":14},"legPower":{"base":156,"amplitude":11},"sand":{"base":143,"amplitude":10},"water":{"base":57,"amplitude":13},"mud":{"base":52,"amplitude":11},"fullness":{"base":102,"amplitude":110}}},{"id":"O24","name":"Shigurego","rankPool":"O","speciesId":0,"personalityId":1,"nativeTags":"無","stats":{"stamina":{"base":180,"amplitude":7},"legPower":{"base":161,"amplitude":5},"sand":{"base":154,"amplitude":9},"water":{"base":123,"amplitude":6},"mud":{"base":72,"amplitude":14},"fullness":{"base":145,"amplitude":110}}},{"id":"O25","name":"Kogurego","rankPool":"O","speciesId":0,"personalityId":1,"nativeTags":"無","stats":{"stamina":{"base":196,"amplitude":13},"legPower":{"base":153,"amplitude":1},"sand":{"base":106,"amplitude":11},"water":{"base":63,"amplitude":1},"mud":{"base":136,"amplitude":5},"fullness":{"base":147,"amplitude":103}}},{"id":"O26","name":"Nanbo no Monjai","rankPool":"O","speciesId":0,"personalityId":3,"nativeTags":"無","stats":{"stamina":{"base":177,"amplitude":11},"legPower":{"base":163,"amplitude":30},"sand":{"base":105,"amplitude":7},"water":{"base":136,"amplitude":14},"mud":{"base":63,"amplitude":10},"fullness":{"base":12,"amplitude":200}}},{"id":"O27","name":"Onodan","rankPool":"O","speciesId":1,"personalityId":1,"nativeTags":"無","stats":{"stamina":{"base":204,"amplitude":0},"legPower":{"base":160,"amplitude":0},"sand":{"base":160,"amplitude":0},"water":{"base":160,"amplitude":0},"mud":{"base":160,"amplitude":0},"fullness":{"base":0,"amplitude":204}}},{"id":"Y00","name":"Samidarego","rankPool":"Y","speciesId":1,"personalityId":0,"nativeTags":"強","stats":{"stamina":{"base":255,"amplitude":0},"legPower":{"base":255,"amplitude":0},"sand":{"base":100,"amplitude":150},"water":{"base":100,"amplitude":150},"mud":{"base":100,"amplitude":150},"fullness":{"base":103,"amplitude":120}}},{"id":"Y01","name":"Shiranui","rankPool":"Y","speciesId":1,"personalityId":3,"nativeTags":"老強","stats":{"stamina":{"base":165,"amplitude":7},"legPower":{"base":230,"amplitude":16},"sand":{"base":187,"amplitude":12},"water":{"base":200,"amplitude":5},"mud":{"base":141,"amplitude":3},"fullness":{"base":121,"amplitude":122}}},{"id":"Y02","name":"Oyashio","rankPool":"Y","speciesId":0,"personalityId":0,"nativeTags":"老","stats":{"stamina":{"base":213,"amplitude":1},"legPower":{"base":200,"amplitude":15},"sand":{"base":100,"amplitude":12},"water":{"base":106,"amplitude":13},"mud":{"base":146,"amplitude":8},"fullness":{"base":107,"amplitude":113}}},{"id":"Y03","name":"Izumo","rankPool":"Y","speciesId":0,"personalityId":1,"nativeTags":"無","stats":{"stamina":{"base":179,"amplitude":15},"legPower":{"base":182,"amplitude":15},"sand":{"base":55,"amplitude":15},"water":{"base":147,"amplitude":5},"mud":{"base":142,"amplitude":14},"fullness":{"base":122,"amplitude":102}}},{"id":"Y04","name":"Mutsusaburo","rankPool":"Y","speciesId":0,"personalityId":1,"nativeTags":"無","stats":{"stamina":{"base":140,"amplitude":15},"legPower":{"base":178,"amplitude":9},"sand":{"base":80,"amplitude":13},"water":{"base":72,"amplitude":3},"mud":{"base":156,"amplitude":1},"fullness":{"base":250,"amplitude":0}}},{"id":"Y05","name":"Kisaragigo","rankPool":"Y","speciesId":0,"personalityId":3,"nativeTags":"無","stats":{"stamina":{"base":130,"amplitude":5},"legPower":{"base":192,"amplitude":30},"sand":{"base":186,"amplitude":3},"water":{"base":127,"amplitude":6},"mud":{"base":160,"amplitude":9},"fullness":{"base":145,"amplitude":110}}},{"id":"Y06","name":"Yayoigo","rankPool":"Y","speciesId":0,"personalityId":1,"nativeTags":"無","stats":{"stamina":{"base":187,"amplitude":1},"legPower":{"base":155,"amplitude":15},"sand":{"base":120,"amplitude":11},"water":{"base":94,"amplitude":5},"mud":{"base":168,"amplitude":2},"fullness":{"base":138,"amplitude":102}}},{"id":"Y07","name":"Uzukigo","rankPool":"Y","speciesId":0,"personalityId":0,"nativeTags":"無","stats":{"stamina":{"base":179,"amplitude":2},"legPower":{"base":157,"amplitude":9},"sand":{"base":99,"amplitude":2},"water":{"base":149,"amplitude":16},"mud":{"base":172,"amplitude":10},"fullness":{"base":140,"amplitude":108}}},{"id":"Y08","name":"Minazukigo","rankPool":"Y","speciesId":1,"personalityId":2,"nativeTags":"無","stats":{"stamina":{"base":126,"amplitude":9},"legPower":{"base":188,"amplitude":4},"sand":{"base":161,"amplitude":14},"water":{"base":104,"amplitude":12},"mud":{"base":94,"amplitude":8},"fullness":{"base":129,"amplitude":110}}},{"id":"Y09","name":"Mirai","rankPool":"Y","speciesId":0,"personalityId":0,"nativeTags":"無","stats":{"stamina":{"base":175,"amplitude":9},"legPower":{"base":190,"amplitude":20},"sand":{"base":77,"amplitude":5},"water":{"base":149,"amplitude":6},"mud":{"base":154,"amplitude":11},"fullness":{"base":141,"amplitude":109}}},{"id":"Y10","name":"Satsukigo","rankPool":"Y","speciesId":0,"personalityId":1,"nativeTags":"無","stats":{"stamina":{"base":109,"amplitude":5},"legPower":{"base":200,"amplitude":13},"sand":{"base":190,"amplitude":3},"water":{"base":140,"amplitude":0},"mud":{"base":168,"amplitude":9},"fullness":{"base":149,"amplitude":100}}},{"id":"Y11","name":"Fuzukigo","rankPool":"Y","speciesId":1,"personalityId":1,"nativeTags":"無","stats":{"stamina":{"base":129,"amplitude":9},"legPower":{"base":150,"amplitude":60},"sand":{"base":59,"amplitude":8},"water":{"base":88,"amplitude":10},"mud":{"base":86,"amplitude":2},"fullness":{"base":103,"amplitude":102}}},{"id":"Y12","name":"Hazukigo","rankPool":"Y","speciesId":0,"personalityId":1,"nativeTags":"無","stats":{"stamina":{"base":168,"amplitude":15},"legPower":{"base":184,"amplitude":23},"sand":{"base":128,"amplitude":9},"water":{"base":110,"amplitude":13},"mud":{"base":119,"amplitude":14},"fullness":{"base":142,"amplitude":103}}},{"id":"Y13","name":"Nagatsukigo","rankPool":"Y","speciesId":0,"personalityId":0,"nativeTags":"無","stats":{"stamina":{"base":103,"amplitude":13},"legPower":{"base":180,"amplitude":2},"sand":{"base":59,"amplitude":15},"water":{"base":107,"amplitude":7},"mud":{"base":156,"amplitude":14},"fullness":{"base":105,"amplitude":100}}},{"id":"Y14","name":"Kannazukigo","rankPool":"Y","speciesId":1,"personalityId":0,"nativeTags":"無","stats":{"stamina":{"base":154,"amplitude":0},"legPower":{"base":208,"amplitude":3},"sand":{"base":144,"amplitude":14},"water":{"base":154,"amplitude":5},"mud":{"base":122,"amplitude":14},"fullness":{"base":131,"amplitude":102}}},{"id":"Y15","name":"Shimotsukigo","rankPool":"Y","speciesId":0,"personalityId":0,"nativeTags":"強","stats":{"stamina":{"base":150,"amplitude":15},"legPower":{"base":250,"amplitude":4},"sand":{"base":150,"amplitude":25},"water":{"base":151,"amplitude":11},"mud":{"base":160,"amplitude":7},"fullness":{"base":135,"amplitude":120}}},{"id":"Y16","name":"Shiwasugo","rankPool":"Y","speciesId":0,"personalityId":0,"nativeTags":"無","stats":{"stamina":{"base":132,"amplitude":6},"legPower":{"base":163,"amplitude":11},"sand":{"base":177,"amplitude":4},"water":{"base":105,"amplitude":9},"mud":{"base":170,"amplitude":4},"fullness":{"base":216,"amplitude":14}}},{"id":"Y17","name":"Koganego","rankPool":"Y","speciesId":0,"personalityId":3,"nativeTags":"無","stats":{"stamina":{"base":109,"amplitude":9},"legPower":{"base":180,"amplitude":15},"sand":{"base":185,"amplitude":14},"water":{"base":100,"amplitude":11},"mud":{"base":106,"amplitude":4},"fullness":{"base":243,"amplitude":9}}},{"id":"Y18","name":"Shirogane","rankPool":"Y","speciesId":0,"personalityId":0,"nativeTags":"無","stats":{"stamina":{"base":155,"amplitude":3},"legPower":{"base":177,"amplitude":13},"sand":{"base":57,"amplitude":14},"water":{"base":203,"amplitude":13},"mud":{"base":98,"amplitude":9},"fullness":{"base":239,"amplitude":9}}},{"id":"Y19","name":"Wakakusataro","rankPool":"Y","speciesId":1,"personalityId":1,"nativeTags":"無","stats":{"stamina":{"base":180,"amplitude":20},"legPower":{"base":211,"amplitude":1},"sand":{"base":155,"amplitude":7},"water":{"base":160,"amplitude":15},"mud":{"base":210,"amplitude":20},"fullness":{"base":16,"amplitude":230}}},{"id":"Y20","name":"Fujin","rankPool":"Y","speciesId":1,"personalityId":2,"nativeTags":"無","stats":{"stamina":{"base":210,"amplitude":5},"legPower":{"base":180,"amplitude":30},"sand":{"base":59,"amplitude":14},"water":{"base":250,"amplitude":5},"mud":{"base":200,"amplitude":15},"fullness":{"base":221,"amplitude":13}}},{"id":"Y21","name":"Raijin","rankPool":"Y","speciesId":0,"personalityId":1,"nativeTags":"無","stats":{"stamina":{"base":167,"amplitude":5},"legPower":{"base":200,"amplitude":12},"sand":{"base":250,"amplitude":4},"water":{"base":146,"amplitude":12},"mud":{"base":250,"amplitude":1},"fullness":{"base":233,"amplitude":5}}},{"id":"Y22","name":"Yamabukimaru","rankPool":"Y","speciesId":1,"personalityId":2,"nativeTags":"無","stats":{"stamina":{"base":193,"amplitude":15},"legPower":{"base":153,"amplitude":14},"sand":{"base":160,"amplitude":10},"water":{"base":88,"amplitude":8},"mud":{"base":174,"amplitude":1},"fullness":{"base":149,"amplitude":102}}},{"id":"Y23","name":"Tatsujinmaru","rankPool":"Y","speciesId":0,"personalityId":1,"nativeTags":"老","stats":{"stamina":{"base":150,"amplitude":50},"legPower":{"base":167,"amplitude":20},"sand":{"base":140,"amplitude":7},"water":{"base":177,"amplitude":5},"mud":{"base":162,"amplitude":2},"fullness":{"base":21,"amplitude":220}}},{"id":"Y24","name":"Edo no Hikari","rankPool":"Y","speciesId":0,"personalityId":1,"nativeTags":"無","stats":{"stamina":{"base":197,"amplitude":20},"legPower":{"base":190,"amplitude":23},"sand":{"base":132,"amplitude":15},"water":{"base":159,"amplitude":13},"mud":{"base":189,"amplitude":2},"fullness":{"base":134,"amplitude":102}}},{"id":"Y25","name":"Kyo no Yume","rankPool":"Y","speciesId":0,"personalityId":3,"nativeTags":"老","stats":{"stamina":{"base":100,"amplitude":30},"legPower":{"base":221,"amplitude":11},"sand":{"base":230,"amplitude":2},"water":{"base":231,"amplitude":4},"mud":{"base":225,"amplitude":2},"fullness":{"base":14,"amplitude":230}}},{"id":"Y26","name":"Hakuginmaru","rankPool":"Y","speciesId":0,"personalityId":2,"nativeTags":"無","stats":{"stamina":{"base":179,"amplitude":30},"legPower":{"base":166,"amplitude":13},"sand":{"base":138,"amplitude":7},"water":{"base":144,"amplitude":7},"mud":{"base":133,"amplitude":4},"fullness":{"base":129,"amplitude":120}}},{"id":"Y27","name":"Ogonnokaze","rankPool":"Y","speciesId":0,"personalityId":0,"nativeTags":"強","stats":{"stamina":{"base":212,"amplitude":20},"legPower":{"base":180,"amplitude":30},"sand":{"base":188,"amplitude":6},"water":{"base":160,"amplitude":56},"mud":{"base":170,"amplitude":14},"fullness":{"base":240,"amplitude":6}}},{"id":"Y28","name":"Mugen","rankPool":"Y","speciesId":1,"personalityId":0,"nativeTags":"無","stats":{"stamina":{"base":134,"amplitude":5},"legPower":{"base":210,"amplitude":20},"sand":{"base":180,"amplitude":15},"water":{"base":200,"amplitude":6},"mud":{"base":190,"amplitude":30},"fullness":{"base":231,"amplitude":15}}},{"id":"Y29","name":"Jugemu","rankPool":"Y","speciesId":1,"personalityId":3,"nativeTags":"無","stats":{"stamina":{"base":200,"amplitude":11},"legPower":{"base":199,"amplitude":20},"sand":{"base":150,"amplitude":20},"water":{"base":157,"amplitude":15},"mud":{"base":160,"amplitude":15},"fullness":{"base":228,"amplitude":4}}},{"id":"Y30","name":"Horai","rankPool":"Y","speciesId":1,"personalityId":1,"nativeTags":"無","stats":{"stamina":{"base":190,"amplitude":30},"legPower":{"base":201,"amplitude":50},"sand":{"base":250,"amplitude":30},"water":{"base":120,"amplitude":4},"mud":{"base":130,"amplitude":0},"fullness":{"base":219,"amplitude":1}}},{"id":"Y31","name":"Tairyoku Jiman","rankPool":"Y","speciesId":1,"personalityId":2,"nativeTags":"老","stats":{"stamina":{"base":250,"amplitude":5},"legPower":{"base":170,"amplitude":30},"sand":{"base":178,"amplitude":10},"water":{"base":91,"amplitude":60},"mud":{"base":145,"amplitude":0},"fullness":{"base":229,"amplitude":12}}},{"id":"Y32","name":"Takessan","rankPool":"Y","speciesId":0,"personalityId":3,"nativeTags":"強","stats":{"stamina":{"base":200,"amplitude":50},"legPower":{"base":155,"amplitude":12},"sand":{"base":155,"amplitude":12},"water":{"base":155,"amplitude":12},"mud":{"base":155,"amplitude":12},"fullness":{"base":35,"amplitude":220}}},{"id":"Y33","name":"Tokuharan","rankPool":"Y","speciesId":1,"personalityId":3,"nativeTags":"強","stats":{"stamina":{"base":129,"amplitude":63},"legPower":{"base":233,"amplitude":10},"sand":{"base":127,"amplitude":78},"water":{"base":124,"amplitude":89},"mud":{"base":128,"amplitude":77},"fullness":{"base":0,"amplitude":196}}},{"id":"Y34","name":"Water Shogun","rankPool":"Y","speciesId":1,"personalityId":1,"nativeTags":"最","stats":{"stamina":{"base":225,"amplitude":20},"legPower":{"base":230,"amplitude":20},"sand":{"base":220,"amplitude":22},"water":{"base":255,"amplitude":0},"mud":{"base":221,"amplitude":17},"fullness":{"base":0,"amplitude":128}}},{"id":"Y35","name":"Mud Shogun","rankPool":"Y","speciesId":1,"personalityId":1,"nativeTags":"最","stats":{"stamina":{"base":230,"amplitude":28},"legPower":{"base":229,"amplitude":10},"sand":{"base":219,"amplitude":22},"water":{"base":222,"amplitude":20},"mud":{"base":255,"amplitude":0},"fullness":{"base":0,"amplitude":125}}},{"id":"Y36","name":"Sand Shogun","rankPool":"Y","speciesId":1,"personalityId":1,"nativeTags":"最","stats":{"stamina":{"base":228,"amplitude":20},"legPower":{"base":231,"amplitude":20},"sand":{"base":255,"amplitude":0},"water":{"base":221,"amplitude":23},"mud":{"base":227,"amplitude":21},"fullness":{"base":0,"amplitude":120}}},{"id":"Y37","name":"Turtle Shogun","rankPool":"Y","speciesId":0,"personalityId":1,"nativeTags":"最","stats":{"stamina":{"base":255,"amplitude":0},"legPower":{"base":255,"amplitude":0},"sand":{"base":245,"amplitude":10},"water":{"base":245,"amplitude":10},"mud":{"base":245,"amplitude":10},"fullness":{"base":0,"amplitude":67}}}],"commentaryCueVariants":{"AcdDakou":4,"AcdDakou2":4,"AcdDown":4,"AcdDownSecond":4,"AcdDownTop":4,"AcdStopGoal":4,"AcdStopGoal2":4,"AcdStopStart":4,"AcdStopStart2":4,"AcdUp":4,"AcdUpLate":4,"AcdUpSame0":4,"AcdUpSame1":4,"AcdUpSame2":4,"Course1Bottom":4,"Course1Same":4,"Course1Top1":4,"Course1Top2":4,"Course1_12":4,"Course22Same1":4,"Course22Same2":4,"Course22Top":4,"Course22_12":4,"Course22_123K":4,"Course22_12K1":4,"Course22_12K2":4,"Course2Bara":4,"Course2Bottom":4,"Course2Same":4,"Course2Second":4,"Course2Top1":4,"Course2Top2":4,"Course2Top3":4,"Course2Top4":4,"Course32Bara":4,"Course32Same":4,"Course32Second11":4,"Course32Second12":4,"Course32Second2":4,"Course32Top1":4,"Course32Top2":4,"Course32_12":4,"Course3Bara1":4,"Course3Bara2":4,"Course3Bottom":4,"Course3Fourth":4,"Course3Same":4,"Course3Second":4,"Course3Third":4,"Course3Top1":4,"Course3Top2":4,"Course3Top3":4,"Course3Top4":4,"Course3_12":4,"Course42Second11":4,"Course42Second12":4,"Course42Second13":4,"Course42Second2":4,"Course42Third1":4,"Course42Third2":4,"Course42Top1":4,"Course42Top2":4,"Course42Top31":4,"Course42Top32":4,"Course42Top4":4,"Course42Top5":4,"Course42Top61":4,"Course42Top62":4,"Course4Same":4,"Course4Top0":4,"Course4Top1":4,"Course4Top2":4,"Course4Top30":4,"Course4Top31":4,"Course4Top32":4,"Course4Top33":4,"Course4Top4":4,"Course4_12":4,"End":1,"GoalSecond1":4,"GoalSecond2":4,"GoalSecond3":4,"GoalSecond4":4,"GoalSecond5":4,"GoalSecond6":4,"GoalSecond7":4,"GoalSecondResult":4,"GoalSecondSame1":4,"GoalSecondSame2":4,"GoalTop1":4,"GoalTop2":4,"GoalTop21":4,"GoalTop22":4,"GoalTop23":4,"GoalTop24":4,"GoalTop31":4,"GoalTop32":4,"GoalTop4":4,"GoalTop5":4,"Hima11":4,"Hima12":4,"Hima2":4,"Start":4,"Start2Same":4,"Start2Top":4},"spawnPools":[{"actorId":"00b0014e","areaId":12,"poolId":0,"delayOverride":-1},{"actorId":"00b00151","areaId":12,"poolId":0,"delayOverride":-1},{"actorId":"00b00219","areaId":12,"poolId":0,"delayOverride":-1},{"actorId":"00b0021a","areaId":12,"poolId":0,"delayOverride":-1},{"actorId":"00b00086","areaId":1,"poolId":1,"delayOverride":-1},{"actorId":"00b000ab","areaId":1,"poolId":1,"delayOverride":-1},{"actorId":"00b0014f","areaId":10,"poolId":2,"delayOverride":-1},{"actorId":"00b00150","areaId":10,"poolId":2,"delayOverride":-1},{"actorId":"00b00211","areaId":10,"poolId":2,"delayOverride":-1},{"actorId":"00b00212","areaId":10,"poolId":2,"delayOverride":-1},{"actorId":"00b00213","areaId":10,"poolId":2,"delayOverride":-1},{"actorId":"00b00214","areaId":10,"poolId":14,"delayOverride":-1},{"actorId":"00b00215","areaId":10,"poolId":14,"delayOverride":-1},{"actorId":"00b00216","areaId":10,"poolId":14,"delayOverride":-1},{"actorId":"00b00217","areaId":10,"poolId":14,"delayOverride":-1},{"actorId":"00b00218","areaId":10,"poolId":14,"delayOverride":-1},{"actorId":"00b001da","areaId":29,"poolId":3,"delayOverride":-1},{"actorId":"00b001dc","areaId":29,"poolId":3,"delayOverride":-1},{"actorId":"00b001e0","areaId":29,"poolId":3,"delayOverride":-1},{"actorId":"00b001e5","areaId":29,"poolId":3,"delayOverride":-1},{"actorId":"00b001ee","areaId":1,"poolId":4,"delayOverride":-1},{"actorId":"00b001f4","areaId":7,"poolId":5,"delayOverride":-1},{"actorId":"00b001f5","areaId":7,"poolId":5,"delayOverride":-1},{"actorId":"00b001f6","areaId":7,"poolId":5,"delayOverride":-1},{"actorId":"00b001f7","areaId":7,"poolId":5,"delayOverride":-1},{"actorId":"00b0021d","areaId":7,"poolId":5,"delayOverride":-1},{"actorId":"00b0020b","areaId":19,"poolId":6,"delayOverride":-1},{"actorId":"00b0020c","areaId":8,"poolId":7,"delayOverride":-1},{"actorId":"00b0020d","areaId":8,"poolId":7,"delayOverride":-1},{"actorId":"00b0020e","areaId":8,"poolId":7,"delayOverride":-1},{"actorId":"00b0020f","areaId":8,"poolId":7,"delayOverride":-1},{"actorId":"00b00210","areaId":8,"poolId":7,"delayOverride":-1},{"actorId":"00b0021b","areaId":86,"poolId":8,"delayOverride":-1},{"actorId":"00b0021c","areaId":86,"poolId":8,"delayOverride":-1},{"actorId":"00b0021e","areaId":11,"poolId":9,"delayOverride":-1},{"actorId":"00b0021f","areaId":11,"poolId":9,"delayOverride":-1},{"actorId":"00b00220","areaId":9,"poolId":10,"delayOverride":-1},{"actorId":"00b00221","areaId":9,"poolId":10,"delayOverride":-1},{"actorId":"00b00222","areaId":57,"poolId":11,"delayOverride":-1},{"actorId":"00b00223","areaId":94,"poolId":12,"delayOverride":-1},{"actorId":"00b00224","areaId":94,"poolId":12,"delayOverride":-1},{"actorId":"00b00225","areaId":94,"poolId":13,"delayOverride":-1},{"actorId":"00b00226","areaId":94,"poolId":13,"delayOverride":-1},{"actorId":"00b00227","areaId":94,"poolId":13,"delayOverride":-1},{"actorId":"00b00228","areaId":94,"poolId":13,"delayOverride":-1},{"actorId":"00b00229","areaId":94,"poolId":13,"delayOverride":-1},{"actorId":"00b0022a","areaId":94,"poolId":13,"delayOverride":-1},{"actorId":"00b0022b","areaId":94,"poolId":13,"delayOverride":-1},{"actorId":"00b0022c","areaId":94,"poolId":13,"delayOverride":-1},{"actorId":"00b0022d","areaId":94,"poolId":13,"delayOverride":-1},{"actorId":"00b0022e","areaId":94,"poolId":13,"delayOverride":-1},{"actorId":"00b0022f","areaId":94,"poolId":13,"delayOverride":-1},{"actorId":"00b00230","areaId":94,"poolId":13,"delayOverride":-1}],"itemEffectsSource":"bin/pausepar/pause.par::item.bin columns 13–16","itemEffects":[{"id":21,"name":"Vitality Pill","category":"FULLNESS","fullnessBeforeMultipliers":60,"currentEffectPacked":5,"capEffectPacked":3},{"id":22,"name":"Deluxe Vitality Pill","category":"FULLNESS","fullnessBeforeMultipliers":80,"currentEffectPacked":8,"capEffectPacked":4},{"id":23,"name":"Special Vitality Pill","category":"FULLNESS","fullnessBeforeMultipliers":100,"currentEffectPacked":10,"capEffectPacked":5},{"id":24,"name":"Passion Pill","category":"ENERGY","fullnessBeforeMultipliers":60,"currentEffectPacked":5,"capEffectPacked":3},{"id":25,"name":"Deluxe Passion Pill","category":"ENERGY","fullnessBeforeMultipliers":80,"currentEffectPacked":8,"capEffectPacked":4},{"id":26,"name":"Special Passion Pill","category":"ENERGY","fullnessBeforeMultipliers":100,"currentEffectPacked":10,"capEffectPacked":5},{"id":27,"name":"All-Purpose Medicine","category":"LEG","fullnessBeforeMultipliers":60,"currentEffectPacked":5,"capEffectPacked":3},{"id":28,"name":"Deluxe All-Purpose Medicine","category":"LEG","fullnessBeforeMultipliers":80,"currentEffectPacked":8,"capEffectPacked":4},{"id":29,"name":"Special All-Purpose Medicine","category":"LEG","fullnessBeforeMultipliers":100,"currentEffectPacked":10,"capEffectPacked":5},{"id":30,"name":"Ultra All-Purpose Medicine","category":"LEG","fullnessBeforeMultipliers":75,"currentEffectPacked":20,"capEffectPacked":10},{"id":31,"name":"Sober Pill","category":"ENERGY","fullnessBeforeMultipliers":5,"currentEffectPacked":-10,"capEffectPacked":-2},{"id":32,"name":"Hunger Pill","category":"FULLNESS","fullnessBeforeMultipliers":-100,"currentEffectPacked":-50,"capEffectPacked":-20},{"id":33,"name":"Manju","category":"SAND","fullnessBeforeMultipliers":60,"currentEffectPacked":0,"capEffectPacked":0},{"id":35,"name":"Ohagi","category":"LEG","fullnessBeforeMultipliers":230,"currentEffectPacked":6,"capEffectPacked":3},{"id":36,"name":"Apple Candy","category":"ENERGY","fullnessBeforeMultipliers":50,"currentEffectPacked":10,"capEffectPacked":4},{"id":37,"name":"Apricot Candy","category":"ENERGY","fullnessBeforeMultipliers":40,"currentEffectPacked":10,"capEffectPacked":2},{"id":38,"name":"Eternal Turtle Candy","category":"ENERGY","fullnessBeforeMultipliers":80,"currentEffectPacked":20,"capEffectPacked":5},{"id":39,"name":"Golden Candy","category":"LEG","fullnessBeforeMultipliers":110,"currentEffectPacked":15,"capEffectPacked":11},{"id":40,"name":"Onigiri","category":"NONE","fullnessBeforeMultipliers":0,"currentEffectPacked":0,"capEffectPacked":3},{"id":46,"name":"Grilled Dango","category":"MUD_WATER","fullnessBeforeMultipliers":200,"currentEffectPacked":50005,"capEffectPacked":20002},{"id":50,"name":"Togarashi","category":"ENERGY","fullnessBeforeMultipliers":30,"currentEffectPacked":-50,"capEffectPacked":-10},{"id":61,"name":"Saba Oshizushi","category":"WATER","fullnessBeforeMultipliers":100,"currentEffectPacked":10,"capEffectPacked":2},{"id":80,"name":"Grilled Dango","category":"MUD_WATER","fullnessBeforeMultipliers":200,"currentEffectPacked":50005,"capEffectPacked":20002},{"id":81,"name":"Matcha Dango","category":"LEG_ENERGY","fullnessBeforeMultipliers":200,"currentEffectPacked":70004,"capEffectPacked":30001},{"id":82,"name":"Three Color Dango","category":"SAND","fullnessBeforeMultipliers":200,"currentEffectPacked":10,"capEffectPacked":3},{"id":83,"name":"Kusa Dango","category":"MUD","fullnessBeforeMultipliers":200,"currentEffectPacked":8,"capEffectPacked":7},{"id":84,"name":"Ohagi","category":"LEG","fullnessBeforeMultipliers":230,"currentEffectPacked":6,"capEffectPacked":3},{"id":85,"name":"Cloudy Sake","category":"WATER","fullnessBeforeMultipliers":120,"currentEffectPacked":10,"capEffectPacked":1},{"id":86,"name":"Nada Sake","category":"ENERGY","fullnessBeforeMultipliers":140,"currentEffectPacked":8,"capEffectPacked":11},{"id":87,"name":"Satsuma Sweet Potato Shochu","category":"LEG","fullnessBeforeMultipliers":80,"currentEffectPacked":7,"capEffectPacked":10},{"id":88,"name":"Sweet Sake","category":"SAND","fullnessBeforeMultipliers":100,"currentEffectPacked":8,"capEffectPacked":10},{"id":89,"name":"Itami Morohaku","category":"WATER","fullnessBeforeMultipliers":80,"currentEffectPacked":10,"capEffectPacked":5},{"id":90,"name":"Itami Sake","category":"FULLNESS","fullnessBeforeMultipliers":90,"currentEffectPacked":12,"capEffectPacked":11},{"id":91,"name":"Taro Sake","category":"ENERGY","fullnessBeforeMultipliers":100,"currentEffectPacked":12,"capEffectPacked":12},{"id":92,"name":"Nara Morohaku","category":"LEG","fullnessBeforeMultipliers":110,"currentEffectPacked":18,"capEffectPacked":15},{"id":93,"name":"Onigiri","category":"ENERGY_LEG","fullnessBeforeMultipliers":250,"currentEffectPacked":150010,"capEffectPacked":100008},{"id":104,"name":"Large Saba Oshizushi","category":"WATER","fullnessBeforeMultipliers":100,"currentEffectPacked":10,"capEffectPacked":2},{"id":139,"name":"Ageha's Onigiri","category":"MUD","fullnessBeforeMultipliers":150,"currentEffectPacked":250,"capEffectPacked":50},{"id":140,"name":"Blazing Fire Pill","category":"ENERGY","fullnessBeforeMultipliers":30,"currentEffectPacked":1,"capEffectPacked":20},{"id":141,"name":"Exotic Pill","category":"SAND","fullnessBeforeMultipliers":30,"currentEffectPacked":1,"capEffectPacked":20},{"id":142,"name":"Gold Pill","category":"WATER","fullnessBeforeMultipliers":30,"currentEffectPacked":1,"capEffectPacked":20},{"id":143,"name":"Jet-Black Pill","category":"MUD","fullnessBeforeMultipliers":30,"currentEffectPacked":1,"capEffectPacked":20},{"id":187,"name":"Raw Chicken","category":"LEG","fullnessBeforeMultipliers":80,"currentEffectPacked":10,"capEffectPacked":8},{"id":188,"name":"Leftovers","category":"ENERGY","fullnessBeforeMultipliers":90,"currentEffectPacked":11,"capEffectPacked":7},{"id":194,"name":"Shiso","category":"MUD_SAND","fullnessBeforeMultipliers":30,"currentEffectPacked":50005,"capEffectPacked":50005},{"id":195,"name":"Sansho","category":"SAND_WATER","fullnessBeforeMultipliers":25,"currentEffectPacked":30006,"capEffectPacked":40005},{"id":196,"name":"Ginger","category":"WATER_MUD","fullnessBeforeMultipliers":30,"currentEffectPacked":30007,"capEffectPacked":40006},{"id":197,"name":"Nori","category":"ENERGY_MUD","fullnessBeforeMultipliers":40,"currentEffectPacked":70006,"capEffectPacked":30005},{"id":198,"name":"Sesame","category":"ENERGY_WATER","fullnessBeforeMultipliers":40,"currentEffectPacked":80001,"capEffectPacked":60002},{"id":199,"name":"Orange","category":"SAND_FULLNESS","fullnessBeforeMultipliers":50,"currentEffectPacked":80002,"capEffectPacked":40002},{"id":200,"name":"3-Blend Togarashi","category":"MUD","fullnessBeforeMultipliers":10,"currentEffectPacked":-15,"capEffectPacked":-10},{"id":201,"name":"5-Blend Togarashi","category":"LEG","fullnessBeforeMultipliers":10,"currentEffectPacked":-15,"capEffectPacked":-10},{"id":202,"name":"7-Blend Togarashi","category":"ENERGY","fullnessBeforeMultipliers":10,"currentEffectPacked":-15,"capEffectPacked":-10},{"id":203,"name":"Village's Offering","category":"LEG","fullnessBeforeMultipliers":100,"currentEffectPacked":40,"capEffectPacked":40},{"id":204,"name":"Kyo Parsley","category":"ENERGY","fullnessBeforeMultipliers":50,"currentEffectPacked":12,"capEffectPacked":15},{"id":205,"name":"Kujo Negi","category":"MUD","fullnessBeforeMultipliers":70,"currentEffectPacked":18,"capEffectPacked":15},{"id":206,"name":"Horikawa Burdock","category":"ENERGY","fullnessBeforeMultipliers":60,"currentEffectPacked":17,"capEffectPacked":15},{"id":208,"name":"Dried Agar","category":"FULLNESS","fullnessBeforeMultipliers":40,"currentEffectPacked":25,"capEffectPacked":30},{"id":211,"name":"Castella","category":"WATER_SAND","fullnessBeforeMultipliers":150,"currentEffectPacked":150015,"capEffectPacked":200020},{"id":214,"name":"Dried Saury","category":"LEG","fullnessBeforeMultipliers":100,"currentEffectPacked":30,"capEffectPacked":10},{"id":219,"name":"Trips Yokan","category":"SAND_WATER","fullnessBeforeMultipliers":200,"currentEffectPacked":900075,"capEffectPacked":250030},{"id":245,"name":"Tuna Sashimi","category":"LEG","fullnessBeforeMultipliers":75,"currentEffectPacked":10,"capEffectPacked":15},{"id":258,"name":"Konpeito","category":"MUD","fullnessBeforeMultipliers":60,"currentEffectPacked":12,"capEffectPacked":15},{"id":324,"name":"Worms (Small)","category":"ENERGY","fullnessBeforeMultipliers":20,"currentEffectPacked":50,"capEffectPacked":1},{"id":325,"name":"Worms (Medium)","category":"ENERGY","fullnessBeforeMultipliers":50,"currentEffectPacked":100,"capEffectPacked":3},{"id":326,"name":"Worms (Large)","category":"ENERGY","fullnessBeforeMultipliers":80,"currentEffectPacked":150,"capEffectPacked":5},{"id":327,"name":"Super Worms","category":"ENERGY","fullnessBeforeMultipliers":120,"currentEffectPacked":200,"capEffectPacked":15},{"id":328,"name":"Corbicula Clam","category":"SAND","fullnessBeforeMultipliers":80,"currentEffectPacked":5,"capEffectPacked":1},{"id":329,"name":"Manila Clam","category":"SAND","fullnessBeforeMultipliers":120,"currentEffectPacked":10,"capEffectPacked":3},{"id":330,"name":"Scallop","category":"SAND","fullnessBeforeMultipliers":150,"currentEffectPacked":15,"capEffectPacked":5},{"id":331,"name":"Sakura Shrimp","category":"MUD","fullnessBeforeMultipliers":80,"currentEffectPacked":5,"capEffectPacked":1},{"id":332,"name":"Prawn","category":"MUD","fullnessBeforeMultipliers":120,"currentEffectPacked":10,"capEffectPacked":3},{"id":333,"name":"Lobster","category":"MUD","fullnessBeforeMultipliers":150,"currentEffectPacked":15,"capEffectPacked":5},{"id":334,"name":"Ricefish","category":"WATER","fullnessBeforeMultipliers":80,"currentEffectPacked":5,"capEffectPacked":3},{"id":335,"name":"Goldfish","category":"WATER","fullnessBeforeMultipliers":120,"currentEffectPacked":10,"capEffectPacked":5},{"id":336,"name":"Sweetfish","category":"WATER","fullnessBeforeMultipliers":150,"currentEffectPacked":15,"capEffectPacked":7},{"id":337,"name":"Eel Liver","category":"ENERGY","fullnessBeforeMultipliers":80,"currentEffectPacked":5,"capEffectPacked":3},{"id":338,"name":"Mullet Roe","category":"ENERGY","fullnessBeforeMultipliers":120,"currentEffectPacked":10,"capEffectPacked":5},{"id":339,"name":"Salmon Roe","category":"ENERGY","fullnessBeforeMultipliers":150,"currentEffectPacked":15,"capEffectPacked":7},{"id":340,"name":"Snail","category":"LEG","fullnessBeforeMultipliers":80,"currentEffectPacked":5,"capEffectPacked":3},{"id":341,"name":"Loach","category":"LEG","fullnessBeforeMultipliers":120,"currentEffectPacked":10,"capEffectPacked":5},{"id":342,"name":"Crawfish","category":"LEG","fullnessBeforeMultipliers":150,"currentEffectPacked":15,"capEffectPacked":7},{"id":343,"name":"Horse Meat","category":"LEG","fullnessBeforeMultipliers":50,"currentEffectPacked":20,"capEffectPacked":8},{"id":344,"name":"Boar Meat","category":"ENERGY_LEG","fullnessBeforeMultipliers":255,"currentEffectPacked":180017,"capEffectPacked":50004}]};
},
(module, load) => {
'use strict';

const {
  createRaceRng, formMultiplier, generateRivalLineup, getEvent, normalizeTurtle, rollRaceBoard, surfaces,
} = load(3);
const { applyAmbience } = load(6);
const { createAutonomousPresentation } = load(7);
const { stepRacePresentation } = load(16);

const f32 = Math.fround;
const sectionLength = 100;
const runningOutDistance = 35;
const unit16Scale = f32(1 / 65535);
const terrain = {
  Sand: { stat: 'sand', fullness: -.05, paceNoise: .5 },
  Water: { stat: 'water', fullness: -.075, paceNoise: .75 },
  Mud: { stat: 'mud', fullness: -.1, paceNoise: 1 },
};
const mishapTarget = [0, .75, .5, undefined, .75];

function integer(value, minimum, name) {
  if (!Number.isInteger(value) || value < minimum) {
    throw new RangeError(`${name} must be an integer of at least ${minimum}`);
  }
  return value;
}

function lerp(current, target, rate) {
  return f32(f32(target - current) * rate + current);
}

function makeRacer(turtle, slot, options) {
  const normalized = normalizeTurtle(turtle, slot);
  const { runtime = {}, stats } = normalized;
  const stamina = slot === 0 && options.staminaMode === 'full' ? stats.stamina.max : stats.stamina.value;
  const appliedEntry = slot === 0 && options.applyEntryEffects;
  return {
    ...normalized,
    slot,
    stamina,
    affinity: Math.max(0, normalized.affinity - (appliedEntry && stamina <= 15 ? 8 : 0)),
    fullness: Math.max(0, stats.fullness.value - (appliedEntry ? 32 : 0)),
    form: formMultiplier(normalized.formScore),
    distance: runtime.distance ?? 0,
    velocity: runtime.velocity ?? 0,
    sectionIndex: runtime.sectionIndex ?? Math.floor(f32((runtime.distance ?? 0) / sectionLength)),
    condition: runtime.condition ?? normalized.personalityId,
    cheerActive: runtime.cheerActive ?? false,
    cheerTarget: runtime.cheerTarget ?? 1,
    cheerMultiplier: runtime.cheerMultiplier ?? 1,
    cheerDelay: runtime.cheerDelay ?? 0,
    cheerWindow: runtime.cheerWindow ?? 0,
    mishapTicks: runtime.mishapTicks ?? 0,
    mishapMultiplier: runtime.mishapMultiplier ?? 1,
    sleepUsed: runtime.sleepUsed ?? false,
    clumsyAnimation: runtime.clumsyAnimation ?? false,
    drift: runtime.drift ?? 0,
    laneFlag: runtime.laneFlag ?? 0,
    place: null,
    finishTick: null,
    staminaAtFinish: null,
    splits: [],
  };
}

function acceptCheer(racer, { rng, timerRate, scale }) {
  // +0x42C schedules the cheering period and derives its target from trust.
  const mode = racer.condition;
  const base = mode === 0 ? f32(1.4) : mode === 1 ? f32(1.5)
    : mode === 3 ? f32(rng.unit16() * f32(.2) + f32(1.4)) : f32(1.6);
  const trustFactor = f32(f32(racer.affinity / 255) * f32(.4) + f32(.8));
  racer.cheerTarget = f32(base * trustFactor);
  racer.cheerActive = true;
  const durationSeconds = [3, 2, 1, 2, 1][mode];
  racer.cheerDelay = durationSeconds === undefined ? 0 : timerRate * durationSeconds + rng.next15() % timerRate;
  racer.cheerWindow = Math.floor(31 * scale) + 1;
  // This path runs after selecting the boost from the turtle's existing affinity.
  if (racer.personalityId === 0) racer.affinity = Math.max(0, racer.affinity - 1);
  if (racer.personalityId === 2) racer.affinity = Math.min(255, racer.affinity + 1);
  // +0x13020 and +0x1384C use one shared draw for the rival and player
  // cheer sounds respectively, before forward movement begins.
  rng.next15();
}

function automaticCheer(racer, order, countCheering, race) {
  const { rng, track, finishDistance } = race;
  // The native rolls happen in sequence, including when the first attempt fails.
  const chance = p => rng.unit16() < f32(p);
  const place = order.indexOf(racer);
  const leader = order[0];
  const nearLeader = place > 0 || leader.distance - order[1].distance < 30;
  const surface = track[Math.min(track.length - 1, racer.sectionIndex)];
  const rule = terrain[surface];
  if (place > 0 && rule) {
    const skill = racer.stats[rule.stat].value;
    if (skill < 85 && chance(.01)) return true;
    if (skill >= 85 && skill < 170 && chance(.005)) return true;
  }
  if (racer.stamina > 160) {
    if (countCheering > 0 && chance(.075)) return true;
    if (chance(.0075)) return true;
  } else if (racer.stamina > 128) {
    if (countCheering > 0 && chance(.05)) return true;
    if (chance(.005)) return true;
  } else if (racer.stamina > 64 && place > 0 && chance([0, .0025, .005, .0075, .01][place])) {
    return true;
  }
  return f32(racer.distance / finishDistance) > f32(.8) && nearLeader;
}

function stepCheering(racers, requests, race) {
  const order = [...racers].sort((a, b) => b.distance - a.distance || a.slot - b.slot);
  const countCheering = racers.filter(racer => racer.cheerActive && racer.cheerWindow === 0).length;
  for (const racer of racers) {
    if (racer.stamina === 0) racer.cheerDelay = 1;
    if (racer.cheerDelay > 0) {
      racer.cheerDelay -= 1;
      if (racer.cheerDelay === 0) racer.cheerActive = false;
      continue;
    }
    if (racer.place !== null) continue;
    // The compensation patch gates the AI's decision rolls to the original cadence.
    if (requests?.has(racer.slot) || (racer.slot > 0 && race.opponentCheering && race.nativeTick &&
        automaticCheer(racer, order, countCheering, race))) {
      acceptCheer(racer, race);
    }
  }
}

function drainStamina(racer, threshold, amount, race) {
  // This low-15-bit roll still consumes a draw on intermediate updates
  // under the FPS patch. The patch only gates the stamina deduction.
  const roll = race.rng.next15() % 90;
  if (race.nativeTick && roll <= threshold) {
    racer.stamina = Math.max(0, racer.stamina - amount);
  }
}

function rollMishap(racer, race, passFactor) {
  const kind = racer.condition;
  const fullness = f32(racer.fullness / 255);
  const trust = f32(racer.affinity / 255);
  const trustFactor = f32(trust * f32(-.6) + f32(1.3));
  const formFactor = f32(f32(f32(1.2) - racer.form) * 4 + f32(.4));
  let probability = f32(f32(formFactor * passFactor * (kind === 4 ? 2 : 1)) * trustFactor);
  if (kind === 0) {
    const distance = racer.distance;
    const canSleep = distance < 25 || (distance > race.finishDistance - 50 && distance < race.finishDistance - 25);
    if (racer.sleepUsed || !canSleep) return false;
    probability = f32(f32(probability * f32(fullness * f32(.3) + 1)) * f32(.005));
  } else if (kind === 1) {
    probability = f32(f32(probability * f32(fullness * f32(.3) + 1)) * f32(.002));
  } else if (kind === 2 || kind === 4) {
    probability = f32(f32(probability * f32(fullness * f32(-.3) + f32(1.3))) * f32(.001));
  } else {
    return false;
  }
  if (race.rng.unit16() >= probability) return false;
  const frames = race.timerRate * 3 + race.rng.next15() % race.timerRate;
  racer.sleepUsed ||= kind === 0;
  racer.clumsyAnimation = kind === 2 || kind === 4;
  racer.mishapTicks = frames * (racer.clumsyAnimation ? 2 : 1);
  return true;
}

function updateStaminaAndMishaps(racer, threshold, race) {
  racer.cheerMultiplier = lerp(racer.cheerMultiplier, racer.cheerActive ? racer.cheerTarget : 1, race.smoothing);
  if (racer.cheerActive) {
    const maxMishap = Math.floor(14 * race.scale) + 1;
    racer.mishapTicks = Math.min(racer.mishapTicks, maxMishap);
    drainStamina(racer, threshold * 3, 2, race);
  }
  if (racer.cheerWindow > 0) racer.cheerWindow -= 1;

  if (racer.mishapTicks > 0) {
    racer.mishapTicks -= 1;
    if (racer.mishapTicks === 0) {
      racer.condition = racer.personalityId;
      racer.clumsyAnimation = false;
    }
    // On expiration the native callback restores the personality first.
    // Unpredictable has no active-mishap interpolation branch that update.
    const target = mishapTarget[racer.condition];
    if (target !== undefined) racer.mishapMultiplier = lerp(racer.mishapMultiplier, target, race.smoothing);
  } else {
    racer.mishapMultiplier = lerp(racer.mishapMultiplier, 1, race.smoothing);
    // The FPS patch enters the same early return as an active cheer.
    if (racer.cheerActive || !race.nativeTick) return;
    if (racer.personalityId === 3) racer.condition = race.rng.next15() % 3;
    if (!rollMishap(racer, race, 1)) {
      // The fallback persists even if its second roll misses. The game
      // restores the saved personality only when the mishap timer ends.
      racer.condition = race.rng.next15() % 3;
      rollMishap(racer, race, .5);
    }
  }
  if (racer.stamina > 0) drainStamina(racer, threshold, 1, race);
}

function moveRacer(racer, race) {
  const { track, rng } = race;
  racer.sectionIndex = Math.min(Math.trunc(f32(racer.distance / sectionLength)), track.length - 1);
  const rule = terrain[track[racer.sectionIndex]];
  const skill = rule ? racer.stats[rule.stat].value : 0;
  const threshold = 9 - 3 * Math.min(2, Math.trunc(skill / 85));
  const power = f32(racer.stats.legPower.value * f32(.002) + .5);
  const fullness = f32(f32(racer.fullness / 255) * f32(rule?.fullness ?? -.025) + 1);
  const skillFactor = rule ? f32(f32(skill / 255) * .5 + .5) : 1;
  // Non-normal surfaces draw the pace variation before updating stamina.
  const paceNoise = rule ? f32(f32(rng.next16() * unit16Scale - .75) * rule.paceNoise + 1) : 1;
  updateStaminaAndMishaps(racer, threshold, race);

  // +0xF40 / +0x1080 / +0x12BC / +0x14F8, keeping the single-precision
  // arithmetic and updating the cumulative forward distance in slot order.
  let pace = f32(fullness * power);
  pace = f32(pace * skillFactor);
  pace = f32(pace * paceNoise);
  pace = f32(pace * racer.cheerMultiplier);
  pace = f32(pace * racer.mishapMultiplier);
  pace = f32(pace * racer.form);
  const stamina = f32(f32(racer.stamina / 255) * .25 + .75);
  const previous = racer.distance;
  racer.distance = f32(f32(pace / race.scale) * stamina + previous);

  // +0x8F3C / +0x9198 consume the shared stream when a stumble
  // reaches a lateral limit. The displacement itself is visual.
  if (racer.clumsyAnimation) {
    const flip = racer.laneFlag ? racer.drift > f32(.9) : racer.drift < f32(-.9);
    if (flip && rng.unit16() < f32(.03) && race.nativeTick) racer.laneFlag ^= 32;
    racer.drift = lerp(racer.drift, racer.laneFlag ? 1 : -1, race.driftSmoothing);
  } else {
    racer.drift = lerp(racer.drift, 0, race.driftSmoothing);
  }
  return f32(racer.distance - previous);
}

function snapshot(tick, racers, race) {
  return {
    tick,
    seconds: tick / race.fps,
    frameCounter: race.frameCounter,
    nativeTick: race.nativeTick,
    seed: race.rng.seed,
    draws: race.rng.draws,
    presentation: race.presentation,
    ...(race.modelNoise && { modelNoise: race.modelNoise }),
    racers: racers.map(({ id, slot, name, distance, velocity, sectionIndex, stamina, fullness, affinity, place, finishTick,
      condition, cheerActive, cheerDelay, cheerWindow, cheerTarget, cheerMultiplier, mishapTicks, mishapMultiplier,
      sleepUsed, clumsyAnimation, drift, laneFlag }) => ({
      id, slot, name, distance, velocity, sectionIndex, stamina, fullness, affinity, place, finishTick,
      surface: race.track[Math.min(race.track.length - 1, sectionIndex)],
      condition, cheerActive, cheerDelay, cheerWindow, cheerTarget, cheerMultiplier, mishapTicks, mishapMultiplier,
      sleepUsed, clumsyAnimation, drift, laneFlag,
    })),
  };
}

function simulateRace(options = {}) {
  const {
    eventId, player, lineup, sections, seed = 1, raceSeed, fps = 30, fpsPatch = true, staminaMode = 'saved',
    cheerTicks = [], traceEvery = 0, onFrame, maxTicks = fps * 240, titleRaceFix = false, maxRivalAttempts,
    opponentCheering = true, frameSeeds, presentationFrames, nativePresentationStart, modelNoiseGeometry,
    generateModelNoiseGeometry,
    waterRippleOrigin = 'unobserved',
    frameCounterOffset = 0, applyEntryEffects = !lineup,
  } = options;
  if (![30, 60, 120].includes(fps)) throw new RangeError('Choose 30, 60, or 120 FPS');
  if (!['saved', 'full'].includes(staminaMode)) throw new RangeError('Choose saved or full stamina');
  if (!['unobserved', 'every-update', 'native-update'].includes(waterRippleOrigin)) {
    throw new RangeError('Unknown water ripple origin cadence');
  }
  if (nativePresentationStart && (frameSeeds || presentationFrames)) {
    throw new TypeError('Autonomous presentation accepts starting state only');
  }
  if (modelNoiseGeometry !== undefined && (!nativePresentationStart || !(modelNoiseGeometry instanceof Map))) {
    throw new TypeError('Model timer geometry replay needs the starting presentation state and a frame map');
  }
  if (generateModelNoiseGeometry !== undefined &&
      (!nativePresentationStart || modelNoiseGeometry || typeof generateModelNoiseGeometry !== 'function')) {
    throw new TypeError('Generated geometry needs the starting presentation state and its own scene generator');
  }
  integer(traceEvery, 0, 'traceEvery');
  integer(maxTicks, 1, 'maxTicks');
  integer(frameCounterOffset, 0, 'frameCounterOffset');
  const event = eventId === undefined ? null : getEvent(eventId);
  const setupRng = createRaceRng(seed);
  if (!sections && !event) throw new TypeError('Supply track sections or an event ID');
  if (!lineup && (!player || !event)) throw new TypeError('Supply a fixed lineup or a player and event ID');
  const layout = sections ? [...sections] : rollRaceBoard(setupRng).layouts[event.id];
  if (!layout.length || layout.length > 5 || layout.some(section => !surfaces.includes(section))) {
    throw new RangeError('Supply one to five resolved track sections (Normal, Water, Sand, or Mud)');
  }
  const diagnostics = {
    model: 'native-race-movement',
    frameRateMode: fps === 30 ? 'original-30' : fpsPatch ? 'compensated' : 'uncompensated',
    setup: lineup ? 'fixed lineup' : 'generated rivals',
    rngStart: raceSeed === undefined ? 'setup stream' : 'captured race seed',
    waterRippleOrigin,
    setupDraws: setupRng.draws,
    limits: [
      'Menus, countdown, betting, and unobserved presentation can advance the same RNG.',
      nativePresentationStart ? 'Generated presentation leaves unresolved native callbacks out.' :
        'Presentation replay requires inputs from the native callback checkpoint.',
    ],
  };
  const generated = lineup ? null : generateRivalLineup({ eventId, player, rng: setupRng, titleRaceFix, maxRivalAttempts });
  diagnostics.setupDraws = setupRng.draws;
  if (generated) diagnostics.rivalAttempts = generated.attempts;
  if (generated?.status === 'no-start') {
    return { status: 'no-start', reason: generated.reason, sections: layout, results: [], trace: [], seed: setupRng.seed, diagnostics };
  }
  const starters = lineup ?? generated.lineup;
  if (!Array.isArray(starters) || starters.length !== 5) throw new RangeError('A race needs exactly five turtles');
  const racers = starters.map((turtle, slot) => makeRacer(turtle, slot, { applyEntryEffects, staminaMode }));
  const autonomous = nativePresentationStart
    ? createAutonomousPresentation(nativePresentationStart, racers, modelNoiseGeometry, generateModelNoiseGeometry) : null;
  const inputByTick = new Map();
  for (const press of cheerTicks) {
    const tick = integer(typeof press === 'number' ? press : press.tick, 1, 'Cheer tick');
    const slot = typeof press === 'number' ? 0 : integer(press.slot, 0, 'Cheer slot');
    if (slot >= 5) throw new RangeError('Cheer slots range from zero to four');
    if (!inputByTick.has(tick)) inputByTick.set(tick, new Set());
    inputByTick.get(tick).add(slot);
  }

  const track = ['Start', ...layout, 'Finish'];
  const scale = fpsPatch ? fps / 30 : 1;
  const race = {
    fps, track, scale, opponentCheering,
    timerRate: fps,
    nativeTick: false,
    frameCounter: frameCounterOffset,
    finishDistance: track.length * sectionLength,
    smoothing: f32(1 - Math.pow(1 - f32(.1), 1 / scale)),
    driftSmoothing: f32(1 - Math.pow(1 - f32(.05), 1 / scale)),
    rng: raceSeed === undefined ? setupRng : createRaceRng(raceSeed),
  };
  const trace = [];
  const results = [];
  const presentation = {
    suppliedFrames: 0,
    generatedFrames: 0,
    resolvedAnimationFrames: 0,
    commentaryFrames: 0,
    crowdFrames: 0,
    sharedDraws: 0,
    ...((modelNoiseGeometry || generateModelNoiseGeometry) && { modelNoiseFrames: 0, modelNoiseDraws: 0 }),
  };
  const emit = (tick, force) => {
    if ((!traceEvery || (!force && tick % traceEvery !== 0)) && !onFrame) return;
    const frame = snapshot(tick, racers, race);
    if (traceEvery && (force || tick % traceEvery === 0)) trace.push(frame);
    onFrame?.(frame);
  };
  const resolvePlace = (racer, tick) => {
    racer.place = results.length + 1;
    racer.finishTick = tick;
    racer.staminaAtFinish = racer.stamina;
    // The crossing callback clears active cheering but preserves the boost timers.
    if (tick !== null) racer.cheerActive = false;
    results.push(racer);
  };
  emit(0, true);
  let tick = 0;
  let geometryIncomplete = false;
  while (results.length < 4 && tick < maxTicks) {
    tick += 1;
    race.frameCounter = frameCounterOffset + tick;
    race.nativeTick = race.frameCounter % scale === 0;
    const observedSeed = frameSeeds instanceof Map ? frameSeeds.get(tick) : frameSeeds?.[tick];
    if (observedSeed !== undefined) race.rng = createRaceRng(observedSeed);
    stepCheering(racers, inputByTick.get(tick), race);
    const previousDistances = autonomous && racers.map(racer => racer.distance);
    for (const racer of racers) {
      if (racer.distance > race.finishDistance + runningOutDistance) continue;
      const previous = racer.distance;
      racer.velocity = moveRacer(racer, race);
      const boundary = Math.floor(previous / sectionLength) + 1;
      if (boundary <= track.length && racer.distance >= boundary * sectionLength) {
        racer.splits.push({ section: boundary, tick, seconds: tick / fps, stamina: racer.stamina });
      }
      if (racer.place === null && racer.distance >= race.finishDistance) resolvePlace(racer, tick);
    }
    // Once four have crossed, the game assigns the remaining slot fifth.
    if (results.length === 4) resolvePlace(racers.find(racer => racer.place === null), null);
    const animation = presentationFrames instanceof Map ? presentationFrames.get(tick) : presentationFrames?.[tick];
    race.presentation = undefined;
    if (autonomous) {
      const drawsBefore = race.rng.draws;
      race.presentation = autonomous.step(race, racers, previousDistances, results.length, tick);
      presentation.generatedFrames += 1;
      if (race.presentation.complete) presentation.resolvedAnimationFrames += 1;
      if (race.presentation.commentary?.complete) presentation.commentaryFrames += 1;
      if (race.presentation.crowd?.complete) presentation.crowdFrames += 1;
      presentation.sharedDraws += race.rng.draws - drawsBefore;
    } else if (animation !== undefined) {
      const drawsBefore = race.rng.draws;
      // State 16 runs commentary, racer presentation, then crowd animation.
      const commentary = animation?.commentary === undefined ? undefined :
        applyAmbience(race.rng, 'commentary', animation.commentary);
      const update = stepRacePresentation(race, racers, animation);
      const crowd = animation?.crowd === undefined ? undefined : applyAmbience(race.rng, 'crowd', animation.crowd);
      race.presentation = { ...update, commentary, crowd };
      presentation.suppliedFrames += 1;
      if (update.complete) presentation.resolvedAnimationFrames += 1;
      if (commentary) presentation.commentaryFrames += 1;
      if (crowd) presentation.crowdFrames += 1;
      presentation.sharedDraws += race.rng.draws - drawsBefore;
    }
    // The arena stage task scatters the water ripple grid's X/Z origin.
    // On the measured profile the pair runs after the race module every update.
    if (waterRippleOrigin === 'every-update' || (waterRippleOrigin === 'native-update' && race.nativeTick)) {
      race.rng.next16();
      race.rng.next16();
    }
    const modelNoise = autonomous?.afterRipple(race, tick);
    if (generateModelNoiseGeometry) {
      race.modelNoise = modelNoise;
      geometryIncomplete = modelNoise?.complete !== true;
    }
    if (modelNoise?.complete) {
      presentation.modelNoiseFrames += 1;
      presentation.modelNoiseDraws += modelNoise.draws;
    }
    if (geometryIncomplete) {
      emit(tick, true);
      break;
    }
    emit(tick, results.length >= 4 || tick === maxTicks);
  }
  diagnostics.presentation = {
    ...presentation,
    unobservedFrames: tick - presentation.suppliedFrames - presentation.generatedFrames,
    ...(autonomous && { unmodeled: [...autonomous.missing], firstUnsupported: autonomous.firstUnsupported }),
  };
  return {
    status: geometryIncomplete ? 'incomplete' : results.length === 5 ? 'finished' : 'timeout',
    sections: layout,
    finishDistance: race.finishDistance,
    tick,
    seed: race.rng.seed,
    results: results.map(racer => ({
      id: racer.id,
      slot: racer.slot,
      name: racer.name,
      place: racer.place,
      finishTick: racer.finishTick,
      finishSeconds: racer.finishTick === null ? null : racer.finishTick / fps,
      stamina: racer.staminaAtFinish,
      splits: racer.splits,
    })),
    trace,
    diagnostics,
  };
}

module.exports = { createRaceRng, generateRivalLineup, rollRaceBoard, simulateRace };

},
(module, load) => {
'use strict';

const f32 = Math.fround;
const placeCues = [8, 5, 6];
const pleasedClips = [0x857, 0x851, 0x852, 0x860];
const crowdClips = {
  start: [0x852, 0x3f8, 0x858, 0x3f9, 0x860, 0x3dd],
  race: [0x858, 0x3d6, 0x3d7, 0x3dd, 0x3d5, 0x857, 0x932, 0x933, 0x851, 0x4cc, 0x4cd, 0x4ce, 0x4cf],
  finish: [0x3d6, 0x3d7, 0x932, 0x933, 0x4d1],
  pleasedFinish: [...pleasedClips, 0x4d0],
  pleasedFeatured: [0x852, 0x860],
};

function integer(value, name) {
  if (!Number.isInteger(value)) throw new TypeError(`${name} must be an integer`);
  return value;
}

function boolean(value, name) {
  if (typeof value !== 'boolean') throw new TypeError(`${name} must be a boolean`);
  return value;
}

function scheduleCue(rng, cueId, callback) {
  const {
    previousCueId, previousVariant, elapsedTicks, raceState, durationUnits, fps, minimumTicks = 30,
  } = callback;
  integer(cueId, 'cueId');
  integer(previousCueId, 'previousCueId');
  integer(elapsedTicks, 'elapsedTicks');
  integer(raceState, 'raceState');
  if (!Number.isInteger(minimumTicks) || minimumTicks < 1) {
    throw new RangeError('Commentary needs a positive acceptance threshold');
  }
  // +0x18E24 can reject a cue before consuming RNG. Same-cue speech
  // alternates variants at +0x190DC without the draw at +0x18FE8.
  if (elapsedTicks < minimumTicks && cueId !== 17 && raceState !== 8) {
    return { cueId, accepted: false };
  }
  if (!Number.isInteger(durationUnits) || durationUnits < 0 || !Number.isInteger(fps) || fps < 1) {
    throw new RangeError('An accepted commentary cue needs nonnegative duration units and a positive FPS');
  }
  if (cueId === previousCueId && ![0, 1].includes(previousVariant)) {
    throw new RangeError('A repeated commentary cue needs its previous variant (0 or 1)');
  }
  const duration = f32(durationUnits * .5);
  const randomDuration = f32(f32(duration * rng.unit16()) * fps);
  const timer = Math.max(minimumTicks, Math.trunc(duration) * fps + Math.trunc(randomDuration));
  const variant = cueId === previousCueId ? previousVariant ^ 1 : rng.next15() & 1;
  return { cueId, accepted: true, variant, timer };
}

function selectPlaceCue(rng, callback) {
  const slot = integer(callback.slot, 'slot');
  if (slot < -1 || slot > 4) throw new RangeError('Place commentary slot must be -1 through 4');
  // +0x192FC selects code 7 without a draw for slot -1. For other slots
  // the selected cue rotates once if it would repeat the current cue ID.
  let cueId = 7;
  if (slot >= 0) {
    const index = rng.next15() % placeCues.length;
    cueId = placeCues[index] === callback.previousCueId
      ? placeCues[(index + 1) % placeCues.length] : placeCues[index];
  }
  return scheduleCue(rng, cueId, { ...callback, durationUnits: 3 });
}

function commentaryRoll(rng, site) {
  switch (site) {
    case '294b8':
      return { passed: rng.unit16() > .5 };
    case '29578':
      // This branch can then call +0x18E24. Record the separate cue
      // callback to account for its gate and individual draws.
      return { passed: rng.unit16() > f32(.9) };
    case '2a70c': {
      const passed = rng.unit16() < f32(.1);
      return { passed, cameraAction: passed ? (rng.next15() & 1) + 1 : null };
    }
    default:
      throw new RangeError(`Unknown native commentary roll "${site}"`);
  }
}

function isCrowdClip(clip) {
  // +0x2B570 filters clip IDs using the five set bits in the native mask.
  return clip >= 0x851 && clip <= 0x860 && Boolean(0x80c3 & (1 << (clip - 0x851)));
}

function selectCrowdClip(rng, callback) {
  const { stage, featured, favoursLeader, pastHalf, refresh } = callback;
  if (!['start', 'race', 'finish'].includes(stage)) throw new RangeError('Unknown crowd selector stage');
  boolean(featured, 'featured');
  boolean(refresh, 'refresh');
  const pleased = stage !== 'start' && boolean(favoursLeader, 'favoursLeader') && boolean(pastHalf, 'pastHalf');
  // +0x2BADC / +0x2B848 / +0x2B5A8 always consume one draw. The
  // refresh retry walks the chosen clip table cyclically without drawing.
  const roll = rng.next15();
  if (featured) {
    return { clip: pleased ? crowdClips.pleasedFeatured[roll & 1] : 0x3f8 };
  }
  const clips = pleased
    ? stage === 'finish' ? crowdClips.pleasedFinish : pleasedClips
    : crowdClips[stage];
  let index = roll % clips.length;
  if (refresh && (stage !== 'finish' || pleased)) {
    while (!isCrowdClip(clips[index])) index = (index + 1) % clips.length;
  }
  return { clip: clips[index] };
}

function startCrowdAnimation(rng, callback) {
  if (!boolean(callback.pending, 'pending')) return { started: false };
  boolean(callback.featured, 'featured');
  // +0x2BFD0 consumes +0x2C0CC then +0x2C138 when the actor's animation
  // start word (+0x4D0) is set.
  // Only ordinary actors take the angle jitter draw at +0x2C20C.
  const phaseRoll = rng.next15();
  const speedRoll = rng.next16();
  const angleJitter = callback.featured ? null : ((rng.next15() >>> 2) - 0x1000);
  return { started: true, phaseRoll, speedRoll, angleJitter };
}

function applyAmbience(rng, phase, callbacks = []) {
  if (phase !== 'commentary' && phase !== 'crowd') throw new RangeError('Unknown native ambience phase');
  if (!Array.isArray(callbacks)) throw new TypeError('Ambience callbacks must be an ordered array');
  const startDraws = rng.draws;
  // Commentary occurs after +0x8C6C and before +0x07468. Crowd comes
  // after +0x07468. A commentary cue can itself select crowd clips via
  // +0x05394. Inside +0x02D90, each actor's selector precedes its update.
  const outputs = callbacks.map(callback => {
    const { kind } = callback;
    if (kind === 'crowd-selector') return selectCrowdClip(rng, callback);
    if (kind === 'crowd-animation' && phase === 'crowd') return startCrowdAnimation(rng, callback);
    if (phase === 'commentary') {
      if (kind === 'cue') return scheduleCue(rng, callback.cueId, callback);
      if (kind === 'place-cue') return selectPlaceCue(rng, callback);
      if (kind === 'commentary-roll') return commentaryRoll(rng, callback.site);
    }
    throw new RangeError(`Native callback "${kind}" does not run in ${phase}`);
  });
  return { outputs, draws: rng.draws - startDraws, seed: rng.seed };
}

module.exports = { applyAmbience, scheduleCue, selectPlaceCue, isCrowdClip, selectCrowdClip, startCrowdAnimation };

},
(module, load) => {
'use strict';

const { createCommentaryState, stepCommentaryState } = load(8);
const { createCrowdAnimation, createCrowdState, queueCrowdReaction, stepCrowdState, updateCrowdFlags } = load(11);
const { applyModelNoise, createModelNoise } = load(13);
const { planModelNoiseFrame } = load(14);
const { advanceRacerMotion, initializeRacerMotion, presentationInput, projectLateralOffset, projectStep, racerScale } = load(15);
const { stepRacePresentation } = load(16);

function createAutonomousPresentation(start, racers, modelNoiseGeometry, generateModelNoiseGeometry) {
  if (start.racers?.length !== racers.length || typeof start.effectManagerActive !== 'boolean') {
    throw new TypeError('Autonomous presentation needs the initial racer animation and effect state');
  }
  const motion = start.racers.map((sample, slot) => {
    if (![sample.smoothedDistance, sample.forwardDelta].every(Number.isFinite)) {
      throw new RangeError('Initial racer projection state is incomplete');
    }
    const racer = racers[slot];
    return {
      smoothedDistance: sample.smoothedDistance,
      forwardDelta: sample.forwardDelta,
      lateralOffset: sample.lateralOffset ?? 0,
      animation: initializeRacerMotion({
        ...sample,
        scale: sample.scale ?? racerScale(racer.stamina, racer.stats.legPower.value),
      }),
    };
  });
  const commentary = start.commentary ? createCommentaryState(start.commentary) : null;
  const crowd = start.crowd ? createCrowdState(start.crowd) : null;
  const crowdClock = crowd && start.animationTiming ? createCrowdAnimation(start.crowd, start.animationTiming) : null;
  const missing = new Set();
  const firstUnsupported = {};
  const timerStart = start.modelNoise;
  const usesModelGeometry = modelNoiseGeometry || generateModelNoiseGeometry;
  if (usesModelGeometry && !Array.isArray(timerStart?.timers)) {
    throw new TypeError('Geometry replay needs initial model timer state');
  }
  const timers = usesModelGeometry ? createModelNoise(timerStart.timers) : null;
  if (!commentary) missing.add('Initial commentary state');
  if (!crowdClock) missing.add('Crowd animation controller');
  else if (!crowdClock.complete) crowdClock.missing.forEach(reason => missing.add(reason));
  if (!timers) missing.add('Camera-dependent model-noise callback scheduling');
  let commentaryStopped = false;
  let crowdStopped = !crowdClock?.complete;

  return {
    missing,
    firstUnsupported,
    afterRipple(race, tick) {
      if (!timers || firstUnsupported.modelNoise !== undefined) return undefined;
      const frame = generateModelNoiseGeometry
        ? generateModelNoiseGeometry({
          frame: race.frameCounter, fps: race.fps, scale: race.scale, track: race.track,
          racers, motion, presentation: race.presentation,
        })
        : modelNoiseGeometry.get(race.frameCounter);
      const plan = frame?.actors?.length ? planModelNoiseFrame(frame) : undefined;
      if (!plan?.complete) {
        firstUnsupported.modelNoise = tick;
        for (const reason of plan?.missing ?? frame?.missing ?? ['Missing camera and actor geometry']) missing.add(reason);
        return { complete: false };
      }
      if (plan.callbacks.some(callback => !timers.has(callback.timer))) {
        firstUnsupported.modelNoise = tick;
        missing.add('Missing initial state for an admitted model timer');
        return { complete: false };
      }
      const update = applyModelNoise(race.rng, timers, plan.callbacks, timerStart.arithmetic);
      return generateModelNoiseGeometry ? {
        complete: true, draws: update.draws, rerolled: update.rerolled,
        timers: plan.callbacks.map(callback => callback.timer),
      } : { complete: true, draws: update.draws };
    },
    step(race, racers, previousDistances, finishCount, tick) {
      const leader = racers.find(racer => racer.place === 1) ??
        racers.reduce((best, racer) => racer.distance > best.distance ? racer : best);
      const progress = {
        state: 16, raceState: 16, fps: race.fps, finishCount, leaderSlot: leader.slot,
        nativeTick: race.nativeTick, minimumTicks: 30 * race.scale,
        leaderDistance: leader.distance, trackLength: race.finishDistance,
      };
      let speech;
      const anchorResets = [];
      if (commentary && !commentaryStopped) {
        if (race.nativeTick) {
          progress.racers = racers.map(racer => {
            const sleepActive = racer.condition === 0 && racer.mishapTicks > 0;
            return {
              slot: racer.slot, distance: racer.distance, place: racer.place, sleepActive,
              surface: race.track[racer.sectionIndex],
              pace: racer.velocity,
              cheering: racer.cheerActive && racer.cheerWindow === 0,
              stumbling: racer.clumsyAnimation || (!sleepActive && racer.mishapTicks > 0),
            };
          });
        }
        speech = stepCommentaryState(commentary, race.rng, progress, stage => {
          if (crowd) {
            const queued = queueCrowdReaction(crowd, race.rng, stage, progress.state);
            if (generateModelNoiseGeometry) anchorResets.push(...queued.map(actor => actor.slot));
          }
        });
        if (!speech.complete) {
          commentaryStopped = true;
          firstUnsupported.commentary = tick;
          missing.add(speech.reason);
        }
      }
      const inputs = motion.map((state, slot) => {
        const racer = racers[slot];
        if (previousDistances[slot] <= race.finishDistance + 35) {
          Object.assign(state, projectStep(state.smoothedDistance, racer.distance, previousDistances[slot] >= race.finishDistance,
            race.finishDistance, race.scale * 30));
          state.lateralOffset = projectLateralOffset(state.lateralOffset, racer.clumsyAnimation, racer.laneFlag,
            state.animation.scale, race.scale * 30);
        }
        const sleepActive = racer.condition === 0 && racer.mishapTicks > 0;
        return presentationInput(state.animation, state, sleepActive);
      });
      const update = stepRacePresentation(race, racers, { racers: inputs, effectManagerActive: start.effectManagerActive });
      if (!update.complete) update.missing.forEach(reason => missing.add(reason));
      const events = new Map((update.events ?? []).map(event => [event.slot, event]));
      motion.forEach(({ animation }, slot) => {
        advanceRacerMotion(animation, inputs[slot].forwardDelta, inputs[slot].sleepActive, events.get(slot), race.fps);
      });
      const crowdUpdate = crowdStopped ? undefined : stepCrowdState(crowd, race.rng, progress, crowdClock.animation);
      if (crowdUpdate && anchorResets.length) crowdUpdate.anchorResets = anchorResets;
      if (crowdStopped && crowd) updateCrowdFlags(crowd, progress);
      if (crowdUpdate?.complete === false) {
        crowdStopped = true;
        firstUnsupported.crowd = tick;
        crowdUpdate.missing.forEach(reason => missing.add(reason));
      }
      return { ...update, commentary: speech, crowd: crowdUpdate };
    },
  };
}

module.exports = { createAutonomousPresentation };

},
(module, load) => {
'use strict';

const { scheduleCue, selectPlaceCue } = load(6);
const { finishCommentaryStandings, selectFinishCommentary } = load(9);
const { lateCameraFollowup, selectLateStandings } = load(10);

const ready = 0x75;
const opening = 0x13;
const f32 = Math.fround;
// Initial camera setup in the +0x18E24 dispatch table. A single native
// store can publish three advances for a vector with three random axes.
const cameraJitterDraws = new Map([
  [5, 0], [6, 6], [7, 3], [8, 0], [10, 3], [12, 0], [13, 1], [14, 3], [15, 0], [16, 0],
]);

function createCommentaryState(start) {
  const { phase, previousPhase, pause, cueId, variant, duration, remaining, soundMask } = start;
  if (![phase, previousPhase, pause, cueId, variant, duration, remaining, soundMask].every(Number.isInteger) ||
      pause < 0 || duration < 0 || remaining < 0 || remaining > duration || soundMask < 0 || soundMask >= 31) {
    throw new RangeError('Incomplete native commentator starting state');
  }
  const completedOpening = phase === ready && previousPhase === opening && pause > 0 &&
    Number.isInteger(start.pauseLength) && start.pauseLength >= pause &&
    Array.isArray(start.rankHistory) && start.rankHistory.length === 5 &&
    Array.isArray(start.gapHistory) && start.gapHistory.length === 4;
  if (!completedOpening && (phase !== ready || previousPhase !== ready || pause !== 0)) {
    throw new RangeError('Commentary replay needs the opening director state');
  }
  return {
    phase, previousPhase, pause, cueId, variant, duration, remaining, soundMask, pauseLength: pause,
    sleepMask: 0, mishapMask: 0, eventCount: 0, previousEventPhase: ready, quietTicks: 0,
    cheerCooldowns: [0, 0, 0, 0, 0], mishapCooldowns: [0, 0, 0, 0, 0],
    lastPlaceMask: 0, lastLeader: -1, focusSlot: -1, sceneWait: 0, sceneType: 0,
    previousLeader: -1, previousScene: ready, announcedFinishCount: 0,
    gapHistory: [0, 0, 0, 0], rankHistory: [],
    ...(completedOpening && {
      pauseLength: start.pauseLength, previousScene: start.previousScene,
      sceneType: start.sceneType, gapHistory: [...start.gapHistory], rankHistory: [...start.rankHistory],
    }),
  };
}

function applyAcceptedCue(state, rng, cue, onReaction) {
  if (!cue.accepted) return null;
  state.cueId = cue.cueId;
  state.variant = cue.variant;
  state.duration = cue.timer;
  state.remaining = cue.timer;
  const jitter = cameraJitterDraws.get(cue.cueId);
  if (jitter === undefined) return `Unmodeled commentary camera handler for cue ${cue.cueId}`;
  cue.cameraRandomWords = Array.from({ length: jitter }, () => rng.next16());
  onReaction?.('race');
  return null;
}

function playReaction(state, rng) {
  let sound = rng.next15() % 5;
  while (state.soundMask & (1 << sound)) sound = (sound + 1) % 5;
  state.soundMask |= 1 << sound;
  if (state.soundMask === 31) state.soundMask = 0;
  return sound;
}

function directCueForProgress(progress, cueId, rng) {
  if (progress > f32(.98)) return cueId !== 16 ? [16, 6] : null;
  if (progress > f32(.825)) return cueId !== 15 ? [15, 3] : null;
  if (progress > f32(.775)) return cueId !== 10 && rng.unit16() > f32(.9) ? [10, 1] : null;
  if (progress > f32(.6) && cueId === 14) return [null, 3];
  return null;
}

function raceInterruption(state, racers, progress, trackLength, rng) {
  const sorted = [...racers].sort((a, b) => b.distance - a.distance || a.slot - b.slot);
  const gaps = sorted.slice(0, -1).map((racer, rank) => f32(racer.distance - sorted[rank + 1].distance));
  const at = racer => f32(racer.distance / trackLength);
  let phase = ready;
  let pause = 0;
  let slot;
  let count = 0;
  let cueId;
  let durationUnits = 3;

  // PRX +0x28F40 handles a new sleeper before checking cheers or stumbles.
  for (const racer of racers) {
    const bit = 1 << racer.slot;
    if ((state.sleepMask & bit) || !racer.sleepActive) continue;
    if (at(racer) >= .5) {
      phase = count ? 3 : 2;
      pause = progress <= f32(.9) ? 45 : 30;
    } else {
      phase = count ? 1 : 0;
      pause = 60;
    }
    count++;
    slot = racer.slot;
    state.sleepMask |= bit;
    playReaction(state, rng);
  }
  if (count > 0) {
    if (progress < f32(.6)) {
      cueId = count === 1 ? (state.cueId === 12 ? 5 : 12) : (state.cueId === 8 ? 5 : 8);
    }
    return { phase, pause, cueId, durationUnits, slot, keepFocusX: cueId === 12 };
  }
  if (state.eventCount >= 2 || progress >= f32(.95)) return null;

  const near = (racer, ratio) => at(racer) <= f32(.975) && f32(at(racer) / progress) >= f32(ratio);
  const cheering = racers.filter(racer => racer.cheering && near(racer, .75));
  const recent = cheering.filter(racer => state.cheerCooldowns[racer.slot] > 0).length;
  for (const racer of cheering) {
    const rank = sorted.indexOf(racer);
    slot = racer.slot;
    if (state.cheerCooldowns[slot] > 0 && ++count !== recent) continue;
    if (count < 2 && recent < 1) {
      if ((rank === 0 && gaps[0] < 15) || (rank === 1 && gaps[0] < 30) ||
          (rank === 2 && f32(gaps[0] + gaps[1]) < 45)) phase = 4;
      else if (rank > 2 && at(racer) < .5) phase = 8;
    } else {
      phase = progress > f32(.6) ? 7 : progress > f32(.3) ? 6 : 5;
    }
    pause = progress > f32(.85) ? 30 : progress < .5 ? 60 : 45;
    state.cheerCooldowns[slot] = 160;
    count++;
  }
  if (pause > 0) {
    if (progress < f32(.6)) cueId = state.cueId === 8 ? 5 : 8;
    return { phase, pause, cueId, durationUnits, slot };
  }
  count = 0;
  for (const racer of racers) {
    const bit = 1 << racer.slot;
    if ((state.mishapMask & bit) || state.mishapCooldowns[racer.slot] > 0 ||
        !near(racer, .85) || !racer.stumbling) continue;
    const rank = sorted.indexOf(racer);
    slot = racer.slot;
    if (rank === 0 && gaps[0] < 60) phase = 11;
    else if (rank === 1 && gaps[1] < 60) phase = 12;
    else phase = [10, 11, 12, 13].includes(state.previousEventPhase) ? 10 : 13;
    pause = progress > f32(.85) ? 30 : at(racer) >= .5 ? 45 : 60;
    state.mishapMask |= bit;
    state.mishapCooldowns[slot] = 160;
    count++;
  }
  if (!count) return null;
  if (progress < f32(.6)) {
    cueId = count === 1 ? (state.cueId === 13 ? 5 : 13) : (state.cueId === 8 ? 5 : 8);
    if (cueId === 13) durationUnits = 10;
  }
  return { phase, pause, cueId, durationUnits, slot, keepFocusX: cueId === 13 };
}

// Third word of the native +0x27914 voice table for phases 0x14–0x39.
const raceSceneTypes = [
  1, 8, 0, 1, 1, 6, 7, 8, 0, 1, 1, 1, 3, 4, 7, 9, 8, 0, 1, 6, 6, 6, 6, 8, 8,
  0, 1, 1, 1, 3, 4, 4, 4, 6, 7, 9, 9, 8,
];

function standingsCommentary(state, progress, racers, rng) {
  const rank = [...racers].sort((a, b) => b.distance - a.distance || a.slot - b.slot);
  const gaps = rank.slice(0, -1).map((racer, index) => f32(racer.distance - rank[index + 1].distance));
  const leader = rank[0].slot;
  const last = rank[4].slot;
  const lastBit = 1 << last;
  const lastAlreadyNamed = (state.lastPlaceMask | state.sleepMask | state.mishapMask) & lastBit;
  let phase;
  let pause = 60;
  let cueId = null;
  let placeSlot = 1;
  if (state.previousPhase === opening && progress < f32(.2)) {
    phase = gaps[0] > 10 || state.sleepMask || state.mishapMask ? 0x14 : 0x15;
    state.lastLeader = phase === 0x14 ? leader : -1;
    pause = 75;
    cueId = undefined;
  } else if (progress < f32(.3) && state.previousPhase <= 0x16) {
    if (!lastAlreadyNamed && gaps[3] > 15) {
      phase = 0x1a;
      cueId = state.cueId === 7 ? 8 : 7;
      state.lastPlaceMask |= lastBit;
      state.focusSlot = last;
    } else if (gaps[0] > 15) {
      phase = state.lastLeader === -1 ? 0x17 : 0x18;
      state.lastLeader = leader;
      state.focusSlot = -1;
    } else {
      phase = gaps[1] > 15 ? 0x19 : 0x1b;
      state.lastLeader = phase === 0x19 ? leader : -1;
      state.focusSlot = -1;
    }
  } else if (progress < f32(.5) && state.previousPhase < 0x26) {
    if (state.sceneWait === 0) {
      state.sceneWait = 15;
      return null;
    }
    if (--state.sceneWait > 0) return null;
    const spread = gaps.reduce((total, gap) => f32(total + gap), 0);
    if (progress >= f32(.4) || state.previousPhase > 0x1c) {
      if (gaps[0] > 15 && gaps[0] > f32(state.gapHistory[0] + 15) && state.lastLeader === -1 &&
          rank[0].surface !== 'Normal') {
        phase = 0x26;
        state.lastLeader = leader;
      } else if (spread < 45 && state.sceneType !== 7) {
        phase = 0x2c;
        state.lastLeader = -1;
      } else if (f32(gaps[0] + gaps[1]) < 15) {
        phase = 0x2b;
        state.lastLeader = -1;
      } else {
        phase = gaps[0] >= 15 ? 0x2a : gaps[1] < 15 ? 0x29 :
          rank[0].slot === state.rankHistory[0] && rank[1].slot === state.rankHistory[1] ? 0x28 : 0x27;
        state.lastLeader = leader;
      }
      pause = 75;
      cueId = rng.unit16() > .5 ? 10 : undefined;
    } else if (!lastAlreadyNamed && gaps[3] > 15 && state.sceneType !== 7 && gaps[0] < 30) {
      phase = 0x22;
      cueId = state.cueId === 5 ? 8 : 5;
      state.lastPlaceMask |= lastBit;
      state.lastLeader = -1;
      state.focusSlot = last;
    } else if (gaps[0] <= 15) {
      const previousSpread = state.gapHistory.reduce((total, gap) => f32(total + gap), 0);
      if (gaps[1] <= 15 || rank[1].slot === state.rankHistory[0] || f32(state.gapHistory[0] - gaps[0]) <= 15) {
        phase = spread > 45 && spread > previousSpread ? 0x23 : 0x24;
      } else phase = 0x21;
      state.lastLeader = phase === 0x24 ? -1 : leader;
      state.focusSlot = -1;
    } else {
      phase = state.lastLeader === -1 ? 0x1d : state.lastLeader !== leader ? 0x20 : gaps[0] >= 30 ? 0x1f : 0x1e;
      state.lastLeader = leader;
      state.focusSlot = -1;
    }
  } else if (progress < f32(.6) && state.previousPhase <= 0x2d) {
    if (state.sceneWait === 0) {
      state.sceneWait = 15;
      return null;
    }
    if (--state.sceneWait > 0) return null;
    if (!rank.every(racer => Number.isFinite(racer.pace))) {
      return { complete: false, reason: 'Missing racer pace for standings commentary' };
    }
    const lastNamed = (state.lastPlaceMask | state.sleepMask) & lastBit;
    if (!lastNamed && gaps[3] > 15 && state.sceneType === 8 && state.focusSlot !== last) {
      phase = 0x36;
      placeSlot = -1;
      state.lastLeader = -1;
      state.focusSlot = last;
      state.lastPlaceMask |= lastBit;
    } else {
      const gaining = (rankIndex, priorIndex) =>
        rank[rankIndex].slot !== state.rankHistory[rankIndex] &&
        rank[rankIndex].slot !== state.rankHistory[priorIndex] && rank[rankIndex].pace > rank[priorIndex].pace;
      if (state.lastLeader !== -1 && state.lastLeader !== leader) {
        phase = 0x31;
      } else if (gaps[0] > 15 && state.sceneType !== 1) {
        phase = state.lastLeader === -1 ? 0x2e : gaps[0] >= 30 ? 0x30 : 0x2f;
      } else if (gaps[0] <= 15 && gaps[0] < state.gapHistory[0] && gaps[1] > 15 && gaining(1, 0)) {
        phase = 0x32;
      } else if (gaps[0] <= 45 && gaps[1] <= 15 && gaps[1] < state.gapHistory[1] && gaps[2] > 15 && gaining(2, 1)) {
        phase = 0x33;
      } else if (gaps[0] <= 45 && gaps[1] <= 45 && gaps[2] <= 15 && gaps[2] < state.gapHistory[2] &&
                 gaps[3] > 15 && gaining(3, 2)) {
        phase = 0x34;
      } else if (f32(gaps[0] + gaps[1]) < 15 && state.sceneType !== 8) {
        phase = 0x39;
      } else {
        const spread = gaps.reduce((total, gap) => f32(total + gap), 0);
        const previousSpread = state.gapHistory.reduce((total, gap) => f32(total + gap), 0);
        phase = spread <= previousSpread ? 0x38 : gaps[1] > 30 && state.sceneType === 6 ? 0x35 : 0x37;
      }
      state.lastLeader = phase === 0x39 ? -1 : leader;
      state.focusSlot = -1;
    }
    pause = 45;
  } else {
    const scene = selectLateStandings(state, progress, rank, gaps);
    return scene && { ...scene, gaps, rank: rank.map(racer => racer.slot) };
  }
  return { phase, pause, cueId, placeSlot, gaps, rank: rank.map(racer => racer.slot) };
}

function stepCommentaryState(state, rng, race, onReaction) {
  const { leaderDistance, trackLength, finishCount, raceState, fps, racers, nativeTick = true, minimumTicks = 30 } = race;
  // The compensated patch gates the director at PRX +0x12DA8. The
  // speech clock counts host ticks and the patch scales its acceptance gate.
  if (state.remaining > 0) state.remaining--;
  if (!nativeTick) return { complete: true };
  if (state.pause > 0 && --state.pause === 0 && state.phase !== ready) {
    state.previousPhase = state.phase;
    state.phase = ready;
  }
  for (const counters of [state.cheerCooldowns, state.mishapCooldowns]) {
    for (let slot = 0; slot < counters.length; slot++) if (counters[slot] > 0) counters[slot]--;
  }
  if (state.previousPhase === 0x73 || state.announcedFinishCount === 4) return { complete: true };
  const standings = racers && finishCommentaryStandings(racers, trackLength);
  const progress = standings?.progress ?? Math.min(1, Math.max(0, f32(leaderDistance / trackLength)));
  const cueContext = () => ({
    previousCueId: state.cueId, previousVariant: state.variant, elapsedTicks: state.duration - state.remaining,
    raceState, fps, minimumTicks,
  });
  let cue;
  let sound;
  let cameraAction;
  let voiceRoll;
  const requestCue = (cueId, durationUnits = 3, slot = 1, focusBySlot = false, keepFocusX = false) => {
    const context = cueContext();
    cue = cueId === null ? selectPlaceCue(rng, { ...context, slot }) :
      scheduleCue(rng, cueId, { ...context, durationUnits });
    if (cue.accepted) Object.assign(cue, { focusSlot: slot, focusBySlot, keepFocusX });
    return applyAcceptedCue(state, rng, cue, cueId === null ? onReaction : undefined);
  };
  const publish = scene => {
    state.previousScene = state.previousPhase;
    state.previousPhase = scene.phase;
    state.sceneType = scene.sceneType ?? raceSceneTypes[scene.phase - 0x14] ?? 0;
    if (standings) {
      state.gapHistory = standings.gaps;
      state.rankHistory = standings.rank;
    }
    state.pause = state.pauseLength = scene.pause;
    voiceRoll = rng.next15(); // +0x27914 -> EBOOT +0x2ADE08.
    if (scene.announcesFinisher && ++state.announcedFinishCount !== 4) state.previousPhase = 0x64;
  };
  const closeFrame = selected => {
    let scene = selected;
    if (scene?.cameraFollowup) {
      publish(scene);
      cameraAction = lateCameraFollowup(rng);
      scene = undefined;
    }
    if (!finishCount && progress < f32(.75) && ++state.quietTicks > 120) {
      if (!racers?.every(racer => Number.isFinite(racer.pace))) {
        return { complete: false, reason: 'Missing racer pace for progress commentary' };
      }
      if (state.phase === ready) state.phase = state.previousPhase;
      const pace = racers.reduce((total, racer) => f32(total + racer.pace), 0);
      const phase = progress >= f32(.3) ? 0x11 : f32(pace * f32(.2)) >= .5 ? 0x10 : 0xf;
      scene = { phase, pause: 60 };
    }
    if (scene && scene.phase !== ready) {
      if (scene.phase > opening) {
        state.eventCount = 0;
        if (state.cueId === 12 || state.cueId === 13) {
          const reason = requestCue(null);
          if (reason) return { complete: false, cue, reason };
        }
      }
      publish(scene);
      state.quietTicks = 0;
    }
    return { complete: true, cue, sound, cameraAction, voiceRoll };
  };

  const canInterrupt = finishCount <= state.announcedFinishCount + 1 &&
    (state.previousScene < 0x5e || state.previousScene > 0x63) &&
    progress > f32(.05) && (state.pause === 0 || state.pauseLength - state.pause > 45);
  if (canInterrupt) {
    if (!racers) return { complete: false, reason: 'Missing commentary racer events' };
    const event = raceInterruption(state, racers, progress, trackLength, rng);
    if (event) {
      if (state.phase === ready) state.phase = state.previousPhase;
      state.pause = state.pauseLength = event.pause;
      state.eventCount++;
      state.previousEventPhase = event.phase;
      const reason = event.cueId !== undefined &&
        requestCue(event.cueId, event.durationUnits, event.slot, true, event.keepFocusX);
      if (reason) return { complete: false, cue, reason };
      return closeFrame({ ...event, sceneType: 10 });
    }
  }
  const cues = finishCount ? null : directCueForProgress(progress, state.cueId, rng);
  if (cues) {
    const [cueId, durationUnits] = cues;
    const reason = requestCue(cueId, durationUnits, cueId === 14 ? 2 : 1);
    if (reason) return { complete: false, cue, reason };
  }
  if (state.phase === ready && state.pause === 0) {
    if (state.previousPhase !== ready) {
      if (!racers) return { complete: false, reason: 'Missing commentary racer positions' };
      const finish = finishCount ? selectFinishCommentary(state, { finishCount, ...standings }) : undefined;
      const scene = finish === undefined ? standingsCommentary(state, progress, racers, rng) : finish;
      if (scene === null) return closeFrame();
      if (scene.complete === false) return scene;
      const duration = scene.cueDurationUnits ?? scene.durationUnits ?? (scene.cueId === 10 ? 1 : 3);
      const reason = scene.cueId !== undefined ?
        requestCue(scene.cueId, duration, scene.cueId === 14 ? 2 : scene.placeSlot, scene.cueFocusBySlot) :
        scene.cueSlot !== undefined ? requestCue(null, duration, scene.cueSlot, scene.cueMode === 1) : undefined;
      if (reason) return { complete: false, cue, reason };
      if (scene.reactionSound) sound = playReaction(state, rng);
      return closeFrame(scene);
    }
    // PRX +0x29A0C opening call uses place slot 1 and reaction sound group 6.
    const reason = requestCue(null);
    if (reason) return { complete: false, reason };
    sound = playReaction(state, rng);
    return closeFrame({ phase: opening, pause: 75 });
  }
  return closeFrame();
}

module.exports = { applyAcceptedCue, createCommentaryState, stepCommentaryState };

},
(module, load) => {
'use strict';

const f32 = Math.fround;
const ready = 0x75;
const rankBonus = [0, 16, 8, 4, 2];
const finishSceneTypes = [1, 1, 1, 1, 1, 1, 0, 4, 8, 4, 8, 0, 4, 4, 4, 4, 4, 4, 4, 6, 6, 6];

// PRX +0x12EE8 sorts adjusted positions, then takes gaps between the raw
// positions in that order. At +0x28B84, finished racers remain eligible for
// progress until they run five units beyond the line.
function finishCommentaryStandings(racers, trackLength) {
  const key = racer => f32(racer.distance + (rankBonus[racer.place] ?? 0) * 100);
  const sorted = [...racers].sort((a, b) => key(b) - key(a) || a.slot - b.slot);
  const rank = sorted.map(racer => racer.slot);
  const gaps = sorted.slice(0, -1).map((racer, index) => f32(racer.distance - sorted[index + 1].distance));
  const activeLeader = sorted.find(racer => racer.distance < f32(trackLength + 5)) ?? sorted.at(-1);
  const progress = Math.min(1, Math.max(0, f32(activeLeader.distance / trackLength)));
  return { rank, gaps, progress };
}

function winnerScene(state, { finishCount, rank, gaps }) {
  const gap = gaps[0];
  const oldGap = state.gapHistory[0];
  const leader = rank[0];
  if (gap < 5 && oldGap < 5) {
    if (finishCount < 2) return null;
    return { phase: leader === state.lastLeader ? 0x71 : 0x72, announcesFinisher: true };
  }
  if (gap >= 30 || Math.abs(f32(gap - oldGap)) >= 15) {
    const phase = gap <= 45 ? 0x63 : leader === state.previousLeader ? 0x5e : 0x5f;
    return { phase, announcesFinisher: false };
  }
  const phase = leader !== state.previousLeader ? 0x62 : leader === state.rankHistory[0] ? 0x60 : 0x61;
  return { phase, announcesFinisher: false };
}

function nextFinisherPhase(state, { rank, gaps }, announced) {
  if (announced === 3) return 0x73;
  if (rank[announced + 1] !== state.rankHistory[announced + 1]) return 0x70;
  if (gaps[announced + 1] < 15) return 0x6f;
  const gap = gaps[announced];
  const unchanged = rank[announced] === state.rankHistory[announced];
  if (gap >= 30 || Math.abs(f32(gap - state.gapHistory[announced])) >= 15) {
    return gap <= 45 ? 0x6e : unchanged ? 0x6a : 0x6b;
  }
  return unchanged ? 0x6c : 0x6d;
}

// PRX +0x28B84 saved director branches from the first finish through its
// final announcement. Call after solving any pending interruption and the
// elapsed pause. undefined means control belongs to an earlier scene family;
// null means the native finish branch deliberately emits no new scene.
function selectFinishCommentary(state, race) {
  const { previousPhase, cueId, announcedFinishCount: announced = 0 } = state;
  const { finishCount, rank, gaps } = race;
  const progress = f32(race.progress);
  if (previousPhase === 0x73 || announced === 4 || state.pause > 0 || state.phase !== ready) return null;
  if (!finishCount || previousPhase <= 0x3a) return undefined;

  const endCue = cueId !== 0x10 ? { cueId: 0x10, cueDurationUnits: 6, cueArgument: 1 } : {};
  if (previousPhase < 0x5e) {
    const scene = winnerScene(state, race);
    return scene && { ...scene, ...endCue, pause: 60, reactionSound: true, sceneType: finishSceneTypes[scene.phase - 0x5e] };
  }
  if (finishCount === announced + 1) {
    if (previousPhase >= 0x65 || progress > f32(.98)) return null;
    const gap = gaps[finishCount];
    const ahead = progress <= f32(.95);
    const phase = ahead ? (gap <= 45 ? 0x68 : 0x67) : (gap <= 30 ? 0x66 : 0x65);
    const placeCue = progress < f32(.95) && cueId === 0x10 ?
      { cueSlot: rank[announced + 1], cueDurationUnits: 3, cueMode: 1 } : {};
    return { phase, pause: 45, announcesFinisher: false, sceneType: finishSceneTypes[phase - 0x5e], ...placeCue };
  }
  if (previousPhase >= 0x6a) return null;
  const phase = nextFinisherPhase(state, race, announced);
  return { phase, pause: 60, announcesFinisher: true, sceneType: finishSceneTypes[phase - 0x5e],
    reactionSound: phase === 0x6f || phase === 0x70,
    ...(progress > f32(.98) ? endCue : {}) };
}

module.exports = { finishCommentaryStandings, selectFinishCommentary };

},
(module, load) => {
'use strict';

const f32 = Math.fround;
const sceneTypes = [
  1, 3, 4, 4, 5, 6, 8, 9, 0, 1, 1, 2, 1, 1, 1, 5, 3, 6, 8, 0,
  1, 1, 1, 1, 1, 1, 1, 1, 4, 4, 4, 4, 8, 8,
];

function chooseApproachScene(state, rank, gaps) {
  const [leader, second] = rank;
  const [firstGap, secondGap, thirdGap, fourthGap] = gaps;
  const previousGap = state.gapHistory[0];
  const withLeader = phase => ({ phase, lastLeader: leader.slot });
  if (leader.slot !== state.rankHistory[0] && firstGap > 15) return withLeader(0x3c);

  if (firstGap < 30 && firstGap < previousGap && f32(firstGap + secondGap) > 15 && second.pace > leader.pace) {
    if (state.sceneType === 4) return { phase: 0x41, lastLeader: -1 };
    if (state.sceneType === 1 || Math.abs(f32(firstGap - previousGap)) >= 15) {
      return withLeader(state.rankHistory.slice(0, 2).includes(second.slot) ? 0x3d : 0x3e);
    }
    if (firstGap <= 15) return withLeader(0x40);
    return withLeader(state.sceneType === 3 ? 0x3b : 0x3c);
  }

  if (state.sceneType === 3) {
    if (firstGap >= 15) return withLeader(0x3f);
  } else {
    if (firstGap > 30 && state.lastLeader === leader.slot) return withLeader(0x3b);
    const topThreeGap = f32(firstGap + secondGap);
    const topFourGap = f32(topThreeGap + thirdGap);
    if ((firstGap > 30 || secondGap <= 15) &&
        (topThreeGap > 30 || thirdGap <= 15) &&
        (topFourGap > 30 || fourthGap <= 15)) {
      return f32(topFourGap + fourthGap) >= 45 ? { phase: 0x42, lastLeader: -1 } : withLeader(0x41);
    }
  }
  return withLeader(f32(second.pace * 1.5) < leader.pace ? 0x3b : 0x40);
}

function chooseLeadScene(state, rank, gaps) {
  const [leader, second] = rank;
  const [firstGap, secondGap] = gaps;
  const previousGap = state.gapHistory[0];
  if ((state.lastLeader !== -1 && leader.slot !== state.lastLeader && state.sceneType === 1) ||
      (firstGap > 15 && state.sceneType === 5 && leader.slot !== state.rankHistory[1])) return 0x4b;
  if (firstGap <= 15 && secondGap > firstGap) return 0x4c;
  if (f32(firstGap + secondGap) < 30) return 0x4d;
  if (firstGap > 15 && previousGap < 15) return leader.pace <= second.pace ? 0x45 : 0x44;
  if (firstGap <= 30) return 0x46;
  if (state.sceneType === 5) return 0x4a;
  if (state.sceneType === 4) return 0x49;
  if (leader.slot !== state.lastLeader || previousGap <= 30) return 0x47;
  return f32(second.pace * .5) <= leader.pace || firstGap >= 60 ? 0x48 : 0x46;
}

function chooseNearFinishScene(state, progress, rank, gaps) {
  const [leader, second] = rank;
  const [firstGap, secondGap] = gaps;
  const steadyLead = second.pace <= leader.pace;
  if (!steadyLead && state.sceneType !== 3 && state.sceneType !== 4 && state.rankHistory[0] !== second.slot) {
    return { phase: 0x57, pause: 30 };
  }
  if (progress > f32(.92)) {
    let phase = 0x53;
    if (firstGap <= 7.5) {
      if (state.sceneType === 4 && secondGap <= 7.5) phase = 0x5c;
      else phase = state.sceneType === 1 ? 0x59 : 0x51;
    }
    return { phase, pause: 15 };
  }

  let phase = 0x4f;
  if (firstGap <= 7.5) {
    if (state.sceneType === 4 && secondGap <= 7.5) phase = 0x5b;
    if (state.sceneType === 1) phase = state.lastLeader === leader.slot ? 0x58 : 0x52;
  } else if (state.previousPhase !== 0x50) {
    phase = 0x50;
  } else if (firstGap > 30 && !steadyLead) {
    phase = 0x56;
  }
  return { phase, pause: leader.pace > .75 && second.pace > .75 ? 15 : 30 };
}

// PRX +0x28B84 pre-finish dispatch. The caller applies cue, voice and
// follow-up RNG in order. Current rank/pace are derived from the same update.
function selectLateStandings(state, progress, rank, gaps) {
  const leader = rank[0].slot;
  if (state.previousPhase <= 0x3a) {
    if (!rank.slice(0, 2).every(racer => Number.isFinite(racer.pace))) {
      return { complete: false, reason: 'Missing racer pace for late standings commentary' };
    }
    const { phase, lastLeader } = chooseApproachScene(state, rank, gaps);
    state.lastLeader = lastLeader;
    return { phase, pause: 45, soundGroup: 3, cameraActions: [0, 1, 2], sceneType: sceneTypes[phase - 0x3b] };
  }
  if (state.previousPhase < 0x44) {
    state.previousLeader = state.lastLeader;
    if (progress < f32(.7)) return null;
    if (!rank.slice(0, 2).every(racer => Number.isFinite(racer.pace))) {
      return { complete: false, reason: 'Missing racer pace for late standings commentary' };
    }
    const phase = chooseLeadScene(state, rank, gaps);
    state.lastLeader = phase === 0x4d ? -1 : leader;
    return { phase, pause: 45, cueId: 14, durationUnits: 3, soundGroup: 4, sceneType: sceneTypes[phase - 0x3b] };
  }

  if (progress < f32(.85)) state.previousLeader = state.lastLeader;
  if (progress > f32(.98)) return null;
  if (state.sceneWait === 0) {
    state.sceneWait = 5;
    return null;
  }
  if (--state.sceneWait > 0) return null;
  if (!rank.slice(0, 2).every(racer => Number.isFinite(racer.pace))) {
    return { complete: false, reason: 'Missing racer pace for late standings commentary' };
  }
  const { phase, pause } = chooseNearFinishScene(state, progress, rank, gaps);
  if (progress < f32(.95)) state.lastLeader = leader;
  return { phase, pause, sceneType: sceneTypes[phase - 0x3b], cameraFollowup: true };
}

// The roll at +0x2A718 occurs after voice selection. A roll in the first
// tenth adds the +0x2A784 draw and chooses a camera action (1 or 2).
function lateCameraFollowup(rng) {
  return rng.unit16() < f32(.1) ? (rng.next15() & 1) + 1 : null;
}

module.exports = { lateCameraFollowup, selectLateStandings };

},
(module, load) => {
'use strict';

const { isCrowdClip, selectCrowdClip, startCrowdAnimation } = load(6);
const { advanceAnimationClock } = load(12);

const crowdSlots = 20;
const finishClip = 0x12f7;
const f32 = Math.fround;

// CAPR IDs and GMT frame counts from bin/motion/m09kamerace.par. The
// selectable clip records in bin/motion/property.bin use default type 1
// with no queued animation properties. F_stand_kamae01 has an explicit
// transition property and is only supported as an existing clock.
const loopingClips = [
  [868, 205], [870, 188], [893, 145], [894, 160], [895, 145],
  [981, 60], [982, 35], [983, 50], [989, 270], [1015, 120], [1016, 125], [1017, 140],
  [1228, 57], [1229, 57], [1230, 43], [1231, 43], [1232, 166], [1233, 45],
  [2343, 83], [2344, 124], [2351, 50], [2353, 68], [2354, 60], [2355, 60],
  [4855, 120], [4867, 120],
];
const oneShotClips = [
  [1103, 110], [1104, 140], [2069, 70], [2070, 115], [2082, 100], [2083, 105],
  [2090, 95], [2129, 90], [2130, 114], [2135, 120], [2136, 96], [2144, 96],
];
const nativeClips = [
  ...loopingClips.map(([nativeId, frames]) => ({ nativeId, frames, fps: 30, loop: true })),
  ...oneShotClips.map(([nativeId, frames]) => ({ nativeId, frames, fps: 30, loop: false })),
];
const nativeClipsById = new Map(nativeClips.map(clip => [clip.nativeId, clip]));

function supportsClipTransition(clip) {
  const native = nativeClipsById.get(clip?.nativeId);
  return native && native.nativeId !== 0x37d &&
    clip.frames === native.frames && clip.fps === native.fps && clip.loop === native.loop;
}

function createCrowdState(samples) {
  const actors = Array(crowdSlots).fill(null);
  for (const sample of samples) {
    const { slot, currentClip, nextClip, pending, animationStartWord, selector, speed } = sample;
    if (!Number.isInteger(slot) || slot < 0 || slot >= crowdSlots || actors[slot]) {
      throw new RangeError('Each crowd actor must occupy a unique slot from 0 to 19');
    }
    if (![currentClip, nextClip, pending, animationStartWord, selector].every(Number.isInteger) ||
        pending < 0 || !Number.isFinite(speed)) {
      throw new TypeError('Crowd actor needs its native clip, update and speed state');
    }
    const { override, featured, favoursLeader, pastHalf } = sample;
    if (![override, featured, favoursLeader, pastHalf].every(value => typeof value === 'boolean' || Number.isInteger(value))) {
      throw new TypeError('Crowd actor needs its native flags');
    }
    actors[slot] = {
      ...sample,
      override: Boolean(override),
      featured: Boolean(featured),
      favoursLeader: Boolean(favoursLeader),
      pastHalf: Boolean(pastHalf),
      selector: Boolean(selector),
    };
  }
  return actors;
}

// +0x5394 and +0x5524 respond to commentary by choosing a new clip for
// every participating actor. The next crowd update applies the queued clip.
function queueCrowdReaction(actors, rng, stage, raceState) {
  if (stage !== 'race' && stage !== 'finish') throw new RangeError('Unknown crowd reaction');
  const events = [];
  let previousClip = 0;
  for (const actor of actors) {
    if (!actor || actor.override) continue;
    if (actor.featured && raceState === 18) {
      actor.nextClip = finishClip;
    } else {
      const select = () => selectCrowdClip(rng, { ...actor, stage, refresh: false }).clip;
      actor.nextClip = select();
      actor.selector = true;
      if (actor.nextClip === previousClip) actor.nextClip = select();
    }
    actor.animationStartWord = 1;
    previousClip = actor.nextClip;
    events.push({ slot: actor.slot, clip: previousClip });
  }
  return events;
}

function updateCrowdFlags(actors, { state, leaderSlot, leaderDistance, trackLength }) {
  const crossedHalf = f32(leaderDistance) > f32(trackLength * .5);
  for (const actor of actors) {
    if (!actor || actor.override) continue;
    actor.pastHalf ||= crossedHalf;
    if (actor.featured) actor.favoursLeader = state !== 18 && leaderSlot !== 0;
  }
}

// +0x02D90 samples animation flags before +0x2C290 advances the model.
// The animation provider supplies that native model state, applies a requested
// clip and advances it. This loop owns the crowd task's decisions and RNG.
function stepCrowdState(actors, rng, race, animation) {
  const { state, leaderSlot, leaderDistance, trackLength } = race;
  if (![animation?.ending, animation?.start, animation?.advance].every(callback => typeof callback === 'function')) {
    throw new TypeError('Crowd scheduling requires the native animation state provider');
  }
  if (!Number.isInteger(state) || !Number.isInteger(leaderSlot) || leaderSlot < 0 || leaderSlot > 4 ||
      !Number.isFinite(leaderDistance) || !Number.isFinite(trackLength) || trackLength <= 0) {
    throw new TypeError('Crowd scheduling requires the state and leader of a player race');
  }
  const distance = f32(leaderDistance);
  const stage = distance > f32(trackLength - 75) ? 'finish' : distance <= 0 ? 'start' : 'race';
  updateCrowdFlags(actors, race);
  const events = [];
  const before = rng.draws;
  for (const actor of actors) {
    if (!actor) continue;
    if (!actor.override) {
      const ending = actor.featured && state === 18;
      if (animation.ending(actor) && actor.pending === 0) {
        let clip = actor.currentClip;
        if (ending) {
          clip = finishClip;
        } else if (isCrowdClip(clip)) {
          clip = selectCrowdClip(rng, { ...actor, stage, refresh: true }).clip;
          events.push({ type: 'select', slot: actor.slot, clip });
        }
        if (clip !== 0) {
          actor.nextClip = clip;
          actor.pending = 1;
          actor.animationStartWord = 0;
        }
      }
    }

    if (actor.pending > 0) actor.pending -= 1;
    if (actor.animationStartWord !== 0 || actor.currentClip !== actor.nextClip) {
      actor.currentClip = actor.nextClip;
      const startup = startCrowdAnimation(rng, { pending: actor.animationStartWord !== 0, featured: actor.featured });
      if (startup.started) {
        actor.animationStartWord = 0;
        actor.speed = f32(f32(startup.speedRoll * f32(1 / 65535) - .5) * .5 + 1);
      }
      const applyModelClip = !isCrowdClip(actor.currentClip) || actor.selector;
      if (applyModelClip) actor.selector = false;
      const model = animation.start(actor, { clip: actor.currentClip, applyModelClip, ...startup });
      events.push({ type: 'start', slot: actor.slot, clip: actor.currentClip, ...startup });
      if (model?.complete === false) {
        return { complete: false, missing: model.missing, events, draws: rng.draws - before, seed: rng.seed };
      }
    }
    animation.advance(actor);
  }
  return { complete: true, events, draws: rng.draws - before, seed: rng.seed };
}

function createCrowdAnimation(samples, timing, clips = nativeClips) {
  const byId = clips === nativeClips ? nativeClipsById : new Map(clips.map(clip => [clip.nativeId, clip]));
  const clocks = new Map();
  const missing = [];
  for (const sample of samples) {
    if (sample.override) continue;
    const animation = sample.animationSample;
    const controller = animation?.controller;
    const clip = byId.get(animation?.modelClip);
    const prefix = 'crowd[' + sample.slot + '].';
    if (!controller || animation.phaseGetter !== 0xa89b0c || controller.clipIndex < 0 ||
        animation.animationLength !== clip?.frames || animation.animationFrame !== controller.frame ||
        sample.modelFlags !== controller.flags) {
      missing.push(prefix + 'model');
      continue;
    }
    if (controller.requestedClip !== 0) missing.push(prefix + 'requestedClip');
    const current = {
      frame: controller.frame,
      flags: controller.flags,
      multiplier: controller.multiplier,
      queuedMotions: controller.queuedMotions,
      blendActive: controller.blendFallback !== 0,
      secondaryActive: controller.secondaryClip >= 0 || controller.secondaryStart !== 0 || controller.secondaryEnd !== 0,
    };
    const check = advanceAnimationClock({ ...current, speed: sample.speed }, clip, timing);
    if (!check.complete) missing.push(...check.missing.map(field => prefix + field));
    clocks.set(sample.slot, { clip, current });
  }
  if (missing.length) return { complete: false, missing };

  return {
    complete: true,
    animation: {
      ending(actor) {
        return Boolean(clocks.get(actor.slot).current.flags & 0xc000);
      },
      start(actor, { clip: clipId, started, phaseRoll }) {
        const clock = clocks.get(actor.slot);
        const clip = byId.get(clipId);
        if (!supportsClipTransition(clip) || !supportsClipTransition(clock?.clip)) {
          return { complete: false, missing: ['crowd[' + actor.slot + '].clipTransition'] };
        }
        // +0x2C0DC uses the length of the still-playing model clip. The
        // type-1 application in +0x4947B0 resets the primary controller
        // flags and sets that offset before the new clip advances.
        clock.current.frame = started ? phaseRoll % (3 * Math.trunc(clock.clip.frames / 4)) : 0;
        clock.current.flags = 0;
        clock.clip = clip;
      },
      advance(actor) {
        const clock = clocks.get(actor.slot);
        if (!clock) return;
        const next = advanceAnimationClock({ ...clock.current, speed: actor.speed }, clock.clip, timing);
        clock.current.frame = next.frame;
        clock.current.flags = next.flags;
      },
    },
  };
}

module.exports = { createCrowdState, queueCrowdReaction, updateCrowdFlags, stepCrowdState, createCrowdAnimation };

},
(module, load) => {
'use strict';

const f32 = Math.fround;

function loopCorrection(frame, length) {
  if (frame < 0) return length;
  if (f32(frame - length) >= 0) return -length;
  return 0;
}

// EBOOT +0x5923F0 advances a GMT clip controller, and +0x4955D4 copies
// its flags to the model. Queued motions and blend channels use separate
// controller records and need their own state before predicting model flags.
function advanceAnimationClock(state, clip, timing) {
  const { frame, flags, speed, multiplier, queuedMotions, blendActive, secondaryActive } = state ?? {};
  const { frames, fps, loop } = clip ?? {};
  const { taskSpeed, stepSeconds } = timing ?? {};
  const missing = [];
  if (queuedMotions !== 0) missing.push('queuedMotions');
  if (blendActive !== false) missing.push('blendActive');
  if (secondaryActive !== false) missing.push('secondaryActive');
  if (![frame, speed, multiplier].every(Number.isFinite) || !Number.isInteger(flags) || flags < 0 || flags > 0xffff) {
    missing.push('controller');
  }
  if (!Number.isInteger(frames) || frames <= 0 || !Number.isFinite(fps) || fps <= 0 || typeof loop !== 'boolean') {
    missing.push('clip');
  }
  if (!Number.isFinite(taskSpeed) || !Number.isFinite(stepSeconds) || stepSeconds < 0) missing.push('timing');
  if (missing.length) return { complete: false, missing };

  const length = f32(frames);
  const seconds = f32(f32(f32(speed) * f32(taskSpeed)) * f32(stepSeconds));
  const step = f32(f32(f32(fps) * seconds) * f32(multiplier));
  const candidate = f32(f32(frame) + step);
  let nextFlags = flags & 0x0fff;
  let nextFrame;
  if (loop) {
    const correction = loopCorrection(candidate, length);
    nextFrame = f32(candidate + correction);
    if (correction) nextFlags |= 0x4000;
    else if (loopCorrection(f32(nextFrame + step), length)) nextFlags |= 0x1000;
  } else {
    nextFrame = candidate < 0 ? 0 : Math.min(length, candidate);
    if (nextFrame === length) nextFlags |= 0x8000;
    if (f32(nextFrame + step) >= length) nextFlags |= 0x2000;
  }
  return { complete: true, frame: nextFrame, flags: nextFlags };
}

module.exports = { advanceAnimationClock };

},
(module, load) => {
'use strict';

// EBOOT +0xA5AB8 updates the timers at each model owner's +0x1A4 and +0x1CC.
// The caller supplies the actual callback sequence and delta. Each timer then
// evolves locally, consuming RNG only when native +0xCA93C crosses its end.
const f32 = Math.fround;
const unit16 = f32(1 / 65535); // Native constant 0x37800080.

function fusedSingle(left, right, addend) {
  // Binary64 holds a product of two binary32 values exactly. Correct the
  // final conversion if the binary64 sum landed exactly on a binary32 tie.
  const product = left * right;
  const sum = product + addend;
  const rounded = f32(sum);
  if (sum === rounded) return rounded;
  const carry = sum - product;
  const error = (product - (sum - carry)) + (addend - carry);
  if (!error || (error > 0) === (rounded > sum)) return rounded;
  const opposite = f32(2 * sum - rounded);
  return Math.abs(rounded - sum) === Math.abs(opposite - sum) ? opposite : rounded;
}

function readModelNoiseTimer(bytes, offset = 0) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return {
    enabled: view.getUint32(offset + 0x00) !== 0,
    base: view.getUint32(offset + 0x04),
    startSpan: view.getUint32(offset + 0x08),
    minLength: view.getUint32(offset + 0x0C),
    lengthSpan: view.getUint32(offset + 0x10),
    elapsed: view.getFloat32(offset + 0x14),
    start: view.getFloat32(offset + 0x18),
    end: view.getFloat32(offset + 0x1C),
    amplitude: view.getFloat32(offset + 0x20),
    minAmplitude: view.getFloat32(offset + 0x24),
  };
}

function timerParameters({ base, startSpan, minLength, lengthSpan, minAmplitude }) {
  if ([base, startSpan, minLength, lengthSpan].some(value =>
    !Number.isInteger(value) || value < 0 || value > 0xffffffff) || !Number.isFinite(f32(minAmplitude))) {
    throw new TypeError('Model-animation timers need four unsigned parameters and a finite minimum amplitude');
  }
  return { base, startSpan, minLength, lengthSpan, minAmplitude: f32(minAmplitude) };
}

function createModelNoise(timers = []) {
  const state = new Map();
  for (const { id, ...timer } of timers) {
    if (id === undefined || state.has(id)) throw new RangeError('Model-animation timers require unique IDs');
    if (typeof timer.enabled !== 'boolean' || !Number.isFinite(f32(timer.elapsed)) || !Number.isFinite(f32(timer.end))) {
      throw new TypeError(`Model-animation timer ${id} needs enabled, elapsed, and end fields`);
    }
    state.set(id, { ...timer, ...timerParameters(timer), elapsed: f32(timer.elapsed), end: f32(timer.end) });
  }
  return state;
}

function modelNoiseDelta(clockFactor, modelFactor, frameStep) {
  // +0x2BFC4C with r4=0, followed by +0xA5AF4 and +0xA5B20.
  return f32(f32(f32(f32(clockFactor) * f32(modelFactor)) * 30) / f32(frameStep));
}

function rollSpan(low16, span, addend, arithmetic) {
  // The observed RPCS3 LLVM build rounds the normalized draw before applying
  // the span. The PPU instruction order rounds the scaled span first.
  if (arithmetic === 'rpcs3-llvm') return fusedSingle(f32(low16 * unit16), f32(span), addend);
  return fusedSingle(f32(f32(span) * unit16), low16, addend);
}

function rerollTimer(rng, timer, arithmetic) {
  // +0xCA6DC keeps the first two draws in registers and publishes the third
  // at +0xCA854, so the ring observes all three advances as one write.
  const startRoll = rng.next16();
  const lengthRoll = rng.next16();
  const amplitudeRoll = rng.next16();
  const { base, startSpan, minLength, lengthSpan, minAmplitude } = timer;
  timer.start = rollSpan(startRoll, startSpan, f32(base), arithmetic);
  const end = rollSpan(lengthRoll, lengthSpan, f32(timer.start + f32(minLength)), arithmetic);
  timer.end = end > timer.start ? end : f32(timer.start + 1);
  timer.amplitude = fusedSingle(f32(1 - f32(minAmplitude)), f32(amplitudeRoll * unit16), f32(minAmplitude));
}

function applyModelNoise(rng, timers, callbacks = [], arithmetic = 'ppu') {
  if (arithmetic !== 'ppu' && arithmetic !== 'rpcs3-llvm') {
    throw new RangeError('Unknown model-animation arithmetic mode');
  }
  const startDraws = rng.draws;
  const rerolled = [];
  for (const callback of callbacks) {
    const { timer: id, kind = 'update' } = callback;
    const timer = timers.get(id);
    if (!timer) throw new RangeError(`Unknown model-animation timer ${id}`);
    if (kind === 'enabled') {
      if (typeof callback.enabled !== 'boolean') throw new TypeError('Model-animation enable state must be boolean');
      timer.enabled = callback.enabled;
      continue;
    }
    if (kind === 'update') {
      if (!Number.isFinite(callback.delta)) throw new TypeError('Model-animation updates need the native time delta');
      timer.elapsed = timer.enabled ? f32(timer.elapsed + f32(callback.delta)) : 0;
      if (!timer.enabled || timer.elapsed <= timer.end) continue;
    } else if (kind === 'configure') {
      Object.assign(timer, timerParameters(callback));
    } else if (kind !== 'reset') {
      throw new RangeError(`Unknown model-animation callback ${kind}`);
    }
    if (kind !== 'configure') timer.elapsed = 0; // +0xCA910 before reconfiguration.
    rerollTimer(rng, timer, arithmetic);
    rerolled.push(id);
  }
  return { draws: rng.draws - startDraws, rerolled, seed: rng.seed };
}

module.exports = { applyModelNoise, createModelNoise, modelNoiseDelta, readModelNoiseTimer };

},
(module, load) => {
'use strict';

const { modelNoiseDelta } = load(13);

const f32 = Math.fround;

// 9E548–9E60C groups the matrix terms as (x+y)+(z+translation).
function transformPoint([x, y, z], [columnX, columnY, columnZ, translation]) {
  return columnX.slice(0, 3).map((value, lane) => f32(
    f32(f32(value * x) + f32(columnY[lane] * y)) + f32(f32(columnZ[lane] * z) + translation[lane]),
  ));
}

function modelCameraSphere({ localCenter, radius, ownerTransform, viewTransform, alternateCamera }) {
  const world = transformPoint(localCenter, ownerTransform);
  const primary = { center: transformPoint(world, viewTransform), radius };
  if (!alternateCamera) return { primary, alternate: null };
  // 9E828–9E8C4 offsets the world sphere horizontally before applying the view.
  const scale = f32(f32(alternateCamera.scale + alternateCamera.scale) * radius);
  const [x, , z] = alternateCamera.direction;
  const shifted = [f32(world[0] + f32(x * scale)), world[1], f32(world[2] + f32(z * scale))];
  return { primary, alternate: { center: transformPoint(shifted, viewTransform), radius } };
}

function cameraBand({ depth, thresholds, margin, fade, fadeStep, keepBandZero, lodEnabled }) {
  // 9E36C clears the prior band before 9AC68. Distance and fade arithmetic
  // below follow the common actor path used by the race audience.
  const insideNearBand = f32(thresholds[0] - margin) <= depth && depth <= margin;
  const matchingIndex = insideNearBand ? 0 : thresholds.findIndex(threshold => threshold < depth);
  let band = matchingIndex === -1 ? thresholds.length - 1 : matchingIndex;
  if (!keepBandZero && band === 0) band = 1;
  if (!lodEnabled && band >= 2) band = 1;
  if (band === 0 || band === 5) {
    fade = Math.max(0, f32(fade - fadeStep));
    if (fade > 0) band = band === 0 ? 1 : 4;
  } else {
    fade = Math.min(1, f32(fade + fadeStep));
  }
  return { band, fade };
}

function sphereInFrustum({ center: [x, y, z], radius }, frustum) {
  // 57DEC. VMX CR6's LT condition means all four comparison lanes are true.
  const low = f32(z - radius);
  const high = f32(z + radius);
  if (frustum.near.every(limit => low > limit) || frustum.far.every(limit => limit > high)) return false;
  const [planeX, planeY, planeZ] = frustum.side;
  return planeX.every((normal, lane) => radius >= f32(planeZ[lane] * z + f32(planeY[lane] * y + f32(normal * x))));
}

function spherePassesOcclusion({ center: [x, y, z], radius }, occlusion) {
  if (!occlusion.enabled) return true;
  // 5CEF0: fixed-point depth, then the set of camera-space quadrants touched
  // by the sphere. The packet list is in native traversal order.
  const depth = Math.max(-0x80000000, Math.min(0x7fffffff, Math.trunc(f32(z - radius) * 1024)));
  const left = f32(x - radius) < 0;
  const below = f32(y - radius) < 0;
  const right = f32(x + radius) > 0;
  const above = f32(y + radius) > 0;
  const mask = (left && below ? 1 : 0) | (right && below ? 2 : 0) |
    (left && above ? 4 : 0) | (right && above ? 8 : 0);

  for (const { depthLimit, quadrants, front: [a,b,c,d], sides } of occlusion.packets) {
    if (depthLimit < depth) break;
    if ((quadrants & mask) !== mask) continue;
    const frontDistance = f32(f32(f32(x * a) + f32(y * b)) + f32(f32(z * c) + d));
    if (!(frontDistance < -radius)) continue;
    const [planeX, planeY, planeZ, planeOffset] = sides;
    if (planeX.every((normal, lane) => f32(normal * x + f32(planeY[lane] * y +
      f32(planeZ[lane] * z + planeOffset[lane]))) > radius)) return false;
  }
  return true;
}

function visibilityBits(actor, frustum, occlusion) {
  const primaryBand = actor.band >= 1 && actor.band <= 4;
  if (!actor.cameraAvailable) return primaryBand ? 3 : 0;
  let visible = 0;
  if (primaryBand) {
    if (!actor.primary || !frustum || !occlusion) return undefined;
    if (sphereInFrustum(actor.primary, frustum)) {
      visible = spherePassesOcclusion(actor.primary, occlusion) ? 3 : 1;
    }
  }
  if (visible === 3 || actor.band > 3) return visible;
  if (actor.alternate === undefined) return undefined;
  // null means the actor+19A/+190 and alternate-camera gates excluded this test.
  if (actor.alternate && (!frustum || !occlusion)) return undefined;
  if (actor.alternate && sphereInFrustum(actor.alternate, frustum)) {
    visible |= spherePassesOcclusion(actor.alternate, occlusion) ? 6 : 4;
  }
  return visible;
}

function planModelNoiseFrame({ actors, frustum, occlusion, clock }) {
  // EBOOT 9DF34 checks each render candidate, issuing slot +E4 for either
  // visibility group or a forced pose request. The common slot
  // (+9D1DC) supplies actor+D8 to +A5AB8, witnessed in the Crystal Cup.
  if (!Array.isArray(actors)) return { complete: false, missing: ['ordered actor candidates'] };
  const callbacks = [];
  const missing = [];
  for (const [index, actor] of actors.entries()) {
    if (actor.modelOwner === 0) continue;
    if (!Number.isInteger(actor.modelOwner) || actor.modelOwner < 0 || actor.modelOwner > 0xffffffff - 0x1CC ||
      typeof actor.forcePose !== 'boolean') {
      missing.push(`actor ${index} model owner or forced pose flag`);
      continue;
    }
    if (!actor.forcePose) {
      if (actor.classificationEnabled === false) continue;
      const visible = actor.classificationEnabled === true && Number.isInteger(actor.band) && actor.band >= 0 && actor.band <= 5 &&
        typeof actor.cameraAvailable === 'boolean' ? visibilityBits(actor, frustum, occlusion) : undefined;
      if (visible === undefined) {
        missing.push(`actor ${index} visibility inputs`);
        continue;
      }
      if ((visible & 3) !== 3 && (visible & 6) !== 6) continue;
    }
    const delta = clock ? modelNoiseDelta(clock.clockFactor, clock.modelFactor, clock.frameStep) : NaN;
    if (!Number.isFinite(delta)) {
      missing.push('animation clock');
      continue;
    }
    callbacks.push({ timer: actor.modelOwner + 0x1A4, delta }, { timer: actor.modelOwner + 0x1CC, delta });
  }
  if (missing.length) return { complete: false, missing: [...new Set(missing)] };
  return { complete: true, callbacks };
}

module.exports = { cameraBand, modelCameraSphere, planModelNoiseFrame, sphereInFrustum, spherePassesOcclusion };

},
(module, load) => {
'use strict';

const f32 = Math.fround;

// CAPR clip IDs and frame lengths from the turtle GMT animations in
// bin/motion/m09kamerace.par. The clips all run at 30 source frames per second.
const clips = new Map([
  [0x31, { frames: 80, loop: false }],  // Eat end
  [0x32, { frames: 100, loop: true }],
  [0x33, { frames: 100, loop: false }],
  [0x34, { frames: 90, loop: true }],   // Idle
  [0x35, { frames: 50, loop: false }],
  [0x36, { frames: 80, loop: true }],
  [0x37, { frames: 50, loop: false }],
  [0x38, { frames: 50, loop: false }],
  [0x39, { frames: 80, loop: true }],
  [0x3a, { frames: 50, loop: false }],
  [0x3b, { frames: 70, loop: false }],  // Sleep end
  [0x3c, { frames: 10, loop: true }],
  [0x3d, { frames: 80, loop: false }],
  [0x3e, { frames: 20, loop: true }],   // Run
  [0x3f, { frames: 40, loop: true }],   // Walk
]);

// EBOOT 0x2AA9C4 uses the entry stats. PRX +0xA74C retains this scale
// for playback and presentation independently of subsequent stamina loss.
function racerScale(initialStamina, legPower) {
  return f32(.75 + .25 * Math.min(1, f32((initialStamina + legPower) / 500)));
}

// PRX +0x90BC uses 0.25 smoothing. The frame-rate patch adjusts the fraction
// over each update. +0x8ED4 also slows the visual model beyond the finish.
function projectStep(oldSmoothed, rawPosition, hasFinished, finishDistance, fps) {
  const correction = f32(rawPosition - oldSmoothed);
  const slowdown = hasFinished ? Math.max(0, f32(1 + f32(f32(rawPosition - finishDistance) / -35))) : 1;
  const base = f32(slowdown * .25);
  const alpha = f32(1 - Math.pow(1 - base, 30 / fps));
  const smoothedDistance = f32(correction * alpha + oldSmoothed);
  return { smoothedDistance, forwardDelta: f32(smoothedDistance - oldSmoothed) };
}

function projectLateralOffset(previous, clumsyAnimation, laneFlag, scale, fps) {
  // Kamerace +8F14/+9298 updates the rendered X offset independently of the yaw.
  const direction = laneFlag & 0x20 ? -1 : 1;
  const target = clumsyAnimation ? f32(f32(1 - scale) * 10 + 1) * direction : 0;
  const base = f32(clumsyAnimation ? .005 : .01);
  const gain = f32(1 - Math.pow(1 - base, 30 / fps));
  return f32(f32(target - previous) * gain + previous);
}

function playbackSpeed(delta, scale, reference) {
  const nativeReference = f32(reference);
  const adjustment = f32(f32(1 - scale) + 1);
  return f32(adjustment + f32(f32(delta - nativeReference) / nativeReference));
}

function initializeRacerMotion({ clip, phase, pendingClip = clip, queuedClip = 0, ended, dwell = 0,
  speed = 1, footfallLatch, scale }) {
  if (!clips.has(clip) || !clips.has(pendingClip) || (queuedClip !== 0 && !clips.has(queuedClip)) ||
      !Number.isFinite(phase) || !Number.isFinite(scale) || !Number.isFinite(speed) ||
      !Number.isInteger(dwell) || dwell < 0 || typeof ended !== 'boolean' ||
      ![-1, 0, 1, 0xffffffff].includes(footfallLatch)) {
    throw new RangeError('Initial racer motion state is incomplete');
  }
  return { clip, phase: f32(phase), pendingClip, queuedClip, ended, dwell, speed, footfallLatch, scale };
}

function presentationInput(state, { smoothedDistance, forwardDelta }, sleepActive) {
  return {
    smoothedDistance, forwardDelta, sleepActive,
    animationFrame: state.phase, animationLength: clips.get(state.clip).frames,
    footfallLatch: state.footfallLatch, animationId: state.clip,
    queuedAnimationId: state.queuedClip, idleClipEnding: state.ended,
  };
}

function advanceRacerMotion(state, forwardDelta, sleepActive, event, fps) {
  if (event?.type === 'footfall') state.footfallLatch = event.footfallLatch;
  if (sleepActive && ![0x3b, 0x3c, 0x3d].includes(state.clip)) {
    state.pendingClip = 0x3d;
    state.queuedClip = 0x3c;
  } else if (!sleepActive && forwardDelta > f32(.6)) {
    state.pendingClip = 0x3e;
    state.queuedClip = 0;
    state.dwell = 0;
    state.speed = playbackSpeed(forwardDelta, state.scale, .6);
  } else if (!sleepActive && ((state.clip === 0x3e && forwardDelta < f32(.4)) ||
    (state.clip !== 0x3e && forwardDelta > f32(.1)))) {
    state.pendingClip = 0x3f;
    state.queuedClip = 0;
    state.dwell = 0;
    state.speed = playbackSpeed(forwardDelta, state.scale, .2);
  }
  if (event?.type === 'idle') {
    state.pendingClip = event.clip;
    state.queuedClip = event.queuedClip;
    state.speed = 1;
    state.dwell = event.dwell;
  }

  // CKame +0x1734 services transitions before advancing the model clip.
  if (state.dwell > 0) state.dwell--;
  if (state.pendingClip !== state.clip) {
    state.clip = state.pendingClip;
    state.phase = 0;
  } else if (state.queuedClip && state.ended) {
    const next = state.queuedClip;
    state.clip = next;
    state.pendingClip = next;
    state.phase = 0;
    switch (next) {
      case 0x36: state.queuedClip = state.dwell ? 0x36 : 0x35; break;
      case 0x39: state.queuedClip = state.dwell ? 0x39 : 0x38; break;
      case 0x35: case 0x38: state.queuedClip = 0x34; break;
      default: state.queuedClip = 0;
    }
  }
  const clip = clips.get(state.clip);
  // The model clock rounds elapsed seconds before converting to asset frames.
  const step = f32(f32(state.speed * f32(1 / fps)) * 30);
  const rawPhase = f32(state.phase + step);
  state.ended = rawPhase >= clip.frames;
  if (clip.loop) {
    state.ended ||= rawPhase < 0;
    state.phase = state.ended ? f32(rawPhase + (rawPhase < 0 ? clip.frames : -clip.frames)) : rawPhase;
  } else {
    state.phase = Math.max(0, Math.min(rawPhase, clip.frames));
  }
  return state;
}

module.exports = { racerScale, projectStep, projectLateralOffset, initializeRacerMotion, presentationInput, advanceRacerMotion };

},
(module, load) => {
'use strict';

const f32 = Math.fround;
const footstepSounds = {
  Normal: [0xcb0000, 5],
  Mud: [0xcb0005, 4],
  Sand: [0xcb0009, 5],
  Water: [0xcb000e, 5],
};

// PRX +0x7468 runs in slot order after the race's movement callback. Its
// displacement and animation queries are inputs from the native model, at this checkpoint.
function stepRacePresentation(race, racers, frameInputs) {
  const missing = [];
  const plan = [];
  const { track } = race;
  if (!Array.isArray(frameInputs?.racers) || frameInputs.racers.length !== racers.length) {
    return { complete: false, draws: 0, missing: ['racers'] };
  }

  for (let slot = 0; slot < racers.length; slot += 1) {
    const input = frameInputs.racers[slot];
    if (input === null) continue; // No native racer in this slot.
    const prefix = 'racers[' + slot + '].';
    if (!input) {
      missing.push(prefix.slice(0, -1));
      continue;
    }
    const forwardDelta = f32(input.forwardDelta);
    if (!Number.isFinite(input.forwardDelta) || !Number.isFinite(forwardDelta)) {
      missing.push(prefix + 'forwardDelta');
      continue;
    }

    if (forwardDelta > f32(.1)) {
      const { smoothedDistance, footfallLatch, animationFrame, animationLength } = input;
      const latch = footfallLatch === 0xffffffff ? -1 : footfallLatch;
      const savedMissing = missing.length;
      if (latch !== -1 && latch !== 0 && latch !== 1) missing.push(prefix + 'footfallLatch');
      if (!Number.isFinite(animationFrame)) missing.push(prefix + 'animationFrame');
      if (!(Number.isFinite(animationLength) && animationLength > 0)) missing.push(prefix + 'animationLength');
      if (missing.length !== savedMissing) continue;

      // The initial -1 latch tests the half-cycle before the wrap, then a
      // successful footfall starts alternating the two triggers (+0x7D68–+0x7E14).
      const frame = f32(animationFrame);
      const length = f32(animationLength);
      const halfFrame = f32(length * .5);
      const atHalfCycle = latch !== 0 && frame > f32(halfFrame - 2) && frame < f32(halfFrame + 2);
      const atWrap = latch !== 1 && (frame < 2 || frame > f32(length - 2));
      if (!atHalfCycle && !atWrap) continue;

      if (!Number.isFinite(smoothedDistance)) {
        missing.push(prefix + 'smoothedDistance');
        continue;
      }
      const section = Math.min(track.length - 1, Math.max(0, Math.trunc(f32(f32(smoothedDistance) / 100))));
      const surface = track[section];
      // +0x8530 checks the previous section when the current terrain has no
      // effect of its own. The transition effect is keyed to Water (code 2).
      const leavingWater = ['Start', 'Normal', 'Finish'].includes(surface) && track[section - 1] === 'Water';
      if (leavingWater && typeof frameInputs.effectManagerActive !== 'boolean') {
        missing.push('effectManagerActive');
        continue;
      }
      plan.push({ slot, type: 'footfall', surface, leavingWater, footfallLatch: atHalfCycle ? 0 : 1 });
      continue;
    }

    // A stationary racer goes from the 0x3e running clip to 0x3f first.
    // It can leave 0x3f directly, or pick a new idle after an unqueued clip ends.
    if (forwardDelta > f32(.05)) continue;
    if (typeof input.sleepActive !== 'boolean') {
      missing.push(prefix + 'sleepActive');
      continue;
    }
    if (input.sleepActive) continue;
    if (!Number.isInteger(input.animationId)) {
      missing.push(prefix + 'animationId');
      continue;
    }
    if (input.animationId === 0x3e) continue;
    if (input.animationId === 0x3f) {
      plan.push({ slot, type: 'idle' });
      continue;
    }
    if (!Number.isInteger(input.queuedAnimationId)) {
      missing.push(prefix + 'queuedAnimationId');
      continue;
    }
    if (input.queuedAnimationId !== 0) continue;
    if (typeof input.idleClipEnding !== 'boolean') {
      missing.push(prefix + 'idleClipEnding');
      continue;
    }
    if (input.idleClipEnding) plan.push({ slot, type: 'idle' });
  }

  // Any unresolved earlier slot can change the RNG used for later slots.
  // Leave the stream intact when the whole frame cannot be recovered.
  if (missing.length) return { complete: false, draws: 0, missing };
  const rng = race.rng;
  const startDraws = rng.draws;
  const events = [];
  for (const event of plan) {
    if (event.type === 'idle') {
      const variant = rng.next15() % 5; // +0x8220
      const clip = variant === 0 ? 0x37 : variant === 1 ? 0x3a : 0x34;
      const queuedClip = variant === 0 ? 0x36 : variant === 1 ? 0x39 : 0;
      const rate = race.timerRate;
      const dwell = Math.trunc(f32(f32(rng.next16() * f32(1 / 65535)) * (rate * 7) + rate * 3)); // +0x86F8
      events.push({ slot: event.slot, type: event.type, clip, queuedClip, dwell });
      continue;
    }

    const effects = [];
    const orientationRolls = [];
    if (event.surface === 'Mud') {
      effects.push(0x419ce9 + rng.next15() % 2, 0x419ce6); // +0x8064
    } else if (event.surface === 'Sand') {
      effects.push(0x419ce7 + rng.next15() % 2); // +0x7E98
    } else if (event.leavingWater) {
      effects.push(0x419ce2 + rng.next15() % 4); // +0x7E98
      if (frameInputs.effectManagerActive) orientationRolls.push(rng.next15(), rng.next15()); // +0x72BC, +0x71F4
    }

    const [base, count] = footstepSounds[event.surface] ?? footstepSounds.Normal;
    const sound = base + rng.next15() % count; // +0x7F18 (Mud uses +0x87D8)
    events.push({ ...event, effects, orientationRolls, sound });
  }
  return { complete: true, draws: rng.draws - startDraws, events };
}

module.exports = { stepRacePresentation };


},
(module, load) => {
'use strict';

const { actorWorldSphere, controllerRootPoint, crowdRefreshesNearCamera, crowdYawToward,
  modelControllerMatrix, sampleMotionRoot, yawSinCos } = load(18);
const { advanceAnimationClock } = load(12);
const { modelCameraSphere, cameraBand } = load(14);
const { readSceneTiming } = load(19);

// property.bin CAPR clips with root-retention mode 1.
const retainingRootIds = [893, 1015, 1017, 2069, 2070, 2082, 2083, 2090, 2129, 2130, 2135, 2136, 2144];

function createModelGeometryForecast({ scene, curves, onCrowdPose }) {
  if (!curves) throw new RangeError('The Crystal Cup scene model needs the extracted root curves');
  const retainingRoot = new Set(retainingRootIds.map(id => curves[id]));
  const { fps } = readSceneTiming(scene);
  const clock = { clockFactor: 1, modelFactor: 1, frameStep: fps };
  const thresholds = [-1.1, -8, -16, -20, -40, 0].map(Math.fround);
  const identity = [[1, 0, 0], [0, 1, 0], [0, 0, 1], [0, 0, 0]];
  const actors = [...scene.sceneCheckpoint.actors].sort((hi, lo) =>
    hi.kind === lo.kind ? hi.slot - lo.slot : hi.kind === 'crowd' ? -1 : 1);
  const crowdOverride = new Set(scene.crowdSample.filter(actor => actor.override).map(actor => actor.pointer));
  const fade = new Map(actors.map(actor => [actor.pointer, actor.culling.fade]));
  const f32 = Math.fround;
  const timing = scene.animationTiming;

  const crowdPoses = new Map(scene.crowdSample.filter(actor => !actor.override).map(sample => {
    const actor = actors.find(candidate => candidate.pointer === sample.pointer);
    const clip = curves[sample.animationSample.modelClip];
    const ctrl = sample.animationSample.controller;
    return [actor.pointer, { clip, raw: sampleMotionRoot(clip, ctrl.frame), base: [...actor.basePosition],
      yaw: actor.yaw, speed: sample.speed, frame: ctrl.frame, flags: ctrl.flags,
      featured: Boolean(sample.featured),
      rootBlendTicks: 0,
      multiplier: ctrl.multiplier, queuedMotions: ctrl.queuedMotions,
      blendActive: ctrl.blendFallback !== 0,
      secondaryActive: ctrl.secondaryClip >= 0 || ctrl.secondaryStart !== 0 || ctrl.secondaryEnd !== 0,
    }];
  }));

  function forecastCrowd(actor, physics, event, anchorReset) {
    const state = crowdPoses.get(actor.pointer);
    if (!state) return { position: actor.position, yaw: actor.yaw };
    const previousClip = state.clip;
    const before = onCrowdPose && {
      ...state, base: state.base.slice(), raw: state.raw.slice(), clip: state.clip.name,
    };
    let reset = false;
    if (event?.started) {
      const leader = physics.racers.find(racer => racer.place === 1) ??
        physics.racers.reduce((a, b) => a.distance < b.distance ? b : a);
      const target = leader.base;
      const anchor = actor.crowdAnchor;
      state.yaw = crowdYawToward(anchor, target, event.angleJitter ?? 0);
      state.speed = f32(f32(event.speedRoll * f32(1 / 65535) - .5) * .5 + 1);
      state.frame = event.phaseRoll % (3 * Math.trunc(state.clip.frames / 4));
      state.flags = 0;
      state.clip = curves[event.clip];
      state.rootBlendTicks = 0;
      reset = true;
    } else if (event) {
      state.frame = 0;
      state.flags = 0;
      state.clip = curves[event.clip];
      state.rootBlendTicks = 5;
      reset = true;
    }
    const step = advanceAnimationClock(state, state.clip, timing);
    if (!step.complete) throw Error('Standing position clock incomplete for crowd slot ' + actor.slot);
    Object.assign(state, step);
    const raw = sampleMotionRoot(state.clip, state.frame);
    if (state.rootBlendTicks > 0) {
      // Automatic clip changes fade in horizontal motion over five updates.
      // The controller stores its weight as a byte, with 255/256 at the end.
      const weight = (6 - state.rootBlendTicks) * 51 / 256;
      raw[0] = f32(raw[0] * weight);
      raw[2] = f32(raw[2] * weight);
      state.rootBlendTicks--;
    }
    const { sin, cos } = yawSinCos(state.yaw);
    // Explicit starts into looping clips can subtract the previous
    // controller root (+830) even after the race task resets the anchor.
    // A wrapped frame uses absolute translation (+48EEFC).
    const carry = !reset || (event?.started && state.clip.loop && retainingRoot.has(previousClip) &&
      (step.flags & 0x4000) === 0);
    // A featured actor's forced refresh of its standing loop starts X/Z
    // movement from the anchor. The one-shot cheers apply their sampled root.
    const refreshFeatured = state.featured && event?.started && state.clip.loop && previousClip === state.clip;
    const dx = refreshFeatured ? 0 : f32(raw[0] - (carry ? state.raw[0] : 0));
    const dz = refreshFeatured ? 0 : f32(raw[2] - (carry ? state.raw[2] : 0));
    const base = reset || anchorReset ? actor.crowdAnchor : state.base;
    state.base = [f32(base[0] + f32(f32(dx * cos) + f32(dz * sin))), base[1],
      f32(base[2] + f32(f32(dz * cos) - f32(dx * sin)))];
    state.raw = raw;
    const adjustment = [0, 4, 8, 12].map(index => actor.adjustmentMatrix.slice(index, index + 4));
    const matrix = modelControllerMatrix({ position: state.base, yaw: state.yaw, adjustment });
    const position = controllerRootPoint({ matrix, root: [0, raw[1], 0] });
    onCrowdPose?.({
      frame: physics.frame, slot: actor.slot, before, after: { ...state, clip: state.clip.name }, event, position,
    });
    return { position, yaw: state.yaw };
  }

  function forecast(camera, physics) {
    const viewTransform = [0, 4, 8, 12].map(index => camera.matrix.slice(index, index + 4));
    const projected = actors.map(actor => {
      const crowd = actor.kind === 'crowd';
      const event = crowd && physics.crowdEvents?.findLast(event => event.slot === actor.slot && event.type === 'start');
      const anchorReset = crowd && physics.crowdAnchorResets?.includes(actor.slot);
      // PRX +5394 and +5524 reset queued crowd actors to their anchors
      // even if +2D90 then keeps their current clip after a loop.
      const positionBeforeUpdate = anchorReset || event?.started ? actor.crowdAnchor :
        crowdPoses.get(actor.pointer)?.base ?? actor.basePosition;
      const classificationEnabled = !crowd || !crowdOverride.has(actor.pointer) &&
        !crowdRefreshesNearCamera(positionBeforeUpdate, camera.crowdEye ?? camera.state.eye);
      const modeledPose = crowd ? forecastCrowd(actor, physics, event, anchorReset) : null;
      const world = crowd ? actorWorldSphere({
        radius: actor.localSphere[3], localCenter: actor.localSphere.slice(0, 3),
        ...modeledPose,
      }) : physics.racers[actor.slot].world;
      const { primary } = modelCameraSphere({ localCenter: world.center, radius: world.radius,
        ownerTransform: identity, viewTransform });
      const band = classificationEnabled ? cameraBand({
        depth: primary.center[2], thresholds, margin: Math.fround(.1), fade: fade.get(actor.pointer),
        fadeStep: .25, keepBandZero: false, lodEnabled: false,
      }) : { band: 0, fade: 0 };
      fade.set(actor.pointer, band.fade);
      return { actor: actor.pointer, modelOwner: actor.modelOwner, forcePose: actor.culling.forcePose,
        classificationEnabled, cameraAvailable: true, band: band.band, primary, alternate: null, world };
    });
    return { frame: camera.frame, actors: projected, frustum: camera.frustum, occlusion: { enabled: false }, clock };
  }
  return forecast;
}

module.exports = { createModelGeometryForecast };

},
(module, load) => {
'use strict';

const f32 = Math.fround;
const angleUnit = (2 * Math.PI) / 65536;
const centimeters = f32(0.01);
const laneWidth = f32(0.15);
const laneOrigin = f32(-0.3);
const shortTravelOffset = f32(0.05);
const scaleOffset = f32(-0.1);
const angleBits = new DataView(new ArrayBuffer(4));

function fusedSingle(left, right, addend) {
  // The product is exact in binary64. Correct any conversion that rounded
  // through a binary32 halfway point when adding the third operand.
  const product = left * right;
  const sum = product + addend;
  const rounded = f32(sum);
  if (sum === rounded) return rounded;
  const carry = sum - product;
  const error = (product - (sum - carry)) + (addend - carry);
  if (!error || (error > 0) === (rounded > sum)) return rounded;
  const opposite = f32(2 * sum - rounded);
  return Math.abs(rounded - sum) === Math.abs(opposite - sum) ? opposite : rounded;
}

function yawSinCos(yaw) {
  // EBOOT 55B14C reads a quarter-turn table of adjacent binary32 sine/cosine
  // pairs. The original 16,384 pairs match rounding these functions to f32.
  const angle = yaw & 0xffff;
  const quarter = (angle & 0x3fff) * angleUnit;
  const sine = f32(Math.sin(quarter));
  const cosine = f32(Math.cos(quarter));
  const swing = (angle & 0x4000) !== 0;
  const sin = angle & 0x8000 ? -(swing ? cosine : sine) : (swing ? cosine : sine);
  const cos = (angle + 0x4000) & 0x8000 ? -(swing ? sine : cosine) : (swing ? sine : cosine);
  return { sin, cos };
}

function crowdYawToward(position, target, jitter = 0) {
  // Kamerace 37C54 quantizes the ratio using the mantissa of 1 + ratio.
  // Its quarter-octant table is atan(single(index / 16384)) in turn units.
  const x = f32(f32(target[0]) - f32(position[0]));
  const z = f32(f32(target[2]) - f32(position[2]));
  if (x === 0) return (z >= 0 ? 0 : 0x8000) + jitter;
  if (z === 0) return (x > 0 ? 0x4000 : -0x4000) + jitter;
  const absX = Math.abs(x);
  const absZ = Math.abs(z);
  const difference = f32(absZ - absX);
  const octantTolerance = 1 / 16384;
  let firstQuadrant;
  if (Math.abs(difference) <= octantTolerance) {
    firstQuadrant = 0x2000;
  } else {
    const ratio = f32(Math.min(absX, absZ) / Math.max(absX, absZ));
    angleBits.setFloat32(0, f32(1 + ratio));
    const index = (angleBits.getUint32(0) >>> 9) & 0x3fff;
    const tableAngle = Math.trunc(f32(f32(Math.atan(index / 16384)) / angleUnit));
    firstQuadrant = difference > 0 ? tableAngle : 0x4000 - tableAngle;
  }
  return (x > 0 ? 1 : -1) * (z > 0 ? firstQuadrant : 0x8000 - firstQuadrant) + jitter;
}

function actorWorldSphere({ localCenter, radius, position, yaw }) {
  // EBOOT 9E538–9E5E8: actor state stores the position and yaw separately
  // from the local sphere. Rotation is about world Y with no radius scaling.
  const [x, y, z] = localCenter.map(f32);
  const [tx, ty, tz] = position.map(f32);
  const { sin, cos } = yawSinCos(yaw);
  return {
    center: [
      f32(f32(cos * x) + f32(f32(sin * z) + tx)),
      f32(y + ty),
      f32(f32(-sin * x) + f32(f32(cos * z) + tz)),
    ],
    radius: f32(radius),
  };
}

function controllerRootPoint({ matrix, root }) {
  // EBOOT 482470 reads the world matrix via the controller's +0x64 call
  // and multiplies it by the selected local joint translation. For joint 0,
  // 48C2A8 stores this point as the position used by actorWorldSphere.
  const [x, y, z] = root.map(f32);
  const [columnX, columnY, columnZ, translation] = matrix;
  return [0, 1, 2].map(axis => {
    const translatedX = fusedSingle(f32(columnX[axis]), x, f32(translation[axis]));
    const translatedY = fusedSingle(f32(columnY[axis]), y, translatedX);
    return fusedSingle(f32(columnZ[axis]), z, translatedY);
  });
}

function modelControllerMatrix({ position, yaw, pendingYaw = 0, adjustment, anchorBlend }) {
  // Common controller virtual +0x60 at EBOOT 48CB08. The translation is
  // the current controller+0x80 point. Adjustment stores the four columns
  // that the race wrapper sends to +48966C.
  let anchor = position.slice(0, 3).map(f32);
  let angle = (yaw + pendingYaw) | 0;
  if (anchorBlend?.weight > 0) {
    const weight = f32(anchorBlend.weight);
    const originalWeight = f32(1 - weight);
    anchor = anchor.map((coordinate, axis) => f32(
      f32(coordinate * originalWeight) + f32(f32(anchorBlend.position[axis]) * weight),
    ));
    const shortYaw = (angle << 16) >> 16;
    const difference = ((anchorBlend.yaw - shortYaw) << 16) >> 16;
    angle = ((shortYaw + Math.trunc(f32(difference * weight))) << 16) >> 16;
  }
  const { sin, cos } = yawSinCos(angle);
  const matrix = [[cos, 0, -sin, 0], [0, 1, 0, 0], [sin, 0, cos, 0], [...anchor, 1]];
  return adjustment.map(([x, y, z], column) => [
    ...controllerRootPoint({
      matrix: column === 3 ? matrix : [matrix[0], matrix[1], matrix[2], [0, 0, 0, 0]],
      root: [x, y, z],
    }),
    column === 3 ? 1 : 0,
  ]);
}

function crowdRefreshesNearCamera(position, eye) {
  // Kamerace 2F58–2F98 compares the actor's pre-update world position
  // against the race camera's current eye in the horizontal plane.
  const dx = f32(f32(position[0]) - f32(eye[0]));
  const dz = f32(f32(position[2]) - f32(eye[2]));
  return Math.sqrt(f32(f32(dx * dx) + f32(dz * dz))) < 1;
}

function racerLandAdjustment(scale) {
  // Kamerace 7964–7A90 scales the three axes of the identity matrix.
  const size = f32(scale);
  return [[size, 0, 0, 0], [0, size, 0, 0], [0, 0, size, 0], [0, 0, 0, 1]];
}

function waterSectionFraction(smoothedDistance, sectionIndex) {
  const progress = f32(smoothedDistance * centimeters);
  return Math.min(1, Math.max(0, f32(progress - sectionIndex)));
}

function racerCameraHeight(smoothedDistance, sectionIndex, scale, track) {
  if (track[sectionIndex] !== 'Water') return 0;
  const fraction = waterSectionFraction(smoothedDistance, sectionIndex);
  let height = f32(scale * f32(-.02));
  // Kamerace 76A8–76C0 lowers the model anchor on entering water.
  if (fraction < f32(.15)) {
    height = f32(height * f32(Math.max(0, f32(fraction - f32(.05))) / f32(.10)));
  } else if (fraction > f32(.95)) {
    height = f32(height * f32(f32(1 - fraction) / f32(.05)));
  }
  return height;
}

function racerTerrainAdjustment(smoothedDistance, sectionIndex, scale, track) {
  if (track[sectionIndex] !== 'Water') return racerLandAdjustment(scale);
  const fraction = waterSectionFraction(smoothedDistance, sectionIndex);
  const ramp = f32(.025);
  let pitch = 0;
  // +07690–07818 pitches the shell down into the water and up onto land.
  if (fraction < f32(.15)) {
    const entry = Math.max(0, f32(fraction - f32(.05)));
    const rise = Math.min(entry, f32(f32(.10) - entry));
    pitch = Math.trunc(f32(f32(Math.min(ramp, rise) / ramp) * 2048));
  } else if (fraction > f32(.95)) {
    const rise = Math.min(f32(fraction - f32(.95)), f32(1 - fraction), ramp);
    pitch = Math.trunc(f32(f32(rise / ramp) * -1024));
  }
  const { sin, cos } = yawSinCos(pitch);
  const y = f32(scale * cos);
  const z = f32(scale * sin);
  return [[scale, 0, 0, 0], [0, y, z, 0], [0, -z, y, 0], [0, 0, 0, 1]];
}

function sampleRootKeys(keys, phase) {
  let lo = 0;
  let hi = keys.length;
  while (lo + 1 < hi) {
    const mid = (lo + hi) >>> 1;
    if (keys[mid][0] <= phase) lo = mid;
    else hi = mid;
  }
  const from = keys[lo];
  const to = keys[hi];
  if (!to || phase <= from[0]) return from.slice(1);
  // The native GMT position blend scales fractional progress by 255/256.
  // This matches unblended crowd roots captured at EBOOT +0x48C2A8.
  const blend = f32(f32(f32(phase - from[0]) / (to[0] - from[0])) * (255 / 256));
  return from.slice(1).map((value, axis) => fusedSingle(f32(to[axis + 1] - value), blend, value));
}

function sampleMotionRoot(clip, phase) {
  const channels = clip?.translation;
  if (!channels?.length || !Number.isFinite(phase) || phase < 0 ||
      channels.some(channel => !channel.keys?.length)) {
    throw new RangeError('Root motion needs the native position keys and animation phase');
  }
  if (channels[0].axis === 'xyz') return sampleRootKeys(channels[0].keys, phase);
  const root = [0, 0, 0];
  for (const channel of channels) {
    const axis = 'xyz'.indexOf(channel.axis);
    if (axis < 0 || channel.axis.length !== 1) throw new RangeError('Unknown native root-motion channel');
    root[axis] = sampleRootKeys(channel.keys, phase)[0];
  }
  return root;
}

function racerRequestedPose({ slot, smoothedDistance, drift, lateralOffset = drift, scale, raceState = 16 }) {
  // Kamerace 7A98–7B10 sets yaw, then 7B88–7C08 submits the point to the
  // actor controller. The result-screen path can substitute another point.
  if (raceState !== 16 || !Number.isInteger(slot) || slot < 0 || slot > 4 ||
      ![smoothedDistance, drift, lateralOffset, scale].every(Number.isFinite)) {
    throw new RangeError('The moving-race pose needs a slot and finite smoothed distance, drift, and scale');
  }
  const distance = f32(smoothedDistance);
  const trackOffset = f32(distance * centimeters);
  const lane = fusedSingle(slot, laneWidth, laneOrigin);
  const spareTravel = f32(1 - Math.min(1, distance));
  const startingOffset = fusedSingle(spareTravel, shortTravelOffset, shortTravelOffset);
  const scaleAdjustment = f32(1 - f32(scale));
  const longitudinal = f32(fusedSingle(scaleAdjustment, scaleOffset, startingOffset) - trackOffset);
  return {
    position: [f32(f32(lateralOffset * centimeters) + lane), 0, longitudinal],
    yaw: Math.trunc(fusedSingle(drift, 4096, 32768)),
  };
}

module.exports = {
  actorWorldSphere, controllerRootPoint, crowdRefreshesNearCamera, crowdYawToward, modelControllerMatrix,
  racerCameraHeight, racerLandAdjustment, racerRequestedPose, racerTerrainAdjustment,
  sampleCrowdRoot: sampleMotionRoot, sampleMotionRoot, yawSinCos,
};

},
(module, load) => {
'use strict';

const { readTurtles } = load(20);

const surfaceNames = ['Start', 'Normal', 'Water', 'Sand', 'Mud', 'Finish'];
const slotOffset = 0x8bb4;

function readSceneTiming(scene) {
  const { modelFrameRate: fps, compensationRatio, timerRate, stepSeconds } = scene.guestRaceClock ?? {};
  if (![30, 60, 120].includes(fps) || stepSeconds !== Math.fround(1 / fps)) {
    throw new RangeError('The scene checkpoint needs a measured 30, 60 or 120 FPS guest timestep');
  }
  const scale = fps / 30;
  // Before native-rate captures recorded the effective constants, the
  // unused patch timing words were zero. The patched rates need both words.
  const hasClock = compensationRatio === scale && timerRate === fps;
  const oldNativeClock = fps === 30 && compensationRatio === 0 && timerRate === 0;
  if (!hasClock && !oldNativeClock) throw new RangeError('Scene compensation ratio or timer rate disagrees with its timestep');
  return { fps, scale };
}

function readRacer(frame, slot) {
  const raw = frame.racers[slot];
  const record = Buffer.from(raw.record, 'hex');
  const save = new Uint8Array(slotOffset + 5 * record.length);
  save.set(record, slotOffset);
  // Rival race records do not need an ownership bit inside the game.
  save[slotOffset + 0x39] |= 1;
  const turtle = readTurtles(new DataView(save.buffer))[0];
  const activeStumble = raw.mishapTicks > 0 && [2, 4].includes(raw.condition);
  const segment = frame.segmentIndices?.[slot];
  return {
    ...turtle,
    slot,
    name: raw.name || turtle.name,
    runtime: {
      distance: frame.distance[slot],
      sectionIndex: segment >= 0 && segment < frame.course.length && Number.isInteger(segment) ? segment : undefined,
      condition: raw.condition,
      cheerActive: Boolean(raw.cheerActive),
      cheerDelay: frame.cooldowns[slot],
      cheerWindow: raw.cheerWindow,
      cheerTarget: raw.cheerTarget,
      cheerMultiplier: raw.cheerMultiplier,
      mishapTicks: raw.mishapTicks,
      mishapMultiplier: raw.mishapMultiplier,
      sleepUsed: Boolean(raw.sleepUsed),
      clumsyAnimation: frame.schemaVersion >= 2 ? Boolean(raw.clumsyAnimation) : activeStumble,
      drift: frame.drift?.[slot] ?? 0,
      laneFlag: frame.flags[slot] & 0x20,
    },
  };
}

function readInitialPresentation(frame, input) {
  if (input && (input.checkpointFrame !== frame.frame || !input.presentation)) {
    throw new RangeError('The presentation checkpoint must match the replay start frame');
  }
  const checkpoint = input?.presentation;
  return {
    effectManagerActive: frame.effectManagerPresent,
    commentary: checkpoint?.commentary,
    crowd: checkpoint?.crowd ?? frame.crowdSample ?? undefined,
    animationTiming: checkpoint?.animationTiming ?? frame.animationTiming,
    modelNoise: checkpoint?.modelNoise,
    racers: frame.racers.map((racer, slot) => ({
      clip: racer.activeClip,
      phase: racer.animationSample?.animationFrame,
      pendingClip: racer.pendingClip,
      queuedClip: racer.queuedClip,
      ended: racer.animationSample?.idleClipEnding,
      dwell: racer.idleDwell,
      speed: racer.playbackSpeed,
      scale: frame.racerScales?.[slot],
      footfallLatch: frame.footstepLatch?.[slot],
      smoothedDistance: frame.smoothedDistance?.[slot],
      forwardDelta: frame.forwardDeltas?.[slot],
    })),
  };
}

module.exports = { readInitialPresentation, readRacer, readSceneTiming, surfaceNames };

},
(module, load) => {
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

},
(module, load) => {
'use strict';

const motion = load(22);
const { cameraFrustum } = load(23);
const { finishCommentaryStandings } = load(9);

const f32 = Math.fround;

function selectFocus(selector, actors, rank) {
  const { focusSlot, focusBySlot, keepFocusX } = selector;
  if (selector.cueId === 7 && focusSlot === -1) return actors[rank[4]].base.slice();
  if (focusBySlot && !actors[focusSlot]) throw new RangeError('Missing camera focus actor');
  if (!focusBySlot && (focusSlot < 1 || focusSlot > rank.length)) {
    throw new RangeError('Camera focus needs a ranked group');
  }
  const selected = focusBySlot ? [focusSlot] : rank.slice(0, focusSlot);
  const point = [0, 0, 0];
  for (const slot of selected) {
    for (let axis = 0; axis < point.length; axis++) {
      point[axis] = f32(point[axis] + actors[slot].base[axis]);
    }
  }
  if (selected.length > 1) {
    const weight = f32(1 / selected.length);
    for (let axis = 0; axis < point.length; axis++) point[axis] = f32(point[axis] * weight);
  }
  if (!keepFocusX) point[0] = 0;
  return point;
}

function advanceShot(cue, state, focus, phase, scale) {
  switch (cue) {
    case 4: return motion.advanceCountdownCamera(state, focus, scale);
    case 5: return motion.advanceLateralCamera(state, focus, scale);
    case 6: return motion.advanceSideTrackingCamera(state, focus, scale);
    case 7: return motion.advanceRearPanCamera(state, scale);
    case 8: return motion.advanceOrbitCamera(state, focus, phase, scale);
    case 10: return motion.advanceFixedEyeCamera(state, scale);
    case 12: return motion.advanceSleepCamera(state, focus, scale);
    case 13: return motion.advanceCloseOrbitCamera(state, focus);
    case 14: return motion.advanceFinishApproachCamera(state, focus, scale);
    case 15: return motion.advanceFinishLineCamera(state, focus, scale);
    case 16: return motion.advanceEndCamera(state, focus, scale);
    default: throw new RangeError(`Unmodeled camera shot ${cue}`);
  }
}

function startShot(cue, previousState, focus, leaderFocus, leader, phase, scale, sections) {
  const { variant, cameraRandomWords } = cue;
  switch (cue.cueId) {
    case 5: return motion.startLateralCamera(variant, leader.slot, focus);
    case 6: return motion.startSideTrackingCamera(variant, leader.slot, cameraRandomWords, focus, leaderFocus);
    case 7: return motion.startRearPanCamera(cameraRandomWords, focus);
    case 8: return motion.startOrbitCamera(variant, leader.velocity, focus, phase, scale);
    case 10: return motion.startFixedEyeCamera(variant, cameraRandomWords, leaderFocus);
    case 12: return motion.startSleepCamera(variant, focus);
    case 13: return motion.startCloseOrbitCamera(variant, cue.focusSlot, leader.velocity, cameraRandomWords[0], focus, scale);
    case 14: return motion.startFinishApproachCamera(variant, sections, cameraRandomWords, focus);
    case 15: return motion.startFinishLineCamera(variant, leader.slot, sections, focus, previousState.target);
    case 16: return motion.startEndCamera(sections, focus);
    default: throw new RangeError(`Unmodeled camera shot ${cue.cueId}`);
  }
}

function createSceneCamera(start, actors, sections) {
  const { cutoff, nativeClockPhase, startingPose, scale, aspect, near, far } = start;
  let state = startingPose;
  let selector = start.startingSelector ?? { cueId: 4, focusSlot: 1 };
  let previousActors = actors;
  let previousRank = finishCommentaryStandings(actors, sections * 100).rank;
  return function updateCamera(frame, racers, nextActors, commentary) {
    const phase = nativeClockPhase + frame - cutoff;
    const followSelector = selector.cueId === 6 ? { ...selector, focusSlot: selector.focusBySlot ? selector.focusSlot : 1 } : selector;
    const focus = selectFocus(followSelector, previousActors, previousRank);
    state = advanceShot(selector.cueId, state, focus, phase, scale);
    const published = state;
    const frustum = cameraFrustum({ fov: published.fov, aspect, near, far });
    const matrix = motion.viewFromCameraPose(published).flat();
    const { rank } = finishCommentaryStandings(racers, sections * 100);
    // The +2A70C follow-up plays a sound through +01FB4, without moving the camera.
    const cue = commentary?.cue;
    if (cue?.accepted) {
      const selected = selectFocus(cue, previousActors, rank);
      const leaderFocus = selectFocus(cue.focusBySlot ? cue : { ...cue, focusSlot: 1 }, previousActors, rank);
      state = startShot(cue, state, selected, leaderFocus, racers[rank[0]], phase, scale, sections);
      selector = cue;
    }
    previousActors = nextActors;
    previousRank = rank;
    return { frame, state: published, matrix, frustum, crowdEye: state.eye, active: state, focus, selector };
  };
}

module.exports = { createSceneCamera };

},
(module, load) => {
'use strict';

const { yawSinCos } = load(18);

const f32 = Math.fround;
const unitScale = f32(1 / 65535);
const nearZeroLengthSquared = 2 ** -32;
const worldUp = [0, 1, 0];

function add(a, b) {
  return a.map((value, axis) => f32(value + b[axis]));
}

function subtract(a, b) {
  return a.map((value, axis) => f32(value - b[axis]));
}

function dot(a, b) {
  return f32(f32(f32(a[0] * b[0]) + f32(a[1] * b[1])) + f32(a[2] * b[2]));
}

function cross(a, b) {
  return [0, 1, 2].map(axis => {
    const j = (axis + 1) % 3;
    const k = (axis + 2) % 3;
    return f32(f32(a[j] * b[k]) - a[k] * b[j]);
  });
}

function normalize(vector) {
  const squared = dot(vector, vector);
  // EBOOT +0x56010C refines the VMX estimate with one Newton step.
  // This starts from the non-accurate-estimate RPCS3 PPU mode.
  const estimate = f32(1 / f32(Math.sqrt(squared)));
  const factor = f32(estimate * f32(1.5 - f32(squared * estimate) * f32(estimate * .5)));
  return vector.map(value => f32(value * factor));
}

function isVector(value) {
  return Array.isArray(value) && value.length === 3 && value.every(Number.isFinite);
}

function validateRandomWords(words, length) {
  return Array.isArray(words) && words.length === length &&
    words.every(word => Number.isInteger(word) && word >= 0 && word <= 0xffff);
}

function timingRetention(gain, scale) {
  let retention = 1 - gain;
  for (let remaining = scale; remaining > 1; remaining /= 2) {
    retention = Math.sqrt(retention);
  }
  return retention;
}

function viewFromCameraPose({ eye, target, up = worldUp }) {
  if (![eye, target, up].every(isVector)) throw new TypeError('Camera pose needs three finite vectors');
  let back = subtract(eye, target);
  const normal = cross(up, back);
  // +0x4C02BC substitutes a canonical pose for near-coincident or parallel inputs.
  if (dot(back, back) < nearZeroLengthSquared || dot(normal, normal) < nearZeroLengthSquared) {
    eye = [0, 0, 0];
    back = [0, 0, -1];
    up = worldUp;
  }
  const cameraZ = normalize(back);
  const cameraX = normalize(cross(normalize(up), cameraZ));
  const cameraY = normalize(cross(cameraZ, cameraX));
  return [
    ...[0, 1, 2].map(i => [cameraX[i], cameraY[i], cameraZ[i], 0]),
    [-dot(eye, cameraX), -dot(eye, cameraY), -dot(eye, cameraZ), 1],
  ];
}

// PRX +0x17588 initializes the lateral tracking shot. Its origin,
// side, and X increment use consecutive low-16 results already
// drawn by the native cue. This helper does not advance shared RNG.
function startCountdownCamera(variant, randomWords, focus) {
  if (![0, 1].includes(variant) || !validateRandomWords(randomWords, 3) || !isVector(focus)) {
    throw new TypeError('Countdown camera needs its variant, three random words and current focus point');
  }
  const [origin, side, speed] = randomWords;
  const initialX = f32(f32(origin * unitScale) * f32(variant ? .3 : -.3));
  const reverse = f32(side * unitScale) <= .5;
  const eyeZ = f32(reverse ? .47 : -.35);
  const targetZ = f32(reverse ? -.17 : .09);
  const increment = f32(f32(speed * unitScale) * f32(variant ? -.0005 : .0005) +
    f32(variant ? -.001 : .001));
  return advanceCountdownCamera({
    eye: [initialX, 0, 0], target: [initialX, 0, 0],
    eyeOffset: [increment, f32(.091), eyeZ],
    targetOffset: [increment, f32(.05), targetZ],
  }, focus, 1);
}

function advanceCountdownCamera(state, focus, scale) {
  if (!isVector(focus) || ![1, 2, 4].includes(scale) ||
      ![state.eye, state.target, state.eyeOffset, state.targetOffset].every(isVector)) {
    throw new TypeError('Countdown camera needs its native pose, focus point and timing scale');
  }
  // Patched +0x1790C/+0x17950 scale the X increments at 60/120 Hz.
  // The other components are reapplied to the new focus instead of accumulated.
  const [x, y, z] = state.eyeOffset;
  const [tx, ty, tz] = state.targetOffset;
  return {
    ...state, fov: 0x11c7,
    eye: add([state.eye[0], focus[1], focus[2]], [f32(x / scale), y, z]),
    target: add([state.target[0], focus[1], focus[2]], [f32(tx / scale), ty, tz]),
  };
}

// PRX +0x163D0 initializes the side-tracking shot with two world focus
// points and six low-16 RNG results already consumed by the cue.
function startSideTrackingCamera(variant, leaderSlot, randomWords, eyeFocus, targetFocus) {
  if (![0, 1].includes(variant) || ![0, 1, 2, 3, 4].includes(leaderSlot) ||
      !validateRandomWords(randomWords, 6) || ![eyeFocus, targetFocus].every(isVector)) {
    throw new TypeError('Side tracking camera needs its variant, leader, six random words and both focus points');
  }
  const onRight = variant === 0 ? leaderSlot !== 4 : leaderSlot === 0;
  const lateral = word => f32(f32(word * unitScale - .5) * f32(.0001));
  const [eyeX, eyeY, eyeZ, targetX, targetY, targetZ] = randomWords;
  return {
    fov: 0x1c71,
    eye: add(eyeFocus, [f32(onRight ? .63 : -.63), f32(.31), f32(-.35)]),
    target: targetFocus.slice(),
    eyeOffset: [lateral(eyeX), lateral(eyeY), f32(f32(eyeZ * unitScale) * f32(-.001))],
    targetOffset: [lateral(targetX), lateral(targetY), f32(f32(targetZ * unitScale) * f32(-.0025) - f32(.0025))],
  };
}

function advanceSideTrackingCamera(state, targetFocus, scale) {
  if (!isVector(targetFocus) || ![1, 2, 4].includes(scale) ||
      ![state.eye, state.target, state.eyeOffset, state.targetOffset].every(isVector)) {
    throw new TypeError('Side tracking camera needs its native pose, focus point and timing scale');
  }
  // The FPS patch scales drift at +0x164E0/+0x16504 and roots the
  // retention at +0x1651C. The target's Z drift also accounts for the
  // blend applied immediately after the offset is added.
  const eye = add(state.eye, state.eyeOffset.map(value => f32(value / scale)));
  const gain = f32(.05);
  const retention = timingRetention(gain, scale);
  const blend = scale === 1 ? gain : f32(1 - retention);
  const zFactor = scale === 1 ? 1 : (1 - gain) * (1 - retention) / (retention * gain);
  const [x, y, z] = state.targetOffset;
  const target = add(state.target, [f32(x / scale), f32(y / scale), f32(z * zFactor)]);
  target[2] = f32(f32(targetFocus[2] - target[2]) * blend + target[2]);
  return { ...state, eye, target };
}

function orbitEye(state, timingTick, scale) {
  // PRX +0x17F98 uses the timing manager's gated +0x10 counter.
  // The high-frame-rate patch divides its signed angular step by 2 or 4.
  const increment = state.variant === 0 ? 32 : -32;
  const { sin, cos } = yawSinCos(Math.imul(timingTick, increment / scale));
  return add(state.target, [
    f32(f32(sin * .75) * state.eyeOffset[0]),
    state.eyeOffset[1],
    f32(f32(cos * .75) * state.eyeOffset[2]),
  ]);
}

// PRX +0x17EF0 uses the race's most recent raw distance increment for
// the current leader to initialize the camera's target lead.
function startOrbitCamera(variant, leaderDelta, focus, timingTick, scale) {
  if (![0, 1].includes(variant) || !Number.isFinite(leaderDelta)) {
    throw new TypeError('Orbit camera needs a native cue variant and leader delta');
  }
  if (!isVector(focus) || !Number.isInteger(timingTick) || ![1, 2, 4].includes(scale)) {
    throw new TypeError('Orbit camera needs a focus, timing tick and timing scale');
  }
  const targetOffset = [0, 0, -f32(leaderDelta * f32(.15))];
  const state = {
    fov: 0x2aaa,
    variant,
    target: add(focus, targetOffset),
    eyeOffset: [f32(.6), f32(.5), f32(.6)],
    targetOffset,
  };
  // The initializer adds the target offset before falling through with
  // that already-offset focus. Initialization retains the stock blend.
  return blendOrbitTarget(state, state.target, timingTick, scale, f32(.05));
}

function blendOrbitTarget(state, focus, timingTick, scale, blend) {
  const difference = subtract(add(focus, state.targetOffset), state.target);
  const target = add(state.target, difference.map(value => f32(value * blend)));
  const next = { ...state, target };
  return { ...next, eye: orbitEye(next, timingTick, scale) };
}

function advanceOrbitCamera(state, focus, timingTick, scale) {
  if (!isVector(focus) || !Number.isInteger(timingTick) || ![1, 2, 4].includes(scale) ||
      ![state.target, state.eyeOffset, state.targetOffset].every(isVector)) {
    throw new TypeError('Orbit camera needs a native pose, focus, timing tick and timing scale');
  }
  const gain = f32(.05);
  const blend = scale === 1 ? gain : f32(1 - timingRetention(gain, scale));
  return blendOrbitTarget(state, focus, timingTick, scale, blend);
}

function lateralFocus(focus) {
  return [focus[0], focus[1], f32(focus[2] - f32(.15))];
}

// PRX +0x168F8 starts the camera beside its target, then follows the focus
// with independently smoothed eye and target positions.
function startLateralCamera(variant, leaderSlot, focus) {
  if (![0, 1].includes(variant) || ![0, 1, 2, 3, 4].includes(leaderSlot) || !isVector(focus)) {
    throw new TypeError('Lateral camera needs a native cue variant, leader and focus');
  }
  const onRight = variant === 0 ? leaderSlot !== 4 : leaderSlot === 0;
  const origin = lateralFocus(focus);
  const eyeOffset = [onRight ? .75 : -.75, f32(.42), 0];
  const targetOffset = [0, f32(-.02), 0];
  return { fov: 0x1c71, eyeOffset, targetOffset, eye: add(origin, eyeOffset), target: add(origin, targetOffset) };
}

function advanceLateralCamera(state, focus, scale) {
  if (!isVector(focus) || ![1, 2, 4].includes(scale) ||
      ![state.eye, state.target, state.eyeOffset, state.targetOffset].every(isVector)) {
    throw new TypeError('Lateral camera needs its native pose, focus point and timing scale');
  }
  const origin = lateralFocus(focus);
  const gain = f32(.05);
  const blend = scale === 1 ? gain : f32(1 - timingRetention(gain, scale));
  const follow = (point, offset) => add(point, subtract(add(origin, offset), point).map(value => f32(value * blend)));
  return { ...state, eye: follow(state.eye, state.eyeOffset), target: follow(state.target, state.targetOffset) };
}

// PRX +0x16D64 initializes a rear pan. A focus of -1 is resolved by
// the scene selector to the last-ranked turtle before this call.
function startRearPanCamera(randomWords, focus) {
  if (!validateRandomWords(randomWords, 3) || !isVector(focus)) {
    throw new TypeError('Rear pan needs three native random words and a focus point');
  }
  const [vertical, eyeZ, targetZ] = randomWords;
  const unit = word => f32(word * unitScale);
  return {
    fov: 0x1c71,
    eye: add(focus, [0, f32(.65), f32(.85)]),
    target: focus.slice(),
    eyeOffset: [0, f32(unit(vertical) * f32(-.00125) - f32(.00125)), f32(unit(eyeZ) * f32(-.001))],
    targetOffset: [0, 0, f32(unit(targetZ) * f32(-.0025) - f32(.0025))],
    thresholdRemaining: 0,
  };
}

function advanceRearPanCamera(state, scale) {
  if (![1, 2, 4].includes(scale) ||
      ![state.eye, state.target, state.eyeOffset, state.targetOffset].every(isVector)) {
    throw new TypeError('Rear pan needs its native pose and timing scale');
  }
  // The patch holds the vertical threshold decision across a native tick.
  const thresholdRemaining = state.thresholdRemaining ?? 0;
  const belowThreshold = thresholdRemaining > 0 ? state.belowThreshold : state.eye[1] < f32(.4);
  const gain = f32(.05);
  const retention = timingRetention(gain, scale);
  const blend = scale === 1 ? gain : f32(1 - retention);
  const eyeOffset = state.eyeOffset.slice();
  if (belowThreshold) eyeOffset[1] = f32(f32(-eyeOffset[1]) * blend + eyeOffset[1]);
  const verticalFactor = scale === 1 ? 1 : belowThreshold
    ? (1 - gain) * (1 - retention) / (retention * gain) : 1 / scale;
  return {
    ...state, eyeOffset, belowThreshold,
    thresholdRemaining: thresholdRemaining > 0 ? thresholdRemaining - 1 : scale - 1,
    eye: add(state.eye, [f32(eyeOffset[0] / scale), f32(eyeOffset[1] * verticalFactor), f32(eyeOffset[2] / scale)]),
    target: add(state.target, state.targetOffset.map(value => f32(value / scale))),
  };
}

// PRX +0x157B4 follows the turtle shown in the sleep commentary shot.
function startSleepCamera(variant, focus) {
  if (![0, 1].includes(variant) || !isVector(focus)) {
    throw new TypeError('Sleep camera needs a native cue variant and focus');
  }
  const eyeOffset = [f32(variant ? .075 : -.075), f32(.10), f32(.31)];
  const target = add(focus, [0, f32(.04), 0]);
  return { fov: 0x1555, eyeOffset, target, eye: add(target, eyeOffset) };
}

function advanceSleepCamera(state, focus, scale) {
  if (!isVector(focus) || !isVector(state.target) || ![1, 2, 4].includes(scale)) {
    throw new TypeError('Sleep camera needs its native target, focus and timing scale');
  }
  const desired = add(focus, [0, f32(.04), 0]);
  const gain = f32(.10);
  const blend = scale === 1 ? gain : f32(1 - timingRetention(gain, scale));
  const target = add(state.target, subtract(desired, state.target).map(value => f32(value * blend)));
  return { ...state, target, eye: add(target, state.eyeOffset) };
}

// PRX +0x17B08 initializes a closer orbit around one ranked turtle.
// The FPS patch scales the initial angle, then advances it one unit per update.
function startCloseOrbitCamera(variant, nearRank, leaderDelta, randomWord, focus, scale) {
  if (![0, 1].includes(variant) || !Number.isInteger(nearRank) || nearRank < 0 || nearRank > 5 ||
      !Number.isFinite(leaderDelta) || !validateRandomWords([randomWord], 1) ||
      !isVector(focus) || ![1, 2, 4].includes(scale)) {
    throw new TypeError('Close orbit camera needs its variant, target rank, leader delta, random word and focus');
  }
  const targetOffset = [0, 0, -f32(leaderDelta * f32(.15))];
  const baseAngle = nearRank <= 1 ? 0 : nearRank === 2 ? 0x200 : 0x400;
  const angle = (baseAngle + ((randomWord >>> 7) & 0xff) - 128) * scale;
  const target = add(focus, [0, 0, targetOffset[2]]);
  target[2] = f32(target[2] - f32(.05));
  return closeOrbitTarget({
    variant, scale, angle, target, targetOffset, eyeOffset: [.5, .25, .5], fov: 0x238e,
  }, focus, true);
}

function closeOrbitTarget(state, focus, initializing) {
  const { scale, targetOffset, eyeOffset, variant } = state;
  const { sin, cos } = yawSinCos(state.angle * 32 / scale);
  const desired = add(focus, targetOffset);
  desired[2] = f32(desired[2] - f32(.05));
  const gain = f32(.05);
  const blend = initializing || scale === 1 ? gain : f32(1 - timingRetention(gain, scale));
  const difference = subtract(desired, state.target);
  const target = add(state.target, difference.map(value => f32(value * blend)));
  const eye = add(target, [
    f32(f32(cos * .75) * eyeOffset[0]),
    eyeOffset[1],
    f32(f32(sin * .75) * eyeOffset[2]),
  ]);
  return { ...state, eye, target, angle: state.angle + (initializing ? scale : 1) * (variant ? 1 : -1) };
}

function advanceCloseOrbitCamera(state, focus) {
  if (!isVector(focus) || ![1, 2, 4].includes(state.scale) ||
      !Number.isSafeInteger(state.angle) || ![state.target, state.eyeOffset, state.targetOffset].every(isVector)) {
    throw new TypeError('Close orbit camera needs its native pose, angle and focus');
  }
  return closeOrbitTarget(state, focus, false);
}

// PRX +0x15E18 places the eye once relative to the focus. Three native
// random words select the end of the track and the pan on each axis.
function startFixedEyeCamera(variant, randomWords, focus) {
  if (![0, 1].includes(variant) || !validateRandomWords(randomWords, 3) || !isVector(focus)) {
    throw new TypeError('Fixed eye camera needs a cue variant, three random words and a focus');
  }
  const [side, x, z] = randomWords;
  const inFront = f32(side * unitScale) > .5;
  const eyeZ = f32(focus[2] + f32(inFront ? .87 : -.87));
  const jitter = word => f32(f32(word * unitScale - .5) * f32(.001));
  return {
    fov: 0x1c71,
    eye: [0, f32(.1), eyeZ],
    target: [f32(variant === 0 ? .43 : -.43), f32(.31), f32(eyeZ + f32(inFront ? -.8 : .8))],
    eyeOffset: [0, 0, 0],
    targetOffset: [jitter(x), 0, jitter(z)],
  };
}

function advanceFixedEyeCamera(state, scale) {
  if (![1, 2, 4].includes(scale) || ![state.target, state.targetOffset].every(isVector)) {
    throw new TypeError('Fixed eye camera needs its native pose and timing scale');
  }
  return { ...state, target: add(state.target, state.targetOffset.map(value => f32(value / scale))) };
}

// PRX +0x184B4 places the camera beyond the course and pans it while
// following the selected turtle. The three words are from the cue's RNG.
function startFinishApproachCamera(variant, sections, randomWords, focus) {
  if (![0, 1].includes(variant) || !validSectionCount(sections) ||
      !validateRandomWords(randomWords, 3) || !isVector(focus)) {
    throw new TypeError('Finish approach camera needs a cue variant, course length, three random words and focus');
  }
  const lateral = word => f32(f32(word * unitScale - .5) * f32(.0001));
  const [x, y, z] = randomWords;
  const eyeOffset = [lateral(x), lateral(y), f32(f32(z * unitScale) * f32(-.001) - f32(.001))];
  const origin = [f32(variant ? -.34 : .34), f32(.3), f32(-sections - f32(.6))];
  return { fov: 0x1c71, eye: add(origin, eyeOffset), target: focus.slice(), eyeOffset, targetOffset: [0, 0, 0] };
}

function advanceFinishApproachCamera(state, focus, scale) {
  if (!isVector(focus) || ![1, 2, 4].includes(scale) ||
      ![state.eye, state.target, state.eyeOffset].every(isVector)) {
    throw new TypeError('Finish approach camera needs its native pose, focus point and timing scale');
  }
  const gain = f32(.05);
  const blend = scale === 1 ? gain : f32(1 - timingRetention(gain, scale));
  const target = add(state.target, subtract(focus, state.target).map(value => f32(value * blend)));
  const eye = add(state.eye, state.eyeOffset.map(value => f32(value / scale)));
  return { ...state, eye, target };
}

function validSectionCount(sections) {
  return Number.isInteger(sections) && sections >= 3 && sections <= 7;
}

function finishLineTarget(focus, previousTarget, sections) {
  const depth = -focus[2];
  const nearLine = f32(sections - .25);
  if (depth <= nearLine) return focus.slice();
  // +0x18CC8 slows the pan within a quarter unit of the finish.
  const factor = Math.min(1, f32(f32(depth - nearLine) / f32(.3)));
  const z = previousTarget[2];
  const blended = f32(f32(1 - factor) * f32(depth + z) - z);
  return [focus[0], focus[1], -Math.min(sections, blended)];
}

// PRX +0x188AC fixes the eye at the finish and follows the selected turtle.
function startFinishLineCamera(variant, leaderSlot, sections, focus, previousTarget) {
  if (![0, 1].includes(variant) || ![0, 1, 2, 3, 4].includes(leaderSlot) ||
      !validSectionCount(sections) || !isVector(focus) || !isVector(previousTarget)) {
    throw new TypeError('Finish line camera needs a native cue variant, leader, course length and focus');
  }
  const onRight = variant === 0 ? leaderSlot !== 4 : leaderSlot === 0;
  return {
    fov: 0x1c71, sections, eye: [f32(onRight ? .69 : -.69), f32(.42), -sections],
    target: finishLineTarget(focus, previousTarget, sections),
  };
}

function advanceFinishLineCamera(state, focus, scale) {
  if (!isVector(focus) || !isVector(state.target) || !validSectionCount(state.sections) ||
      ![1, 2, 4].includes(scale)) {
    throw new TypeError('Finish line camera needs its native pose, focus point and timing scale');
  }
  const desired = finishLineTarget(focus, state.target, state.sections);
  const gain = f32(.1);
  const blend = scale === 1 ? gain : f32(1 - timingRetention(gain, scale));
  return { ...state, target: add(state.target, subtract(desired, state.target).map(value => f32(value * blend))) };
}

// PRX +0x16B94 aims down the track from behind the finish line.
function startEndCamera(sections, focus) {
  if (!validSectionCount(sections) || !isVector(focus)) {
    throw new TypeError('End camera needs the course length and focus');
  }
  return { fov: 0x1c71, eye: [0, .25, f32(-sections - f32(1.1))], target: add(focus, [0, .25, 0]) };
}

function advanceEndCamera(state, focus, scale) {
  if (!isVector(focus) || !isVector(state.target) || ![1, 2, 4].includes(scale)) {
    throw new TypeError('End camera needs its native pose, focus point and timing scale');
  }
  const desired = add(focus, [0, .25, 0]);
  const gain = f32(.05);
  const blend = scale === 1 ? gain : f32(1 - timingRetention(gain, scale));
  return { ...state, target: add(state.target, subtract(desired, state.target).map(value => f32(value * blend))) };
}

module.exports = {
  advanceEndCamera, advanceFinishLineCamera, startEndCamera, startFinishLineCamera,
  advanceFinishApproachCamera, advanceFixedEyeCamera, startFinishApproachCamera, startFixedEyeCamera,
  advanceCloseOrbitCamera, advanceCountdownCamera, advanceLateralCamera, advanceOrbitCamera, advanceSideTrackingCamera,
  advanceSleepCamera, startSleepCamera, advanceRearPanCamera, startRearPanCamera,
  startCloseOrbitCamera, startCountdownCamera, startLateralCamera, startOrbitCamera, startSideTrackingCamera,
  viewFromCameraPose,
};

},
(module, load) => {
'use strict';

const f32 = Math.fround;
const radiansPerTurnUnit = 2 * Math.PI / 65536;

function normal(tangent) {
  const lengthSquared = f32(1 + f32(tangent * tangent));
  const inverseLength = f32(1 / Math.sqrt(lengthSquared));
  return [inverseLength, f32(tangent * inverseLength)];
}

function cameraFrustum({ fov, aspect, near, far }) {
  if (!Number.isInteger(fov) || fov < 2 || fov >= 32768 ||
      ![aspect, near, far].every(Number.isFinite) || aspect <= 0 || near <= 0 || far <= near) {
    throw new RangeError('A race camera needs a fixed-turn FOV and a valid aspect and depth range');
  }
  // EBOOT +0x583A8 halves the fixed-turn FOV before the tangent lookup.
  // The VMX routine normalizes the plane using a reciprocal-square-root estimate
  // and a refinement, so the last bit may differ across arithmetic backends.
  const tangent = f32(Math.tan((fov >> 1) * radiansPerTurnUnit));
  const [horizontal, horizontalDepth] = normal(f32(tangent * f32(aspect)));
  const [vertical, verticalDepth] = normal(tangent);
  return {
    near: Array(4).fill(f32(-near)),
    far: Array(4).fill(f32(-far)),
    side: [
      [horizontal, -horizontal, 0, 0],
      [0, 0, -vertical, vertical],
      [horizontalDepth, horizontalDepth, verticalDepth, verticalDepth],
    ],
  };
}

module.exports = { cameraFrustum };

}];
  const cache = [];
  function load(id) {
    if (cache[id]) return cache[id].exports;
    const module = cache[id] = { exports: {} };
    modules[id](module, load);
    return module.exports;
  }
  return load(0);
})();
const { runSceneTrial } = turtleRaceScenes;

self.addEventListener('message', event => {
  const { start, end, eventId, player, sections, fps, staminaMode } = event.data ?? {};
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || end < start) {
    self.postMessage({ error: 'invalid-trial-range' });
    return;
  }
  try {
    const counts = { wins: 0, finished: 0, noStart: 0, unavailable: 0 };
    for (let index = start; index < end; index++) {
      const trial = runSceneTrial({ eventId, player, sections, fps, staminaMode, index });
      if (trial.status === 'finished') {
        counts.finished++;
        if (trial.results[0]?.slot === 0) counts.wins++;
      } else if (trial.status === 'no-start') {
        counts.noStart++;
      } else {
        counts.unavailable++;
      }
    }
    self.postMessage(counts);
  } catch (error) {
    console.error(error);
    self.postMessage({ error: 'trial-failed' });
  }
});

self.postMessage({ workerReady: true });

  }
  if (typeof document === 'undefined') startTurtleRaceWorker();
  else document.currentScript.turtleRaceWorkerSource = '(' + startTurtleRaceWorker.toString() + ')();';
})();
