import { setTimeout as sleep } from 'node:timers/promises';
import { type ManagedObjects, type MessageBus, type Subscription, systemBus, Variant } from 'dbus-native';

import { PairingError, ScaleNotFoundError } from '../errors';
import { Service } from '../protocol';
import { BluezGattClient } from './BluezGattClient';
import { BLUEZ, call, getProperty, Interface, isDbusError, type Properties, withTimeout } from './dbus';
import { type CodeListener, pairingAgent } from './PairingAgent';

export interface BluezDevice {
  /** D-Bus object path, e.g. /org/bluez/hci0/dev_D8_0B_CB_5C_3C_AC */
  path: string;
  address: string;
  name?: string;
  /**
   * User slot of the measurement the scale was announcing when the scan found it (see `pendingMeasurement`), or
   * `undefined` if it had none.
   */
  pendingUserIndex?: number;
}

export interface BluezOptions {
  /** Adapter name, e.g. `hci0`. Default: the first adapter */
  adapter?: string;
}

export interface ScanOptions {
  /** Advertised name to look for. Default: `BF500` (ignored if `address` is set) */
  name?: string;
  /** MAC address to look for, e.g. `AA:BB:CC:DD:EE:FF` */
  address?: string;
  /**
   * Only resolve when the scale advertises a measurement that no host has fetched yet: `true` for any user, or a list
   * of user slots. The scale puts the slot of that measurement into its Weight Scale service data (`02` for user 2)
   * until a host fetches it. Without this option any advertisement counts: the scale advertises about every 10 s even
   * while asleep, and connecting wakes it up.
   */
  pendingMeasurement?: boolean | readonly number[];
  /** Default: 60 s */
  timeoutMs?: number;
  signal?: AbortSignal;
}

export interface PairOptions {
  /** Called with the 6-digit code; the scale shows the same code. Press SET on the scale to confirm. */
  onCode?: CodeListener;
  /** How long to wait for the SET press. Default: 60 s */
  timeoutMs?: number;
}

export interface ConnectOptions {
  /** Default: 30 s */
  timeoutMs?: number;
}

const AGENT_PATH = '/dev/krngl/beurer_scale_ble/agent';

/**
 * `bus.objects()` subscribes to property changes with `path_namespace='/'`, which dbus-broker doesn't deliver, so the
 * view would never see advertisements, notifications or disconnects. This rule covers all of BlueZ's objects.
 */
const PROPERTIES_CHANGED = `type='signal',sender='${BLUEZ}',interface='${Interface.PROPERTIES}',member='PropertiesChanged'`;

const str = (props: Properties | undefined, key: string): string | undefined => {
  const value = props?.[key];
  return typeof value === 'string' ? value : undefined;
};

/**
 * The Weight Scale service data holds the user slot of a measurement no host has fetched yet, and is empty otherwise.
 * Only meaningful for properties of a fresh advertisement: BlueZ keeps the last value around.
 */
const pendingUserIndex = (props: Properties): number | undefined => {
  const data = (props.ServiceData as Record<string, unknown> | undefined)?.[Service.WEIGHT_SCALE];
  return Buffer.isBuffer(data) && data.length > 0 ? data[0] : undefined;
};

/** Signs that the device is advertising right now, as opposed to being cached by BlueZ. */
const ADVERTISEMENT_PROPERTIES = ['RSSI', 'ManufacturerData', 'ServiceData', 'TxPower'];

/** Access to a BF500 through BlueZ (Linux) over the system D-Bus. */
export class Bluez {
  private constructor(
    private readonly bus: MessageBus,
    /** BlueZ's object tree, kept up to date by its signals */
    private readonly objects: ManagedObjects,
    private readonly propertiesChanged: Subscription,
    private readonly adapterPath: string,
  ) {}

