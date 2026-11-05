export type MassUnit = 'kg' | 'lb';

export interface WeightMeasurement {
  /** Weight in `unit`. */
  weight: number;
  unit: MassUnit;
  /** Scale clock at the time of the measurement. */
  timestamp?: Date;
  /** Scale user slot (1..8), or 0xff if the scale could not assign the measurement to a user. */
  userIndex?: number;
  bmi?: number;
  /** Height used for the BMI, in metres (kg) or inches (lb). */
  height?: number;
}

/**
 * Values that need the impedance (body fat, muscle, water, ...) are missing when the scale could not measure it,
 * e.g. when the person was not barefoot. The scale then shows "bf --".
 */
export interface BodyCompositionMeasurement {
  unit: MassUnit;
  /** Body fat in percent. */
  bodyFat?: number;
  timestamp?: Date;
  userIndex?: number;
  /** Basal metabolism in kilojoules. */
  basalMetabolism?: number;
  /** Muscle percentage. */
  muscle?: number;
  muscleMass?: number;
  fatFreeMass?: number;
  softLeanMass?: number;
  bodyWaterMass?: number;
  /** Impedance in ohms. */
  impedance?: number;
  weight?: number;
  height?: number;
}

export interface Measurement {
  weight: WeightMeasurement;
  /** Sent by the scale right after the weight; missing if it did not arrive in time. */
  bodyComposition?: BodyCompositionMeasurement;
}
