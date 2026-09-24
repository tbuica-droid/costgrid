import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";

/**
 * The master key, held in the macOS keychain instead of a file.
 *
 * What this buys, stated plainly: the key that decrypts every stored provider
 * credential stops living in a plaintext `.env`, so it is out of backups, out
 * of sync folders and out of any `git add .`. What it does not buy is
 * protection from software already running as you. The item is created by
 * `/usr/bin/security`, so that tool reads it back without a prompt, and so can
 * anything that runs it. The signed desktop app narrows that to the app's own
 * code signature; this is the step before it.
 *
 * macOS only for now. Windows and Linux get the equivalent through the
 * desktop app's own secure storage.
 */

export const KEYCHAIN_SERVICE = "dev.costgrid.gateway";
export const KEYCHAIN_ACCOUNT = "master-key";

const SECURITY = "/usr/bin/security";
const NOT_FOUND = 44;
const ALREADY_EXISTS = 45;

/** Exactly what `generateMasterKey` produces. Checked before it reaches a command line. */
const KEY_SHAPE = /^[A-Za-z0-9_-]{32,256}$/;
/** `security -i` splits on whitespace, so nothing it tokenises may contain any. */
const SAFE_TOKEN = /^[^\s"'\\]+$/;

export type KeychainRunner = (
  args: readonly string[],
  input?: string,
) => { status: number; stdout: string; stderr: string };

export interface KeychainOptions {
  readonly service?: string;
  readonly account?: string;
  /** A specific keychain file. Tests use a throwaway one; unset means the login keychain. */
  readonly keychain?: string;
  readonly platform?: NodeJS.Platform;
  readonly run?: KeychainRunner;
}

const defaultRun: KeychainRunner = (args, input) => {
  const result = spawnSync(SECURITY, args, { input, encoding: "utf8" });
  if (result.error) throw result.error;
  return { status: result.status ?? 1, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
};

function resolve(options: KeychainOptions) {
  const platform = options.platform ?? process.platform;
  if (platform !== "darwin") {
    throw new Error(
      "The keychain master key source is macOS only for now. " +
        "Set COSTGRID_MASTER_KEY_SOURCE=env and provide COSTGRID_MASTER_KEY instead.",
    );
  }
  return {
    service: options.service ?? KEYCHAIN_SERVICE,
    account: options.account ?? KEYCHAIN_ACCOUNT,
    keychain: options.keychain,
    run: options.run ?? defaultRun,
  };
}

/** A new master key: 48 random bytes, 64 characters of base64url. */
export function generateMasterKey(): string {
  return randomBytes(48).toString("base64url");
}

/** The stored master key, or undefined when there is none yet. */
export function readMasterKey(options: KeychainOptions = {}): string | undefined {
  const { service, account, keychain, run } = resolve(options);
  const args = ["find-generic-password", "-s", service, "-a", account, "-w"];
  if (keychain !== undefined) args.push(keychain);

  const { status, stdout, stderr } = run(args);
  if (status === NOT_FOUND) return undefined;
  if (status !== 0) {
    throw new Error(
      `could not read the CostGrid master key from the keychain: ${stderr.trim() || `security exited ${status}`}. ` +
        "If the keychain is locked, unlock it and try again.",
    );
  }

  const value = stdout.trim();
  if (value === "") throw new Error("the keychain returned an empty CostGrid master key");
  return value;
}

/**
 * Store a master key, never replacing one that is already there.
 *
 * Replacing it would make every provider key encrypted under the old one
 * undecryptable, so "exists" is an answer rather than an error, and the
 * keychain itself enforces it: without `-U`, a second add is refused.
 *
 * The secret goes in on stdin through `security -i`, never as an argument,
 * because arguments are visible to every process on the machine.
 */
export function storeMasterKey(secret: string, options: KeychainOptions = {}): "created" | "exists" {
  const { service, account, keychain, run } = resolve(options);
  if (!KEY_SHAPE.test(secret)) {
    throw new RangeError("a master key must be 32 to 256 base64url characters");
  }
  for (const token of [service, account, keychain]) {
    if (token !== undefined && !SAFE_TOKEN.test(token)) {
      throw new RangeError(`keychain name, service and account may not contain spaces or quotes: ${token}`);
    }
  }

  const command = ["add-generic-password", "-s", service, "-a", account, "-w", secret];
  if (keychain !== undefined) command.push(keychain);

  const { status, stderr } = run(["-i"], `${command.join(" ")}\n`);
  if (status === 0) return "created";
  if (status === ALREADY_EXISTS) return "exists";
  throw new Error(
    `could not store the CostGrid master key in the keychain: ${
      stderr.replaceAll(secret, "[redacted]").trim() || `security exited ${status}`
    }`,
  );
}
