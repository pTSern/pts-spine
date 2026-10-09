import { _decorator, UIRenderer, BufferAsset, Texture2D, JsonAsset, Material, EventTarget, assetManager, UITransform } from 'cc';
import { EDITOR } from 'cc/env';
import { FastSpineData, FastSpineAnimation, FastSpineEvent } from './FastSpineData';
import { fastSpineAssembler } from './FastSpineAssembler';
import { FastSpineBatchManager } from './FastSpineBatchManager';

const { ccclass, property, executeInEditMode, menu, playOnFocus } = _decorator;

export interface TrackEntry {
    trackIndex: number;
    animation: FastSpineAnimation | null;
    animationName: string;
    loop: boolean;
    delay: number;
    trackTime: number;
    isComplete: boolean;
}

export enum FastSpineEventType {
    START = 'start',
    INTERRUPT = 'interrupt',
    END = 'end',
    DISPOSE = 'dispose',
    COMPLETE = 'complete',
    EVENT = 'event',
}

/**
 * FastSpine is an ultra-fast, drop-in replacement component for sp.Skeleton in Cocos Creator.
 * It renders pre-baked binary vertex frames (.fastspine) with zero bone/matrix CPU calculations
 * and automatic multi-drawcall dynamic batching.
 */
@ccclass('FastSpine')
@menu('Spine/FastSpine')
@executeInEditMode
@playOnFocus
export class FastSpine extends UIRenderer {
    @property({ type: BufferAsset, tooltip: 'Baked .fastspine.bin binary asset' })
    protected _fastSpineData: BufferAsset | null = null;

    @property({ type: BufferAsset, tooltip: 'Baked .fastspine.bin binary asset' })
    public get fastSpineData(): BufferAsset | null {
        return this._fastSpineData;
    }
    public set fastSpineData(val: BufferAsset | null) {
        this._fastSpineData = val;
        this._initData();
    }

    @property({ type: Texture2D, tooltip: 'Atlas texture page' })
    protected _texture: Texture2D | null = null;

    @property({ type: Texture2D, tooltip: 'Atlas texture page' })
    public get texture(): Texture2D | null {
        return this._texture;
    }
    public set texture(val: Texture2D | null) {
        this._texture = val;
        (this as any).updateMaterial?.();
        FastSpineBatchManager.instance.updateRegistration(this);
    }

    @property({ type: JsonAsset, tooltip: 'Optional companion JSON metadata' })
    public fastSpineJson: JsonAsset | null = null;

    @property({ tooltip: 'Default animation name' })
    public defaultAnimation = '';

    @property({ tooltip: 'Loop current animation' })
    public loop = true;

    @property({ tooltip: 'Playback speed multiplier' })
    public timeScale = 1.0;

    @property({ tooltip: 'Pause playback' })
    public paused = false;

    @property({ tooltip: 'Interpolate smoothly between baked frames' })
    public interpolateFrames = true;

    @property({ tooltip: 'Enable global multi-drawcall dynamic batching' })
    public enableBatch = true;

    // Runtime data
    private _data: FastSpineData = new FastSpineData();
    public get data(): FastSpineData {
        return this._data;
    }

    private _currentTrack: TrackEntry | null = null;
    private _tracks: Map<number, TrackEntry> = new Map();
    private _eventTarget: EventTarget = new EventTarget();
    private _lastEmittedFrame = -1;

    private _completeListener: ((entry: TrackEntry) => void) | null = null;
    private _eventListener: ((entry: TrackEntry, event: FastSpineEvent) => void) | null = null;

    public get animation(): string {
        return this._currentTrack ? this._currentTrack.animationName : this.defaultAnimation;
    }
    public set animation(val: string) {
        this.setAnimation(0, val, this.loop);
    }

    public get currentTime(): number {
        return this._currentTrack ? this._currentTrack.trackTime : 0;
    }
    public set currentTime(val: number) {
        if (this._currentTrack) {
            this._currentTrack.trackTime = val;
            this.markForUpdateRenderData();
        }
    }

    public __preload(): void {
        super.__preload();
        this._flushAssembler();
    }

    public onLoad(): void {
        super.onLoad();
        this._flushAssembler();
        this._initData();
    }

    public onEnable(): void {
        super.onEnable();
        FastSpineBatchManager.instance.register(this);
        if (!this._data || !this._data.isValid) {
            this._initData();
        }
        if (this.defaultAnimation && (!this._currentTrack || !this._currentTrack.animation)) {
            this.setAnimation(0, this.defaultAnimation, this.loop);
        }
        this.markForUpdateRenderData();
        if (typeof (this as any).updateRenderer === 'function') {
            (this as any).updateRenderer();
        }
    }

