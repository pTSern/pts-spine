import { _decorator } from 'cc';

export interface FastSpineAnimation {
    name: string;
    startFrame: number;
    frameCount: number;
    duration: number;
    fps: number;
    loop: boolean;
}

export interface FastSpineSkin {
    name: string;
    startFrame: number;
    frameCount: number;
    animations: Map<string, FastSpineAnimation>;
    animationList: FastSpineAnimation[];
}

export interface FastSpineEvent {
    name: string;
    frame: number;
    time: number;
    intValue: number;
    floatValue: number;
    stringValue: string;
    data?: { name: string };
}

export interface FastSpineFrameView {
    positions: Float32Array;
    uvs: Float32Array;
    colors: Uint32Array;
}

const MAGIC_STR = 'FSPN';
const HEADER_SIZE = 32;

/**
 * FastSpineData represents the parsed zero-copy runtime data of a .fastspine binary asset
 */
export class FastSpineData {
    public version = 0x0100;
    public fps = 30;
    public flags = 0;
    public frameCount = 0;
    public vertexCountPerFrame = 0;
    public indexCount = 0;
    public indices: Uint16Array = new Uint16Array(0);

    // Flat data arrays for instant indexing without heap allocations
    public allPositions: Float32Array = new Float32Array(0);
    public allUVs: Float32Array = new Float32Array(0);
    public allColors: Uint32Array = new Uint32Array(0);

    public animations: Map<string, FastSpineAnimation> = new Map();
    public animationList: FastSpineAnimation[] = [];
    public skins: Map<string, FastSpineSkin> = new Map();
    public skinList: FastSpineSkin[] = [];
    public currentSkinName = '';
    public events: FastSpineEvent[] = [];
    public drawOrders: Uint16Array[] = [];
    public frameDrawOrderIds: Uint16Array = new Uint16Array(0);

    private _isValid = false;

    public get isValid(): boolean {
        return this._isValid;
    }

