import { type CallOptions, DBusError, type MessageBus } from 'dbus-native';

import { TimeoutError } from '../errors';

export const BLUEZ = 'org.bluez';

export enum Interface {
  PROPERTIES = 'org.freedesktop.DBus.Properties',
  ADAPTER = 'org.bluez.Adapter1',
  DEVICE = 'org.bluez.Device1',
  AGENT_MANAGER = 'org.bluez.AgentManager1',
  GATT_CHARACTERISTIC = 'org.bluez.GattCharacteristic1',
}

/** Properties of one interface, as plain values (`ay` as `Buffer`, `a{sv}` as an object). */
export type Properties = Record<string, unknown>;

export interface Call {
  path: string;
  iface: Interface;
  member: string;
  /** D-Bus signature of `body` */
  signature?: string;
  body?: unknown[];
}

/**
 * Calls a BlueZ method. Throws our `TimeoutError` when no reply arrives in time (the client default is 25 s), and
 * dbus-native's `DBusError` (see `dbusName`) for error replies.
 */
export const call = async <T = void>(
  bus: MessageBus,
  { path, iface, member, signature, body }: Call,
  options: CallOptions = {},
): Promise<T> => {
  try {
    return await bus.invoke<T>({ destination: BLUEZ, path, interface: iface, member, ...(signature && { signature, body }) }, options);
  } catch (error) {
    if ((error as { code?: unknown }).code === 'ETIMEDOUT') {
      throw new TimeoutError(`Timed out after ${(error as { timeout?: number }).timeout} ms waiting for ${member}`);
    }
    throw error;
  }
};

export const getProperty = (bus: MessageBus, path: string, iface: Interface, name: string): Promise<unknown> =>
  call(bus, { path, iface: Interface.PROPERTIES, member: 'Get', signature: 'ss', body: [iface, name] });

export const isDbusError = (error: unknown): error is DBusError & { dbusName: string } =>
  error instanceof DBusError && typeof error.dbusName === 'string';

/**
 * Rejects with `TimeoutError` if `promise` doesn't settle in time. A late rejection of `promise` is swallowed.
 */
export const withTimeout = <T>(promise: Promise<T>, timeoutMs: number, what: string): Promise<T> => {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new TimeoutError(`Timed out after ${timeoutMs} ms ${what}`)), timeoutMs);
  });
  promise.catch(() => undefined);
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
};
