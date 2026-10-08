'use strict';

/**
 * FastSpine Binary Format Encoder and Decoder
 * Conforms to Antigravity Blueprint: Fast Spine Optimizer Section 5 specification
 *
 * Header: 32 Bytes
 * - Magic: 0x4653504E ("FSPN")
 * - Version: 0x0100 (1.0)
 * - FrameCount: Uint16
 * - FPS: Uint8
 * - Flags: Uint8 (bit 0: twoColor, bit 1: premultiplied)
 * - VertexCountPerFrame: Uint16
 * - IndexCount: Uint32
 * - AnimationTableOffset: Uint32
 * - EventTableOffset: Uint32
 * - BufferDataOffset: Uint32
 * - Reserved: Uint32 (4 bytes)
 */

const MAGIC = 0x4653504E; // "FSPN" in little-endian (0x4E, 0x50, 0x53, 0x46) or big-endian check
const MAGIC_STR = 'FSPN';
const VERSION = 0x0100;
const HEADER_SIZE = 32;

class FastSpineBinary {
    /**
     * Encode baked data into a .fastspine binary buffer
     * @param {Object} data
     * @param {number} data.fps
     * @param {number} data.vertexCountPerFrame
     * @param {Uint16Array} data.indices
     * @param {Array<Object>} data.frames - array of { positions: Float32Array, uvs: Float32Array, colors: Uint32Array }
     * @param {Array<Object>} data.animations - array of { name, startFrame, frameCount, duration, fps, loop }
     * @param {Array<Object>} data.events - array of { name, frame, time, intValue, floatValue, stringValue }
     * @param {number} [data.flags=0]
     * @returns {Buffer}
     */
    static encode(data) {
        const {
            fps = 30,
            vertexCountPerFrame = 0,
            indices = new Uint16Array(0),
            frames = [],
            animations = [],
            events = [],
            flags = 0,
        } = data;

        const frameCount = frames.length;
        const indexCount = indices.length;

        // 1. Calculate Frame Vertices byte size
        // Per frame: (positions: Float32Array(vc * 2)) + (uvs: Float32Array(vc * 2)) + (colors: Uint32Array(vc))
        // Bytes per vertex per frame: 2*4 + 2*4 + 4 = 20 bytes
        const bytesPerVertex = 20;
        const frameDataBytes = frameCount * vertexCountPerFrame * bytesPerVertex;

        // 2. Shared Index Buffer byte size
        const indexDataBytes = indexCount * 2; // Uint16

        // BufferData starts right after header
        const bufferDataOffset = HEADER_SIZE;
        const indexDataOffset = bufferDataOffset + frameDataBytes;

        // 3. Encode Animation Table
        const animBuffer = this._encodeAnimations(animations);
        const animTableOffset = indexDataOffset + indexDataBytes;

        // 4. Encode Event Table
        const eventBuffer = this._encodeEvents(events);
        const eventTableOffset = animTableOffset + animBuffer.length;

        const totalBytes = eventTableOffset + eventBuffer.length;
        const out = Buffer.alloc(totalBytes);

        // --- Write Header (32 bytes) ---
        // 0..3: Magic
        out.write(MAGIC_STR, 0, 4, 'ascii');
        // 4..5: Version
        out.writeUInt16LE(VERSION, 4);
        // 6..7: FrameCount
        out.writeUInt16LE(frameCount, 6);
        // 8: FPS
        out.writeUInt8(fps, 8);
        // 9: Flags
        out.writeUInt8(flags, 9);
        // 10..11: VertexCountPerFrame
        out.writeUInt16LE(vertexCountPerFrame, 10);
        // 12..15: IndexCount
        out.writeUInt32LE(indexCount, 12);
        // 16..19: AnimationTableOffset
        out.writeUInt32LE(animTableOffset, 16);
        // 20..23: EventTableOffset
        out.writeUInt32LE(eventTableOffset, 20);
        // 24..27: BufferDataOffset
        out.writeUInt32LE(bufferDataOffset, 24);
        // 28..31: Reserved
        out.writeUInt32LE(0, 28);

        // --- Write Frame Vertices ---
        let offset = bufferDataOffset;
        for (let i = 0; i < frameCount; i++) {
            const frame = frames[i];
            const pos = frame.positions; // Float32Array(vc * 2)
            const uvs = frame.uvs;       // Float32Array(vc * 2)
            const colors = frame.colors; // Uint32Array(vc)

            // Write positions
            for (let v = 0; v < vertexCountPerFrame * 2; v++) {
                out.writeFloatLE(pos && v < pos.length ? pos[v] : 0, offset);
                offset += 4;
            }
            // Write UVs
            for (let v = 0; v < vertexCountPerFrame * 2; v++) {
                out.writeFloatLE(uvs && v < uvs.length ? uvs[v] : 0, offset);
                offset += 4;
            }
            // Write colors (RGBA8 packed into Uint32)
            for (let v = 0; v < vertexCountPerFrame; v++) {
                out.writeUInt32LE(colors && v < colors.length ? colors[v] : 0xffffffff, offset);
                offset += 4;
            }
        }

        // --- Write Shared Index Buffer ---
        for (let i = 0; i < indexCount; i++) {
            out.writeUInt16LE(indices[i], offset);
            offset += 2;
        }

        // --- Write Animation Table ---
        animBuffer.copy(out, offset);
        offset += animBuffer.length;

        // --- Write Event Table ---
        eventBuffer.copy(out, offset);
        offset += eventBuffer.length;

        return out;
    }

