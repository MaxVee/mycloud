#!/usr/bin/env node

console.warn(`if you made any changes to serverless-uncompiled.yml
make sure to run: npm run build:slsyml before running this script
`)

require('../test/env')
const { genLocalResources } = require('../lib/cli/utils')

genLocalResources().catch(err => {
  console.error(err)
  process.exit(1)
})