    /**
     * Parse binary ArrayBuffer from a BufferAsset
     */
    public parse(arrayBuffer: ArrayBuffer): boolean {
        if (!arrayBuffer || arrayBuffer.byteLength < HEADER_SIZE) {
            console.error('[FastSpineData] Invalid buffer: size less than header');
            this._isValid = false;
            return false;
        }

        const dataView = new DataView(arrayBuffer);
        const u8 = new Uint8Array(arrayBuffer);

        // Check Magic
        const magic = String.fromCharCode(u8[0], u8[1], u8[2], u8[3]);
        if (magic !== MAGIC_STR) {
            console.error(`[FastSpineData] Invalid magic header: expected ${MAGIC_STR}, got ${magic}`);
            this._isValid = false;
            return false;
        }

        this.version = dataView.getUint16(4, true);
        this.frameCount = dataView.getUint16(6, true);
        this.fps = dataView.getUint8(8);
        this.flags = dataView.getUint8(9);
        this.vertexCountPerFrame = dataView.getUint16(10, true);
        this.indexCount = dataView.getUint32(12, true);
        const animTableOffset = dataView.getUint32(16, true);
        const eventTableOffset = dataView.getUint32(20, true);
        const bufferDataOffset = dataView.getUint32(24, true);
        const skinTableOffset = dataView.getUint32(28, true);
        let drawOrderTableOffset = 0;
        if (bufferDataOffset >= 36 && arrayBuffer.byteLength >= 36) {
            drawOrderTableOffset = dataView.getUint32(32, true);
        }

        const totalVertices = this.frameCount * this.vertexCountPerFrame;

        // Byte offsets for frame streams
        // Stream layout per frame: [x,y]*vc, [u,v]*vc, [col]*vc
        // We unpack directly into continuous typed arrays for maximum GPU cache locality
        this.allPositions = new Float32Array(totalVertices * 2);
        this.allUVs = new Float32Array(totalVertices * 2);
        this.allColors = new Uint32Array(totalVertices);

        let ptr = bufferDataOffset;
        for (let f = 0; f < this.frameCount; f++) {
            const vertBase = f * this.vertexCountPerFrame;

            // Float32 [x, y]
            for (let v = 0; v < this.vertexCountPerFrame * 2; v++) {
                this.allPositions[vertBase * 2 + v] = dataView.getFloat32(ptr, true);
                ptr += 4;
            }
            // Float32 [u, v]
            for (let v = 0; v < this.vertexCountPerFrame * 2; v++) {
                this.allUVs[vertBase * 2 + v] = dataView.getFloat32(ptr, true);
                ptr += 4;
            }
            // Uint32 color
            for (let v = 0; v < this.vertexCountPerFrame; v++) {
                this.allColors[vertBase + v] = dataView.getUint32(ptr, true);
                ptr += 4;
            }
        }

        // Shared Index Buffer
        this.indices = new Uint16Array(this.indexCount);
        for (let i = 0; i < this.indexCount; i++) {
            this.indices[i] = dataView.getUint16(ptr, true);
            ptr += 2;
        }

        // Decode Animations
        this._decodeAnimations(dataView, u8, animTableOffset);

        // Decode Events
        this._decodeEvents(dataView, u8, eventTableOffset);

        // Decode Skins
        if (skinTableOffset && skinTableOffset > 0 && skinTableOffset < arrayBuffer.byteLength) {
            this._decodeSkins(dataView, u8, skinTableOffset);
        } else {
            const defSkin: FastSpineSkin = {
                name: 'default',
                startFrame: 0,
                frameCount: this.frameCount,
                animations: new Map(this.animations),
                animationList: [...this.animationList],
            };
            this.skins.set('default', defSkin);
            this.skinList = [defSkin];
        }

        // Decode Draw Orders
        if (drawOrderTableOffset && drawOrderTableOffset > 0 && drawOrderTableOffset < arrayBuffer.byteLength) {
            this._decodeDrawOrders(dataView, drawOrderTableOffset);
        } else {
            this.drawOrders = [];
            this.frameDrawOrderIds = new Uint16Array(0);
        }

        if (this.skinList.length > 0 && !this.currentSkinName) {
            this.currentSkinName = this.skinList[0].name;
        }

        this._isValid = true;
        return true;
    }

    private _decodeAnimations(view: DataView, u8: Uint8Array, offset: number): void {
        this.animations.clear();
        this.animationList = [];
        if (!offset || offset >= view.byteLength) return;

        let ptr = offset;
        const count = view.getUint16(ptr, true); ptr += 2;
        const decoder = typeof TextDecoder !== 'undefined' ? new TextDecoder('utf-8') : null;

        for (let i = 0; i < count; i++) {
            const nameLen = view.getUint16(ptr, true); ptr += 2;
            const nameStr = decoder
                ? decoder.decode(u8.subarray(ptr, ptr + nameLen))
                : String.fromCharCode.apply(null, Array.from(u8.subarray(ptr, ptr + nameLen)));
            ptr += nameLen;

            const startFrame = view.getUint16(ptr, true); ptr += 2;
            const frameCount = view.getUint16(ptr, true); ptr += 2;
            const duration = view.getFloat32(ptr, true); ptr += 4;
            const fps = view.getUint8(ptr); ptr += 1;
            const loop = view.getUint8(ptr) === 1; ptr += 1;

            const anim: FastSpineAnimation = {
                name: nameStr,
                startFrame,
                frameCount,
                duration,
                fps,
                loop,
            };
            this.animations.set(nameStr, anim);
            this.animationList.push(anim);
        }
    }

