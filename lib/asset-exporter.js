'use strict';

const fs = require('fs');
const path = require('path');
const { SpineParser } = require('./spine-parser');
const { SpineBaker } = require('./spine-baker');

class AssetExporter {
    /**
     * Bake a single Spine asset from file path
     * @param {string} spineJsonPath
     * @param {Object} options
     * @param {string} [options.outputDir] - defaults to same directory as spineJsonPath
     * @param {number} [options.fps=30]
     * @param {string} [options.skin='default']
     * @param {boolean} [options.createPrefab=true]
     * @returns {Promise<{ binPath: string, jsonPath: string, metadata: Object }>}
     */
    static async bakeSpineAsset(spineJsonPath, options = {}) {
        if (!fs.existsSync(spineJsonPath)) {
            throw new Error(`Spine asset file not found: ${spineJsonPath}`);
        }

        const { skeleton, atlas, atlasPath } = SpineParser.loadFromFile(spineJsonPath);
        const fps = options.fps || 30;
        const skin = options.skin || (skeleton.skins && (Array.isArray(skeleton.skins) ? skeleton.skins[0]?.name : Object.keys(skeleton.skins)[0])) || 'default';

        const baker = new SpineBaker(skeleton, atlas, { fps, skin, spineJsonPath, atlasPath });
        const result = await baker.bake();

        const baseDir = options.outputDir || path.dirname(spineJsonPath);
        if (!fs.existsSync(baseDir)) {
            fs.mkdirSync(baseDir, { recursive: true });
        }

        const baseName = path.basename(spineJsonPath, path.extname(spineJsonPath));
        const binFileName = `${baseName}.fastspine.bin`;
        const jsonFileName = `${baseName}.fastspine.json`;

        const binPath = path.join(baseDir, binFileName);
        const jsonPath = path.join(baseDir, jsonFileName);

        fs.writeFileSync(binPath, result.buffer);
        fs.writeFileSync(jsonPath, JSON.stringify(result.metadata, null, 2), 'utf8');

        // Immediately sync to editor library/ folder if meta already exists
        if (fs.existsSync(binPath + '.meta')) {
            try {
                const bm = JSON.parse(fs.readFileSync(binPath + '.meta', 'utf8'));
                if (bm.uuid) {
                    const prefix = bm.uuid.substring(0, 2);
                    const libTarget = path.join(process.cwd(), 'library', prefix, `${bm.uuid}.bin`);
                    if (fs.existsSync(path.dirname(libTarget))) {
                        fs.writeFileSync(libTarget, result.buffer);
                    }
                }
            } catch (e) {}
        }

        // Optional prefab generation
        let prefabPath = null;
        if (options.createPrefab) {
            prefabPath = path.join(baseDir, `${baseName}_fastspine.prefab`);

            // Try resolving texture UUID from atlas
            let texUuid = null;
            if (atlas && atlas.pages && atlas.pages.length > 0) {
                const pageName = atlas.pages[0].name;
                const srcDir = path.dirname(spineJsonPath);
                const pngMetaPath = path.join(srcDir, `${pageName}.meta`);
                if (fs.existsSync(pngMetaPath)) {
                    try {
                        const pm = JSON.parse(fs.readFileSync(pngMetaPath, 'utf8'));
                        if (pm.subMetas && pm.subMetas['6c48a']) {
                            texUuid = pm.subMetas['6c48a'].uuid || (pm.uuid + '@6c48a');
                        } else if (pm.uuid) {
                            texUuid = pm.uuid + '@6c48a';
                        }
                    } catch (e) {}
                }
            }

            // Try resolving bin/json UUIDs if metas already exist
            let binUuid = null;
            if (fs.existsSync(binPath + '.meta')) {
                try { binUuid = JSON.parse(fs.readFileSync(binPath + '.meta', 'utf8')).uuid; } catch (e) {}
            }
            let jsonUuid = null;
            if (fs.existsSync(jsonPath + '.meta')) {
                try { jsonUuid = JSON.parse(fs.readFileSync(jsonPath + '.meta', 'utf8')).uuid; } catch (e) {}
            }

            const width = skeleton.skeleton ? Math.ceil(skeleton.skeleton.width || 100) : 100;
            const height = skeleton.skeleton ? Math.ceil(skeleton.skeleton.height || 100) : 100;

            const prefabContent = this.generateFastSpinePrefab(baseName, result.metadata, {
                binUuid,
                jsonUuid,
                texUuid,
                width,
                height,
            });
            fs.writeFileSync(prefabPath, JSON.stringify(prefabContent, null, 2), 'utf8');
        }

        // Notify Cocos Editor AssetDB if in editor environment
        await this.refreshAssetDb(baseDir);

        return {
            binPath,
            jsonPath,
            prefabPath,
            metadata: result.metadata,
        };
    }

