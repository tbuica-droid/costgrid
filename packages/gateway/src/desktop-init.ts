import { generateMasterKey, KEYCHAIN_SERVICE, readMasterKey, storeMasterKey } from "./keychain.js";

/**
 * One-time setup for desktop mode: put a master key in the keychain.
 *
 * Safe to run twice. It never replaces a key that is already there, because
 * every provider key stored under the old one would become undecryptable, and
 * it never prints the key it creates, because a terminal's scrollback is a file
 * like any other.
 */
function main(): void {
  if (readMasterKey() !== undefined) {
    console.log("A CostGrid master key is already in your keychain. Nothing was changed.");
    return;
  }

  // "exists" here means another run got there between the read and the write.
  // Either way there is exactly one key, and it was not replaced.
  const outcome = storeMasterKey(generateMasterKey());
  if (outcome === "exists") {
    console.log("A CostGrid master key is already in your keychain. Nothing was changed.");
    return;
  }

  console.log(`Created a CostGrid master key in your login keychain (item "${KEYCHAIN_SERVICE}").`);
  console.log("It was not printed and not written to any file.");
  console.log("");
  console.log("Next: npm run desktop, then open http://127.0.0.1:8787/console");
}

try {
  main();
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
}