    /**
     * Decode a .fastspine binary buffer into a structured object
     * @param {Buffer|ArrayBuffer|Uint8Array} buffer
     * @returns {Object}
     */
    static decode(buffer) {
        const buf = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer.buffer || buffer, buffer.byteOffset || 0, buffer.byteLength || buffer.length);
        if (buf.length < HEADER_SIZE) {
            throw new Error('Invalid .fastspine file: size smaller than header');
        }

        const magic = buf.toString('ascii', 0, 4);
        if (magic !== MAGIC_STR) {
            throw new Error(`Invalid .fastspine magic header: expected ${MAGIC_STR}, got ${magic}`);
        }

        const version = buf.readUInt16LE(4);
        const frameCount = buf.readUInt16LE(6);
        const fps = buf.readUInt8(8);
        const flags = buf.readUInt8(9);
        const vertexCountPerFrame = buf.readUInt16LE(10);
        const indexCount = buf.readUInt32LE(12);
        const animTableOffset = buf.readUInt32LE(16);
        const eventTableOffset = buf.readUInt32LE(20);
        const bufferDataOffset = buf.readUInt32LE(24);

        // Decode Frames
        const frames = [];
        let offset = bufferDataOffset;
        for (let i = 0; i < frameCount; i++) {
            const positions = new Float32Array(vertexCountPerFrame * 2);
            for (let v = 0; v < vertexCountPerFrame * 2; v++) {
                positions[v] = buf.readFloatLE(offset);
                offset += 4;
            }
            const uvs = new Float32Array(vertexCountPerFrame * 2);
            for (let v = 0; v < vertexCountPerFrame * 2; v++) {
                uvs[v] = buf.readFloatLE(offset);
                offset += 4;
            }
            const colors = new Uint32Array(vertexCountPerFrame);
            for (let v = 0; v < vertexCountPerFrame; v++) {
                colors[v] = buf.readUInt32LE(offset);
                offset += 4;
            }
            frames.push({ positions, uvs, colors });
        }

        // Decode Indices
        const indices = new Uint16Array(indexCount);
        for (let i = 0; i < indexCount; i++) {
            indices[i] = buf.readUInt16LE(offset);
            offset += 2;
        }

        // Decode Animations
        const animations = this._decodeAnimations(buf, animTableOffset);

        // Decode Events
        const events = this._decodeEvents(buf, eventTableOffset);

