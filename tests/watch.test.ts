import { describe, expect, it } from '@jest/globals';

import {
  Characteristic,
  type Measurement,
  measurementKey,
  ScaleNotFoundError,
  type ScaleTransport,
  type ScannedDevice,
  type ScanOptions,
  UcpError,
  UcpResult,
  type UserCredentials,
  watch,
} from '../src';
import { BODY_COMPOSITION, FakeScale, weightPayload } from './mocks/FakeScale';

const CREDENTIALS = { userIndex: 1, consentCode: 4942 };
const USER_2 = { userIndex: 2, consentCode: 6262 };
const FAST = { idleTimeoutMs: 10, sessionTimeoutMs: 1_000, cooldownMs: 0, retryDelayMs: 0 };

/**
 * A weighing that makes the scale announce a pending measurement: of user 1 with these payloads, of another user, or
 * one whose connection fails.
 */
type WakeUp = Buffer[] | { user: number; send: Buffer[] } | Error;

/**
 * A scale that announces a pending measurement once per entry of `wakeUps`, and sends the given payloads right after
 * connecting. Announcements the scan doesn't look for pass unnoticed. After the last one, the scale sleeps until the
 * watch is stopped.
 */
class FakeTransport implements ScaleTransport<ScannedDevice> {
  public readonly scales: FakeScale[] = [];
  public readonly scans: ScanOptions[] = [];
  public readonly connectedAt: number[] = [];
  private current: WakeUp | undefined;

  constructor(private readonly wakeUps: WakeUp[]) {}

  public async scan(options: ScanOptions): Promise<ScannedDevice> {
    const { signal, pendingMeasurement } = options;
    this.scans.push(options);
    const userOf = (wakeUp: WakeUp): number | undefined =>
      wakeUp instanceof Error ? undefined : Array.isArray(wakeUp) ? CREDENTIALS.userIndex : wakeUp.user;
    const wanted = (wakeUp: WakeUp): boolean => {
      const user = userOf(wakeUp);
      return user === undefined || typeof pendingMeasurement !== 'object' || pendingMeasurement.includes(user);
    };
    while (this.wakeUps.length > 0 && !wanted(this.wakeUps[0])) {
      this.wakeUps.shift();
    }
    if (this.wakeUps.length === 0) {
      await new Promise((_, reject) => signal?.addEventListener('abort', () => reject(signal.reason), { once: true }));
    }
    this.current = this.wakeUps.shift();
    return { pendingUserIndex: this.current && userOf(this.current) };
  }

  public async connect(): Promise<FakeScale> {
    this.connectedAt.push(Date.now());
    const wakeUp = this.current;
    if (wakeUp instanceof Error) {
      throw wakeUp;
    }
    const fake = new FakeScale();
    fake.users.set(CREDENTIALS.userIndex, CREDENTIALS.consentCode);
    fake.users.set(USER_2.userIndex, USER_2.consentCode);
    this.scales.push(fake);
    const payloads = wakeUp === undefined ? [] : Array.isArray(wakeUp) ? wakeUp : wakeUp.send;
    // once subscribed, like the scale does right after the connection is up
    setImmediate(() => {
      for (const payload of payloads) {
        fake.notify(
          payload.length === BODY_COMPOSITION.length ? Characteristic.BODY_COMPOSITION_MEASUREMENT : Characteristic.WEIGHT_MEASUREMENT,
          payload,
        );
      }
    });
    return fake;
  }
}

/** Runs `watch()` until `count` measurements were delivered. */
const watchFor = async (
  transport: FakeTransport,
  count: number,
  options: { seen?: string[]; credentials?: UserCredentials | UserCredentials[] } = {},
) => {
  const controller = new AbortController();
  const measurements: Measurement[] = [];
  const errors: Error[] = [];
  const watching = watch(transport, {
    ...FAST,
    credentials: CREDENTIALS,
    ...options,
    signal: controller.signal,
    onError: (error) => errors.push(error),
    onMeasurement: (measurement) => {
      measurements.push(measurement);
      if (measurements.length === count) {
        controller.abort();
      }
    },
  });
  if (count === 0) {
    setTimeout(() => controller.abort(), 50);
  }
  await watching;
  return { measurements, errors };
};

const morning = (day: number, kg: number): Buffer => weightPayload(kg, new Date(2026, 10, day, 7, 0), CREDENTIALS.userIndex);

