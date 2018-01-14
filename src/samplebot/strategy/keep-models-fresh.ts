import _ = require('lodash')
import ModelsPack = require('@tradle/models-pack')
import baseModels = require('../../models')
import { isPromise, stableStringify } from '../../utils'

const BASE_MODELS_IDS = Object.keys(baseModels)
const mapModelsToPack = new Map()

export const defaultPropertyName = 'modelsHash'
export const getDefaultIdentifierFromUser = (user) => user.id
export const getDefaultIdentifierFromReq = ({ user }) => getDefaultIdentifierFromUser(user)

export const keepModelsFreshPlugin = ({
  getModelsPackForUser,
  propertyName=defaultPropertyName,
  // unique identifier for counterparty
  // which will be used to track freshness.
  // defaults to user.id
  getIdentifier=getDefaultIdentifierFromReq,
  send
}: {
  getModelsPackForUser: (user) => any,
  send: ({ req, to, object }) => Promise<any>
  getIdentifier?: (req:any) => string,
  propertyName?: string,
}) => {
  // modelsObject => modelsArray
  // modelsArray => modelsHash
  return async (req) => {
    const identifier = getIdentifier(req)
    const { user } = req
    let modelsPack = getModelsPackForUser(user)
    if (isPromise(modelsPack)) {
      modelsPack = await modelsPack
    }

    if (!modelsPack) return

    await sendModelsPackIfUpdated({
      user,
      modelsPack,
      propertyName,
      identifier,
      send: object => send({ req, to: user, object })
    })
  }
}

export const sendModelsPackIfUpdated = async ({
  user,
  modelsPack,
  send,
  identifier,
  propertyName=defaultPropertyName,
}: {
  user: any,
  modelsPack: any,
  send: (pack:any) => Promise<any>,
  identifier?: string,
  propertyName?: string
}) => {
  if (!identifier) identifier = getDefaultIdentifierFromUser(user)

  if (!user[propertyName] || typeof user[propertyName] !== 'object') {
    user[propertyName] = {}
  }

  const versionId = user[propertyName][identifier]
  if (modelsPack.versionId === versionId) return

  user[propertyName][identifier] = modelsPack.versionId
  return await send(modelsPack)
}

export const createGetIdentifierFromReq = ({ employeeManager }) => {
  return req => {
    const { user, message } = req
    const { originalSender } = message
    let identifier = getDefaultIdentifierFromUser(user)
    if (originalSender) {
      identifier += ':' + originalSender
    }

    return identifier
  }
}

export const createModelsPackGetter = ({ bot, productsAPI, employeeManager }) => {
  // const employeeModels = _.omit(bot.models, BASE_MODELS_IDS)
  // const customerModels = employeeModels
  // const customerModels = _.omit(
  //   productsAPI.models.all,
  //   Object.keys(productsAPI.models.private.all)
  //     .concat(BASE_MODELS_IDS)
  // )

  return async (user) => {
    if (employeeManager.isEmployee(user)) {
      return await bot.modelStore.getCumulativeModelsPack()
    }

    return bot.modelStore.myModelsPack
  }
}
