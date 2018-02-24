import path = require('path')
import _ = require('lodash')
import promisify = require('pify')
import proc = require('child_process')
import { parseSync as parseEnv } from 'env-file-parser'
import _fs = require('fs')
import YAML = require('js-yaml')
import getLocalIP = require('localip')
import isNative = require('is-native-module')
import {
  pick,
  extend
} from 'lodash'

import { models } from '@tradle/models'
import validateResource = require('@tradle/validate-resource')
import { TYPE } from '@tradle/constants'
import { Bucket } from '../bucket'
import Errors = require('../errors')
import { createAWSWrapper } from '../aws'
import { Logger } from '../logger'
import { Env } from '../env'
import { createRemoteTradle } from '../'
import { createConf } from '../in-house-bot/configure'
import {
  Tradle,
  Bot,
  IConf
} from '../in-house-bot/types'

import { wait } from '../utils'
import {
  addResourcesToEnvironment,
  addResourcesToOutputs,
  removeResourcesThatDontWorkLocally,
  addBucketTables,
  stripDevFunctions,
  setBucketEncryption
} from './compile'

const Localstack = require('../test/localstack')
const debug = require('debug')('tradle:sls:cli:utils')
const prettify = obj => JSON.stringify(obj, null, 2)
const copy = promisify(require('copy-dynamodb-table').copy)

const pexec = promisify(proc.exec.bind(proc))
const fs = promisify(_fs)

const getStackName = () => {
  const {
    service,
    provider: { stage }
  } = require('./serverless-yml')

  return `${service}-${stage}`
}

const getStackResources = ({ tradle, stackName }: {
  tradle: Tradle
  stackName: string
}) => {
  return tradle.stackUtils.getStackResources(stackName || getStackName())
}

const getPhysicalId = async ({ tradle, logicalId }) => {
  const resources = await getStackResources({
    tradle,
    stackName: getStackName()
  })

  const match = resources.find(({ LogicalResourceId }) => LogicalResourceId === logicalId)
  if (!match) {
    const list = resources.map(({ LogicalResourceId }) => LogicalResourceId)
    throw new Error(`resource with logical id "${logicalId}" not found. See list of resources in stack: ${JSON.stringify(list)}`)
  }

  return match.PhysicalResourceId
}

const genLocalResources = async ({ tradle }) => {
  if (!tradle) {
    tradle = require('../').createTestTradle()
  }

  const { aws } = tradle
  const { s3 } = aws
  const yml = require('./serverless-yml')
  const { resources } = yml
  const { Resources } = resources
  const togo = {}
  const tables = []
  const buckets = []

  let numCreated = 0
  Object.keys(Resources)
    .filter(name => Resources[name].Type === 'AWS::DynamoDB::Table')
    .forEach(name => {
      const { Type, Properties } = Resources[name]
      if (Properties.StreamSpecification) {
        Properties.StreamSpecification.StreamEnabled = true
      }

      togo[name] = true
      tables.push(
        aws.dynamodb.createTable(Properties).promise()
          .then(result => {
            delete togo[name]
            debug(`created table: ${name}`)
            debug('waiting on', togo)
            numCreated++
          })
          .catch(err => {
            if (err.name !== 'ResourceInUseException') {
              throw err
            }
          })
      )
    })

  const currentBuckets = await aws.s3.listBuckets().promise()
  Object.keys(Resources)
    .filter(name => Resources[name].Type === 'AWS::S3::Bucket')
    .forEach(name => {
      const Bucket = tradle.prefix + name.toLowerCase()
      const exists = currentBuckets.Buckets.find(({ Name }) => {
        return Name === Bucket
      })

      if (exists) return

      togo[name] = true
      buckets.push(
        aws.s3.createBucket({ Bucket })
        .promise()
        .then(result => {
          numCreated++
          delete togo[name]
          debug(`created bucket: ${name}`)
          debug('waiting on', togo)
        })
      )
    })

  const promises = buckets.concat(tables)
  debug(`waiting for resources...`)
  await Promise.all(promises)
  debug('resources created!')
  return numCreated
}

const makeDeploymentBucketPublic = async () => {
  const { buckets } = createRemoteTradle()
  await buckets.ServerlessDeployment.makePublic()
}

const interpolateTemplate = (opts:{ arg?:string, sync?:boolean }={}) => {
  const { arg='', sync } = opts
  const command = `sls print ${arg}`
  if (sync) {
    return Promise.resolve(proc.execSync(command).toString())
  }

  return new Promise((resolve, reject) => {
    proc.exec(command, {
      cwd: process.cwd()
    }, function (err, stdout, stderr) {
      if (err) {
        reject(new Error(stderr || stdout || err.message))
      } else {
        resolve(stdout.toString())
      }
    })
  })
}

