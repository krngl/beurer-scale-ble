#!/usr/bin/env node
import { mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { parseArgs } from 'node:util';

import { Bf500 } from './Bf500';
import { Bluez, type BluezDevice } from './bluez';
import { isLoginRejected } from './errors';
import { Gender, type Measurement, type UserCredentials, type UserProfile } from './types';
import { watch } from './watch';

const USAGE = `Usage: bf500 <command> [options]

Commands:
  pair                 Bond with the scale (press SET on the scale when it shows a code)
  weigh                Take a measurement and print it
  watch                Wait for weighings and print each one, until stopped
  profile              Update the saved user's profile on the scale
  users                List the user slots on the scale
  info                 Print device information and battery level
  delete-user          Delete the saved user from the scale

Options:
  --address <mac>      Scale MAC address (default: first scale named BF500)
  --adapter <name>     Bluetooth adapter, e.g. hci0 (default: first adapter)
  --register           weigh: register a new user even if one is saved
  --birth <date>       Date of birth, YYYY-MM-DD   } required when registering
  --gender <gender>    male | female               } a user, and for profile
  --height <cm>        Height in cm                }
  --timeout <seconds>  weigh: how long to wait for a measurement (default: 60)
  --json               weigh, watch, users: print JSON (watch: one measurement per line)
  -h, --help           Show this help
`;

const { values: options, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    address: { type: 'string' },
    adapter: { type: 'string' },
    register: { type: 'boolean', default: false },
    birth: { type: 'string' },
    gender: { type: 'string' },
    height: { type: 'string' },
    timeout: { type: 'string', default: '60' },
    json: { type: 'boolean', default: false },
    help: { type: 'boolean', short: 'h', default: false },
  },
});

class UsageError extends Error {}

const log = (message: string): void => {
  process.stderr.write(`${message}\n`);
};

const configDir = (): string => join(process.env.XDG_CONFIG_HOME ?? join(homedir(), '.config'), 'beurer-scale-ble');
const credentialsFile = ({ address }: Pick<BluezDevice, 'address'>): string =>
  join(configDir(), `${address.replaceAll(':', '').toLowerCase()}.json`);

const loadCredentials = async (device: Pick<BluezDevice, 'address'>): Promise<UserCredentials | undefined> => {
  try {
    const { userIndex, consentCode } = JSON.parse(await readFile(credentialsFile(device), 'utf8')) as Partial<UserCredentials>;
    return typeof userIndex === 'number' && typeof consentCode === 'number' ? { userIndex, consentCode } : undefined;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return undefined;
    }
    throw error;
  }
};

const saveCredentials = async (device: BluezDevice, credentials: UserCredentials): Promise<void> => {
  await mkdir(configDir(), { recursive: true });
  await writeFile(credentialsFile(device), `${JSON.stringify(credentials)}\n`, { mode: 0o600 });
};

const parseProfile = (): UserProfile => {
  const { birth, gender, height } = options;
  if (!birth || !gender || !height) {
    throw new UsageError('--birth, --gender and --height are required');
  }
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(birth);
  if (!match) {
    throw new UsageError('--birth must be YYYY-MM-DD');
  }
  const genders: Record<string, Gender> = { male: Gender.MALE, female: Gender.FEMALE };
  if (!(gender in genders)) {
    throw new UsageError('--gender must be male or female');
  }
  const heightCm = Number(height);
  if (!Number.isInteger(heightCm) || heightCm < 50 || heightCm > 250) {
    throw new UsageError('--height must be a whole number of centimetres');
  }
  return {
    birthDate: { year: Number(match[1]), month: Number(match[2]), day: Number(match[3]) },
    gender: genders[gender],
    heightCm,
  };
};

