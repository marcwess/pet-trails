import { SPECIES } from '@pet-trails/shared';
import { FrontSide, MeshLambertMaterial, SRGBColorSpace, type BufferGeometry, type Mesh, type MeshStandardMaterial } from 'three';
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
    const gltf = await loader.loadAsync(`${base}assets/pets/animal-${SPECIES[i]}.glb`);
    gltf.scene.updateWorldMatrix(true, true);
    const parts: BufferGeometry[] = [];
    gltf.scene.traverse((obj) => {
      const mesh = obj as Mesh;
      if (!mesh.isMesh) return;
      const srcMat = (Array.isArray(mesh.material) ? mesh.material[0] : mesh.material) as MeshStandardMaterial;
      if (!material && srcMat.map) {
        srcMat.map.colorSpace = SRGBColorSpace;
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
    const merged = mergeGeometries(parts, false);
    for (const part of parts) part.dispose();
    if (!merged) throw new Error(`Could not merge ${SPECIES[i]}`);
    merged.computeBoundingBox();
    const bb = merged.boundingBox!;
    const height = Math.max(0.001, bb.max.y - bb.min.y);
    // The body stays inside about 1.5 cells so the ground ring around it is land.
    const scale = 0.88 / height;
    merged.translate(-(bb.min.x + bb.max.x) / 2, -bb.min.y, -(bb.min.z + bb.max.z) / 2);
    merged.scale(scale, scale, scale);
    merged.computeVertexNormals();
    geos.push(merged);
    onProgress(i + 1, total);
  }
  if (!material) throw new Error('Pet colormap missing');
  return { geos, material };
}
