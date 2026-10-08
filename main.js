'use strict';

const path = require('path');
const { AssetExporter } = require('./lib/asset-exporter');

exports.methods = {
    openPanel() {
        Editor.Panel.open('pts-spine');
    },

    async scanSpines() {
        const projectPath = Editor.Project ? Editor.Project.path : process.cwd();
        const assetsDir = path.join(projectPath, 'assets');
        return AssetExporter.scanProjectSpines(assetsDir);
    },

    async bakeSpine(options) {
        if (!options || !options.path) {
            throw new Error('Missing spine asset path');
        }
        return await AssetExporter.bakeSpineAsset(options.path, {
            fps: options.fps || 30,
            skin: options.skin || 'default',
            outputDir: options.outputDir,
            createPrefab: options.createPrefab !== false,
        });
    },
};

exports.load = function () {
    console.log('[pts-spine] Fast Spine Optimizer loaded.');
};

exports.unload = function () {
    console.log('[pts-spine] Fast Spine Optimizer unloaded.');
};
