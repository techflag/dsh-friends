/** Visual identifier only: this is not a hash for authentication or cryptography.
 * Keep v2 stable so the same public identity has the same avatar across hosts.
 * No nickname, key fragment, external URL or executable markup enters the SVG.
 */
export function avatarSvg(publicKey?:string):string {
  if(!publicKey||!/^([0-9a-f]{64})$/i.test(publicKey))return '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 40 40"><rect width="40" height="40" rx="8" fill="#eeeaf1"/><circle cx="20" cy="15" r="6" fill="#9a8da3"/><path d="M9 33a11 11 0 0 1 22 0" fill="#9a8da3"/></svg>';
  let seed=2166136261;
  for(const c of publicKey.toLowerCase())seed=Math.imul(seed^c.charCodeAt(0),16777619)>>>0;
  const palettes=[['#e9ddf6','#65318b'],['#f4dce8','#963861'],['#f8e2d4','#a04d24'],['#e5edce','#557027'],['#d8ece5','#286958'],['#e4dff2','#634688'],['#f2e6ca','#866020'],['#f0dce1','#8e4153']];
  const [background,foreground]=palettes[seed%palettes.length];
  // Large, distinct silhouettes remain legible in a 30px chat avatar.
  const shapes=[
    '<path d="m20 6 13 14-13 14L7 20Z"/><circle cx="20" cy="20" r="4" fill="BG"/>',
    '<path d="M20 7a6 6 0 0 1 5 9 6 6 0 0 1 0 11 6 6 0 0 1-10 0 6 6 0 0 1 0-11 6 6 0 0 1 5-9Z"/><circle cx="20" cy="21" r="4" fill="BG"/>',
    '<circle cx="20" cy="20" r="12"/><circle cx="20" cy="20" r="7" fill="BG"/><circle cx="20" cy="20" r="3"/>',
    '<path d="M9 29C5 13 16 7 32 8c1 17-7 26-19 22L25 15Z"/>',
    '<path d="m6 29 10-17 6 10 5-8 8 15Z"/><circle cx="27" cy="9" r="3"/>',
    '<rect x="8" y="8" width="10" height="10" rx="3"/><rect x="22" y="8" width="10" height="10" rx="3"/><rect x="8" y="22" width="10" height="10" rx="3"/><rect x="22" y="22" width="10" height="10" rx="3"/>',
    '<path d="M19 6h2v7l5-5 2 2-5 5h11v10H23l5 5-2 2-5-5v7h-2v-7l-5 5-2-2 5-5H6V15h11l-5-5 2-2 5 5Z"/>',
    '<path d="M8 13a12 12 0 0 1 24 0v14a12 12 0 0 1-24 0Zm7 1v12a5 5 0 0 0 10 0V14a5 5 0 0 0-10 0Z" fill-rule="evenodd"/>',
    '<path d="M7 26c4-18 8 12 13-6s9 11 13-6" fill="none" stroke="FG" stroke-width="6" stroke-linecap="round"/>',
    '<path d="M20 33 7 20C-1 9 15 2 20 13 25 2 41 9 33 20Z"/>',
    '<path d="M29 7A14 14 0 1 0 33 29 13 13 0 0 1 29 7Z"/>',
    '<path d="M16 6h8v12h10L20 34 6 18h10Z"/>',
  ];
  const shape=shapes[(seed>>>8)%shapes.length].replaceAll('BG',background).replaceAll('FG',foreground);
  const rotation=[0,0,0,90][(seed>>>24)%4];
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 40 40"><rect width="40" height="40" rx="8" fill="${background}"/><g fill="${foreground}" transform="rotate(${rotation} 20 20)">${shape}</g></svg>`;
}