  /** Connects to the system D-Bus (`$DBUS_SYSTEM_BUS_ADDRESS` or the default socket). */
  public static async open({ adapter }: BluezOptions = {}): Promise<Bluez> {
    const bus = systemBus();
    try {
      const propertiesChanged = await bus.watch(PROPERTIES_CHANGED);
      const objects = await bus.objects(BLUEZ, '/');
      const adapters = Object.keys(objects.filter(Interface.ADAPTER));
      const adapterPath = adapter ? adapters.find((path) => path.endsWith(`/${adapter}`)) : adapters.sort()[0];
      if (!adapterPath) {
        throw new Error(adapter ? `Bluetooth adapter ${adapter} not found` : 'No Bluetooth adapter found');
      }
      return new Bluez(bus, objects, propertiesChanged, adapterPath);
    } catch (error) {
      await bus.close().catch(() => undefined);
      throw error;
    }
  }

  /** Closes the D-Bus connection. */
  public async close(): Promise<void> {
    await this.objects.close().catch(() => undefined);
    await this.propertiesChanged.remove().catch(() => undefined);
    await this.bus.close();
  }

  /**
   * Waits until the scale advertises: about every 10 s while asleep, more often while awake. With `pendingMeasurement`,
   * waits until it has a measurement to fetch (see `BluezDevice.pendingUserIndex`). Throws `ScaleNotFoundError` on
   * timeout.
   */
  public async scan({
    name = 'BF500',
    address,
    pendingMeasurement = false,
    timeoutMs = 60_000,
    signal,
  }: ScanOptions = {}): Promise<BluezDevice> {
    const matches = (props: Properties): boolean =>
      address ? str(props, 'Address')?.toUpperCase() === address.toUpperCase() : (str(props, 'Name') ?? str(props, 'Alias')) === name;
    const wanted = (advertised: Properties): boolean => {
      if (!pendingMeasurement) {
        return true;
      }
      const userIndex = pendingUserIndex(advertised);
      return userIndex !== undefined && (pendingMeasurement === true || pendingMeasurement.includes(userIndex));
    };
    /** `advertised`: the properties the advertisement itself carried, as opposed to what BlueZ had cached */
    const found = (path: string, props: Properties, advertised: Properties): BluezDevice | undefined =>
      this.isOwnDevice(path) && matches(props) && wanted(advertised)
        ? { path, address: str(props, 'Address') ?? '', name: str(props, 'Name'), pendingUserIndex: pendingUserIndex(advertised) }
        : undefined;

    signal?.throwIfAborted();
    const cleanups: Array<() => void> = [];
    try {
      const result = new Promise<BluezDevice>((resolve, reject) => {
        // a device BlueZ doesn't know yet
        const onAdded = (path: string, ifaces: Record<string, Properties>): void => {
          const props = ifaces[Interface.DEVICE];
          const device = props && found(path, props, props);
          if (device) {
            resolve(device);
          }
        };
        // a known device: RSSI etc. change on every advertisement
        const onChanged = (path: string, iface: string, changed: Properties): void => {
          const props = this.objects.get(path)?.[Interface.DEVICE];
          const device =
            iface === Interface.DEVICE && props && ADVERTISEMENT_PROPERTIES.some((key) => key in changed) && found(path, props, changed);
          if (device) {
            resolve(device);
          }
        };
        this.objects.on('added', onAdded).on('changed', onChanged);
        cleanups.push(() => this.objects.off('added', onAdded).off('changed', onChanged));

        const timer = setTimeout(() => reject(new ScaleNotFoundError()), timeoutMs);
        cleanups.push(() => clearTimeout(timer));

        if (signal) {
          const onAbort = (): void => reject(signal.reason);
          signal.addEventListener('abort', onAbort, { once: true });
          cleanups.push(() => signal.removeEventListener('abort', onAbort));
        }
      });
      result.catch(() => undefined);

      await this.adapter('SetDiscoveryFilter', 'a{sv}', [{ Transport: 'le', DuplicateData: true }]);
      await this.adapter('StartDiscovery');
      cleanups.push(() => void this.adapter('StopDiscovery').catch(() => undefined));

      return await result;
    } finally {
      for (const cleanup of cleanups) {
        cleanup();
      }
    }
  }

  public async isPaired(device: BluezDevice): Promise<boolean> {
    return (await getProperty(this.bus, device.path, Interface.DEVICE, 'Paired')) === true;
  }

  /** Removes the device and its bond from BlueZ. Scan again before pairing. */
  public async forget(device: BluezDevice): Promise<void> {
    await this.adapter('RemoveDevice', 'o', [device.path]);
  }

