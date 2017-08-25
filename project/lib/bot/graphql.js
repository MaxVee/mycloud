const debug = require('debug')('tradle:sls:graphql')
const { graphql } = require('graphql')
const express = require('express')
const expressGraphQL = require('express-graphql')
const compression = require('compression')
const cors = require('cors')
const bodyParser = require('body-parser')
const awsServerlessExpress = require('aws-serverless-express')
const awsServerlessExpressMiddleware = require('aws-serverless-express/middleware')
const { createResolvers } = require('@tradle/dynamodb')
const { createSchema } = require('@tradle/schema-graphql')
const { co } = require('../utils')
const { docClient } = require('../aws')
const { NODE_ENV } = process.env
const TESTING = process.env.NODE_ENV === 'test'

module.exports = function setup (opts) {
  const { models, objects, tables } = opts
  const app = express()
  app.use(compression())
  app.use(cors())
  app.use(bodyParser.json())
  app.use(bodyParser.urlencoded({ extended: true }))
  app.use(awsServerlessExpressMiddleware.eventContext())
  app.use('/', expressGraphQL(() => ({
    schema: getSchema(),
    graphiql: true
  })))

  const binaryMimeTypes = [
    'application/json',
    'text/html'
  ]

  const server = awsServerlessExpress.createServer(app, null, binaryMimeTypes)
  const handleHTTPRequest = (event, context) => {
    awsServerlessExpress.proxy(server, event, context)
  }

  const resolvers = createResolvers({ objects, models, tables })

  // be lazy
  let schema
  const getSchema = () => {
    if (!schema) {
      schema = createSchema({ models, objects, resolvers }).schema
    }

    return schema
  }

  const executeQuery = (query, variables) => {
    return graphql(getSchema(), query, null, {}, variables)
  }

  return {
    tables,
    resolvers,
    executeQuery,
    handleHTTPRequest
  }
}