    public onDisable(): void {
        super.onDisable();
        FastSpineBatchManager.instance.unregister(this);
    }

    protected _flushAssembler(): void {
        if (this._assembler !== fastSpineAssembler) {
            this._assembler = fastSpineAssembler;
        }
        if (!this._renderData) {
            this._renderData = fastSpineAssembler.createData(this);
        }
        (this as any).updateMaterial?.();
    }

    protected _render(render: any): void {
        if (!this._assembler) {
            this._flushAssembler();
        }
        if (this._renderData && this._texture) {
            render.commitComp(this, this._renderData, this._texture, this._assembler, null);
        }
    }

    protected _canRender(): boolean {
        if (!super._canRender()) {
            return false;
        }
        return !!this._texture && !!this._data && this._data.isValid;
    }

    private _getBuffer(): ArrayBuffer | null {
        if (!this._fastSpineData) return null;
        const asset = this._fastSpineData as any;
        if (typeof asset.buffer === 'function') {
            try {
                const b = asset.buffer();
                if (b && b.byteLength > 0) return b;
            } catch (e) {}
        }
        if (asset._buffer && asset._buffer.byteLength > 0) {
            return asset._buffer;
        }
        if (asset._nativeAsset && asset._nativeAsset.byteLength > 0) {
            return asset._nativeAsset;
        }
        if (asset._nativeAsset && asset._nativeAsset.buffer && asset._nativeAsset.buffer.byteLength > 0) {
            return asset._nativeAsset.buffer;
        }
        // In Editor mode, read directly from library/ or project filesystem
        if (EDITOR && typeof window !== 'undefined') {
            try {
                const req = (window as any).require || (globalThis as any).require;
                if (typeof req === 'function') {
                    const fs = req('fs');
                    const path = req('path');
                    const ed = (window as any).Editor || (globalThis as any).Editor;
                    const projPath = (ed && ed.Project && ed.Project.path) ? ed.Project.path : 'E:\\__pTSern\\KingdomMatch';
                    const uuid = asset._uuid || asset.uuid;
                    if (uuid && projPath) {
                        const prefix = uuid.substring(0, 2);
                        const libPath = path.join(projPath, 'library', prefix, `${uuid}.bin`);
                        if (fs.existsSync(libPath)) {
                            const fileBuf = fs.readFileSync(libPath);
                            return fileBuf.buffer.slice(fileBuf.byteOffset, fileBuf.byteOffset + fileBuf.byteLength);
                        }
                    }
                }
            } catch (e) {}
        }
        return null;
    }

    private _updateContentSize(): void {
        if (!this._data || !this._data.isValid || this._data.vertexCountPerFrame === 0) return;
        const uiTrans = this.getComponent(UITransform);
        if (!uiTrans) return;

        let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
        const pos = this._data.allPositions;
        const cols = this._data.allColors;
        const count = Math.min(pos.length, this._data.vertexCountPerFrame * 2);
        for (let i = 0; i < count; i += 2) {
            if (cols && cols.length > i / 2 && (cols[i / 2] >>> 24) === 0) continue;
            const x = pos[i];
            const y = pos[i + 1];
            if (x < minX) minX = x;
            if (x > maxX) maxX = x;
            if (y < minY) minY = y;
            if (y > maxY) maxY = y;
        }
        if (maxX > minX && maxY > minY) {
            const w = Math.ceil(maxX - minX);
            const h = Math.ceil(maxY - minY);
            uiTrans.setContentSize(w, h);
            if (w > 0) uiTrans.anchorX = Math.abs(minX) / w;
            if (h > 0) uiTrans.anchorY = Math.abs(minY) / h;
        }
    }

    private _initData(): void {
        const buffer = this._getBuffer();
        if (buffer) {
            if (this._data.parse(buffer)) {
                this._updateContentSize();
                if (this.defaultAnimation) {
                    this.setAnimation(0, this.defaultAnimation, this.loop);
                } else {
                    const anims = this._data.getAnimationNames();
                    if (anims.length > 0) {
                        this.setAnimation(0, anims[0], this.loop);
                    }
                }
            }
        } else if (this._fastSpineData) {
            const asset = this._fastSpineData as any;
            const uuid = asset._uuid || asset.uuid;
            if (uuid && typeof assetManager !== 'undefined') {
                assetManager.loadAny({ uuid }, (err, loadedAsset) => {
                    if (!err && loadedAsset) {
                        this._initData();
                    }
                });
            }
        }
        (this as any).updateMaterial?.();
        this.markForUpdateRenderData();
        if (typeof (this as any).updateRenderer === 'function') {
            (this as any).updateRenderer();
        }
    }

