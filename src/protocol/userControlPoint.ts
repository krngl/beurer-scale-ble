import { ProtocolError } from '../errors';
import { UcpOpCode, UcpResult } from '../types';

export interface UcpResponse {
  requestOpCode: UcpOpCode;
  result: UcpResult;
  /** Response parameter, e.g. the new user index for REGISTER_NEW_USER. */
  parameter: Buffer;
}

const assertConsentCode = (consentCode: number): void => {
  if (!Number.isInteger(consentCode) || consentCode < 0 || consentCode > 9999) {
    throw new RangeError(`consent code must be an integer in 0..9999 [consentCode="${consentCode}"]`);
  }
};

const assertUserIndex = (userIndex: number): void => {
  if (!Number.isInteger(userIndex) || userIndex < 0 || userIndex > 0xfe) {
    throw new RangeError(`user index must be an integer in 0..254 [userIndex="${userIndex}"]`);
  }
};

export const encodeRegisterNewUser = (consentCode: number): Buffer => {
  assertConsentCode(consentCode);
  const data = Buffer.alloc(3);
  data.writeUInt8(UcpOpCode.REGISTER_NEW_USER, 0);
  data.writeUInt16LE(consentCode, 1);
  return data;
};

export const encodeConsent = (userIndex: number, consentCode: number): Buffer => {
  assertUserIndex(userIndex);
  assertConsentCode(consentCode);
  const data = Buffer.alloc(4);
  data.writeUInt8(UcpOpCode.CONSENT, 0);
  data.writeUInt8(userIndex, 1);
  data.writeUInt16LE(consentCode, 2);
  return data;
};

/** Deletes the user data of the logged-in user. */
export const encodeDeleteUserData = (): Buffer => Buffer.from([UcpOpCode.DELETE_USER_DATA]);

export const parseUcpResponse = (data: Buffer): UcpResponse => {
  if (data.length < 3 || data[0] !== UcpOpCode.RESPONSE) {
    throw new ProtocolError(`unexpected User Control Point indication [data="${data.toString('hex')}"]`);
  }
  return { requestOpCode: data[1], result: data[2], parameter: data.subarray(3) };
};
