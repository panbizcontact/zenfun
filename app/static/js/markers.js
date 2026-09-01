/* 古墳の形状マークを SVG で生成する。
   形状ごとに輪郭を描き、orientation（前方部の向く方位・度）で回転させる。
   0=北向き。時計回りに東=90。 */

const SHAPE_COLORS = {
  zenpokoenfun: "#9e3b2e", // 前方後円墳 … 辰砂朱
  hotategai:    "#5a6b4a", // 帆立貝式   … 苔緑
  enpun:        "#a9863f", // 円墳       … 古金
  hofun:        "#2f4858", // 方墳       … 藍鉄
  zenpokohofun: "#6f4a5a", // 前方後方墳 … 紫檀
  unknown:      "#7a736a", // 不明       … 鈍色
};

// viewBox 100x100、中心(50,50)基準の輪郭を描く。up = 前方部が上(北)を向いた形。
function shapePath(shape) {
  switch (shape) {
    case "zenpokoenfun":
      // 前方後円墳: 上=末広がりに開く方形の前方部、くびれ部で細まり、下=円形の後円部（鍵穴型）
      return `M30 12 L70 12 L58 38 A24 24 0 1 1 42 38 Z`;
    case "hotategai":
      // 帆立貝式: 円形の主丘に短い（前方後円墳より丈の低い）前方部が付く扇型
      return `M35 18 L65 18 L59 34 A26 26 0 1 1 41 34 Z`;
    case "zenpokohofun":
      // 前方後方墳: 末広がりの方形の前方部＋くびれ部＋方形の後方部（前後とも角ばった双方形）
      return `M30 12 L70 12 L58 38 L74 38 L74 86 L26 86 L26 38 L42 38 Z`;
    case "enpun": // 円墳
      return `M50 50 m-30 0 a30 30 0 1 0 60 0 a30 30 0 1 0 -60 0`;
    case "hofun": // 方墳
      return `M22 22 H78 V78 H22 Z`;
    default: // 不明: 菱形
      return `M50 18 L82 50 L50 82 L18 50 Z`;
  }
}

// 回転する必要がある（向きの意味がある）形状か
function hasOrientation(shape) {
  return shape === "zenpokoenfun" || shape === "hotategai" || shape === "zenpokohofun";
}

/**
 * SVG 文字列を返す。
 * @param {string} shape 形状キー
 * @param {number} size  ピクセルサイズ
 * @param {number} orientationDeg 前方部の方位(度)。0=北。
 */
function kofunMarkerSVG(shape, size = 28, orientationDeg = 0) {
  const rotate = hasOrientation(shape) ? orientationDeg : 0;
  const path = shapePath(shape);
  return `
<svg width="${size}" height="${size}" viewBox="0 0 100 100" xmlns="http://www.w3.org/2000/svg">
  <g transform="rotate(${rotate} 50 50)">
    <path d="${path}" fill="#ffffff" stroke="#23201c" stroke-width="4"
          stroke-linejoin="round"/>
  </g>
</svg>`.trim();
}

// data URI（MapLibre のアイコンや <img> src 用）
function kofunMarkerDataURI(shape, size = 28, orientationDeg = 0) {
  const svg = kofunMarkerSVG(shape, size, orientationDeg);
  return "data:image/svg+xml;charset=utf-8," + encodeURIComponent(svg);
}

window.KofunMarkers = {
  SHAPE_COLORS, kofunMarkerSVG, kofunMarkerDataURI, hasOrientation,
};
