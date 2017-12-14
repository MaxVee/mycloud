#!/usr/bin/env node

process.env.IS_LOCAL = 'true'
process.env.DEBUG = process.env.DEBUG || 'tradle*'

require('source-map-support').install()

console.warn(`if you made any changes to serverless-uncompiled.yml
make sure to run: npm run build:yml before running this script
`)

const { force } = require('minimist')(process.argv.slice(2), {
  boolean: ['force']
})

import promisify = require('pify')
import { tradle } from '../'
import { genLocalResources, initializeProvider } from '../cli/utils'
import Errors = require('../errors')

const rethrow = (err) => {
  if (err) throw err
}

;(async () => {
  // the below has been replaced by the plugins serverless-dynamodb-local and serverless-s3-local
  // const numCreated = await genLocalResources({ tradle })
  // if (numCreated) {
  //   console.log('waiting a bit to ensure resources are ready...')
  //   await new Promise(resolve => setTimeout(resolve, 5000))
  // }

  await initializeProvider()
})()
.catch(err => {
  console.error(err)
  process.exitCode = 1
})
