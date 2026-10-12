// macOS builds made without a Developer ID certificate.
//
// electron-builder then skips signing altogether, which leaves the app with
// Electron's original signature broken by our changes to the bundle. Apple
// Silicon Macs refuse such an app as "damaged" and offer no way to open it.
// An ad-hoc signature fixes that: macOS then shows the usual "unidentified
// developer" prompt, which the user can approve in System Settings →
// Privacy & Security → Open Anyway. Only a Developer ID certificate with
// notarisation (see .github/workflows/desktop-release.yml) removes the prompt.
const { execFileSync } = require('node:child_process');
const path = require('node:path');

exports.default = async function adhocSign(context) {
  if (context.electronPlatformName !== 'darwin') return;
  // With a certificate, electron-builder signs (and notarises) properly.
  if (process.env.CSC_IDENTITY_AUTO_DISCOVERY !== 'false') return;

  const app = path.join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`);
  execFileSync('codesign', ['--force', '--deep', '--sign', '-', app], { stdio: 'inherit' });
  // Fail the build rather than ship an app macOS calls damaged.
  execFileSync('codesign', ['--verify', '--deep', '--strict', '--verbose=2', app], { stdio: 'inherit' });
};
