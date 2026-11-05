import { randomInt } from 'node:crypto';
import { EventEmitter, on } from 'node:events';

import { DisconnectedError, ProtocolError, TimeoutError, UcpError } from './errors';
import type { GattClient } from './GattClient';
import {
  Characteristic,
  encodeConsent,
  encodeCurrentTime,
  encodeDatabaseChangeIncrement,
  encodeDateOfBirth,
  encodeDeleteUserData,
  encodeGender,
  encodeHeight,
  encodeRegisterNewUser,
  encodeUserListRequest,
  isUserListEnd,
  parseBodyCompositionMeasurement,
  parseDatabaseChangeIncrement,
  parseUcpResponse,
  parseUserListEntry,
  parseWeightMeasurement,
  type UcpResponse,
} from './protocol';
import type {
  BodyCompositionMeasurement,
  DeviceInfo,
  Measurement,
  UserCredentials,
  UserListEntry,
  UserProfile,
  WeightMeasurement,
} from './types';
import { UcpResult } from './types';

export interface Bf500Events {
  /** Every weight measurement the scale sends, including stored ones. */
  weight: [WeightMeasurement];
  /** Every body composition measurement the scale sends, including stored ones. */
  bodyComposition: [BodyCompositionMeasurement];
  /** Data from the scale could not be decoded. Only emitted if a listener is registered. */
  error: [Error];
  disconnect: [];
}

export interface MeasureOptions {
  /** How long to wait for the weight. Default: 60 s */
  timeoutMs?: number;
  /** How long to wait for the body composition after the weight. Default: 3 s */
  bodyCompositionTimeoutMs?: number;
  /**
   * Measurements stamped earlier than this many ms before `measure()` was called are treated as
   * stored measurements and ignored. Relies on the scale clock (see `setTime()`). Default: 90 s
   */
  maxAgeMs?: number;
  /**
   * Return a fresh measurement the scale already sent during this session instead of triggering a new one.
   * The person has often been weighed by the time the connection is up: the scale sends that measurement as
   * soon as notifications are enabled. Default: true
   */
  reuseRecent?: boolean;
  signal?: AbortSignal;
}

export interface CollectOptions {
  /** Stop waiting when no measurement arrived for this long. Default: 10 s */
  idleTimeoutMs?: number;
  /** Stop waiting after this long, even if measurements keep coming. 0 returns what has arrived so far. Default: 60 s */
  timeoutMs?: number;
  /** Only return measurements of this user slot. Default: the logged-in user (all users if nobody is logged in) */
  userIndex?: number;
  /** Stops waiting early. Doesn't reject: the measurements received so far are returned. */
  signal?: AbortSignal;
}

export interface Bf500Options {
  /** How long to wait for the scale to answer a User Control Point request. It answers late while it is measuring. Default: 30 s */
  requestTimeoutMs?: number;
}

const NO_USER = 0xff;
/** More than the scale can store (8 users × 30 measurements) */
const MAX_RECEIVED = 256;

/**
 * Session with a connected and bonded Beurer BF500.
 *
 * Typical flow: `create()` → `login()` (or `registerUser()` + `login()` + `setUserProfile()` on first use)
 * → `setTime()` → `measure()`. To wait for weighings instead of taking one, use `collect()`, or `watch()` for the
 * whole scan-connect-collect loop.
 */
export class Bf500 extends EventEmitter<Bf500Events> {
  /**
   * Measurements to wait for. Separate from the public events because `events.on()` also listens for `error`, which
   * would make a garbled notification fail the wait.
   */
  private readonly measurements = new EventEmitter<Pick<Bf500Events, 'weight' | 'bodyComposition'>>();
  private readonly ucpResponses = new EventEmitter<{ response: [UcpResponse] }>();
  private ucpPending = false;
  private readonly userListNotifications = new EventEmitter<{ data: [Buffer] }>();
  /** Subscribed on first use of `getUserList()` */
  private userListSubscription: Promise<unknown> | undefined;
  private userListPending = false;
  /** Logged-in user slot */
  private userIndex: number | undefined;
  /** Latest measurement the scale sent, not yet returned by `measure()` */
  private recent: Measurement | undefined;
  /** Every measurement the scale sent, not yet returned by `collect()` */
  private readonly received: Measurement[] = [];
  private readonly disconnected = new AbortController();

  private constructor(
    private readonly gatt: GattClient,
    private readonly requestTimeoutMs: number,
  ) {
    super();
  }

