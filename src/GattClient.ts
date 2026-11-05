export type NotificationListener = (data: Buffer) => void;

export interface WriteOptions {
  /** Write without response ("command") instead of a write request. */
  withoutResponse?: boolean;
}

/**
 * A connected GATT client. Characteristics are addressed by their full 128-bit UUID (lower case).
 * `BluezGattClient` implements this for Linux; anything else (tests, other stacks) can too.
 */
export interface GattClient {
  read(characteristic: string): Promise<Buffer>;
  write(characteristic: string, data: Buffer, options?: WriteOptions): Promise<void>;
  /** Enables notifications/indications. Resolves to a function that disables them again. */
  subscribe(characteristic: string, listener: NotificationListener): Promise<() => Promise<void>>;
  /** Registers a listener for the connection being lost. Returns a function that removes it. */
  onDisconnect(listener: () => void): () => void;
  disconnect(): Promise<void>;
}
