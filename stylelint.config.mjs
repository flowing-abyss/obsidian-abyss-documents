/** @type {import('stylelint').Config} */
const config = {
  extends: ['stylelint-config-obsidianmd', 'stylelint-config-standard'],
  ignoreFiles: ['styles.css'],
  rules: {
    // App 1.13.4's earliest supported installer is 1.5.8 (Chromium 120),
    // as exercised by the earliest/earliest desktop E2E capability.
    'plugin/no-unsupported-browser-features': [true, { browsers: ['chrome >= 120'], ignore: [] }],
    'selector-max-type': 0,
    'custom-property-pattern': null,
  },
};

export default config;
