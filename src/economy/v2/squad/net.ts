// Live presence, the wire (squad/index.ts uses it): browsers find each other and talk directly, with no server of
// ours. The library is Trystero (0.27): peers meet through public Nostr relays and then open WebRTC data channels
// to one another. It is loaded only when presence is on.
//
// Checked against the installed types, 14 Nov 2026: `joinRoom({ appId }, room)`; `room.makeAction<T>(name)` answers
// `{ send, onMessage }`; `room.onPeerLeave(({ peerId }) => …)`; `room.leave()`.
//
// Two things a player should know (README → Limits): the other players' browsers connect to theirs directly, as in
// any peer-to-peer game, so each can see the other's network address; and the meeting relays are public services
// this project doesn't run.
import type { Wire } from "./model";

export interface Net {
  /** Tells everyone in the room. Never throws. */
  send(state: Wire): void;
  leave(): void;
}

export interface NetHandlers {
  /** Something arrived from a peer. It is whatever they sent: check it (model.ts sanitize). */
  onState(peerId: string, raw: unknown): void;
  onLeave(peerId: string): void;
}

export type Connect = (room: string, handlers: NetHandlers) => Promise<Net>;

export const APP_ID = "saltline-v2-yard";

export const connect: Connect = async (roomName, handlers) => {
  const { joinRoom } = await import("trystero");
  const room = joinRoom({ appId: APP_ID, relayConfig: { warnOnRelayFailure: false } }, roomName);
  const states = room.makeAction<Wire>("st");
  states.onMessage((data, ctx) => handlers.onState(ctx.peerId, data));
  room.onPeerLeave(({ peerId }) => handlers.onLeave(peerId));
  return {
    send(state) {
      void states.send(state).catch(() => {});
    },
    leave() {
      void room.leave().catch(() => {});
    },
  };
};