const formatMeasurement = ({ weight, bodyComposition }: Measurement): string => {
  const lines = [`Weight: ${weight.weight.toFixed(2)} ${weight.unit}`];
  if (weight.userIndex !== undefined) {
    lines.push(`User:   ${weight.userIndex === 0xff ? 'unknown' : weight.userIndex}`);
  }
  if (weight.timestamp) {
    lines.push(`Time:   ${weight.timestamp.toLocaleString()}`);
  }
  if (weight.bmi !== undefined) {
    lines.push(`BMI:    ${weight.bmi.toFixed(1)}`);
  }
  if (bodyComposition) {
    lines.push(
      bodyComposition.bodyFat === undefined
        ? 'Body fat: not measured (stand on the scale barefoot)'
        : `Body fat: ${bodyComposition.bodyFat.toFixed(1)} %`,
    );
    if (bodyComposition.muscle !== undefined) {
      lines.push(`Muscle:   ${bodyComposition.muscle.toFixed(1)} %`);
    }
    if (bodyComposition.bodyWaterMass !== undefined) {
      lines.push(`Water:    ${bodyComposition.bodyWaterMass.toFixed(1)} ${bodyComposition.unit}`);
    }
  }
  return lines.join('\n');
};

/** Scans for the scale, connects and runs `action` with a session. */
const withScale = async (
  bluez: Bluez,
  signal: AbortSignal,
  action: (scale: Bf500, device: BluezDevice) => Promise<void>,
  prompt = 'Waiting for the scale...',
): Promise<void> => {
  log(prompt);
  const device = await bluez.scan({ address: options.address, signal });
  log(`Found ${device.address}, connecting...`);
  const scale = await Bf500.create(await bluez.connect(device));
  try {
    await action(scale, device);
  } finally {
    await scale.disconnect().catch(() => undefined);
  }
};

/** The address of the only scale with saved credentials. */
const savedScaleAddress = async (): Promise<string> => {
  const files = await readdir(configDir()).catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') {
      return [];
    }
    throw error;
  });
  const scales = files.filter((file) => /^[0-9a-f]{12}\.json$/.test(file));
  if (scales.length !== 1) {
    throw new UsageError(
      scales.length === 0
        ? 'No saved user. Run "bf500 weigh" with --birth, --gender and --height first.'
        : `Users for several scales are saved in ${configDir()}; pick one with --address.`,
    );
  }
  return (scales[0].slice(0, 12).match(/../g) ?? []).join(':').toUpperCase();
};

const requireCredentials = async (device: Pick<BluezDevice, 'address'>): Promise<UserCredentials> => {
  const credentials = await loadCredentials(device);
  if (!credentials) {
    throw new UsageError('No saved user for this scale. Run "bf500 weigh" with --birth, --gender and --height first.');
  }
  return credentials;
};

const login = async (scale: Bf500, credentials: UserCredentials): Promise<void> => {
  try {
    await scale.login(credentials);
  } catch (error) {
    if (isLoginRejected(error)) {
      throw new UsageError(
        `The scale rejected saved user ${credentials.userIndex} (deleted or scale reset?). Register again with --register.`,
      );
    }
    throw error;
  }
};

