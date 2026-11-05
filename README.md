# beurer-scale-ble

TypeScript library and CLI for the **Beurer BF500** body-fat scale over Bluetooth LE on Linux (BlueZ via D-Bus). Reads weight and body composition, manages user slots, and waits passively for weighings.

## Requirements

- Linux with BlueZ 5 and a Bluetooth LE adapter. The library talks to `bluetoothd` over the system D-Bus, so no root is needed.
- Node.js 26

> [!WARNING]
> The scale pairs with the Bluetooth debug key. BlueZ doesn't keep such bonds unless `DebugKeys` is enabled.

## CLI

```sh
bf500 pair                                                  # once: press SET on the scale when it shows a code
bf500 weigh --birth 1990-01-31 --gender male --height 180   # first time: registers a user slot
bf500 weigh                                                 # step on the scale; prints the measurement
bf500 watch                                                 # prints every weighing until stopped
```

| Command                                              | What it does                                                                         |
| ---------------------------------------------------- | ------------------------------------------------------------------------------------ |
| `pair`                                               | Bonds with the scale, removing an existing bond first.                               |
| `weigh [--register --birth … --gender … --height …]` | Logs in, sets the clock and prints a measurement. Registers a user if none is saved. |
| `watch`                                              | Prints each weighing about 10–20 s after it happens. Stops on SIGINT/SIGTERM.        |
| `users`                                              | Lists the user slots on the scale.                                                   |
| `profile --birth … --gender … --height …`            | Updates the saved user's profile, which the scale uses for BMI and body composition. |
| `info`                                               | Prints model, firmware and battery level.                                            |
| `delete-user`                                        | Deletes the saved user from the scale.                                               |

Options: `--address <mac>` (default: the first scale named `BF500`), `--adapter <hciX>`, `--json` (`weigh`, `watch`, `users`), `--timeout <s>` (`weigh`). Credentials are saved in `$XDG_CONFIG_HOME/beurer-scale-ble/<mac>.json` (default `~/.config`). From a checkout, run `yarn install && yarn build` and use `node build/src/cli.js`.

## Library

```ts
import { Bluez, watch } from '@krngl/beurer-scale-ble';

const bluez = await Bluez.open();
const stop = new AbortController();
process.once('SIGTERM', () => stop.abort());

await watch(bluez, {
  credentials, // { userIndex, consentCode } from registerUser(), or a list of them
  signal: stop.signal,
  onMeasurement: async ({ weight, bodyComposition }) => store(weight, bodyComposition),
  onError: (error) => console.warn(error.message), // watch() retries
});
await bluez.close();
```

The scale advertises about every 10 s, even while asleep, and announces the user slot of a measurement no host has fetched yet. `watch()` connects only then, logs in as that user and passes on the readings. Weighings of other users stay on the scale. Readings it already delivered are skipped; pass `seen` (their `measurementKey()`s) to keep that across restarts. It rejects only when the scale refuses a login (see `isLoginRejected()`).

- **`Bluez`**: `scan()`, `isPaired()`, `pair()`, `forget()`, `connect()`. `scan({ pendingMeasurement: true })` (or a list of slots) waits until the scale announces a measurement; the result's `pendingUserIndex` says for whom.
- **`Bf500`**: `registerUser()`, `login()`, `deleteUser()`, `setUserProfile()`, `setTime()`, `measure()` (uses a reading the scale just sent, or triggers one), `collect()` (waits for readings without triggering), `getUserList()` (all slots; no login needed, no consent codes), `getBatteryLevel()`, `getDeviceInfo()`. It emits `weight`, `bodyComposition`, `error` and `disconnect`.
- **Errors**: `ScaleNotFoundError`, `PairingError`, `UcpError`, `TimeoutError`, `DisconnectedError`, `ProtocolError`.
- `Bf500` only needs a [`GattClient`](src/GattClient.ts), so other Bluetooth stacks can be plugged in. The encoders, decoders and UUIDs are exported too.

## Protocol notes

Observed with firmware 1.13 and BlueZ 5.87.

- **Pairing:** confirm the code with SET on the scale. The scale only shows it once connected, so `pair()` connects first.
- **Users:** 8 slots. A user registers once and logs in on every connection. The scale keeps up to 30 readings per user until a host fetches them, and assigns a weighing to the user whose last weight is within ±3 kg.
- **Readings:** after login the scale sends its stored readings by itself. It can also be asked to take a new one.
- **Body composition:** body fat, muscle and water need a barefoot measurement. If it fails, the scale shows "bf --" and these values are left out.
- **User list:** any host can read all slots (birth date, height, activity level) without logging in.
- **Timing:** connecting takes 3–5 s. The scale answers slowly while it is measuring, so requests time out after 30 s.
- **Display:** "USE APP" means not set up yet, "PAir" asks for SET, "APP" means connected but nobody logged in, "U: -" means the weighing couldn't be assigned to a user. Menu and factory reset are described in the [BF 500 manual](https://res.cloudinary.com/beurer/image/upload/v1784729176/stibo-live/76011_BF500_2026-07-16_08_IM1_BEU.pdf).

## Open questions

- Whether the bond survives a restart of `bluetoothd` or a reboot.
- Body fat has failed ("bf --") in every test so far, even barefoot.
- What the scale's vendor-specific characteristics `FFF0`, `FFF2`, `FFF3`, `FFF5` and `FFF7` do.
- Whether a weighing that couldn't be assigned ("U: -") is announced.

## Development

```sh
yarn test
yarn lint
yarn build
```