  /** Subscribes to the scale's measurement and control point characteristics. */
  public static async create(gatt: GattClient, { requestTimeoutMs = 30_000 }: Bf500Options = {}): Promise<Bf500> {
    const scale = new Bf500(gatt, requestTimeoutMs);
    gatt.onDisconnect(() => {
      scale.disconnected.abort();
      scale.emit('disconnect');
    });

    await gatt.subscribe(Characteristic.USER_CONTROL_POINT, (data) =>
      scale.decode(data, parseUcpResponse, (response) => scale.ucpResponses.emit('response', response)),
    );
    await gatt.subscribe(Characteristic.WEIGHT_MEASUREMENT, (data) =>
      scale.decode(data, parseWeightMeasurement, (weight) => {
        const measurement: Measurement = { weight };
        scale.recent = measurement;
        scale.received.push(measurement);
        if (scale.received.length > MAX_RECEIVED) {
          scale.received.shift();
        }
        scale.measurements.emit('weight', weight);
        scale.emit('weight', weight);
      }),
    );
    await gatt.subscribe(Characteristic.BODY_COMPOSITION_MEASUREMENT, (data) =>
      scale.decode(data, parseBodyCompositionMeasurement, (bodyComposition) => {
        // the BF500 sends the body composition right after its weight, without a timestamp or user to match them by
        for (const measurement of new Set([scale.recent, scale.received.at(-1)])) {
          if (measurement && !measurement.bodyComposition) {
            measurement.bodyComposition = bodyComposition;
          }
        }
        scale.measurements.emit('bodyComposition', bodyComposition);
        scale.emit('bodyComposition', bodyComposition);
      }),
    );
    return scale;
  }

  /**
   * Creates a new user slot on the scale. Persist the returned credentials: they are needed for every `login()`.
   * The scale has 8 slots; registration fails with `UcpError` (OPERATION_FAILED) when all are taken.
   */
  public async registerUser(consentCode: number = randomInt(0, 10_000)): Promise<UserCredentials> {
    const parameter = await this.ucp(encodeRegisterNewUser(consentCode));
    if (parameter.length < 1) {
      throw new ProtocolError('Register New User response is missing the user index');
    }
    return { userIndex: parameter[0], consentCode };
  }

  /**
   * Logs in to a user slot. Fails with `UcpError`: USER_NOT_AUTHORIZED for a wrong consent code, OPERATION_FAILED for a
   * slot that doesn't exist (see `isLoginRejected()`).
   */
  public async login({ userIndex, consentCode }: UserCredentials): Promise<void> {
    await this.ucp(encodeConsent(userIndex, consentCode));
    this.userIndex = userIndex;
  }

  /** Deletes the logged-in user's slot and data from the scale. The slot is free right away (see `getUserList()`). */
  public async deleteUser(): Promise<void> {
    await this.ucp(encodeDeleteUserData());
    this.userIndex = undefined;
  }

  /** Writes the logged-in user's profile. The scale uses it for BMI and body composition. */
  public async setUserProfile({ birthDate, gender, heightCm }: UserProfile): Promise<void> {
    await this.gatt.write(Characteristic.DATE_OF_BIRTH, encodeDateOfBirth(birthDate));
    await this.gatt.write(Characteristic.GENDER, encodeGender(gender));
    await this.gatt.write(Characteristic.HEIGHT, encodeHeight(heightCm));
    // tell the scale the user's data changed
    const increment = parseDatabaseChangeIncrement(await this.gatt.read(Characteristic.DATABASE_CHANGE_INCREMENT));
    await this.gatt.write(Characteristic.DATABASE_CHANGE_INCREMENT, encodeDatabaseChangeIncrement(increment + 1));
  }

  /** Sets the scale clock (local time). Measurements are timestamped with it. */
  public async setTime(date: Date = new Date()): Promise<void> {
    await this.gatt.write(Characteristic.CURRENT_TIME, encodeCurrentTime(date));
  }

  /** The logged-in user slot, or `undefined` if nobody is logged in. */
  public async getUserIndex(): Promise<number | undefined> {
    const [index] = await this.gatt.read(Characteristic.USER_INDEX);
    return index === NO_USER ? undefined : index;
  }

  /** Battery level in percent. */
  public async getBatteryLevel(): Promise<number> {
    const [level] = await this.gatt.read(Characteristic.BATTERY_LEVEL);
    return level;
  }