    /**
     * Generate Cocos Creator 3.8 .prefab structure for FastSpine
     */
    static generateFastSpinePrefab(name, metadata, extra = {}) {
        const animNames = metadata.animations ? metadata.animations.map(a => a.name) : [];
        const defaultAnim = animNames.length > 0 ? animNames[0] : 'default';
        const width = extra.width || 100;
        const height = extra.height || 100;
        const binUuid = extra.binUuid || null;
        const jsonUuid = extra.jsonUuid || null;
        const texUuid = extra.texUuid || null;

        const FAST_SPINE_CID = 'aa451f3U6pCh5/UMfb5syfK';

        return [
            {
                "__type__": "cc.Prefab",
                "_name": `${name}_fastspine`,
                "_objFlags": 0,
                "__editorExtras__": {},
                "_native": "",
                "data": {
                    "__id__": 1
                },
                "optimizationPolicy": 0,
                "persistent": false
            },
            {
                "__type__": "cc.Node",
                "_name": name,
                "_objFlags": 0,
                "__editorExtras__": {},
                "_parent": null,
                "_children": [],
                "_active": true,
                "_components": [
                    {
                        "__id__": 2
                    },
                    {
                        "__id__": 4
                    }
                ],
                "_prefab": {
                    "__id__": 6
                },
                "_lpos": {
                    "__type__": "cc.Vec3",
                    "x": 0,
                    "y": 0,
                    "z": 0
                },
                "_lrot": {
                    "__type__": "cc.Quat",
                    "x": 0,
                    "y": 0,
                    "z": 0,
                    "w": 1
                },
                "_lscale": {
                    "__type__": "cc.Vec3",
                    "x": 1,
                    "y": 1,
                    "z": 1
                },
                "_layer": 33554432
            },
            {
                "__type__": "cc.UITransform",
                "_name": "",
                "_objFlags": 0,
                "node": {
                    "__id__": 1
                },
                "_enabled": true,
                "__editorExtras__": {},
                "__prefab": {
                    "__id__": 3
                },
                "_contentSize": {
                    "__type__": "cc.Size",
                    "width": width,
                    "height": height
                },
                "_anchorPoint": {
                    "__type__": "cc.Vec2",
                    "x": 0.5,
                    "y": 0.5
                }
            },
            {
                "__type__": "cc.CompPrefabInfo",
                "fileId": "fastspine_uitransform"
            },
            {
                "__type__": FAST_SPINE_CID,
                "_name": "",
                "_objFlags": 0,
                "node": {
                    "__id__": 1
                },
                "_enabled": true,
                "__editorExtras__": {},
                "__prefab": {
                    "__id__": 5
                },
                "defaultAnimation": defaultAnim,
                "loop": true,
                "timeScale": 1,
                "interpolateFrames": true,
                "enableBatch": true,
                "_fastSpineData": binUuid ? { "__uuid__": binUuid } : null,
                "_texture": texUuid ? { "__uuid__": texUuid } : null,
                "fastSpineJson": jsonUuid ? { "__uuid__": jsonUuid } : null
            },
            {
                "__type__": "cc.CompPrefabInfo",
                "fileId": "fastspine_comp"
            },
            {
                "__type__": "cc.PrefabInfo",
                "root": {
                    "__id__": 1
                },
                "asset": {
                    "__id__": 0
                },
                "fileId": "fastspine_root",
                "instance": null,
                "targetOverrides": null,
                "nestedPrefabInstanceRoots": null
            }
        ];
    }

    /**
     * Refresh Cocos Creator AssetDB if Editor global is available
     */
    static async refreshAssetDb(folderPath) {
        if (typeof Editor !== 'undefined' && Editor.Message && Editor.Message.request) {
            try {
                // Convert absolute path to db:// url if inside project assets
                const projectPath = Editor.Project ? Editor.Project.path : '';
                const assetsDir = path.join(projectPath, 'assets');
                if (folderPath.startsWith(assetsDir)) {
                    const rel = path.relative(projectPath, folderPath).replace(/\\/g, '/');
                    const dbUrl = `db://${rel}`;
                    await Editor.Message.request('asset-db', 'refresh-asset', dbUrl);
                }
            } catch (err) {
                console.warn('[AssetExporter] Asset DB refresh warning:', err.message);
            }
        }
    }

    /**
     * Scan project assets for Spine files (.json containing skeleton or .skel)
     * @param {string} searchDir
     * @returns {Array<{ path: string, relativePath: string, name: string, hasAtlas: boolean, size: number }>}
     */
    static scanProjectSpines(searchDir) {
        const results = [];
        const scan = (dir) => {
            if (!fs.existsSync(dir)) return;
            const entries = fs.readdirSync(dir, { withFileTypes: true });
            for (const entry of entries) {
                const fullPath = path.join(dir, entry.name);
                if (entry.isDirectory()) {
                    if (entry.name !== 'node_modules' && entry.name !== '.git' && entry.name !== 'temp') {
                        scan(fullPath);
                    }
                } else if (entry.isFile() && entry.name.endsWith('.json')) {
                    // Check if Spine skeleton
                    try {
                        const content = fs.readFileSync(fullPath, 'utf8');
                        if (content.length > 20 && (content.includes('"skeleton"') || content.includes('"bones"'))) {
                            const parsed = JSON.parse(content);
                            if (parsed.skeleton && Array.isArray(parsed.bones)) {
                                const baseName = path.basename(entry.name, '.json');
                                const hasAtlas = fs.existsSync(path.join(dir, `${baseName}.atlas`)) ||
                                                fs.existsSync(path.join(dir, `${baseName}.atlas.txt`));
                                results.push({
                                    path: fullPath,
                                    name: baseName,
                                    hasAtlas,
                                    size: fs.statSync(fullPath).size,
                                    animationsCount: parsed.animations ? Object.keys(parsed.animations).length : 0,
                                    skinsCount: parsed.skins ? (Array.isArray(parsed.skins) ? parsed.skins.length : Object.keys(parsed.skins).length) : 1,
                                });
                            }
                        }
                    } catch (e) {
                        // Not a spine JSON
                    }
                }
            }
        };
        scan(searchDir);
        return results;
    }
}

module.exports = {
    AssetExporter,
};
