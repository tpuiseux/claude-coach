declare module "@garmin/fitsdk" {
  export class Encoder {
    onMesg(mesgNum: number, data: Record<string, unknown>): void;
    close(): Uint8Array;
  }

  export class Decoder {
    constructor(stream: Stream);
    read(): { messages: Record<string, unknown[]>; errors: string[] };
  }

  export class Stream {
    static fromBuffer(buffer: Buffer): Stream;
    static fromByteArray(bytes: Uint8Array): Stream;
    static fromArrayBuffer(buffer: ArrayBuffer): Stream;
  }

  export const Profile: {
    MesgNum: {
      FILE_ID: number;
      FILE_CREATOR: number;
      WORKOUT: number;
      WORKOUT_STEP: number;
    };
  };
}