const commands: Record<string, (bluez: Bluez, signal: AbortSignal) => Promise<void>> = {
  async pair(bluez, signal) {
    log('Waiting for the scale - tap or step on it...');
    let device = await bluez.scan({ address: options.address, signal });
    if (await bluez.isPaired(device)) {
      log('Removing the existing bond...');
      await bluez.forget(device);
      device = await bluez.scan({ address: device.address, signal });
    }
    log(`Pairing with ${device.address}...`);
    await bluez.pair(device, { onCode: (code) => log(`Code ${code} - press SET on the scale to confirm.`) });
    log('Paired.');
  },

  async weigh(bluez, signal) {
    const timeoutMs = Number(options.timeout) * 1000;
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
      throw new UsageError('--timeout must be a positive number of seconds');
    }
    // validate before connecting: the scale goes back to sleep quickly
    const profile = options.register || options.birth || options.gender || options.height ? parseProfile() : undefined;

    await withScale(
      bluez,
      signal,
      async (scale, device) => {
        let credentials = options.register ? undefined : await loadCredentials(device);
        if (credentials) {
          await login(scale, credentials);
        } else {
          if (!profile) {
            throw new UsageError('No saved user for this scale. Pass --birth, --gender and --height to register one.');
          }
          credentials = await scale.registerUser();
          await saveCredentials(device, credentials);
          log(`Registered as user ${credentials.userIndex} (saved to ${credentialsFile(device)}).`);
          await scale.login(credentials);
          await scale.setUserProfile(profile);
        }

        await scale.setTime();
        log('Waiting for the measurement - if the scale shows no weight, step on it again and stay until it is stable...');
        const measurement = await scale.measure({ timeoutMs, signal });
        process.stdout.write(`${options.json ? JSON.stringify(measurement) : formatMeasurement(measurement)}\n`);
      },
      'Waiting for the scale - step on it...',
    );
  },

  async watch(bluez, signal) {
    const address = options.address ?? (await savedScaleAddress());
    const credentials = await requireCredentials({ address });
    log(`Watching ${address} as user ${credentials.userIndex}. Measurements are printed shortly after each weighing.`);
    await watch(bluez, {
      address,
      credentials,
      signal,
      onConnect: (_device, user) => log(`The scale has a new measurement for user ${user.userIndex}, fetching it...`),
      onError: (error) => log(`${error.name}: ${error.message}`),
      onMeasurement: (measurement) => {
        process.stdout.write(options.json ? `${JSON.stringify(measurement)}\n` : `${formatMeasurement(measurement)}\n\n`);
      },
    }).catch((error: unknown) => {
      if (isLoginRejected(error)) {
        throw new UsageError(
          `The scale rejected saved user ${credentials.userIndex} (deleted or scale reset?). Register again with "bf500 weigh --register".`,
        );
      }
      throw error;
    });
  },

  async profile(bluez, signal) {
    const profile = parseProfile();
    await withScale(bluez, signal, async (scale, device) => {
      await login(scale, await requireCredentials(device));
      await scale.setUserProfile(profile);
      log('Profile updated.');
    });
  },

  async users(bluez, signal) {
    await withScale(bluez, signal, async (scale, device) => {
      const users = await scale.getUserList();
      if (options.json) {
        process.stdout.write(`${JSON.stringify(users)}\n`);
        return;
      }
      const saved = (await loadCredentials(device))?.userIndex;
      const pad = (value: number): string => String(value).padStart(2, '0');
      const lines = users.map(
        ({ userIndex, initials, birthDate: { year, month, day }, heightCm, activityLevel }) =>
          `User ${userIndex}: born ${year}-${pad(month)}-${pad(day)}, ${heightCm} cm, activity level ${activityLevel}` +
          `${initials ? `, initials ${initials}` : ''}${userIndex === saved ? ' (saved credentials)' : ''}`,
      );
      process.stdout.write(`${lines.length > 0 ? lines.join('\n') : 'No users.'}\n`);
    });
  },

  async info(bluez, signal) {
    await withScale(bluez, signal, async (scale) => {
      const info = await scale.getDeviceInfo();
      process.stdout.write(
        `${[
          `Manufacturer: ${info.manufacturer}`,
          `Model:        ${info.model}`,
          `Firmware:     ${info.firmwareRevision}`,
          `Hardware:     ${info.hardwareRevision}`,
          `Software:     ${info.softwareRevision}`,
          `Battery:      ${await scale.getBatteryLevel()} %`,
        ].join('\n')}\n`,
      );
    });
  },

  async 'delete-user'(bluez, signal) {
    await withScale(bluez, signal, async (scale, device) => {
      const credentials = await requireCredentials(device);
      await login(scale, credentials);
      await scale.deleteUser();
      await rm(credentialsFile(device), { force: true });
      log(`Deleted user ${credentials.userIndex}.`);
    });
  },
};

const main = async (): Promise<number> => {
  const [command] = positionals;
  if (options.help || !command) {
    process.stdout.write(USAGE);
    return options.help ? 0 : 1;
  }
  const run = commands[command];
  if (!run) {
    log(`Unknown command "${command}".\n`);
    process.stderr.write(USAGE);
    return 1;
  }

  const abort = new AbortController();
  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    process.once(signal, () => abort.abort(new Error('Interrupted')));
  }
  const bluez = await Bluez.open({ adapter: options.adapter });
  try {
    await run(bluez, abort.signal);
    return 0;
  } catch (error) {
    log(error instanceof UsageError ? error.message : `${(error as Error).name}: ${(error as Error).message}`);
    return 1;
  } finally {
    await bluez.close();
  }
};

main().then(
  (code) => process.exit(code),
  (error: unknown) => {
    log(String(error));
    process.exit(1);
  },
);
