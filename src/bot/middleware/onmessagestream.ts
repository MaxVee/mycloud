// @ts-ignore
import Promise = require('bluebird')
import _ = require('lodash')
import { TYPE } from '@tradle/constants'
import Errors = require('../../errors')
import { getRecordsFromEvent } from '../../db-utils'
import {
  batchProcess,
  ensureTimestamped,
  promiseNoop,
  wait,
  uniqueStrict
} from '../../utils'

import { fromDynamoDB } from '../lambda'
import { onMessagesSaved } from './onmessagessaved'
import { Lambda, ISettledPromise, ITradleMessage } from '../../types'

const S3_GET_ATTEMPTS = 3
const S3_FAILED_GET_INITIAL_RETRY_DELAY = 1000

export const createMiddleware = (lambda:Lambda, opts?:any) => {
  const { tradle, bot, logger } = lambda
  const logAndThrow = (results) => {
    const failed = results.map(({ reason }) => reason)
      .filter(reason => reason)

    if (failed.length) {
      logger.debug('failed to save payloads', failed)
      throw new Error(failed[0])
    }
  }

  const preProcess = preProcessOne(lambda, opts)
  const postProcess = postProcessBatch(lambda, opts)
  return async (ctx, next) => {
    const { event } = ctx
    event.bot = bot
    // unmarshalling is prob a waste of time
    const messages = getRecordsFromEvent(event)
    const preResults:ISettledPromise<ITradleMessage>[] = await batchProcess({
      data: messages,
      batchSize: 20,
      processOne: preProcess,
      settle: true
    })

    const successes = preResults
      .filter(result => result.value)
      .map(result => result.value)

    const postResults = await postProcess(messages)

    // const postResults = await batchProcess({
    //   data: successes,
    //   batchSize: 20,
    //   processOne: postProcess
    // })

    logAndThrow(preResults)
    await next()
  }
}

export const preProcessOne = (lambda:Lambda, opts) => {
  const { bot, logger } = lambda
  return async (message) => {
    const payload = message.object
    const type = message._payloadType
    let maxAttempts = S3_GET_ATTEMPTS
    let delay = S3_FAILED_GET_INITIAL_RETRY_DELAY
    while (maxAttempts--) {
      try {
        const body = await bot.objects.get(payload._link)
        extendTradleObject(payload, body)
      } catch (err) {
        // TODO: implement retry/fallback policy
        Errors.ignore(err, Errors.NotFound)
        await wait(delay)
        delay *= 2
      }
    }

    return message
  }
}

export const postProcessBatch = (lambda, opts) => {
  const { logger } = lambda
  const businessLogicMiddleware = onMessagesSaved(lambda, opts)
  return async (messages) => {
    const subCtx = {
      ...lambda.execCtx,
      event: { messages }
    }

    try {
      await businessLogicMiddleware(subCtx, promiseNoop)
    } catch (err) {
      // TODO: implement retry/fallback policy
      logger.debug('failure in custom onmessagestream middleware', {
        messages,
        error: Errors.export(err)
      })
    }
  }
}

const extendTradleObject = (a, b) => {
  const virtual = uniqueStrict((a._virtual || []).concat(b._virtual || []))
  _.extend(a, b)
  if (virtual.length) a._virtual = virtual

  return a
}