const isAlphaNumeric = str => /^[a-zA-Z][a-zA-Z0-9]+$/.test(str)

const compileTemplate = async (path) => {
  const file = await fs.readFile(path, { encoding: 'utf8' })
  const yml = YAML.safeLoad(file)
  const exists = fs.existsSync('./serverless.yml')
  if (!exists) {
    await fs.writeFile('./serverless.yml', file, { encoding: 'utf8' })
  }

  const interpolatedStr = await interpolateTemplate()
  const interpolated = YAML.safeLoad(interpolatedStr)
  if (!isAlphaNumeric(interpolated.service)) {
    throw new Error(`"service" name "${interpolated.service}" is not alphanumeric`)
  }

  if (!isAlphaNumeric(interpolated.provider.stage)) {
    throw new Error(`stage "${interpolated.provider.stage}" is not alphanumeric`)
  }

  // validateProviderConf(interpolated.custom.providerConf)
  addBucketTables({ yml, prefix: interpolated.custom.prefix })
  setBucketEncryption({ target: yml, interpolated })
  stripDevFunctions(yml)

  const isLocal = process.env.IS_LOCAL
  if (isLocal) {
    removeResourcesThatDontWorkLocally(yml)
  }

  addResourcesToEnvironment(yml)
  addResourcesToOutputs(yml)
  return YAML.dump(yml)
}

function loadCredentials () {
  const AWS = require('aws-sdk')
  const yml = require('./serverless-yml')
  const { profile } = yml.provider
  AWS.config.credentials = new AWS.SharedIniFileCredentials({ profile })
}

function getRemoteEnv () {
  return require('./remote-service-map')
}

function loadRemoteEnv () {
  _.extend(process.env, getRemoteEnv())
  // const { env } = require('../env').tradle
  // env.set(getRemoteEnv())
}

// borrowed gratefully from https://github.com/juliangruber/native-modules
const getNativeModules = async (dir='node_modules', modules={}) => {
  const lstat = await fs.lstat(dir)
  if (!lstat.isDirectory()) return

  const name = dir.split('node_modules').pop()
  if (name in modules) return

  const files = await fs.readdir(dir)
  const promiseOne = fs.readFile(`${dir}/package.json`)
    .then(json => {
      const pkg = JSON.parse(json.toString('utf8'))
      if (isNative(pkg)) modules[pkg.name] = true
    }, err => {
      if (err.code !== 'ENOENT') throw err
    })

  const nested = files
    .filter(f => !/^\./.test(f))
    .map(f => getNativeModules(`${dir}/${f}`, modules))

  await Promise.all(nested.concat(promiseOne))
  return Object.keys(modules)
}

const getProductionModules = async () => {
  const command = 'npm ls --production --parseable=true --long=false --silent'
  const buf = await pexec(command, {
    cwd: process.cwd()
  })

  return buf.toString()
    .split('\n')
    .map(path => {
      return {
        path,
        name: path.split('node_modules/').pop()
      }
    })
}

const getTableDefinitions = () => {
  const yml = require('./serverless-yml')
  const { Resources } = yml.resources
  const tableNames = Object.keys(Resources)
    .filter(name => Resources[name].Type === 'AWS::DynamoDB::Table')

  const map = {}
  for (const name of tableNames) {
    map[name] = Resources[name]
  }

  return map
}

// const validateProviderConf = conf => {
//   const { style } = conf
//   if (style) {
//     validateResource.resource({
//       models,
//       resource: style
//     })
//   }
// }

const downloadDeploymentTemplate = async (tradle:Tradle) => {
  const { aws, stackUtils } = tradle
  const physicalId = await getPhysicalId({
    tradle,
    logicalId: 'ServerlessDeploymentBucket'
  })

  return await stackUtils.getStackTemplate(new Bucket({
    name: physicalId,
    s3: aws.s3
  }))
}

function getLatestS3Object (list) {
  let max = 0
  let latest
  for (let metadata of list) {
    let date = new Date(metadata.LastModified).getTime()
    if (date > max) latest = metadata
  }

  return latest
}

