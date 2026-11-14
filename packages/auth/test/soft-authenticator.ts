/**
 * Software WebAuthn authenticator for tests: an ES256 (P-256) credential that answers
 * registration and authentication ceremonies like a real device (attestation "none").
 */
import { createHash, generateKeyPairSync, randomBytes, sign, type KeyObject } from "node:crypto";
import { isoCBOR } from "@simplewebauthn/server/helpers";
import type { AuthenticationResponseJSON, PublicKeyCredentialCreationOptionsJSON, PublicKeyCredentialRequestOptionsJSON, RegistrationResponseJSON } from "@simplewebauthn/server";

const b64u = (b: Uint8Array | Buffer) => Buffer.from(b).toString("base64url");
const sha256 = (b: Buffer | string) => createHash("sha256").update(b).digest();

export class SoftAuthenticator {
  readonly credentialId = randomBytes(16);
  private readonly privateKey: KeyObject;
  private readonly publicKey: KeyObject;
  private counter = 0;
  userHandle: string | undefined;

  constructor(
    readonly origin: string,
    readonly rpId: string,
  ) {
    const kp = generateKeyPairSync("ec", { namedCurve: "P-256" });
    this.privateKey = kp.privateKey;
    this.publicKey = kp.publicKey;
  }

  get id(): string {
    return b64u(this.credentialId);
  }

  private cosePublicKey(): Uint8Array {
    const jwk = this.publicKey.export({ format: "jwk" });
    return isoCBOR.encode(
      new Map<number, number | Uint8Array>([
        [1, 2], // kty: EC2
        [3, -7], // alg: ES256
        [-1, 1], // crv: P-256
        [-2, Buffer.from(jwk.x!, "base64url")],
        [-3, Buffer.from(jwk.y!, "base64url")],
      ]),
    );
  }

  private authData(flags: number, attested?: Uint8Array): Buffer {
    const count = Buffer.alloc(4);
    count.writeUInt32BE(this.counter);
    const parts = [sha256(this.rpId), Buffer.from([flags]), count];
    if (attested) parts.push(Buffer.from(attested));
    return Buffer.concat(parts);
  }

  register(options: PublicKeyCredentialCreationOptionsJSON, origin = this.origin): RegistrationResponseJSON {
    this.userHandle = options.user.id;
    const clientDataJSON = Buffer.from(JSON.stringify({ type: "webauthn.create", challenge: options.challenge, origin, crossOrigin: false }));
    const idLen = Buffer.alloc(2);
    idLen.writeUInt16BE(this.credentialId.length);
    const attested = Buffer.concat([Buffer.alloc(16), idLen, this.credentialId, Buffer.from(this.cosePublicKey())]);
    const authData = this.authData(0x45, attested); // UP | UV | AT
    const attestationObject = isoCBOR.encode(new Map<string, unknown>([["fmt", "none"], ["attStmt", new Map()], ["authData", authData]]) as never);
    return {
      id: this.id,
      rawId: this.id,
      type: "public-key",
      response: { clientDataJSON: b64u(clientDataJSON), attestationObject: b64u(attestationObject), transports: ["internal"] },
      clientExtensionResults: {},
    };
  }

  authenticate(options: PublicKeyCredentialRequestOptionsJSON, origin = this.origin): AuthenticationResponseJSON {
    this.counter++;
    const clientDataJSON = Buffer.from(JSON.stringify({ type: "webauthn.get", challenge: options.challenge, origin, crossOrigin: false }));
    const authData = this.authData(0x05); // UP | UV
    const signature = sign("sha256", Buffer.concat([authData, sha256(clientDataJSON)]), this.privateKey); // DER, as WebAuthn requires
    return {
      id: this.id,
      rawId: this.id,
      type: "public-key",
      response: {
        clientDataJSON: b64u(clientDataJSON),
        authenticatorData: b64u(authData),
        signature: b64u(signature),
        ...(this.userHandle ? { userHandle: this.userHandle } : {}),
      },
      clientExtensionResults: {},
    };
  }
}
