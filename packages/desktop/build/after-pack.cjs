/*
 * Runs after electron-builder has assembled the Mac app and before it signs.
 *
 * Without an Apple Developer ID there is nothing to sign with, and
 * electron-builder leaves the app unsigned. An unsigned app on an Apple
 * Silicon Mac is refused outright as "damaged". An ad-hoc signature (the
 * `-` identity, which any Mac can make) turns that into the ordinary
 * "unidentified developer" warning, which a person can get past from System
 * Settings. When a real identity is configured, electron-builder signs over
 * this afterwards, so it costs nothing to do always.
 */
const { execFileSync } = require("node:child_process");
const { join } = require("node:path");

module.exports = async function afterPack(context) {
  if (context.electronPlatformName !== "darwin") return;
  const app = join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`);
  execFileSync("codesign", ["--force", "--deep", "--sign", "-", app], { stdio: "inherit" });
};
