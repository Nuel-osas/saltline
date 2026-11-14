// Live presence, the wire (squad/index.ts uses it): browsers find each other and talk directly, with no server of
// ours. The library is Trystero (0.27): peers meet through public Nostr relays and then open WebRTC data channels
// to one another. It is loaded only when presence is on.
//
// Checked against the installed types, 14 Nov 2026: `joinRoom({ appId }, room)`; `room.makeAction<T>(name)` answers
// `{ send, onMessage }`, and `send(data, { target: peerId })` goes to one peer; `room.onPeerLeave(({ peerId }) => …)`; `room.leave()`.
//
// Two things a player should know (README → Limits): the other players' browsers connect to theirs directly, as in
// any peer-to-peer game, so each can see the other's network address; and the meeting relays are public services
// this project doesn't run.
import type { Wire } from "./model";

export interface Net {
  /** Tells everyone in the room. Never throws. */
  send(state: Wire): void;
  /** Tells one player that this one's shot met them, and what it would do. */
  hit(peerId: string, damage: number): void;
  /** Tells the player whose hit dropped this one. */
  ko(peerId: string): void;
  leave(): void;
}

export interface NetHandlers {
  /** Something arrived from a peer. It is whatever they sent: check it (model.ts sanitize). */
  onState(peerId: string, raw: unknown): void;
  onLeave(peerId: string): void;
  /** Another player says they hit this one. Their word only: check it (model.ts HitGate). */
  onHit(peerId: string, raw: unknown): void;
  /** A player this one hit says it dropped them. */
  onKo(peerId: string): void;
}

export type Connect = (room: string, handlers: NetHandlers) => Promise<Net>;

export const APP_ID = "saltline-v2-yard";

export const connect: Connect = async (roomName, handlers) => {
  const { joinRoom } = await import("trystero");
  const room = joinRoom({ appId: APP_ID, relayConfig: { warnOnRelayFailure: false } }, roomName);
  const states = room.makeAction<Wire>("st");
  states.onMessage((data, ctx) => handlers.onState(ctx.peerId, data));
  room.onPeerLeave(({ peerId }) => handlers.onLeave(peerId));
  const hits = room.makeAction<{ d: number }>("hit");
  hits.onMessage((data, ctx) => handlers.onHit(ctx.peerId, data));
  const kos = room.makeAction<{ k: 1 }>("ko");
  kos.onMessage((_data, ctx) => handlers.onKo(ctx.peerId));
  return {
    send(state) {
      void states.send(state).catch(() => {});
    },
    hit(peerId, damage) {
      void hits.send({ d: damage }, { target: peerId }).catch(() => {});
    },
    ko(peerId) {
      void kos.send({ k: 1 }, { target: peerId }).catch(() => {});
    },
    leave() {
      void room.leave().catch(() => {});
    },
  };
};