  /**
   * Lists every user slot on the scale with its profile, including slots registered by other hosts.
   * The list holds no consent codes: reading another slot's measurements still needs its credentials.
   */
  public async getUserList({ timeoutMs = 10_000 }: { timeoutMs?: number } = {}): Promise<UserListEntry[]> {
    if (this.userListPending) {
      throw new Error('Another user list request is in progress');
    }
    this.userListPending = true;
    try {
      if (!this.userListSubscription) {
        const subscription = this.gatt.subscribe(Characteristic.USER_LIST, (data) => this.userListNotifications.emit('data', data));
        this.userListSubscription = subscription;
        subscription.catch(() => (this.userListSubscription = undefined));
      }
      await this.userListSubscription;

      const entries: UserListEntry[] = [];
      const isEnd = (data: Buffer): boolean => {
        if (isUserListEnd(data)) {
          return true;
        }
        this.decode(data, parseUserListEntry, (entry) => entries.push(entry));
        return false;
      };
      await this.writeAndWait(Characteristic.USER_LIST, encodeUserListRequest(), (cancel) =>
        this.waitFor(this.userListNotifications, 'data', isEnd, timeoutMs, 'the user list', cancel),
      );
      return entries;
    } finally {
      this.userListPending = false;
    }
  }

  public async getDeviceInfo(): Promise<DeviceInfo> {
    const read = async (characteristic: Characteristic): Promise<string> => (await this.gatt.read(characteristic)).toString('utf8');
    return {
      manufacturer: await read(Characteristic.MANUFACTURER_NAME),
      model: await read(Characteristic.MODEL_NUMBER),
      firmwareRevision: await read(Characteristic.FIRMWARE_REVISION),
      hardwareRevision: await read(Characteristic.HARDWARE_REVISION),
      softwareRevision: await read(Characteristic.SOFTWARE_REVISION),
    };
  }

  /**
   * Returns a measurement for the logged-in user: a fresh one the scale already sent (see `reuseRecent`), or else
   * asks the scale to take one and waits for it. The person has to be on the scale (or step on it) until the weight
   * is stable.
   */
  public async measure({
    timeoutMs = 60_000,
    bodyCompositionTimeoutMs = 3_000,
    maxAgeMs = 90_000,
    reuseRecent = true,
    signal,
  }: MeasureOptions = {}): Promise<Measurement> {
    const notBefore = Date.now() - maxAgeMs;
    const accept = (measurement: { timestamp?: Date; userIndex?: number }): boolean =>
      (!measurement.timestamp || measurement.timestamp.getTime() >= notBefore) &&
      (this.userIndex === undefined || measurement.userIndex === undefined || measurement.userIndex === this.userIndex);

    const recent = this.recent;
    if (reuseRecent && recent && accept(recent.weight)) {
      this.recent = undefined;
      return this.withBodyComposition(recent, accept, bodyCompositionTimeoutMs, signal);
    }

    // the body composition follows the weight closely, so listen for both from the start
    let bodyComposition: BodyCompositionMeasurement | undefined;
    const collectBodyComposition = (measurement: BodyCompositionMeasurement): void => {
      if (accept(measurement)) {
        bodyComposition = measurement;
      }
    };
    this.on('bodyComposition', collectBodyComposition);
    try {
      const weight = await this.writeAndWait(Characteristic.TAKE_MEASUREMENT, Buffer.from([0x00]), (cancel) =>
        this.waitFor(
          this.measurements,
          'weight',
          accept,
          timeoutMs,
          'a weight measurement',
          signal ? AbortSignal.any([signal, cancel]) : cancel,
        ),
      );
      this.recent = undefined;
      const measurement: Measurement = bodyComposition ? { weight, bodyComposition } : { weight };
      return await this.withBodyComposition(measurement, accept, bodyCompositionTimeoutMs, signal);
    } finally {
      this.off('bodyComposition', collectBodyComposition);
    }
  }

  /**
   * Returns every measurement received since `create()` (or the previous `collect()`), waiting until the scale stops
   * sending. Doesn't ask the scale to take a measurement: it sends the ones it stored (e.g. the last weighing) by
   * itself, right after notifications are enabled.
   *
   * Stops when no measurement arrived for `idleTimeoutMs`, when the scale disconnects, or after `timeoutMs`.
   */
  public async collect({
    idleTimeoutMs = 10_000,
    timeoutMs = 60_000,
    userIndex = this.userIndex,
    signal,
  }: CollectOptions = {}): Promise<Measurement[]> {
    const stop = AbortSignal.any([this.disconnected.signal, ...(signal ? [signal] : [])]);
    if (timeoutMs > 0 && !stop.aborted) {
      const stopOrTimeout = AbortSignal.any([stop, AbortSignal.timeout(timeoutMs)]);
      await new Promise<void>((resolve) => {
        let idleTimer: NodeJS.Timeout | undefined;
        const done = (): void => {
          clearTimeout(idleTimer);
          this.measurements.off('weight', onMeasurement);
          this.measurements.off('bodyComposition', onMeasurement);
          stopOrTimeout.removeEventListener('abort', done);
          resolve();
        };
        const onMeasurement = (): void => {
          clearTimeout(idleTimer);
          idleTimer = setTimeout(done, idleTimeoutMs);
        };
        onMeasurement();
        this.measurements.on('weight', onMeasurement);
        this.measurements.on('bodyComposition', onMeasurement);
        stopOrTimeout.addEventListener('abort', done, { once: true });
      });
    }
    return this.received
      .splice(0)
      .filter(({ weight }) => userIndex === undefined || weight.userIndex === undefined || weight.userIndex === userIndex);
  }

