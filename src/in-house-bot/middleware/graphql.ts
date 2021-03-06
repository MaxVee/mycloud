import compose from 'koa-compose'
import cors from 'kcors'
import { pick, once } from 'lodash'
import { bodyParser } from '../../middleware/body-parser'
import { createHandler as createGraphqlHandler } from '../../middleware/graphql'
import { createHandler as createGraphqlAuthHandler } from '../../middleware/graphql-auth'
import {
  IPBLambdaHttp as Lambda,
  MiddlewareHttp as Middleware,
  IBotComponents,
  IPBHttpMiddlewareContext,
  IUser,
} from '../types'

import {
  sendModelsPackIfUpdated,
  createModelsPackGetter
} from '../plugins/keep-models-fresh'

import { MODELS_HASH_PROPERTY } from '../constants'

export const keepModelsFresh = (lambda:Lambda) => {
  const createSender = (components: IBotComponents) => {
    const { bot, employeeManager, productsAPI } = components
    const getModelsPackForUser = createModelsPackGetter({
      bot,
      employeeManager,
      productsAPI,
    })

    return async (user) => {
      const modelsPack = await getModelsPackForUser(user)
      if (!modelsPack) return

      const sent = await sendModelsPackIfUpdated({
        user,
        modelsPack,
        send: object => bot.send({ to: user, object })
      })

      if (sent) {
        lambda.tasks.add({
          name: 'saveuser',
          promise: bot.users.merge(pick(user, ['id', MODELS_HASH_PROPERTY]))
        })
      }
    }
  }

  let sendModelsPackToUser
  return async (ctx, next) => {
    const { user, components } = ctx
    if (user) {
      if (!sendModelsPackToUser) {
        sendModelsPackToUser = createSender(components)
      }

      await sendModelsPackToUser(user)
    }

    await next()
  }
}

export const createAuth = (lambda: Lambda) => {
  const isGuestAllowed = ({ ctx, user, query }) => {
    return lambda.isLocal || ctx.components.conf.bot.graphqlAuth === false
  }

  return createGraphqlAuthHandler(lambda, {
    isGuestAllowed,
    canUserRunQuery: opts => {
      const { ctx, user, query } = opts
      const { employeeManager } = ctx.components as IBotComponents
      return isGuestAllowed(opts) || (user && employeeManager.isEmployee(user))
    }
  })
}

export const createMiddleware = (lambda:Lambda):Middleware => {
  return compose([
    cors(),
    bodyParser({ jsonLimit: '10mb' }),
    createAuth(lambda),
    keepModelsFresh(lambda),
    createGraphqlHandler(lambda)
  ])
}
