import { ProtocolError } from '../errors';
import type { BodyCompositionMeasurement, WeightMeasurement } from '../types';

/** Raw value the scale sends when a measurement was unsuccessful. */
const UNSUCCESSFUL = 0xffff;

const WeightFlag = {
  IMPERIAL: 1 << 0,
  TIMESTAMP: 1 << 1,
  USER_ID: 1 << 2,
  BMI_AND_HEIGHT: 1 << 3,
} as const;

const BodyCompositionFlag = {
  IMPERIAL: 1 << 0,
  TIMESTAMP: 1 << 1,
  USER_ID: 1 << 2,
  BASAL_METABOLISM: 1 << 3,
  MUSCLE_PERCENTAGE: 1 << 4,
  MUSCLE_MASS: 1 << 5,
  FAT_FREE_MASS: 1 << 6,
  SOFT_LEAN_MASS: 1 << 7,
  BODY_WATER_MASS: 1 << 8,
  IMPEDANCE: 1 << 9,
  WEIGHT: 1 << 10,
  HEIGHT: 1 << 11,
} as const;

/** Reads fields from a little-endian buffer front to back. */
class Reader {
  private offset = 0;

  constructor(
    private readonly data: Buffer,
    private readonly name: string,
  ) {}

  private ensure(bytes: number): void {
    if (this.offset + bytes > this.data.length) {
      throw new ProtocolError(`${this.name} too short [data="${this.data.toString('hex')}"]`);
    }
  }

  uint8(): number {
    this.ensure(1);
    const value = this.data.readUInt8(this.offset);
    this.offset += 1;
    return value;
  }

  uint16(): number {
    this.ensure(2);
    const value = this.data.readUInt16LE(this.offset);
    this.offset += 2;
    return value;
  }

  /** Bluetooth "Date Time" (0x2A08): year u16, month, day, hours, minutes, seconds. Year 0 means unknown. */
  dateTime(): Date | undefined {
    const year = this.uint16();
    const [month, day, hours, minutes, seconds] = [this.uint8(), this.uint8(), this.uint8(), this.uint8(), this.uint8()];
    return year === 0 ? undefined : new Date(year, month - 1, day, hours, minutes, seconds);
  }
}

const round = (value: number, decimals: number): number => Number(value.toFixed(decimals));

/**
 * Decodes the Weight Measurement characteristic (0x2A9D).
 *
 * Returns `undefined` if the scale reports the measurement as unsuccessful.
 */
export const parseWeightMeasurement = (data: Buffer): WeightMeasurement | undefined => {
  const reader = new Reader(data, 'Weight Measurement');
  const flags = reader.uint8();
  const imperial = (flags & WeightFlag.IMPERIAL) !== 0;
  const raw = reader.uint16();
  if (raw === UNSUCCESSFUL) {
    return undefined;
  }

  const measurement: WeightMeasurement = {
    weight: imperial ? round(raw * 0.01, 2) : round(raw * 0.005, 3),
    unit: imperial ? 'lb' : 'kg',
  };
  if (flags & WeightFlag.TIMESTAMP) {
    measurement.timestamp = reader.dateTime();
  }
  if (flags & WeightFlag.USER_ID) {
    measurement.userIndex = reader.uint8();
  }
  if (flags & WeightFlag.BMI_AND_HEIGHT) {
    measurement.bmi = round(reader.uint16() * 0.1, 1);
    measurement.height = imperial ? round(reader.uint16() * 0.1, 1) : round(reader.uint16() * 0.001, 3);
  }
  return measurement;
};

/**
 * Decodes the Body Composition Measurement characteristic (0x2A9C).
 *
 * Returns `undefined` if the scale reports the measurement as unsuccessful.
 */
export const parseBodyCompositionMeasurement = (data: Buffer): BodyCompositionMeasurement | undefined => {
  const reader = new Reader(data, 'Body Composition Measurement');
  const flags = reader.uint16();
  const imperial = (flags & BodyCompositionFlag.IMPERIAL) !== 0;
  const bodyFat = reader.uint16();
  if (bodyFat === UNSUCCESSFUL) {
    return undefined;
  }

  const mass = (): number => (imperial ? round(reader.uint16() * 0.01, 2) : round(reader.uint16() * 0.005, 3));
  // the BF500 sends 0 for every value that needs the impedance when it could not measure it (e.g. not barefoot)
  const measured = (value: number): number | undefined => (value === 0 ? undefined : value);
  const measurement: BodyCompositionMeasurement = {
    unit: imperial ? 'lb' : 'kg',
    bodyFat: measured(round(bodyFat * 0.1, 1)),
  };
  if (flags & BodyCompositionFlag.TIMESTAMP) {
    measurement.timestamp = reader.dateTime();
  }
  if (flags & BodyCompositionFlag.USER_ID) {
    measurement.userIndex = reader.uint8();
  }
  if (flags & BodyCompositionFlag.BASAL_METABOLISM) {
    measurement.basalMetabolism = reader.uint16();
  }
  if (flags & BodyCompositionFlag.MUSCLE_PERCENTAGE) {
    measurement.muscle = measured(round(reader.uint16() * 0.1, 1));
  }
  if (flags & BodyCompositionFlag.MUSCLE_MASS) {
    measurement.muscleMass = measured(mass());
  }
  if (flags & BodyCompositionFlag.FAT_FREE_MASS) {
    measurement.fatFreeMass = measured(mass());
  }
  if (flags & BodyCompositionFlag.SOFT_LEAN_MASS) {
    measurement.softLeanMass = measured(mass());
  }
  if (flags & BodyCompositionFlag.BODY_WATER_MASS) {
    measurement.bodyWaterMass = measured(mass());
  }
  if (flags & BodyCompositionFlag.IMPEDANCE) {
    measurement.impedance = measured(round(reader.uint16() * 0.1, 1));
  }
  if (flags & BodyCompositionFlag.WEIGHT) {
    measurement.weight = mass();
  }
  if (flags & BodyCompositionFlag.HEIGHT) {
    measurement.height = imperial ? round(reader.uint16() * 0.1, 1) : round(reader.uint16() * 0.001, 3);
  }
  return measurement;
};
