export type PropKind = 'house' | 'tree' | 'fence' | 'lamp' | 'bench' | 'palm' | 'umbrella' | 'pillar' | 'building';
export type BiomeId = 'neighborhood' | 'park' | 'coast' | 'bridge' | 'city' | 'sunset' | 'night';

export interface BiomeSpec {
  id: BiomeId;
  endDistance: number;
  skyTop: number;
  skyBottom: number;
  ground: number;
  track: number;
  curb: number;
  stripe: number;
  hemiSky: number;
  hemiGround: number;
  sun: number;
  props: readonly PropKind[];
}

const BIOMES: readonly BiomeSpec[] = [
  {
    id: 'neighborhood', endDistance: 300,
    skyTop: 0x68c7ff, skyBottom: 0xe5f8ff,
    ground: 0x78c96f, track: 0x66707c, curb: 0xf4f7f2, stripe: 0xffde59,
    hemiSky: 0xcceeff, hemiGround: 0x83b96f, sun: 0xfff2b0,
    props: ['house', 'tree', 'fence', 'lamp', 'bench'],
  },
  {
    id: 'park', endDistance: 650,
    skyTop: 0x55bdf6, skyBottom: 0xdcf7ec,
    ground: 0x55b95f, track: 0x8f7d67, curb: 0xd8c59a, stripe: 0xffffff,
    hemiSky: 0xc4edff, hemiGround: 0x6da85f, sun: 0xffedaa,
    props: ['tree', 'bench', 'lamp', 'fence'],
  },
  {
    id: 'coast', endDistance: 1050,
    skyTop: 0x4fc3ff, skyBottom: 0xe0fbff,
    ground: 0xf2d68a, track: 0xb9895a, curb: 0xffffff, stripe: 0xffe277,
    hemiSky: 0xc7f2ff, hemiGround: 0xe7c97d, sun: 0xfff0b3,
    props: ['palm', 'umbrella', 'bench', 'lamp'],
  },
  {
    id: 'bridge', endDistance: 1450,
    skyTop: 0x5bbcff, skyBottom: 0xdaf3ff,
    ground: 0x4ba3c7, track: 0x6c7480, curb: 0xe8eef2, stripe: 0xffd75e,
    hemiSky: 0xc8ecff, hemiGround: 0x5f9db5, sun: 0xffedb0,
    props: ['pillar', 'lamp', 'fence'],
  },
  {
    id: 'city', endDistance: 1900,
    skyTop: 0x78bdef, skyBottom: 0xe3edf5,
    ground: 0x9aa5ad, track: 0x535d68, curb: 0xd9dee2, stripe: 0xffcf4d,
    hemiSky: 0xc4dff2, hemiGround: 0x8d969e, sun: 0xffe8a3,
    props: ['building', 'lamp', 'bench', 'fence'],
  },
  {
    id: 'sunset', endDistance: 2350,
    skyTop: 0x7e7bd8, skyBottom: 0xffb36b,
    ground: 0x7aa264, track: 0x655d6b, curb: 0xffc98e, stripe: 0xffe28a,
    hemiSky: 0xd89cc0, hemiGround: 0x80745f, sun: 0xff9f55,
    props: ['palm', 'umbrella', 'lamp', 'bench'],
  },
  {
    id: 'night', endDistance: 2800,
    skyTop: 0x18244f, skyBottom: 0x49548f,
    ground: 0x344d5c, track: 0x3d4658, curb: 0x8ea1c8, stripe: 0xf8d76e,
    hemiSky: 0x6674c8, hemiGround: 0x263d4a, sun: 0x9fb7ff,
    props: ['building', 'lamp', 'bench'],
  },
];

const LOOP_DISTANCE = BIOMES[BIOMES.length - 1].endDistance;

export function biomeAt(travelled: number, blendSpan = 80): { current: BiomeSpec; next: BiomeSpec; blend01: number } {
  const distance = travelled > 0 ? travelled % LOOP_DISTANCE : 0;
  const index = BIOMES.findIndex((biome) => distance < biome.endDistance);
  const current = BIOMES[index];
  const next = BIOMES[(index + 1) % BIOMES.length];
  const remaining = current.endDistance - distance;
  const blend01 = remaining < blendSpan ? 1 - remaining / blendSpan : 0;
  return { current, next, blend01 };
}
