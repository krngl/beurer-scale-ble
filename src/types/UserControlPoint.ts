/** User Data Service: User Control Point (0x2A9F) op codes */
export enum UcpOpCode {
  REGISTER_NEW_USER = 0x01,
  CONSENT = 0x02,
  DELETE_USER_DATA = 0x03,
  RESPONSE = 0x20,
}

/** User Data Service: User Control Point (0x2A9F) response values */
export enum UcpResult {
  SUCCESS = 0x01,
  OP_CODE_NOT_SUPPORTED = 0x02,
  INVALID_PARAMETER = 0x03,
  OPERATION_FAILED = 0x04,
  USER_NOT_AUTHORIZED = 0x05,
}
