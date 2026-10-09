'use strict';

const path = require('path');
const { AssetExporter } = require('../lib/asset-exporter');

async function main() {
    const spinePath = path.resolve(__dirname, '../../../assets/game/$shared/_$shared/spine/main/Main.json');
    const outDir = path.resolve(__dirname, '../../../assets/FastSpine');
    console.log('Baking Main to:', outDir);
    const res = await AssetExporter.bakeSpineAsset(spinePath, {
        outputDir: outDir,
        fps: 30,
        createPrefab: true,
    });
    console.log('Done! Prefab:', res.prefabPath);
}

main().catch(console.error);
