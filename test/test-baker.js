'use strict';

const path = require('path');
const fs = require('fs');
const { SpineParser } = require('../lib/spine-parser');
const { SpineBaker } = require('../lib/spine-baker');
const { FastSpineBinary } = require('../lib/fastspine-binary');
const { AssetExporter } = require('../lib/asset-exporter');

async function runTest() {
    console.log('=== Test FastSpine Baker Engine ===\n');

    // 1. Scan for spines in assets
    const assetsDir = path.resolve(__dirname, '../../../assets');
    console.log(`Scanning Spine assets in ${assetsDir}...`);
    const found = AssetExporter.scanProjectSpines(assetsDir);
    console.log(`Found ${found.length} Spine skeletons in project.`);
    for (const f of found.slice(0, 5)) {
        console.log(` - ${f.name} (hasAtlas: ${f.hasAtlas}, animations: ${f.animationsCount}, skins: ${f.skinsCount})`);
    }

    // 2. Test baking on daughter skeleton
    const targetSpine = path.resolve(__dirname, '../../../assets/game/decorator/level_1/spines/daughter/skeleton.json');
    if (!fs.existsSync(targetSpine)) {
        console.error('Target spine not found:', targetSpine);
        process.exit(1);
    }

    console.log(`\nBaking target Spine: ${targetSpine}`);
    const outDir = path.resolve(__dirname, 'output');
    if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });

    const result = await AssetExporter.bakeSpineAsset(targetSpine, {
        outputDir: outDir,
        fps: 30,
        createPrefab: true,
    });

    console.log('\nBake completed successfully!');
    console.log('Output bin:', result.binPath, `(${fs.statSync(result.binPath).size} bytes)`);
    console.log('Output json:', result.jsonPath);
    console.log('Output prefab:', result.prefabPath);
    console.log('\nMetadata summary:');
    console.log(` - Total frames: ${result.metadata.totalFrames}`);
    console.log(` - Vertex count per frame: ${result.metadata.vertexCountPerFrame}`);
    console.log(` - Index count: ${result.metadata.indexCount}`);
    console.log(` - Animations:`, result.metadata.animations.map(a => `${a.name} (${a.frameCount} frames, ${a.duration.toFixed(2)}s)`));

    // Test complex skeleton if available
    const mainSpine = path.resolve(__dirname, '../../../assets/game/$shared/_$shared/spine/main/Main.json');
    if (fs.existsSync(mainSpine)) {
        console.log(`\nBaking complex Spine: ${mainSpine}`);
        const complexRes = await AssetExporter.bakeSpineAsset(mainSpine, {
            outputDir: outDir,
            fps: 30,
            createPrefab: true,
        });
        console.log(`Complex Spine bake OK! Frames: ${complexRes.metadata.totalFrames}, VC: ${complexRes.metadata.vertexCountPerFrame}, Indices: ${complexRes.metadata.indexCount}`);
        console.log(`Animations:`, complexRes.metadata.animations.map(a => `${a.name} (${a.frameCount} frames)`));
    }

    // 3. Test decoding binary back
    console.log('\nVerifying binary decoder...');
    const binData = fs.readFileSync(result.binPath);
    const decoded = FastSpineBinary.decode(binData);
    console.log(`Decoded magic check: OK, version: ${decoded.version.toString(16)}, frames: ${decoded.frameCount}, vc: ${decoded.vertexCountPerFrame}`);
    if (decoded.frames.length === result.metadata.totalFrames) {
        console.log('Frame count matches 100%!');
    } else {
        throw new Error('Decoded frame count mismatch!');
    }

    console.log('\n[PASS] All Baker and Binary tests passed successfully!\n');
}

runTest().catch(err => {
    console.error('[FAIL]', err);
    process.exit(1);
});
