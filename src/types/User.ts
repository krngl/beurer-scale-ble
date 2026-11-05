/** User Data Service: Gender (0x2A8C) */
export enum Gender {
  MALE = 0,
  FEMALE = 1,
  UNSPECIFIED = 2,
}

/** What a host needs to log in to its user slot on the scale. Persist it after `registerUser()`. */
export interface UserCredentials {
  /** Scale user slot, 1..8 */
  userIndex: number;
  /** 0..9999 */
  consentCode: number;
}

/** A user slot as listed by the scale (see `Bf500.getUserList()`). */
export interface UserListEntry {
  /** 1..8 */
  userIndex: number;
  /** `undefined` when unset (all `ff`), as seen so far. The encoding of set initials is unverified. */
  initials?: string;
  birthDate: { year: number; month: number; day: number };
  heightCm: number;
  /** Most likely the activity level (1..5) from the scale's user menu. New users get 3. */
  activityLevel: number;
}

/** Used by the scale for BMI and body composition, and for its own display. */
export interface UserProfile {
  birthDate: { year: number; month: number; day: number };
  gender: Gender;
  heightCm: number;
}
