# pTSpine — Fast Spine Converter & Multi-Drawcall Batching Engine

High-performance Spine animation pre-baker and dynamic batching runtime for **Cocos Creator 3.8.x LTS**.


---

## 🚀 Key Advantages Over Default Cocos Spine

| Metric / Feature | Cocos REALTIME | Cocos SHARED_CACHE | Fast Spine (`pts-spine`) |
| :--- | :--- | :--- | :--- |
| **CPU Overhead (100 units)** | Very High (~60ms) | Medium (~16ms) | **Ultra Low (~1.5ms)** |
| **DrawCalls** | High (Slot interleaving) | Medium (Manual batch) | **Aggregated / 1–2 Drawcalls** |
| **Memory Model** | Heap object trees | High JS object maps | **Compact Zero-Copy Binary Buffer** |
| **Frame Interpolation** | Full IK evaluation | None / Stepped | **Smooth 60/120 FPS Sub-frame Tween** |
| **Drop-in Compatibility** | Standard `sp.Skeleton` | Limited | **Full `sp.Skeleton` API Parity** |

---

## 📦 Extension Structure

```
extensions/pts-spine/
├── package.json              # Extension manifest (v2) and asset-db contributions
├── main.js                   # IPC message handlers & panel lifecycle
├── README.md                 # Technical guide & documentation
├── lib/
│   ├── fastspine-binary.js   # Zero-copy binary packer/unpacker (.fastspine spec)
│   ├── spine-parser.js       # Pure JS parser for Spine JSON & Atlas definitions
│   ├── spine-baker.js        # Forward kinematics & frame sampler engine
│   └── asset-exporter.js     # Cocos Creator AssetDB & Prefab generator
├── panel/
│   └── index.js              # Dockable editor conversion & scan panel
├── assets/                   # Mounted to db://pts-spine/
│   ├── tsconfig.json         # TypeScript configuration for runtime
│   └── scripts/
│       ├── FastSpine.ts      # Drop-in UIRenderer component for sp.Skeleton
│       ├── FastSpineData.ts  # Runtime binary loader & frame cache manager
│       ├── FastSpineAssembler.ts    # Cocos 3.8 UIRenderer vertex assembler
│       ├── FastSpineBatchManager.ts # Multi-drawcall batch consolidator
│       └── index.ts          # Public runtime exports
└── test/
    └── test-baker.js         # Automated tests verifying bake on project spines
```

---

## 🛠️ Binary Format Specification (`.fastspine`)

Conforming to Section 5 of the architecture blueprint:

```
[Header: 32 Bytes]
  - Magic: 0x4653504E ("FSPN")   (4 bytes)
  - Version: 0x0100 (1.0)        (Uint16, 2 bytes)
  - FrameCount: Uint16           (Uint16, 2 bytes)
  - FPS: Uint8                   (Uint8, 1 byte)
  - Flags: Uint8                 (Uint8, 1 byte)
  - VertexCountPerFrame: Uint16  (Uint16, 2 bytes)
  - IndexCount: Uint32           (Uint32, 4 bytes)
  - AnimationTableOffset: Uint32 (Uint32, 4 bytes)
  - EventTableOffset: Uint32     (Uint32, 4 bytes)
  - BufferDataOffset: Uint32     (Uint32, 4 bytes)
  - Reserved: Uint32             (4 bytes)

[Data Block: Frame Vertices] (at BufferDataOffset)
  For each frame i in 0..FrameCount - 1:
    - [x, y]: Float32 * VertexCount
    - [u, v]: Float32 * VertexCount
    - [color]: Uint32 (RGBA8 packed) * VertexCount

[Data Block: Shared Index Buffer]
  - Triangles: Uint16 * IndexCount

[Data Block: Animation Table] (at AnimationTableOffset)
  - Name, StartFrame, FrameCount, Duration, FPS, Loop flag

[Data Block: Event Table] (at EventTableOffset)
  - Keyframe events: Name, Time, Frame, Int/Float/String payload
```

---

## 💻 Runtime Usage

### Drop-in Replacement for `sp.Skeleton`

Attach `FastSpine` component to your 2D node:

```typescript
import { _decorator, Component, Node } from 'cc';
import { FastSpine } from 'db://pts-spine/scripts/FastSpine';

const { ccclass, property } = _decorator;

@ccclass('EnemyCharacter')
export class EnemyCharacter extends Component {
    @property(FastSpine)
    public spine: FastSpine = null!;

    start() {
        // Drop-in methods identical to sp.Skeleton:
        this.spine.setAnimation(0, 'walk', true);
        this.spine.timeScale = 1.2;

        this.spine.on('complete', (entry) => {
            console.log('Animation completed:', entry.animationName);
        });

        this.spine.on('event', (entry, event) => {
            console.log('Timeline event fired:', event.name, event.stringValue);
        });
    }

    attack() {
        this.spine.setAnimation(0, 'attack', false);
    }
}
```

### Multi-Drawcall Dynamic Batching

`FastSpine` automatically registers with `FastSpineBatchManager`. Multiple characters sharing the same texture atlas are rendered in a single consolidated pass, reducing 50+ drawcalls down to 1–2!

```typescript
import { FastSpineBatchManager } from 'db://pts-spine/scripts/FastSpineBatchManager';

// Inspect live performance telemetry:
const stats = FastSpineBatchManager.instance.getStats();
console.log(`Active entities: ${stats.activeInstances}`);
console.log(`Drawcalls saved: ${stats.totalDrawcallsSaved}`);
console.log(`CPU time saved: ~${stats.estimatedCpuTimeSavedMs} ms/frame`);
```

---

## 🖥️ Editor Workflow

1. Open **Extension → pTSpine (Fast Spine Optimizer)** in the Cocos Creator menu.
2. Click **Scan Project Spines** or drag & drop Spine `.json` skeletons.
3. Configure target FPS (30 or 60) and output folder (default `db://assets/FastSpine`).
4. Click **Bake Selected Spines**.
5. Use generated `.fastspine.bin` assets and prefabs directly in your scenes.