        return {
            version,
            fps,
            flags,
            frameCount,
            vertexCountPerFrame,
            indexCount,
            indices,
            frames,
            animations,
            events,
            rawBuffer: buf,
        };
    }

    static _encodeAnimations(animations) {
        const parts = [];
        const countBuf = Buffer.alloc(2);
        countBuf.writeUInt16LE(animations.length, 0);
        parts.push(countBuf);

        for (const anim of animations) {
            const nameBuf = Buffer.from(anim.name || '', 'utf8');
            const itemBuf = Buffer.alloc(2 + nameBuf.length + 2 + 2 + 4 + 1 + 1);
            let ptr = 0;
            itemBuf.writeUInt16LE(nameBuf.length, ptr); ptr += 2;
            nameBuf.copy(itemBuf, ptr); ptr += nameBuf.length;
            itemBuf.writeUInt16LE(anim.startFrame || 0, ptr); ptr += 2;
            itemBuf.writeUInt16LE(anim.frameCount || 0, ptr); ptr += 2;
            itemBuf.writeFloatLE(anim.duration || 0, ptr); ptr += 4;
            itemBuf.writeUInt8(anim.fps || 30, ptr); ptr += 1;
            itemBuf.writeUInt8(anim.loop ? 1 : 0, ptr); ptr += 1;
            parts.push(itemBuf);
        }
        return Buffer.concat(parts);
    }

    static _decodeAnimations(buf, offset) {
        if (!offset || offset >= buf.length) return [];
        let ptr = offset;
        const count = buf.readUInt16LE(ptr); ptr += 2;
        const list = [];
        for (let i = 0; i < count; i++) {
            const len = buf.readUInt16LE(ptr); ptr += 2;
            const name = buf.toString('utf8', ptr, ptr + len); ptr += len;
            const startFrame = buf.readUInt16LE(ptr); ptr += 2;
            const frameCount = buf.readUInt16LE(ptr); ptr += 2;
            const duration = buf.readFloatLE(ptr); ptr += 4;
            const fps = buf.readUInt8(ptr); ptr += 1;
            const loop = buf.readUInt8(ptr) === 1; ptr += 1;
            list.push({ name, startFrame, frameCount, duration, fps, loop });
        }
        return list;
    }

    static _encodeEvents(events) {
        const parts = [];
        const countBuf = Buffer.alloc(2);
        countBuf.writeUInt16LE(events.length, 0);
        parts.push(countBuf);

        for (const ev of events) {
            const nameBuf = Buffer.from(ev.name || '', 'utf8');
            const strValBuf = Buffer.from(ev.stringValue || '', 'utf8');
            const itemBuf = Buffer.alloc(2 + nameBuf.length + 2 + 4 + 4 + 4 + 2 + strValBuf.length);
            let ptr = 0;
            itemBuf.writeUInt16LE(nameBuf.length, ptr); ptr += 2;
            nameBuf.copy(itemBuf, ptr); ptr += nameBuf.length;
            itemBuf.writeUInt16LE(ev.frame || 0, ptr); ptr += 2;
            itemBuf.writeFloatLE(ev.time || 0, ptr); ptr += 4;
            itemBuf.writeInt32LE(ev.intValue || 0, ptr); ptr += 4;
            itemBuf.writeFloatLE(ev.floatValue || 0, ptr); ptr += 4;
            itemBuf.writeUInt16LE(strValBuf.length, ptr); ptr += 2;
            strValBuf.copy(itemBuf, ptr); ptr += strValBuf.length;
            parts.push(itemBuf);
        }
        return Buffer.concat(parts);
    }

    static _decodeEvents(buf, offset) {
        if (!offset || offset >= buf.length) return [];
        let ptr = offset;
        const count = buf.readUInt16LE(ptr); ptr += 2;
        const list = [];
        for (let i = 0; i < count; i++) {
            const len = buf.readUInt16LE(ptr); ptr += 2;
            const name = buf.toString('utf8', ptr, ptr + len); ptr += len;
            const frame = buf.readUInt16LE(ptr); ptr += 2;
            const time = buf.readFloatLE(ptr); ptr += 4;
            const intValue = buf.readInt32LE(ptr); ptr += 4;
            const floatValue = buf.readFloatLE(ptr); ptr += 4;
            const strLen = buf.readUInt16LE(ptr); ptr += 2;
            const stringValue = buf.toString('utf8', ptr, ptr + strLen); ptr += strLen;
            list.push({ name, frame, time, intValue, floatValue, stringValue });
        }
        return list;
    }
}

module.exports = {
    FastSpineBinary,
    MAGIC,
    MAGIC_STR,
    VERSION,
    HEADER_SIZE,
};