const clearTypes = async ({ tradle, types }) => {
  const { dbUtils } = tradle
  const { getModelMap, clear } = dbUtils
  const modelMap = getModelMap({ types })

  let deleteCounts = {}
  const buckets = []
  types.forEach(id => {
    const bucketName = modelMap.models[id]
    if (!buckets.includes(bucketName)) {
      buckets.push(bucketName)
    }
  })

  console.log('deleting items from buckets:', buckets.join(', '))
  await Promise.all(buckets.map(async (TableName) => {
    const { KeySchema } = await dbUtils.getTableDefinition(TableName)
    const keyProps = KeySchema.map(({ AttributeName }) => AttributeName)
    const processOne = async (item) => {
      const type = item[TYPE]
      if (!types.includes(item[TYPE])) return

      const Key = pick(item, keyProps)
      while (true) {
        try {
          console.log('deleting item', Key, 'from', TableName)
          await dbUtils.del({ TableName, Key })
          break
        } catch (err) {
          const { name } = err
          if (!(name === 'ResourceNotFoundException' ||
            name === 'LimitExceededException' ||
            name === 'ProvisionedThroughputExceededException')) {
            throw err
          }

          await wait(1000)
          console.log('failed to delete item, will retry', err.name)
        }
      }

      if (!deleteCounts[TableName]) {
        deleteCounts[TableName] = {}
      }

      if (deleteCounts[TableName][type]) {
        deleteCounts[TableName][type]++
      } else {
        deleteCounts[TableName][type] = 1
      }
    }

    await dbUtils.batchProcess({
      batchSize: 20,
      params: { TableName },
      processOne
    })
  }))

  return deleteCounts
}

const initStack = async (opts:{ bot?: Bot, force?: boolean }={}) => {
  let { bot, force } = opts
  if (!bot) {
    const { createBot } = require('../bot')
    bot = createBot()
  }

  const conf = createConf({ bot })
  if (!force) {
    try {
      const current = await conf.get()
      const { info, botConf } = current
      if (info && botConf) {
        console.log('already initialized')
        return
      }
    } catch (err) {}
  }

  // const providerConf = require('../in-house-bot/conf/provider')
  const yml = require('./serverless-yml')
  const providerConf = yml.custom.org
  try {
    await conf.initInfra(providerConf, {
      forceRecreateIdentity: force
    })
  } catch (err) {
    Errors.ignore(err, Errors.Exists)
    console.log('prevented overwrite of existing identity/keys')
  }
}

const cloneRemoteTable = async ({ source, destination }) => {
  loadCredentials()

  const AWS = require('aws-sdk')
  const yml = require('./serverless-yml')
  const localCredentials = parseEnv(path.resolve(__dirname, '../../docker/.env'))
  const destinationAWSConfig = {
    accessKeyId: localCredentials.AWS_ACCESS_KEY_ID,
    secretAccessKey: localCredentials.AWS_SECRET_ACCESS_KEY
  }

  const { region } = yml.provider
  await copy({
    config: {
      region
    },
    source: {
      tableName: source,
      dynamoClient: new AWS.DynamoDB.DocumentClient({ region })
    },
    destination: {
      tableName: destination, // required
      dynamoClient: new AWS.DynamoDB.DocumentClient({
        region,
        endpoint: Localstack.DynamoDB
      })
    },
    log: true
  })
}

const alwaysTrue = (...any) => true
const cloneRemoteBucket = async ({ source, destination, filter=alwaysTrue }) => {
  loadCredentials()

  const AWS = require('aws-sdk')
  const sourceBucket = new Bucket({
    name: source,
    s3: new AWS.S3()
  })

  const destinationS3 = new AWS.S3({
    endpoint: Localstack.S3,
    s3ForcePathStyle: true
  })

  await sourceBucket.forEach({
    getBody: true,
    map: batch => {
      const keep = batch.filter(filter)
      console.log(`processing batch of ${keep.length} items`)
      return Promise.all(keep.map(async (item) => {
        return destinationS3.putObject({
          Key: item.Key,
          Bucket: destination,
          Body: item.Body,
          ContentType: item.ContentType
        }).promise()
      }))
    }
  })
}

export const getOfflinePort = (env?:Env) => {
  if (env && env.SERVERLESS_OFFLINE_PORT) {
    return env.SERVERLESS_OFFLINE_PORT
  }

  const yml = require('./serverless-yml')
  return yml.custom['serverless-offline'].port
}

export const getOfflineHost = (env?:Env) => {
  if (env && env.SERVERLESS_OFFLINE_APIGW) {
    return env.SERVERLESS_OFFLINE_APIGW
  }

  const port = getOfflinePort(env)
  return `http://${getLocalIP()}:${port}`
}

export {
  getRemoteEnv,
  loadRemoteEnv,
  compileTemplate,
  interpolateTemplate,
  genLocalResources,
  makeDeploymentBucketPublic,
  loadCredentials,
  getStackName,
  getStackResources,
  getPhysicalId,
  getNativeModules,
  getProductionModules,
  getTableDefinitions,
  downloadDeploymentTemplate,
  clearTypes,
  initStack,
  cloneRemoteTable,
  cloneRemoteBucket
}
