import type {NativeRegistration} from '../runtime/capability-protocol.ts';
import type {RoutingNativePort} from './routing-port.ts';
import {ROUTING_LIMITS,type RoutingMessage} from './routing-contract.ts';
export type ChannelEndpoint = Readonly<{registration: NativeRegistration}>;
type Channel = Readonly<{id: string; a: ChannelEndpoint; b: ChannelEndpoint}>;
type Terminal = Readonly<{endpoint: ChannelEndpoint; message: Readonly<{type: 'inc.channel.closed'; channelId: string; reason: string}>}>;
/** No payload backlog. Only bounded terminal control records survive a foreground pause. */
export class RoutingChannels {
  private readonly channels = new Map<string, Channel>();
  private readonly terminals = new Map<string, Terminal[]>();
  private retry: ReturnType<typeof setTimeout> | null = null;
  private stopped = false;
  private readonly native: RoutingNativePort;
  private readonly active: (endpoint: ChannelEndpoint, revision: number) => void;
  constructor(native: RoutingNativePort, active: (endpoint: ChannelEndpoint, revision: number) => void) {this.native = native; this.active = active;}
  private contains(channel: Channel, endpoint: ChannelEndpoint) {return channel.a === endpoint || channel.b === endpoint;}
  private peer(channel: Channel, endpoint: ChannelEndpoint) {return channel.a === endpoint ? channel.b : channel.a;}
  private count(endpoint: ChannelEndpoint) {return [...this.channels.values()].filter(channel => this.contains(channel, endpoint)).length + (this.terminals.get(endpoint.registration.generation)?.length ?? 0);}
  open(a: ChannelEndpoint, b: ChannelEndpoint, revision: number): Readonly<{channelId: string; peer: string}> | null {
    this.active(a, revision); this.active(b, revision); this.flush(revision);
    if (a === b || this.count(a) >= ROUTING_LIMITS.channels || this.count(b) >= ROUTING_LIMITS.channels) return null;
    const id = this.native.newChannelId();
    if (!/^[A-Za-z0-9_-]{1,128}$/.test(id) || this.channels.has(id) || [...this.terminals.values()].some(rows => rows.some(row => row.message.channelId === id))) return null;
    const channel = Object.freeze({id, a, b}); this.channels.set(id, channel);
    // Native enqueues target handle creation before the broker returns opener success.
    if (!this.native.send(b.registration.generation, revision, {type: 'inc.channel.opened', channelId: id, peer: a.registration.appId})) {this.channels.delete(id); return null;}
    return Object.freeze({channelId: id, peer: b.registration.appId});
  }
  list(endpoint: ChannelEndpoint, revision: number) {
    this.active(endpoint, revision); this.flush(revision);
    const result: Readonly<{id: string; peer: string}>[] = [];
    for (const channel of this.channels.values()) if (this.contains(channel, endpoint)) result.push(Object.freeze({id: channel.id, peer: this.peer(channel, endpoint).registration.appId}));
    return result;
  }
  private terminal(channel: Channel, reason: string, revision: number, omit?: string) {
    if (!this.channels.delete(channel.id)) return;
    for (const endpoint of [channel.a, channel.b]) {
      const generation = endpoint.registration.generation;
      if (generation === omit) continue;
      const rows = this.terminals.get(generation) ?? [];
      if (rows.length >= ROUTING_LIMITS.channels) continue; // Opens include terminal quota, so this cannot grow beyond the per-endpoint bound.
      rows.push(Object.freeze({endpoint, message: Object.freeze({type: 'inc.channel.closed', channelId: channel.id, reason})})); this.terminals.set(generation, rows);
    }
    this.flush(revision);
  }
  close(endpoint: ChannelEndpoint, id: string, revision: number) {
    this.active(endpoint, revision); const channel = this.channels.get(id);
    if (channel && this.contains(channel, endpoint)) this.terminal(channel, 'closed', revision);
  }
  emit(endpoint: ChannelEndpoint, message: RoutingMessage, revision: number) {
    this.active(endpoint, revision); this.flush(revision);
    const selected = message.type === 'inc.channel.broadcast' ? [...this.channels.values()].filter(channel => this.contains(channel, endpoint)) : [this.channels.get(message.channelId!)].filter((value): value is Channel => !!value && this.contains(value, endpoint));
    for (const channel of selected) {
      const peer = this.peer(channel, endpoint);
      try {
        this.active(endpoint, revision); this.active(peer, revision);
        if (!this.native.send(peer.registration.generation, revision, {type: 'inc.channel.event', channelId: channel.id, sender: endpoint.registration.appId, ...(Object.prototype.hasOwnProperty.call(message, 'payload') ? {payload: message.payload} : {})})) this.terminal(channel, 'buffer overflow', revision);
      } catch {this.terminal(channel, 'peer unavailable', revision);}
    }
  }
  endpointClosed(generation: string, revision: number) {
    this.terminals.delete(generation);
    for (const channel of this.channels.values()) if ([channel.a, channel.b].some(endpoint => endpoint.registration.generation === generation)) this.terminal(channel, 'peer destroyed', revision, generation);
  }
  revoke(revision: number, retainTerminal: boolean) {
    if (retainTerminal) for (const channel of this.channels.values()) this.terminal(channel, 'background', revision);
    else {this.channels.clear(); this.terminals.clear(); this.cancelRetry();}
  }
  private cancelRetry() {if (this.retry !== null) clearTimeout(this.retry); this.retry = null;}
  flush(revision: number) {
    if (this.stopped || !this.native.state().available) return;
    for (const [generation, rows] of this.terminals) {
      while (rows.length) {
        const terminal = rows[0]!;
        try {this.active(terminal.endpoint, revision);} catch {rows.shift(); continue;}
        if (!this.native.send(generation, revision, terminal.message)) break;
        rows.shift();
      }
      if (!rows.length) this.terminals.delete(generation);
    }
    if (this.terminals.size && this.retry === null) this.retry = setTimeout(() => {this.retry = null; this.flush(this.native.state().revision);}, 50);
    else if (!this.terminals.size) this.cancelRetry();
  }
  stop() {this.stopped = true; this.channels.clear(); this.terminals.clear(); this.cancelRetry();}
}