describe('watch', () => {
  it('logs in, sets the clock and delivers what the scale sends after waking up', async () => {
    const transport = new FakeTransport([[morning(5, 78.6), BODY_COMPOSITION]]);

    const { measurements } = await watchFor(transport, 1);

    expect(measurements[0]).toMatchObject({ weight: { weight: 78.6 }, bodyComposition: { basalMetabolism: 7300 } });
    const [fake] = transport.scales;
    expect(fake.writesTo(Characteristic.USER_CONTROL_POINT)).toEqual(['02014e13']);
    expect(fake.writesTo(Characteristic.CURRENT_TIME)).toHaveLength(1);
    expect(fake.writesTo(Characteristic.TAKE_MEASUREMENT)).toEqual([]);
    expect(transport.scans[0]).toMatchObject({ pendingMeasurement: [1] });
  });

  it('fetches each weighing with the credentials of the user it belongs to', async () => {
    const user2 = weightPayload(64.5, new Date(2026, 10, 5, 18, 0), USER_2.userIndex);
    const transport = new FakeTransport([{ user: 2, send: [user2] }, [morning(5, 78.2)]]);

    const { measurements } = await watchFor(transport, 2, { credentials: [CREDENTIALS, USER_2] });

    expect(measurements.map(({ weight }) => [weight.userIndex, weight.weight])).toEqual([
      [2, 64.5],
      [1, 78.2],
    ]);
    expect(transport.scans[0]).toMatchObject({ pendingMeasurement: [1, 2] });
    expect(transport.scales[0].writesTo(Characteristic.USER_CONTROL_POINT)).toEqual(['02027618']);
    expect(transport.scales[1].writesTo(Characteristic.USER_CONTROL_POINT)).toEqual(['02014e13']);
  });

  it("leaves other users' weighings on the scale", async () => {
    const user2 = weightPayload(64.5, new Date(2026, 10, 5, 18, 0), USER_2.userIndex);
    const transport = new FakeTransport([{ user: 2, send: [user2] }, [morning(5, 78.2)]]);

    const { measurements } = await watchFor(transport, 1);

    expect(measurements.map(({ weight }) => weight.weight)).toEqual([78.2]);
    expect(transport.scales).toHaveLength(1);
  });

  it('rejects when the user was deleted', async () => {
    const transport = new FakeTransport([{ user: 3, send: [] }]);
    const watching = watch(transport, { ...FAST, credentials: { userIndex: 3, consentCode: 1 }, onMeasurement: () => undefined });

    await expect(watching).rejects.toMatchObject({ result: UcpResult.OPERATION_FAILED });
  });

  it('needs at least one user', async () => {
    await expect(watch(new FakeTransport([]), { credentials: [], onMeasurement: () => undefined })).rejects.toBeInstanceOf(RangeError);
  });

  it('backs off while sessions bring nothing new', async () => {
    const transport = new FakeTransport([[morning(4, 78)], [morning(4, 78)], [morning(4, 78)], [morning(5, 77.5)]]);
    const delivered: number[] = [];
    const controller = new AbortController();

    await watch(transport, {
      ...FAST,
      cooldownMs: 20,
      credentials: CREDENTIALS,
      signal: controller.signal,
      onMeasurement: ({ weight }) => {
        delivered.push(weight.weight);
        if (delivered.length === 2) {
          controller.abort();
        }
      },
    });

    expect(delivered).toEqual([78, 77.5]);
    const [first, second, third, fourth] = transport.connectedAt;
    expect(second - first).toBeLessThan(80); // new measurement: base cooldown
    expect(third - second).toBeGreaterThanOrEqual(15); // nothing new once: still the base
    expect(fourth - third).toBeGreaterThanOrEqual(35); // nothing new twice: doubled
  });

  it('delivers each measurement once, across wake-ups', async () => {
    const transport = new FakeTransport([[morning(4, 78)], [morning(4, 78), morning(5, 77.5)]]);

    const { measurements } = await watchFor(transport, 2);

    expect(measurements.map(({ weight }) => weight.weight)).toEqual([78, 77.5]);
  });

  it('skips measurements seen in an earlier run', async () => {
    const transport = new FakeTransport([[morning(4, 78), morning(5, 77.5)]]);
    const [seen] = [{ weight: { weight: 78, unit: 'kg' as const, userIndex: 1, timestamp: new Date(2026, 10, 4, 7, 0) } }].map(
      measurementKey,
    );

    const { measurements } = await watchFor(transport, 1, { seen: [seen as string] });

    expect(measurements.map(({ weight }) => weight.weight)).toEqual([77.5]);
  });

  it('reports failed connections and keeps watching', async () => {
    const transport = new FakeTransport([new Error('le-connection-abort-by-local'), [morning(5, 77.5)]]);

    const { measurements, errors } = await watchFor(transport, 1);

    expect(errors.map(({ message }) => message)).toEqual(['le-connection-abort-by-local']);
    expect(measurements).toHaveLength(1);
  });

  it('rejects when the scale no longer knows the user', async () => {
    const transport = new FakeTransport([[]]);
    const watching = watch(transport, { ...FAST, credentials: { userIndex: 1, consentCode: 1 }, onMeasurement: () => undefined });

    await expect(watching).rejects.toBeInstanceOf(UcpError);
    await expect(watching).rejects.toMatchObject({ result: UcpResult.USER_NOT_AUTHORIZED });
  });

  it('keeps scanning when the scale stays asleep', async () => {
    let scans = 0;
    const transport = new FakeTransport([]);
    transport.scan = async () => {
      scans++;
      if (scans < 3) {
        throw new ScaleNotFoundError();
      }
      return FakeTransport.prototype.scan.call(transport, { signal: controller.signal });
    };
    const controller = new AbortController();
    const errors: Error[] = [];
    setTimeout(() => controller.abort(), 20);

    await watch(transport, {
      ...FAST,
      credentials: CREDENTIALS,
      signal: controller.signal,
      onError: (e) => errors.push(e),
      onMeasurement: () => undefined,
    });

    expect(scans).toBe(3);
    expect(errors).toEqual([]);
  });
});
