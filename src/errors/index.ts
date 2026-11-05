import { UcpOpCode, UcpResult } from '../types';

class ScaleNotFoundError extends Error {
  override readonly name = 'ScaleNotFoundError';

  constructor(message = 'No scale found. Wake it up by tapping or stepping on it.') {
    super(message);
  }
}

class TimeoutError extends Error {
  override readonly name = 'TimeoutError';
}

/** The scale disconnected while an operation was waiting for it (it usually goes to sleep). */
class DisconnectedError extends Error {
  override readonly name = 'DisconnectedError';

  constructor(message = 'The scale disconnected.') {
    super(message);
  }
}

/** Data received from the scale could not be decoded. */
class ProtocolError extends Error {
  override readonly name = 'ProtocolError';
}

/** The scale rejected a User Control Point request (register, login, delete). */
class UcpError extends Error {
  override readonly name = 'UcpError';

  constructor(
    public readonly opCode: UcpOpCode,
    public readonly result: UcpResult,
  ) {
    super(`User Control Point request failed [opCode="${UcpOpCode[opCode] ?? opCode}", result="${UcpResult[result] ?? result}"]`);
  }
}

/** Bonding with the scale failed. `reason` is the BlueZ error name, e.g. `org.bluez.Error.AuthenticationCanceled`. */
class PairingError extends Error {
  override readonly name = 'PairingError';

  constructor(
    public readonly reason: string,
    message?: string,
  ) {
    super(`Pairing failed [reason="${reason}"]${message ? `: ${message}` : ''}`);
  }
}

/**
 * The scale refused a `login()`: the consent code is wrong (`USER_NOT_AUTHORIZED`), or the slot doesn't exist, e.g.
 * after `deleteUser()` or a factory reset (`OPERATION_FAILED`).
 */
const isLoginRejected = (error: unknown): error is UcpError =>
  error instanceof UcpError &&
  error.opCode === UcpOpCode.CONSENT &&
  (error.result === UcpResult.USER_NOT_AUTHORIZED || error.result === UcpResult.OPERATION_FAILED);

export { DisconnectedError, isLoginRejected, PairingError, ProtocolError, ScaleNotFoundError, TimeoutError, UcpError };
