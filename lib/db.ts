import { db as newDB, createTable } from '@tradle/dynamodb'
import AWS = require('aws-sdk')
// const Tables = require('./tables')

export = function createDB (opts: {
  models: any,
  objects: any,
  tables: any,
  aws: any,
  constants: any,
  env: any,
  prefix: string
}) {
  const { models, objects, tables, aws, constants, env, prefix } = opts
  const readOnlyObjects = {
    get: objects.get,
    put: objects.put
  }

  const db = newDB({
    models,
    objects: readOnlyObjects,
    docClient: aws.docClient,
    maxItemSize: constants.MAX_DB_ITEM_SIZE,
    prefix
  })

  // export Outbox only
  const messageModel = models['tradle.Message']
  if (!messageModel.isInterface) {
    const messagesTable = createTable({
      models,
      objects: readOnlyObjects,
      bodyInObjects: false,
      forbidScan: true,
      model: messageModel,
      tableName: tables.Messages.name,
      prefix,
      // better load these from serverless-yml
      hashKey: '_link',
      indexes: [
        {
          hashKey: '_author',
          rangeKey: 'time',
          name: '_author',
          type: 'global',
          projection: {
            ProjectionType: 'KEYS_ONLY'
          }
        },
        {
          hashKey: '_recipient',
          rangeKey: 'time',
          name: '_recipient',
          type: 'global',
          projection: {
            ProjectionType: 'KEYS_ONLY'
          }
        },
        {
          hashKey: '_payloadLink',
          name: '_payloadLink',
          type: 'global',
          projection: {
            ProjectionType: 'KEYS_ONLY'
          }
        }
      ]
    })

    db.setTableForType('tradle.Message', messagesTable)
  }

  const pubKeyModel = models['tradle.PubKey']
  const pubKeys = createTable({
    models: {
      ...models,
      [pubKeyModel.id]: pubKeyModel
    },
    objects: readOnlyObjects,
    model: pubKeyModel,
    tableName: tables.PubKeys.name,
    prefix,
    hashKey: 'pub',
    indexes: []
  })

  db.setTableForType('tradle.PubKey', pubKeys)
  return db
}
