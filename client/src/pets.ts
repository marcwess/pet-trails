import { SPECIES } from '@pet-trails/shared';
import {
  BoxGeometry,
  FrontSide,
  MeshLambertMaterial,
  NearestFilter,
  SRGBColorSpace,
  type BufferGeometry,
  type Mesh,
  type MeshStandardMaterial,
  type Texture,
} from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';

/** Bake each cube pet into one geometry so a species is a single instanced draw. */
export async function loadPetGeometries(
  base: string,
  onProgress: (done: number, total: number) => void,
): Promise<{ geos: BufferGeometry[]; material: MeshLambertMaterial }> {
  const loader = new GLTFLoader();
  const geos: BufferGeometry[] = [];
  let material: MeshLambertMaterial | null = null;
  const total = SPECIES.length;
  for (let i = 0; i < total; i++) {
    const species = SPECIES[i]!;
    let merged: BufferGeometry | null = null;
    try {
      const gltf = await loader.loadAsync(`${base}assets/pets/animal-${species}.glb`);
      gltf.scene.updateWorldMatrix(true, true);
      const parts: BufferGeometry[] = [];
      gltf.scene.traverse((obj) => {
        const mesh = obj as Mesh;
        if (!mesh.isMesh) return;
        const srcMat = (Array.isArray(mesh.material) ? mesh.material[0] : mesh.material) as MeshStandardMaterial;
        if (!material && srcMat.map) {
          // The atlas is a grid of flat swatches. Linear filtering and mipmaps
          // blend a pink pig into the gray neighbors, so the whole body reads gray.
          srcMat.map.colorSpace = SRGBColorSpace;
          srcMat.map.magFilter = NearestFilter;
          srcMat.map.minFilter = NearestFilter;
          srcMat.map.generateMipmaps = false;
          srcMat.map.anisotropy = 1;
          srcMat.map.needsUpdate = true;
          material = new MeshLambertMaterial({ map: srcMat.map, side: FrontSide });
        } else if (srcMat.map && material?.map && srcMat.map !== material.map) {
          srcMat.map.dispose();
        }
        srcMat.dispose();
        const g = mesh.geometry.clone();
        g.applyMatrix4(mesh.matrixWorld);
        g.deleteAttribute('tangent');
        g.deleteAttribute('color');
        parts.push(g);
        mesh.geometry.dispose();
      });
      merged = mergeGeometries(parts, false);
      for (const part of parts) part.dispose();
    } catch (err) {
      console.error(`Pet model failed: ${species}`, err);
    }
    if (!merged) merged = fallbackPet();
    merged.computeBoundingBox();
    const bb = merged.boundingBox!;
    const height = Math.max(0.001, bb.max.y - bb.min.y);
    // Center on the paws, not the tail. A bbox center leaves the feet hanging off a pedestal.
    const pos = merged.getAttribute('position');
    const yCut = bb.min.y + height * 0.12;
    let sx = 0;
    let sz = 0;
    let n = 0;
    for (let v = 0; v < pos.count; v++) {
      if (pos.getY(v) > yCut) continue;
      sx += pos.getX(v);
      sz += pos.getZ(v);
      n++;
    }
    const cx = n > 0 ? sx / n : (bb.min.x + bb.max.x) / 2;
    const cz = n > 0 ? sz / n : (bb.min.z + bb.max.z) / 2;
    const scale = 1.32 / height;
    merged.translate(-cx, -bb.min.y, -cz);
    merged.scale(scale, scale, scale);
    merged.computeVertexNormals();
    geos.push(merged);
    onProgress(i + 1, total);
  }
  if (!material) throw new Error('Pet colormap missing');
  return { geos, material };
}

/** A visible stand-in so one broken GLB cannot leave a species invisible. */
function fallbackPet(): BufferGeometry {
  const geo = new BoxGeometry(0.7, 0.9, 0.7);
  geo.translate(0, 0.45, 0);
  return geo;
}

/** Kenney Platformer Kit coin (CC0). Null if the file is missing. */
export async function loadCoinGeometry(base: string): Promise<{ geometry: BufferGeometry; map: Texture | null } | null> {
  try {
    const loader = new GLTFLoader();
    const gltf = await loader.loadAsync(`${base}assets/coins/coin-gold.glb`);
    gltf.scene.updateWorldMatrix(true, true);
    const parts: BufferGeometry[] = [];
    let map: Texture | null = null;
    gltf.scene.traverse((obj) => {
      const mesh = obj as Mesh;
      if (!mesh.isMesh) return;
      const g = mesh.geometry.clone();
      g.applyMatrix4(mesh.matrixWorld);
      g.deleteAttribute('tangent');
      g.deleteAttribute('color');
      parts.push(g);
      mesh.geometry.dispose();
      const srcMat = (Array.isArray(mesh.material) ? mesh.material[0] : mesh.material) as MeshStandardMaterial;
      if (!map && srcMat?.map) {
        map = srcMat.map;
        map.colorSpace = SRGBColorSpace;
        map.needsUpdate = true;
        srcMat.map = null;
      }
      srcMat?.dispose();
    });
    const merged = mergeGeometries(parts, false);
    for (const part of parts) part.dispose();
    if (!merged) return null;
    merged.computeBoundingBox();
    const bb = merged.boundingBox!;
    const width = Math.max(0.001, bb.max.x - bb.min.x);
    const scale = 0.58 / width;
    merged.translate(-(bb.min.x + bb.max.x) / 2, -(bb.min.y + bb.max.y) / 2, -(bb.min.z + bb.max.z) / 2);
    merged.scale(scale, scale, scale);
    return { geometry: merged, map };
  } catch {
    return null;
  }
}