    private _decodeSkins(view: DataView, u8: Uint8Array, offset: number): void {
        this.skins.clear();
        this.skinList = [];
        if (!offset || offset >= view.byteLength) return;

        let ptr = offset;
        const count = view.getUint16(ptr, true); ptr += 2;
        const decoder = typeof TextDecoder !== 'undefined' ? new TextDecoder('utf-8') : null;

        for (let i = 0; i < count; i++) {
            const nameLen = view.getUint16(ptr, true); ptr += 2;
            const nameStr = decoder
                ? decoder.decode(u8.subarray(ptr, ptr + nameLen))
                : String.fromCharCode.apply(null, Array.from(u8.subarray(ptr, ptr + nameLen)));
            ptr += nameLen;

            const startFrame = view.getUint16(ptr, true); ptr += 2;
            const frameCount = view.getUint16(ptr, true); ptr += 2;

            const animCount = view.getUint16(ptr, true); ptr += 2;
            const animMap = new Map<string, FastSpineAnimation>();
            const animList: FastSpineAnimation[] = [];

            for (let a = 0; a < animCount; a++) {
                const aNameLen = view.getUint16(ptr, true); ptr += 2;
                const aName = decoder
                    ? decoder.decode(u8.subarray(ptr, ptr + aNameLen))
                    : String.fromCharCode.apply(null, Array.from(u8.subarray(ptr, ptr + aNameLen)));
                ptr += aNameLen;

                const aStartFrame = view.getUint16(ptr, true); ptr += 2;
                const aFrameCount = view.getUint16(ptr, true); ptr += 2;
                const duration = view.getFloat32(ptr, true); ptr += 4;
                const fps = view.getUint8(ptr); ptr += 1;
                const loop = view.getUint8(ptr) === 1; ptr += 1;

                const anim: FastSpineAnimation = {
                    name: aName,
                    startFrame: aStartFrame,
                    frameCount: aFrameCount,
                    duration,
                    fps,
                    loop,
                };
                animMap.set(aName, anim);
                animList.push(anim);
            }

            const skin: FastSpineSkin = {
                name: nameStr,
                startFrame,
                frameCount,
                animations: animMap,
                animationList: animList,
            };
            this.skins.set(nameStr, skin);
            this.skinList.push(skin);
        }

        if (this.skinList.length > 0) {
            this.currentSkinName = this.skinList[0].name;
        }
    }

    private _decodeEvents(view: DataView, u8: Uint8Array, offset: number): void {
        this.events = [];
        if (!offset || offset >= view.byteLength) return;

        let ptr = offset;
        const count = view.getUint16(ptr, true); ptr += 2;
        const decoder = typeof TextDecoder !== 'undefined' ? new TextDecoder('utf-8') : null;

        for (let i = 0; i < count; i++) {
            const nameLen = view.getUint16(ptr, true); ptr += 2;
            const nameStr = decoder
                ? decoder.decode(u8.subarray(ptr, ptr + nameLen))
                : String.fromCharCode.apply(null, Array.from(u8.subarray(ptr, ptr + nameLen)));
            ptr += nameLen;

            const frame = view.getUint16(ptr, true); ptr += 2;
            const time = view.getFloat32(ptr, true); ptr += 4;
            const intValue = view.getInt32(ptr, true); ptr += 4;
            const floatValue = view.getFloat32(ptr, true); ptr += 4;

            const strLen = view.getUint16(ptr, true); ptr += 2;
            const strVal = decoder
                ? decoder.decode(u8.subarray(ptr, ptr + strLen))
                : String.fromCharCode.apply(null, Array.from(u8.subarray(ptr, ptr + strLen)));
            ptr += strLen;

            this.events.push({
                name: nameStr,
                frame,
                time,
                intValue,
                floatValue,
                stringValue: strVal,
                data: { name: nameStr },
            });
        }
    }

    public getSkinNames(): string[] {
        return this.skinList.map(s => s.name);
    }

    public findSkin(name: string): FastSpineSkin | null {
        return this.skins.get(name) || null;
    }

    public setSkin(name: string): boolean {
        const s = this.findSkin(name);
        if (!s) return false;
        this.currentSkinName = s.name;
        return true;
    }

    public get currentSkin(): FastSpineSkin | null {
        return this.findSkin(this.currentSkinName) || this.skinList[0] || null;
    }