    public update(dt: number): void {
        if (this.paused || !this._currentTrack || !this._data.isValid) return;

        const effectiveDt = dt * this.timeScale;
        const entry = this._currentTrack;
        const oldTime = entry.trackTime;
        entry.trackTime += effectiveDt;

        const anim = entry.animation;
        if (anim) {
            const dur = anim.duration > 0 ? anim.duration : 1 / this._data.fps;
            // Check completion
            if (!entry.loop && entry.trackTime >= dur && !entry.isComplete) {
                entry.isComplete = true;
                this._emitEvent(FastSpineEventType.COMPLETE, entry);
                if (this._completeListener) this._completeListener(entry);
            }

            // Check timeline events
            this._checkEvents(anim, oldTime, entry.trackTime);
        }

        this.markForUpdateRenderData();
    }

    private _checkEvents(anim: FastSpineAnimation, oldTime: number, newTime: number): void {
        if (this._data.events.length === 0) return;
        const dur = anim.duration > 0 ? anim.duration : 1 / this._data.fps;
        const t1 = entryLoopTime(oldTime, dur, this.loop);
        const t2 = entryLoopTime(newTime, dur, this.loop);

        for (const ev of this._data.events) {
            if (ev.frame >= anim.startFrame && ev.frame < anim.startFrame + anim.frameCount) {
                if (ev.time >= t1 && ev.time <= t2) {
                    this._emitEvent(FastSpineEventType.EVENT, this._currentTrack!, ev);
                    if (this._eventListener && this._currentTrack) {
                        this._eventListener(this._currentTrack, ev);
                    }
                }
            }
        }
    }

    /**
     * Drop-in sp.Skeleton API: Set animation on track
     */
    public setAnimation(trackIndex: number, animName: string, loop = true): TrackEntry | null {
        const anim = this._data.findAnimation(animName);
        const entry: TrackEntry = {
            trackIndex,
            animation: anim,
            animationName: animName,
            loop,
            delay: 0,
            trackTime: 0,
            isComplete: false,
        };

        this._tracks.set(trackIndex, entry);
        if (trackIndex === 0) {
            this._currentTrack = entry;
        }

        this._emitEvent(FastSpineEventType.START, entry);
        this.markForUpdateRenderData();
        return entry;
    }

    /**
     * Drop-in sp.Skeleton API: Add animation to queue
     */
    public addAnimation(trackIndex: number, animName: string, loop = true, delay = 0): TrackEntry | null {
        // Queue or set
        if (!this._tracks.has(trackIndex)) {
            return this.setAnimation(trackIndex, animName, loop);
        }
        // Future queue can be queued; for now set if current complete
        return this.setAnimation(trackIndex, animName, loop);
    }

    public clearTrack(trackIndex: number): void {
        this._tracks.delete(trackIndex);
        if (trackIndex === 0) this._currentTrack = null;
    }

    public clearTracks(): void {
        this._tracks.clear();
        this._currentTrack = null;
    }

    public getCurrent(trackIndex = 0): TrackEntry | null {
        return this._tracks.get(trackIndex) || null;
    }

    public findAnimation(name: string): FastSpineAnimation | null {
        return this._data.findAnimation(name);
    }

    public getAnimationNames(): string[] {
        return this._data.getAnimationNames();
    }

    public setSkin(skinName: string): void {
        // Baked skin switcher
    }

    public setCompleteListener(listener: (entry: TrackEntry) => void): void {
        this._completeListener = listener;
    }

    public setEventListener(listener: (entry: TrackEntry, event: FastSpineEvent) => void): void {
        this._eventListener = listener;
    }

    public on(type: string, callback: Function, target?: any): void {
        this._eventTarget.on(type, callback as any, target);
    }

    public off(type: string, callback: Function, target?: any): void {
        this._eventTarget.off(type, callback as any, target);
    }

    private _emitEvent(type: string, ...args: any[]): void {
        this._eventTarget.emit(type, ...args);
    }

    /**
     * Query playback progress for assembler
     */
    public getPlaybackProgress(): { frame1: number, frame2: number, alpha: number, isComplete: boolean } {
        if (!this._currentTrack || !this._currentTrack.animation) {
            return { frame1: 0, frame2: 0, alpha: 0, isComplete: true };
        }
        return this._data.getFrameProgress(
            this._currentTrack.animationName,
            this._currentTrack.trackTime,
            this._currentTrack.loop
        );
    }
}

function entryLoopTime(time: number, duration: number, loop: boolean): number {
    if (duration <= 0) return 0;
    if (loop) {
        let t = time % duration;
        if (t < 0) t += duration;
        return t;
    }
    return Math.min(time, duration);
}
