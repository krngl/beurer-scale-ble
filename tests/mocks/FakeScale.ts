import { EventEmitter } from 'node:events';

import { Characteristic, type GattClient, type NotificationListener } from '../../src';

/** Encodes a Weight Measurement (kg) with timestamp and user index, like the BF500 sends it. */
export const weightPayload = (kg: number, timestamp: Date, userIndex: number): Buffer => {
  const data = Buffer.alloc(11);
  data.writeUInt8(0x06, 0);
  data.writeUInt16LE(Math.round(kg / 0.005), 1);
  data.writeUInt16LE(timestamp.getFullYear(), 3);
  data.writeUInt8(timestamp.getMonth() + 1, 5);
  data.writeUInt8(timestamp.getDate(), 6);
  data.writeUInt8(timestamp.getHours(), 7);
  data.writeUInt8(timestamp.getMinutes(), 8);
  data.writeUInt8(timestamp.getSeconds(), 9);
  data.writeUInt8(userIndex, 10);
  return data;
};

/** Body Composition Measurement as captured from a BF500 */
export const BODY_COMPOSITION = Buffer.from('98030000841c0000000000000000', 'hex');

/** In-memory stand-in for a BF500, implementing just enough of its GATT behaviour. */
export class FakeScale implements GattClient {
  public readonly writes: Array<{ characteristic: string; data: Buffer }> = [];
  public readonly values = new Map<string, Buffer>([
    [Characteristic.DATABASE_CHANGE_INCREMENT, Buffer.from('05000000', 'hex')],
    [Characteristic.USER_INDEX, Buffer.from([0xff])],
    [Characteristic.BATTERY_LEVEL, Buffer.from([31])],
    [Characteristic.MANUFACTURER_NAME, Buffer.from('Beurer')],
    [Characteristic.MODEL_NUMBER, Buffer.from('BF500')],
    [Characteristic.FIRMWARE_REVISION, Buffer.from('1.13')],
    [Characteristic.HARDWARE_REVISION, Buffer.from('1.1')],
    [Characteristic.SOFTWARE_REVISION, Buffer.from('1.0')],
  ]);
  /** consent code per user slot */
  public readonly users = new Map<number, number>();
  /** User List entries, sent in order (followed by the end marker) when the list is requested. */
  public userListPayloads: Buffer[] = [];
  /** Sent in order when a measurement is triggered. */
  public measurementPayloads: Buffer[] = [];
  public respondToControlPoint = true;
  public respondToUserList = true;
  public failWrites = false;

  private readonly listeners = new Map<string, NotificationListener>();
  private readonly events = new EventEmitter<{ disconnect: [] }>();
  private loggedIn: number | undefined;

  public async read(characteristic: string): Promise<Buffer> {
    const value = this.values.get(characteristic);
    if (!value) {
      throw new Error(`not readable: ${characteristic}`);
    }
    return value;
  }

  public async write(characteristic: string, data: Buffer): Promise<void> {
    if (this.failWrites) {
      throw new Error('write failed');
    }
    this.writes.push({ characteristic, data });
    if (characteristic === Characteristic.USER_CONTROL_POINT) {
      this.handleControlPoint(data);
    } else if (characteristic === Characteristic.USER_LIST) {
      for (const payload of this.respondToUserList ? [...this.userListPayloads, Buffer.from([0x01])] : []) {
        this.notifyLater(Characteristic.USER_LIST, payload);
      }
    } else if (characteristic === Characteristic.TAKE_MEASUREMENT) {
      for (const payload of this.measurementPayloads) {
        const target =
          payload.length === BODY_COMPOSITION.length ? Characteristic.BODY_COMPOSITION_MEASUREMENT : Characteristic.WEIGHT_MEASUREMENT;
        this.notifyLater(target, payload);
      }
    } else {
      this.values.set(characteristic, data);
    }
  }

  public async subscribe(characteristic: string, listener: NotificationListener): Promise<() => Promise<void>> {
    this.listeners.set(characteristic, listener);
    return async () => {
      this.listeners.delete(characteristic);
    };
  }

  public onDisconnect(listener: () => void): () => void {
    this.events.on('disconnect', listener);
    return () => this.events.off('disconnect', listener);
  }

  public async disconnect(): Promise<void> {
    this.events.emit('disconnect');
  }

  /** Sends a notification as if the scale had pushed it. */
  public notify(characteristic: string, data: Buffer): void {
    this.listeners.get(characteristic)?.(data);
  }

  public writesTo(characteristic: string): string[] {
    return this.writes.filter((write) => write.characteristic === characteristic).map((write) => write.data.toString('hex'));
  }

  private handleControlPoint(request: Buffer): void {
    const respond = (result: number, ...parameter: number[]): void => {
      if (this.respondToControlPoint) {
        this.notifyLater(Characteristic.USER_CONTROL_POINT, Buffer.from([0x20, request[0], result, ...parameter]));
      }
    };
    switch (request[0]) {
      case 0x01: {
        const userIndex = [1, 2, 3, 4, 5, 6, 7, 8].find((index) => !this.users.has(index));
        if (userIndex === undefined) {
          respond(0x04);
          return;
        }
        this.users.set(userIndex, request.readUInt16LE(1));
        respond(0x01, userIndex);
        return;
      }
      case 0x02: {
        const userIndex = request[1];
        // like the BF500: an unknown slot fails, a known one with the wrong code is not authorized
        if (!this.users.has(userIndex)) {
          respond(0x04);
          return;
        }
        if (this.users.get(userIndex) !== request.readUInt16LE(2)) {
          respond(0x05);
          return;
        }
        this.loggedIn = userIndex;
        this.values.set(Characteristic.USER_INDEX, Buffer.from([userIndex]));
        respond(0x01);
        return;
      }
      case 0x03: {
        if (this.loggedIn === undefined) {
          respond(0x05);
          return;
        }
        this.users.delete(this.loggedIn);
        this.loggedIn = undefined;
        respond(0x01);
        return;
      }
      default:
        respond(0x02);
    }
  }

  private notifyLater(characteristic: string, data: Buffer): void {
    setImmediate(() => this.notify(characteristic, data));
  }
}
