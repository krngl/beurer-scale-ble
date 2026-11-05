import { type DefinedInterface, defineInterface } from 'dbus-native';

export type CodeListener = (code: string) => void;

const rejected = (what: string): never => {
  throw Object.assign(new Error(`${what} is not supported`), { dbusName: 'org.bluez.Error.Rejected' });
};

const nothing = (): null => null;

/**
 * BlueZ pairing agent (org.bluez.Agent1) for the "KeyboardDisplay" capability.
 *
 * The BF500 pairs with LE Secure Connections numeric comparison: both sides show the same 6-digit code. The agent
 * accepts it on the host side right away; the user's confirmation is pressing SET on the scale.
 */
export const pairingAgent = (onCode?: CodeListener): DefinedInterface => {
  const showPasskey = ({ passkey }: { passkey: number }): null => {
    onCode?.(passkey.toString().padStart(6, '0'));
    return null;
  };
  return defineInterface({
    name: 'org.bluez.Agent1',
    methods: {
      Release: { handler: nothing },
      RequestConfirmation: { in: { device: 'o', passkey: 'u' }, handler: showPasskey },
      DisplayPasskey: { in: { device: 'o', passkey: 'u', entered: 'q' }, handler: showPasskey },
      DisplayPinCode: {
        in: { device: 'o', pincode: 's' },
        handler: ({ pincode }: { pincode: string }) => {
          onCode?.(pincode);
          return null;
        },
      },
      RequestPasskey: { in: { device: 'o' }, out: { passkey: 'u' }, handler: () => rejected('Passkey entry') },
      RequestPinCode: { in: { device: 'o' }, out: { pincode: 's' }, handler: () => rejected('PIN code entry') },
      RequestAuthorization: { in: { device: 'o' }, handler: nothing },
      AuthorizeService: { in: { device: 'o', uuid: 's' }, handler: nothing },
      Cancel: { handler: nothing },
    },
  });
};
