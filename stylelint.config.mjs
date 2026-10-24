/** @type {import('stylelint').Config} */
const config = {
  extends: ['stylelint-config-obsidianmd', 'stylelint-config-standard'],
  ignoreFiles: ['styles.css'],
  rules: {
    // App 1.7.2's earliest supported installer is 1.4.13 (Chromium 114),
    // as exercised by the earliest/earliest desktop E2E capability.
    'plugin/no-unsupported-browser-features': [true, { browsers: ['chrome >= 114'], ignore: [] }],
    'selector-max-type': 0,
    'custom-property-pattern': null,
  },
};

export default config;