  public async disconnect(): Promise<void> {
    await this.gatt.disconnect();
  }

  /** Waits briefly for the body composition that belongs to `measurement`, if it hasn't arrived yet. */
  private async withBodyComposition(
    measurement: Measurement,
    accept: (measurement: BodyCompositionMeasurement) => boolean,
    timeoutMs: number,
    signal?: AbortSignal,
  ): Promise<Measurement> {
    if (measurement.bodyComposition) {
      return measurement;
    }
    try {
      const bodyComposition = await this.waitFor(this.measurements, 'bodyComposition', accept, timeoutMs, 'body composition', signal);
      return { ...measurement, bodyComposition };
    } catch (error) {
      if (error instanceof TimeoutError || error instanceof DisconnectedError) {
        return measurement;
      }
      throw error;
    }
  }

  private decode<T>(data: Buffer, parse: (data: Buffer) => T | undefined, handle: (value: T) => void): void {
    let value: T | undefined;
    try {
      value = parse(data);
    } catch (error) {
      if (this.listenerCount('error') > 0) {
        this.emit('error', error instanceof Error ? error : new ProtocolError(String(error)));
      }
      return;
    }
    if (value !== undefined) {
      handle(value);
    }
  }

  /** Writes a User Control Point request and waits for its response indication. */
  private async ucp(request: Buffer): Promise<Buffer> {
    if (this.ucpPending) {
      throw new Error('Another User Control Point request is in progress');
    }
    this.ucpPending = true;
    try {
      const opCode = request[0];
      const { result, parameter } = await this.writeAndWait(Characteristic.USER_CONTROL_POINT, request, (cancel) =>
        this.waitFor(
          this.ucpResponses,
          'response',
          (response) => response.requestOpCode === opCode,
          this.requestTimeoutMs,
          'the User Control Point response',
          cancel,
        ),
      );
      if (result !== UcpResult.SUCCESS) {
        throw new UcpError(opCode, result);
      }
      return parameter;
    } finally {
      this.ucpPending = false;
    }
  }

  /**
   * Starts waiting for the reply before writing, so a fast reply can't be missed. If the write fails, the wait is
   * cancelled through the signal passed to `waitForReply` and the write error is thrown.
   */
  private async writeAndWait<T>(
    characteristic: Characteristic,
    data: Buffer,
    waitForReply: (cancel: AbortSignal) => Promise<T>,
  ): Promise<T> {
    const cancel = new AbortController();
    const reply = waitForReply(cancel.signal);
    try {
      await this.gatt.write(characteristic, data);
    } catch (error) {
      reply.catch(() => undefined);
      cancel.abort(error);
      throw error;
    }
    return reply;
  }

  /** Resolves with the first `event` value that `accept` accepts; rejects on timeout, disconnect or abort. */
  private async waitFor<E extends Record<keyof E, [unknown]>, K extends keyof E & string>(
    emitter: EventEmitter<E>,
    event: K,
    accept: (value: E[K][0]) => boolean,
    timeoutMs: number,
    what: string,
    signal?: AbortSignal,
  ): Promise<E[K][0]> {
    const timeout = AbortSignal.timeout(timeoutMs);
    const stop = AbortSignal.any([timeout, this.disconnected.signal, ...(signal ? [signal] : [])]);
    try {
      // listens right away, before the first await
      for await (const [value] of on(emitter as EventEmitter, event, { signal: stop })) {
        if (accept(value)) {
          return value;
        }
      }
    } catch (error) {
      if (signal?.aborted) {
        throw signal.reason;
      }
      if (this.disconnected.signal.aborted) {
        throw new DisconnectedError(`The scale disconnected while waiting for ${what}.`);
      }
      if (timeout.aborted) {
        throw new TimeoutError(`Timed out after ${timeoutMs} ms waiting for ${what}`);
      }
      throw error;
    }
    throw new Error(`Stopped waiting for ${what}`); // not reached: on() only ends by its signal
  }
}
