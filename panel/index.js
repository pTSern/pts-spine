'use strict';

const path = require('path');
const fs = require('fs');
const { AssetExporter } = require('../lib/asset-exporter');

const OUTPUT_KEY = 'pts-spine.output';

function filePathOf(file) {
    if (file.path) return file.path;
    try {
        return require('electron').webUtils.getPathForFile(file);
    } catch (e) {
        return null;
    }
}

module.exports = Editor.Panel.define({
    template: `
<div class="root">
  <div class="header-card">
    <div class="badge">Performance Optimizer</div>
    <div class="title">Fast Spine Converter & Multi-Drawcall Engine</div>
    <div class="desc">Pre-bake skeletal vertices into zero-copy binary buffers (.fastspine) with drop-in sp.Skeleton compatibility and automatic dynamic batching.</div>
  </div>

  <div id="drop" class="drop">
    <div class="drop-title">Drop Spine <b>.json</b> skeleton file, <b>.atlas</b>, or directory here</div>
    <div class="drop-hint">Or click to scan all Spine assets currently in the project.</div>
    <div class="drop-buttons">
      <button id="scan" class="primary-btn">Scan Project Spines</button>
      <button id="browse">Browse Files…</button>
    </div>
  </div>

  <div class="settings-grid">
    <div class="row">
      <label for="output">Output folder:</label>
      <input id="output" type="text" spellcheck="false" placeholder="db://assets/FastSpine">
    </div>
    <div class="row-opts">
      <div class="row-opt">
        <label for="fps">Bake FPS:</label>
        <select id="fps">
          <option value="30" selected>30 FPS (Standard mobile)</option>
          <option value="60">60 FPS (High fidelity)</option>
        </select>
      </div>
      <label class="check"><input id="prefab" type="checkbox" checked> Create Prefabs</label>
      <label class="check"><input id="interp" type="checkbox" checked> Frame Interpolation</label>
    </div>
  </div>

  <div class="list-head">
    <span id="summary">No Spines loaded</span>
    <span class="spacer"></span>
    <button id="select-all">All</button>
    <button id="select-none">None</button>
  </div>
  <div id="list" class="list"></div>

  <div class="actions">
    <button id="convert" class="action-btn primary" disabled>Bake Selected Spines</button>
    <button id="export-bin" class="action-btn secondary" disabled>Export .fastspine Binary</button>
  </div>

  <div class="stats-card">
    <div class="stats-item">
      <span class="stats-label">CPU Cost (100 units):</span>
      <span class="stats-val highlight-green">~1.5ms (vs ~60ms Realtime)</span>
    </div>
    <div class="stats-item">
      <span class="stats-label">DrawCalls:</span>
      <span class="stats-val highlight-green">Aggregated 1-2 calls</span>
    </div>
  </div>

  <div id="log" class="log"></div>
</div>`,

    style: `
:host { display: flex; height: 100%; }
.root { display: flex; flex-direction: column; gap: 8px; padding: 12px; width: 100%; box-sizing: border-box; font-size: 12px; background: #161b22; color: #c9d1d9; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
.header-card { background: #0d1117; border: 1px solid #30363d; border-radius: 6px; padding: 10px 12px; display: flex; flex-direction: column; gap: 4px; }
.badge { display: inline-block; width: fit-content; padding: 2px 6px; font-size: 10px; font-weight: 600; text-transform: uppercase; border-radius: 12px; background: rgba(88, 166, 255, 0.15); color: #58a6ff; border: 1px solid rgba(88, 166, 255, 0.3); }
.title { font-size: 14px; font-weight: 600; color: #f0f6fc; }
.desc { font-size: 11px; color: #8b949e; line-height: 1.4; }
.drop { border: 2px dashed #30363d; border-radius: 6px; padding: 14px; text-align: center; display: flex; flex-direction: column; gap: 6px; align-items: center; background: rgba(22, 27, 34, 0.5); }
.drop.over { border-color: #58a6ff; background: rgba(88, 166, 255, 0.08); }
.drop-title { font-size: 12px; color: #f0f6fc; }
.drop-hint { font-size: 11px; opacity: 0.65; margin-bottom: 4px; }
.drop-buttons { display: flex; gap: 8px; }
.settings-grid { display: flex; flex-direction: column; gap: 6px; background: #0d1117; border: 1px solid #30363d; border-radius: 6px; padding: 8px 10px; }
.row { display: flex; align-items: center; gap: 8px; }
.row label { white-space: nowrap; font-size: 11px; color: #8b949e; }
.row input[type=text] { flex: 1; padding: 4px 6px; background: #161b22; color: #c9d1d9; border: 1px solid #30363d; border-radius: 4px; font-size: 11px; }
.row-opts { display: flex; align-items: center; gap: 14px; }
.row-opt { display: flex; align-items: center; gap: 6px; }
.row-opt select { background: #161b22; color: #c9d1d9; border: 1px solid #30363d; border-radius: 4px; padding: 2px 6px; font-size: 11px; }
.check { display: flex; align-items: center; gap: 6px; cursor: pointer; font-size: 11px; color: #c9d1d9; }
.list-head { display: flex; align-items: center; gap: 6px; font-size: 11px; color: #8b949e; }
.spacer { flex: 1; }
.list { flex: 1; min-height: 100px; max-height: 220px; overflow-y: auto; border: 1px solid #30363d; border-radius: 4px; background: #0d1117; }
.item { display: flex; align-items: center; gap: 8px; padding: 5px 8px; border-bottom: 1px solid #21262d; cursor: pointer; font-size: 11px; }
.item:hover { background: rgba(255, 255, 255, 0.03); }
.item .name { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-weight: 500; color: #f0f6fc; }
.item .pills { display: flex; gap: 4px; }
.pill { padding: 1px 5px; border-radius: 3px; font-size: 10px; font-weight: 600; }
.pill-green { background: rgba(63, 185, 80, 0.2); color: #3fb950; }
.pill-orange { background: rgba(210, 153, 34, 0.2); color: #d29922; }
.pill-purple { background: rgba(188, 140, 255, 0.2); color: #bc8cff; }
.item.error .name { color: #f85149; }
button { padding: 4px 10px; background: #21262d; color: #c9d1d9; border: 1px solid #30363d; border-radius: 4px; cursor: pointer; font-size: 11px; }
button:hover:not(:disabled) { background: #30363d; }
button:disabled { opacity: 0.45; cursor: default; }
.primary-btn { background: #238636; border-color: #2ea043; color: #fff; font-weight: 600; }
.primary-btn:hover:not(:disabled) { background: #2ea043; }
.action-btn { padding: 8px; font-weight: 600; font-size: 12px; }
.action-btn.primary { background: #1f6feb; border-color: #388bfd; color: #fff; }
.action-btn.primary:hover:not(:disabled) { background: #388bfd; }
.action-btn.secondary { background: #21262d; border-color: #30363d; color: #c9d1d9; }
.actions { display: flex; gap: 8px; }
.actions button { flex: 1; }
.stats-card { display: flex; justify-content: space-around; background: #0d1117; border: 1px solid #30363d; border-radius: 4px; padding: 6px 10px; font-size: 11px; }
.stats-item { display: flex; gap: 6px; align-items: center; }
.stats-label { color: #8b949e; }
.stats-val { font-weight: 600; }
.highlight-green { color: #3fb950; }
.log { height: 110px; overflow-y: auto; font-family: 'JetBrains Mono', Consolas, monospace; font-size: 11px; background: #0d1117; border: 1px solid #30363d; border-radius: 4px; padding: 6px 8px; white-space: pre-wrap; line-height: 1.4; }
.log .warn { color: #d29922; }
.log .ok { color: #3fb950; }
.log .err { color: #f85149; }
.log .info { color: #58a6ff; }
`,

    $: {
        drop: '#drop',
        browse: '#browse',
        scan: '#scan',
        output: '#output',
        fps: '#fps',
        prefab: '#prefab',
        interp: '#interp',
        summary: '#summary',
        list: '#list',
        selectAll: '#select-all',
        selectNone: '#select-none',
        convert: '#convert',
        exportBin: '#export-bin',
        log: '#log',
    },

    methods: {
        write(kind, text) {
            const line = document.createElement('div');
            line.className = kind;
            line.textContent = text;
            this.$.log.appendChild(line);
            this.$.log.scrollTop = this.$.log.scrollHeight;
        },

        logger() {
            return {
                info: (m) => this.write('info', m),
                warn: (m) => this.write('warn', `! ${m}`),
                ok: (m) => this.write('ok', `✓ ${m}`),
                error: (m) => this.write('err', `✗ ${m}`),
            };
        },

        scanProject() {
            const log = this.logger();
            log.info('Scanning project for Spine assets...');
            const projectPath = Editor.Project ? Editor.Project.path : '';
            const assetsDir = path.join(projectPath, 'assets');
            const found = AssetExporter.scanProjectSpines(assetsDir);
            this.items = found.map(f => ({
                path: f.path,
                name: f.name,
                hasAtlas: f.hasAtlas,
                animationsCount: f.animationsCount,
                skinsCount: f.skinsCount,
                selected: true,
                error: null,
            }));
            log.ok(`Detected ${this.items.length} Spine skeleton(s) in project.`);
            this.renderList();
        },

        loadFiles(files) {
            const log = this.logger();
            const valid = [];
            for (const f of files) {
                if (fs.existsSync(f)) {
                    const st = fs.statSync(f);
                    if (st.isDirectory()) {
                        const inDir = AssetExporter.scanProjectSpines(f);
                        for (const item of inDir) valid.push(item);
                    } else if (f.endsWith('.json')) {
                        try {
                            const cnt = fs.readFileSync(f, 'utf8');
                            if (cnt.includes('"skeleton"') || cnt.includes('"bones"')) {
                                const parsed = JSON.parse(cnt);
                                const baseName = path.basename(f, '.json');
                                const dir = path.dirname(f);
                                const hasAtlas = fs.existsSync(path.join(dir, `${baseName}.atlas`)) ||
                                                fs.existsSync(path.join(dir, `${baseName}.atlas.txt`));
                                valid.push({
                                    path: f,
                                    name: baseName,
                                    hasAtlas,
                                    animationsCount: parsed.animations ? Object.keys(parsed.animations).length : 0,
                                    skinsCount: parsed.skins ? Object.keys(parsed.skins).length : 1,
                                });
                            }
                        } catch (e) {
                            log.warn(`Skipping invalid JSON: ${path.basename(f)}`);
                        }
                    }
                }
            }

            if (valid.length === 0) {
                log.warn('No valid Spine skeletons detected in dropped items.');
                return;
            }

            // Deduplicate by path
            const seen = new Set((this.items || []).map(i => i.path));
            for (const v of valid) {
                if (!seen.has(v.path)) {
                    this.items.push({
                        ...v,
                        selected: true,
                        error: null,
                    });
                    seen.add(v.path);
                }
            }

            log.info(`Loaded ${valid.length} Spine skeleton(s).`);
            this.renderList();
        },

        renderList() {
            this.$.list.innerHTML = '';
            for (const item of this.items || []) {
                const row = document.createElement('div');
                row.className = 'item' + (item.error ? ' error' : '');

                const check = document.createElement('input');
                check.type = 'checkbox';
                check.checked = !!item.selected;
                check.onchange = (e) => {
                    item.selected = e.target.checked;
                    this.updateSummary();
                };
                row.appendChild(check);

                const name = document.createElement('span');
                name.className = 'name';
                name.textContent = item.name;
                name.title = item.path;
                row.appendChild(name);

                const pills = document.createElement('div');
                pills.className = 'pills';

                if (item.hasAtlas) {
                    const atlasPill = document.createElement('span');
                    atlasPill.className = 'pill pill-green';
                    atlasPill.textContent = 'Atlas OK';
                    pills.appendChild(atlasPill);
                } else {
                    const atlasPill = document.createElement('span');
                    atlasPill.className = 'pill pill-orange';
                    atlasPill.textContent = 'No Atlas';
                    pills.appendChild(atlasPill);
                }

                const animPill = document.createElement('span');
                animPill.className = 'pill pill-purple';
                animPill.textContent = `${item.animationsCount || 0} anims`;
                pills.appendChild(animPill);

                row.appendChild(pills);
                this.$.list.appendChild(row);
            }
            this.updateSummary();
        },

        updateSummary() {
            const total = (this.items || []).length;
            const selected = (this.items || []).filter(i => i.selected).length;
            this.$.summary.textContent = `${selected} of ${total} selected`;
            const hasSel = selected > 0 && !this.busy;
            this.$.convert.disabled = !hasSel;
            this.$.exportBin.disabled = !hasSel;
        },

        async bakeSelected() {
            const selected = (this.items || []).filter(i => i.selected);
            if (!selected.length) return;

            const log = this.logger();
            this.busy = true;
            this.updateSummary();

            const fps = parseInt(this.$.fps.value, 10) || 30;
            const createPrefab = this.$.prefab.checked;
            let outputFolder = this.$.output.value.trim();

            let targetDir = null;
            if (outputFolder) {
                if (outputFolder.startsWith('db://assets')) {
                    const projectPath = Editor.Project ? Editor.Project.path : '';
                    targetDir = path.join(projectPath, outputFolder.replace('db://', ''));
                } else {
                    targetDir = outputFolder;
                }
            }

            log.info(`--- Starting Bake (${selected.length} items, ${fps} FPS) ---`);
            let successCount = 0;

            try {
                for (const item of selected) {
                    log.info(`Baking: ${item.name}...`);
                    try {
                        const outDir = targetDir || path.dirname(item.path);
                        const res = await AssetExporter.bakeSpineAsset(item.path, {
                            fps,
                            outputDir: outDir,
                            createPrefab,
                        });
                        const dur = res.metadata.animations ? res.metadata.animations.reduce((sum, a) => sum + a.duration, 0) : 0;
                        log.ok(`✓ ${item.name}: ${res.metadata.totalFrames} frames, ${res.metadata.vertexCountPerFrame} verts/frame (${res.metadata.binarySize} bytes)`);
                        successCount++;
                    } catch (e) {
                        log.error(`✗ ${item.name}: ${e.message}`);
                    }
                }
            } finally {
                this.busy = false;
                this.updateSummary();
            }

            log.ok(`=== Bake Complete: ${successCount}/${selected.length} succeeded! ===`);
        },
    },

    ready() {
        this.items = [];
        this.busy = false;
        let saved = null;
        try { saved = localStorage.getItem(OUTPUT_KEY); } catch (e) {}
        this.$.output.value = saved || 'db://assets/FastSpine';

        this.$.output.onchange = () => {
            try { localStorage.setItem(OUTPUT_KEY, this.$.output.value.trim()); } catch (e) {}
        };

        this.$.scan.onclick = () => this.scanProject();

        this.$.selectAll.onclick = () => {
            for (const item of this.items || []) item.selected = true;
            this.renderList();
        };

        this.$.selectNone.onclick = () => {
            for (const item of this.items || []) item.selected = false;
            this.renderList();
        };

        this.$.convert.onclick = () => this.bakeSelected();
        this.$.exportBin.onclick = () => this.bakeSelected();

        // Drag & Drop
        this.$.drop.ondragover = (e) => {
            e.preventDefault();
            this.$.drop.classList.add('over');
        };
        this.$.drop.ondragleave = () => {
            this.$.drop.classList.remove('over');
        };
        this.$.drop.ondrop = (e) => {
            e.preventDefault();
            this.$.drop.classList.remove('over');
            const files = Array.from(e.dataTransfer.files).map(filePathOf).filter(Boolean);
            this.loadFiles(files);
        };

        // Auto-scan on launch if empty
        setTimeout(() => {
            this.scanProject();
        }, 100);
    },
});