    public findAnimation(name: string, skinName?: string): FastSpineAnimation | null {
        const skin = skinName ? this.findSkin(skinName) : this.currentSkin;
        if (skin) {
            const anim = skin.animations.get(name);
            if (anim) return anim;
        }
        return this.animations.get(name) || null;
    }

    public getAnimationNames(skinName?: string): string[] {
        const skin = skinName ? this.findSkin(skinName) : this.currentSkin;
        if (skin) {
            return skin.animationList.map(a => a.name);
        }
        return this.animationList.map(a => a.name);
    }

    /**
     * Compute current frame index and sub-frame alpha for interpolation
     */
    public getFrameProgress(animName: string, time: number, loop: boolean, skinName?: string): { frame1: number, frame2: number, alpha: number, isComplete: boolean } {
        const anim = this.findAnimation(animName, skinName);
        if (!anim || anim.frameCount <= 0) {
            return { frame1: 0, frame2: 0, alpha: 0, isComplete: true };
        }

        const dur = anim.duration > 0 ? anim.duration : 1 / this.fps;
        let t = time;
        let isComplete = false;

        if (loop) {
            t = t % dur;
            if (t < 0) t += dur;
        } else {
            if (t >= dur) {
                t = dur;
                isComplete = true;
            } else if (t < 0) {
                t = 0;
            }
        }

        const exactFrame = (t / dur) * (anim.frameCount - 1);
        const f1Index = Math.floor(exactFrame);
        const alpha = exactFrame - f1Index;
        let f2Index = f1Index + 1;

        if (f2Index >= anim.frameCount) {
            f2Index = loop ? 0 : anim.frameCount - 1;
        }

        const globalF1 = anim.startFrame + f1Index;
        const globalF2 = anim.startFrame + f2Index;

        return {
            frame1: Math.min(globalF1, this.frameCount - 1),
            frame2: Math.min(globalF2, this.frameCount - 1),
            alpha,
            isComplete,
        };
    }

    /**
     * Get index buffer for a given frame index considering Spine drawOrder timeline
     */
    public getIndices(frameIndex: number): Uint16Array {
        if (this.drawOrders.length > 0 && frameIndex >= 0 && frameIndex < this.frameDrawOrderIds.length) {
            const orderId = this.frameDrawOrderIds[frameIndex];
            if (orderId < this.drawOrders.length) {
                return this.drawOrders[orderId];
            }
        }
        return this.indices;
    }

    /**
     * Get draw order permutation ID for a given frame index
     */
    public getDrawOrderId(frameIndex: number): number {
        if (this.frameDrawOrderIds.length > 0 && frameIndex >= 0 && frameIndex < this.frameDrawOrderIds.length) {
            return this.frameDrawOrderIds[frameIndex];
        }
        return 0;
    }

    /**
     * Get index buffer directly by unique draw order ID
     */
    public getIndicesByOrderId(orderId: number): Uint16Array {
        if (orderId >= 0 && orderId < this.drawOrders.length) {
            return this.drawOrders[orderId];
        }
        return this.indices;
    }

    private _decodeDrawOrders(view: DataView, offset: number): void {
        this.drawOrders = [];
        if (!offset || offset >= view.byteLength) return;

        let ptr = offset;
        const count = view.getUint16(ptr, true); ptr += 2;
        const indexCount = view.getUint32(ptr, true); ptr += 4;

        for (let i = 0; i < count; i++) {
            const indices = new Uint16Array(indexCount);
            for (let j = 0; j < indexCount; j++) {
                indices[j] = view.getUint16(ptr, true);
                ptr += 2;
            }
            this.drawOrders.push(indices);
        }

        const frameCount = view.getUint16(ptr, true); ptr += 2;
        this.frameDrawOrderIds = new Uint16Array(frameCount);
        for (let i = 0; i < frameCount; i++) {
            this.frameDrawOrderIds[i] = view.getUint16(ptr, true);
            ptr += 2;
        }
    }
}

