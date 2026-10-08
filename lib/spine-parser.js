'use strict';

const fs = require('fs');
const path = require('path');

class AtlasPage {
    constructor(name) {
        this.name = name;
        this.width = 0;
        this.height = 0;
        this.format = 'RGBA8888';
        this.minFilter = 'linear';
        this.magFilter = 'linear';
        this.uWrap = 'clamp-to-edge';
        this.vWrap = 'clamp-to-edge';
        this.regions = new Map();
    }
}

class AtlasRegion {
    constructor(page, name) {
        this.page = page;
        this.name = name;
        this.x = 0;
        this.y = 0;
        this.width = 0;
        this.height = 0;
        this.u = 0;
        this.v = 0;
        this.u2 = 0;
        this.v2 = 0;
        this.offsetX = 0;
        this.offsetY = 0;
        this.originalWidth = 0;
        this.originalHeight = 0;
        this.rotate = false;
        this.degrees = 0;
        this.index = -1;
    }
}

class TextureAtlas {
    constructor(atlasText) {
        this.pages = [];
        this.regions = new Map();
        if (atlasText) {
            this.parse(atlasText);
        }
    }

    parse(text) {
        const lines = text.split(/\r?\n/);
        let currentPage = null;
        let currentRegion = null;

        for (let i = 0; i < lines.length; i++) {
            const rawLine = lines[i];
            const line = rawLine.trim();
            if (line.length === 0) {
                currentPage = null;
                currentRegion = null;
                continue;
            }

            if (!currentPage) {
                currentPage = new AtlasPage(line);
                this.pages.push(currentPage);
                // Read page properties
                while (i + 1 < lines.length) {
                    const nextLine = lines[i + 1].trim();
                    if (!nextLine || nextLine.indexOf(':') === -1) break;
                    i++;
                    const colonIdx = nextLine.indexOf(':');
                    const key = nextLine.substring(0, colonIdx).trim().toLowerCase();
                    const val = nextLine.substring(colonIdx + 1).trim();

                    if (key === 'size') {
                        const parts = val.split(',');
                        currentPage.width = parseInt(parts[0].trim(), 10) || 0;
                        currentPage.height = parseInt(parts[1].trim(), 10) || 0;
                    } else if (key === 'format') {
                        currentPage.format = val;
                    } else if (key === 'filter') {
                        const parts = val.split(',');
                        currentPage.minFilter = parts[0].trim();
                        currentPage.magFilter = (parts[1] || parts[0]).trim();
                    } else if (key === 'repeat') {
                        if (val === 'x') currentPage.uWrap = 'repeat';
                        else if (val === 'y') currentPage.vWrap = 'repeat';
                        else if (val === 'xy') {
                            currentPage.uWrap = 'repeat';
                            currentPage.vWrap = 'repeat';
                        }
                    }
                }
                continue;
            }

            // Region entry
            if (line.indexOf(':') === -1) {
                currentRegion = new AtlasRegion(currentPage, line);
                currentPage.regions.set(line, currentRegion);
                this.regions.set(line, currentRegion);
            } else if (currentRegion) {
                const colonIdx = line.indexOf(':');
                const key = line.substring(0, colonIdx).trim().toLowerCase();
                const val = line.substring(colonIdx + 1).trim();

                if (key === 'rotate') {
                    if (val === 'true') {
                        currentRegion.rotate = true;
                        currentRegion.degrees = 90;
                    } else if (val === 'false') {
                        currentRegion.rotate = false;
                        currentRegion.degrees = 0;
                    } else {
                        currentRegion.degrees = parseInt(val, 10) || 0;
                        currentRegion.rotate = currentRegion.degrees !== 0;
                    }
                } else if (key === 'xy') {
                    const parts = val.split(',');
                    currentRegion.x = parseInt(parts[0].trim(), 10) || 0;
                    currentRegion.y = parseInt(parts[1].trim(), 10) || 0;
                } else if (key === 'size') {
                    const parts = val.split(',');
                    currentRegion.width = parseInt(parts[0].trim(), 10) || 0;
                    currentRegion.height = parseInt(parts[1].trim(), 10) || 0;
                } else if (key === 'orig') {
                    const parts = val.split(',');
                    currentRegion.originalWidth = parseInt(parts[0].trim(), 10) || 0;
                    currentRegion.originalHeight = parseInt(parts[1].trim(), 10) || 0;
                } else if (key === 'offset') {
                    const parts = val.split(',');
                    currentRegion.offsetX = parseInt(parts[0].trim(), 10) || 0;
                    currentRegion.offsetY = parseInt(parts[1].trim(), 10) || 0;
                } else if (key === 'index') {
                    currentRegion.index = parseInt(val, 10) || -1;
                }
            }
        }

        // Compute UVs for each region
        for (const page of this.pages) {
            const pw = page.width || 1;
            const ph = page.height || 1;
            for (const region of page.regions.values()) {
                region.u = region.x / pw;
                region.v = region.y / ph;
                if (region.rotate) {
                    region.u2 = (region.x + region.height) / pw;
                    region.v2 = (region.y + region.width) / ph;
                } else {
                    region.u2 = (region.x + region.width) / pw;
                    region.v2 = (region.y + region.height) / ph;
                }
            }
        }
    }

    findRegion(name) {
        return this.regions.get(name) || null;
    }
}

class SpineParser {
    /**
     * Parse Spine JSON string or object
     * @param {string|Object} jsonInput
     * @returns {Object}
     */
    static parseSkeleton(jsonInput) {
        const data = typeof jsonInput === 'string' ? JSON.parse(jsonInput) : jsonInput;
        if (!data || !data.bones) {
            throw new Error('Invalid Spine skeleton: missing bones definition');
        }
        return data;
    }

    /**
     * Parse Texture Atlas text
     * @param {string} atlasText
     * @returns {TextureAtlas}
     */
    static parseAtlas(atlasText) {
        return new TextureAtlas(atlasText);
    }

    /**
     * Load spine skeleton and matching atlas from a directory or file path
     * @param {string} spineJsonPath
     * @returns {{ skeleton: Object, atlas: TextureAtlas, atlasPath: string }}
     */
    static loadFromFile(spineJsonPath) {
        const jsonContent = fs.readFileSync(spineJsonPath, 'utf8');
        const skeleton = this.parseSkeleton(jsonContent);

        const dir = path.dirname(spineJsonPath);
        const baseName = path.basename(spineJsonPath, path.extname(spineJsonPath));

        // Candidates for atlas file
        const candidates = [
            path.join(dir, `${baseName}.atlas`),
            path.join(dir, `${baseName}.atlas.txt`),
            path.join(dir, `${baseName}.txt`),
        ];

        let atlasPath = null;
        for (const cand of candidates) {
            if (fs.existsSync(cand)) {
                atlasPath = cand;
                break;
            }
        }

        // If not found by basename, search for any .atlas or .atlas.txt in dir
        if (!atlasPath) {
            const files = fs.readdirSync(dir);
            for (const f of files) {
                if (f.endsWith('.atlas') || f.endsWith('.atlas.txt')) {
                    atlasPath = path.join(dir, f);
                    break;
                }
            }
        }

        let atlas = null;
        if (atlasPath && fs.existsSync(atlasPath)) {
            const atlasText = fs.readFileSync(atlasPath, 'utf8');
            atlas = this.parseAtlas(atlasText);
        }

        return { skeleton, atlas, atlasPath };
    }
}

module.exports = {
    SpineParser,
    TextureAtlas,
    AtlasPage,
    AtlasRegion,
};
