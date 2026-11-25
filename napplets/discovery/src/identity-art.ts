/** A local decorative identity plate. Only numeric address hashes and palette colours enter this image. */
export function identityArt(seed: number, tone: string): string {
  let state = seed;
  const next = (limit: number) => {
    state = (Math.imul(1664525, state) + 1013904223) >>> 0;
    return Math.floor(state / 4294967296 * limit);
  };
  const cx = 130 + next(65);
  const tilt = next(37) - 18;
  const radius = 65;
  const stars = Array.from({length: 37}, () =>
    `<circle cx="${next(360)}" cy="${next(125)}" r="${next(3) ? .6 : 1.2}" fill="#cbd6e2"/>`).join('');
  const bands = Array.from({length: 17}, (_, index) => {
    const y = index * 8 - 15;
    const lift = next(16) + 4;
    const width = next(6) + 1;
    return `<path d="M${cx-85} ${y}q32 ${lift} 63 1t68 1t45 4" stroke="${index % 4 ? tone : '#ffe0b2'}" stroke-width="${width}" opacity="${(2 + next(5))/10}"/>`;
  }).join('');
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 360 125">
    <defs>
      <radialGradient id="sky"><stop stop-color="${tone}" stop-opacity=".4"/><stop offset="1" stop-color="#07131e"/></radialGradient>
      <radialGradient id="body" cx="29%" cy="16%" r="91%"><stop stop-color="#ffe1b1"/><stop offset=".32" stop-color="${tone}"/><stop offset=".76" stop-color="#344253"/><stop offset="1" stop-color="#111c28"/></radialGradient>
      <linearGradient id="night" x2="1" y2=".32" gradientUnits="objectBoundingBox"><stop offset=".32" stop-color="#061322" stop-opacity="0"/><stop offset="1" stop-color="#061322" stop-opacity=".88"/></linearGradient>
      <clipPath id="disc"><circle cx="${cx}" cy="66" r="${radius}"/></clipPath>
    </defs>
    <rect width="360" height="125" fill="url(#sky)"/><g opacity=".7">${stars}</g>
    <g transform="rotate(${tilt} ${cx} 66)">
      <ellipse cx="${cx}" cy="66" rx="135" ry="34" fill="none" stroke="${tone}" stroke-width="1.3"/>
      <circle cx="${cx}" cy="66" r="${radius}" fill="url(#body)"/>
      <g clip-path="url(#disc)" fill="none">${bands}<rect x="${cx-radius}" y="1" width="130" height="130" fill="url(#night)"/></g>
      <path d="M${cx-135} 66a135 34 0 0 0 270 0" fill="none" stroke="#ffcb8a" stroke-width="2.4"/>
      <path d="M${cx-138} 66a138 38 0 0 0 276 0" fill="none" stroke="${tone}" stroke-width=".8"/>
    </g>
  </svg>`;
  return `url("data:image/svg+xml,${encodeURIComponent(svg)}")`;
}
