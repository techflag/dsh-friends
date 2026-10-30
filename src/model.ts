import { z } from 'zod';

export const CANDIDATE_RELAYS = ['wss://relay.damus.io', 'wss://relay.primal.net', 'wss://nos.lol'];
export const PROFILE_TAG = 'dsh-friends/profile/v1';
// Experimental public discovery, isolated by d + protocol; not a registered NIP kind.
// NIP-78 kind 30078 is owner-private and must not be used for public discovery.
export const PROFILE_KIND = 30388;
export const LEASE_SECONDS = 900;
export const hexKey = z.string().regex(/^[0-9a-f]{64}$/);
export const profileSchema = z.object({ name:z.string().trim().min(1).max(20), bio:z.string().max(160), tags:z.array(z.string().trim().min(1).max(16)).max(3), looking:z.string().max(60) }).strict();
export type Profile = z.infer<typeof profileSchema>;
export const storedSchema = z.object({
  version:z.literal(1), publicKey:hexKey.optional(), vault:z.string().max(300).optional(),
  profile:profileSchema, discoverable:z.boolean(), networkApproved:z.boolean(),
  encryptedData:z.string().max(8_000_000).optional(),
  announcementAt:z.number().int().nonnegative().default(0),
}).strict().refine(s=>Boolean(s.publicKey)===Boolean(s.vault),'Incomplete identity');
export type Stored = z.infer<typeof storedSchema>;
export const initialStored = ():Stored => ({version:1, profile:{name:'新搭子',bio:'',tags:[],looking:''},discoverable:false,networkApproved:false,announcementAt:0});
export interface Store { read():Stored; write(value:Stored):Promise<void>; }
export interface Peer extends Profile { publicKey:string; updatedAt:number; expiresAt:number; visible:boolean; eventId:string; }
export interface Invitation { id:string; peer:string; greeting:string; direction:'incoming'|'outgoing'; state:'pending'|'accepted'|'ignored'; expiresAt:number; }
export interface Message { id:string; peer:string; text:string; mine:boolean; createdAt:number; status:'sending'|'relay-accepted'|'failed'|'received'; }
export interface Outbox { id:string; peer:string; events:Record<string,unknown>[]; relayUrls:string[]; type:'request'|'accept'|'text'; requestId?:string; }
export interface PrivateData { version:1; peers:Record<string,Peer>; invitations:Record<string,Invitation>; friends:string[]; blocked:string[]; messages:Message[]; outbox:Outbox[]; seen:string[]; inboxes:Record<string,{urls:string[];updatedAt:number}>; }
export const emptyPrivate = ():PrivateData => ({version:1,peers:{},invitations:{},friends:[],blocked:[],messages:[],outbox:[],seen:[],inboxes:{}});
const peerSchema=profileSchema.extend({publicKey:hexKey,updatedAt:z.number().int(),expiresAt:z.number().int(),visible:z.boolean(),eventId:hexKey});
const invitationSchema=z.object({id:z.string().uuid(),peer:hexKey,greeting:z.string().max(120),direction:z.enum(['incoming','outgoing']),state:z.enum(['pending','accepted','ignored']),expiresAt:z.number().int()}).strict();
const messageSchema=z.object({id:z.string().uuid(),peer:hexKey,text:z.string().max(2000),mine:z.boolean(),createdAt:z.number().int(),status:z.enum(['sending','relay-accepted','failed','received'])}).strict();
const outboxSchema=z.object({id:z.string().uuid(),peer:hexKey,events:z.array(z.record(z.string(),z.unknown())).max(2),relayUrls:z.array(z.string().max(256)).max(3),type:z.enum(['request','accept','text']),requestId:z.string().uuid().optional()}).strict();
export const privateSchema=z.object({version:z.literal(1),peers:z.record(hexKey,peerSchema),invitations:z.record(z.string().uuid(),invitationSchema),friends:z.array(hexKey).max(500),blocked:z.array(hexKey).max(500),messages:z.array(messageSchema).max(1000),outbox:z.array(outboxSchema).max(100),seen:z.array(z.string().max(128)).max(2000),inboxes:z.record(hexKey,z.object({urls:z.array(z.string().max(256)).max(3),updatedAt:z.number().int()}))}).strict();
export interface Snapshot {
  identity:'missing'|'locked'|'ready'; publicKey?:string; profile:Profile;
  discoverable:boolean; published:boolean; networkApproved:boolean;
  relays:{url:string;state:'idle'|'connecting'|'connected'|'failed'}[];
  peers:Peer[]; invitations:Invitation[]; friends:Peer[]; blocked:string[]; messages:Message[];
  pending:number; pendingIds:string[]; error?:string;
}
export class FriendsError extends Error { constructor(readonly code:string, message:string){super(message);} }
export function demand(condition:unknown, code:string, message:string):asserts condition { if(!condition)throw new FriendsError(code,message); }
