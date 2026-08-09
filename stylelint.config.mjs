/** @type {import('stylelint').Config} */
const config = {
  extends: ['stylelint-config-standard'],
  ignoreFiles: ['styles.css'],
  rules: {
    'selector-max-type': 0,
    'custom-property-pattern': null,
  },
};

export default config;
