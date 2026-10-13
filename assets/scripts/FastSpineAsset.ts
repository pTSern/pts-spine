import { _decorator, BufferAsset, CCClass, CCInteger, EAxisDirection, sp } from "cc";
import { pTSAsset } from "db://pts-core/scripts/utils";
import { FastSpineData } from "./FastSpineData";
import { EDITOR } from "cc/env";
import { CC_IEnumList } from "db://pts-core/scripts/interfaces/cc/CC.IEnumable";
import { FastSpine } from "./FastSpine";

const { ccclass, menu, property } = _decorator;

@ccclass("FastSpineAsset")
@menu('Animation/FastSpine')
export class FastSpineAsset extends pTSAsset {
    @property({ type: BufferAsset, tooltip: 'Baked .fastspine.bin binary asset' })
    protected _binary: BufferAsset = null;
    @property({ type: BufferAsset, tooltip: 'Baked .fastspine.bin binary asset' })
    public get binary(): BufferAsset { return this._binary }
    public set binary(val: BufferAsset) {
        this._binary = val;
        this.onFocusInEditor();
    }

    @property({  })
    anim: string = ''

    @property({  })
    mix: number = 0.2

    @property({  })
    loop: boolean = true

    @property({ type: CCInteger })
    tracker: number = 0

    private _getBuffer(): ArrayBuffer | null {
        if (!this._binary) return null;
        if(!EDITOR) return null;
        const asset = this._binary as any;
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
        return null;
    }

    onFocusInEditor(): void {
        if(!this._binary) {
            CCClass.Attr.setClassAttr(this, 'anim', 'type', undefined);
        } else {
            const _buffer = this._getBuffer();
            if(!_buffer) return;
            const _data = new FastSpineData();
            if(!_data.parse(_buffer)) return;

            const _anims = _data.getAnimationNames();
            const _cca = CC_IEnumList.generator(_anims)

            CCClass.Attr.setClassAttr(this, 'anim', 'type', "Enum");
            CCClass.Attr.setClassAttr(this, 'anim', 'enumList', _cca);
        }
    }

    execute(target: FastSpine | sp.Skeleton) {
        if(!target) return null;
        return target.setAnimation(this.tracker, this.anim, this.loop);
    }
}
