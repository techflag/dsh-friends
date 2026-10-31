import * as React from 'react';
import {Button as DshButton} from '@deepseek-ai/dsh-client-ui-primitives';

/** Keep the official control and its keyboard behavior, with plugin-wide color roles. */
export function Button(props:React.ComponentProps<typeof DshButton>){
  const {className='',variant,...rest}=props;
  return <DshButton {...rest} variant={variant} className={`df-control ${variant==='primary'?'df-primary':variant==='ghost'?'df-ghost':'df-neutral'} ${className}`}/>;
}
