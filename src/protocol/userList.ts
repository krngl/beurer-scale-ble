import { ProtocolError } from '../errors';
import type { UserListEntry } from '../types';

const ENTRY = 0x00;
const ENTRY_LENGTH = 12;
const UNSET = 0xff;

/** Beurer vendor User List (0xFFF1): writing `00` makes the scale send one notification per user slot. */
export const encodeUserListRequest = (): Buffer => Buffer.from([ENTRY]);

/** The scale ends the user list with a single byte (`01`). */
export const isUserListEnd = (data: Buffer): boolean => data.length === 1;

/**
 * One user list entry: `00`, user index, 3 bytes of initials (`ff` = unset), birth year u16, month, day,
 * height u16 (cm), activity level.
 */
export const parseUserListEntry = (data: Buffer): UserListEntry => {
  if (data.length < ENTRY_LENGTH || data[0] !== ENTRY) {
    throw new ProtocolError(`unexpected User List notification [data="${data.toString('hex')}"]`);
  }
  const initials = data.subarray(2, 5).filter((byte) => byte !== UNSET);
  return {
    userIndex: data[1],
    initials: initials.length > 0 ? Buffer.from(initials).toString('latin1') : undefined,
    birthDate: { year: data.readUInt16LE(5), month: data[7], day: data[8] },
    heightCm: data.readUInt16LE(9),
    activityLevel: data[11],
  };
};
