import * as React from 'react';
import { avatarSvg } from './avatar-pattern.js';

/** Decorative; the adjacent visible nickname supplies the accessible identity. */
export function Avatar({publicKey,size=''}:{publicKey?:string;size?:'large'|'small'|''}){
  const source=React.useMemo(()=>`data:image/svg+xml,${encodeURIComponent(avatarSvg(publicKey))}`,[publicKey]);
  return <span className={`df-avatar ${size?`df-avatar-${size}`:''}`} aria-hidden="true"><img src={source} alt="" width={40} height={40} draggable={false}/></span>;
}
