/**
 * Current Time (0x2A2B): Exact Time 256 (date time, day of week, fractions256) followed by the adjust reason.
 * The scale has no notion of time zones, so local time is sent.
 */
export const encodeCurrentTime = (date: Date): Buffer => {
  const data = Buffer.alloc(10);
  data.writeUInt16LE(date.getFullYear(), 0);
  data.writeUInt8(date.getMonth() + 1, 2);
  data.writeUInt8(date.getDate(), 3);
  data.writeUInt8(date.getHours(), 4);
  data.writeUInt8(date.getMinutes(), 5);
  data.writeUInt8(date.getSeconds(), 6);
  // day of week: 1 = Monday .. 7 = Sunday
  data.writeUInt8(date.getDay() === 0 ? 7 : date.getDay(), 7);
  data.writeUInt8(0, 8);
  data.writeUInt8(0, 9);
  return data;
};
