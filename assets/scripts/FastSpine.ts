import { _decorator, UIRenderer, BufferAsset, Texture2D, JsonAsset, Material, EventTarget } from 'cc';
import { FastSpineData, FastSpineAnimation, FastSpineEvent } from './FastSpineData';
import { fastSpineAssembler } from './FastSpineAssembler';
import { FastSpineBatchManager } from './FastSpineBatchManager';

const { ccclass, property, executeInEditMode, menu } = _decorator;

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
        if (this.defaultAnimation && (!this._currentTrack || !this._currentTrack.animation)) {
            this.setAnimation(0, this.defaultAnimation, this.loop);
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
    }

    private _initData(): void {
        if (this._fastSpineData && (this._fastSpineData as any)._nativeAsset) {
            const buffer = (this._fastSpineData as any)._nativeAsset as ArrayBuffer;
            if (this._data.parse(buffer)) {
                if (this.defaultAnimation) {
                    this.setAnimation(0, this.defaultAnimation, this.loop);
                } else {
                    const anims = this._data.getAnimationNames();
                    if (anims.length > 0) {
                        this.setAnimation(0, anims[0], this.loop);
                    }
                }
            }
        }
        this.markForUpdateRenderData();
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
