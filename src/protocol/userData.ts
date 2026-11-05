import type { Gender, UserProfile } from '../types';

/** Date of Birth (0x2A85): year u16, month, day */
export const encodeDateOfBirth = ({ year, month, day }: UserProfile['birthDate']): Buffer => {
  const data = Buffer.alloc(4);
  data.writeUInt16LE(year, 0);
  data.writeUInt8(month, 2);
  data.writeUInt8(day, 3);
  return data;
};

/** Gender (0x2A8C) */
export const encodeGender = (gender: Gender): Buffer => Buffer.from([gender]);

/** Height (0x2A8E): u16 in centimetres */
export const encodeHeight = (heightCm: number): Buffer => {
  const data = Buffer.alloc(2);
  data.writeUInt16LE(Math.round(heightCm), 0);
  return data;
};

/** Database Change Increment (0x2A99): u32 */
export const encodeDatabaseChangeIncrement = (value: number): Buffer => {
  const data = Buffer.alloc(4);
  data.writeUInt32LE(value >>> 0, 0);
  return data;
};

export const parseDatabaseChangeIncrement = (data: Buffer): number => data.readUInt32LE(0);
