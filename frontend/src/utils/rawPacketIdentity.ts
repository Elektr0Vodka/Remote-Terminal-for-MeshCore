import type { RawPacket } from '../types';

/**
 * Distinguish real-time RF observations from storage identity.
 * observation_id is emitted per WS event; id is the DB row identity fallback.
 */
export function getRawPacketObservationKey(
  packet: Pick<RawPacket, 'id' | 'observation_id'>
): string {
  if (packet.observation_id !== undefined && packet.observation_id !== null) {
    return `obs-${packet.observation_id}`;
  }
  return `db-${packet.id}`;
}

export function appendRawPacketUnique(
  prev: RawPacket[],
  packet: RawPacket,
  maxPackets: number
): RawPacket[] {
  const packetKey = getRawPacketObservationKey(packet);
  if (prev.some((p) => getRawPacketObservationKey(p) === packetKey)) {
    return prev;
  }

  const updated = [...prev, packet];
  if (updated.length > maxPackets) {
    return updated.slice(-maxPackets);
  }
  return updated;
}
