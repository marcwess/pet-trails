type Geom = import('polygon-clipping').Polygon | import('polygon-clipping').MultiPolygon;

declare module 'polygon-clipping' {
  interface PolygonClipping {
    union(geom: Geom, ...geoms: Geom[]): import('polygon-clipping').MultiPolygon;
    difference(subject: Geom, ...clips: Geom[]): import('polygon-clipping').MultiPolygon;
    intersection(geom: Geom, ...geoms: Geom[]): import('polygon-clipping').MultiPolygon;
  }
  const polygonClipping: PolygonClipping;
  export default polygonClipping;
}
