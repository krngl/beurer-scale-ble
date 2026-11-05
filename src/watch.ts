import { setTimeout as sleep } from 'node:timers/promises';

import { Bf500 } from './Bf500';
import type { ScanOptions } from './bluez';
import { isLoginRejected, ScaleNotFoundError } from './errors';
import type { GattClient } from './GattClient';
import type { Measurement, UserCredentials } from './types';

/** What `watch()` needs to know about a scale a scan found. `BluezDevice` has it. */
export interface ScannedDevice {
  /** User slot of the measurement the scale was announcing; `undefined` if unknown. */
  pendingUserIndex?: number;
}

/** What `watch()` needs from the Bluetooth stack. `Bluez` implements it. */
export interface ScaleTransport<D extends ScannedDevice> {
  /** With `pendingMeasurement`, resolves when the scale announces a measurement of one of those users. */
  scan(options: ScanOptions): Promise<D>;
  connect(device: D): Promise<GattClient>;
}

export interface WatchOptions<D extends ScannedDevice> {
  /**
   * The saved user slot(s) (see `Bf500.registerUser()`). Each weighing is fetched with the credentials of the user it
   * belongs to. Weighings of users not listed here stay on the scale and don't wake it up.
   */
  credentials: UserCredentials | readonly UserCredentials[];
  /**
   * Called once per new measurement, oldest first. If it throws, the error goes to `onError` and the measurement
   * isn't marked as seen; the scale may not send it again, so persist or queue it here.
   */
  onMeasurement: (measurement: Measurement) => void | Promise<void>;
  /** A connection attempt or session failed; `watch()` keeps going. */
  onError?: (error: Error) => void;
  /** Connected to the scale to fetch a measurement of `user`. */
  onConnect?: (device: D, user: UserCredentials) => void;
  /** Scale MAC address. Default: the first scale named `name` */
  address?: string;
  /** Default: `BF500` */
  name?: string;
  /**
   * `measurementKey()`s of measurements delivered earlier, e.g. persisted from a previous run. Measurements with
   * these keys are skipped, since the scale may send its latest measurement again on the next connection.
   */
  seen?: Iterable<string>;
  /**
   * Pause after a session before looking for the scale again. Doubles (up to 1 h) while sessions bring nothing new,
   * e.g. if the scale keeps announcing a measurement it doesn't send, so it isn't woken up over and over.
   * Default: 30 s
   */
  cooldownMs?: number;
  /** Pause after a failed attempt. Doubles like `cooldownMs`. Default: 5 s */
  retryDelayMs?: number;
  /** See `Bf500.collect()`. Default: 10 s */
  idleTimeoutMs?: number;
  /** Maximum time to stay connected per session, see `timeoutMs` of `Bf500.collect()`. Default: 60 s */
  sessionTimeoutMs?: number;
  /** Stops watching. Measurements of a running session are still delivered. */
  signal?: AbortSignal;
}

/** Discovery is restarted this often, in case BlueZ dropped it. */
const SCAN_RESTART_MS = 5 * 60_000;
const MAX_SEEN = 1_000;
const MAX_PAUSE_MS = 60 * 60_000;

const toError = (error: unknown): Error => (error instanceof Error ? error : new Error(String(error)));

/** Identifies a measurement for de-duplication; `undefined` if it has no timestamp. */
export const measurementKey = ({ weight }: Measurement): string | undefined =>
  weight.timestamp && `${weight.userIndex ?? ''}|${weight.timestamp.getTime()}|${weight.weight}${weight.unit}`;

/**
 * Waits for weighings until `signal` is aborted. The scale advertises about every 10 s, even while asleep, and announces
 * the user slot of a measurement no host has fetched yet. When that is one of the `credentials`, this connects (which
 * wakes the scale up), logs in as that user, sets the clock and passes on the measurements the scale sends, including
 * older ones it stored while nobody was listening. Fetching clears the announcement.
 *
 * Errors are reported to `onError` and retried. Rejects only if the scale rejects a login (`UcpError`, see
 * `isLoginRejected()`): wrong consent code, user deleted, or scale reset.
 */
export const watch = async <D extends ScannedDevice>(
  transport: ScaleTransport<D>,
  {
    credentials,
    onMeasurement,
    onError,
    onConnect,
    address,
    name,
    seen: initiallySeen = [],
    cooldownMs = 30_000,
    retryDelayMs = 5_000,
    idleTimeoutMs,
    sessionTimeoutMs,
    signal,
  }: WatchOptions<D>,
): Promise<void> => {
  const users: readonly UserCredentials[] = 'userIndex' in credentials ? [credentials] : credentials;
  if (users.length === 0) {
    throw new RangeError('watch() needs at least one user');
  }
  const seen = new Set(initiallySeen);
  const pause = (ms: number): Promise<void> => sleep(ms, undefined, { signal }).catch(() => undefined);

  /** Passes on new measurements and returns how many there were. */
  const deliver = async (measurements: Measurement[]): Promise<number> => {
    let count = 0;
    for (const measurement of measurements) {
      const key = measurementKey(measurement);
      if (key !== undefined && seen.has(key)) {
        continue;
      }
      count++;
      try {
        await onMeasurement(measurement);
      } catch (error) {
        onError?.(toError(error));
        continue;
      }
      if (key !== undefined) {
        seen.add(key);
        if (seen.size > MAX_SEEN) {
          seen.delete(seen.values().next().value as string);
        }
      }
    }
    return count;
  };

  const session = async (device: D, user: UserCredentials, collected: Measurement[]): Promise<void> => {
    const scale = await Bf500.create(await transport.connect(device));
    onConnect?.(device, user);
    try {
      await scale.login(user);
      await scale.setTime();
      collected.push(...(await scale.collect({ idleTimeoutMs, timeoutMs: sessionTimeoutMs, userIndex: user.userIndex, signal })));
    } finally {
      // if the session failed, keep what arrived before (the scale sends stored measurements right after connecting)
      collected.push(...(await scale.collect({ timeoutMs: 0, userIndex: user.userIndex })));
      await scale.disconnect().catch(() => undefined);
    }
  };

  /** Sessions in a row that brought nothing new */
  let fruitless = 0;
  const backoff = (ms: number): Promise<void> => pause(Math.min(ms * 2 ** Math.max(0, fruitless - 1), MAX_PAUSE_MS));

  while (!signal?.aborted) {
    let device: D;
    try {
      device = await transport.scan({
        address,
        name,
        pendingMeasurement: users.map(({ userIndex }) => userIndex),
        timeoutMs: SCAN_RESTART_MS,
        signal,
      });
    } catch (error) {
      if (!(error instanceof ScaleNotFoundError) && !signal?.aborted) {
        onError?.(toError(error));
        await pause(retryDelayMs);
      }
      continue;
    }

    // a transport that doesn't report the slot gets the first user
    const user = users.find(({ userIndex }) => userIndex === device.pendingUserIndex) ?? users[0];
    const collected: Measurement[] = [];
    let failure: unknown;
    let failed = false;
    try {
      await session(device, user, collected);
    } catch (error) {
      failure = error;
      failed = true;
    }
    fruitless = (await deliver(collected)) > 0 ? 0 : fruitless + 1;

    if (!failed) {
      await backoff(cooldownMs);
    } else if (isLoginRejected(failure)) {
      throw failure;
    } else if (!signal?.aborted) {
      onError?.(toError(failure));
      await backoff(retryDelayMs);
    }
  }
};
