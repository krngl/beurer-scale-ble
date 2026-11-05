import { beforeEach, describe, expect, it } from '@jest/globals';

import { Bf500, Characteristic, DisconnectedError, Gender, TimeoutError, UcpError, UcpOpCode, UcpResult } from '../src';
import { BODY_COMPOSITION, FakeScale, weightPayload } from './mocks/FakeScale';

describe('Bf500', () => {
  let fake: FakeScale;
  let scale: Bf500;

  beforeEach(async () => {
    fake = new FakeScale();
    scale = await Bf500.create(fake);
  });

  describe('users', () => {
    it('registers a user and logs in', async () => {
      const credentials = await scale.registerUser(4942);

      expect(credentials).toEqual({ userIndex: 1, consentCode: 4942 });
      expect(fake.writesTo(Characteristic.USER_CONTROL_POINT)).toEqual(['014e13']);

      await scale.login(credentials);
      expect(fake.writesTo(Characteristic.USER_CONTROL_POINT)).toEqual(['014e13', '02014e13']);
      expect(await scale.getUserIndex()).toBe(1);
    });

    it('generates a consent code', async () => {
      const { consentCode } = await scale.registerUser();

      expect(Number.isInteger(consentCode)).toBe(true);
      expect(consentCode).toBeGreaterThanOrEqual(0);
      expect(consentCode).toBeLessThanOrEqual(9999);
    });

    it('rejects a wrong consent code', async () => {
      const { userIndex } = await scale.registerUser(1234);

      const login = scale.login({ userIndex, consentCode: 4321 });
      await expect(login).rejects.toBeInstanceOf(UcpError);
      await expect(login).rejects.toMatchObject({ opCode: UcpOpCode.CONSENT, result: UcpResult.USER_NOT_AUTHORIZED });
    });

    it('fails when all slots are taken', async () => {
      for (let i = 0; i < 8; i++) {
        await scale.registerUser();
      }
      await expect(scale.registerUser()).rejects.toMatchObject({ result: UcpResult.OPERATION_FAILED });
    });

    it('deletes the logged-in user', async () => {
      const credentials = await scale.registerUser();
      await scale.login(credentials);

      await scale.deleteUser();

      expect(fake.users.size).toBe(0);
      // the BF500 answers a login to a deleted slot with OPERATION_FAILED
      await expect(scale.login(credentials)).rejects.toMatchObject({ opCode: UcpOpCode.CONSENT, result: UcpResult.OPERATION_FAILED });
    });

    it('times out when the scale does not answer', async () => {
      fake.respondToControlPoint = false;
      const impatient = await Bf500.create(fake, { requestTimeoutMs: 20 });
      await expect(impatient.registerUser()).rejects.toBeInstanceOf(TimeoutError);
    });

    it('passes write errors through', async () => {
      fake.failWrites = true;
      await expect(scale.registerUser()).rejects.toThrow('write failed');
      fake.failWrites = false;
      // the failed request must not block the next one
      await expect(scale.registerUser(1)).resolves.toEqual({ userIndex: 1, consentCode: 1 });
    });

    it('writes the profile and bumps the database change increment', async () => {
      await scale.setUserProfile({ birthDate: { year: 1990, month: 1, day: 31 }, gender: Gender.MALE, heightCm: 180 });

      expect(fake.writesTo(Characteristic.DATE_OF_BIRTH)).toEqual(['c607011f']);
      expect(fake.writesTo(Characteristic.GENDER)).toEqual(['00']);
      expect(fake.writesTo(Characteristic.HEIGHT)).toEqual(['b400']);
      expect(fake.writesTo(Characteristic.DATABASE_CHANGE_INCREMENT)).toEqual(['06000000']);
    });
  });

  describe('measure', () => {
    it('triggers a measurement and returns weight and body composition', async () => {
      const now = new Date();
      fake.measurementPayloads = [weightPayload(80.3, now, 1), BODY_COMPOSITION];

      const measurement = await scale.measure();

      expect(fake.writesTo(Characteristic.TAKE_MEASUREMENT)).toEqual(['00']);
      expect(measurement.weight).toMatchObject({ weight: 80.3, unit: 'kg', userIndex: 1 });
      expect(measurement.bodyComposition).toEqual({ unit: 'kg', basalMetabolism: 7300 });
    });

    it('skips stored measurements', async () => {
      const lastWeek = new Date(Date.now() - 7 * 24 * 3600 * 1000);
      fake.measurementPayloads = [weightPayload(76, lastWeek, 1), weightPayload(80.3, new Date(), 1)];

      const measurement = await scale.measure({ bodyCompositionTimeoutMs: 10 });

      expect(measurement.weight.weight).toBe(80.3);
    });

    it('still emits stored measurements as events', async () => {
      const weights: number[] = [];
      scale.on('weight', ({ weight }) => weights.push(weight));
      fake.measurementPayloads = [weightPayload(76, new Date(2020, 0, 1), 1), weightPayload(80.3, new Date(), 1)];

      await scale.measure({ bodyCompositionTimeoutMs: 10 });

      expect(weights).toEqual([76, 80.3]);
    });

    it('returns a fresh measurement the scale sent before measure() was called', async () => {
      const credentials = await scale.registerUser();
      await scale.login(credentials);
      fake.notify(Characteristic.WEIGHT_MEASUREMENT, weightPayload(78.6, new Date(), credentials.userIndex));
      fake.notify(Characteristic.BODY_COMPOSITION_MEASUREMENT, BODY_COMPOSITION);

      const measurement = await scale.measure();

      expect(fake.writesTo(Characteristic.TAKE_MEASUREMENT)).toEqual([]);
      expect(measurement.weight.weight).toBe(78.6);
      expect(measurement.bodyComposition).toMatchObject({ basalMetabolism: 7300 });
    });

    it('returns an earlier measurement only once', async () => {
      fake.notify(Characteristic.WEIGHT_MEASUREMENT, weightPayload(78.6, new Date(), 1));
      fake.measurementPayloads = [weightPayload(79, new Date(), 1)];

      expect((await scale.measure({ bodyCompositionTimeoutMs: 10 })).weight.weight).toBe(78.6);
      expect((await scale.measure({ bodyCompositionTimeoutMs: 10 })).weight.weight).toBe(79);
    });

    it('does not reuse old measurements or those of other users', async () => {
      await scale.login(await scale.registerUser());
      fake.notify(Characteristic.WEIGHT_MEASUREMENT, weightPayload(70, new Date(), 2));
      fake.measurementPayloads = [weightPayload(78.6, new Date(), 1)];

      expect((await scale.measure({ bodyCompositionTimeoutMs: 10 })).weight.weight).toBe(78.6);

      fake.notify(Characteristic.WEIGHT_MEASUREMENT, weightPayload(76, new Date(2020, 0, 1), 1));
      expect((await scale.measure({ bodyCompositionTimeoutMs: 10 })).weight.weight).toBe(78.6);
      expect(fake.writesTo(Characteristic.TAKE_MEASUREMENT)).toHaveLength(2);
    });

    it('can be told to always trigger a new measurement', async () => {
      fake.notify(Characteristic.WEIGHT_MEASUREMENT, weightPayload(78.6, new Date(), 1));
      fake.measurementPayloads = [weightPayload(79, new Date(), 1)];

      const measurement = await scale.measure({ reuseRecent: false, bodyCompositionTimeoutMs: 10 });

      expect(measurement.weight.weight).toBe(79);
    });

    it('resolves without body composition if none arrives', async () => {
      fake.measurementPayloads = [weightPayload(80, new Date(), 1)];

      const measurement = await scale.measure({ bodyCompositionTimeoutMs: 20 });

      expect(measurement.weight.weight).toBe(80);
      expect(measurement.bodyComposition).toBeUndefined();
    });

    it('times out without a measurement', async () => {
      await expect(scale.measure({ timeoutMs: 20 })).rejects.toBeInstanceOf(TimeoutError);
    });

    it('rejects when the scale disconnects', async () => {
      const measurement = scale.measure();
      setImmediate(() => void fake.disconnect());

      await expect(measurement).rejects.toBeInstanceOf(DisconnectedError);
    });

    it('rejects right away once the scale has disconnected', async () => {
      await fake.disconnect();

      await expect(scale.measure({ timeoutMs: 60_000 })).rejects.toBeInstanceOf(DisconnectedError);
    });

    it('can be aborted', async () => {
      const controller = new AbortController();
      const measurement = scale.measure({ signal: controller.signal });
      controller.abort(new Error('stop'));

      await expect(measurement).rejects.toThrow('stop');
    });

    it('ignores data it cannot decode', async () => {
      const errors: Error[] = [];
      scale.on('error', (error) => errors.push(error));
      fake.measurementPayloads = [Buffer.from('0e01', 'hex'), weightPayload(80, new Date(), 1)];

      const measurement = await scale.measure({ bodyCompositionTimeoutMs: 10 });

      expect(measurement.weight.weight).toBe(80);
      expect(errors).toHaveLength(1);
    });
  });

  describe('collect', () => {
    it('returns what the scale sent on connecting, without triggering a measurement', async () => {
      const credentials = await scale.registerUser();
      fake.notify(Characteristic.WEIGHT_MEASUREMENT, weightPayload(76, new Date(2026, 10, 4, 7, 0), credentials.userIndex));
      fake.notify(Characteristic.BODY_COMPOSITION_MEASUREMENT, BODY_COMPOSITION);
      fake.notify(Characteristic.WEIGHT_MEASUREMENT, weightPayload(77, new Date(2026, 10, 5, 7, 0), credentials.userIndex));
      await scale.login(credentials);

      const measurements = await scale.collect({ idleTimeoutMs: 10 });

      expect(fake.writesTo(Characteristic.TAKE_MEASUREMENT)).toEqual([]);
      expect(measurements.map(({ weight }) => weight.weight)).toEqual([76, 77]);
      expect(measurements[0].bodyComposition).toMatchObject({ basalMetabolism: 7300 });
      expect(measurements[1].bodyComposition).toBeUndefined();
    });

    it('waits for measurements and stops when the scale disconnects', async () => {
      const collected = scale.collect({ idleTimeoutMs: 1_000 });
      setImmediate(() => {
        fake.notify(Characteristic.WEIGHT_MEASUREMENT, weightPayload(78.6, new Date(), 1));
        fake.notify(Characteristic.BODY_COMPOSITION_MEASUREMENT, BODY_COMPOSITION);
        void fake.disconnect();
      });

      const measurements = await collected;

      expect(measurements).toHaveLength(1);
      expect(measurements[0]).toMatchObject({ weight: { weight: 78.6 }, bodyComposition: { basalMetabolism: 7300 } });
      // a disconnected session returns right away
      expect(await scale.collect()).toEqual([]);
    });

    it('returns each measurement once', async () => {
      fake.notify(Characteristic.WEIGHT_MEASUREMENT, weightPayload(78.6, new Date(), 1));

      expect(await scale.collect({ timeoutMs: 0 })).toHaveLength(1);
      expect(await scale.collect({ timeoutMs: 0 })).toEqual([]);
    });

    it('skips measurements of other users', async () => {
      await scale.login(await scale.registerUser());
      fake.notify(Characteristic.WEIGHT_MEASUREMENT, weightPayload(70, new Date(), 2));
      fake.notify(Characteristic.WEIGHT_MEASUREMENT, weightPayload(78.6, new Date(), 1));

      const measurements = await scale.collect({ timeoutMs: 0 });

      expect(measurements.map(({ weight }) => weight.weight)).toEqual([78.6]);
    });

    it('gives up after the timeout', async () => {
      expect(await scale.collect({ timeoutMs: 20 })).toEqual([]);
    });

    it('stops early when aborted', async () => {
      const controller = new AbortController();
      fake.notify(Characteristic.WEIGHT_MEASUREMENT, weightPayload(78.6, new Date(), 1));
      const collected = scale.collect({ idleTimeoutMs: 60_000, timeoutMs: 60_000, signal: controller.signal });
      controller.abort();

      expect(await collected).toHaveLength(1);
    });
  });

  describe('getUserList', () => {
    it('lists every user slot', async () => {
      fake.userListPayloads = [Buffer.from('0001ffffffc6070101af0003', 'hex'), Buffer.from('0002ffffffbc07060fbe0003', 'hex')];

      const users = await scale.getUserList();

      expect(fake.writesTo(Characteristic.USER_LIST)).toEqual(['00']);
      expect(users.map(({ userIndex, heightCm }) => [userIndex, heightCm])).toEqual([
        [1, 175],
        [2, 190],
      ]);
      // subscribes only once
      expect(await scale.getUserList()).toHaveLength(2);
    });

    it('returns an empty list', async () => {
      expect(await scale.getUserList()).toEqual([]);
    });

    it('times out without the end of the list', async () => {
      fake.respondToUserList = false;
      await expect(scale.getUserList({ timeoutMs: 20 })).rejects.toBeInstanceOf(TimeoutError);
    });
  });

  it('reads device info and battery', async () => {
    expect(await scale.getDeviceInfo()).toEqual({
      manufacturer: 'Beurer',
      model: 'BF500',
      firmwareRevision: '1.13',
      hardwareRevision: '1.1',
      softwareRevision: '1.0',
    });
    expect(await scale.getBatteryLevel()).toBe(31);
  });

  it('sets the clock', async () => {
    await scale.setTime(new Date(2026, 10, 5, 16, 51, 5));
    expect(fake.writesTo(Characteristic.CURRENT_TIME)).toEqual(['ea070b05103305040000']);
  });
});