  /**
   * Bonds with the scale. The scale shows a 6-digit code (also passed to `onCode`); press SET on the scale to confirm.
   * The scale must be awake and not bonded in BlueZ yet (see `isPaired()` / `forget()`).
   * Throws `PairingError` with the BlueZ reason, e.g. `org.bluez.Error.AuthenticationCanceled` when SET wasn't pressed.
   */
  public async pair(device: BluezDevice, { onCode, timeoutMs = 60_000 }: PairOptions = {}): Promise<void> {
    const agentManager = { path: '/org/bluez', iface: Interface.AGENT_MANAGER };
    const registration = await this.bus.export(AGENT_PATH, pairingAgent(onCode));
    try {
      await call(this.bus, { ...agentManager, member: 'RegisterAgent', signature: 'os', body: [AGENT_PATH, 'KeyboardDisplay'] });
      try {
        // The scale only starts pairing on an established connection. Connect() itself may not return before
        // pairing (services stay unresolved), so only the link state matters here.
        await this.device(device, 'Connect', { timeout: 10_000 }).catch(() => undefined);
        if ((await getProperty(this.bus, device.path, Interface.DEVICE, 'Connected')) !== true) {
          throw new PairingError('NotConnected', 'could not connect to the scale');
        }
        await sleep(2_000);

        try {
          // Pair() is answered by this process's agent, not the desktop's
          await this.device(device, 'Pair', { timeout: timeoutMs });
        } catch (error) {
          throw isDbusError(error) ? new PairingError(error.dbusName, error.message) : error;
        }
        await call(this.bus, {
          path: device.path,
          iface: Interface.PROPERTIES,
          member: 'Set',
          signature: 'ssv',
          body: [Interface.DEVICE, 'Trusted', new Variant('b', true)],
        });
      } finally {
        await call(this.bus, { ...agentManager, member: 'UnregisterAgent', signature: 'o', body: [AGENT_PATH] }).catch(() => undefined);
      }
    } finally {
      await registration.remove().catch(() => undefined);
      await this.device(device, 'Disconnect').catch(() => undefined);
    }
  }

  /** Connects to a bonded scale and resolves its GATT services. */
  public async connect(device: BluezDevice, { timeoutMs = 30_000 }: ConnectOptions = {}): Promise<BluezGattClient> {
    let onChanged: (path: string, iface: string, changed: Properties) => void = () => undefined;
    const resolved = new Promise<void>((resolve) => {
      onChanged = (path, iface, changed) => {
        if (path === device.path && iface === Interface.DEVICE && changed.ServicesResolved === true) {
          resolve();
        }
      };
    });
    this.objects.on('changed', onChanged);
    try {
      await this.device(device, 'Connect', { timeout: timeoutMs });
      if (this.objects.get(device.path)?.[Interface.DEVICE]?.ServicesResolved !== true) {
        await withTimeout(resolved, timeoutMs, 'resolving services');
      }
    } finally {
      this.objects.off('changed', onChanged);
    }
    return new BluezGattClient(this.bus, this.objects, device.path, this.characteristicsOf(device.path));
  }

  private adapter(member: string, signature?: string, body?: unknown[]): Promise<void> {
    return call(this.bus, { path: this.adapterPath, iface: Interface.ADAPTER, member, signature, body });
  }

  private device(device: BluezDevice, member: string, options?: { timeout: number }): Promise<void> {
    return call(this.bus, { path: device.path, iface: Interface.DEVICE, member }, options);
  }

  private isOwnDevice(path: string): boolean {
    return path.startsWith(`${this.adapterPath}/dev_`) && !path.slice(this.adapterPath.length + 1).includes('/');
  }

  /** characteristic UUID → object path */
  private characteristicsOf(devicePath: string): Map<string, string> {
    const characteristics = new Map<string, string>();
    for (const [path, props] of Object.entries(this.objects.filter(Interface.GATT_CHARACTERISTIC))) {
      const uuid = str(props, 'UUID');
      if (path.startsWith(`${devicePath}/`) && uuid) {
        characteristics.set(uuid.toLowerCase(), path);
      }
    }
    return characteristics;
  }
}
