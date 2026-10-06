import { decryptSecret, type RaceStreams } from '@triathlon/core';
import type { IcuClient, StreamList } from '@triathlon/integrations-icu';
import type { IcuConnectionRecord } from '../icu-connect';

export interface RaceStreamsDeps {
  findConnection(userId: string): Promise<IcuConnectionRecord | null>;
  /** Decryption keyring: current key first, then previous (see core getEncKeys). */
  keys: Buffer[];
  createClient(athleteId: string, apiKey: string): Pick<IcuClient, 'getActivityStreams'>;
}

function dataOf(streams: StreamList, type: string): (number | null)[] | null {
  return streams.find((s) => s.type === type)?.data ?? null;
}

/** ICU's stream list as the debrief's streams; null without a time stream. */
export function toRaceStreams(streams: StreamList): RaceStreams | null {
  const timeSec = dataOf(streams, 'time');
  if (!timeSec || timeSec.length < 2) return null;
  return {
    timeSec: timeSec.map((t) => t ?? 0),
    watts: dataOf(streams, 'watts'),
    heartrate: dataOf(streams, 'heartrate'),
    velocity: dataOf(streams, 'velocity_smooth'),
  };
}

/** Fetches the streams of one activity. Null when the athlete is not connected. Throws on ICU errors. */
export async function fetchRaceStreams(
  userId: string,
  icuActivityId: string,
  deps: RaceStreamsDeps
): Promise<RaceStreams | null> {
  const connection = await deps.findConnection(userId);
  if (!connection) return null;
  const apiKey = decryptSecret(
    { ciphertext: connection.apiKeyCiphertext, iv: connection.apiKeyIv },
    deps.keys
  );
  const client = deps.createClient(connection.icuAthleteId, apiKey);
  return toRaceStreams(await client.getActivityStreams(icuActivityId));
}
