// Expo config plugin: keeps Agora's screen-sharing extension out of the Android app.
//
// react-native-agora depends on `io.agora.rtc:full-screen-sharing`, whose manifest adds
// FOREGROUND_SERVICE, FOREGROUND_SERVICE_MEDIA_PROJECTION, a `mediaProjection` foreground service
// (MediaProjectionMgr$LocalScreenSharingService) and a helper activity to every app that includes
// it. This app uses Agora for voice only, so the module is excluded — the way Agora's own README
// describes for apps without screen sharing.
//
// The exclusion goes into android/app/build.gradle, not the root build.gradle: it then applies to
// what the APP packages, and leaves react-native-agora's own module compiling exactly as it ships.
// Remove this plugin if screen sharing is ever added.
const { withAppBuildGradle } = require('expo/config-plugins');

const GROUP = 'io.agora.rtc';
const MODULE = 'full-screen-sharing';
const TAG = 'without-agora-screen-sharing';
const START = `// @generated begin ${TAG} - expo prebuild (plugins/withoutAgoraScreenSharing.js)`;
const END = `// @generated end ${TAG}`;

const BLOCK = [START, 'configurations.configureEach {', `    exclude group: '${GROUP}', module: '${MODULE}'`, '}', END].join('\n');

/** Adds the exclusion to the contents of app/build.gradle. Running it again changes nothing. */
function addExclusion(contents) {
  const start = contents.indexOf(START);
  const end = contents.indexOf(END);
  // Already there (a prebuild over an existing android folder): replace that block, never add a second.
  if (start !== -1 && end > start) return contents.slice(0, start) + BLOCK + contents.slice(end + END.length);
  return `${contents.replace(/\s*$/, '')}\n\n${BLOCK}\n`;
}

const withoutAgoraScreenSharing = (config) =>
  withAppBuildGradle(config, (mod) => {
    if (mod.modResults.language !== 'groovy') {
      throw new Error('withoutAgoraScreenSharing: android/app/build.gradle is not Groovy; add the exclusion for this build file format.');
    }
    mod.modResults.contents = addExclusion(mod.modResults.contents);
    return mod;
  });

module.exports = withoutAgoraScreenSharing;
module.exports.addExclusion = addExclusion;
