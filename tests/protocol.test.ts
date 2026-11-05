import { describe, expect, it } from '@jest/globals';

import {
  encodeConsent,
  encodeCurrentTime,
  encodeDatabaseChangeIncrement,
  encodeDateOfBirth,
  encodeDeleteUserData,
  encodeGender,
  encodeHeight,
  encodeRegisterNewUser,
  Gender,
  isLoginRejected,
  isUserListEnd,
  ProtocolError,
  parseBodyCompositionMeasurement,
  parseDatabaseChangeIncrement,
  parseUcpResponse,
  parseUserListEntry,
  parseWeightMeasurement,
  UcpError,
  UcpOpCode,
  UcpResult,
} from '../src';

const hex = (value: string): Buffer => Buffer.from(value, 'hex');

// payloads captured from a BF500 (firmware 1.13)
describe('parseWeightMeasurement', () => {
  it('decodes weight, timestamp, user and BMI', () => {
    expect(parseWeightMeasurement(hex('0e403dea07010f081e00020001d606'))).toEqual({
      weight: 78.4,
      unit: 'kg',
      timestamp: new Date(2026, 0, 15, 8, 30, 0),
      userIndex: 2,
      bmi: 25.6,
      height: 1.75,
    });
    expect(parseWeightMeasurement(hex('0ebc3eea070110081f02010601d606'))).toMatchObject({ weight: 80.3, userIndex: 1, bmi: 26.2 });
  });

  it('decodes the minimal form', () => {
    expect(parseWeightMeasurement(hex('00443d'))).toEqual({ weight: 78.42, unit: 'kg' });
  });

  it('decodes imperial units', () => {
    expect(parseWeightMeasurement(hex('018443'))).toEqual({ weight: 172.84, unit: 'lb' });
  });

  it('leaves out an unknown timestamp', () => {
    expect(parseWeightMeasurement(hex('02443d00000000000000'))?.timestamp).toBeUndefined();
  });

  it('returns undefined for an unsuccessful measurement', () => {
    expect(parseWeightMeasurement(hex('00ffff'))).toBeUndefined();
  });

  it('rejects truncated data', () => {
    expect(() => parseWeightMeasurement(hex('0e403dea07'))).toThrow(ProtocolError);
  });
});

describe('parseBodyCompositionMeasurement', () => {
  it('decodes the fields flagged by the BF500', () => {
    expect(parseBodyCompositionMeasurement(hex('98030000841c0000000000000000'))).toEqual({
      unit: 'kg',
      basalMetabolism: 7300,
    });
  });

  it('decodes a full measurement', () => {
    // flags: timestamp, user, basal metabolism, muscle %, muscle mass, fat free mass, soft lean mass, water, impedance, weight, height
    const data = hex(
      'fe0f' + 'fa00' + 'ea07010f081e00' + '01' + 'e81c' + 'b401' + '5039' + 'a861' + '1027' + '4038' + 'a00f' + '403d' + 'd606',
    );
    expect(parseBodyCompositionMeasurement(data)).toEqual({
      unit: 'kg',
      bodyFat: 25,
      timestamp: new Date(2026, 0, 15, 8, 30, 0),
      userIndex: 1,
      basalMetabolism: 7400,
      muscle: 43.6,
      muscleMass: 73.36,
      fatFreeMass: 125,
      softLeanMass: 50,
      bodyWaterMass: 72,
      impedance: 400,
      weight: 78.4,
      height: 1.75,
    });
  });

  it('returns undefined for an unsuccessful measurement', () => {
    expect(parseBodyCompositionMeasurement(hex('0000ffff'))).toBeUndefined();
  });
});

describe('User Control Point', () => {
  it('encodes requests as sent to the BF500', () => {
    expect(encodeRegisterNewUser(4942).toString('hex')).toBe('014e13');
    expect(encodeConsent(2, 4942).toString('hex')).toBe('02024e13');
    expect(encodeDeleteUserData().toString('hex')).toBe('03');
  });

  it('validates consent code and user index', () => {
    expect(() => encodeRegisterNewUser(10_000)).toThrow(RangeError);
    expect(() => encodeRegisterNewUser(1.5)).toThrow(RangeError);
    expect(() => encodeConsent(0xff, 1)).toThrow(RangeError);
  });

  it('parses responses', () => {
    expect(parseUcpResponse(hex('20010102'))).toEqual({
      requestOpCode: UcpOpCode.REGISTER_NEW_USER,
      result: UcpResult.SUCCESS,
      parameter: hex('02'),
    });
    expect(parseUcpResponse(hex('200205'))).toMatchObject({ requestOpCode: UcpOpCode.CONSENT, result: UcpResult.USER_NOT_AUTHORIZED });
    expect(() => parseUcpResponse(hex('0102'))).toThrow(ProtocolError);
  });
});

describe('user data', () => {
  it('encodes the profile characteristics', () => {
    expect(encodeDateOfBirth({ year: 1990, month: 1, day: 31 }).toString('hex')).toBe('c607011f');
    expect(encodeGender(Gender.FEMALE).toString('hex')).toBe('01');
    expect(encodeHeight(175).toString('hex')).toBe('af00');
  });

  it('round-trips the database change increment', () => {
    expect(parseDatabaseChangeIncrement(encodeDatabaseChangeIncrement(258))).toBe(258);
    expect(encodeDatabaseChangeIncrement(1).toString('hex')).toBe('01000000');
  });
});

describe('encodeCurrentTime', () => {
  it('encodes local time with the day of week', () => {
    // Thursday
    expect(encodeCurrentTime(new Date(2026, 10, 5, 16, 51, 5)).toString('hex')).toBe('ea070b05103305040000');
    // Sunday is 7
    expect(encodeCurrentTime(new Date(2026, 10, 8, 0, 0, 0))[7]).toBe(7);
  });
});

describe('user list', () => {
  it('decodes entries', () => {
    expect(parseUserListEntry(hex('0001ffffffc6070101af0003'))).toEqual({
      userIndex: 1,
      initials: undefined,
      birthDate: { year: 1990, month: 1, day: 1 },
      heightCm: 175,
      activityLevel: 3,
    });
    expect(parseUserListEntry(hex('0002ffffffbc07060fbe0003'))).toMatchObject({
      userIndex: 2,
      birthDate: { year: 1980, month: 6, day: 15 },
      heightCm: 190,
    });
  });

  it('decodes set initials', () => {
    expect(parseUserListEntry(hex('00014a47ffc6070101af0003')).initials).toBe('JG');
  });

  it('recognises the end of the list', () => {
    expect(isUserListEnd(hex('01'))).toBe(true);
    expect(isUserListEnd(hex('0001ffffffc6070101af0003'))).toBe(false);
  });

  it('rejects other data', () => {
    expect(() => parseUserListEntry(hex('0001ff'))).toThrow(ProtocolError);
    expect(() => parseUserListEntry(hex('0101ffffffc6070101af0003'))).toThrow(ProtocolError);
  });
});

describe('isLoginRejected', () => {
  it('covers a wrong consent code and a missing slot, for logins only', () => {
    expect(isLoginRejected(new UcpError(UcpOpCode.CONSENT, UcpResult.USER_NOT_AUTHORIZED))).toBe(true);
    expect(isLoginRejected(new UcpError(UcpOpCode.CONSENT, UcpResult.OPERATION_FAILED))).toBe(true);
    expect(isLoginRejected(new UcpError(UcpOpCode.REGISTER_NEW_USER, UcpResult.OPERATION_FAILED))).toBe(false);
    expect(isLoginRejected(new Error('other'))).toBe(false);
  });
});
