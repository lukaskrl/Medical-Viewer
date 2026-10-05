const path = require('path');
const base = require('../../jest.config.base.js');

module.exports = {
  ...base,
  // This package's babel.config.js predates the root one and cannot parse
  // Jest's own (transformed) runner, so tests use the root config.
  transform: {
    '^.+\\.[jt]sx?$': [
      'babel-jest',
      { configFile: path.resolve(__dirname, '../../babel.config.js') },
    ],
  },
  moduleNameMapper: {
    ...base.moduleNameMapper,
    '@ohif/(.*)': '<rootDir>/../../platform/$1/src',
    '^@cornerstonejs/(.*)$': '<rootDir>/../../node_modules/@cornerstonejs/$1/dist/esm',
  },
};
