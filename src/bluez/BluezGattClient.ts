import { EventEmitter } from 'node:events';
import type { ManagedObjects, MessageBus } from 'dbus-native';

import type { GattClient, NotificationListener, WriteOptions } from '../GattClient';
import { call, Interface, type Properties } from './dbus';

interface Subscription {
  path: string;
  listener: NotificationListener;
}

/** `GattClient` on top of BlueZ's D-Bus API. Created by `Bluez.connect()`. */
export class BluezGattClient implements GattClient {
  private readonly events = new EventEmitter<{ disconnect: [] }>();
  private readonly subscriptions = new Set<Subscription>();
  private closed = false;

  private readonly onChanged = (path: string, iface: string, changed: Properties): void => {
    if (iface === Interface.GATT_CHARACTERISTIC && Buffer.isBuffer(changed.Value)) {
      for (const subscription of this.subscriptions) {
        if (subscription.path === path) {
          subscription.listener(changed.Value);
        }
      }
    } else if (path === this.devicePath && iface === Interface.DEVICE && changed.Connected === false) {
      this.close();
      this.events.emit('disconnect');
    }
  };

  /** @internal */
  public constructor(
    private readonly bus: MessageBus,
    private readonly objects: ManagedObjects,
    private readonly devicePath: string,
    /** characteristic UUID → object path */
    private readonly characteristics: ReadonlyMap<string, string>,
  ) {
    objects.on('changed', this.onChanged);
  }

  public async read(characteristic: string): Promise<Buffer> {
    return call<Buffer>(this.bus, { ...this.characteristic(characteristic), member: 'ReadValue', signature: 'a{sv}', body: [{}] });
  }

  public async write(characteristic: string, data: Buffer, { withoutResponse = false }: WriteOptions = {}): Promise<void> {
    await call(this.bus, {
      ...this.characteristic(characteristic),
      member: 'WriteValue',
      signature: 'aya{sv}',
      body: [data, { type: withoutResponse ? 'command' : 'request' }],
    });
  }

  public async subscribe(characteristic: string, listener: NotificationListener): Promise<() => Promise<void>> {
    const target = this.characteristic(characteristic);
    const subscription: Subscription = { path: target.path, listener };
    this.subscriptions.add(subscription);
    try {
      await call(this.bus, { ...target, member: 'StartNotify' });
    } catch (error) {
      this.subscriptions.delete(subscription);
      throw error;
    }

    return async () => {
      if (this.subscriptions.delete(subscription)) {
        await call(this.bus, { ...target, member: 'StopNotify' }).catch(() => undefined);
      }
    };
  }

  public onDisconnect(listener: () => void): () => void {
    this.events.on('disconnect', listener);
    return () => this.events.off('disconnect', listener);
  }

  public async disconnect(): Promise<void> {
    if (this.closed) {
      return;
    }
    await Promise.all(
      [...this.subscriptions].map(async (subscription) => {
        this.subscriptions.delete(subscription);
        await call(this.bus, { path: subscription.path, iface: Interface.GATT_CHARACTERISTIC, member: 'StopNotify' }).catch(
          () => undefined,
        );
      }),
    );
    await call(this.bus, { path: this.devicePath, iface: Interface.DEVICE, member: 'Disconnect' });
  }

  private close(): void {
    this.closed = true;
    this.subscriptions.clear();
    this.objects.off('changed', this.onChanged);
  }

  private characteristic(characteristic: string): { path: string; iface: Interface } {
    const path = this.characteristics.get(characteristic.toLowerCase());
    if (!path) {
      throw new Error(`The scale has no characteristic ${characteristic}`);
    }
    return { path, iface: Interface.GATT_CHARACTERISTIC };
  }
}
